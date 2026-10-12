import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, download, qs } from '@/services/api';
import { apiFilterParams, toIso, type ObsFilterValues } from './obsTime';

/* Types follow docs/architecture/observability-api.md */

export type MetricEntity = 'host' | 'database' | 'service' | 'jvm' | 'pod' | 'node' | 'run' | string;
export interface MetricDef { key: string; label: string; unit?: string | null; entity: MetricEntity }
export interface ObsInventory {
  from: string; to: string;
  hosts: { id: string; name: string; role?: string | null; environmentId?: string | null; projectId?: string | null; lastSeen?: string | null }[];
  databases: { id: string; name: string; engine?: string | null; hostId?: string | null; lastSeen?: string | null }[];
  services: { id: string; name: string; kind?: string | null; lastSeen?: string | null }[];
  kubernetes: {
    clusters: { id: string; name: string }[];
    namespaces: { cluster: string; name: string }[];
    workloads: { cluster: string; namespace: string; name: string; kind?: string }[];
    pods: { cluster: string; namespace: string; name: string; workload?: string | null; node?: string | null }[];
  };
  runs: { id: string; runKey: string; testName: string; startedAt: string; endedAt: string | null; status: string }[];
  metrics: MetricDef[];
}
export interface ObsStats { min: number | null; avg: number | null; max: number | null; p95: number | null; last: number | null; samples: number }
export interface ObsSeries { metric: string; unit?: string | null; entityId: string | null; entity: string; label: string; points: [number, number | null][]; stats?: ObsStats }
export interface ObsMarker { ts: string; endTs?: string | null; kind: 'run' | 'event' | 'annotation' | 'deployment' | string; label: string; href?: string | null }
export interface ObsSeriesResp { from: string; to: string; stepSec: number; agg: string; series: ObsSeries[]; truncated?: boolean; markers?: ObsMarker[] }
export interface ObsTableRow { metric: string; unit?: string | null; entity: string; entityId: string | null; label: string; stats: ObsStats }
export interface ObsTableResp { from: string; to: string; rows: ObsTableRow[] }
export interface CollectionSchedule {
  integrationId: string; integrationName?: string; name?: string; type?: string; enabled: boolean; intervalSec: number; environmentId?: string | null;
  lastRunAt?: string | null; lastStatus?: string | null; lastError?: string | null; points?: number | null;
}

export type Agg = 'avg' | 'min' | 'max' | 'p95' | 'sum' | 'last';
export const AGGS: Agg[] = ['avg', 'min', 'max', 'p95', 'sum', 'last'];

export const ENTITY_LABEL: Record<string, string> = {
  host: 'Hosts', database: 'Databases', service: 'Services', jvm: 'JVM', pod: 'Kubernetes pods', node: 'Kubernetes nodes', run: 'Test runs',
};
export const ENTITY_ORDER = ['host', 'database', 'service', 'jvm', 'pod', 'node', 'run'];

