import { config } from '../../config.js';
import type { Connector } from './types.js';
import { authHeaders, expectOk, http, probe } from './http.js';

/**
 * OpenTelemetry (push).
 *
 * OTLP → Perfmon mapping (POST /api/v1/ingest/otlp/v1/metrics, OTLP/HTTP JSON encoding):
 *
 *   resourceMetrics[].resource.attributes   → tags on every point (service.name, host.name, deployment.environment, ...)
 *   scopeMetrics[].scope.name               → tag "otel.scope"
 *   metric.name                             → metric_points.metric (unchanged, e.g. "http.server.request.duration")
 *   metric.unit                             → tag "unit"
 *   gauge.dataPoints[] / sum.dataPoints[]   → one metric_points row each: value = asDouble ?? asInt, ts = timeUnixNano
 *                                             (sum: tag "temporality" = cumulative|delta, "monotonic" = true|false)
 *   histogram.dataPoints[]                  → "<name>.count", "<name>.sum" and "<name>.avg" points
 *   dataPoint.attributes                    → merged into tags (data point wins over resource)
 *   Run correlation (required)              → attribute "perfmon.run_id" | "perfmon.runId" | "runId" | "run.id" on the
 *                                             data point or resource, or the ?runId=<RUN_ID> query parameter.
 *                                             Points without a resolvable run are rejected (partialSuccess).
 *
 * Authenticate with an API key ("Authorization: Bearer pmk_..." or "X-API-Key") with the ingest scope.
 * OTLP/HTTP protobuf is not accepted — configure the exporter with `encoding: json` (collector otlphttp exporter).
 */
export const OTLP_RUN_ATTRIBUTES = ['perfmon.run_id', 'perfmon.runId', 'runId', 'run.id', 'perfmon.run.id'];

export const opentelemetryConnector: Connector = {
  type: 'OPENTELEMETRY',
  label: 'OpenTelemetry (OTLP/HTTP)',
  category: 'OBSERVABILITY',
  authTypes: ['NONE', 'TOKEN'],
  fields: [
    { key: 'healthUrl', label: 'Collector health endpoint (optional, e.g. http://otel-collector:13133/)', required: false },
    { key: 'token', label: 'Token for the health endpoint (optional)', required: false, secret: true },
  ],
  supportsImport: false,
  docs: `Push-based. Point an OpenTelemetry Collector "otlphttp" exporter (encoding: json) or SDK OTLP/HTTP JSON exporter at ${config.publicUrl.replace(/\/$/, '')}/api/v1/ingest/otlp/v1/metrics?runId=<RUN_ID> with header "Authorization: Bearer <pmk_ API key>". Mapping: gauge and sum data points become Perfmon metric points (metric = OTel metric name, value = asDouble/asInt, time = timeUnixNano); histogram points become <name>.count/.sum/.avg; resource attributes + data-point attributes become tags; the run is taken from the attribute perfmon.run_id (or runId / run.id) or the ?runId= parameter — points without a run are rejected. The connection test checks the optional collector health endpoint.`,

  async test(i, c) {
    const url = (i.config?.healthUrl || i.url || '').trim();
    if (!url) return { ok: true, latencyMs: 0, message: 'Push-based integration: no endpoint to probe. Send OTLP/HTTP JSON metrics to /api/v1/ingest/otlp/v1/metrics.' };
    return probe(async () => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Health URL must be http(s)');
      const r = expectOk(await http(url, { headers: authHeaders(i, c) }), 'OpenTelemetry Collector health');
      return { message: `Collector reachable (${r.json?.status ?? `HTTP ${r.status}`})`, details: r.json ?? undefined };
    });
  },
};
