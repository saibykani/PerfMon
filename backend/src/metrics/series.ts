import { query, tsPool } from '../db/pool.js';
import { Histogram } from '../lib/histogram.js';

const minOf = (xs: number[]) => { let m = Infinity; for (const x of xs) if (x < m) m = x; return xs.length ? m : null; };
const maxOf = (xs: number[]) => { let m = -Infinity; for (const x of xs) if (x > m) m = x; return xs.length ? m : null; };

export type PercentileMethod = 'exact_histogram' | 'source_reported' | 'interval_weighted_approx';

/** Choose a bucket size (seconds) so a window renders with <= maxPoints points. */
export function chooseStep(fromMs: number, toMs: number, maxPoints = 600, minStep = 1) {
  const span = Math.max(1, (toMs - fromMs) / 1000);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];
  for (const s of steps) if (s >= minStep && span / s <= maxPoints) return s;
  return 86400;
}

export interface SeriesPoint {
  t: number;              // bucket start (epoch ms)
  count: number;
  errors: number;
  tps: number;
  errorPct: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  users: number | null;
  sentBps: number;
  receivedBps: number;
}

export interface SeriesResult {
  step: number;
  percentileMethod: PercentileMethod;
  points: SeriesPoint[];
}

interface Window { from?: Date | null; to?: Date | null; step?: number | null; source?: string }

/** Resolve which metric source a run has (live preferred over jtl, html_report). */
export async function runSource(runId: string, preferred?: string): Promise<string | null> {
  const rows = await query(`SELECT DISTINCT source FROM run_metrics WHERE run_id = $1`, [runId], tsPool);
  const have = rows.map((r) => r.source as string);
  if (preferred && have.includes(preferred)) return preferred;
  for (const s of ['live', 'jtl', 'import']) if (have.includes(s)) return s;
  return have[0] ?? null;
}

export async function runWindow(runId: string, source: string) {
  const r = await query(`SELECT min(ts) AS a, max(ts + make_interval(secs => interval_sec)) AS b, min(interval_sec) AS min_int, max(interval_sec) AS max_int FROM run_metrics WHERE run_id = $1 AND source = $2`, [runId, source], tsPool);
  return { from: r[0]?.a as Date | null, to: r[0]?.b as Date | null, minInterval: Number(r[0]?.min_int ?? 1), maxInterval: Number(r[0]?.max_int ?? 1) };
}

function pctFromRows(rows: { cnt: number; hist: number[] | null; p: number | null }[], q: number, min: number | null, max: number | null): { v: number | null; method: PercentileMethod } {
  if (!rows.length) return { v: null, method: 'exact_histogram' };
  if (rows.every((r) => r.hist)) {
    const h = new Histogram();
    for (const r of rows) h.mergeSparse(r.hist);
    return { v: h.percentile(q, min, max), method: 'exact_histogram' };
  }
  const withP = rows.filter((r) => r.p != null && r.cnt > 0);
  if (!withP.length) return { v: null, method: 'source_reported' };
  if (withP.length === 1) return { v: withP[0].p, method: 'source_reported' };
  const w = withP.reduce((a, r) => a + r.cnt, 0);
  return { v: withP.reduce((a, r) => a + r.p! * r.cnt, 0) / w, method: 'interval_weighted_approx' };
}

/**
 * Time series for a run (whole run, or one transaction) bucketed to `step`.
 * Percentiles are merged from histograms where available (exact to ~2.5%),
 * otherwise returned as reported (single interval) or flagged as approximate.
 */
