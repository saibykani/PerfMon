import type { Connector, Credentials, ImportQuery, ImportedSeries, IntegrationRecord } from './types.js';
import { ConnectorError, expectOk, http, joinUrl, probe, requireUrl } from './http.js';

/**
 * Dynatrace connector: Metrics API v2 (GET /api/v2/metrics/query) with an "Api-Token" header.
 * The token needs the `metrics.read` scope. Selectors with the `:names` transformation expose
 * entity names (e.g. dt.entity.host.name) which map to Perfmon servers/services.
 */
const DEFAULTS: ImportQuery[] = [
  { metric: 'cpu_pct', target: 'server', query: 'builtin:host.cpu.usage:names' },
  { metric: 'memory_pct', target: 'server', query: 'builtin:host.mem.usage:names' },
  { metric: 'avg_latency_ms', target: 'service', query: 'builtin:service.response.time:names', scale: 0.001 },  // µs → ms
  { metric: 'request_rate', target: 'service', query: 'builtin:service.requestCount.total:names', scale: 1 / 60 }, // per minute → per second
  { metric: 'error_rate_pct', target: 'service', query: 'builtin:service.errors.total.rate:names' },
  { metric: 'gc_time_ms', target: 'jvm', query: 'builtin:tech.jvm.memory.gc.suspensionTime:names' },
];

const token = (c: Credentials) => c.apiToken || c.token || c.apiKey || '';
const headers = (c: Credentials) => {
  const t = token(c);
  if (!t) throw new ConnectorError('Dynatrace API token is not configured (credential "apiToken")');
  return { authorization: `Api-Token ${t}`, accept: 'application/json' };
};

/** Picks a Metrics API resolution so the window has ≤ ~600 points (Dynatrace minimum is 1m for most metrics). */
export function dynatraceResolution(fromMs: number, toMs: number) {
  const min = Math.max(1, Math.ceil((toMs - fromMs) / 60000 / 600));
  return `${min}m`;
}

export function parseDynatraceResult(json: any): { labels: Record<string, string>; points: [number, number][] }[] {
  const out: { labels: Record<string, string>; points: [number, number][] }[] = [];
  for (const res of json?.result ?? []) {
    for (const d of res.data ?? []) {
      const labels: Record<string, string> = { metricId: res.metricId, ...(d.dimensionMap ?? {}) };
      // friendly server / service name from the :names transformation
      const hostName = d.dimensionMap?.['dt.entity.host.name'];
      const svcName = d.dimensionMap?.['dt.entity.service.name'];
      if (hostName) labels.host = hostName;
      if (svcName) labels.service = svcName;
      const points: [number, number][] = [];
      (d.timestamps ?? []).forEach((t: number, idx: number) => {
        const v = d.values?.[idx];
        if (v != null && Number.isFinite(Number(v))) points.push([t, Number(v)]);
      });
      out.push({ labels, points });
    }
  }
  return out;
}

export const dynatraceConnector: Connector = {
  type: 'DYNATRACE',
  label: 'Dynatrace',
  category: 'APM',
  authTypes: ['API_KEY', 'TOKEN'],
  fields: [
    { key: 'apiToken', label: 'API token (metrics.read)', required: true, secret: true },
    { key: 'entitySelector', label: 'Entity selector (optional, e.g. type(HOST),tag(perf))', required: false },
  ],
  supportsImport: true,
  docs: 'Imports host, service and JVM metrics for a run window through the Dynatrace Metrics API v2 (GET /api/v2/metrics/query, header "Authorization: Api-Token <token>", scope metrics.read). URL = https://<env-id>.live.dynatrace.com (or the Managed /e/<env-id> URL). config.mappings: [{ metric, target, query: "<metric selector>", scale? }]; optional config.entitySelector narrows entities. Defaults: builtin:host.cpu.usage, builtin:host.mem.usage, builtin:service.response.time (µs→ms), builtin:service.requestCount.total (per minute → per second), builtin:service.errors.total.rate.',
  defaultQueries: () => DEFAULTS,

  async test(i: IntegrationRecord, c: Credentials) {
    return probe(async () => {
      const base = requireUrl(i);
      const r = expectOk(await http(joinUrl(base, '/api/v2/metrics?pageSize=1&fields=displayName'), { headers: headers(c) }), 'Dynatrace Metrics API');
      return { message: `Connected to Dynatrace Metrics API v2; ${r.json?.totalCount ?? 'n/a'} metrics available`, details: { totalCount: r.json?.totalCount } };
    });
  },

  async importRun(i, c, run, queries) {
    const base = requireUrl(i);
    const series: ImportedSeries[] = [];
    const warnings: string[] = [];
    for (const q of queries) {
      try {
        const qs = new URLSearchParams({ metricSelector: q.query, from: String(run.from.getTime()), to: String(run.to.getTime()), resolution: dynatraceResolution(run.from.getTime(), run.to.getTime()) });
        if (i.config?.entitySelector) qs.set('entitySelector', i.config.entitySelector);
        const r = expectOk(await http(joinUrl(base, `/api/v2/metrics/query?${qs}`), { headers: headers(c) }), 'Dynatrace metrics query');
        const rows = parseDynatraceResult(r.json);
        if (!rows.some((s) => s.points.length)) warnings.push(`${q.metric}: no data for '${q.query}' in the run window`);
        for (const s of rows) if (s.points.length) series.push({ query: q, labels: s.labels, points: s.points });
      } catch (e) {
        warnings.push(`${q.metric}: ${(e as Error).message}`);
      }
    }
    return { series, warnings };
  },
};
