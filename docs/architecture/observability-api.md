# Observability API contract (time-window monitoring)

Shared contract between the backend (`backend/src/observability/`) and the frontend
(`frontend/src/components/observability/`, Observability pages). All endpoints are under
`/api/v1`, require `VIEW_PROJECT`, and are scoped to the caller's organization.

## Conventions

- **Time**: `from` / `to` are ISO-8601 instants with timezone (`2026-10-12T09:15:00Z`), minute
  precision or finer (epoch ms also accepted; ISO without timezone → 400). Default window: last hour.
  Window is `[from, to)` (inclusive start, exclusive end). Stored and returned in UTC; the UI displays
  local time or UTC. Responses echo the effective `from`, `to` and `stepSec`.
- **Step**: `step=auto` (default) picks the smallest of 10, 15, 30, 60, 120, 300, 600, 900, 1800,
  3600, 21600, 86400 seconds that keeps ≤ 600 points per series; an explicit `step` (seconds,
  ≥ 10) is honoured but raised if it would exceed 2 000 points. Buckets are aligned to
  `floor(epoch / step) * step`.
- **Aggregation** within a bucket: `agg=avg|min|max|sum|p95|last` (default `avg`).
- **Filters** (all optional, comma-separated lists = OR within a filter, AND across filters):
  `projectId`, `environmentId`, `applicationId`, `runId`, `hostId`, `serviceId`,
  `databaseId`, `cluster` (Kubernetes connection id), `namespace`, `workload`, `pod`, `node`,
  `role` (host role, case-insensitive, e.g. `role=loadgen` or `role=app,db`; applies to hosts and to
  databases / JVMs / services through the host they run on).
  A filter that does not apply to an entity type is ignored for that type (e.g. `namespace` does not
  restrict hosts). Kubernetes connections without a project stay visible under a `projectId` filter.
- **Errors** use the standard envelope `{ timestamp, status, error, message, path }`.
  A window larger than 90 days → 400.

## GET /observability/inventory

Entities that reported data in the window (or exist in the inventory), for the filter pickers.

```json
{
  "from": "…", "to": "…",
  "hosts":     [{ "id": "uuid", "name": "app-01", "role": "app|db|loadgen|…|null", "hostname": "…|null", "environmentId": "uuid|null", "projectId": "uuid", "lastSeen": "ISO|null", "hasJvm": false }],
  "databases": [{ "id": "uuid", "name": "orders-db", "engine": "postgres|mysql|…|null", "hostId": "uuid|null", "lastSeen": "ISO|null" }],
  "services":  [{ "id": "uuid", "name": "checkout-svc", "kind": "service|jvm", "serviceKind": "service|gateway|…", "hostId": "uuid|null", "hasJvm": true, "lastSeen": "ISO|null" }],
  "kubernetes": {
    "clusters":   [{ "id": "integration-uuid", "name": "prod-eks" }],
    "namespaces": [{ "cluster": "id", "name": "shop" }],
    "workloads":  [{ "cluster": "id", "namespace": "shop", "name": "web", "kind": "Deployment" }],
    "pods":       [{ "cluster": "id", "namespace": "shop", "name": "web-7d9…", "workload": "web", "node": "n1" }],
    "nodes":      [{ "cluster": "id", "name": "n1" }]
  },
  "runs": [{ "id": "uuid", "runKey": "PF-…", "testName": "…", "startedAt": "ISO", "endedAt": "ISO|null", "status": "…", "environmentId": "uuid", "projectId": "uuid" }],
  "metrics": [{ "key": "host.cpu_pct", "label": "CPU", "unit": "%", "entity": "host", "hasData": true }]
}
```

## Metric catalogue (`metrics[].key`)

| entity | keys (unit) |
|---|---|
| host | `host.cpu_pct` (%), `host.memory_pct` (%), `host.memory_used_mb` (MB), `host.disk_pct` (%), `host.load_1m`, `host.net_rx_kbps` / `host.net_tx_kbps` (KB/s) |
| database | `db.query_latency_ms` (ms), `db.connections_active`, `db.pool_pct` (%), `db.slow_queries`, `db.locks`, `db.deadlocks`, `db.tps` (tx/s), `db.cpu_pct` (%) |
| service | `svc.request_rate` (req/s), `svc.error_pct` (%), `svc.latency_ms` (ms), `svc.p95_latency_ms` (ms), `svc.cpu_pct` (%) |
| jvm | `jvm.heap_used_mb` (MB), `jvm.heap_pct` (%), `jvm.gc_pause_ms` (ms), `jvm.threads` |
| pod | `k8s.pod.cpu_millicores` (mCPU), `k8s.pod.memory_mb` (MB), `k8s.pod.restarts` (cumulative counter) |
| node | `k8s.node.cpu_millicores` (mCPU), `k8s.node.memory_mb` (MB), `k8s.node.cpu_pct` (%), `k8s.node.memory_pct` (% of allocatable) |
| run | `run.tps` (req/s), `run.p95_ms` (ms), `run.error_pct` (%), `run.active_users` |

