import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePermission, principalOf } from '../auth/principal.js';
import { badRequest } from '../lib/errors.js';
import { typed, z, toCsv } from '../lib/http.js';
import { METRIC_BY_KEY, METRIC_KEYS } from './catalog.js';
import { inventory, markers, metricSeries, type Scope, type SeriesOut } from './query.js';
import { InputError, chooseStep, parseAgg, parseFilters, parseMetricKeys, resolveWindow, FILTER_KEYS } from './pure.js';
import { collectionRoutes } from './collection.js';

const tags = ['Observability'];
const filterShape = Object.fromEntries(FILTER_KEYS.map((k) => [k, z.string().max(10000).optional()])) as Record<(typeof FILTER_KEYS)[number], z.ZodOptional<z.ZodString>>;
const windowShape = { from: z.string().max(64).optional(), to: z.string().max(64).optional() };
const seriesQuery = z.object({
  ...windowShape, ...filterShape,
  metric: z.string().max(2000).optional(),
  step: z.string().max(12).optional(),
  agg: z.string().max(8).optional(),
  groupBy: z.enum(['entity', 'none']).default('entity'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Converts pure-layer InputError into the standard 400 envelope. */
export function input<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof InputError) throw badRequest(e.message); throw e; }
}

export const scopeOf = (req: FastifyRequest): Scope => { const p = principalOf(req); return { orgId: p.orgId, keyProjectId: p.projectId ?? null }; };

/** Runs several metric queries (bounded concurrency) — shared by the routes and the OBSERVABILITY report. */
export async function querySeries(scope: Scope, q: { metrics: string[]; from: Date; to: Date; stepSec: number; agg: ReturnType<typeof parseAgg>; groupBy: 'entity' | 'none'; limit: number; points: boolean; filters: ReturnType<typeof parseFilters> }) {
  const out: SeriesOut[] = [];
  let truncated = false;
  const results = new Array<{ series: SeriesOut[]; total: number }>(q.metrics.length);
  let i = 0;
  const worker = async () => {
    while (i < q.metrics.length) {
      const k = i++;
      results[k] = await metricSeries(METRIC_BY_KEY.get(q.metrics[k])!, scope, q.filters, { from: q.from, to: q.to }, { stepSec: q.stepSec, agg: q.agg, groupBy: q.groupBy, limit: q.limit, points: q.points });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  for (const r of results) { out.push(...r.series); if (r.total > r.series.length) truncated = true; }
  return { series: out, truncated };
}

export async function observabilityRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };

  r.get('/observability/inventory', {
    ...view,
    schema: { tags, summary: 'Entities and metric catalogue for the Observability filters (window default: last hour)', querystring: z.object({ ...windowShape, ...filterShape }) },
  }, async (req) => {
    const { from, to } = input(() => resolveWindow(req.query.from, req.query.to));
    const filters = input(() => parseFilters(req.query));
    return inventory(scopeOf(req), filters, { from, to });
  });

  const parse = (q: z.infer<typeof seriesQuery>) => input(() => {
    const { from, to } = resolveWindow(q.from, q.to);
    const metrics = parseMetricKeys(q.metric, METRIC_KEYS);
    const stepSec = chooseStep(from.getTime(), to.getTime(), q.step);
    return { from, to, metrics, stepSec, agg: parseAgg(q.agg), filters: parseFilters(q), groupBy: q.groupBy, limit: q.limit };
  });

  r.get('/observability/series', {
    ...view,
    schema: {
      tags, summary: 'Time series per entity for one or more metric keys, aligned buckets + raw-sample stats + markers',
      description: 'Buckets start at floor(epoch/step)*step (UTC); `points` are [bucketStartMs, value|null]; `stats` come from raw samples in [from, to). Window ≤ 90 days.',
      querystring: seriesQuery,
    },
  }, async (req) => {
    const q = parse(req.query);
    const scope = scopeOf(req);
    const [{ series, truncated }, mk] = await Promise.all([
      querySeries(scope, { ...q, points: true }),
      markers(scope, q.filters, { from: q.from, to: q.to }),
    ]);
    return { from: q.from.toISOString(), to: q.to.toISOString(), stepSec: q.stepSec, agg: q.agg, series, truncated, markers: mk };
  });

  r.get('/observability/table', {
    ...view,
    schema: { tags, summary: 'One row per entity × metric with raw-sample stats (format=csv for text/csv)', querystring: seriesQuery },
  }, async (req, reply) => {
    const q = parse(req.query);
    const { series, truncated } = await querySeries(scopeOf(req), { ...q, points: false });
    const rows = series.map((s) => ({ metric: s.metric, unit: s.unit, entity: s.entity, entityId: s.entityId, label: s.label, ...(s.host ? { hostId: s.hostId, host: s.host } : {}), stats: s.stats }));
    if (req.query.format === 'csv') {
      const flat = rows.map((x) => ({ metric: x.metric, unit: x.unit, entity: x.entity, entity_id: x.entityId, label: x.label, host: (x as any).host ?? '',
        samples: x.stats.samples, min: x.stats.min, avg: x.stats.avg, max: x.stats.max, p95: x.stats.p95, last: x.stats.last, max_ts_utc: x.stats.maxTs, last_ts_utc: x.stats.lastTs }));
      const cols = ['metric', 'unit', 'entity', 'entity_id', 'label', 'host', 'samples', 'min', 'avg', 'max', 'p95', 'last', 'max_ts_utc', 'last_ts_utc'];
      const name = `observability-${q.from.toISOString().slice(0, 16).replace(/[:T]/g, '')}-${q.to.toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(toCsv(flat, cols) + '\n');
    }
    return { from: q.from.toISOString(), to: q.to.toISOString(), rows, truncated };
  });

  await collectionRoutes(app);
}
