import type { FilterKey } from './pure.js';

/**
 * Metric catalogue: public metric key → whitelisted SQL over REAL stored columns.
 * Nothing user-supplied is ever interpolated into SQL — only these constant fragments.
 */

export type EntityKind = 'host' | 'database' | 'service' | 'jvm' | 'pod' | 'node' | 'run';
export type SourceId = 'host' | 'database' | 'service' | 'jvm' | 'k8s_pod' | 'k8s_node' | 'run';

export interface MetricDef {
  key: string; label: string; unit: string; entity: EntityKind; source: SourceId;
  /** SQL expression over alias `m` (the metric row) */
  expr: string;
  /** metric_points.metric name (k8s sources only) */
  pointMetric?: string;
  /** stored column(s) for docs / method appendix */
  column: string;
}

/**
 * Entity source: FROM clause (metric alias `m`), entity id/label, organization + project expressions and the
 * column each filter applies to. Filters without a column here do not apply to that entity type (ignored).
 * Hosts are always reachable as alias `h` (servers) so `role` / `hostId` work for DB, JVM and services too.
 */
export interface SourceDef {
  from: string; eid: string; label: string; org: string; project: string; hostId?: string; hostLabel?: string;
  where?: string;
  filters: Partial<Record<FilterKey, string>>;
  /** k8s: points with project NULL (org-wide connection) remain visible for an explicit projectId filter */
  projectNullable?: boolean;
  table: string;
}

const RUN_SOURCE_ORDER = `ARRAY['live','jtl','import','html_report']`;

export const SOURCES: Record<SourceId, SourceDef> = {
  host: {
    table: 'server_metrics',
    from: `server_metrics m JOIN servers h ON h.id = m.server_id JOIN projects pr ON pr.id = h.project_id`,
    eid: `m.server_id::text`, label: `h.name`, org: 'pr.organization_id', project: 'h.project_id', hostId: 'h.id::text', hostLabel: 'h.name',
    filters: { projectId: 'h.project_id', environmentId: 'h.environment_id', applicationId: 'h.application_id', hostId: 'm.server_id', runId: 'm.run_id', role: 'lower(h.role)' },
  },
  database: {
    table: 'database_metrics',
    from: `database_metrics m LEFT JOIN services e ON e.id = m.service_id LEFT JOIN servers h ON h.id = COALESCE(m.server_id, e.server_id)
           JOIN projects pr ON pr.id = COALESCE(e.project_id, h.project_id)`,
    eid: `COALESCE(m.service_id, m.server_id)::text`, label: `COALESCE(e.name, h.name)`, org: 'pr.organization_id', project: 'pr.id', hostId: 'h.id::text', hostLabel: 'h.name',
    filters: { projectId: 'pr.id', environmentId: 'COALESCE(e.environment_id, h.environment_id)', applicationId: 'COALESCE(e.application_id, h.application_id)', databaseId: 'm.service_id', hostId: 'h.id', runId: 'm.run_id', role: 'lower(h.role)' },
  },
  jvm: {
    table: 'jvm_metrics',
    from: `jvm_metrics m LEFT JOIN services e ON e.id = m.service_id LEFT JOIN servers h ON h.id = COALESCE(m.server_id, e.server_id)
           JOIN projects pr ON pr.id = COALESCE(e.project_id, h.project_id)`,
    eid: `COALESCE(m.service_id, m.server_id)::text`, label: `COALESCE(e.name, h.name)`, org: 'pr.organization_id', project: 'pr.id', hostId: 'h.id::text', hostLabel: 'h.name',
    filters: { projectId: 'pr.id', environmentId: 'COALESCE(e.environment_id, h.environment_id)', applicationId: 'COALESCE(e.application_id, h.application_id)', serviceId: 'm.service_id', hostId: 'h.id', runId: 'm.run_id', role: 'lower(h.role)' },
  },
  service: {
    table: 'service_metrics',
    from: `service_metrics m JOIN services e ON e.id = m.service_id LEFT JOIN servers h ON h.id = e.server_id JOIN projects pr ON pr.id = e.project_id`,
    eid: `m.service_id::text`, label: `e.name`, org: 'pr.organization_id', project: 'e.project_id', hostId: 'h.id::text', hostLabel: 'h.name',
    filters: { projectId: 'e.project_id', environmentId: 'e.environment_id', applicationId: 'e.application_id', serviceId: 'm.service_id', hostId: 'h.id', runId: 'm.run_id', role: 'lower(h.role)' },
  },
  run: {
    table: 'run_metrics',
    // one metric source per run (live > jtl > import > html_report), chosen once per run, never mixed
    from: `test_runs e JOIN projects pr ON pr.id = e.project_id
           CROSS JOIN LATERAL (SELECT u.s FROM unnest(${RUN_SOURCE_ORDER}) WITH ORDINALITY u(s, o)
                                WHERE EXISTS (SELECT 1 FROM run_metrics x WHERE x.run_id = e.id AND x.source = u.s) ORDER BY u.o LIMIT 1) ps
           JOIN run_metrics m ON m.run_id = e.id AND m.source = ps.s`,
    eid: `e.id::text`, label: `e.run_key`, org: 'pr.organization_id', project: 'e.project_id', where: 'e.deleted_at IS NULL',
    filters: { projectId: 'e.project_id', environmentId: 'e.environment_id', applicationId: 'e.application_id', runId: 'e.id' },
  },
  k8s_pod: {
    table: 'metric_points',
    from: `metric_points m JOIN integrations i ON i.id::text = m.tags->>'cluster' AND i.type = 'KUBERNETES'`,
    eid: `(m.tags->>'cluster') || '/' || (m.tags->>'namespace') || '/' || (m.tags->>'pod')`, label: `(m.tags->>'namespace') || '/' || (m.tags->>'pod')`,
    org: 'i.organization_id', project: 'm.project_id', where: `m.source = 'kubernetes'`, projectNullable: true,
    filters: { projectId: 'm.project_id', cluster: `m.tags->>'cluster'`, namespace: `m.tags->>'namespace'`, workload: `m.tags->>'workload'`, pod: `m.tags->>'pod'`, node: `m.tags->>'node'`, runId: 'm.run_id' },
  },
  k8s_node: {
    table: 'metric_points',
    from: `metric_points m JOIN integrations i ON i.id::text = m.tags->>'cluster' AND i.type = 'KUBERNETES'`,
    eid: `(m.tags->>'cluster') || '/' || (m.tags->>'node')`, label: `m.tags->>'node'`,
    org: 'i.organization_id', project: 'm.project_id', where: `m.source = 'kubernetes'`, projectNullable: true,
    filters: { projectId: 'm.project_id', cluster: `m.tags->>'cluster'`, node: `m.tags->>'node'`, runId: 'm.run_id' },
  },
};

