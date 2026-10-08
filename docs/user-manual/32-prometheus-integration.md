# Prometheus Integration

If your servers and applications are already scraped by Prometheus (node_exporter, Micrometer, JMX exporter, postgres_exporter, ...), you do not need to install the Perfmon Collector on them. A Prometheus integration lets Perfmon run PromQL range queries for a run's execution window and store the results as server, JVM, database and service metrics of that run. The imported metrics then appear in the run's Infrastructure, JVM and Database tabs and are used by the analysis (bottlenecks, capacity, performance score), exactly like Collector data.

The integration is **pull, after the fact**: Perfmon queries Prometheus when you click **Import** (or call the API). It does not scrape exporters itself, and it does not stream Prometheus data live during the test.

## How it works

```text
 node_exporter / Micrometer / exporters ──scrape──► Prometheus
                                                        ▲
             Perfmon ── GET /api/v1/query_range ────────┘   (one query per mapping, run window)
                │
                └─► server_metrics / jvm_metrics / database_metrics / service_metrics  (tagged with the Run ID)
```

1. You add a Prometheus integration once (URL plus optional credentials).
2. After (or during) a test, you start an **Import** for a run.
3. For each **metric mapping** (a PromQL expression mapped to a Perfmon metric name), Perfmon calls `GET <prometheus>/api/v1/query_range` from the run's start to its end (or to now if the run is still running).
4. Each returned series is assigned to a server or service from its labels and stored with the Run ID. Completed runs are re-analyzed automatically.

## Prerequisites

| Item | Requirement |
|---|---|
| Prometheus | Reachable **from the Perfmon server** (not from your browser) over HTTP(S), Prometheus HTTP API v1 |
| Credentials | None, a bearer token, or basic-auth user and password, depending on how Prometheus is exposed |
| Permission to configure | `MANAGE_INTEGRATIONS` (Admin and SRE roles by default) |
| Permission to import | `MANAGE_INTEGRATIONS` **or** `INGEST_METRICS` (so an API key with the `ingest` scope can import from CI) |
| Run | The run must have started (it needs a start time). Runs that are not finished yet are imported up to "now" |

## Step-by-step setup

### Step 1: Open the catalog

Go to Platform → **Integrations** (`/integrations`) and click **Add integration**. The **Catalog** tab opens. Prometheus is listed under **Metrics** with an **Import** tag. Click **Docs** on the card to read the connector summary, or **Add** to configure it.

### Step 2: Fill in the form

| Field | Value | Notes |
|---|---|---|
| **Name** | e.g. `Team Prometheus` | Up to 120 characters |
| **Project** | **All projects** or one project | Empty = available to every project. A project-bound integration can only import into runs of that project |
| **URL** | e.g. `http://prometheus:9090` | Base URL as reachable from the Perfmon server, without `/api/v1`. Must start with `http://` or `https://` |
| **Authentication** | **None**, **Bearer token** or **Basic auth** | |
| **Bearer token** | the token | Used when Authentication is **Bearer token** (`Authorization: Bearer <token>`) |
| **Username (basic auth)** / **Password (basic auth)** | user and password | Used when Authentication is **Basic auth** |
| **Metric mappings (optional)** | JSON array | Empty = connector defaults (see below). **Start from defaults** fills the box with the default mappings so you can edit them |
| **Enabled** | on | Disabled integrations cannot be imported from |

The credential fields are shown only when Authentication is not **None**. Credentials are write-only: they are encrypted at rest (AES-256-GCM) and never returned by the API. When you edit the integration later, leave a stored value untouched to keep it.

Click **Add integration**.

### Step 3: Test the connection

Click **Test** on the integration row. Perfmon calls `GET /api/v1/status/buildinfo` and `GET /api/v1/query?query=up` with a 10-second timeout. A healthy result looks like:

```text
Connected to Prometheus 2.53.0; 42 scrape target(s) report 'up'
```

The **Health** column is then updated:

| Health | Meaning |
|---|---|
| `HEALTHY` | Test succeeded in 3 seconds or less |
| `DEGRADED` | Test succeeded but took more than 3 seconds |
| `DOWN` | Test failed. Hover over the warning icon to see the last error |
| `UNKNOWN` | Not tested since it was created or since the URL, authentication or credentials changed |

The results of tests in the current browser session are also listed in the **Connection tests (this session)** card.