export async function runSeries(runId: string, opts: Window & { transaction?: string | null; maxPoints?: number }): Promise<SeriesResult> {
  const source = opts.source ?? (await runSource(runId)) ?? 'live';
  const win = await runWindow(runId, source);
  const from = opts.from ?? win.from;
  const to = opts.to ?? win.to;
  if (!from || !to) return { step: 1, percentileMethod: 'exact_histogram', points: [] };
  const step = opts.step ?? chooseStep(from.getTime(), to.getTime(), opts.maxPoints ?? 600, win.minInterval);
  const table = opts.transaction ? 'transaction_metrics' : 'run_metrics';
  const params: unknown[] = [runId, source, from, to, step];
  let txnFilter = '';
  if (opts.transaction) { params.push(opts.transaction); txnFilter = `AND transaction = $6`; }
  const rows = await query(
    `SELECT floor(extract(epoch from ts) / $5) * $5 AS bucket, ts, interval_sec, sample_count, error_count, sum_rt, min_rt, max_rt,
            p50, p90, p95, p99, ${opts.transaction ? 'NULL::int' : 'active_threads'} AS active_threads, bytes_sent, bytes_received, histogram
     FROM ${table} WHERE run_id = $1 AND source = $2 AND ts >= $3 AND ts < $4 ${txnFilter} ORDER BY ts`, params, tsPool);

  const buckets = new Map<number, any[]>();
  for (const r of rows) {
    const b = Number(r.bucket) * 1000;
    let arr = buckets.get(b);
    if (!arr) buckets.set(b, (arr = []));
    arr.push(r);
  }
  let method: PercentileMethod = 'exact_histogram';
  const points: SeriesPoint[] = [];
  for (const [t, rs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const count = rs.reduce((a, r) => a + r.sample_count, 0);
    const errors = rs.reduce((a, r) => a + r.error_count, 0);
    const sum = rs.reduce((a, r) => a + r.sum_rt, 0);
    const mins = rs.map((r) => r.min_rt).filter((v) => v != null);
    const maxs = rs.map((r) => r.max_rt).filter((v) => v != null);
    const min = mins.length ? Math.min(...mins) : null;
    const max = maxs.length ? Math.max(...maxs) : null;
    const span = Math.max(step, Math.max(...rs.map((r) => r.interval_sec)));
    const pr = (k: string, q: number) => {
      const res = pctFromRows(rs.map((r) => ({ cnt: r.sample_count, hist: r.histogram, p: r[k] })), q, min, max);
      if (res.method === 'interval_weighted_approx' || (res.method === 'source_reported' && method === 'exact_histogram')) method = res.method;
      return res.v;
    };
    const users = rs.map((r) => r.active_threads).filter((v) => v != null);
    points.push({
      t, count, errors,
      tps: count / span,
      errorPct: count ? (errors / count) * 100 : null,
      avg: count ? sum / count : null,
      min, max,
      p50: pr('p50', 50), p90: pr('p90', 90), p95: pr('p95', 95), p99: pr('p99', 99),
      users: users.length ? Math.max(...users) : null,
      sentBps: rs.reduce((a, r) => a + Number(r.bytes_sent), 0) / span,
      receivedBps: rs.reduce((a, r) => a + Number(r.bytes_received), 0) / span,
    });
  }
  return { step, percentileMethod: method, points };
}

/** Aggregate statistics over a window (whole run or zoomed range). */
export async function windowStats(runId: string, opts: Window & { transaction?: string | null } = {}) {
  const source = opts.source ?? (await runSource(runId)) ?? 'live';
  const table = opts.transaction ? 'transaction_metrics' : 'run_metrics';
  const params: unknown[] = [runId, source];
  const conds: string[] = [];
  if (opts.from) { params.push(opts.from); conds.push(`ts >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); conds.push(`ts < $${params.length}`); }
  if (opts.transaction) { params.push(opts.transaction); conds.push(`transaction = $${params.length}`); }
  const rows = await query(
    `SELECT ts, interval_sec, sample_count, error_count, sum_rt, sum_sq_rt, min_rt, max_rt, p50, p75, p90, p95, p99, p999,
            ${opts.transaction ? 'NULL::int' : 'active_threads'} AS active_threads, bytes_sent, bytes_received, histogram
     FROM ${table} WHERE run_id = $1 AND source = $2 ${conds.length ? 'AND ' + conds.join(' AND ') : ''} ORDER BY ts`, params, tsPool);
  return computeStats(rows, source);
}

export function computeStats(rows: any[], source: string) {
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.sample_count, 0);
  const errors = rows.reduce((a, r) => a + r.error_count, 0);
  const sum = rows.reduce((a, r) => a + r.sum_rt, 0);
  const mins = rows.map((r) => r.min_rt).filter((v) => v != null);
  const maxs = rows.map((r) => r.max_rt).filter((v) => v != null);
  const min = minOf(mins);
  const max = maxOf(maxs);
  const first = new Date(rows[0].ts).getTime();
  const lastRow = rows[rows.length - 1];
  const last = new Date(lastRow.ts).getTime() + lastRow.interval_sec * 1000;
  const durationSec = Math.max(1, (last - first) / 1000);
  const allHist = rows.every((r) => r.histogram || r.sample_count === 0);
  let method: PercentileMethod;
  const pct: Record<string, number | null> = {};
  if (allHist) {
    const h = new Histogram();
    for (const r of rows) h.mergeSparse(r.histogram);
    for (const [k, q] of [['p50', 50], ['p75', 75], ['p90', 90], ['p95', 95], ['p99', 99], ['p999', 99.9]] as const) pct[k] = h.percentile(q, min, max);
    method = 'exact_histogram';
  } else {
    for (const k of ['p50', 'p75', 'p90', 'p95', 'p99', 'p999']) {
      const withP = rows.filter((r) => r[k] != null && r.sample_count > 0);
      const w = withP.reduce((a, r) => a + r.sample_count, 0);
      pct[k] = w ? withP.reduce((a, r) => a + r[k] * r.sample_count, 0) / w : null;
    }
    method = rows.length === 1 ? 'source_reported' : 'interval_weighted_approx';
  }
  const sumSqOk = rows.every((r) => r.sum_sq_rt != null);
  const avg = total ? sum / total : null;
  const stddev = sumSqOk && total > 1 && avg != null ? Math.sqrt(Math.max(0, rows.reduce((a, r) => a + r.sum_sq_rt, 0) / total - avg * avg)) : null;
  // Peak TPS on >=5s windows to avoid single-second noise
  const peakWin = Math.max(5, maxOf(rows.map((r) => r.interval_sec)) ?? 1);
  const win = new Map<number, number>();
  for (const r of rows) {
    const k = Math.floor(new Date(r.ts).getTime() / (peakWin * 1000));
    win.set(k, (win.get(k) ?? 0) + r.sample_count);
  }
  const tpsPeak = win.size ? maxOf([...win.values()])! / peakWin : null;
  const users = rows.map((r) => r.active_threads).filter((v) => v != null) as number[];
  const bytesSent = rows.reduce((a, r) => a + Number(r.bytes_sent), 0);
  const bytesRecv = rows.reduce((a, r) => a + Number(r.bytes_received), 0);
  return {
    source,
    totalSamples: total,
    successCount: total - errors,
    failureCount: errors,
    errorPct: total ? (errors / total) * 100 : 0,
    tpsAvg: total / durationSec,
    tpsPeak,
    avgRt: avg,
    minRt: min,
    maxRt: max,
    medianRt: pct.p50,
    p50: pct.p50, p75: pct.p75, p90: pct.p90, p95: pct.p95, p99: pct.p99, p999: pct.p999,
    stddevRt: stddev,
    usersAvg: users.length ? users.reduce((a, b) => a + b, 0) / users.length : null,
    usersPeak: maxOf(users),
    bytesSent, bytesReceived: bytesRecv,
    sentKbSec: bytesSent / 1024 / durationSec,
    receivedKbSec: bytesRecv / 1024 / durationSec,
    durationSec,
    startTs: first,
    endTs: last,
    percentileMethod: method,
  };
}

export type WindowStats = NonNullable<ReturnType<typeof computeStats>>;

/** Per-transaction statistics for a run window. */
export async function transactionStats(runId: string, opts: Window = {}) {
  const source = opts.source ?? (await runSource(runId)) ?? 'live';
  const params: unknown[] = [runId, source];
  const conds: string[] = [];
  if (opts.from) { params.push(opts.from); conds.push(`ts >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); conds.push(`ts < $${params.length}`); }
  const rows = await query(
    `SELECT transaction, ts, interval_sec, sample_count, error_count, sum_rt, sum_sq_rt, min_rt, max_rt, p50, p75, p90, p95, p99, p999, NULL::int AS active_threads, bytes_sent, bytes_received, histogram
     FROM transaction_metrics WHERE run_id = $1 AND source = $2 ${conds.length ? 'AND ' + conds.join(' AND ') : ''} ORDER BY transaction, ts`, params, tsPool);
  // use whole-run duration for TPS so per-transaction TPS sums to the run TPS
  const runStats = await windowStats(runId, { ...opts, source });
  const by = new Map<string, any[]>();
  for (const r of rows) {
    let a = by.get(r.transaction);
    if (!a) by.set(r.transaction, (a = []));
    a.push(r);
  }
  return [...by.entries()].map(([name, rs]) => {
    const s = computeStats(rs, source)!;
    const dur = runStats?.durationSec ?? s.durationSec;
    return { name, ...s, tpsAvg: s.totalSamples / dur, sentKbSec: s.bytesSent / 1024 / dur, receivedKbSec: s.bytesReceived / 1024 / dur };
  });
}

/** Generic infra series helper: avg/max per bucket for numeric columns of a table. */
export async function infraSeries(table: 'server_metrics' | 'jvm_metrics' | 'database_metrics' | 'service_metrics', columns: string[], where: { runId?: string | null; serverId?: string | null; serviceId?: string | null; from?: Date | null; to?: Date | null; step?: number | null; groupBy?: 'server_id' | 'service_id' | null }) {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (where.runId) { params.push(where.runId); conds.push(`run_id = $${params.length}`); }
  if (where.serverId) { params.push(where.serverId); conds.push(`server_id = $${params.length}`); }
  if (where.serviceId) { params.push(where.serviceId); conds.push(`service_id = $${params.length}`); }
  if (where.from) { params.push(where.from); conds.push(`ts >= $${params.length}`); }
  if (where.to) { params.push(where.to); conds.push(`ts < $${params.length}`); }
  if (!conds.length) return { step: 0, points: [] as any[] };
  const range = await query(`SELECT min(ts) a, max(ts) b FROM ${table} WHERE ${conds.join(' AND ')}`, params, tsPool);
  if (!range[0]?.a) return { step: 0, points: [] as any[] };
  const step = where.step ?? chooseStep(new Date(range[0].a).getTime(), new Date(range[0].b).getTime() + 1000, 500, 1);
  params.push(step);
  const g = where.groupBy ? `, ${where.groupBy}` : '';
  const cols = columns.map((c) => `avg(${c}) AS ${c}, max(${c}) AS ${c}_max`).join(', ');
  const rows = await query(
    `SELECT floor(extract(epoch from ts) / $${params.length}) * $${params.length} * 1000 AS t${g}, ${cols}
     FROM ${table} WHERE ${conds.join(' AND ')} GROUP BY 1${g} ORDER BY 1`, params, tsPool);
  return { step, points: rows.map((r) => ({ ...r, t: Number(r.t) })) };
}
