import { one, query, tsPool } from '../db/pool.js';
import type { Principal } from '../auth/principal.js';
import { Histogram } from '../lib/histogram.js';
import { pctChange, round } from '../lib/stats.js';
import { Conds } from '../lib/scope.js';
import { runSeries, windowStats, transactionStats, runSource, runWindow, chooseStep, type SeriesPoint } from '../metrics/series.js';
import { primarySummary, primaryTransactions, infraAggregates } from '../analytics/summary.js';
import { resolveBaseline } from '../analytics/compare.js';

/**
 * Panel query engine — the dashboard "metric abstraction". Panels describe WHAT to show
 * (source + metric + grouping); this module resolves dashboard variables server-side,
 * enforces organization scoping and returns render-ready PanelResults.
 *
 * Percentiles are never averaged silently: run/transaction series merge histograms
 * (percentileMethod reported), cross-run values are per-run percentiles, and any
 * aggregation of percentiles across runs is labelled as such.
 */

export type PanelType = 'kpi' | 'stat' | 'line' | 'area' | 'bar' | 'stacked_bar' | 'histogram' | 'heatmap' | 'scatter' | 'gauge' | 'donut' | 'table' | 'timeline'
  | 'percentiles' | 'tps' | 'error_distribution' | 'sla_gauge' | 'users' | 'latency_heatmap' | 'endpoint_ranking' | 'transaction_ranking' | 'bottleneck' | 'text';
export const PANEL_TYPES: PanelType[] = ['kpi', 'stat', 'line', 'area', 'bar', 'stacked_bar', 'histogram', 'heatmap', 'scatter', 'gauge', 'donut', 'table', 'timeline',
  'percentiles', 'tps', 'error_distribution', 'sla_gauge', 'users', 'latency_heatmap', 'endpoint_ranking', 'transaction_ranking', 'bottleneck', 'text'];
export const SOURCES = ['run_series', 'runs', 'transactions', 'endpoints', 'infra', 'jvm', 'database', 'sla', 'regressions', 'errors', 'kpi', 'bottleneck', 'latency_heatmap', 'alerts', 'text'] as const;
export type Source = (typeof SOURCES)[number];
export const GROUP_BYS = ['run', 'build', 'release', 'transaction', 'endpoint', 'server', 'environment', 'test', 'day', 'response_code', 'error_type'] as const;

export interface PanelQuery {
  source: Source; metric?: string; metrics?: string[]; aggregation?: 'avg' | 'max' | 'min' | 'sum' | 'last';
  groupBy?: (typeof GROUP_BYS)[number]; limit?: number; sort?: 'asc' | 'desc'; markdown?: string;
}
export type PanelResult =
  | { kind: 'timeseries'; unit?: string; series: { name: string; key?: string; data: [number, number | null][] }[]; percentileMethod?: string; runKey?: string; xAxis?: 'time' | 'elapsed' | 'value' }
  | { kind: 'stat'; unit?: string; value: number | null; label?: string; delta?: number | null; better?: 'lower' | 'higher'; sparkline?: number[]; status?: 'pass' | 'warn' | 'fail' | null }
  | { kind: 'categories'; unit?: string; categories: string[]; series: { name: string; data: (number | null)[] }[] }
  | { kind: 'table'; columns: { key: string; header: string; unit?: string }[]; rows: Record<string, any>[] }
  | { kind: 'heatmap'; times: number[]; buckets: string[]; cells: [number, number, number][] }
  | { kind: 'items'; items: { title: string; subtitle?: string; severity?: string; value?: string; link?: string }[] }
  | { kind: 'text'; markdown: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

export interface QueryBody {
  panels: { id: string; type: PanelType; query: PanelQuery }[];
  vars: Record<string, string | string[] | null | undefined>;
  timeRange: { from: number; to: number } | { runId: string };
}

// ---------------------------------------------------------------- metric catalogue
interface MetricDef { label: string; unit: string; better?: 'lower' | 'higher'; percentile?: boolean; series?: keyof SeriesPoint }
export const METRICS: Record<string, MetricDef> = {
  tps: { label: 'TPS', unit: 'tps', better: 'higher', series: 'tps' },
  p50: { label: 'P50', unit: 'ms', better: 'lower', percentile: true, series: 'p50' },
  p75: { label: 'P75', unit: 'ms', better: 'lower', percentile: true },
  p90: { label: 'P90', unit: 'ms', better: 'lower', percentile: true, series: 'p90' },
  p95: { label: 'P95', unit: 'ms', better: 'lower', percentile: true, series: 'p95' },
  p99: { label: 'P99', unit: 'ms', better: 'lower', percentile: true, series: 'p99' },
  avg_rt: { label: 'Avg RT', unit: 'ms', better: 'lower', series: 'avg' },
  max_rt: { label: 'Max RT', unit: 'ms', better: 'lower', series: 'max' },
  error_pct: { label: 'Error %', unit: '%', better: 'lower', series: 'errorPct' },
  errors: { label: 'Errors', unit: '', better: 'lower', series: 'errors' },
  requests: { label: 'Requests', unit: '', series: 'count' },
  users: { label: 'Users', unit: '', series: 'users' },
  cpu_pct: { label: 'CPU', unit: '%', better: 'lower' },
  memory_pct: { label: 'Memory', unit: '%', better: 'lower' },
  disk_pct: { label: 'Disk', unit: '%', better: 'lower' },
  net_bps: { label: 'Network', unit: 'B/s' },
  heap_pct: { label: 'Heap', unit: '%', better: 'lower' },
  gc_pause_ms: { label: 'GC pause', unit: 'ms', better: 'lower' },
  threads: { label: 'Threads', unit: '' },
  db_latency_ms: { label: 'DB latency', unit: 'ms', better: 'lower' },
  db_connections: { label: 'DB active connections', unit: '' },
  sla_pass_pct: { label: 'SLA compliance', unit: '%', better: 'higher' },
  score: { label: 'Performance score', unit: '', better: 'higher' },
  runs: { label: 'Runs', unit: '' },
  pass_rate: { label: 'Pass rate', unit: '%', better: 'higher' },
};
const def = (m: string): MetricDef => METRICS[m] ?? { label: m, unit: '' };

const INFRA_COLS: Record<'infra' | 'jvm' | 'database', { table: string; cols: Record<string, string>; fallback: string }> = {
  infra: { table: 'server_metrics', fallback: 'cpu_pct', cols: { cpu_pct: 'cpu_pct', memory_pct: 'memory_pct', disk_pct: 'disk_pct', net_bps: '(COALESCE(net_in_bps,0) + COALESCE(net_out_bps,0))', load: 'load_avg_1m', tcp_connections: 'tcp_connections' } },
  jvm: { table: 'jvm_metrics', fallback: 'heap_pct', cols: { heap_pct: '(heap_used_mb / NULLIF(heap_max_mb, 0) * 100)', heap_used_mb: 'heap_used_mb', gc_pause_ms: 'gc_max_pause_ms', gc_time_ms: 'gc_time_ms', threads: 'thread_count', classes_loaded: 'classes_loaded' } },
  database: { table: 'database_metrics', fallback: 'db_latency_ms', cols: { db_latency_ms: 'query_latency_ms', db_connections: 'active_connections', slow_queries: 'slow_queries', locks: 'locks', deadlocks: 'deadlocks', cpu_pct: 'cpu_pct', memory_pct: 'memory_pct', db_tps: 'transactions_per_sec' } },
};

const STAT_TYPES = new Set<PanelType>(['kpi', 'stat', 'gauge', 'sla_gauge']);
const CATEGORY_TYPES = new Set<PanelType>(['bar', 'stacked_bar', 'donut', 'error_distribution', 'endpoint_ranking', 'transaction_ranking', 'histogram']);
const SERIES_TYPES = new Set<PanelType>(['line', 'area', 'percentiles', 'tps', 'users', 'timeline']);
const empty = (message: string): PanelResult => ({ kind: 'empty', message });
const r2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? null : round(v, d));

function aggregate(values: (number | null)[], agg: string = 'avg'): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!xs.length) return null;
  switch (agg) {
    case 'max': return Math.max(...xs);
    case 'min': return Math.min(...xs);
    case 'sum': return xs.reduce((a, b) => a + b, 0);
    case 'last': return xs[xs.length - 1];
    default: return xs.reduce((a, b) => a + b, 0) / xs.length;
  }
}

