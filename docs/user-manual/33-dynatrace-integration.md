# Dynatrace Integration

If the system under test is monitored by Dynatrace, Perfmon can pull host, service and JVM metrics for a run's time window through the **Dynatrace Metrics API v2** and store them with the run. The imported data appears in the run's Infrastructure and JVM views and in Applications Monitoring, and it feeds the analysis (bottlenecks, capacity, performance score) like data from the Perfmon Collector.

The Dynatrace connector is **import only**: Perfmon queries Dynatrace when you click **Import** or call the import API. It does not stream Dynatrace data during the test, and it does not push anything to Dynatrace.

## How it works

1. You add a Dynatrace integration once: environment URL and an API token with the `metrics.read` scope.
2. After (or during) a test, you start an **Import** for a run.
3. For each **metric mapping** (a Dynatrace metric selector mapped to a Perfmon metric), Perfmon calls `GET <environment>/api/v2/metrics/query` for the run's window with the header `Authorization: Api-Token <token>`.
4. Each returned series is assigned to a server or service and stored with the Run ID. Completed runs are re-analyzed.

## Prerequisites

| Item | Requirement |
|---|---|
| Dynatrace environment | SaaS `https://<env-id>.live.dynatrace.com`, or Managed `https://<your-domain>/e/<env-id>`, reachable **from the Perfmon server** |
| API token | Scope **Read metrics** (`metrics.read`) |
| Permission to configure | `MANAGE_INTEGRATIONS` (Admin and SRE roles by default) |
| Permission to import | `MANAGE_INTEGRATIONS` **or** `INGEST_METRICS` |
| Run | The run must have started. Runs that are not finished yet are imported up to "now" |

## Step-by-step setup

### Step 1: Create the API token in Dynatrace

In Dynatrace, open **Access tokens**, choose **Generate new token**, name it (for example `perfmon-metrics-read`) and add the scope **Read metrics** (`metrics.read`). Copy the token; Dynatrace shows it only once. Perfmon needs no other scope.

### Step 2: Add the integration in Perfmon

Go to Platform → **Integrations** (`/integrations`) → **Add integration**. In the **Catalog**, Dynatrace is listed under **APM** with an **Import** tag. Click **Add** and fill in:

| Field | Value | Notes |
|---|---|---|
| **Name** | e.g. `Dynatrace Production` | Up to 120 characters |
| **Project** | **All projects** or one project | A project-bound integration can only import into runs of that project |
| **URL** | `https://abc12345.live.dynatrace.com` | The environment URL without `/api/v2`. Managed: include `/e/<env-id>` |
| **Authentication** | **API key** (default) or **Bearer token** | Both send the token as `Authorization: Api-Token <token>`; the choice makes no difference for Dynatrace |
| **Entity selector (optional, e.g. type(HOST),tag(perf))** | e.g. `type(HOST),tag(perf)` | Passed as `entitySelector` with **every** query of this integration, to limit the data to the test environment |
| **API token (metrics.read)** | the token | Required. Encrypted at rest (AES-256-GCM), never returned by the API |
| **Metric mappings (optional)** | JSON array | Empty = connector defaults. **Start from defaults** fills in the defaults for editing |

Click **Add integration**.

> Because the entity selector is applied to every mapping, it must suit all of them. A host selector such as `type(HOST),tag(perf)` does not fit service metrics. If you need different entity filters, leave the field empty and put the filter into each metric selector instead (for example with `:filter(...)`), or create two integrations.

### Step 3: Test the connection

Click **Test** on the integration row. Perfmon calls `GET /api/v2/metrics?pageSize=1&fields=displayName` (10-second timeout). A healthy result:

```text
Connected to Dynatrace Metrics API v2; 2873 metrics available
```

Health is set to `HEALTHY` (3 seconds or less), `DEGRADED` (slower) or `DOWN` (failed, with the error shown on the warning icon).

### Step 4: Import metrics for a run

1. Click **Import** on the integration row (disabled while the integration is disabled).
2. **Run**: pick one of the 100 most recently started runs.
3. **Queries**: **Connector defaults**, **Configured mappings**, or **Custom** (the query column is labeled **Metric selector**).
4. Click **Import**.

The result lists the points imported, the number of series, the servers and services the data was assigned to, and warnings for any selector that returned no data or failed.

## Default mappings

| Target | Perfmon metric | Metric selector | Scale |
|---|---|---|---|
| server | `cpu_pct` | `builtin:host.cpu.usage:names` | — |
| server | `memory_pct` | `builtin:host.mem.usage:names` | — |
| service | `avg_latency_ms` | `builtin:service.response.time:names` | `0.001` (µs → ms) |
| service | `request_rate` | `builtin:service.requestCount.total:names` | `1/60` (per minute → per second) |
| service | `error_rate_pct` | `builtin:service.errors.total.rate:names` | — |
| jvm | `gc_time_ms` | `builtin:tech.jvm.memory.gc.suspensionTime:names` | — |

The `:names` transformation adds the entity's display name to the result. Perfmon uses it to name servers and services:

