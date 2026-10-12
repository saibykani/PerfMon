import { query, tsPool } from '../db/pool.js';
import { Conds } from '../lib/scope.js';
import { METRIC_BY_KEY, METRICS, SOURCES, publicMetric, type EntityKind, type MetricDef } from './catalog.js';
import { AGG_SQL, fillGrid, type Agg, type Filters } from './pure.js';

/**
 * Observability query engine. All SQL is built from the whitelisted fragments in catalog.ts; user input only
 * travels as bind parameters. Buckets: floor(epoch / step) * step (UTC); aggregation per bucket in SQL;
 * stats from RAW samples in [from, to); empty buckets are null (never interpolated).
 */

export interface Scope { orgId: string; keyProjectId?: string | null }
export interface Window { from: Date; to: Date }

export interface SeriesStats { min: number | null; avg: number | null; max: number | null; p95: number | null; last: number | null; samples: number; maxTs: string | null; lastTs: string | null }
export interface SeriesOut {
  metric: string; unit: string; entityId: string; entity: EntityKind; label: string; hostId?: string | null; host?: string | null;
  points?: [number, number | null][]; stats: SeriesStats;
}

const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const isoOrNull = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** WHERE conditions for org scope, API-key project binding, window and filters of one metric source. */
export function scopeConds(def: MetricDef, scope: Scope, f: Filters, w: Window, c = new Conds()) {
  const src = SOURCES[def.source];
  c.add(`${src.org} = ?`, scope.orgId);
  if (scope.keyProjectId) c.add(`${src.project} = ?`, scope.keyProjectId);
  if (src.where) c.raw(src.where);
  if (def.pointMetric) c.add('m.metric = ?', def.pointMetric);
  c.add('m.ts >= ?', w.from);
  c.add('m.ts < ?', w.to);
  for (const [k, vals] of Object.entries(f) as [keyof Filters, string[]][]) {
    const col = src.filters[k];
    if (!col || !vals?.length) continue;           // filter does not apply to this entity type
    if (k === 'projectId' && src.projectNullable) c.add(`(${col} = ANY(?) OR ${col} IS NULL)`, vals);
    else c.add(`${col} = ANY(?)`, vals);
  }
  return c;
}

function rawCte(def: MetricDef, scope: Scope, f: Filters, w: Window, groupBy: 'entity' | 'none') {
  const src = SOURCES[def.source];
  const c = scopeConds(def, scope, f, w);
  const eid = groupBy === 'none' ? `'*'::text` : src.eid;
  const label = groupBy === 'none' ? `'*'::text` : src.label;
  const host = groupBy === 'none' || !src.hostId ? 'NULL::text' : src.hostId;
  const hostLabel = groupBy === 'none' || !src.hostLabel ? 'NULL::text' : src.hostLabel;
  const sql = `raw AS MATERIALIZED (
      SELECT ${eid} AS eid, ${label} AS label, ${host} AS host_id, ${hostLabel} AS host, m.ts AS ts, (${def.expr})::float8 AS v
      FROM ${src.from}
      WHERE ${c.where()} AND (${def.expr}) IS NOT NULL AND (${def.expr})::float8 <> 'NaN'::float8
    )`;
  return { sql, c };
}

/**
 * One metric → up to `limit` series (highest average first) with bucketed points and raw-sample stats.
 * Returns `total` = number of entities with data (truncated when total > limit).
 */
