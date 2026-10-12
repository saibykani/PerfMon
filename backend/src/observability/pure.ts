/**
 * Pure helpers for the Observability hub (no I/O) — unit-tested in pure.test.ts.
 * Contract: docs/architecture/observability-api.md
 */

export const MAX_WINDOW_MS = 90 * 86_400_000;
export const STEP_CANDIDATES = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 21600, 86400] as const;
export const AUTO_MAX_POINTS = 600;
export const EXPLICIT_MAX_POINTS = 2000;
export const MIN_STEP = 10;
export const DEFAULT_WINDOW_MS = 3_600_000;

export class InputError extends Error {}

/* ------------------------------------------------------------------ time */

const TZ_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/i;

/** ISO-8601 instant WITH timezone (Z or ±hh:mm), or epoch milliseconds. Naive local times are rejected (ambiguous). */
export function parseInstant(v: string | number | null | undefined, name: string): Date | undefined {
  if (v == null || v === '') return undefined;
  const s = String(v).trim();
  let d: Date;
  if (/^\d{10,14}$/.test(s)) d = new Date(Number(s));
  else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw new InputError(`\`${name}\` must be an ISO-8601 instant (e.g. 2026-10-12T09:15:00Z) or epoch milliseconds`);
    if (!TZ_RE.test(s)) throw new InputError(`\`${name}\` must include a timezone (Z or ±hh:mm): '${s}'`);
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) throw new InputError(`Invalid timestamp \`${name}\`: '${s}'`);
  return d;
}

/** Effective window [from, to): defaults to the last hour; from < to; ≤ 90 days. */
export function resolveWindow(fromRaw?: string | number | null, toRaw?: string | number | null, now = Date.now()) {
  const to = parseInstant(toRaw, 'to') ?? new Date(now);
  const from = parseInstant(fromRaw, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from.getTime() >= to.getTime()) throw new InputError('`from` must be before `to`');
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw new InputError('The time window is limited to 90 days');
  return { from, to };
}

/* ------------------------------------------------------------------ buckets */

/** Bucket start (epoch ms) of a timestamp: floor(epoch / step) * step. */
export function bucketStart(ms: number, stepSec: number) {
  const step = stepSec * 1000;
  return Math.floor(ms / step) * step;
}

/** Number of aligned buckets touching [from, to). */
export function bucketCount(fromMs: number, toMs: number, stepSec: number) {
  if (toMs <= fromMs) return 0;
  return (bucketStart(toMs - 1, stepSec) - bucketStart(fromMs, stepSec)) / (stepSec * 1000) + 1;
}

/**
 * Step selection: `auto` → smallest candidate keeping ≤ 600 buckets. Explicit step (s, ≥ 10) is kept unless it
 * would exceed 2 000 buckets; then it is raised to the smallest candidate that fits.
 */
export function chooseStep(fromMs: number, toMs: number, requested?: string | number | null): number {
  const auto = requested == null || requested === '' || String(requested).toLowerCase() === 'auto';
  if (auto) return STEP_CANDIDATES.find((s) => bucketCount(fromMs, toMs, s) <= AUTO_MAX_POINTS) ?? STEP_CANDIDATES[STEP_CANDIDATES.length - 1];
  const step = Number(requested);
  if (!Number.isInteger(step) || step < MIN_STEP) throw new InputError(`\`step\` must be "auto" or an integer number of seconds ≥ ${MIN_STEP}`);
  if (bucketCount(fromMs, toMs, step) <= EXPLICIT_MAX_POINTS) return step;
  return STEP_CANDIDATES.find((s) => s >= step && bucketCount(fromMs, toMs, s) <= EXPLICIT_MAX_POINTS) ?? STEP_CANDIDATES[STEP_CANDIDATES.length - 1];
}

