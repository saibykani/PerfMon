# Observability hub (time-window monitoring)

The Observability hub shows every monitored layer for **any time window**, not just for a test run: hosts (including load generators), databases, services and JVMs, Kubernetes pods and nodes, and the load-test metrics of the runs that overlap the window. You can filter by project, environment, application, run, host role and individual entities. Windows are specified to the minute, and reports can be generated for them.

The full API contract is in `docs/architecture/observability-api.md`. This chapter explains how the data is calculated and how to use it.

## How values are calculated

| Rule | Behaviour |
|---|---|
| Time | `from` / `to` are ISO-8601 instants **with a timezone** (`2026-10-12T09:15:00Z` or `…+02:00`) or epoch milliseconds. Values without a timezone are rejected because they are ambiguous. All times are stored and returned in UTC. |
| Window | `[from, to)`: the start is inclusive and the end exclusive. The default is the last hour, and the maximum is 90 days (a larger window returns 400). |
| Buckets | Bucket start = `floor(epoch / step) × step`, computed in SQL, so a 60 s bucket always starts at hh:mm:00 UTC. |
| Step | `step=auto` picks the smallest of 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 21600 or 86400 s that keeps ≤ 600 points. An explicit step (≥ 10 s) is kept unless it would exceed 2 000 points; in that case it is raised to the next candidate that fits. |
| Aggregation | `agg=avg` (default), `min`, `max`, `sum`, `p95` or `last` is applied to the raw samples inside each bucket. |
| Gaps | A bucket without samples is `null`. Values are **never interpolated**. |
| Statistics | `min`, `avg`, `max`, `p95`, `last`, `samples`, `maxTs` (first time at the maximum) and `lastTs` are computed from **all raw samples in the window**, never from bucket averages. P95 uses PostgreSQL `percentile_cont` (linear interpolation between closest ranks). |
| Runs | Each run's load-test metrics come from a single source (live listener, else JTL, else import, else HTML report). Sources are never mixed. |

## Filters

Every filter is optional. A filter can hold several comma-separated values: values within one filter are combined with OR, and different filters are combined with AND. The filters are `projectId`, `environmentId`, `applicationId`, `runId`, `hostId`, `serviceId`, `databaseId`, `role` (host role, e.g. `role=loadgen` or `role=app,db`), `cluster` (Kubernetes connection id), `namespace`, `workload`, `pod` and `node`.

- A filter that does not apply to an entity type is ignored for that type. For example, `namespace` does not restrict hosts, and `hostId` / `role` restrict hosts, databases, JVMs and services (through the host they run on).
- Kubernetes connections without a project remain visible when you filter by `projectId`. An API key that is bound to a project only ever sees that project.

## Load generators

Hosts with role `loadgen` (machines running JMeter) are monitored like any other host. Their CPU, memory, disk and network come from `host.*` metrics. JVM heap and GC from the collector's `jvm` section are available as `jvm.*` series per host, even when no service is attached. Use `role=loadgen` to see only the load generators. A saturated load generator (CPU close to 90 %, heap near its maximum, long GC pauses) distorts measured response times.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/observability/inventory` | Entities in scope with `lastSeen` in the window, Kubernetes clusters/namespaces/workloads/pods/nodes, overlapping runs, and the metric catalogue (`hasData` per metric). |
| `GET /api/v1/observability/series?metric=host.cpu_pct,db.query_latency_ms&from=…&to=…` | Series per entity (`groupBy=entity`, or `none` for a single combined series), the top `limit` entities by average (default 20, max 100), `points` + `stats`, and `markers` (runs, events, deployments, annotations). |
| `GET /api/v1/observability/table?…` | One row per entity × metric, with stats only. Add `&format=csv` for CSV with UTC timestamps. |
| `GET /api/v1/observability/collection` | Continuous collection schedules with `lastRunAt`, `lastStatus` (`RUNNING`, `OK`, `NO_DATA`, `ERROR`, `DISABLED`), `lastError`, `points`, `totalPoints` and `watermark`. |
| `POST /api/v1/observability/collection` | `{ integrationId, enabled, intervalSec ≥ 60, environmentId? }`. Requires MANAGE_INTEGRATIONS. |
| `DELETE /api/v1/observability/collection/<integrationId>` | Removes a schedule. Data that was already collected is kept. |

### Metric keys

