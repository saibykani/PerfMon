import { bulkInsert, one, query, tsPool } from '../db/pool.js';
import type { ImportedSeries, RunWindow } from './connectors/types.js';
import { hostFromLabels } from './connectors/http.js';

/**
 * Persists imported series into Perfmon's metric model, correlated to the run:
 *   server   → server_metrics  (per server, auto-registered by name in the run's environment)
 *   jvm      → jvm_metrics     (per server/service)
 *   database → database_metrics (per database service)
 *   service  → service_metrics (per service)
 *   custom / unknown metric → metric_points (tags = source labels)
 * Values for the same entity and timestamp are merged into one row. Re-importing replaces
 * previously imported rows of the same source for the run (idempotent).
 */
export const TARGET_COLUMNS: Record<string, Record<string, string>> = {
  server: {
    cpu_pct: 'cpu_pct', memory_pct: 'memory_pct', memory_used_mb: 'memory_used_mb', disk_pct: 'disk_pct', disk_read_bps: 'disk_read_bps', disk_write_bps: 'disk_write_bps',
    net_in_bps: 'net_in_bps', net_out_bps: 'net_out_bps', load_avg_1m: 'load_avg_1m', processes: 'processes', tcp_connections: 'tcp_connections', file_descriptors: 'file_descriptors',
  },
  jvm: {
    heap_used_mb: 'heap_used_mb', heap_committed_mb: 'heap_committed_mb', heap_max_mb: 'heap_max_mb', nonheap_used_mb: 'nonheap_used_mb', gc_count: 'gc_count', gc_time_ms: 'gc_time_ms',
    gc_max_pause_ms: 'gc_max_pause_ms', gc_pause_ms: 'gc_max_pause_ms', thread_count: 'thread_count', threads: 'thread_count', peak_threads: 'peak_threads', classes_loaded: 'classes_loaded',
  },
  database: {
    connections: 'connections', active_connections: 'active_connections', db_connections: 'active_connections', max_connections: 'max_connections', query_latency_ms: 'query_latency_ms',
    db_latency_ms: 'query_latency_ms', slow_queries: 'slow_queries', locks: 'locks', deadlocks: 'deadlocks', cpu_pct: 'cpu_pct', memory_pct: 'memory_pct', transactions_per_sec: 'transactions_per_sec',
  },
  service: {
    request_rate: 'request_rate', error_rate_pct: 'error_rate_pct', avg_latency_ms: 'avg_latency_ms', p95_latency_ms: 'p95_latency_ms', exceptions: 'exceptions', cpu_pct: 'cpu_pct', memory_pct: 'memory_pct',
  },
};
const INT_COLS = new Set(['processes', 'tcp_connections', 'file_descriptors', 'gc_count', 'thread_count', 'peak_threads', 'classes_loaded', 'connections', 'active_connections', 'max_connections', 'slow_queries', 'locks', 'deadlocks', 'exceptions']);

const TABLE: Record<string, { table: string; key: 'server' | 'service' | 'both' }> = {
  server: { table: 'server_metrics', key: 'server' },
  jvm: { table: 'jvm_metrics', key: 'both' },
  database: { table: 'database_metrics', key: 'both' },
  service: { table: 'service_metrics', key: 'service' },
};

function applyTransform(v: number, s: ImportedSeries['query']) {
  let x = v;
  if (s.transform === 'invert_pct') x = 100 - x;
  if (s.scale != null && Number.isFinite(s.scale)) x *= s.scale;
  return x;
}

