import type { Connector, ImportQuery, ImportedSeries } from './types.js';
import { ConnectorError, authHeaders, expectOk, http, joinUrl, probe, requireUrl } from './http.js';

/**
 * Prometheus connector: PromQL range queries (GET /api/v1/query_range) for the run window.
 * Generic metric abstraction: each mapping turns a PromQL expression into a Perfmon metric
 * (cpu_pct, memory_pct, heap_used_mb, query_latency_ms, request_rate, ...); the UI only deals
 * with Perfmon metric names.
 */
const DEFAULTS: ImportQuery[] = [
  { metric: 'cpu_pct', target: 'server', query: '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)' },
  { metric: 'memory_pct', target: 'server', query: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100' },
  { metric: 'load_avg_1m', target: 'server', query: 'node_load1' },
  { metric: 'heap_used_mb', target: 'jvm', query: 'sum by (instance) (jvm_memory_used_bytes{area="heap"}) / 1048576' },
  { metric: 'heap_max_mb', target: 'jvm', query: 'sum by (instance) (jvm_memory_max_bytes{area="heap"}) / 1048576' },
  { metric: 'gc_max_pause_ms', target: 'jvm', query: 'max by (instance) (jvm_gc_pause_seconds_max) * 1000' },
  { metric: 'thread_count', target: 'jvm', query: 'sum by (instance) (jvm_threads_live_threads)' },
  { metric: 'request_rate', target: 'service', query: 'sum by (application) (rate(http_server_requests_seconds_count[1m]))' },
];

export function parsePromMatrix(json: any): { labels: Record<string, string>; points: [number, number][] }[] {
  if (json?.status !== 'success') throw new ConnectorError(`Prometheus error: ${json?.error ?? 'unexpected response'}`);
  const data = json.data;
  const rows = data?.resultType === 'matrix' ? data.result : data?.resultType === 'vector' ? data.result.map((r: any) => ({ metric: r.metric, values: [r.value] })) : [];
  return rows.map((r: any) => ({
    labels: Object.fromEntries(Object.entries(r.metric ?? {}).map(([k, v]) => [k, String(v)])),
    points: (r.values ?? []).map(([t, v]: [number, string]) => [Math.round(Number(t) * 1000), Number(v)] as [number, number]).filter(([, v]: [number, number]) => Number.isFinite(v)),
  }));
}

export const prometheusConnector: Connector = {
  type: 'PROMETHEUS',
  label: 'Prometheus',
  category: 'METRICS',
  authTypes: ['NONE', 'TOKEN', 'BASIC'],
  fields: [
    { key: 'token', label: 'Bearer token', required: false, secret: true },
    { key: 'username', label: 'Username (basic auth)', required: false, secret: true },
    { key: 'password', label: 'Password (basic auth)', required: false, secret: true },
  ],
  supportsImport: true,
  docs: 'Imports metrics for a run window with PromQL range queries (GET /api/v1/query_range, step derived from the run duration). config.mappings: [{ metric, target: server|jvm|database|service|custom, query: "<PromQL>", serverName?, serviceName?, scale? }]. Defaults cover node_exporter (CPU, memory, load) and Micrometer JVM/HTTP metrics. Series are split by the instance/host label and stored per server (port stripped), correlated to the Run ID.',
  defaultQueries: () => DEFAULTS,

  async test(i, c) {
    return probe(async () => {
      const base = requireUrl(i);
      const r = expectOk(await http(joinUrl(base, '/api/v1/status/buildinfo'), { headers: authHeaders(i, c) }), 'Prometheus buildinfo');
      const ver = r.json?.data?.version;
      const q = expectOk(await http(joinUrl(base, '/api/v1/query?query=up'), { headers: authHeaders(i, c) }), 'Prometheus query');
      const targets = q.json?.data?.result?.length ?? 0;
      return { message: `Connected to Prometheus ${ver ?? ''}`.trim() + `; ${targets} scrape target(s) report 'up'`, details: { version: ver, targets } };
    });
  },

  async importRun(i, c, run, queries) {
    const base = requireUrl(i);
    const series: ImportedSeries[] = [];
    const warnings: string[] = [];
    for (const q of queries) {
      try {
        const qs = new URLSearchParams({ query: q.query, start: String(run.from.getTime() / 1000), end: String(run.to.getTime() / 1000), step: `${run.stepSec}s` });
        const r = await http(joinUrl(base, `/api/v1/query_range?${qs}`), { headers: authHeaders(i, c) });
        if (!r.ok) throw new ConnectorError(r.json?.error ? `Prometheus error: ${r.json.error}` : `HTTP ${r.status}`);
        const rows = parsePromMatrix(r.json);
        if (!rows.length) warnings.push(`${q.metric}: query returned no series in the run window`);
        for (const s of rows) series.push({ query: q, labels: s.labels, points: s.points });
      } catch (e) {
        warnings.push(`${q.metric}: ${(e as Error).message}`);
      }
    }
    return { series, warnings };
  },
};