| Dimension returned by Dynatrace | Used as |
|---|---|
| `dt.entity.host.name` | Server name (registered automatically in the run's project and environment) |
| `dt.entity.service.name` | Service name (registered automatically) |

A series that has neither a host nor a service name (for example a metric whose only dimension is a process group instance) cannot be assigned. It is skipped with the warning `could not map series to a server or service — skipped` (or `series without a host/instance label and no serverName` / `series without a service label and no serviceName` for server and service targets). Set `serverName` or `serviceName` in the mapping in that case. This can apply to the default `gc_time_ms` mapping, depending on the dimensions your environment returns.

## Writing your own mappings

Mappings use the same format as the other import connectors: `metric`, `query` (here: a Dynatrace metric selector), `target` (`server`, `jvm`, `database`, `service`, `custom`), and optionally `serverName`, `serviceName`, `scale`, `transform` (`invert_pct`) and `role`. The Perfmon metric names per target and the server/service assignment rules are listed in [Prometheus Integration → Metric mappings](32-prometheus-integration.md#metric-mappings).

Mind the Dynatrace units and use `scale` to convert them:

| Dynatrace unit | Perfmon unit | `scale` |
|---|---|---|
| Microseconds | ms | `0.001` |
| Count per minute | per second | `0.016666666666666666` |
| Bytes | MB | `0.00000095367431640625` |
| Percent | % | none |

Example mapping set:

```json
[
  { "metric": "cpu_pct",        "target": "server",  "query": "builtin:host.cpu.usage:names" },
  { "metric": "memory_pct",     "target": "server",  "query": "builtin:host.mem.usage:names" },
  { "metric": "avg_latency_ms", "target": "service", "query": "builtin:service.response.time:names", "scale": 0.001 },
  { "metric": "request_rate",   "target": "service", "query": "builtin:service.requestCount.total:names", "scale": 0.016666666666666666 },
  { "metric": "error_rate_pct", "target": "service", "query": "builtin:service.errors.total.rate:names" },
  { "metric": "gc_time_ms",     "target": "jvm",     "query": "builtin:tech.jvm.memory.gc.suspensionTime:names", "serverName": "app01" }
]
```

Check every selector in Dynatrace's **Data Explorer** for the test's time range before you rely on it; metric keys and dimensions vary between Dynatrace versions and technologies.

## Import window and resolution

| Aspect | Behavior |
|---|---|
| Window | Run start → run end (or now while the run is not finished); `from` and `to` are sent as epoch milliseconds |
| Resolution | `<n>m`, where n = run duration in minutes / 600, rounded up, minimum `1m`. Short runs therefore get 1-minute points |
| Points kept | Only points from 1 minute before the start to 1 minute after the end. Empty values are dropped |
| Timeout | 10 seconds per request |
| Re-import | Replaces the earlier Dynatrace import of the same run |
| Finished runs | `COMPLETED`, `FAILED` and `ABORTED` runs are re-analyzed after an import that stored data |

Because Dynatrace's finest resolution for most metrics is 1 minute, very short tests (a few minutes) produce only a few points per series. For detailed per-second server metrics during short tests, use the Perfmon Collector instead (see [Infrastructure Monitoring](17-infrastructure-monitoring.md)).

## REST API

The integration endpoints are the same for every connector; see [Prometheus Integration → REST API](32-prometheus-integration.md#rest-api) for the full list. Dynatrace-specific values:

| Field | Value |
|---|---|
| `type` | `DYNATRACE` |
| `authType` | `API_KEY` or `TOKEN` |
| `credentials.apiToken` | The Dynatrace token (`token` and `apiKey` are accepted as alternative credential names) |
| `config.entitySelector` | Optional entity selector |
| `config.mappings` | Optional mappings |

Create the integration (user JWT with `MANAGE_INTEGRATIONS`):

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/integrations" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "Dynatrace Production",
    "type": "DYNATRACE",
    "url": "https://abc12345.live.dynatrace.com",
    "authType": "API_KEY",
    "credentials": { "apiToken": "dt0c01.REPLACE_ME" },
    "config": { "entitySelector": "type(HOST),tag(perf)" }
  }' | jq '{id, health, credentialKeys}'
```

Import into a run (an API key with the `ingest` scope is enough):

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/integrations/<integration-id>/import" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\",\"queries\":[{\"metric\":\"cpu_pct\",\"target\":\"server\",\"query\":\"builtin:host.cpu.usage:names\"}]}" \
  | jq '{imported, series, servers, warnings}'
```

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `Dynatrace API token is not configured (credential "apiToken")` | Enter the token in **API token (metrics.read)** and save |
| `Dynatrace Metrics API: authentication failed (HTTP 401) — check the credentials` | Token is wrong, expired or revoked |
| `Dynatrace Metrics API: authentication failed (HTTP 403) — check the credentials` | Token lacks the `metrics.read` scope |
| `Dynatrace Metrics API: endpoint not found (HTTP 404) — check the URL` | URL is not the environment root. SaaS: `https://<env-id>.live.dynatrace.com`. Managed: `https://<domain>/e/<env-id>` |
| `<metric>: no data for '<selector>' in the run window` | Wrong selector, an entity selector that excludes the entities, or no data in that period. Check in Data Explorer |
| `Dynatrace metrics query: HTTP 400 — …` | Invalid metric selector or entity selector syntax; the message from Dynatrace follows the dash |
| `Connection timed out after 10s` / `Host not found (DNS lookup failed)` | The Perfmon server cannot reach Dynatrace (proxy, firewall or DNS) |
| `Integration is bound to a different project than the run` | Pick a run of the integration's project, or set the integration's project to **All projects** |

## Related chapters

- [Prometheus Integration](32-prometheus-integration.md)
- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [JVM Monitoring](18-jvm-monitoring.md)
- [OpenTelemetry](34-opentelemetry.md)
- [Users, roles & API keys](00e-users-and-api-keys.md)