// ---------------------------------------------------------------- context / variables
interface RunRow { id: string; run_key: string; status: string; started_at: Date | null; ended_at: Date | null; test_id: string; environment_id: string; project_id: string; build_number: string | null; analysis: any; performance_score: number | null }

class Ctx {
  projects: string[] | null = null;
  applications: string[] | null = null;
  environments: string[] | null = null;
  tests: string[] | null = null;
  runs: string[] | null = null;              // explicit run ids
  transactions: string[] | null = null;
  endpoints: string[] | null = null;
  servers: string[] | null = null;
  services: string[] | null = null;
  builds: string[] | null = null;
  from: Date;
  to: Date;
  runMode = false;                           // timeRange = { runId }
  private resolvedRunsP?: Promise<RunRow[]>;
  private crossRunsP?: Promise<any[]>;
  constructor(public principal: Principal) { this.to = new Date(); this.from = new Date(Date.now() - 86400000); }
  get orgId() { return this.principal.orgId; }

  /** Adds run filters (alias r) to a condition builder. */
  runConds(c: Conds, opts: { includeRuns?: boolean } = {}) {
    c.add('r.organization_id = ?', this.orgId).raw('r.deleted_at IS NULL');
    if (this.projects) c.add('r.project_id = ANY(?::uuid[])', this.projects);
    if (this.applications) c.add('r.application_id = ANY(?::uuid[])', this.applications);
    if (this.environments) c.add('r.environment_id = ANY(?::uuid[])', this.environments);
    if (this.tests) c.add('r.test_id = ANY(?::uuid[])', this.tests);
    if (this.builds) c.add('r.build_number = ANY(?::text[])', this.builds);
    if (opts.includeRuns && this.runs) c.add('r.id = ANY(?::uuid[])', this.runs);
    return c;
  }

  /** Runs for run-scoped sources: explicit $run / timeRange.runId, else latest completed run matching filters (in range, then overall). */
  resolvedRuns(): Promise<RunRow[]> {
    if (!this.resolvedRunsP) this.resolvedRunsP = (async () => {
      const cols = 'r.id, r.run_key, r.status, r.started_at, r.ended_at, r.test_id, r.environment_id, r.project_id, r.build_number, r.analysis, r.performance_score';
      if (this.runs) {
        if (!this.runs.length) return [];
        const rows = await query<RunRow>(`SELECT ${cols} FROM test_runs r WHERE r.id = ANY($1::uuid[]) AND r.organization_id = $2 AND r.deleted_at IS NULL`, [this.runs, this.orgId]);
        return this.runs.map((id) => rows.find((x) => x.id === id)).filter(Boolean) as RunRow[];
      }
      const pick = async (ranged: boolean) => {
        const c = this.runConds(new Conds());
        c.raw(`r.status IN ('COMPLETED','RUNNING','ANALYZING')`);
        if (ranged) c.add('COALESCE(r.started_at, r.created_at) <= ?', this.to).add('COALESCE(r.ended_at, now()) >= ?', this.from);
        return query<RunRow>(`SELECT ${cols} FROM test_runs r WHERE ${c.where()} ORDER BY (r.status = 'COMPLETED') DESC, COALESCE(r.started_at, r.created_at) DESC LIMIT 1`, c.params);
      };
      const inRange = await pick(true);
      return inRange.length ? inRange : pick(false);
    })();
    return this.resolvedRunsP;
  }

  /** Completed runs for cross-run sources (time range; in run mode: all runs up to that run). Chronological, max 200. */
  crossRuns(): Promise<any[]> {
    if (!this.crossRunsP) this.crossRunsP = (async () => {
      const c = this.runConds(new Conds());
      c.raw(`r.status = 'COMPLETED'`);
      if (!this.runMode) {
        if (this.runs) c.add('r.id = ANY(?::uuid[])', this.runs);
        else c.add('COALESCE(r.started_at, r.created_at) >= ?', this.from).add('COALESCE(r.started_at, r.created_at) <= ?', this.to);
      } else c.add('COALESCE(r.started_at, r.created_at) <= ?', this.to);
      const rows = await query(
        `SELECT * FROM (
           SELECT r.id, r.run_key, r.result, r.status, COALESCE(r.started_at, r.created_at) started_at, r.build_number, r.performance_score, r.test_id,
                  t.name test_name, e.name environment_name, COALESCE(rel.version, r.version) release_version,
                  s.tps_avg, s.p50, s.p75, s.p90, s.p95, s.p99, s.avg_rt, s.max_rt, s.error_pct, s.failure_count, s.total_samples, s.users_peak, s.sla_pass_pct, s.percentile_method
           FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN environments e ON e.id = r.environment_id LEFT JOIN releases rel ON rel.id = r.release_id
           LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END LIMIT 1) s ON true
           WHERE ${c.where()} ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 200) x ORDER BY started_at`, c.params);
      if (rows.length) {
        const infra = await query(
          `SELECT sm.run_id, avg(sm.cpu_pct) cpu, avg(sm.memory_pct) mem FROM server_metrics sm JOIN servers s ON s.id = sm.server_id
           WHERE sm.run_id = ANY($1::uuid[]) AND coalesce(s.role,'') <> 'loadgen' GROUP BY 1`, [rows.map((x) => x.id)], tsPool);
        const by = new Map(infra.map((x) => [x.run_id, x]));
        for (const x of rows) { x.cpu_pct = by.get(x.id)?.cpu ?? null; x.memory_pct = by.get(x.id)?.mem ?? null; }
      }
      return rows;
    })();
    return this.crossRunsP;
  }
}

const listVar = (vars: QueryBody['vars'], name: string): string[] | null => {
  const v = vars[name] ?? vars['$' + name];
  if (v == null) return null;
  const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter((x) => x && !['all', '$__all', '*'].includes(x.toLowerCase()));
  return arr.length ? arr : null;
};

export async function buildContext(principal: Principal, body: Pick<QueryBody, 'vars' | 'timeRange'>): Promise<Ctx> {
  const ctx = new Ctx(principal);
  const org = principal.orgId;
  const vars = body.vars ?? {};
  const ids = async (sql: string, values: string[] | null) => (values ? (await query(sql, [org, values])).map((x) => x.id as string) : null);

  ctx.projects = await ids(`SELECT id FROM projects WHERE organization_id = $1 AND (id::text = ANY($2) OR key = ANY($2))`, listVar(vars, 'project'));
  if (principal.projectId) ctx.projects = ctx.projects ? ctx.projects.filter((p) => p === principal.projectId) : [principal.projectId];
  ctx.applications = await ids(`SELECT a.id FROM applications a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1 AND (a.id::text = ANY($2) OR a.code = ANY($2) OR a.name = ANY($2))`, listVar(vars, 'application'));
  ctx.environments = await ids(`SELECT e.id FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.organization_id = $1 AND (e.id::text = ANY($2) OR e.name = ANY($2))`, listVar(vars, 'environment'));
  ctx.tests = await ids(`SELECT t.id FROM performance_tests t JOIN projects p ON p.id = t.project_id WHERE p.organization_id = $1 AND (t.id::text = ANY($2) OR t.name = ANY($2))`, listVar(vars, 'test'));
  ctx.servers = await ids(`SELECT s.id FROM servers s JOIN projects p ON p.id = s.project_id WHERE p.organization_id = $1 AND (s.id::text = ANY($2) OR s.name = ANY($2) OR s.hostname = ANY($2))`, listVar(vars, 'server'));
  ctx.services = await ids(`SELECT s.id FROM services s JOIN projects p ON p.id = s.project_id WHERE p.organization_id = $1 AND (s.id::text = ANY($2) OR s.name = ANY($2))`, listVar(vars, 'service'));
  ctx.endpoints = await ids(`SELECT ep.id FROM api_endpoints ep JOIN applications a ON a.id = ep.application_id JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1 AND (ep.id::text = ANY($2) OR (ep.method || ' ' || ep.path_template) = ANY($2))`, listVar(vars, 'endpoint'));
  ctx.transactions = listVar(vars, 'transaction');
  ctx.builds = listVar(vars, 'build');

  const runRefs = 'runId' in (body.timeRange ?? {}) ? [(body.timeRange as { runId: string }).runId] : listVar(vars, 'run');
  if (runRefs) {
    const rows = await query(`SELECT id, run_key, started_at, ended_at, created_at, project_id FROM test_runs WHERE organization_id = $1 AND deleted_at IS NULL AND (id::text = ANY($2) OR run_key = ANY($2))`, [org, runRefs]);
    const allowed = rows.filter((x) => !principal.projectId || x.project_id === principal.projectId);
    // keep the caller's order
    ctx.runs = runRefs.map((ref) => allowed.find((x) => x.id === ref || x.run_key === ref)?.id).filter((x): x is string => !!x);
    ctx.runs = [...new Set(ctx.runs)];
  }
  if ('runId' in (body.timeRange ?? {})) {
    ctx.runMode = true;
    const run = ctx.runs?.length ? await one(`SELECT started_at, ended_at, created_at FROM test_runs WHERE id = $1`, [ctx.runs[0]]) : null;
    ctx.from = run ? new Date(run.started_at ?? run.created_at) : new Date(Date.now() - 86400000);
    ctx.to = run?.ended_at ? new Date(run.ended_at) : new Date();
  } else if (body.timeRange && 'from' in body.timeRange) {
    ctx.from = new Date(body.timeRange.from);
    ctx.to = new Date(body.timeRange.to);
  }
  return ctx;
}

