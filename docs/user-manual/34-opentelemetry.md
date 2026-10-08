# OpenTelemetry

Perfmon has a **basic** OpenTelemetry receiver: it accepts OTLP **metrics** over **HTTP with JSON encoding** and stores each data point as a generic metric point of a run. This chapter explains exactly what is supported, how to point an OpenTelemetry Collector at Perfmon, how the data is mapped, and which alternatives to use when you need more than the receiver offers.

## What is supported (current version)

| Capability | Status |
|---|---|
| OTLP/HTTP **metrics**, JSON encoding (`POST /api/v1/ingest/otlp/v1/metrics`) | Supported |
| Gauge and Sum data points | Supported: one metric point per data point |
| Histogram data points | Partially: stored as `<name>.count`, `<name>.sum` and `<name>.avg`. Buckets are **not** stored, so no percentiles |
| Summary and Exponential histogram data points | **Not supported**: rejected (counted in `rejectedDataPoints`) |
| OTLP/HTTP with **protobuf** encoding (the default of most exporters) | **Not supported**: set `encoding: json` |
| OTLP/**gRPC** (port 4317) | **Not supported** |
| Traces (`/v1/traces`) and logs (`/v1/logs`) | **Not supported**: there is no endpoint for them |
| Data in Infrastructure, JVM, Database or Applications Monitoring views, SLA, alerts, analysis | **No**: OTLP data is stored as generic metric points only (see [Where the data appears](#where-the-data-appears)) |

If you need OTel-instrumented metrics in the Infrastructure, JVM or Database views, use one of the [alternatives](#alternatives) below.

## Prerequisites

| Item | Requirement |
|---|---|
| Credential | A Perfmon API key with the `ingest` scope (`pmk_...`), sent as `Authorization: Bearer pmk_...` or `X-API-Key: pmk_...`. A user JWT with `INGEST_METRICS` also works but expires |
| Run | Every data point must be correlated to an existing run (see [Run correlation](#run-correlation)) |
| Exporter | An OTLP/HTTP exporter that can send **JSON**, typically the OpenTelemetry Collector's `otlphttp` exporter with `encoding: json` |
| Network | The exporter must reach the Perfmon API (`/api/v1/...`) over HTTP(S) |

Create the key under Platform → **Administration** → **API keys** → **Create key** (scope **ingest**). See [Users, roles & API keys](00e-users-and-api-keys.md).

## Run correlation

Perfmon never stores metrics without a run. For each data point, the run is taken from the first of these attributes it finds (data point attributes and resource attributes are merged, data point wins):

`perfmon.run_id`, `perfmon.runId`, `runId`, `run.id`, `perfmon.run.id`

If none of them is present, the `?runId=<RunID>` query parameter of the request is used. Points without a run are rejected.

Unlike the JMeter ingestion endpoints, the OTLP receiver does **not** check the run status and does not move the run to `RUNNING`. It accepts points for any existing run, including completed ones. Start and complete the run as usual (API or CI pipeline, see [Running Tests](07-running-tests.md)).

## Step-by-step: OpenTelemetry Collector → Perfmon

### Step 1: Create the run and export the variables

```bash
export PERFMON_URL=http://perfmon.example.com:8080
export PERFMON_API_KEY=pmk_0a1b2c3d_REPLACE_ME
export PERFMON_RUN_ID=$(curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/runs" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"project":"payments","application":"merchant-payments","environment":"Performance","test":"200 TPS Payment Load"}' | jq -r .runId)
```

### Step 2: Add a Perfmon exporter to the Collector configuration

Add an `otlphttp` exporter with JSON encoding and a `resource` processor that stamps the Run ID on every metric. Keep your existing receivers and exporters; add a separate metrics pipeline for Perfmon:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch:
    timeout: 10s
  resource/perfmon:
    attributes:
      - key: perfmon.run_id
        value: "${env:PERFMON_RUN_ID}"
        action: upsert

exporters:
  otlphttp/perfmon:
    metrics_endpoint: http://perfmon.example.com:8080/api/v1/ingest/otlp/v1/metrics
    encoding: json
    headers:
      Authorization: "Bearer ${env:PERFMON_API_KEY}"

service:
  pipelines:
    metrics/perfmon:
      receivers: [otlp]
      processors: [resource/perfmon, batch]
      exporters: [otlphttp/perfmon]
```

Use `metrics_endpoint` (the full URL), not `endpoint`: with `endpoint`, the Collector appends `/v1/metrics` to the base URL itself. The same snippet, pre-filled with your Perfmon URL, is available in the UI under Platform → **Integrations** → **Pipelines & snippets** → **OpenTelemetry (OTLP)**.

The Run ID changes with every test. Restart (or reload) the Collector with the new `PERFMON_RUN_ID` for each run, or put the run into the URL instead of a processor: `metrics_endpoint: .../api/v1/ingest/otlp/v1/metrics?runId=PF-2026-10-06-000127`.

### Step 3: Run the test and check the data

Start the test. Then check that the points arrive, using the run's raw data endpoint:

```bash
curl -s "$PERFMON_URL/api/v1/runs/$PERFMON_RUN_ID/raw?table=metric_points&pageSize=5" \
  -H "authorization: Bearer $PERFMON_API_KEY" | jq '{total, metrics, sample: .items[0]}'
```

### Step 4 (optional): Register the OpenTelemetry integration

Adding an **OpenTelemetry (OTLP/HTTP)** entry under Platform → **Integrations** → **Catalog** (category **Observability**, tag **Push**) is optional. It does not change how data is received; it documents the setup and lets you monitor the Collector:

| Field | Purpose |
|---|---|
| **Name**, **Project** | As for every integration |
| **Authentication** | **None** or **Bearer token** (for the health endpoint) |
| **Collector health endpoint (optional, e.g. http://otel-collector:13133/)** | URL of the Collector's `health_check` extension |
| **Token for the health endpoint (optional)** | Sent as `Authorization: Bearer <token>` to the health endpoint |

**Test** then calls the health endpoint and reports `Collector reachable (...)`. Without a health endpoint, the test always succeeds with "Push-based integration: no endpoint to probe."

## Sending OTLP JSON directly (curl or SDK)

The endpoint accepts a standard `ExportMetricsServiceRequest` in OTLP JSON. A minimal example that you can use to test the setup:

```bash
NOW_NS=$(( $(date +%s) * 1000000000 ))
curl -s -X POST "$PERFMON_URL/api/v1/ingest/otlp/v1/metrics?runId=$PERFMON_RUN_ID" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{
  "resourceMetrics": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "checkout" } },
      { "key": "host.name",    "value": { "stringValue": "app01" } } ] },
    "scopeMetrics": [{
      "scope": { "name": "manual-test" },
      "metrics": [
        { "name": "queue.depth", "unit": "{messages}",
          "gauge": { "dataPoints": [ { "asInt": "42", "timeUnixNano": "'"$NOW_NS"'",
                                       "attributes": [ { "key": "queue", "value": { "stringValue": "payments" } } ] } ] } },
        { "name": "http.server.request.duration", "unit": "s",
          "histogram": { "aggregationTemporality": 2,
                         "dataPoints": [ { "count": "120", "sum": 27.6, "timeUnixNano": "'"$NOW_NS"'" } ] } }
      ] }] }] }'
# {}
```

SDKs can export directly if they support the `http/json` OTLP protocol (not all SDKs do; the Java SDK, for example, supports only gRPC and `http/protobuf`). With the standard SDK environment variables:

```bash
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="$PERFMON_URL/api/v1/ingest/otlp/v1/metrics"
export OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20$PERFMON_API_KEY"
export OTEL_RESOURCE_ATTRIBUTES="perfmon.run_id=$PERFMON_RUN_ID"
```

If your SDK cannot send JSON, send to a Collector (any protocol) and let the Collector forward JSON to Perfmon as shown above.

## How OTLP data is mapped

| OTLP element | Stored in Perfmon as |
|---|---|
| `metric.name` | Metric name, unchanged (e.g. `http.server.request.duration`), truncated to 200 characters |
| Gauge / Sum data point | One point: value = `asDouble` or `asInt`, time = `timeUnixNano` (or `startTimeUnixNano`) |
| Sum: temporality, monotonic | Tags `temporality` (`cumulative` or `delta`) and `monotonic` (`true` or `false`). Cumulative values are stored as sent, not converted to rates |
| Histogram data point | Points `<name>.count`, `<name>.sum` and, when `sum` is present and count > 0, `<name>.avg` |
| Resource attributes | Tags on every point (e.g. `service.name`, `host.name`, `deployment.environment`) |
| Data point attributes | Tags (override resource attributes with the same key) |
| `scope.name` | Tag `otel.scope` |
| `metric.unit` | Tag `unit` |

Points are stored with source `otlp`.

## Responses and limits

| Response | Meaning |
|---|---|
| `200 {}` | All data points accepted |
| `200 {"partialSuccess": {"rejectedDataPoints": n, "errorMessage": "…"}}` | Some points were accepted, n were rejected (no run correlation, unknown run, no numeric value, or an unsupported type such as Summary) |
| `400` `No data points could be correlated to a run: add the perfmon.run_id resource attribute or ?runId=<RUN_ID>` | Nothing was accepted because no point had a run |
| `400` `run <id>: Run '<id>' not found` | The Run ID does not exist |
| `400` `run <id>: API key is not authorized for this project` | The key is bound to a different project than the run |
| `401` / `403` | Missing or invalid key, or key without `INGEST_METRICS` |
| `415` or `400` | The body is not JSON (protobuf). Set `encoding: json` |

| Limit | Value |
|---|---|
| Request body | 20 MB |
| `resourceMetrics` per request | 10,000 |
| Rate limit | The per-key ingestion rate limit (`INGEST_RATE_LIMIT_PER_SEC`) is not applied to this endpoint in the current version. Use the Collector's `batch` processor anyway |

## Where the data appears

OTLP points are stored as **generic metric points** of the run. In the current version they are shown only in the run's raw data:

- Run page → **Raw Metrics** tab → select table `metric_points`, then pick a metric from the metric drop-down. Switch to **JSON** to see the tags.
- API: `GET /api/v1/runs/<RunID>/raw?table=metric_points&metric=<name>` (`&format=csv` downloads all matching rows as CSV).

They are **not** used by the Infrastructure, JVM, Database and Applications Monitoring views, dashboards, SLA rules, alerts, bottleneck analysis or the performance score.

## Alternatives

Use these implemented paths when you need OTel-sourced metrics in Perfmon's structured views and analysis:

| Goal | Recommended path | Chapter |
|---|---|---|
| Host CPU, memory, disk, network in the Infrastructure view | Perfmon Collector on the hosts, or `POST /api/v1/ingest/infrastructure` (`server` object + `metrics` array) | [Infrastructure Monitoring](17-infrastructure-monitoring.md) |
| JVM heap, GC, threads in the JVM view | `POST /api/v1/ingest/infrastructure` with the `jvm` array, from your own exporter | [JVM Monitoring](18-jvm-monitoring.md) |
| Database connections and latency | `POST /api/v1/ingest/infrastructure` with the `database` array, or a Prometheus exporter + import | [Database Monitoring](19-database-monitoring.md) |
| Service request rate, errors, latency in Applications Monitoring | `POST /api/v1/ingest/infrastructure` with a `service` object and the `serviceMetrics` array | [Infrastructure Monitoring](17-infrastructure-monitoring.md) |
| Metrics your OTel Collector already sends to Prometheus | Add the Collector's Prometheus exporter (or remote write) to your Prometheus, then use the **Prometheus integration** to import them into the run with PromQL mappings to Perfmon metric names (`cpu_pct`, `heap_used_mb`, `request_rate`, ...) | [Prometheus Integration](32-prometheus-integration.md) |
| Services monitored by Dynatrace | Dynatrace integration import | [Dynatrace Integration](33-dynatrace-integration.md) |
| Custom business metrics (queue depth, cache hit rate) as tagged points | `POST /api/v1/metrics` with `{"runId", "metric", "value", "ts", "tags"}` items, or InfluxDB line protocol to `/api/v1/ingest/influx/write?runId=<RunID>` (any measurement other than `jmeter` is stored as `<measurement>.<field>` points) | [JMeter Integration](09-jmeter-integration.md#multi-run-and-dimensional-data-post-apiv1metrics) |

The Prometheus route is the closest replacement for OTel-native ingestion today: the Collector does the collection, Prometheus keeps the history, and Perfmon imports exactly the run window into its structured metric model.

## Related chapters

- [Prometheus Integration](32-prometheus-integration.md)
- [Dynatrace Integration](33-dynatrace-integration.md)
- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [JVM Monitoring](18-jvm-monitoring.md)
- [Server Monitoring](00d-server-monitoring.md)
- [Users, roles & API keys](00e-users-and-api-keys.md)
