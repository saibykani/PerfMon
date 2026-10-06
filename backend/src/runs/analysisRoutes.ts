import type { FastifyInstance } from 'fastify';
import { one, query, tsPool } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { badRequest } from '../lib/errors.js';
import { typed, z, toCsv } from '../lib/http.js';
import { Histogram } from '../lib/histogram.js';
import { resolveRun } from '../ingest/runCache.js';
import { runSeries, windowStats, transactionStats, runSource, runWindow, infraSeries, chooseStep } from '../metrics/series.js';
import { compareRuns, resolveBaseline } from '../analytics/compare.js';
import { reconcile } from '../reports/reconcile.js';
import { hub, liveConnections } from '../live/hub.js';
import { pctChange } from '../lib/stats.js';

const idParam = z.object({ id: z.string() });
const rangeQuery = { from: z.string().optional(), to: z.string().optional(), step: z.coerce.number().int().min(1).optional(), source: z.string().optional() };
const d = (s?: string) => (s ? new Date(/^\d+$/.test(s) ? Number(s) : s) : undefined);

export async function runAnalysisRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_RUN') };

  // Timeline: users / TPS / response time / errors + CPU & memory overlay + events. Synchronized charts use one step.
  r.get('/runs/:id/timeline', { ...view, schema: { tags: ['Run Analysis'], summary: 'Run timeline series (zoomable: from/to)', params: idParam, querystring: z.object({ ...rangeQuery, transaction: z.string().optional() }) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const q = req.query;
    const source = q.source ?? (await runSource(ref.id)) ?? 'live';
    const series = await runSeries(ref.id, { source, from: d(q.from), to: d(q.to), step: q.step, transaction: q.transaction });
    const win = series.points.length ? { from: new Date(series.points[0].t), to: new Date(series.points[series.points.length - 1].t + series.step * 1000) } : await runWindow(ref.id, source);
    const infra = await infraSeries('server_metrics', ['cpu_pct', 'memory_pct'], { runId: ref.id, from: win.from, to: win.to, step: series.step });
    const events = await query(`SELECT id, type, severity, ts, title, description, source FROM events WHERE run_id = $1 ORDER BY ts`, [ref.id]);
    const annotations = await query(`SELECT id, ts, ts_end, title, text, tags, created_by_name FROM annotations WHERE run_id = $1 ORDER BY ts`, [ref.id]);
    return { ...series, source, window: win, infra: infra.points, events, annotations };
  });

  r.get('/runs/:id/stats', { ...view, schema: { tags: ['Run Analysis'], summary: 'KPIs for a time window (recomputed for zoom selections)', params: idParam, querystring: z.object({ ...rangeQuery, transaction: z.string().optional() }) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    return windowStats(ref.id, { source: req.query.source, from: d(req.query.from), to: d(req.query.to), transaction: req.query.transaction });
  });

  r.get('/runs/:id/transactions', { ...view, schema: { tags: ['Run Analysis'], summary: 'Transaction statistics table', params: idParam, querystring: z.object(rangeQuery) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req), true);
    const q = req.query;
    const source = q.source ?? (await runSource(ref.id)) ?? (await one(`SELECT 1 FROM transactions WHERE run_id = $1 AND source = 'html_report' LIMIT 1`, [ref.id]) ? 'html_report' : 'live');
    if (!q.from && !q.to && ref.status !== 'RUNNING') {
      const stored = await query(`SELECT * FROM transactions WHERE run_id = $1 AND source = $2 ORDER BY samples DESC`, [ref.id, source]);
      if (stored.length) return { source, items: stored.map((t) => ({ name: t.name, samples: Number(t.samples), errors: Number(t.errors), errorPct: t.error_pct, tps: t.tps, avg: t.avg_rt, min: t.min_rt, max: t.max_rt, median: t.median_rt, p90: t.p90, p95: t.p95, p99: t.p99, stddev: t.stddev_rt, receivedKbSec: t.received_kb_sec, sentKbSec: t.sent_kb_sec, slaStatus: t.sla_status, percentileMethod: t.percentile_method })) };
    }
    const live = await transactionStats(ref.id, { source, from: d(q.from), to: d(q.to) });
    return { source, items: live.map((t) => ({ name: t.name, samples: t.totalSamples, errors: t.failureCount, errorPct: t.errorPct, tps: t.tpsAvg, avg: t.avgRt, min: t.minRt, max: t.maxRt, median: t.medianRt, p90: t.p90, p95: t.p95, p99: t.p99, stddev: t.stddevRt, receivedKbSec: t.receivedKbSec, sentKbSec: t.sentKbSec, slaStatus: null, percentileMethod: t.percentileMethod })).sort((a, b) => b.samples - a.samples) };
  });

  r.get('/runs/:id/transactions/detail', { ...view, schema: { tags: ['Run Analysis'], summary: 'Transaction drill-down', params: idParam, querystring: z.object({ name: z.string(), ...rangeQuery }) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const { name } = req.query;
    const source = req.query.source ?? (await runSource(ref.id)) ?? 'live';
    const [series, stats] = await Promise.all([
      runSeries(ref.id, { source, transaction: name, from: d(req.query.from), to: d(req.query.to) }),
      windowStats(ref.id, { source, transaction: name, from: d(req.query.from), to: d(req.query.to) }),
    ]);
    const codes = await query(`SELECT response_code, success, sum(count)::int n FROM response_code_metrics WHERE run_id = $1 AND transaction = $2 AND source = $3 GROUP BY 1, 2 ORDER BY 3 DESC`, [ref.id, name, source]);
    const failures = await query(`SELECT error_type, response_code, message, sum(count)::int n FROM error_metrics WHERE run_id = $1 AND transaction = $2 AND source = $3 GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 50`, [ref.id, name, source]);
    const hists = await query(`SELECT histogram FROM transaction_metrics WHERE run_id = $1 AND transaction = $2 AND source = $3 AND histogram IS NOT NULL`, [ref.id, name, source], tsPool);
    const h = new Histogram();
    for (const x of hists) h.mergeSparse(x.histogram);
    const sla = await query(`SELECT metric, actual_value, warning_value, critical_value, status, unit FROM sla_results WHERE run_id = $1 AND transaction = $2`, [ref.id, name]);
    // History across previous runs of the same test
    const history = await query(
      `SELECT r.id, r.run_key, r.build_number, r.started_at, t.samples, t.tps, t.avg_rt, t.p95, t.p99, t.error_pct
       FROM test_runs r JOIN transactions t ON t.run_id = r.id AND t.name = $2 AND t.source IN ('live','jtl')
       WHERE r.test_id = $1 AND r.deleted_at IS NULL AND r.status = 'COMPLETED' ORDER BY r.started_at DESC LIMIT 20`, [ref.testId, name]);
    return { name, source, stats, series, responseCodes: codes, failures, latencyDistribution: h.total ? h.distribution() : null, sla, history: history.reverse() };
  });

  r.get('/runs/:id/endpoints', { ...view, schema: { tags: ['Run Analysis'], summary: 'Normalized API endpoint statistics', params: idParam, querystring: z.object(rangeQuery) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const params: unknown[] = [ref.id];
    let cond = '';
    if (req.query.from) { params.push(d(req.query.from)); cond += ` AND m.ts >= $${params.length}`; }
    if (req.query.to) { params.push(d(req.query.to)); cond += ` AND m.ts < $${params.length}`; }
    const rows = await query(
      `SELECT e.id, e.method, e.path_template, m.histogram, m.status_codes, m.sample_count, m.error_count, m.sum_rt, m.min_rt, m.max_rt, m.p95, m.p99, m.ts, m.interval_sec
       FROM api_metrics m JOIN api_endpoints e ON e.id = m.endpoint_id WHERE m.run_id = $1 ${cond}`, params, tsPool);
    const win = await windowStats(ref.id, { from: d(req.query.from), to: d(req.query.to) });
    const by = new Map<string, any[]>();
    for (const x of rows) { const a = by.get(x.id) ?? []; a.push(x); by.set(x.id, a); }
    return [...by.values()].map((rs) => {
      const n = rs.reduce((a, x) => a + x.sample_count, 0);
      const err = rs.reduce((a, x) => a + x.error_count, 0);
      const exact = rs.every((x) => x.histogram);
      const h = new Histogram();
      if (exact) for (const x of rs) h.mergeSparse(x.histogram);
      const codes: Record<string, number> = {};
      for (const x of rs) for (const [c, v] of Object.entries(x.status_codes ?? {})) codes[c] = (codes[c] ?? 0) + Number(v);
      const min = Math.min(...rs.map((x) => x.min_rt ?? Infinity));
      const max = Math.max(...rs.map((x) => x.max_rt ?? -Infinity));
      return {
        id: rs[0].id, method: rs[0].method, endpoint: rs[0].path_template, requests: n, errors: err, errorPct: n ? (err / n) * 100 : 0,
        tps: win ? n / win.durationSec : null, avg: n ? rs.reduce((a, x) => a + x.sum_rt, 0) / n : null, min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null,
        p95: exact ? h.percentile(95, min, max) : null, p99: exact ? h.percentile(99, min, max) : null, statusCodes: codes,
      };
    }).sort((a, b) => b.requests - a.requests);
  });

  r.get('/runs/:id/endpoints/:endpointId', { ...view, schema: { tags: ['Run Analysis'], summary: 'Endpoint drill-down', params: z.object({ id: z.string(), endpointId: z.string().uuid() }) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const ep = await one(`SELECT * FROM api_endpoints WHERE id = $1 AND application_id = $2`, [req.params.endpointId, ref.applicationId]);
    if (!ep) throw badRequest('Endpoint does not belong to this run\'s application');
    const win = await runWindow(ref.id, (await runSource(ref.id)) ?? 'live');
    const step = win.from && win.to ? chooseStep(win.from.getTime(), win.to.getTime(), 300, win.minInterval) : 10;
    const rows = await query(
      `SELECT floor(extract(epoch from ts)/$3)*$3*1000 AS t, sum(sample_count)::int n, sum(error_count)::int err, sum(sum_rt) s, array_agg(histogram) hs, max(interval_sec) iv
       FROM api_metrics WHERE run_id = $1 AND endpoint_id = $2 GROUP BY 1 ORDER BY 1`, [ref.id, ep.id, step], tsPool);
    const all = new Histogram();
    const points = rows.map((x) => {
      const h = new Histogram();
      for (const s of x.hs) { h.mergeSparse(s); all.mergeSparse(s); }
      return { t: Number(x.t), count: x.n, tps: x.n / Math.max(step, x.iv), errors: x.err, avg: x.n ? x.s / x.n : null, p95: h.percentile(95), p99: h.percentile(99) };
    });
    const codes = await query(`SELECT key AS code, sum(value::int)::int n FROM api_metrics, jsonb_each_text(status_codes) WHERE run_id = $1 AND endpoint_id = $2 GROUP BY 1 ORDER BY 2 DESC`, [ref.id, ep.id]);
    const history = await query(
      `SELECT r.run_key, r.build_number, r.started_at, sum(m.sample_count)::int n, sum(m.sum_rt)/NULLIF(sum(m.sample_count),0) avg, sum(m.error_count)::float/NULLIF(sum(m.sample_count),0)*100 err
       FROM api_metrics m JOIN test_runs r ON r.id = m.run_id WHERE m.endpoint_id = $1 AND r.test_id = $2 AND r.deleted_at IS NULL GROUP BY r.id ORDER BY r.started_at DESC LIMIT 20`, [ep.id, ref.testId]);
    return { endpoint: ep, step, points, statusCodes: codes, latencyDistribution: all.total ? all.distribution() : null, p95: all.percentile(95), p99: all.percentile(99), history: history.reverse() };
  });

  r.get('/runs/:id/errors', {
    ...view,
    schema: { tags: ['Run Analysis'], summary: 'Error analysis grouped by HTTP status, sampler, endpoint, message, type or time', params: idParam, querystring: z.object({ groupBy: z.enum(['response_code', 'transaction', 'endpoint', 'message', 'error_type', 'time']).default('response_code'), ...rangeQuery }) },
  }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const g = req.query.groupBy;
    if (g === 'time') {
      const win = await runWindow(ref.id, (await runSource(ref.id)) ?? 'live');
      const step = win.from && win.to ? chooseStep(win.from.getTime(), win.to.getTime(), 200, 5) : 10;
      return query(`SELECT floor(extract(epoch from ts)/$2)*$2*1000 AS t, error_type, sum(count)::int n FROM error_metrics WHERE run_id = $1 GROUP BY 1, 2 ORDER BY 1`, [ref.id, step]);
    }
    const col = g === 'endpoint' ? "COALESCE(endpoint, '(unknown)')" : g;
    const total = await one(`SELECT sum(sample_count)::bigint n FROM run_metrics WHERE run_id = $1 AND source = $2`, [ref.id, (await runSource(ref.id)) ?? 'live']);
    const rows = await query(
      `SELECT ${col} AS key, sum(count)::int AS count, array_agg(DISTINCT error_type) AS types, (array_agg(message ORDER BY count DESC))[1] AS sample_message, min(ts) AS first_seen, max(ts) AS last_seen
       FROM error_metrics WHERE run_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 200`, [ref.id]);
    const errTotal = rows.reduce((a, x) => a + x.count, 0);
    return rows.map((x) => ({ ...x, pctOfErrors: errTotal ? (x.count / errTotal) * 100 : 0, pctOfAll: total?.n ? (x.count / Number(total.n)) * 100 : null }));
  });

  r.get('/runs/:id/response-codes', { ...view, schema: { tags: ['Run Analysis'], summary: 'Response code distribution + series', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const source = (await runSource(ref.id)) ?? 'live';
    const win = await runWindow(ref.id, source);
    const step = win.from && win.to ? chooseStep(win.from.getTime(), win.to.getTime(), 300, win.minInterval) : 10;
    const [dist, series] = await Promise.all([
      query(`SELECT response_code, bool_and(success) success, sum(count)::int n FROM response_code_metrics WHERE run_id = $1 AND source = $2 AND transaction <> '__all__' GROUP BY 1 ORDER BY 3 DESC`, [ref.id, source]),
      query(`SELECT floor(extract(epoch from ts)/$3)*$3*1000 AS t, response_code, sum(count)::int n FROM response_code_metrics WHERE run_id = $1 AND source = $2 GROUP BY 1, 2 ORDER BY 1`, [ref.id, source, step]),
    ]);
    return { step, distribution: dist, series };
  });

  r.get('/runs/:id/latency-distribution', { ...view, schema: { tags: ['Run Analysis'], summary: 'Latency histogram (exact buckets when raw samples were ingested)', params: idParam, querystring: z.object({ transaction: z.string().optional() }) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const source = (await runSource(ref.id)) ?? 'live';
    const rows = req.query.transaction
      ? await query(`SELECT histogram FROM transaction_metrics WHERE run_id = $1 AND source = $2 AND transaction = $3`, [ref.id, source, req.query.transaction], tsPool)
      : await query(`SELECT histogram FROM run_metrics WHERE run_id = $1 AND source = $2`, [ref.id, source], tsPool);
    if (!rows.length || rows.some((x) => !x.histogram)) return { available: false, reason: 'Latency distribution requires raw samples (JTL upload or JSON samples). Pre-aggregated sources only provide percentiles.' };
    const h = new Histogram();
    for (const x of rows) h.mergeSparse(x.histogram);
    return { available: true, total: h.total, buckets: h.distribution() };
  });

  // Heatmap: time x latency bucket counts
  r.get('/runs/:id/latency-heatmap', { ...view, schema: { tags: ['Run Analysis'], summary: 'Latency heatmap (time × latency bucket)', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const source = (await runSource(ref.id)) ?? 'live';
    const win = await runWindow(ref.id, source);
    if (!win.from || !win.to) return { available: false };
    const step = chooseStep(win.from.getTime(), win.to.getTime(), 120, win.minInterval);
    const rows = await query(`SELECT floor(extract(epoch from ts)/$3)*$3*1000 AS t, array_agg(histogram) hs FROM run_metrics WHERE run_id = $1 AND source = $2 GROUP BY 1 ORDER BY 1`, [ref.id, source, step], tsPool);
    if (rows.some((x) => x.hs.some((h: any) => !h))) return { available: false, reason: 'Requires raw samples' };
    const edges = [0, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, Infinity];
    const cells: [number, number, number][] = [];
    rows.forEach((x, xi) => {
      const h = new Histogram();
      for (const s of x.hs) h.mergeSparse(s);
      const counts = new Array(edges.length - 1).fill(0);
      for (const b of h.distribution()) {
        const mid = (b.from + b.to) / 2;
        const i = edges.findIndex((e, k) => mid >= e && mid < edges[k + 1]);
        if (i >= 0) counts[i] += b.count;
      }
      counts.forEach((c, yi) => { if (c) cells.push([xi, yi, c]); });
    });
    return { available: true, step, times: rows.map((x) => Number(x.t)), buckets: edges.slice(0, -1).map((e, i) => `${e}-${Number.isFinite(edges[i + 1]) ? edges[i + 1] : '∞'} ms`), cells };
  });

  r.get('/runs/:id/infrastructure', { ...view, schema: { tags: ['Run Analysis'], summary: 'Server metrics for the run window, per server', params: idParam, querystring: z.object(rangeQuery) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const servers = await query(
      `SELECT s.id, s.name, s.hostname, s.role, s.os, s.cpu_cores, s.memory_mb, s.status, avg(m.cpu_pct) cpu_avg, max(m.cpu_pct) cpu_max, avg(m.memory_pct) mem_avg, max(m.memory_pct) mem_max,
              max(m.disk_pct) disk_max, avg(m.net_in_bps) net_in_avg, avg(m.net_out_bps) net_out_avg, max(m.load_avg_1m) load_max, max(m.tcp_connections) tcp_max, max(m.file_descriptors) fd_max
       FROM server_metrics m JOIN servers s ON s.id = m.server_id WHERE m.run_id = $1 GROUP BY s.id ORDER BY s.role, s.name`, [ref.id], tsPool);
    const series = await infraSeries('server_metrics', ['cpu_pct', 'memory_pct', 'disk_pct', 'disk_read_bps', 'disk_write_bps', 'net_in_bps', 'net_out_bps', 'load_avg_1m', 'tcp_connections', 'processes', 'file_descriptors'],
      { runId: ref.id, from: d(req.query.from), to: d(req.query.to), step: req.query.step, groupBy: 'server_id' });
    return { servers, step: series.step, series: series.points };
  });

  r.get('/runs/:id/jvm', { ...view, schema: { tags: ['Run Analysis'], summary: 'JVM metrics (heap, GC, threads, classes)', params: idParam, querystring: z.object(rangeQuery) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const targets = await query(`SELECT DISTINCT COALESCE(sv.name, s.name) AS name, j.server_id, j.service_id FROM jvm_metrics j LEFT JOIN servers s ON s.id = j.server_id LEFT JOIN services sv ON sv.id = j.service_id WHERE j.run_id = $1`, [ref.id], tsPool);
    const series = await infraSeries('jvm_metrics', ['heap_used_mb', 'heap_committed_mb', 'heap_max_mb', 'nonheap_used_mb', 'gc_count', 'gc_time_ms', 'gc_max_pause_ms', 'thread_count', 'peak_threads', 'classes_loaded'],
      { runId: ref.id, from: d(req.query.from), to: d(req.query.to), step: req.query.step, groupBy: 'server_id' });
    return { targets, step: series.step, series: series.points };
  });

  r.get('/runs/:id/database', { ...view, schema: { tags: ['Run Analysis'], summary: 'Database metrics', params: idParam, querystring: z.object(rangeQuery) } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const targets = await query(`SELECT DISTINCT sv.id, sv.name, sv.technology, d.db_engine FROM database_metrics d LEFT JOIN services sv ON sv.id = d.service_id WHERE d.run_id = $1`, [ref.id], tsPool);
    const series = await infraSeries('database_metrics', ['connections', 'active_connections', 'max_connections', 'query_latency_ms', 'slow_queries', 'locks', 'deadlocks', 'cpu_pct', 'memory_pct', 'transactions_per_sec'],
      { runId: ref.id, from: d(req.query.from), to: d(req.query.to), step: req.query.step, groupBy: 'service_id' });
    return { targets, step: series.step, series: series.points };
  });

  r.get('/runs/:id/services', { ...view, schema: { tags: ['Run Analysis'], summary: 'Service health + service map for the run', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const services = await query(
      `SELECT s.id, s.name, s.kind, s.technology, s.health_status, avg(m.request_rate) request_rate, avg(m.error_rate_pct) error_rate_pct, avg(m.avg_latency_ms) avg_latency_ms,
              max(m.p95_latency_ms) p95_latency_ms, sum(m.exceptions)::int exceptions, avg(m.cpu_pct) cpu_pct, avg(m.memory_pct) memory_pct
       FROM services s LEFT JOIN service_metrics m ON m.service_id = s.id AND m.run_id = $1
       WHERE s.environment_id = $2 GROUP BY s.id ORDER BY s.kind, s.name`, [ref.id, ref.environmentId]);
    const deps = services.length ? await query(`SELECT source_service_id AS source, target_service_id AS target FROM service_dependencies WHERE source_service_id = ANY($1::uuid[])`, [services.map((s) => s.id)]) : [];
    return { services, dependencies: deps };
  });

  r.get('/runs/:id/logs', {
    ...view,
    schema: { tags: ['Run Analysis'], summary: 'Correlated logs (jump from a time point with ?around=<ts>)', params: idParam, querystring: z.object({ from: z.string().optional(), to: z.string().optional(), around: z.string().optional(), windowSec: z.coerce.number().default(60), level: z.string().optional(), service: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).default(500) }) },
  }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const q = req.query;
    const params: unknown[] = [ref.id];
    const conds = ['run_id = $1'];
    let from = d(q.from), to = d(q.to);
    if (q.around) { const t = d(q.around)!.getTime(); from = new Date(t - q.windowSec * 1000); to = new Date(t + q.windowSec * 1000); }
    if (from) { params.push(from); conds.push(`ts >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`ts <= $${params.length}`); }
    if (q.level) { params.push(q.level.split(',').map((s) => s.toUpperCase())); conds.push(`level = ANY($${params.length})`); }
    if (q.service) { params.push(q.service); conds.push(`service = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); conds.push(`message ILIKE $${params.length}`); }
    params.push(q.limit);
    const items = await query(`SELECT id, ts, level, service, server, logger, message FROM log_entries WHERE ${conds.join(' AND ')} ORDER BY ts LIMIT $${params.length}`, params);
    const facets = await query(`SELECT level, service, count(*)::int n FROM log_entries WHERE run_id = $1 GROUP BY 1, 2`, [ref.id]);
    return { items, facets, from, to };
  });

  r.get('/runs/:id/events', { ...view, schema: { tags: ['Run Analysis'], summary: 'Events, annotations and alerts for the run', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const [events, annotations, alerts] = await Promise.all([
      query(`SELECT * FROM events WHERE run_id = $1 OR (run_id IS NULL AND environment_id = $2 AND ts BETWEEN (SELECT COALESCE(started_at, created_at) - interval '1 hour' FROM test_runs WHERE id = $1) AND (SELECT COALESCE(ended_at, now()) + interval '1 hour' FROM test_runs WHERE id = $1)) ORDER BY ts`, [ref.id, ref.environmentId]),
      query(`SELECT * FROM annotations WHERE run_id = $1 ORDER BY ts`, [ref.id]),
      query(`SELECT id, type, severity, status, title, message, value, threshold, fired_at, resolved_at FROM alerts WHERE run_id = $1 ORDER BY fired_at`, [ref.id]),
    ]);
    return { events, annotations, alerts };
  });

  r.get('/runs/:id/sla', { ...view, schema: { tags: ['Run Analysis'], summary: 'SLA evaluation results', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const results = await query(`SELECT s.*, r.name AS rule_name FROM sla_results s LEFT JOIN sla_rules r ON r.id = s.rule_id WHERE s.run_id = $1 ORDER BY CASE s.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'PASS' THEN 2 ELSE 3 END, s.scope, s.metric`, [ref.id]);
    const profile = await one(`SELECT sp.id, sp.name FROM performance_tests t JOIN sla_profiles sp ON sp.id = t.sla_profile_id WHERE t.id = $1`, [ref.testId]);
    const evaluated = results.filter((x) => x.status !== 'NO_DATA');
    const passed = evaluated.filter((x) => x.status !== 'FAIL').length;
    return { profile, results, total: evaluated.length, passed, failed: evaluated.length - passed, warnings: evaluated.filter((x) => x.status === 'WARNING').length, compliancePct: evaluated.length ? (passed / evaluated.length) * 100 : null };
  });

  r.get('/runs/:id/insights', { ...view, schema: { tags: ['Run Analysis'], summary: 'Insights, recommendations, regressions and bottleneck analysis', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const [insights, recommendations, regressions, run] = await Promise.all([
      query(`SELECT * FROM insights WHERE run_id = $1 ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at`, [ref.id]),
      query(`SELECT * FROM recommendations WHERE run_id = $1 ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END`, [ref.id]),
      query(`SELECT g.*, b.run_key AS baseline_run_key FROM regressions g LEFT JOIN test_runs b ON b.id = g.baseline_run_id WHERE g.run_id = $1 ORDER BY g.direction, g.severity DESC, g.change_pct DESC NULLS LAST`, [ref.id]),
      one(`SELECT analysis, analyzed_at, result, result_breakdown, score_breakdown, performance_score FROM test_runs WHERE id = $1`, [ref.id]),
    ]);
    return { insights, recommendations, regressions, analysis: run.analysis, analyzedAt: run.analyzed_at, result: run.result, resultBreakdown: run.result_breakdown, score: run.performance_score, scoreBreakdown: run.score_breakdown };
  });

  r.get('/runs/:id/comparison', { ...view, schema: { tags: ['Run Analysis'], summary: 'Compare this run with its baseline (or ?with=<run>)', params: idParam, querystring: z.object({ with: z.string().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const ref = await resolveRun(req.params.id, p);
    const other = req.query.with ? await resolveRun(req.query.with, p) : null;
    const base = other ? { id: other.id, runKey: other.runKey, reason: 'selected' } : await resolveBaseline(ref.id);
    if (!base) return { available: false, reason: 'No baseline or previous completed run of this test' };
    return { available: true, baseline: base, ...(await compareRuns([base.id, ref.id])) };
  });

  r.get('/runs/:id/reconciliation', { ...view, schema: { tags: ['Run Analysis'], summary: 'Data consistency: live metrics vs uploaded HTML report', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    return reconcile(ref.id);
  });

  const RAW_TABLES: Record<string, string> = {
    run_metrics: 'ts, source, interval_sec, active_threads, sample_count, error_count, sum_rt, min_rt, max_rt, p50, p90, p95, p99, bytes_sent, bytes_received',
    transaction_metrics: 'ts, source, transaction, interval_sec, sample_count, error_count, sum_rt, min_rt, max_rt, p50, p90, p95, p99, bytes_sent, bytes_received',
    response_code_metrics: 'ts, source, transaction, response_code, success, count',
    error_metrics: 'ts, source, transaction, endpoint, response_code, error_type, message, count',
    server_metrics: 'ts, server_id, cpu_pct, memory_pct, disk_pct, net_in_bps, net_out_bps, load_avg_1m, tcp_connections',
    jvm_metrics: 'ts, server_id, service_id, heap_used_mb, heap_max_mb, gc_count, gc_time_ms, gc_max_pause_ms, thread_count',
    database_metrics: 'ts, service_id, connections, active_connections, query_latency_ms, slow_queries, locks, cpu_pct',
    metric_points: 'ts, metric, value, tags, source',
  };
  r.get('/runs/:id/raw', {
    ...view,
    schema: { tags: ['Run Analysis'], summary: 'Raw metric rows (JSON or CSV download)', params: idParam, querystring: z.object({ table: z.enum(Object.keys(RAW_TABLES) as [string, ...string[]]).default('run_metrics'), format: z.enum(['json', 'csv']).default('json'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(10000).default(200), metric: z.string().optional() }) },
  }, async (req, reply) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const q = req.query;
    const params: unknown[] = [ref.id];
    let extra = '';
    if (q.metric && q.table === 'metric_points') { params.push(q.metric); extra = ` AND metric = $${params.length}`; }
    if (q.metric && q.table === 'transaction_metrics') { params.push(q.metric); extra = ` AND transaction = $${params.length}`; }
    const total = await one(`SELECT count(*)::int n FROM ${q.table} WHERE run_id = $1${extra}`, params, tsPool);
    if (q.format === 'csv') {
      const rows = await query(`SELECT ${RAW_TABLES[q.table]} FROM ${q.table} WHERE run_id = $1${extra} ORDER BY ts LIMIT 1000000`, params, tsPool);
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${ref.runKey}-${q.table}.csv"`).send(toCsv(rows.map((x) => ({ ...x, ts: new Date(x.ts).toISOString() }))));
    }
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(`SELECT ${RAW_TABLES[q.table]} FROM ${q.table} WHERE run_id = $1${extra} ORDER BY ts LIMIT $${params.length - 1} OFFSET $${params.length}`, params, tsPool);
    const metrics = q.table === 'metric_points' ? await query(`SELECT DISTINCT metric FROM metric_points WHERE run_id = $1`, [ref.id]) : [];
    return { table: q.table, columns: RAW_TABLES[q.table].split(', '), total: total.n, page: q.page, pageSize: q.pageSize, items: rows, metrics: metrics.map((m) => m.metric), runId: ref.runKey };
  });

  r.get('/runs/:id/audit', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Run Analysis'], summary: 'Audit trail for the run and its artifacts', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    return query(
      `SELECT id, ts, user_email, action, resource_type, resource_id, ip, result, details FROM audit_logs
       WHERE resource_id = $1 OR details->>'runId' IN ($1, $2) OR resource_id IN (SELECT id::text FROM artifacts WHERE run_id = $1::uuid) ORDER BY ts DESC LIMIT 500`, [ref.id, ref.runKey]);
  });

  // Server-Sent Events: live metrics without page refresh. ?interval=2..60 seconds (configurable refresh).
  app.get('/runs/:id/stream', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Live'], summary: 'Live metrics stream (SSE). Auth via ?access_token=<JWT>', params: idParam, querystring: z.object({ interval: z.coerce.number().min(1).max(60).default(5), access_token: z.string().optional() }) } as any }, async (req: any, reply) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const intervalMs = Number(req.query.interval ?? 5) * 1000;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': req.headers.origin ?? '*' });
    liveConnections.inc();
    let lastT = 0;
    let closed = false;
    const send = (event: string, data: unknown) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const tick = async () => {
      try {
        const run = await one(`SELECT status, result, performance_score, started_at, ended_at, live_last_ingest_at FROM test_runs WHERE id = $1`, [ref.id]);
        const source = (await runSource(ref.id)) ?? 'live';
        const from = lastT ? new Date(lastT - 10000) : undefined; // re-send recent buckets (late data merges)
        const series = await runSeries(ref.id, { source, from, step: 5 });
        const stats = await windowStats(ref.id, { source });
        const recent = await windowStats(ref.id, { source, from: new Date(Date.now() - 60000) });
        if (series.points.length) lastT = series.points[series.points.length - 1].t;
        const cpu = await one(`SELECT avg(cpu_pct) cpu, avg(memory_pct) mem FROM server_metrics WHERE run_id = $1 AND ts > now() - interval '30 seconds'`, [ref.id], tsPool);
        send('metrics', { run, points: series.points, step: series.step, percentileMethod: series.percentileMethod, totals: stats, last60s: recent, infra: cpu });
      } catch (e) { send('error', { message: (e as Error).message }); }
    };
    const onEvent = (ev: { type: string; data: unknown }) => { if (ev.type === 'status') send('status', ev.data); };
    hub.on(`run:${ref.id}`, onEvent);
    await tick();
    const timer = setInterval(tick, intervalMs);
    const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      closed = true;
      clearInterval(timer);
      clearInterval(ping);
      hub.off(`run:${ref.id}`, onEvent);
      liveConnections.dec();
    });
  });

  // Live: currently running runs with last-60s KPIs
  r.get('/live/runs', { ...view, schema: { tags: ['Live'], summary: 'Running tests with live KPIs', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const runs = await query(
      `SELECT r.id, r.run_key, r.status, r.started_at, r.live_last_ingest_at, r.virtual_users, r.target_tps, t.name test_name, e.name environment_name
       FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN environments e ON e.id = r.environment_id
       WHERE r.organization_id = $1 AND r.deleted_at IS NULL AND (r.status IN ('RUNNING','ANALYZING') OR r.ended_at > now() - interval '15 minutes') AND ($2::uuid IS NULL OR r.project_id = $2)
       ORDER BY r.started_at DESC NULLS LAST LIMIT 50`, [p.orgId, req.query.projectId ?? p.projectId ?? null]);
    return Promise.all(runs.map(async (x) => ({ ...x, last60s: x.status === 'RUNNING' ? await windowStats(x.id, { from: new Date(Date.now() - 60000) }) : null, totals: await windowStats(x.id) })));
  });

  // Baseline delta helper for KPI cards
  r.get('/runs/:id/kpi-deltas', { ...view, schema: { tags: ['Run Analysis'], summary: 'KPI change vs baseline', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const base = await resolveBaseline(ref.id);
    if (!base) return { baseline: null, deltas: {} };
    const [a, b] = await Promise.all([windowStats(base.id), windowStats(ref.id)]);
    const keys = ['tpsAvg', 'avgRt', 'p50', 'p90', 'p95', 'p99', 'errorPct', 'maxRt', 'tpsPeak'] as const;
    return { baseline: base, deltas: Object.fromEntries(keys.map((k) => [k, a && b ? pctChange(a[k] as number, b[k] as number) : null])) };
  });
}
