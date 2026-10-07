import type { FastifyInstance, FastifyRequest } from 'fastify';
import { aggregator, type AggregatePoint, type RawSample } from './aggregator.js';
import { parseLineProtocol, type LinePoint } from './lineProtocol.js';
import { resolveRun, ensureIngestible, type RunRef } from './runCache.js';
import { checkIngestRate } from './rateLimit.js';
import { requirePermission, principalOf, type Principal } from '../auth/principal.js';
import { badRequest, notFound } from '../lib/errors.js';
import { typed, z } from '../lib/http.js';
import { one, query, bulkInsert, pool } from '../db/pool.js';
import { selfMetrics } from '../selfmon/registry.js';
import { ingestInfrastructure, infraPayload } from './infra.js';

const rawSampleSchema = z.object({
  ts: z.union([z.number(), z.string()]),
  label: z.string().min(1).max(300),
  elapsed: z.number().min(0),
  success: z.boolean().default(true),
  responseCode: z.union([z.string(), z.number()]).nullish(),
  responseMessage: z.string().nullish(),
  failureMessage: z.string().nullish(),
  bytes: z.number().nullish(),
  sentBytes: z.number().nullish(),
  latency: z.number().nullish(),
  connect: z.number().nullish(),
  url: z.string().nullish(),
  method: z.string().nullish(),
  allThreads: z.number().nullish(),
});

// Accepts both the documented aggregate shape and common aliases
const aggregateSchema = z.object({
  runId: z.string().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  ts: z.union([z.number(), z.string()]).optional(),
  intervalSec: z.number().int().min(1).max(3600).optional(),
  transaction: z.string().max(300).nullish(),
  requests: z.number().min(0).optional(),
  count: z.number().min(0).optional(),
  errors: z.number().min(0).optional(),
  throughput: z.number().optional(),
  avgResponseTime: z.number().optional(),
  avg: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  p50: z.number().optional(), p75: z.number().optional(), p90: z.number().optional(),
  p95: z.number().optional(), p99: z.number().optional(), p999: z.number().optional(),
  sentBytes: z.number().optional(),
  receivedBytes: z.number().optional(),
  activeUsers: z.number().optional(),
  activeThreads: z.number().optional(),
  responseCodes: z.record(z.string(), z.number()).optional(),
  errorDetails: z.array(z.object({ responseCode: z.string().nullish(), message: z.string().nullish(), count: z.number() })).optional(),
});