Only keys backed by real stored columns are returned; the backend maps them to
`server_metrics`, `database_metrics`, `service_metrics`, `jvm_metrics`, `metric_points`
(source `kubernetes`) and `run_metrics`. `hasData` tells whether any entity of that type reported in
the window. JVM series are per service, or per host when the JVM has no service (e.g. a load generator's
JMeter JVM); JVM / database / service series carry `hostId` + `host` when known.

## GET /observability/series

Query: `metric=<key>` (one or more, comma-separated), `from`, `to`, `step`, `agg`,
`groupBy=entity|none` (default `entity`), `limit` (max series per metric, default 20, by
highest average), plus the filters above.

```json
{
  "from": "…", "to": "…", "stepSec": 60, "agg": "avg",
  "series": [{
    "metric": "host.cpu_pct", "unit": "%", "entityId": "uuid", "entity": "host", "label": "app-01",
    "points": [[1760260500000, 42.1], [1760260560000, null]],
    "hostId": "uuid (db/jvm/service series only, when known)", "host": "app-01",
    "stats": { "min": 3.2, "avg": 41.7, "max": 97.0, "p95": 88.0, "last": 40.2, "samples": 812,
               "maxTs": "ISO (first sample at the max)", "lastTs": "ISO" }
  }],
  "truncated": false,
  "markers": [{ "ts": "ISO", "endTs": "ISO|null", "kind": "run|event|annotation|deployment", "label": "PF-… Payment Load", "href": "/runs/PF-…" }]
}
```

`points` are bucket-start epoch ms; `null` = no data in that bucket (never interpolated).
`stats` are computed from raw samples in the window (not from bucket averages); `p95` = PostgreSQL
`percentile_cont(0.95)`. `limit` ∈ 1…100. `groupBy=none` returns one series per metric with
`entityId: "*"`, label `All hosts` etc. Marker `kind` = `run` (with `endTs`, `href`, `severity` = run
status) | `event` / `deployment` (`severity` = INFO/WARNING/CRITICAL) | `annotation`. ≤ 30 metrics per call.

## GET /observability/table

Same query as `series` but returns one row per entity × metric with `stats` only (for the
summary table and CSV export): `{ from, to, rows: [{ metric, unit, entity, entityId, label, stats }] }`.
Rows also carry `hostId`/`host` when known, and `truncated`. `?format=csv` returns `text/csv` with header
`metric,unit,entity,entity_id,label,host,samples,min,avg,max,p95,last,max_ts_utc,last_ts_utc`.

## Continuous collection

- `POST /observability/collection` (MANAGE_INTEGRATIONS) body
  `{ integrationId, enabled, intervalSec (≥ 60), environmentId? }` — schedules the integration's
  metric import (InfluxDB / Prometheus / Dynatrace mappings) on a timer for the last interval,
  independent of runs (run_id NULL unless a run is RUNNING in the linked environment).
  Kubernetes connections: enables the sampler continuously (not only while viewed).
  `environmentId` is required for metric integrations unless the integration is bound to a project.
  Returns the schedule (same shape as GET items).
- `GET /observability/collection` → `[{ integrationId, integrationName, type, projectId, enabled, intervalSec,
  effectiveIntervalSec (KUBERNETES: 20 — the sampler period), environmentId, environmentName, lastRunAt,
  lastStatus: RUNNING|OK|NO_DATA|ERROR|DISABLED|null, lastError, points (last import count), totalPoints,
  watermark (end of the last imported window), createdAt, updatedAt }]`.
- `DELETE /observability/collection/:integrationId` (MANAGE_INTEGRATIONS) removes a schedule (data kept).

## Reports

`POST /reports` accepts `type: "OBSERVABILITY"` with
`params: { from, to, filters: {…same keys as query filters, string (comma list) or string[]…}, metrics: ["host.cpu_pct", …], title? }`
(`projectId` top-level or `filters.projectId[0]` is the owning project; with no `filters.projectId` the
report covers the owning project; `metrics` optional = all with data). Includes a "Load generators"
table when hosts with role `loadgen` reported in the window.
and produces the usual formats (pdf, html, xlsx, csv, json) via the existing report pipeline.