export async function storeImportedSeries(run: RunWindow, source: string, series: ImportedSeries[]) {
  const warnings: string[] = [];
  // idempotent: remove a previous import from the same source for this run
  for (const t of ['server_metrics', 'jvm_metrics', 'database_metrics', 'service_metrics']) await query(`DELETE FROM ${t} WHERE run_id = $1 AND source = $2`, [run.id, source], tsPool);
  await query(`DELETE FROM metric_points WHERE run_id = $1 AND source = $2`, [run.id, source], tsPool);

  const serverIds = new Map<string, string>();
  const serviceIds = new Map<string, string>();
  const serverId = async (name: string, role: string | undefined) => {
    if (serverIds.has(name)) return serverIds.get(name)!;
    const row = await one(
      `INSERT INTO servers (project_id, environment_id, application_id, name, hostname, role, status, last_seen_at)
       VALUES ($1,$2,$3,$4,$4,$5,'UNKNOWN',NULL)
       ON CONFLICT (project_id, name) DO UPDATE SET role = COALESCE(servers.role, EXCLUDED.role) RETURNING id`,
      [run.projectId, run.environmentId, run.applicationId, name, role ?? null]);
    serverIds.set(name, row.id);
    return row.id as string;
  };
  const serviceId = async (name: string, kind: string, srv: string | null) => {
    const k = `${kind}|${name}`;
    if (serviceIds.has(k)) return serviceIds.get(k)!;
    const row = await one(
      `INSERT INTO services (project_id, application_id, environment_id, server_id, name, kind) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, environment_id, name) DO UPDATE SET server_id = COALESCE(services.server_id, EXCLUDED.server_id) RETURNING id`,
      [run.projectId, run.applicationId, run.environmentId, srv, name, kind]);
    serviceIds.set(k, row.id);
    return row.id as string;
  };

  // rows keyed by table|entity|ts → merged column values
  const rows = new Map<string, { table: string; server: string | null; service: string | null; ts: number; values: Record<string, number> }>();
  const generic: unknown[][] = [];
  let imported = 0;
  const fromMs = run.from.getTime();
  const toMs = run.to.getTime();

  for (const s of series) {
    const q = s.query;
    const col = TARGET_COLUMNS[q.target]?.[q.metric];
    const pts = s.points.filter(([t, v]) => t >= fromMs - 60000 && t <= toMs + 60000 && Number.isFinite(v));
    if (!pts.length) continue;
    if (!col) {
      if (q.target !== 'custom') warnings.push(`${q.metric}: not a known ${q.target} metric — stored as a custom metric point`);
      for (const [t, v] of pts) generic.push([new Date(t), q.metric, applyTransform(v, q), run.id, run.projectId, run.environmentId, JSON.stringify({ ...s.labels, ...(q.serverName ? { server: q.serverName } : {}), ...(q.serviceName ? { service: q.serviceName } : {}) }), source]);
      imported += pts.length;
      continue;
    }
    const host = q.serverName ?? hostFromLabels(s.labels);
    const svcName = q.serviceName ?? s.labels.service ?? s.labels['service.name'] ?? s.labels.application ?? s.labels.job ?? null;
    let srv: string | null = null;
    let svc: string | null = null;
    const spec = TABLE[q.target];
    if (spec.key === 'server' || spec.key === 'both') {
      if (host) srv = await serverId(host, q.role ?? (q.target === 'database' ? 'db' : 'app'));
      else if (spec.key === 'server') { warnings.push(`${q.metric}: series without a host/instance label and no serverName — skipped`); continue; }
    }
    if (spec.key === 'service' || spec.key === 'both') {
      const name = svcName ?? (q.target === 'database' ? host : null);
      if (name) svc = await serviceId(name, q.target === 'database' ? 'database' : 'service', srv);
      else if (spec.key === 'service') { warnings.push(`${q.metric}: series without a service label and no serviceName — skipped`); continue; }
    }
    if (!srv && !svc) { warnings.push(`${q.metric}: could not map series to a server or service — skipped`); continue; }
    for (const [t, v] of pts) {
      const k = `${spec.table}|${srv}|${svc}|${t}`;
      let r = rows.get(k);
      if (!r) rows.set(k, (r = { table: spec.table, server: srv, service: svc, ts: t, values: {} }));
      const val = applyTransform(v, q);
      r.values[col] = INT_COLS.has(col) ? Math.round(val) : val;
      imported++;
    }
  }

  type Row = { table: string; server: string | null; service: string | null; ts: number; values: Record<string, number> };
  const byTable = new Map<string, Row[]>();
  for (const r of rows.values()) {
    const arr = byTable.get(r.table) ?? [];
    arr.push(r);
    byTable.set(r.table, arr);
  }
  for (const [table, list] of byTable) {
    const target = Object.entries(TABLE).find(([, v]) => v.table === table)![0];
    const cols = [...new Set(Object.values(TARGET_COLUMNS[target]))];
    const keyCols = TABLE[target].key === 'server' ? ['server_id'] : TABLE[target].key === 'service' ? ['service_id'] : ['server_id', 'service_id'];
    const columns = ['ts', ...keyCols, 'run_id', ...cols, 'source'];
    const values = list.map((r) => [new Date(r.ts), ...keyCols.map((k) => (k === 'server_id' ? r.server : r.service)), run.id, ...cols.map((c) => r.values[c] ?? null), source]);
    for (let i = 0; i < values.length; i += 1000) {
      const [sql, params] = bulkInsert(table, columns, values.slice(i, i + 1000));
      await query(sql, params, tsPool);
    }
  }
  for (let i = 0; i < generic.length; i += 2000) {
    const [sql, params] = bulkInsert('metric_points', ['ts', 'metric', 'value', 'run_id', 'project_id', 'environment_id', 'tags', 'source'], generic.slice(i, i + 2000));
    await query(sql, params, tsPool);
  }
  if (serverIds.size) await query(`UPDATE servers SET last_seen_at = GREATEST(COALESCE(last_seen_at, 'epoch'), $2) WHERE id = ANY($1::uuid[])`, [[...serverIds.values()], run.to]);
  return { imported, warnings, servers: [...serverIds.keys()], services: [...serviceIds.keys()].map((k) => k.split('|')[1]) };
}