// ---------------------------------------------------------------- run-level metric values
async function runStatValue(run: RunRow, metric: string): Promise<{ value: number | null; method?: string | null }> {
  if (['cpu_pct', 'memory_pct', 'disk_pct', 'net_bps', 'heap_pct', 'gc_pause_ms', 'threads', 'db_latency_ms', 'db_connections'].includes(metric)) {
    const i = await infraAggregates(run.id);
    const map: Record<string, number | null> = { cpu_pct: i.cpuAvg, memory_pct: i.memAvg, disk_pct: i.diskMax, net_bps: i.netAvgBps, heap_pct: i.heapPctMax, gc_pause_ms: i.gcPauseMax, threads: i.threadsMax, db_latency_ms: i.dbLatencyAvg, db_connections: i.dbActiveMax };
    return { value: map[metric] ?? null };
  }
  if (metric === 'score') return { value: run.performance_score };
  const live = run.status === 'RUNNING';
  const s = live ? null : await primarySummary(run.id);
  if (metric === 'sla_pass_pct') return { value: s?.sla_pass_pct ?? null };
  if (s) {
    const map: Record<string, number | null> = { tps: s.tps_avg, p50: s.p50, p75: s.p75, p90: s.p90, p95: s.p95, p99: s.p99, avg_rt: s.avg_rt, max_rt: s.max_rt, error_pct: s.error_pct, errors: s.failure_count, requests: s.total_samples, users: s.users_peak };
    return { value: map[metric] ?? null, method: s.percentile_method };
  }
  const w = await windowStats(run.id);
  if (!w) return { value: null };
  const map: Record<string, number | null> = { tps: w.tpsAvg, p50: w.p50, p75: w.p75, p90: w.p90, p95: w.p95, p99: w.p99, avg_rt: w.avgRt, max_rt: w.maxRt, error_pct: w.errorPct, errors: w.failureCount, requests: w.totalSamples, users: w.usersPeak };
  return { value: map[metric] ?? null, method: w.percentileMethod };
}

async function slaStatusFor(runId: string, metric: string): Promise<'pass' | 'warn' | 'fail' | null> {
  const rows = await query(`SELECT status FROM sla_results WHERE run_id = $1 AND scope = 'RUN' AND metric = $2 AND status <> 'NO_DATA'`, [runId, metric]);
  if (!rows.length) return null;
  if (rows.some((x) => x.status === 'FAIL')) return 'fail';
  if (rows.some((x) => x.status === 'WARNING')) return 'warn';
  return 'pass';
}

const seriesValue = (p: SeriesPoint, metric: string): number | null => {
  const k = def(metric).series;
  const v = k ? (p[k] as number | null) : null;
  return v == null ? null : r2(v, 3);
};

// ---------------------------------------------------------------- sources
async function kpiSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const metric = q.metric ?? q.metrics?.[0] ?? 'p95';
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  const d = def(metric);
  const { value, method } = await runStatValue(run, metric);
  let delta: number | null = null;
  const base = await resolveBaseline(run.id);
  if (base) {
    const b = await one(`SELECT id, run_key, status, started_at, ended_at, test_id, environment_id, project_id, build_number, analysis, performance_score FROM test_runs WHERE id = $1`, [base.id]);
    if (b) delta = r2(pctChange((await runStatValue(b, metric)).value, value), 1);
  }
  let sparkline: number[] | undefined;
  if (d.series) {
    const s = await runSeries(run.id, { maxPoints: 60 });
    sparkline = s.points.map((p) => seriesValue(p, metric)).filter((v): v is number => v != null);
  }
  const slaMetric = metric === 'tps' ? 'tps' : metric;
  const status = await slaStatusFor(run.id, slaMetric);
  const approx = d.percentile && method === 'interval_weighted_approx';
  return { kind: 'stat', unit: d.unit, value: r2(value, 2), label: `${d.label}${approx ? ' ≈ (approx.)' : ''} · ${run.run_key}`, delta, better: d.better, sparkline, status };
}

async function runSeriesSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  if (STAT_TYPES.has(type)) return kpiSource(ctx, type, q);
  const defaults: Partial<Record<PanelType, string[]>> = { percentiles: ['p50', 'p90', 'p95', 'p99'], tps: ['tps'], users: ['users'] };
  const metrics = (q.metrics?.length ? q.metrics : q.metric ? [q.metric] : defaults[type] ?? ['p95']).filter((m) => def(m).series);
  if (!metrics.length) return { kind: 'error', message: `Metric(s) not available as a run time series: ${(q.metrics ?? [q.metric]).join(', ')}` };
  const runs = await ctx.resolvedRuns();
  if (!runs.length) return empty('No run matches the current filters');
  const transaction = ctx.transactions?.length === 1 ? ctx.transactions[0] : null;
  if (runs.length > 1) {
    // Overlay of several runs on elapsed time (first metric only)
    const m = metrics[0];
    const series = [];
    let method = 'exact_histogram';
    for (const run of runs.slice(0, 6)) {
      const s = await runSeries(run.id, { transaction, maxPoints: 300 });
      if (s.percentileMethod !== 'exact_histogram') method = s.percentileMethod;
      const t0 = s.points[0]?.t ?? 0;
      series.push({ name: run.run_key, key: m, data: s.points.map((p) => [p.t - t0, seriesValue(p, m)] as [number, number | null]) });
    }
    return { kind: 'timeseries', unit: def(m).unit, series, xAxis: 'elapsed', ...(def(m).percentile ? { percentileMethod: method } : {}) };
  }
  const run = runs[0];
  const s = await runSeries(run.id, { transaction, maxPoints: 400 });
  if (!s.points.length) return empty(`No metrics recorded for ${run.run_key}${transaction ? ` / ${transaction}` : ''}`);
  return {
    kind: 'timeseries', unit: def(metrics[0]).unit, runKey: run.run_key, xAxis: 'time',
    series: metrics.map((m) => ({ name: transaction ? `${def(m).label} · ${transaction}` : def(m).label, key: m, data: s.points.map((p) => [p.t, seriesValue(p, m)] as [number, number | null]) })),
    ...(metrics.some((m) => def(m).percentile) ? { percentileMethod: s.percentileMethod } : {}),
  };
}

function runMetric(row: any, m: string): number | null {
  const map: Record<string, string> = { tps: 'tps_avg', avg_rt: 'avg_rt', max_rt: 'max_rt', error_pct: 'error_pct', errors: 'failure_count', requests: 'total_samples', users: 'users_peak', sla_pass_pct: 'sla_pass_pct', score: 'performance_score', cpu_pct: 'cpu_pct', memory_pct: 'memory_pct' };
  const v = row[map[m] ?? m];
  return v == null ? null : Number(v);
}
function groupKey(row: any, g: string | undefined): string {
  switch (g) {
    case 'build': return row.build_number ?? '(no build)';
    case 'release': return row.release_version ?? '(no release)';
    case 'test': return row.test_name;
    case 'environment': return row.environment_name;
    case 'day': return new Date(row.started_at).toISOString().slice(0, 10);
    case 'result' as any: return row.result ?? row.status;
    default: return row.run_key;
  }
}