const M = (key: string, label: string, unit: string, entity: EntityKind, source: SourceId, expr: string, column: string, pointMetric?: string): MetricDef =>
  ({ key, label, unit, entity, source, expr, column, pointMetric });

export const METRICS: MetricDef[] = [
  M('host.cpu_pct', 'CPU', '%', 'host', 'host', 'm.cpu_pct', 'server_metrics.cpu_pct'),
  M('host.memory_pct', 'Memory', '%', 'host', 'host', 'm.memory_pct', 'server_metrics.memory_pct'),
  M('host.memory_used_mb', 'Memory used', 'MB', 'host', 'host', 'm.memory_used_mb', 'server_metrics.memory_used_mb'),
  M('host.disk_pct', 'Disk used', '%', 'host', 'host', 'm.disk_pct', 'server_metrics.disk_pct'),
  M('host.load_1m', 'Load (1 min)', '', 'host', 'host', 'm.load_avg_1m', 'server_metrics.load_avg_1m'),
  M('host.net_rx_kbps', 'Network in', 'KB/s', 'host', 'host', 'm.net_in_bps / 1024.0', 'server_metrics.net_in_bps / 1024'),
  M('host.net_tx_kbps', 'Network out', 'KB/s', 'host', 'host', 'm.net_out_bps / 1024.0', 'server_metrics.net_out_bps / 1024'),

  M('db.query_latency_ms', 'Query latency', 'ms', 'database', 'database', 'm.query_latency_ms', 'database_metrics.query_latency_ms'),
  M('db.connections_active', 'Active connections', '', 'database', 'database', 'm.active_connections', 'database_metrics.active_connections'),
  M('db.pool_pct', 'Connection pool used', '%', 'database', 'database', 'CASE WHEN m.max_connections > 0 THEN m.active_connections * 100.0 / m.max_connections END', 'database_metrics.active_connections × 100 / max_connections'),
  M('db.slow_queries', 'Slow queries', '', 'database', 'database', 'm.slow_queries', 'database_metrics.slow_queries'),
  M('db.locks', 'Locks', '', 'database', 'database', 'm.locks', 'database_metrics.locks'),
  M('db.deadlocks', 'Deadlocks', '', 'database', 'database', 'm.deadlocks', 'database_metrics.deadlocks'),
  M('db.tps', 'Transactions', 'tx/s', 'database', 'database', 'm.transactions_per_sec', 'database_metrics.transactions_per_sec'),
  M('db.cpu_pct', 'DB CPU', '%', 'database', 'database', 'm.cpu_pct', 'database_metrics.cpu_pct'),

  M('svc.request_rate', 'Request rate', 'req/s', 'service', 'service', 'm.request_rate', 'service_metrics.request_rate'),
  M('svc.error_pct', 'Error rate', '%', 'service', 'service', 'm.error_rate_pct', 'service_metrics.error_rate_pct'),
  M('svc.latency_ms', 'Latency (avg)', 'ms', 'service', 'service', 'm.avg_latency_ms', 'service_metrics.avg_latency_ms'),
  M('svc.p95_latency_ms', 'Latency (P95)', 'ms', 'service', 'service', 'm.p95_latency_ms', 'service_metrics.p95_latency_ms'),
  M('svc.cpu_pct', 'Service CPU', '%', 'service', 'service', 'm.cpu_pct', 'service_metrics.cpu_pct'),

  M('jvm.heap_used_mb', 'Heap used', 'MB', 'jvm', 'jvm', 'm.heap_used_mb', 'jvm_metrics.heap_used_mb'),
  M('jvm.heap_pct', 'Heap used', '%', 'jvm', 'jvm', 'CASE WHEN m.heap_max_mb > 0 THEN m.heap_used_mb * 100.0 / m.heap_max_mb END', 'jvm_metrics.heap_used_mb × 100 / heap_max_mb'),
  M('jvm.gc_pause_ms', 'GC pause (max)', 'ms', 'jvm', 'jvm', 'm.gc_max_pause_ms', 'jvm_metrics.gc_max_pause_ms'),
  M('jvm.threads', 'Threads', '', 'jvm', 'jvm', 'm.thread_count', 'jvm_metrics.thread_count'),

  M('k8s.pod.cpu_millicores', 'Pod CPU', 'mCPU', 'pod', 'k8s_pod', 'm.value', "metric_points k8s.pod.cpu_mcores", 'k8s.pod.cpu_mcores'),
  M('k8s.pod.memory_mb', 'Pod memory', 'MB', 'pod', 'k8s_pod', 'm.value / 1048576.0', "metric_points k8s.pod.memory_bytes / 1048576", 'k8s.pod.memory_bytes'),
  M('k8s.pod.restarts', 'Pod restarts', '', 'pod', 'k8s_pod', 'm.value', "metric_points k8s.pod.restarts", 'k8s.pod.restarts'),
  M('k8s.node.cpu_millicores', 'Node CPU', 'mCPU', 'node', 'k8s_node', 'm.value', "metric_points k8s.node.cpu_mcores", 'k8s.node.cpu_mcores'),
  M('k8s.node.memory_mb', 'Node memory', 'MB', 'node', 'k8s_node', 'm.value / 1048576.0', "metric_points k8s.node.memory_bytes / 1048576", 'k8s.node.memory_bytes'),
  M('k8s.node.cpu_pct', 'Node CPU (of allocatable)', '%', 'node', 'k8s_node', 'm.value', "metric_points k8s.node.cpu_pct", 'k8s.node.cpu_pct'),
  M('k8s.node.memory_pct', 'Node memory (of allocatable)', '%', 'node', 'k8s_node', 'm.value', "metric_points k8s.node.memory_pct", 'k8s.node.memory_pct'),

  M('run.tps', 'Throughput', 'req/s', 'run', 'run', 'm.sample_count::float8 / NULLIF(m.interval_sec, 0)', 'run_metrics.sample_count / interval_sec'),
  M('run.p95_ms', 'Response time P95', 'ms', 'run', 'run', 'm.p95', 'run_metrics.p95'),
  M('run.error_pct', 'Error rate', '%', 'run', 'run', 'CASE WHEN m.sample_count > 0 THEN m.error_count * 100.0 / m.sample_count END', 'run_metrics.error_count × 100 / sample_count'),
  M('run.active_users', 'Active users', '', 'run', 'run', 'm.active_threads', 'run_metrics.active_threads'),
];

export const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));
export const METRIC_KEYS = new Set(METRICS.map((m) => m.key));

export const publicMetric = (m: MetricDef) => ({ key: m.key, label: m.label, unit: m.unit, entity: m.entity });