export async function metricSeries(def: MetricDef, scope: Scope, f: Filters, w: Window, opts: { stepSec: number; agg: Agg; groupBy: 'entity' | 'none'; limit: number; points: boolean }) {
  const { sql: raw, c } = rawCte(def, scope, f, w, opts.groupBy);
  const lim = c.param(opts.limit);
  const step = opts.points ? c.param(opts.stepSec) : '';
  const bucketSql = opts.points
    ? `, bk AS (SELECT eid, (floor(extract(epoch FROM ts) / ${step}::int) * ${step}::int)::bigint AS b, ${AGG_SQL[opts.agg]} AS v
               FROM raw WHERE eid IN (SELECT eid FROM top) GROUP BY 1, 2)`
    : '';
  const ptsCol = opts.points ? `, (SELECT json_agg(json_build_array(bk.b, bk.v) ORDER BY bk.b) FROM bk WHERE bk.eid = top.eid) AS pts` : '';
  const sql = `WITH ${raw},
    st AS (SELECT eid, max(label) AS label, max(host_id) AS host_id, max(host) AS host, count(*)::int AS n, min(v) AS mn, avg(v) AS av, max(v) AS mx,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY v) AS p95 FROM raw GROUP BY eid),
    top AS (SELECT st.*, count(*) OVER () AS total FROM st ORDER BY av DESC, eid LIMIT ${lim}),
    lst AS (SELECT DISTINCT ON (eid) eid, v AS last, ts AS last_ts FROM raw WHERE eid IN (SELECT eid FROM top) ORDER BY eid, ts DESC),
    mxt AS (SELECT DISTINCT ON (eid) eid, ts AS max_ts FROM raw WHERE eid IN (SELECT eid FROM top) ORDER BY eid, v DESC, ts ASC)
    ${bucketSql}
    SELECT top.eid, top.label, top.host_id, top.host, top.n, top.mn, top.av, top.mx, top.p95, top.total, lst.last, lst.last_ts, mxt.max_ts ${ptsCol}
    FROM top JOIN lst USING (eid) JOIN mxt USING (eid) ORDER BY top.av DESC, top.eid`;
  const rows = await query(sql, c.params, tsPool);
  const total = rows.length ? Number(rows[0].total) : 0;
  const allLabel = `All ${def.entity === 'database' ? 'databases' : def.entity === 'jvm' ? 'JVMs' : def.entity + 's'}`;
  const series: SeriesOut[] = rows.map((r) => ({
    metric: def.key, unit: def.unit, entityId: r.eid, entity: def.entity, label: opts.groupBy === 'none' ? allLabel : r.label,
    ...(r.host_id ? { hostId: r.host_id, host: r.host } : {}),
    ...(opts.points ? { points: fillGrid(w.from.getTime(), w.to.getTime(), opts.stepSec, (r.pts ?? []) as [number, number | null][]) } : {}),
    stats: { min: num(r.mn), avg: num(r.av), max: num(r.mx), p95: num(r.p95), last: num(r.last), samples: Number(r.n), maxTs: isoOrNull(r.max_ts), lastTs: isoOrNull(r.last_ts) },
  }));
  return { series, total };
}

/* ------------------------------------------------------------------ markers */

export interface Marker { ts: string; endTs: string | null; kind: 'run' | 'event' | 'annotation' | 'deployment'; label: string; href?: string; severity?: string }