async function runsSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const rows = await ctx.crossRuns();
  const metrics = q.metrics?.length ? q.metrics : [q.metric ?? 'p95'];
  if (type === 'table') {
    const lim = q.limit ?? 50;
    const sorted = [...rows].reverse().slice(0, lim);
    return {
      kind: 'table',
      columns: [{ key: 'runKey', header: 'Run ID' }, { key: 'test', header: 'Test' }, { key: 'build', header: 'Build' }, { key: 'startedAt', header: 'Started' }, { key: 'result', header: 'Result' },
        { key: 'tps', header: 'TPS', unit: 'tps' }, { key: 'p95', header: 'P95', unit: 'ms' }, { key: 'p99', header: 'P99', unit: 'ms' }, { key: 'errorPct', header: 'Errors', unit: '%' },
        { key: 'slaPassPct', header: 'SLA', unit: '%' }, { key: 'score', header: 'Score' }],
      rows: sorted.map((x) => ({ runKey: x.run_key, link: `/runs/${x.run_key}`, test: x.test_name, build: x.build_number, startedAt: x.started_at, result: x.result ?? x.status, tps: r2(x.tps_avg), p95: r2(x.p95), p99: r2(x.p99), errorPct: r2(x.error_pct, 3), slaPassPct: r2(x.sla_pass_pct, 1), score: x.performance_score, percentileMethod: x.percentile_method })),
    };
  }
  if (!rows.length) return empty('No completed runs in the selected range');
  const m0 = metrics[0];
  if (STAT_TYPES.has(type)) {
    if (m0 === 'runs') return { kind: 'stat', value: rows.length, label: 'Completed runs', sparkline: [] };
    if (m0 === 'pass_rate') {
      const judged = rows.filter((x) => ['PASS', 'PASS_WITH_WARNINGS', 'FAIL'].includes(x.result));
      const v = judged.length ? (judged.filter((x) => x.result !== 'FAIL').length / judged.length) * 100 : null;
      return { kind: 'stat', unit: '%', value: r2(v, 1), label: `Pass rate (${judged.length} runs)`, better: 'higher', status: v == null ? null : v >= 90 ? 'pass' : v >= 70 ? 'warn' : 'fail' };
    }
    const values = rows.map((x) => runMetric(x, m0));
    const agg = q.aggregation ?? 'avg';
    const d = def(m0);
    const nonNull = values.filter((v) => v != null) as number[];
    const value = aggregate(values, agg);
    const label = d.percentile && agg !== 'last' && agg !== 'max' && agg !== 'min'
      ? `${d.label} — ${agg === 'sum' ? 'sum' : 'average'} of per-run ${d.label} values (not a merged percentile), ${nonNull.length} runs`
      : `${d.label} (${agg}, ${nonNull.length} runs)`;
    const last = nonNull[nonNull.length - 1];
    const prev = nonNull[nonNull.length - 2];
    return { kind: 'stat', unit: d.unit, value: r2(value), label, delta: agg === 'last' ? r2(pctChange(prev, last), 1) : null, better: d.better, sparkline: nonNull.map((v) => r2(v)!) };
  }
  if (type === 'scatter') {
    const [mx, my] = metrics.length >= 2 ? metrics : ['tps', 'p95'];
    const pts = rows.map((x) => [runMetric(x, mx), runMetric(x, my)] as [number | null, number | null]).filter((p): p is [number, number] => p[0] != null && p[1] != null).sort((a, b) => a[0] - b[0]);
    return { kind: 'timeseries', unit: def(my).unit, xAxis: 'value', series: [{ name: `${def(my).label} vs ${def(mx).label}`, key: `${my}:${mx}`, data: pts.map(([a, b]) => [r2(a)!, r2(b)]) }] };
  }
  if (CATEGORY_TYPES.has(type) || (q.groupBy && q.groupBy !== 'run' && !SERIES_TYPES.has(type))) {
    const g = q.groupBy ?? 'run';
    const groups = new Map<string, any[]>();
    for (const x of rows) { const k = groupKey(x, g); groups.set(k, [...(groups.get(k) ?? []), x]); }
    const cats = [...groups.keys()];
    const agg = q.aggregation ?? 'avg';
    const multiRunGroups = [...groups.values()].some((v) => v.length > 1);
    if (m0 === 'runs') return { kind: 'categories', categories: cats, series: [{ name: 'Runs', data: cats.map((c) => groups.get(c)!.length) }] };
    return {
      kind: 'categories', unit: def(m0).unit, categories: cats,
      series: metrics.map((m) => ({
        name: def(m).percentile && multiRunGroups && agg === 'avg' ? `${def(m).label} (avg of runs)` : def(m).label,
        data: cats.map((c) => r2(aggregate(groups.get(c)!.map((x) => runMetric(x, m)), agg))),
      })),
    };
  }
  return {
    kind: 'timeseries', unit: def(m0).unit, xAxis: 'time',
    series: metrics.map((m) => ({ name: def(m).label, key: m, data: rows.map((x) => [new Date(x.started_at).getTime(), r2(runMetric(x, m))] as [number, number | null]) })),
    ...(metrics.some((m) => def(m).percentile) ? { percentileMethod: 'per_run' } : {}),
  };
}

const TXN_COLS: Record<string, string> = { tps: 'tps', p50: 'median', p90: 'p90', p95: 'p95', p99: 'p99', avg_rt: 'avg', max_rt: 'max', error_pct: 'errorPct', errors: 'errors', requests: 'samples' };

async function loadRunTransactions(run: RunRow) {
  if (run.status !== 'RUNNING') {
    const stored = await primaryTransactions(run.id);
    if (stored.length) return stored.map((t) => ({ name: t.name, samples: Number(t.samples), errors: Number(t.errors), errorPct: t.error_pct, tps: t.tps, avg: t.avg_rt, median: t.median_rt, p90: t.p90, p95: t.p95, p99: t.p99, max: t.max_rt, slaStatus: t.sla_status, percentileMethod: t.percentile_method }));
  }
  const live = await transactionStats(run.id);
  return live.map((t) => ({ name: t.name, samples: t.totalSamples, errors: t.failureCount, errorPct: t.errorPct, tps: t.tpsAvg, avg: t.avgRt, median: t.p50, p90: t.p90, p95: t.p95, p99: t.p99, max: t.maxRt, slaStatus: null, percentileMethod: t.percentileMethod }));
}