/** Full bucket grid for the window; buckets without data are null (never interpolated). `pts` = [bucketStartSec | ms, value]. */
export function fillGrid(fromMs: number, toMs: number, stepSec: number, pts: [number, number | null][], inSeconds = true): [number, number | null][] {
  const step = stepSec * 1000;
  const byStart = new Map<number, number | null>();
  for (const [b, v] of pts) byStart.set(inSeconds ? b * 1000 : b, v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const out: [number, number | null][] = [];
  const last = bucketStart(toMs - 1, stepSec);
  for (let t = bucketStart(fromMs, stepSec); t <= last; t += step) out.push([t, byStart.has(t) ? byStart.get(t)! : null]);
  return out;
}

/* ------------------------------------------------------------------ stats (reference semantics of the SQL) */

/** PostgreSQL percentile_cont semantics (linear interpolation between closest ranks). */
export function percentileCont(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface RawStats { min: number | null; avg: number | null; max: number | null; p95: number | null; last: number | null; samples: number; maxTs: number | null; lastTs: number | null }

/** Stats over RAW samples [ts ms, value] (not bucket averages). Non-finite values are ignored. Ties on max → earliest ts. */
export function rawStats(samples: [number, number | null][]): RawStats {
  const xs = samples.filter((s): s is [number, number] => s[1] != null && Number.isFinite(s[1]));
  if (!xs.length) return { min: null, avg: null, max: null, p95: null, last: null, samples: 0, maxTs: null, lastTs: null };
  let min = Infinity; let max = -Infinity; let sum = 0; let maxTs = 0; let lastTs = -Infinity; let last = 0;
  for (const [t, v] of xs) {
    if (v < min) min = v;
    if (v > max || (v === max && t < maxTs)) { max = v; maxTs = t; }
    sum += v;
    if (t >= lastTs) { lastTs = t; last = v; }
  }
  const sorted = xs.map((x) => x[1]).sort((a, b) => a - b);
  return { min, avg: sum / xs.length, max, p95: percentileCont(sorted, 0.95), last, samples: xs.length, maxTs, lastTs };
}

/** Bucket aggregation reference (same semantics as the SQL aggregates). */
export function aggregate(values: [number, number][], agg: Agg): number | null {
  if (!values.length) return null;
  const vs = values.map((v) => v[1]);
  switch (agg) {
    case 'avg': return vs.reduce((a, b) => a + b, 0) / vs.length;
    case 'min': return Math.min(...vs);
    case 'max': return Math.max(...vs);
    case 'sum': return vs.reduce((a, b) => a + b, 0);
    case 'p95': return percentileCont([...vs].sort((a, b) => a - b), 0.95);
    case 'last': return [...values].sort((a, b) => a[0] - b[0])[values.length - 1][1];
  }
}

/** Reference bucketing: raw samples → aligned buckets → aggregate. */
export function bucketize(samples: [number, number][], stepSec: number, agg: Agg): [number, number | null][] {
  const m = new Map<number, [number, number][]>();
  for (const s of samples) {
    const b = bucketStart(s[0], stepSec);
    const arr = m.get(b) ?? [];
    arr.push(s);
    m.set(b, arr);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([b, vs]) => [b, aggregate(vs, agg)]);
}

/* ------------------------------------------------------------------ aggregation & filters */

export const AGGS = ['avg', 'min', 'max', 'sum', 'p95', 'last'] as const;
export type Agg = (typeof AGGS)[number];

/** SQL aggregate per bucket — whitelisted constant strings over column `v` (ordered by `ts`). */
export const AGG_SQL: Record<Agg, string> = {
  avg: 'avg(v)', min: 'min(v)', max: 'max(v)', sum: 'sum(v)',
  p95: 'percentile_cont(0.95) WITHIN GROUP (ORDER BY v)',
  last: '(array_agg(v ORDER BY ts DESC))[1]',
};

export function parseAgg(v: unknown): Agg {
  const s = v == null || v === '' ? 'avg' : String(v).toLowerCase();
  if (!(AGGS as readonly string[]).includes(s)) throw new InputError(`\`agg\` must be one of ${AGGS.join(', ')}`);
  return s as Agg;
}

export const UUID_FILTERS = ['projectId', 'environmentId', 'applicationId', 'runId', 'hostId', 'serviceId', 'databaseId', 'cluster'] as const;
export const TEXT_FILTERS = ['namespace', 'workload', 'pod', 'node', 'role'] as const;
export const FILTER_KEYS = [...UUID_FILTERS, ...TEXT_FILTERS] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string[]>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUES = 100;

/** Filters from a query object or a report params object: comma-separated strings or arrays; OR within, AND across. */
export function parseFilters(q: Record<string, unknown>): Filters {
  const out: Filters = {};
  for (const k of FILTER_KEYS) {
    const raw = q[k];
    if (raw == null || raw === '') continue;
    const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
    const vals = [...new Set(parts)];
    if (!vals.length) continue;
    if (vals.length > MAX_VALUES) throw new InputError(`Filter \`${k}\` accepts at most ${MAX_VALUES} values`);
    for (const v of vals) {
      if ((UUID_FILTERS as readonly string[]).includes(k) && !UUID_RE.test(v)) throw new InputError(`Filter \`${k}\` must be a UUID (or comma-separated UUIDs): '${v}'`);
      if (v.length > 253) throw new InputError(`Filter \`${k}\` value is too long`);
    }
    out[k] = UUID_FILTERS.includes(k as any) || k === 'role' ? [...new Set(vals.map((v) => v.toLowerCase()))] : vals;
  }
  return out;
}

export function parseMetricKeys(v: unknown, known: Set<string>): string[] {
  const keys = [...new Set((Array.isArray(v) ? v : [v]).flatMap((x) => (x == null ? [] : String(x).split(','))).map((s) => s.trim()).filter(Boolean))];
  if (!keys.length) throw new InputError('`metric` is required (one or more metric keys, comma-separated)');
  if (keys.length > 30) throw new InputError('At most 30 metrics per request');
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) throw new InputError(`Unknown metric key(s): ${unknown.join(', ')} — see GET /observability/inventory → metrics`);
  return keys;
}