const genericPointSchema = z.object({
  metric: z.string().min(1).max(200),
  value: z.number(),
  ts: z.union([z.number(), z.string()]).optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  runId: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const toMs = (v: number | string | undefined | null): number => {
  if (v == null) return Date.now();
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v > 1e14 ? v / 1000 : v;
  if (/^\d+$/.test(v)) return toMs(Number(v));
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw badRequest(`Invalid timestamp '${v}'`);
  return t;
};

export function normalizeAggregate(a: z.infer<typeof aggregateSchema>): AggregatePoint {
  const count = a.count ?? a.requests ?? 0;
  return {
    ts: toMs(a.ts ?? a.timestamp),
    intervalSec: a.intervalSec,
    transaction: a.transaction ?? null,
    count,
    errors: a.errors ?? 0,
    avg: a.avg ?? a.avgResponseTime ?? null,
    min: a.min ?? null, max: a.max ?? null,
    p50: a.p50 ?? null, p75: a.p75 ?? null, p90: a.p90 ?? null, p95: a.p95 ?? null, p99: a.p99 ?? null, p999: a.p999 ?? null,
    sentBytes: a.sentBytes ?? null, receivedBytes: a.receivedBytes ?? null,
    activeThreads: a.activeThreads ?? a.activeUsers ?? null,
    responseCodes: a.responseCodes, errorDetails: a.errorDetails,
  };
}

const normalizeSample = (s: z.infer<typeof rawSampleSchema>): RawSample => ({
  ...s, ts: toMs(s.ts), responseCode: s.responseCode == null ? null : String(s.responseCode),
});

async function ingestForRun(req: FastifyRequest, run: RunRef, samples: RawSample[], points: AggregatePoint[]) {
  const all = [...samples.map((s) => s.ts), ...points.map((p) => p.ts)];
  if (!all.length) return { accepted: 0 };
  await ensureIngestible(run, new Date(Math.min(...all)));
  if (samples.length) aggregator.addSamples(run, samples);
  if (points.length) aggregator.addAggregates(run, points);
  await aggregator.maybeFlush();
  return { accepted: samples.length + points.length };
}

// JMeter InfluxDB Backend Listener compatibility ------------------------------------------
const lastTsPerRun = new Map<string, number>();
const PCT_FIELD: Record<string, keyof AggregatePoint> = { 'pct50.0': 'p50', 'pct75.0': 'p75', 'pct90.0': 'p90', 'pct95.0': 'p95', 'pct99.0': 'p99', 'pct99.9': 'p999' };

async function handleInflux(req: FastifyRequest, body: string) {
  const q = req.query as Record<string, string | undefined>;
  const { points, errors } = parseLineProtocol(body, q.precision);
  const accepted = await ingestLinePoints(principalOf(req), points, { runKey: q.runId, measurement: q.measurement });
  if (errors.length) selfMetrics.inc('ingest_parse_errors', errors.length);
  return { accepted, parseErrors: errors };
}

interface JmeterRow { txn: string; ts: number; kind: string; data: Record<string, any> }

/**
 * Groups the all/ok/ko/response-code lines of one listener send per transaction.
 * JMeter stamps each line separately, so lines of the same send can differ by a few ms;
 * grouping by exact timestamp would count a transaction's "all" and "ok" lines twice.
 * Sends are ≥ 1 s apart, so lines within 500 ms of a group's first line (and not
 * repeating a kind already in it) belong to the same send.
 */
function groupSends(rows: JmeterRow[]): Record<string, Record<string, any>>[] {
  const byTxn = new Map<string, JmeterRow[]>();
  for (const r of rows) (byTxn.get(r.txn) ?? byTxn.set(r.txn, []).get(r.txn)!).push(r);
  const out: Record<string, Record<string, any>>[] = [];
  for (const list of byTxn.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let cur: { start: number; g: Record<string, Record<string, any>> } | null = null;
    for (const r of list) {
      if (!cur || r.ts - cur.start > 500 || cur.g[r.kind]) out.push((cur = { start: r.ts, g: {} }).g);
      cur.g[r.kind] = { ...r.data, __ts: cur.start };
    }
  }
  return out;
}

export interface LineIngestOptions {
  runKey?: string;
  measurement?: string;
  /** metric source: 'live' for the Backend Listener, 'import' for InfluxDB imports */
  source?: string;
  /** accept data for finished runs (imports of historical results) */
  allowCompleted?: boolean;
  /** interval of the reported points; inferred from consecutive writes when omitted */
  intervalSec?: number;
}

/**
 * Stores JMeter InfluxdbBackendListenerClient points (measurement `jmeter`, plus `events`
 * annotations and any other measurement as generic metrics) for their runs.
 */
export async function ingestLinePoints(principal: Principal, points: LinePoint[], opts: LineIngestOptions = {}) {
  const measurementName = opts.measurement || 'jmeter';
  const source = opts.source ?? 'live';
  const byRun = new Map<string, { run: RunRef; rows: JmeterRow[]; threads: { ts: number; v: number; s?: number; f?: number }[]; events: { ts: number; text: string }[]; generic: any[] }>();

  for (const p of points) {
    const runKey = opts.runKey || p.tags.runId || p.tags.run_id || p.tags.runid || (/^PF-\d{4}-\d{2}-\d{2}-\d+$/.test(p.tags.application ?? '') ? p.tags.application : undefined);
    if (!runKey) throw badRequest('Run ID is required: add ?runId=<RUN_ID> to the listener URL or a TAG_runId listener parameter');
    let entry = byRun.get(runKey);
    if (!entry) {
      const run = await resolveRun(runKey, principal);
      byRun.set(runKey, (entry = { run, rows: [], threads: [], events: [], generic: [] }));
    }
    const ts = p.timestamp ?? Date.now();
    if (p.measurement === measurementName) {
      const txn = p.tags.transaction ?? 'all';
      if (txn === 'internal') {
        const v = Number(p.fields.maxAT ?? p.fields.meanAT ?? 0);
        entry.threads.push({ ts, v, s: Number(p.fields.startedT ?? NaN), f: Number(p.fields.endedT ?? NaN) });
        continue;
      }
      const kind = p.tags.responseCode !== undefined ? 'err:' + p.tags.responseCode + ':' + (p.tags.responseMessage ?? '') : (p.tags.statut ?? (txn === 'all' ? 'total' : 'all'));
      entry.rows.push({ txn, ts, kind, data: { ...p.fields, __txn: txn, __rc: p.tags.responseCode, __rm: p.tags.responseMessage } });
    } else if (p.measurement === 'events') {
      entry.events.push({ ts, text: String(p.fields.text ?? p.tags.title ?? 'event') });
    } else {
      for (const [f, v] of Object.entries(p.fields)) if (typeof v === 'number') entry.generic.push({ ts, metric: `${p.measurement}.${f}`, value: v, tags: p.tags });
    }
  }

  let accepted = 0;
  for (const { run, rows, threads, events, generic } of byRun.values()) {
    const groups = groupSends(rows);
    const tsList = groups.flatMap((g) => Object.values(g).map((x) => x.__ts as number));
    const prev = lastTsPerRun.get(run.id);
    const sorted = [...new Set(tsList)].sort((a, b) => a - b);
    const first = sorted[0] ?? threads[0]?.ts ?? Date.now();
    let intervalSec = opts.intervalSec ?? (prev && first > prev ? Math.round((first - prev) / 1000) : 5);
    if (!(intervalSec >= 1 && intervalSec <= 60)) intervalSec = 5;
    if (sorted.length && source === 'live') lastTsPerRun.set(run.id, sorted[sorted.length - 1]);
    await ensureIngestible(run, new Date(first), opts.allowCompleted);

    const aggs: AggregatePoint[] = [];
    for (const g of groups) {
      const base = g.all ?? g.total ?? null;
      const ok = g.ok;
      const ko = g.ko;
      const any = base ?? ok ?? ko ?? Object.values(g)[0];
      const txn = any.__txn as string;
      const ts = any.__ts as number;
      const errDetails = Object.entries(g).filter(([k]) => k.startsWith('err:')).map(([, v]) => ({ responseCode: v.__rc ?? null, message: v.__rm ?? null, count: Number(v.count ?? 0) }));
      if (!base && !ok && !ko) {
        if (errDetails.length) aggs.push({ ts, intervalSec, transaction: txn === 'all' ? null : txn, count: 0, errors: 0, errorDetails: errDetails });
        continue;
      }
      const point: AggregatePoint = { ts, intervalSec, transaction: txn === 'all' ? null : txn, count: 0, errorDetails: errDetails };
      if (base) {
        point.count = Number(base.count ?? 0);
        point.errors = base.countError !== undefined ? Number(base.countError) : Number(ko?.count ?? 0);
        point.avg = base.avg != null ? Number(base.avg) : null;
        point.min = base.min != null ? Number(base.min) : null;
        point.max = base.max != null ? Number(base.max) : null;
        point.sentBytes = base.sb != null ? Number(base.sb) : null;
        point.receivedBytes = base.rb != null ? Number(base.rb) : null;
        for (const [f, k] of Object.entries(PCT_FIELD)) if (base[f] != null) (point as any)[k] = Number(base[f]);
      } else {
        const okc = Number(ok?.count ?? 0);
        const koc = Number(ko?.count ?? 0);
        point.count = okc + koc;
        point.errors = koc;
        if (point.count) point.avg = ((Number(ok?.avg ?? 0) * okc) + (Number(ko?.avg ?? 0) * koc)) / point.count;
        point.min = Math.min(Number(ok?.min ?? Infinity), Number(ko?.min ?? Infinity));
        point.max = Math.max(Number(ok?.max ?? -Infinity), Number(ko?.max ?? -Infinity));
        for (const [f, k] of Object.entries(PCT_FIELD)) if (ok?.[f] != null) (point as any)[k] = Number(ok[f]);
      }
      aggs.push(point);
    }
    if (aggs.length) aggregator.addAggregates(run, aggs, source);
    for (const t of threads) aggregator.setThreads(run, t.ts, t.v, Number.isFinite(t.s!) ? t.s : null, Number.isFinite(t.f!) ? t.f : null, source);
    for (const e of events) {
      await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, ts, title, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [run.projectId, run.applicationId, run.environmentId, run.id, /end|finish|stop/i.test(e.text) ? 'TEST_END' : /start/i.test(e.text) ? 'TEST_START' : 'OTHER', new Date(e.ts), e.text.slice(0, 300), source === 'live' ? 'jmeter' : 'influx_import']);
    }
    if (generic.length) await insertGeneric(run, generic, source === 'live' ? 'api' : 'influx_import');
    accepted += aggs.length + threads.length + events.length + generic.length;
  }
  await aggregator.maybeFlush();
  return accepted;
}

async function insertGeneric(run: RunRef | null, pts: { ts: number; metric: string; value: number; tags?: Record<string, string>; projectId?: string | null; environmentId?: string | null }[], source = 'api') {
  for (let i = 0; i < pts.length; i += 2000) {
    const rows = pts.slice(i, i + 2000).map((p) => [new Date(p.ts), p.metric, p.value, run?.id ?? null, run?.projectId ?? p.projectId ?? null, run?.environmentId ?? p.environmentId ?? null, JSON.stringify(p.tags ?? {}), source]);
    const [sql, params] = bulkInsert('metric_points', ['ts', 'metric', 'value', 'run_id', 'project_id', 'environment_id', 'tags', 'source'], rows);
    await query(sql, params);
  }
  selfMetrics.inc('ingest_points', pts.length);
}

export async function ingestRoutes(app: FastifyInstance) {
  const r = typed(app);
  // Line protocol bodies (JMeter InfluxDB listener sends text/plain or no content-type)
  app.addContentTypeParser(['application/octet-stream', 'text/x-influxdb-line-protocol'], { parseAs: 'string', bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  const ingestGuard = { preHandler: [requirePermission('INGEST_METRICS'), async (req: FastifyRequest) => checkIngestRate(req)] };

  r.post('/runs/:runId/metrics', {
    ...ingestGuard,
    bodyLimit: 50 * 1024 * 1024,
    schema: {
      tags: ['Ingestion'],
      summary: 'Batch-ingest metrics for a run (raw samples and/or pre-aggregated points)',
      description: 'Body may be `{ samples: RawSample[], points: Aggregate[] }`, `{ metrics: Aggregate[] }` or a bare array of aggregates. The run transitions QUEUED → RUNNING on first data. Percentiles from raw samples are exact (histogram-merged); pre-aggregated percentiles are stored as reported.',
      params: z.object({ runId: z.string() }),
      body: z.union([
        z.object({ samples: z.array(rawSampleSchema).max(200000).optional(), points: z.array(aggregateSchema).max(100000).optional(), metrics: z.array(aggregateSchema).max(100000).optional() }),
        z.array(aggregateSchema).max(100000),
      ]),
    },
  }, async (req) => {
    const run = await resolveRun(req.params.runId, principalOf(req));
    const b = req.body as any;
    const samples = Array.isArray(b) ? [] : (b.samples ?? []).map(normalizeSample);
    const points = (Array.isArray(b) ? b : [...(b.points ?? []), ...(b.metrics ?? [])]).map(normalizeAggregate);
    return { runId: run.runKey, ...(await ingestForRun(req, run, samples, points)) };
  });

  r.post('/metrics', {
    ...ingestGuard,
    bodyLimit: 50 * 1024 * 1024,
    schema: {
      tags: ['Ingestion'],
      summary: 'Generic batch ingestion (multi-run aggregates and dimensional metric points)',
      description: 'Array (or `{ items: [] }`) of either JMeter-style aggregates `{runId, timestamp, transaction, requests, errors, avgResponseTime, p95, p99}` or dimensional points `{metric, value, ts, runId?, tags}`.',
      body: z.union([z.array(z.union([genericPointSchema, aggregateSchema])).max(100000), z.object({ items: z.array(z.union([genericPointSchema, aggregateSchema])).max(100000) })]),
    },
  }, async (req) => {
    const items = (Array.isArray(req.body) ? req.body : req.body.items) as any[];
    const principal = principalOf(req);
    const byRun = new Map<string, { run: RunRef; aggs: AggregatePoint[]; generic: any[] }>();
    const orphan: any[] = [];
    for (const it of items) {
      const isGeneric = typeof it.metric === 'string' && typeof it.value === 'number';
      if (!it.runId) {
        if (!isGeneric) throw badRequest('Aggregate metrics require runId. Never store performance metrics without a run.');
        orphan.push({ ts: toMs(it.ts ?? it.timestamp), metric: it.metric, value: it.value, tags: it.tags, projectId: principal.projectId ?? null });
        continue;
      }
      let e = byRun.get(it.runId);
      if (!e) byRun.set(it.runId, (e = { run: await resolveRun(it.runId, principal), aggs: [], generic: [] }));
      if (isGeneric) e.generic.push({ ts: toMs(it.ts ?? it.timestamp), metric: it.metric, value: it.value, tags: it.tags });
      else e.aggs.push(normalizeAggregate(it));
    }
    let accepted = 0;
    for (const e of byRun.values()) {
      if (e.aggs.length) accepted += (await ingestForRun(req, e.run, [], e.aggs)).accepted;
      if (e.generic.length) { await insertGeneric(e.run, e.generic); accepted += e.generic.length; }
    }
    if (orphan.length) { await insertGeneric(null, orphan); accepted += orphan.length; }
    return { accepted, runs: [...byRun.values()].map((e) => e.run.runKey) };
  });

  // InfluxDB v1 (/write) and v2 (/api/v2/write) compatible endpoints for JMeter's built-in InfluxdbBackendListenerClient
  for (const path of ['/ingest/influx/write', '/ingest/influx/api/v2/write']) {
    app.post(path, {
      ...ingestGuard,
      bodyLimit: 50 * 1024 * 1024,
      schema: {
        tags: ['Ingestion'],
        summary: 'InfluxDB line-protocol endpoint for the JMeter Backend Listener',
        description: 'Configure JMeter Backend Listener → InfluxdbBackendListenerClient with influxdbUrl=`<perfmon>/api/v1/ingest/influx/write?runId=<RUN_ID>` and influxdbToken=`<API key>`. Returns 204 like InfluxDB.',
        querystring: z.object({ runId: z.string().optional(), db: z.string().optional(), precision: z.string().optional(), measurement: z.string().optional() }).passthrough(),
      },
    }, async (req, reply) => {
      const body = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!body.trim()) return reply.code(204).send();
      const res = await handleInflux(req, body);
      if (res.parseErrors.length && res.accepted === 0) throw badRequest('Unable to parse line protocol', res.parseErrors);
      return reply.code(204).send();
    });
  }

  r.post('/ingest/infrastructure', {
    ...ingestGuard,
    bodyLimit: 20 * 1024 * 1024,
    schema: {
      tags: ['Ingestion'],
      summary: 'Perfmon Collector: server, JVM, database and service metrics',
      description: 'Servers/services are auto-registered by name. If runId is omitted, data is correlated to the RUNNING run in the same environment (if any).',
      body: infraPayload,
    },
  }, async (req) => ingestInfrastructure(req, req.body));

  r.post('/ingest/flush', { preHandler: requirePermission('INGEST_METRICS'), schema: { tags: ['Ingestion'], summary: 'Force-flush buffered metrics (testing/CI)', body: z.object({ runId: z.string().optional() }).optional() } }, async (req) => {
    const runId = req.body?.runId ? (await resolveRun(req.body.runId, principalOf(req))).id : undefined;
    await aggregator.flush(true, runId);
    return { ok: true };
  });
}

export { insertGeneric };