async function transactionsSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const metric = q.metric ?? q.metrics?.[0] ?? 'p95';
  const col = TXN_COLS[metric];
  if (!col) return { kind: 'error', message: `Metric '${metric}' is not available per transaction` };
  const crossRun = ['run', 'build', 'release', 'day'].includes(q.groupBy ?? '') && type !== 'table' && !STAT_TYPES.has(type) && !(ctx.runs?.length === 1);
  if (crossRun) {
    const runs = await ctx.crossRuns();
    if (!runs.length) return empty('No completed runs in the selected range');
    const txns = await query(
      `SELECT DISTINCT ON (x.run_id, x.name) x.run_id, x.name, x.samples, x.tps, x.avg_rt avg, x.median_rt median, x.p90, x.p95, x.p99, x.max_rt max, x.error_pct "errorPct", x.errors
       FROM transactions x WHERE x.run_id = ANY($1::uuid[]) ${ctx.transactions ? 'AND x.name = ANY($2::text[])' : ''}
       ORDER BY x.run_id, x.name, CASE x.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END`,
      ctx.transactions ? [runs.map((x) => x.id), ctx.transactions] : [runs.map((x) => x.id)]);
    const volume = new Map<string, number>();
    for (const t of txns) volume.set(t.name, (volume.get(t.name) ?? 0) + Number(t.samples));
    const top = [...volume.entries()].sort((a, b) => b[1] - a[1]).slice(0, q.limit ?? 8).map(([n]) => n);
    if (CATEGORY_TYPES.has(type)) {
      const cats = runs.map((x) => groupKey(x, q.groupBy));
      return { kind: 'categories', unit: def(metric).unit, categories: cats, series: top.map((name) => ({ name, data: runs.map((rr) => r2(txns.find((t) => t.run_id === rr.id && t.name === name)?.[col] ?? null)) })) };
    }
    return {
      kind: 'timeseries', unit: def(metric).unit, xAxis: 'time', ...(def(metric).percentile ? { percentileMethod: 'per_run' } : {}),
      series: top.map((name) => ({ name, key: metric, data: runs.map((rr) => [new Date(rr.started_at).getTime(), r2(txns.find((t) => t.run_id === rr.id && t.name === name)?.[col] ?? null)] as [number, number | null]) })),
    };
  }
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  let rows = await loadRunTransactions(run);
  if (ctx.transactions) rows = rows.filter((t) => ctx.transactions!.includes(t.name));
  if (!rows.length) return empty(`No transactions recorded for ${run.run_key}`);
  if (type === 'table') {
    const lim = q.limit ?? 200;
    const sorted = q.sort ? [...rows].sort((a: any, b: any) => (q.sort === 'asc' ? 1 : -1) * ((a[col] ?? -Infinity) - (b[col] ?? -Infinity))) : rows;
    return {
      kind: 'table',
      columns: [{ key: 'name', header: 'Transaction' }, { key: 'samples', header: 'Samples' }, { key: 'errors', header: 'Errors' }, { key: 'errorPct', header: 'Error %', unit: '%' }, { key: 'tps', header: 'TPS', unit: 'tps' },
        { key: 'avg', header: 'Avg', unit: 'ms' }, { key: 'median', header: 'Median', unit: 'ms' }, { key: 'p90', header: 'P90', unit: 'ms' }, { key: 'p95', header: 'P95', unit: 'ms' }, { key: 'p99', header: 'P99', unit: 'ms' },
        { key: 'max', header: 'Max', unit: 'ms' }, { key: 'slaStatus', header: 'SLA' }],
      rows: sorted.slice(0, lim).map((t: any) => ({ ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === 'number' ? r2(v, 3) : v])), link: `/runs/${run.run_key}/transactions?name=${encodeURIComponent(t.name)}` })),
    };
  }
  if (STAT_TYPES.has(type)) {
    if (rows.length !== 1) return empty('Select a single transaction ($transaction) for a stat panel');
    return { kind: 'stat', unit: def(metric).unit, value: r2((rows[0] as any)[col]), label: `${def(metric).label} · ${rows[0].name}`, better: def(metric).better };
  }
  if (SERIES_TYPES.has(type)) {
    const top = [...rows].sort((a, b) => b.samples - a.samples).slice(0, q.limit ?? 8);
    let method = 'exact_histogram';
    const series = [];
    for (const t of top) {
      const s = await runSeries(run.id, { transaction: t.name, maxPoints: 300 });
      if (s.percentileMethod !== 'exact_histogram') method = s.percentileMethod;
      series.push({ name: t.name, key: metric, data: s.points.map((p) => [p.t, seriesValue(p, metric)] as [number, number | null]) });
    }
    return { kind: 'timeseries', unit: def(metric).unit, runKey: run.run_key, xAxis: 'time', series, ...(def(metric).percentile ? { percentileMethod: method } : {}) };
  }
  const desc = (q.sort ?? 'desc') === 'desc';
  const ranked = [...rows].filter((t: any) => t[col] != null).sort((a: any, b: any) => (desc ? b[col] - a[col] : a[col] - b[col])).slice(0, q.limit ?? 10);
  return { kind: 'categories', unit: def(metric).unit, categories: ranked.map((t) => t.name), series: [{ name: def(metric).label, data: ranked.map((t: any) => r2(t[col])) }] };
}

async function endpointsSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const metric = q.metric ?? q.metrics?.[0] ?? 'p95';
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  const params: unknown[] = [run.id];
  let cond = '';
  if (ctx.endpoints) { params.push(ctx.endpoints); cond = `AND m.endpoint_id = ANY($2::uuid[])`; }
  if (SERIES_TYPES.has(type)) {
    const src = (await runSource(run.id)) ?? 'live';
    const win = await runWindow(run.id, src);
    const step = win.from && win.to ? chooseStep(win.from.getTime(), win.to.getTime(), 200, win.minInterval) : 10;
    params.push(step);
    const rows = await query(
      `SELECT m.endpoint_id, e.method || ' ' || e.path_template AS name, floor(extract(epoch from m.ts)/$${params.length})*$${params.length}*1000 AS t,
              sum(m.sample_count)::int n, sum(m.error_count)::int err, sum(m.sum_rt) s, max(m.interval_sec) iv, array_agg(m.histogram) hs, min(m.min_rt) mn, max(m.max_rt) mx
       FROM api_metrics m JOIN api_endpoints e ON e.id = m.endpoint_id WHERE m.run_id = $1 ${cond} GROUP BY 1, 2, 3 ORDER BY 3`, params, tsPool);
    if (!rows.length) return empty(`No endpoint metrics for ${run.run_key}`);
    const vol = new Map<string, number>();
    for (const x of rows) vol.set(x.name, (vol.get(x.name) ?? 0) + x.n);
    const top = [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, q.limit ?? 8).map(([n]) => n);
    let exact = true;
    const val = (x: any): number | null => {
      if (metric === 'tps') return x.n / Math.max(step, x.iv);
      if (metric === 'avg_rt') return x.n ? x.s / x.n : null;
      if (metric === 'error_pct') return x.n ? (x.err / x.n) * 100 : null;
      if (metric === 'errors') return x.err;
      if (metric === 'requests') return x.n;
      if (def(metric).percentile) {
        if (x.hs.some((h: any) => !h)) { exact = false; return null; }
        const h = new Histogram();
        for (const s of x.hs) h.mergeSparse(s);
        return h.percentile(Number(metric.slice(1)), x.mn, x.mx);
      }
      if (metric === 'max_rt') return x.mx;
      return null;
    };
    const series = top.map((name) => ({ name, key: metric, data: rows.filter((x) => x.name === name).map((x) => [Number(x.t), r2(val(x))] as [number, number | null]) }));
    return { kind: 'timeseries', unit: def(metric).unit, runKey: run.run_key, xAxis: 'time', series, ...(def(metric).percentile ? { percentileMethod: exact ? 'exact_histogram' : 'unavailable_without_raw_samples' } : {}) };
  }
  const rows = await query(
    `SELECT e.id, e.method, e.path_template, m.histogram, m.status_codes, m.sample_count, m.error_count, m.sum_rt, m.min_rt, m.max_rt
     FROM api_metrics m JOIN api_endpoints e ON e.id = m.endpoint_id WHERE m.run_id = $1 ${cond}`, params, tsPool);
  if (!rows.length) return empty(`No endpoint metrics for ${run.run_key}`);
  const stats = await windowStats(run.id);
  const by = new Map<string, any[]>();
  for (const x of rows) by.set(x.id, [...(by.get(x.id) ?? []), x]);
  const eps = [...by.values()].map((rs) => {
    const n = rs.reduce((a, x) => a + x.sample_count, 0);
    const err = rs.reduce((a, x) => a + x.error_count, 0);
    const exact = rs.every((x) => x.histogram);
    const h = new Histogram();
    if (exact) for (const x of rs) h.mergeSparse(x.histogram);
    const mins = rs.map((x) => x.min_rt).filter((v) => v != null);
    const maxs = rs.map((x) => x.max_rt).filter((v) => v != null);
    const mn = mins.length ? Math.min(...mins) : null;
    const mx = maxs.length ? Math.max(...maxs) : null;
    return {
      id: rs[0].id, endpoint: `${rs[0].method} ${rs[0].path_template}`, requests: n, errors: err, errorPct: n ? (err / n) * 100 : 0, tps: stats ? n / stats.durationSec : null,
      avg: n ? rs.reduce((a, x) => a + x.sum_rt, 0) / n : null, p50: exact ? h.percentile(50, mn, mx) : null, p90: exact ? h.percentile(90, mn, mx) : null,
      p95: exact ? h.percentile(95, mn, mx) : null, p99: exact ? h.percentile(99, mn, mx) : null, max: mx, percentileMethod: exact ? 'exact_histogram' : 'unavailable',
    };
  });
  const key: Record<string, string> = { tps: 'tps', p50: 'p50', p90: 'p90', p95: 'p95', p99: 'p99', avg_rt: 'avg', max_rt: 'max', error_pct: 'errorPct', errors: 'errors', requests: 'requests' };
  const k = key[metric] ?? 'p95';
  if (type === 'table') {
    return {
      kind: 'table',
      columns: [{ key: 'endpoint', header: 'Endpoint' }, { key: 'requests', header: 'Requests' }, { key: 'errorPct', header: 'Error %', unit: '%' }, { key: 'tps', header: 'TPS', unit: 'tps' },
        { key: 'avg', header: 'Avg', unit: 'ms' }, { key: 'p95', header: 'P95', unit: 'ms' }, { key: 'p99', header: 'P99', unit: 'ms' }, { key: 'max', header: 'Max', unit: 'ms' }],
      rows: eps.sort((a, b) => b.requests - a.requests).slice(0, q.limit ?? 200).map((e) => ({ ...e, errorPct: r2(e.errorPct, 3), tps: r2(e.tps), avg: r2(e.avg), p50: r2(e.p50), p90: r2(e.p90), p95: r2(e.p95), p99: r2(e.p99), max: r2(e.max), link: `/runs/${run.run_key}/endpoints?id=${e.id}` })),
    };
  }
  if (STAT_TYPES.has(type)) {
    if (eps.length !== 1) return empty('Select a single endpoint ($endpoint) for a stat panel');
    return { kind: 'stat', unit: def(metric).unit, value: r2((eps[0] as any)[k]), label: `${def(metric).label} · ${eps[0].endpoint}`, better: def(metric).better };
  }
  const desc = (q.sort ?? 'desc') === 'desc';
  const ranked = eps.filter((e: any) => e[k] != null).sort((a: any, b: any) => (desc ? b[k] - a[k] : a[k] - b[k])).slice(0, q.limit ?? 10);
  if (!ranked.length) return empty(`${def(metric).label} per endpoint requires raw samples (JTL / JSON samples)`);
  return { kind: 'categories', unit: def(metric).unit, categories: ranked.map((e) => e.endpoint), series: [{ name: def(metric).label, data: ranked.map((e: any) => r2(e[k])) }] };
}