### Step 4: Import metrics for a run

1. Click **Import** on the integration row. (The button is disabled while the integration is disabled.)
2. **Run**: pick a run. The list shows the 100 most recently started runs (of the integration's project, if it is bound to one).
3. **Queries**: keep **Connector defaults** (or **Configured mappings**, if the integration has mappings), or choose **Custom** to edit the queries for this import only.
4. Click **Import**.

The result shows the number of points imported, the number of series, the window and step used, the servers and services the data was assigned to, and any warnings. Open the run's **Infrastructure**, **JVM** or **Database** tab to see the data.

## Default mappings

When neither the import request nor the integration defines mappings, these defaults are used. They cover node_exporter and Micrometer (Spring Boot Actuator) metric names:

| Target | Perfmon metric | PromQL |
|---|---|---|
| server | `cpu_pct` | `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)` |
| server | `memory_pct` | `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100` |
| server | `load_avg_1m` | `node_load1` |
| jvm | `heap_used_mb` | `sum by (instance) (jvm_memory_used_bytes{area="heap"}) / 1048576` |
| jvm | `heap_max_mb` | `sum by (instance) (jvm_memory_max_bytes{area="heap"}) / 1048576` |
| jvm | `gc_max_pause_ms` | `max by (instance) (jvm_gc_pause_seconds_max) * 1000` |
| jvm | `thread_count` | `sum by (instance) (jvm_threads_live_threads)` |
| service | `request_rate` | `sum by (application) (rate(http_server_requests_seconds_count[1m]))` |

If your exporters use different metric or label names, write your own mappings.

## Metric mappings

A mapping turns one PromQL expression into one Perfmon metric. Mappings are stored in the integration (`config.mappings`, up to 200) or sent with a single import (`queries`, up to 100).

| Field | Required | Description |
|---|---|---|
| `metric` | Yes | Perfmon metric name (see the table below). Any name is allowed for `custom` |
| `query` | Yes | PromQL expression (up to 5000 characters) |
| `target` | Yes | `server`, `jvm`, `database`, `service` or `custom` |
| `serverName` | No | Fixed server name. Otherwise taken from the series labels |
| `serviceName` | No | Fixed service or database name. Otherwise taken from the series labels |
| `scale` | No | Multiplies every value, for unit conversion (e.g. `0.000000954` for bytes → MB) |
| `transform` | No | `invert_pct`: stores `100 - value` (e.g. CPU idle % → CPU used %). Applied before `scale` |
| `role` | No | Role given to a server that is registered by the import (e.g. `app`, `db`, `loadgen`). Default: `db` for the `database` target, `app` otherwise. Not shown in the import dialog; set it in the JSON |

Perfmon metrics per target (the **Perfmon metric** drop-down in the Custom import table shows the same lists):

| Target | Perfmon metrics |
|---|---|
| server | `cpu_pct`, `memory_pct`, `memory_used_mb`, `disk_pct`, `disk_read_bps`, `disk_write_bps`, `net_in_bps`, `net_out_bps`, `load_avg_1m`, `processes`, `tcp_connections`, `file_descriptors` |
| jvm | `heap_used_mb`, `heap_committed_mb`, `heap_max_mb`, `nonheap_used_mb`, `gc_count`, `gc_time_ms`, `gc_max_pause_ms` (alias `gc_pause_ms`), `thread_count` (alias `threads`), `peak_threads`, `classes_loaded` |
| database | `connections`, `active_connections` (alias `db_connections`), `max_connections`, `query_latency_ms` (alias `db_latency_ms`), `slow_queries`, `locks`, `deadlocks`, `cpu_pct`, `memory_pct`, `transactions_per_sec` |
| service | `request_rate`, `error_rate_pct`, `avg_latency_ms`, `p95_latency_ms`, `exceptions`, `cpu_pct`, `memory_pct` |
| custom | Any name. Stored as generic metric points with the series labels as tags |

A mapping with a metric name that is not in the list for its target is stored as a custom metric point, and the import returns the warning `<metric>: not a known <target> metric — stored as a custom metric point`.

### How series are assigned to servers and services

| Target | Server | Service |
|---|---|---|
| server | Required | — |
| jvm | From labels (if present) | From labels (if present); at least one of the two is required |
| database | From labels (if present) | From labels; falls back to the server name |
| service | — | Required |

- **Server name**: `serverName`, otherwise the first of these labels: `host`, `hostname`, `host.name`, `dt.entity.host.name`, `instance`, `node`, `server`. A port suffix is removed (`app01:9100` → `app01`). Unknown servers are registered automatically in the run's project and environment.
- **Service name**: `serviceName`, otherwise the first of the labels `service`, `service.name`, `application`, `job`. Unknown services are registered automatically.
- Keep the label you need in the result. `sum by (instance) (...)` keeps `instance`; a bare `sum(...)` drops all labels, so the series is skipped (warning `series without a host/instance label and no serverName — skipped`) unless you set `serverName`.

Make sure the server names match the names the Collector uses (if you use both), otherwise the same machine appears twice.

### Example: complete mapping set

```json
[
  { "metric": "cpu_pct",    "target": "server", "query": "100 - (avg by (instance) (rate(node_cpu_seconds_total{mode=\"idle\"}[1m])) * 100)" },
  { "metric": "memory_pct", "target": "server", "query": "(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100" },
  { "metric": "disk_pct",   "target": "server", "query": "(1 - node_filesystem_avail_bytes{mountpoint=\"/\"} / node_filesystem_size_bytes{mountpoint=\"/\"}) * 100" },
  { "metric": "net_in_bps", "target": "server", "query": "sum by (instance) (rate(node_network_receive_bytes_total{device!=\"lo\"}[1m]))" },
  { "metric": "cpu_pct",    "target": "server", "query": "100 - (avg by (instance) (rate(node_cpu_seconds_total{mode=\"idle\",instance=~\"lg.*\"}[1m])) * 100)", "role": "loadgen" },
  { "metric": "heap_used_mb", "target": "jvm", "query": "sum by (instance) (jvm_memory_used_bytes{area=\"heap\"})", "scale": 0.00000095367431640625 },
  { "metric": "gc_max_pause_ms", "target": "jvm", "query": "max by (instance) (jvm_gc_pause_seconds_max) * 1000" },
  { "metric": "active_connections", "target": "database", "query": "sum by (instance) (pg_stat_activity_count{state=\"active\"})", "serviceName": "orders-db" },
  { "metric": "p95_latency_ms", "target": "service", "query": "histogram_quantile(0.95, sum by (application, le) (rate(http_server_requests_seconds_bucket[1m]))) * 1000" },
  { "metric": "queue_depth", "target": "custom", "query": "sum by (queue) (rabbitmq_queue_messages)" }
]
```

The non-default exporter metrics in this example (`node_filesystem_*`, `pg_stat_activity_count`, `http_server_requests_seconds_bucket`, `rabbitmq_queue_messages`) are common names. Check them against your own exporters in the Prometheus UI before you use them. The `role: loadgen` entry is a pattern for load generator machines: load generators are excluded from system-under-test aggregates (see [Server roles](17-infrastructure-monitoring.md#server-roles)). Note that `role` is only applied to a server that does not have a role yet.

## Import window, step and re-import

| Aspect | Behavior |
|---|---|
| Window | Run start → run end. While the run is not finished: run start → now. The run must have a start time (`Run … has not started yet — nothing to import`) |
| Step | The smallest of 5, 10, 15, 30, 60, 120, 300 or 600 seconds that gives at most 600 points per series; 900 seconds for very long runs |
| Points kept | Only points between 1 minute before the start and 1 minute after the end |
| Timeout | 10 seconds per HTTP request to Prometheus |
| Re-import | Replaces the previous Prometheus import of the same run. Importing twice is safe |
| Finished runs | Runs that are `COMPLETED`, `FAILED` or `ABORTED` are re-analyzed after an import that stored data |
| Partial failures | A failing query does not stop the others. Each failure becomes a warning, e.g. `heap_used_mb: query returned no series in the run window` or `cpu_pct: Prometheus error: …` |

Health after an import: `DOWN` if no query returned any series and every query produced a warning, otherwise `HEALTHY`.

Deleting an integration destroys its stored credentials. Metrics already imported into runs are kept.

## REST API

All endpoints are under `/api/v1`. Creating, editing, deleting and testing integrations need `MANAGE_INTEGRATIONS`. API keys cannot have this permission (their scopes are `ingest` and `read`), so use a user JWT from `POST /api/v1/auth/login` for those calls.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| GET | `/integrations/types` | `VIEW_PROJECT` | Catalog: fields, auth types, docs and `defaultMappings` per type |
| GET | `/integrations?type=PROMETHEUS&projectId=` | `VIEW_PROJECT` | Configured integrations (secrets are never returned; `credentialKeys` lists the names that are stored) |
| GET | `/integrations/:id` | `VIEW_PROJECT` | One integration |
| POST | `/integrations` | `MANAGE_INTEGRATIONS` | Create |
| PATCH | `/integrations/:id` | `MANAGE_INTEGRATIONS` | Update. `config` is replaced as a whole; credentials: the keys you send are replaced, `null` removes a key |
| DELETE | `/integrations/:id` | `MANAGE_INTEGRATIONS` | Delete (imported metrics are kept) |
| POST | `/integrations/:id/test` | `MANAGE_INTEGRATIONS` | Connection test, updates health |
| POST | `/integrations/:id/import` | `MANAGE_INTEGRATIONS` or `INGEST_METRICS` | Import for a run: `{ "runId": "...", "queries": [ ... ] }` (`queries` optional, up to 100) |

Create a Prometheus integration with a bearer token and two mappings:

```bash
TOKEN=$(curl -s -X POST "$PERFMON_URL/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"email":"sre@example.com","password":"…"}' | jq -r .token)

curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/integrations" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "Team Prometheus",
    "type": "PROMETHEUS",
    "url": "http://prometheus:9090",
    "authType": "TOKEN",
    "credentials": { "token": "REPLACE_ME" },
    "config": { "mappings": [
      { "metric": "cpu_pct", "target": "server", "query": "100 - (avg by (instance) (rate(node_cpu_seconds_total{mode=\"idle\"}[1m])) * 100)" },
      { "metric": "heap_used_mb", "target": "jvm", "query": "sum by (instance) (jvm_memory_used_bytes{area=\"heap\"}) / 1048576" }
    ] }
  }' | jq '{id, health, credentialKeys}'
```

For basic authentication use `"authType": "BASIC", "credentials": {"username": "…", "password": "…"}`. Secrets must be sent in `credentials`; a request that puts `token`, `password`, `apiKey` or similar keys into `config` is rejected with `400`.

Test it:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/integrations/<integration-id>/test" -H "authorization: Bearer $TOKEN"
# {"ok":true,"latencyMs":38,"message":"Connected to Prometheus 2.53.0; 42 scrape target(s) report 'up'","details":{…},"health":"HEALTHY"}
```

Import into a run from a CI pipeline, after the run is completed (an API key with the `ingest` scope is enough):

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/integrations/<integration-id>/import" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\"}" | jq '{imported, series, servers, services, warnings}'
# {"imported":4312,"series":9,"servers":["app01","app02","db01"],"services":["merchant-payments"],"warnings":[]}
```

Find the integration ID with `GET /api/v1/integrations?type=PROMETHEUS` (field `id`).

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `Prometheus buildinfo: authentication failed (HTTP 401) — check the credentials` | Wrong token or user/password, or wrong Authentication type |
| `Prometheus buildinfo: endpoint not found (HTTP 404) — check the URL` | The URL includes a path that is not the Prometheus root (e.g. `/graph`), or a reverse proxy uses a prefix you did not include |
| `Connection refused …` / `Host not found (DNS lookup failed)` / `Connection timed out after 10s` | Prometheus is not reachable **from the Perfmon server**. In Docker, use the service name (`http://prometheus:9090`), not `localhost` |
| `Integration is disabled` | Enable the integration (toggle in the row) |
| `Integration is bound to a different project than the run` | Pick a run of the integration's project, or set the integration's project to **All projects** |
| `…: query returned no series in the run window` | The metric did not exist during the run, or a label filter does not match. Test the query in the Prometheus UI for the same time range |
| `…: series without a host/instance label and no serverName — skipped` | Keep `instance` in the result (`by (instance)`) or set `serverName` |
| Data imported but the same host appears twice | Prometheus uses a different host name than the Collector. Set `serverName` in the mapping |

## Related chapters

- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [JVM Monitoring](18-jvm-monitoring.md)
- [Database Monitoring](19-database-monitoring.md)
- [InfluxDB (optional)](00c-influxdb-setup.md)
- [Dynatrace Integration](33-dynatrace-integration.md)
- [OpenTelemetry](34-opentelemetry.md)
- [Users, roles & API keys](00e-users-and-api-keys.md)