| Entity | Keys | Stored in |
|---|---|---|
| host | `host.cpu_pct`, `host.memory_pct`, `host.memory_used_mb`, `host.disk_pct`, `host.load_1m`, `host.net_rx_kbps`, `host.net_tx_kbps` (bytes/s ÷ 1024) | `server_metrics` |
| database | `db.query_latency_ms`, `db.connections_active`, `db.pool_pct` (active × 100 / max connections), `db.slow_queries`, `db.locks`, `db.deadlocks`, `db.tps`, `db.cpu_pct` | `database_metrics` |
| service | `svc.request_rate`, `svc.error_pct`, `svc.latency_ms` (avg), `svc.p95_latency_ms`, `svc.cpu_pct` | `service_metrics` |
| jvm | `jvm.heap_used_mb`, `jvm.heap_pct` (used × 100 / max), `jvm.gc_pause_ms` (max pause), `jvm.threads` | `jvm_metrics` |
| pod | `k8s.pod.cpu_millicores`, `k8s.pod.memory_mb`, `k8s.pod.restarts` (cumulative counter) | `metric_points`, source `kubernetes` |
| node | `k8s.node.cpu_millicores`, `k8s.node.memory_mb`, `k8s.node.cpu_pct`, `k8s.node.memory_pct` (of allocatable) | `metric_points`, source `kubernetes` |
| run | `run.tps` (samples / interval), `run.p95_ms`, `run.error_pct`, `run.active_users` | `run_metrics` |

## Continuous collection

Without a schedule, InfluxDB, Prometheus and Dynatrace metrics are imported only for a run (see the integration chapters). With continuous collection enabled, Perfmon imports them on a timer, whether or not a test is running:

1. Open the integration, enable **Continuous collection**, choose an interval (minimum 60 s) and, preferably, an environment.
2. Every interval, Perfmon runs the integration's mappings (or the connector defaults, e.g. Telegraf cpu/mem/disk/system) for the window `[watermark, now − lag)`. The window is cut at step boundaries: 10 s steps with a 20 s lag for InfluxDB and Prometheus, and 60 s steps with a 120 s lag for Dynatrace.
3. Each window starts exactly where the previous one ended (the *watermark*), so windows never overlap and no timestamp is stored twice. After downtime, Perfmon catches up at most 6 hours per run.
4. If a run is RUNNING in the schedule's environment, the points are attached to that run. Otherwise `run_id` is empty and the data is visible only in the Observability hub.
5. Data belongs to the environment's project. Without an environment, the integration must be bound to a project.

**Kubernetes** connections switch the pod/node sampler into continuous mode: it samples every 20 s even when nobody is viewing the Kubernetes pages. For continuously sampled clusters, samples not attached to a run are kept for `OBS_K8S_RETENTION_DAYS` (default 14 days) instead of 24 hours.

Each process runs one scheduler, and at most three schedules run at the same time. When several backend instances share a database, a PostgreSQL advisory lock per schedule and an atomic "is it due" update ensure that only one instance executes each tick. Set `OBS_COLLECTION_DISABLED=true` to turn the scheduler off on an instance.

## Observability report

`POST /api/v1/reports` with:

```json
{ "type": "OBSERVABILITY", "projectId": "<uuid>",
  "params": { "from": "2026-10-06T20:10:00Z", "to": "2026-10-06T20:55:00Z",
              "filters": { "environmentId": "<uuid>", "role": "app,loadgen" },
              "metrics": ["host.cpu_pct", "db.query_latency_ms"], "title": "Night incident" } }
```

`projectId` and `metrics` are both optional. By default, all metrics with data are included. Without a project (neither `projectId` nor `filters.projectId`), the report covers the whole organization, and the cover page says so. It is then listed under the project of a filtered entity, or else under the organization's first project. An API key that is bound to a project always gets a report for that project only. The report is available as PDF, HTML, XLSX, CSV and JSON and contains:

- **Cover**: the window to the minute (UTC), duration, timezone, bucket size, every applied filter, and entity counts.
- **Executive summary**: the highest CPU, memory and DB latency, plus pod restarts, each with the exact UTC time of its peak; key figures; and a hot-spot table (peak per metric with its time, window average and P95).
- **One chapter per entity type with data**: Hosts (with a **Load generators** table when `loadgen` hosts are in scope, showing peak CPU, memory, JVM heap and GC pause with timestamps), Databases, Services & JVM, Kubernetes, and Test runs. Each metric has a chart (≤ 300 aligned buckets, top 8 entities) and a statistics table (samples, min, avg, P95, max, time of max, last; up to 50 entities).
- **Markers**: runs, events, deployments and annotations in the window.
- **Appendix**: the method (window, bucket alignment, aggregation, statistics), the stored column behind each metric, and the report metadata.