async function infraSource(ctx: Ctx, source: 'infra' | 'jvm' | 'database', type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const spec = INFRA_COLS[source];
  const metric = q.metric ?? q.metrics?.[0] ?? spec.fallback;
  const expr = spec.cols[metric];
  if (!expr) return { kind: 'error', message: `Metric '${metric}' is not available for source '${source}' (use: ${Object.keys(spec.cols).join(', ')})` };
  const agg = q.aggregation ?? 'avg';
  const sqlAgg = agg === 'max' ? 'max' : agg === 'min' ? 'min' : agg === 'sum' ? 'sum' : 'avg';
  // Entity scope: servers/services in the caller's organization matching the variables
  const sc = new Conds([ctx.orgId]);
  sc.raw('p.organization_id = $1');
  if (ctx.projects) sc.add('x.project_id = ANY(?::uuid[])', ctx.projects);
  if (ctx.environments) sc.add('x.environment_id = ANY(?::uuid[])', ctx.environments);
  if (ctx.applications) sc.add('(x.application_id IS NULL OR x.application_id = ANY(?::uuid[]))', ctx.applications);
  const servers = (await query(`SELECT x.id FROM servers x JOIN projects p ON p.id = x.project_id WHERE ${sc.where()} ${ctx.servers ? `AND x.id = ANY($${sc.params.length + 1}::uuid[])` : ''}`, ctx.servers ? [...sc.params, ctx.servers] : sc.params)).map((x) => x.id);
  const services = source === 'infra' ? [] : (await query(`SELECT x.id FROM services x JOIN projects p ON p.id = x.project_id WHERE ${sc.where()} ${ctx.services ? `AND x.id = ANY($${sc.params.length + 1}::uuid[])` : ''}`, ctx.services ? [...sc.params, ctx.services] : sc.params)).map((x) => x.id);

  const c = new Conds();
  if (source === 'infra') c.add('m.server_id = ANY(?::uuid[])', servers);
  else c.list.push(`(m.server_id = ANY(${c.param(servers)}::uuid[]) OR m.service_id = ANY(${c.param(services)}::uuid[]))`);
  let runKey: string | undefined;
  const explicit = ctx.runs != null || ctx.runMode;
  if (explicit) {
    const [run] = await ctx.resolvedRuns();
    if (!run) return empty('No run matches the current filters');
    runKey = run.run_key;
    c.add('m.run_id = ?', run.id);
  } else c.add('m.ts >= ?', ctx.from).add('m.ts < ?', ctx.to);
  const nameExpr = source === 'infra' ? 's.name' : `COALESCE(sv.name, s.name, 'unknown')`;
  const joins = `LEFT JOIN servers s ON s.id = m.server_id ${source === 'infra' ? '' : 'LEFT JOIN services sv ON sv.id = m.service_id'}`;
  const range = await one(`SELECT min(m.ts) a, max(m.ts) b, count(*)::int n FROM ${spec.table} m WHERE ${c.where()}`, c.params, tsPool);
  if (!range?.n) return empty(`No ${source === 'infra' ? 'infrastructure' : source === 'jvm' ? 'JVM' : 'database'} metrics for the selected ${explicit ? 'run' : 'time range'}`);
  const d = def(metric);
  if (STAT_TYPES.has(type) || type === 'table' || CATEGORY_TYPES.has(type)) {
    const rows = await query(
      `SELECT ${nameExpr} AS name, avg(${expr}) avg, max(${expr}) max, min(${expr}) min, sum(${expr}) sum,
              (array_agg(${expr} ORDER BY m.ts DESC) FILTER (WHERE ${expr} IS NOT NULL))[1] AS last
       FROM ${spec.table} m ${joins} WHERE ${c.where()} GROUP BY 1 ORDER BY 1`, c.params, tsPool);
    if (type === 'table') {
      return { kind: 'table', columns: [{ key: 'name', header: source === 'infra' ? 'Server' : 'Target' }, { key: 'avg', header: `${d.label} avg`, unit: d.unit }, { key: 'max', header: `${d.label} max`, unit: d.unit }, { key: 'last', header: 'Last', unit: d.unit }],
        rows: rows.map((x) => ({ name: x.name, avg: r2(n(x.avg)), max: r2(n(x.max)), last: r2(n(x.last)) })) };
    }
    if (CATEGORY_TYPES.has(type)) return { kind: 'categories', unit: d.unit, categories: rows.map((x) => x.name), series: [{ name: `${d.label} (${agg})`, data: rows.map((x) => r2(n(x[agg === 'last' ? 'last' : sqlAgg]))) }] };
    const overall = await one(`SELECT ${sqlAgg}(${expr}) v FROM ${spec.table} m WHERE ${c.where()}`, c.params, tsPool);
    const step = chooseStep(new Date(range.a).getTime(), new Date(range.b).getTime() + 1000, 60);
    const spark = await query(`SELECT floor(extract(epoch from m.ts)/${c.param(step)})*${step} t, avg(${expr}) v FROM ${spec.table} m WHERE ${c.where()} GROUP BY 1 ORDER BY 1`, c.params, tsPool);
    const value = agg === 'last' ? n(rows.map((x) => x.last).find((v) => v != null)) : n(overall?.v);
    const status = d.unit === '%' && value != null ? (value >= 90 ? 'fail' : value >= 75 ? 'warn' : 'pass') : null;
    return { kind: 'stat', unit: d.unit, value: r2(value), label: `${d.label} (${agg}${runKey ? ` · ${runKey}` : ''})`, better: d.better, sparkline: spark.map((x) => r2(n(x.v))).filter((v): v is number => v != null), status };
  }
  const step = chooseStep(new Date(range.a).getTime(), new Date(range.b).getTime() + 1000, 300);
  const perEntity = (q.groupBy ?? 'server') === 'server' || q.groupBy === 'environment';
  const rows = await query(
    `SELECT floor(extract(epoch from m.ts)/${c.param(step)})*${step}*1000 AS t, ${perEntity ? nameExpr : `'all'`} AS name, ${sqlAgg === 'sum' ? 'avg' : sqlAgg}(${expr}) v
     FROM ${spec.table} m ${joins} WHERE ${c.where()} GROUP BY 1, 2 ORDER BY 1`, c.params, tsPool);
  const names = [...new Set(rows.map((x) => x.name as string))];
  return {
    kind: 'timeseries', unit: d.unit, xAxis: 'time', ...(runKey ? { runKey } : {}),
    series: names.map((name) => ({ name: perEntity ? `${d.label} · ${name}` : d.label, key: metric, data: rows.filter((x) => x.name === name).map((x) => [Number(x.t), r2(n(x.v))] as [number, number | null]) })),
  };
}
const n = (v: unknown) => (v == null ? null : Number(v));