export async function markers(scope: Scope, f: Filters, w: Window): Promise<Marker[]> {
  const common = (c: Conds, alias: string, cols: { env?: boolean; app?: boolean; run?: string }) => {
    c.add(`pr.organization_id = ?`, scope.orgId);
    if (scope.keyProjectId) c.add(`${alias}.project_id = ?`, scope.keyProjectId);
    if (f.projectId) c.add(`${alias}.project_id = ANY(?)`, f.projectId);
    if (f.environmentId && cols.env) c.add(`${alias}.environment_id = ANY(?)`, f.environmentId);
    if (f.applicationId && cols.app) c.add(`${alias}.application_id = ANY(?)`, f.applicationId);
    if (f.runId && cols.run) c.add(`${cols.run} = ANY(?)`, f.runId);
  };
  const rc = new Conds();
  common(rc, 'r', { env: true, app: true, run: 'r.id' });
  rc.raw('r.deleted_at IS NULL AND r.started_at IS NOT NULL');
  rc.add('r.started_at < ?', w.to);
  rc.add('COALESCE(r.ended_at, now()) >= ?', w.from);
  const ec = new Conds();
  common(ec, 'ev', { env: true, app: true, run: 'ev.run_id' });
  ec.add('ev.ts >= ?', w.from);
  ec.add('ev.ts < ?', w.to);
  const ac = new Conds();
  common(ac, 'a', { env: true, run: 'a.run_id' });
  ac.add('a.ts < ?', w.to);
  ac.add('COALESCE(a.ts_end, a.ts) >= ?', w.from);
  const [runs, events, notes] = await Promise.all([
    query(`SELECT r.run_key, r.started_at, r.ended_at, r.status, t.name AS test_name FROM test_runs r JOIN projects pr ON pr.id = r.project_id
           JOIN performance_tests t ON t.id = r.test_id WHERE ${rc.where()} ORDER BY r.started_at LIMIT 300`, rc.params),
    query(`SELECT ev.type, ev.severity, ev.ts, ev.title FROM events ev JOIN projects pr ON pr.id = ev.project_id WHERE ${ec.where()} ORDER BY ev.ts LIMIT 300`, ec.params),
    query(`SELECT a.ts, a.ts_end, a.title FROM annotations a JOIN projects pr ON pr.id = a.project_id WHERE ${ac.where()} ORDER BY a.ts LIMIT 300`, ac.params),
  ]);
  const out: Marker[] = [
    ...runs.map((r) => ({ ts: isoOrNull(r.started_at)!, endTs: isoOrNull(r.ended_at), kind: 'run' as const, label: `${r.run_key} ${r.test_name}`, href: `/runs/${r.run_key}`, severity: r.status })),
    ...events.map((e) => ({ ts: isoOrNull(e.ts)!, endTs: null, kind: (e.type === 'DEPLOYMENT' ? 'deployment' : 'event') as Marker['kind'], label: e.title, severity: e.severity })),
    ...notes.map((a) => ({ ts: isoOrNull(a.ts)!, endTs: isoOrNull(a.ts_end), kind: 'annotation' as const, label: a.title })),
  ];
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/* ------------------------------------------------------------------ inventory */

export async function inventory(scope: Scope, f: Filters, w: Window) {
  const P = (c: Conds, projCol: string, extra: { env?: string; app?: string; id?: [keyof Filters, string][]; role?: string } = {}) => {
    c.add('pr.organization_id = ?', scope.orgId);
    if (scope.keyProjectId) c.add(`${projCol} = ?`, scope.keyProjectId);
    if (f.projectId) c.add(`${projCol} = ANY(?)`, f.projectId);
    if (f.environmentId && extra.env) c.add(`${extra.env} = ANY(?)`, f.environmentId);
    if (f.applicationId && extra.app) c.add(`${extra.app} = ANY(?)`, f.applicationId);
    if (f.role && extra.role) c.add(`${extra.role} = ANY(?)`, f.role);
    for (const [k, col] of extra.id ?? []) if (f[k]) c.add(`${col} = ANY(?)`, f[k]);
    return c;
  };
  const hc = P(new Conds([w.from, w.to]), 's.project_id', { env: 's.environment_id', app: 's.application_id', id: [['hostId', 's.id']], role: 'lower(s.role)' });
  const dc = P(new Conds([w.from, w.to]), 'sv.project_id', { env: 'sv.environment_id', app: 'sv.application_id', id: [['databaseId', 'sv.id'], ['hostId', 'sv.server_id']], role: 'lower(h.role)' });
  const sc = P(new Conds([w.from, w.to]), 'sv.project_id', { env: 'sv.environment_id', app: 'sv.application_id', id: [['serviceId', 'sv.id'], ['hostId', 'sv.server_id']], role: 'lower(h.role)' });
  const rc = P(new Conds([w.from, w.to]), 'r.project_id', { env: 'r.environment_id', app: 'r.application_id', id: [['runId', 'r.id']] });
  const kc = new Conds([scope.orgId]);
  if (scope.keyProjectId) kc.add('i.project_id = ?', scope.keyProjectId);
  if (f.projectId) kc.add('(i.project_id = ANY(?) OR i.project_id IS NULL)', f.projectId);
  if (f.cluster) kc.add('i.id = ANY(?)', f.cluster);

  const [hosts, dbs, svcs, runs, clusters] = await Promise.all([
    query(`SELECT s.id, s.name, s.role, s.environment_id, s.project_id, s.hostname,
                  (SELECT max(x.ts) FROM server_metrics x WHERE x.server_id = s.id AND x.ts >= $1 AND x.ts < $2) AS last_seen,
                  EXISTS (SELECT 1 FROM jvm_metrics j WHERE j.server_id = s.id AND j.ts >= $1 AND j.ts < $2) AS has_jvm
             FROM servers s JOIN projects pr ON pr.id = s.project_id WHERE ${hc.where()} ORDER BY s.name LIMIT 2000`, hc.params),
    query(`SELECT sv.id, sv.name, sv.technology, sv.server_id, sv.environment_id, sv.project_id,
                  (SELECT max(x.ts) FROM database_metrics x WHERE x.service_id = sv.id AND x.ts >= $1 AND x.ts < $2) AS last_seen,
                  (SELECT x.db_engine FROM database_metrics x WHERE x.service_id = sv.id AND x.db_engine IS NOT NULL ORDER BY x.ts DESC LIMIT 1) AS engine
             FROM services sv JOIN projects pr ON pr.id = sv.project_id LEFT JOIN servers h ON h.id = sv.server_id
            WHERE sv.kind = 'database' AND ${dc.where()} ORDER BY sv.name LIMIT 2000`, dc.params),
    query(`SELECT sv.id, sv.name, sv.kind, sv.server_id, sv.environment_id, sv.project_id,
                  (SELECT max(x.ts) FROM service_metrics x WHERE x.service_id = sv.id AND x.ts >= $1 AND x.ts < $2) AS svc_seen,
                  (SELECT max(x.ts) FROM jvm_metrics x WHERE x.service_id = sv.id AND x.ts >= $1 AND x.ts < $2) AS jvm_seen
             FROM services sv JOIN projects pr ON pr.id = sv.project_id LEFT JOIN servers h ON h.id = sv.server_id
            WHERE sv.kind <> 'database' AND ${sc.where()} ORDER BY sv.name LIMIT 2000`, sc.params),
    query(`SELECT r.id, r.run_key, t.name AS test_name, r.started_at, r.ended_at, r.status, r.environment_id, r.project_id
             FROM test_runs r JOIN projects pr ON pr.id = r.project_id JOIN performance_tests t ON t.id = r.test_id
            WHERE r.deleted_at IS NULL AND r.started_at IS NOT NULL AND r.started_at < $2 AND COALESCE(r.ended_at, now()) >= $1 AND ${rc.where()}
            ORDER BY r.started_at DESC LIMIT 300`, rc.params),
    query(`SELECT i.id, i.name, COALESCE(NULLIF(i.config->>'clusterName', ''), i.name) AS cluster_name FROM integrations i
            WHERE i.organization_id = $1 AND i.type = 'KUBERNETES' AND ${kc.where()} ORDER BY i.name`, kc.params),
  ]);

  let k8s: any[] = [];
  let k8sNodes: any[] = [];
  if (clusters.length) {
    const ids = clusters.map((c) => c.id);
    const pc = new Conds([ids, w.from, w.to]);
    if (scope.keyProjectId) pc.add('m.project_id = ?', scope.keyProjectId);
    for (const [k, col] of [['namespace', `m.tags->>'namespace'`], ['workload', `m.tags->>'workload'`], ['pod', `m.tags->>'pod'`], ['node', `m.tags->>'node'`]] as const) if (f[k]) pc.add(`${col} = ANY(?)`, f[k]);
    [k8s, k8sNodes] = await Promise.all([
      query(`SELECT DISTINCT m.tags->>'cluster' AS cluster, m.tags->>'namespace' AS namespace, m.tags->>'pod' AS pod, m.tags->>'workload' AS workload,
                    m.tags->>'workloadKind' AS workload_kind, m.tags->>'node' AS node
               FROM metric_points m WHERE m.source = 'kubernetes' AND m.metric = 'k8s.pod.cpu_mcores' AND m.tags->>'cluster' = ANY($1::text[])
                AND m.ts >= $2 AND m.ts < $3 AND ${pc.where()} LIMIT 5000`, pc.params, tsPool),
      query(`SELECT DISTINCT m.tags->>'cluster' AS cluster, m.tags->>'node' AS node
               FROM metric_points m WHERE m.source = 'kubernetes' AND m.metric = 'k8s.node.cpu_mcores' AND m.tags->>'cluster' = ANY($1::text[])
                AND m.ts >= $2 AND m.ts < $3 ${scope.keyProjectId ? 'AND m.project_id = $4' : ''} LIMIT 2000`, scope.keyProjectId ? [ids, w.from, w.to, scope.keyProjectId] : [ids, w.from, w.to], tsPool),
    ]);
  }
  const uniq = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
  const svcOut = svcs.map((s) => {
    const seen = [s.svc_seen, s.jvm_seen].filter(Boolean).map((d) => new Date(d).getTime());
    return { id: s.id, name: s.name, kind: s.jvm_seen && !s.svc_seen ? 'jvm' : 'service', serviceKind: s.kind, hostId: s.server_id ?? null, hasJvm: !!s.jvm_seen, lastSeen: seen.length ? new Date(Math.max(...seen)).toISOString() : null };
  });
  const hostOut = hosts.map((h) => ({ id: h.id, name: h.name, role: h.role ?? null, hostname: h.hostname ?? null, environmentId: h.environment_id ?? null, projectId: h.project_id, lastSeen: isoOrNull(h.last_seen), hasJvm: !!h.has_jvm }));
  const dbOut = dbs.map((d) => ({ id: d.id, name: d.name, engine: d.engine ?? d.technology ?? null, hostId: d.server_id ?? null, lastSeen: isoOrNull(d.last_seen) }));
  const pods = k8s.filter((p) => p.pod);
  const has: Record<EntityKind, boolean> = {
    host: hostOut.some((h) => h.lastSeen), database: dbOut.some((d) => d.lastSeen), service: svcOut.some((s) => s.lastSeen && s.kind === 'service'),
    jvm: svcOut.some((s) => s.hasJvm) || hostOut.some((h) => h.hasJvm), pod: pods.length > 0, node: k8sNodes.length > 0, run: runs.length > 0,
  };
  return {
    from: w.from.toISOString(), to: w.to.toISOString(),
    hosts: hostOut, databases: dbOut, services: svcOut,
    kubernetes: {
      clusters: clusters.map((c) => ({ id: c.id, name: c.cluster_name })),
      namespaces: uniq(pods, (p) => `${p.cluster}|${p.namespace}`).map((p) => ({ cluster: p.cluster, name: p.namespace })),
      workloads: uniq(pods.filter((p) => p.workload), (p) => `${p.cluster}|${p.namespace}|${p.workload}`).map((p) => ({ cluster: p.cluster, namespace: p.namespace, name: p.workload, kind: p.workload_kind ?? null })),
      pods: uniq(pods, (p) => `${p.cluster}|${p.namespace}|${p.pod}`).map((p) => ({ cluster: p.cluster, namespace: p.namespace, name: p.pod, workload: p.workload ?? null, node: p.node ?? null })),
      nodes: k8sNodes.filter((n) => n.node).map((n) => ({ cluster: n.cluster, name: n.node })),
    },
    runs: runs.map((r) => ({ id: r.id, runKey: r.run_key, testName: r.test_name, startedAt: isoOrNull(r.started_at), endedAt: isoOrNull(r.ended_at), status: r.status, environmentId: r.environment_id, projectId: r.project_id })),
    metrics: METRICS.map((m) => ({ ...publicMetric(m), hasData: has[m.entity] })),
  };
}

export { METRIC_BY_KEY };
