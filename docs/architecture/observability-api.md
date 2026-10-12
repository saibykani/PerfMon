# Observability API contract (time-window monitoring)

Shared contract between the backend (`backend/src/observability/`) and the frontend
(`frontend/src/components/observability/`, Observability pages). All endpoints are under
`/api/v1`, require `VIEW_PROJECT`, and are scoped to the caller's organization.

## Conventions

- **Time**: `from` / `to` are ISO-8601 instants with timezone (`2026-10-12T09:15:00Z`), minute
  precision or finer. Stored and returned in UTC; the UI displays local time or UTC.
  Responses echo the effective `from`, `to` and `stepSec`.
- **Step**: `step=auto` (default) picks the smallest of 10, 15, 30, 60, 120, 300, 600, 900, 1800,
  3600, 21600, 86400 seconds that keeps ≤ 600 points per series; an explicit `step` (seconds,
  ≥ 10) is honoured but raised if it would exceed 2 000 points. Buckets are aligned to
  `floor(epoch / step) * step`.
- **Aggregation** within a bucket: `agg=avg|min|max|sum|p95|last` (default `avg`).
- **Filters** (all optional, comma-separated lists = OR within a filter, AND across filters):
  `projectId`, `environmentId`, `applicationId`, `runId`, `hostId`, `serviceId`,
  `databaseId`, `cluster` (Kubernetes connection id), `namespace`, `workload`, `pod`, `node`.
- **Errors** use the standard envelope `{ timestamp, status, error, message, path }`.
  A window larger than 90 days → 400.

## GET /observability/inventory

Entities that reported data in the window (or exist in the inventory), for the filter pickers.

```json
{
  "from": "…", "to": "…",
  "hosts":     [{ "id": "uuid", "name": "app-01", "role": "app", "environmentId": "uuid|null", "projectId": "uuid", "lastSeen": "ISO|null" }],
  "databases": [{ "id": "uuid", "name": "orders-db", "engine": "postgres|mysql|…|null", "hostId": "uuid|null", "lastSeen": "ISO|null" }],
  "services":  [{ "id": "uuid", "name": "checkout-svc", "kind": "service|jvm", "lastSeen": "ISO|null" }],
  "kubernetes": {
    "clusters":   [{ "id": "integration-uuid", "name": "prod-eks" }],
    "namespaces": [{ "cluster": "id", "name": "shop" }],
    "workloads":  [{ "cluster": "id", "namespace": "shop", "name": "web", "kind": "Deployment" }],
    "pods":       [{ "cluster": "id", "namespace": "shop", "name": "web-7d9…", "workload": "web", "node": "n1" }]
  },
  "runs": [{ "id": "uuid", "runKey": "PF-…", "testName": "…", "startedAt": "ISO", "endedAt": "ISO|null", "status": "…" }],
  "metrics": [{ "key": "host.cpu_pct", "label": "CPU", "unit": "%", "entity": "host" }]
}
```

## Metric catalogue (`metrics[].key`)

| entity | keys (unit) |
|---|---|
| host | `host.cpu_pct` (%), `host.memory_pct` (%), `host.memory_used_mb` (MB), `host.disk_pct` (%), `host.load_1m`, `host.net_rx_kbps` / `host.net_tx_kbps` (KB/s) |
| database | `db.query_latency_ms` (ms), `db.connections_active`, `db.pool_pct` (%), `db.slow_queries`, `db.locks`, `db.deadlocks`, `db.tps` (tx/s), `db.cpu_pct` (%) |
| service | `svc.request_rate` (req/s), `svc.error_pct` (%), `svc.latency_ms` (ms), `svc.cpu_pct` (%) |
| jvm | `jvm.heap_used_mb` (MB), `jvm.heap_pct` (%), `jvm.gc_pause_ms` (ms), `jvm.threads` |
| pod | `k8s.pod.cpu_millicores`, `k8s.pod.memory_mb`, `k8s.pod.restarts` |
| node | `k8s.node.cpu_millicores`, `k8s.node.memory_mb` |
| run | `run.tps` (req/s), `run.p95_ms` (ms), `run.error_pct` (%), `run.active_users` |

Only keys backed by real stored columns are returned; the backend maps them to
`server_metrics`, `database_metrics`, `service_metrics`, `jvm_metrics`, `metric_points`
(source `kubernetes`) and `run_metrics`.

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
    "stats": { "min": 3.2, "avg": 41.7, "max": 97.0, "p95": 88.0, "last": 40.2, "samples": 812 }
  }],
  "truncated": false,
  "markers": [{ "ts": "ISO", "endTs": "ISO|null", "kind": "run|event|annotation|deployment", "label": "PF-… Payment Load", "href": "/runs/PF-…" }]
}
```

`points` are bucket-start epoch ms; `null` = no data in that bucket (never interpolated).
`stats` are computed from raw samples in the window (not from bucket averages).

## GET /observability/table

Same query as `series` but returns one row per entity × metric with `stats` only (for the
summary table and CSV export): `{ from, to, rows: [{ metric, unit, entity, entityId, label, stats }] }`.
`?format=csv` returns `text/csv` with a header row.

## Continuous collection

- `POST /observability/collection` (MANAGE_INTEGRATIONS) body
  `{ integrationId, enabled, intervalSec (≥ 60), environmentId? }` — schedules the integration's
  metric import (InfluxDB / Prometheus / Dynatrace mappings) on a timer for the last interval,
  independent of runs (run_id NULL unless a run is RUNNING in the linked environment).
  Kubernetes connections: enables the sampler continuously (not only while viewed).
- `GET /observability/collection` → current schedules with `lastRunAt`, `lastStatus`, `lastError`,
  `points` (last import count).

## Reports

`POST /reports` accepts `type: "OBSERVABILITY"` with
`params: { from, to, filters: {…same keys as query filters…}, metrics: ["host.cpu_pct", …], title? }`
and produces the usual formats (pdf, html, xlsx, csv, json) via the existing report pipeline.