async function slaSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  if (SERIES_TYPES.has(type)) {
    const runs = await ctx.crossRuns();
    const pts = runs.filter((x) => x.sla_pass_pct != null);
    if (!pts.length) return empty('No SLA evaluations in the selected range');
    return { kind: 'timeseries', unit: '%', xAxis: 'time', series: [{ name: 'SLA compliance', key: 'sla_pass_pct', data: pts.map((x) => [new Date(x.started_at).getTime(), r2(x.sla_pass_pct, 1)] as [number, number | null]) }] };
  }
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  const rows = await query(`SELECT s.*, r.name rule_name FROM sla_results s LEFT JOIN sla_rules r ON r.id = s.rule_id WHERE s.run_id = $1
                            ORDER BY CASE s.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'PASS' THEN 2 ELSE 3 END, s.scope, s.metric`, [run.id]);
  if (!rows.length) return empty(`No SLA profile was evaluated for ${run.run_key}`);
  const evaluated = rows.filter((x) => x.status !== 'NO_DATA');
  if (type === 'table') {
    return {
      kind: 'table',
      columns: [{ key: 'scope', header: 'Scope' }, { key: 'transaction', header: 'Transaction' }, { key: 'metric', header: 'Metric' }, { key: 'actual', header: 'Actual' }, { key: 'warning', header: 'Warning' }, { key: 'critical', header: 'Critical' }, { key: 'status', header: 'Status' }],
      rows: rows.slice(0, q.limit ?? 500).map((x) => ({ scope: x.scope, transaction: x.transaction, metric: x.metric, actual: r2(x.actual_value), warning: x.warning_value, critical: x.critical_value, unit: x.unit, status: x.status })),
    };
  }
  if (CATEGORY_TYPES.has(type)) {
    if (q.groupBy === 'transaction') {
      const fails = new Map<string, number>();
      for (const x of rows.filter((y) => y.status === 'FAIL')) fails.set(x.transaction ?? 'Run', (fails.get(x.transaction ?? 'Run') ?? 0) + 1);
      return { kind: 'categories', categories: [...fails.keys()], series: [{ name: 'Violations', data: [...fails.values()] }] };
    }
    const statuses = ['PASS', 'WARNING', 'FAIL', 'NO_DATA'];
    return { kind: 'categories', categories: statuses, series: [{ name: 'Assertions', data: statuses.map((s) => rows.filter((x) => x.status === s).length) }] };
  }
  const passed = evaluated.filter((x) => x.status !== 'FAIL').length;
  const value = evaluated.length ? (passed / evaluated.length) * 100 : null;
  const status = evaluated.some((x) => x.status === 'FAIL') ? 'fail' : evaluated.some((x) => x.status === 'WARNING') ? 'warn' : evaluated.length ? 'pass' : null;
  return { kind: 'stat', unit: '%', value: r2(value, 1), label: `SLA compliance · ${run.run_key} (${passed}/${evaluated.length} assertions)`, better: 'higher', status };
}

async function regressionsSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const c = ctx.runConds(new Conds());
  if (ctx.runs && !ctx.runMode) c.add('r.id = ANY(?::uuid[])', ctx.runs);
  else if (ctx.runMode && ctx.runs?.length) c.add('r.id = ?', ctx.runs[0]);
  else c.add('COALESCE(r.started_at, r.created_at) >= ?', ctx.from).add('COALESCE(r.started_at, r.created_at) <= ?', ctx.to);
  if (ctx.transactions) c.add('(g.transaction IS NULL OR g.transaction = ANY(?::text[]))', ctx.transactions);
  const rows = await query(
    `SELECT g.*, r.run_key, b.run_key baseline_key, t.name test_name FROM regressions g JOIN test_runs r ON r.id = g.run_id JOIN performance_tests t ON t.id = r.test_id
     LEFT JOIN test_runs b ON b.id = g.baseline_run_id WHERE ${c.where()}
     ORDER BY (g.direction = 'REGRESSION') DESC, CASE g.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, COALESCE(r.started_at, r.created_at) DESC, g.change_pct DESC NULLS LAST LIMIT 500`, c.params);
  const regs = rows.filter((x) => x.direction === 'REGRESSION');
  if (STAT_TYPES.has(type)) return { kind: 'stat', value: regs.length, label: 'Regressions', better: 'lower', status: regs.some((x) => x.severity === 'CRITICAL') ? 'fail' : regs.length ? 'warn' : 'pass' };
  if (!rows.length) return empty('No regressions or improvements detected in the selected scope');
  const fmtV = (v: number | null, m: string) => (v == null ? 'n/a' : `${r2(v, m.includes('pct') ? 2 : 0)}${m === 'error_pct' || m.includes('cpu') || m.includes('mem') ? '%' : m === 'tps' ? ' TPS' : ' ms'}`);
  if (type === 'table') {
    return {
      kind: 'table',
      columns: [{ key: 'runKey', header: 'Run ID' }, { key: 'baselineRunKey', header: 'Baseline' }, { key: 'scope', header: 'Scope' }, { key: 'transaction', header: 'Transaction' }, { key: 'metric', header: 'Metric' },
        { key: 'previous', header: 'Baseline value' }, { key: 'current', header: 'Current value' }, { key: 'changePct', header: 'Change', unit: '%' }, { key: 'direction', header: 'Direction' }, { key: 'severity', header: 'Severity' }],
      rows: rows.slice(0, q.limit ?? 100).map((x) => ({ runKey: x.run_key, link: `/runs/${x.run_key}`, baselineRunKey: x.baseline_key, scope: x.scope, transaction: x.transaction, metric: x.metric, previous: r2(x.previous_value), current: r2(x.current_value), changePct: r2(x.change_pct, 1), direction: x.direction, severity: x.severity })),
    };
  }
  if (CATEGORY_TYPES.has(type)) {
    const key = (x: any) => (q.groupBy === 'transaction' ? x.transaction ?? 'Run' : q.groupBy === 'run' ? x.run_key : x.metric);
    const counts = new Map<string, number>();
    for (const x of regs) counts.set(key(x), (counts.get(key(x)) ?? 0) + 1);
    return { kind: 'categories', categories: [...counts.keys()], series: [{ name: 'Regressions', data: [...counts.values()] }] };
  }
  return {
    kind: 'items',
    items: rows.slice(0, q.limit ?? 20).map((x) => ({
      title: `${x.transaction ?? (x.scope === 'INFRA' ? 'Infrastructure' : 'Run')} ${x.metric.toUpperCase()} ${x.change_pct != null ? `${x.change_pct > 0 ? '+' : ''}${r2(x.change_pct, 1)}%` : ''}`.trim(),
      subtitle: `${x.run_key}${x.baseline_key ? ` vs ${x.baseline_key}` : ''} · ${x.test_name} · ${x.direction}`,
      severity: x.severity, value: `${fmtV(x.previous_value, x.metric)} → ${fmtV(x.current_value, x.metric)}`, link: `/runs/${x.run_key}/insights`,
    })),
  };
}

async function errorsSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  const txnCond = ctx.transactions ? 'AND transaction = ANY($2::text[])' : '';
  const base = ctx.transactions ? [run.id, ctx.transactions] : [run.id];
  if (SERIES_TYPES.has(type)) {
    const win = await runWindow(run.id, (await runSource(run.id)) ?? 'live');
    const step = win.from && win.to ? chooseStep(win.from.getTime(), win.to.getTime(), 200, 5) : 10;
    const rows = await query(`SELECT floor(extract(epoch from ts)/${Number(step)})*${Number(step)}*1000 AS t, error_type, sum(count)::int n FROM error_metrics WHERE run_id = $1 ${txnCond} GROUP BY 1, 2 ORDER BY 1`, base);
    if (!rows.length) return empty(`No errors recorded for ${run.run_key}`);
    const types = [...new Set(rows.map((x) => x.error_type as string))];
    return { kind: 'timeseries', unit: '', runKey: run.run_key, xAxis: 'time', series: types.map((t) => ({ name: t, key: 'errors', data: rows.filter((x) => x.error_type === t).map((x) => [Number(x.t), x.n] as [number, number | null]) })) };
  }
  const g = q.groupBy && ['response_code', 'error_type', 'transaction', 'endpoint'].includes(q.groupBy) ? q.groupBy : 'response_code';
  const col = g === 'endpoint' ? `COALESCE(endpoint, '(unknown)')` : g === 'response_code' ? `COALESCE(response_code, '(none)')` : g;
  const rows = await query(`SELECT ${col} AS key, sum(count)::int AS n, (array_agg(message ORDER BY count DESC))[1] AS sample FROM error_metrics WHERE run_id = $1 ${txnCond} GROUP BY 1 ORDER BY 2 DESC LIMIT ${Math.min(q.limit ?? 20, 200)}`, base);
  const total = rows.reduce((a, x) => a + x.n, 0);
  if (STAT_TYPES.has(type)) return { kind: 'stat', value: total, label: `Errors · ${run.run_key}`, better: 'lower' };
  if (!rows.length) return empty(`No errors recorded for ${run.run_key}`);
  if (type === 'table') {
    return { kind: 'table', columns: [{ key: 'key', header: g.replace('_', ' ') }, { key: 'count', header: 'Count' }, { key: 'pct', header: '% of errors', unit: '%' }, { key: 'sample', header: 'Sample message' }],
      rows: rows.map((x) => ({ key: x.key, count: x.n, pct: r2((x.n / total) * 100, 1), sample: x.sample })) };
  }
  return { kind: 'categories', categories: rows.map((x) => String(x.key)), series: [{ name: 'Errors', data: rows.map((x) => x.n) }] };
}