/** Fallback catalogue (contract) used for labels before the inventory has loaded. */
export const CATALOGUE: MetricDef[] = [
  { key: 'host.cpu_pct', label: 'CPU', unit: '%', entity: 'host' }, { key: 'host.memory_pct', label: 'Memory', unit: '%', entity: 'host' },
  { key: 'host.memory_used_mb', label: 'Memory used', unit: 'MB', entity: 'host' }, { key: 'host.disk_pct', label: 'Disk', unit: '%', entity: 'host' },
  { key: 'host.load_1m', label: 'Load (1m)', entity: 'host' }, { key: 'host.net_rx_kbps', label: 'Network in', unit: 'KB/s', entity: 'host' },
  { key: 'host.net_tx_kbps', label: 'Network out', unit: 'KB/s', entity: 'host' },
  { key: 'db.query_latency_ms', label: 'Query latency', unit: 'ms', entity: 'database' }, { key: 'db.connections_active', label: 'Active connections', entity: 'database' },
  { key: 'db.pool_pct', label: 'Pool utilisation', unit: '%', entity: 'database' }, { key: 'db.slow_queries', label: 'Slow queries', entity: 'database' },
  { key: 'db.locks', label: 'Locks', entity: 'database' }, { key: 'db.deadlocks', label: 'Deadlocks', entity: 'database' },
  { key: 'db.tps', label: 'Transactions', unit: 'tx/s', entity: 'database' }, { key: 'db.cpu_pct', label: 'DB CPU', unit: '%', entity: 'database' },
  { key: 'svc.request_rate', label: 'Request rate', unit: 'req/s', entity: 'service' }, { key: 'svc.error_pct', label: 'Error rate', unit: '%', entity: 'service' },
  { key: 'svc.latency_ms', label: 'Latency', unit: 'ms', entity: 'service' }, { key: 'svc.cpu_pct', label: 'Service CPU', unit: '%', entity: 'service' },
  { key: 'jvm.heap_used_mb', label: 'Heap used', unit: 'MB', entity: 'jvm' }, { key: 'jvm.heap_pct', label: 'Heap', unit: '%', entity: 'jvm' },
  { key: 'jvm.gc_pause_ms', label: 'GC pause', unit: 'ms', entity: 'jvm' }, { key: 'jvm.threads', label: 'Threads', entity: 'jvm' },
  { key: 'k8s.pod.cpu_millicores', label: 'Pod CPU', unit: 'mCPU', entity: 'pod' }, { key: 'k8s.pod.memory_mb', label: 'Pod memory', unit: 'MB', entity: 'pod' },
  { key: 'k8s.pod.restarts', label: 'Pod restarts', entity: 'pod' },
  { key: 'k8s.node.cpu_millicores', label: 'Node CPU', unit: 'mCPU', entity: 'node' }, { key: 'k8s.node.memory_mb', label: 'Node memory', unit: 'MB', entity: 'node' },
  { key: 'run.tps', label: 'Throughput', unit: 'req/s', entity: 'run' }, { key: 'run.p95_ms', label: 'P95 response', unit: 'ms', entity: 'run' },
  { key: 'run.error_pct', label: 'Errors', unit: '%', entity: 'run' }, { key: 'run.active_users', label: 'Active users', entity: 'run' },
];

export function metricIndex(inv?: ObsInventory | null): Record<string, MetricDef> {
  const out: Record<string, MetricDef> = {};
  for (const m of CATALOGUE) out[m.key] = m;
  for (const m of inv?.metrics ?? []) out[m.key] = m;
  return out;
}

export interface ObsQuery { from: number; to: number; filters: ObsFilterValues }

export function seriesParams(q: ObsQuery, o: { metrics: string[]; agg?: Agg; groupBy?: 'entity' | 'none'; step?: number | 'auto'; limit?: number }) {
  return {
    metric: o.metrics.join(','), from: toIso(q.from), to: toIso(q.to), step: o.step ?? 'auto', agg: o.agg ?? 'avg', groupBy: o.groupBy ?? 'entity',
    ...(o.limit ? { limit: o.limit } : {}), ...apiFilterParams(q.filters),
  };
}

export const useObsInventory = (from: number, to: number) =>
  useQuery({
    queryKey: ['obs', 'inventory', from, to],
    queryFn: () => api.get<ObsInventory>('/observability/inventory', { from: toIso(from), to: toIso(to) }),
    placeholderData: keepPreviousData, staleTime: 30_000, retry: 1,
  });

export const useObsSeries = (q: ObsQuery, o: Parameters<typeof seriesParams>[1], enabled = true) => {
  const params = seriesParams(q, o);
  return useQuery({
    queryKey: ['obs', 'series', params], enabled: enabled && o.metrics.length > 0,
    queryFn: () => api.get<ObsSeriesResp>('/observability/series', params), placeholderData: keepPreviousData, retry: 1,
  });
};

export const useObsTable = (q: ObsQuery, o: Parameters<typeof seriesParams>[1], enabled = true) => {
  const params = seriesParams(q, o);
  return useQuery({
    queryKey: ['obs', 'table', params], enabled: enabled && o.metrics.length > 0,
    queryFn: () => api.get<ObsTableResp>('/observability/table', params), placeholderData: keepPreviousData, retry: 1,
  });
};

export const downloadTableCsv = (q: ObsQuery, o: Parameters<typeof seriesParams>[1]) =>
  download(`/observability/table${qs({ ...seriesParams(q, o), format: 'csv' })}`, 'observability.csv');