async function bottleneckSource(ctx: Ctx, type: PanelType): Promise<PanelResult> {
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  const a = run.analysis;
  if (!a) return empty(`${run.run_key} has not been analysed yet`);
  const cands: any[] = a.bottlenecks ?? [];
  if (type === 'table') {
    return { kind: 'table', columns: [{ key: 'component', header: 'Component' }, { key: 'category', header: 'Category' }, { key: 'confidence', header: 'Confidence', unit: '%' }, { key: 'label', header: 'Assessment' }, { key: 'evidence', header: 'Evidence' }],
      rows: cands.map((c) => ({ component: c.component, category: c.category, confidence: r2(c.confidence * 100, 0), label: c.label, evidence: (c.evidence ?? []).join(' · ') })) };
  }
  const items = cands.map((c) => ({
    title: c.component, subtitle: `${c.label}${c.evidence?.length ? ' — ' + c.evidence[0] : ''}`,
    severity: c.confidence >= 0.8 ? 'CRITICAL' : c.confidence >= 0.65 ? 'WARNING' : 'INFO', value: `${Math.round(c.confidence * 100)}%`, link: `/runs/${run.run_key}/insights`,
  }));
  if (a.saturation?.detected) items.unshift({ title: 'Throughput saturation', subtitle: (a.saturation.evidence ?? []).join(' · '), severity: 'WARNING', value: `${a.saturation.atTps} TPS`, link: `/runs/${run.run_key}/insights` });
  for (const g of a.gaps ?? []) items.push({ title: 'Evidence gap', subtitle: g, severity: 'INFO', value: '', link: `/runs/${run.run_key}/insights` });
  if (!items.length) return empty(`No bottleneck candidates for ${run.run_key}`);
  return { kind: 'items', items };
}

async function heatmapSource(ctx: Ctx): Promise<PanelResult> {
  const [run] = await ctx.resolvedRuns();
  if (!run) return empty('No run matches the current filters');
  const source = (await runSource(run.id)) ?? 'live';
  const win = await runWindow(run.id, source);
  if (!win.from || !win.to) return empty(`No metrics recorded for ${run.run_key}`);
  const step = chooseStep(win.from.getTime(), win.to.getTime(), 120, win.minInterval);
  const txn = ctx.transactions?.length === 1 ? ctx.transactions[0] : null;
  const rows = txn
    ? await query(`SELECT floor(extract(epoch from ts)/$3)*$3*1000 AS t, array_agg(histogram) hs FROM transaction_metrics WHERE run_id = $1 AND source = $2 AND transaction = $4 GROUP BY 1 ORDER BY 1`, [run.id, source, step, txn], tsPool)
    : await query(`SELECT floor(extract(epoch from ts)/$3)*$3*1000 AS t, array_agg(histogram) hs FROM run_metrics WHERE run_id = $1 AND source = $2 GROUP BY 1 ORDER BY 1`, [run.id, source, step], tsPool);
  if (!rows.length || rows.some((x) => x.hs.some((h: any) => !h))) return empty('Latency heatmap requires raw samples (JTL upload or JSON samples); this run only has interval-aggregated percentiles');
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
    counts.forEach((cnt, yi) => { if (cnt) cells.push([xi, yi, cnt]); });
  });
  return { kind: 'heatmap', times: rows.map((x) => Number(x.t)), buckets: edges.slice(0, -1).map((e, i) => `${e}-${Number.isFinite(edges[i + 1]) ? edges[i + 1] : '∞'} ms`), cells };
}

async function alertsSource(ctx: Ctx, type: PanelType, q: PanelQuery): Promise<PanelResult> {
  const c = new Conds([ctx.orgId]);
  c.raw('p.organization_id = $1');
  if (ctx.projects) c.add('al.project_id = ANY(?::uuid[])', ctx.projects);
  if (ctx.runs?.length) c.add('al.run_id = ANY(?::uuid[])', ctx.runs);
  else c.add(`(al.status <> 'RESOLVED' OR al.fired_at >= ?)`, ctx.from);
  if (ctx.environments) c.add('(r.environment_id IS NULL OR r.environment_id = ANY(?::uuid[]))', ctx.environments);
  const rows = await query(
    `SELECT al.*, r.run_key, s.name server_name FROM alerts al JOIN projects p ON p.id = al.project_id LEFT JOIN test_runs r ON r.id = al.run_id LEFT JOIN servers s ON s.id = al.server_id
     WHERE ${c.where()} ORDER BY (al.status = 'FIRING') DESC, al.fired_at DESC LIMIT 200`, c.params);
  const firing = rows.filter((x) => x.status === 'FIRING');
  if (STAT_TYPES.has(type)) return { kind: 'stat', value: firing.length, label: 'Active alerts', better: 'lower', status: firing.some((x) => x.severity === 'CRITICAL') ? 'fail' : firing.length ? 'warn' : 'pass' };
  if (!rows.length) return empty('No alerts in the selected range');
  if (type === 'table') {
    return { kind: 'table', columns: [{ key: 'title', header: 'Alert' }, { key: 'severity', header: 'Severity' }, { key: 'status', header: 'Status' }, { key: 'runKey', header: 'Run ID' }, { key: 'firedAt', header: 'Fired' }],
      rows: rows.slice(0, q.limit ?? 50).map((x) => ({ id: x.id, title: x.title, severity: x.severity, status: x.status, runKey: x.run_key, server: x.server_name, firedAt: x.fired_at, value: x.value, threshold: x.threshold })) };
  }
  if (CATEGORY_TYPES.has(type)) {
    const sev = ['CRITICAL', 'WARNING', 'INFO'];
    return { kind: 'categories', categories: sev, series: [{ name: 'Alerts', data: sev.map((s) => rows.filter((x) => x.severity === s).length) }] };
  }
  return { kind: 'items', items: rows.slice(0, q.limit ?? 20).map((x) => ({ title: x.title, subtitle: [x.status, x.run_key, x.server_name, new Date(x.fired_at).toISOString()].filter(Boolean).join(' · '), severity: x.severity, value: x.value != null ? String(r2(x.value)) : undefined, link: `/alerts?id=${x.id}` })) };
}

// ---------------------------------------------------------------- dispatcher
export async function runPanel(ctx: Ctx, panel: { type: PanelType; query: PanelQuery }): Promise<PanelResult> {
  const q = panel.query ?? ({ source: 'text' } as PanelQuery);
  const type = panel.type;
  if (type === 'text' || q.source === 'text') return { kind: 'text', markdown: q.markdown ?? '' };
  switch (q.source) {
    case 'run_series': return runSeriesSource(ctx, type, q);
    case 'kpi': return kpiSource(ctx, type, q);
    case 'runs': return runsSource(ctx, type, q);
    case 'transactions': return transactionsSource(ctx, type, q);
    case 'endpoints': return endpointsSource(ctx, type, q);
    case 'infra': case 'jvm': case 'database': return infraSource(ctx, q.source, type, q);
    case 'sla': return slaSource(ctx, type, q);
    case 'regressions': return regressionsSource(ctx, type, q);
    case 'errors': return errorsSource(ctx, type, q);
    case 'bottleneck': return bottleneckSource(ctx, type);
    case 'latency_heatmap': return heatmapSource(ctx);
    case 'alerts': return alertsSource(ctx, type, q);
    default: return { kind: 'error', message: `Unknown source '${(q as any).source}'` };
  }
}

export async function runPanelQueries(principal: Principal, body: QueryBody, log?: { error: (o: object, m: string) => void }) {
  const ctx = await buildContext(principal, body);
  const results: Record<string, PanelResult> = {};
  const panels = body.panels ?? [];
  // Bounded concurrency: keeps the DB pool available for other requests.
  for (let i = 0; i < panels.length; i += 4) {
    await Promise.all(panels.slice(i, i + 4).map(async (p) => {
      try {
        results[p.id] = await runPanel(ctx, p);
      } catch (e) {
        log?.error({ err: e, panel: p.id }, 'panel query failed');
        results[p.id] = { kind: 'error', message: (e as Error).message?.slice(0, 300) || 'Query failed' };
      }
    }));
  }
  return { results };
}
