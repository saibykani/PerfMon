# Infrastructure Monitoring

Infrastructure Monitoring records server metrics (CPU, memory, disk, network, load, connections) while your tests run and ties them to the Run ID. Perfmon then shows load-test behaviour and resource usage on the same timeline. The same data feeds SLA rules, regression detection, the Performance Score, bottleneck analysis and capacity planning.

Data arrives in one of three ways:

- the **Perfmon Collector**, a small Node.js agent with no dependencies that you run on each server
- your own scripts calling the ingestion API
- integrations such as Prometheus, InfluxDB or Dynatrace

## Where to find it

| Location | Route | Shows |
|---|---|---|
| Observability → Infrastructure | `/infrastructure` | Server inventory with latest utilization and status |
| Run detail, Infrastructure view | `/runs/<Run ID>` | Per-server aggregates and series for the run window |
| Overview | `/` | Infrastructure health widget (latest sample per server) |

## Server roles

The `role` of each server affects how its metrics are used in analysis:

| Role | Meaning | Effect on analysis |
|---|---|---|
| `app` (Collector default) | Application server | Included in CPU and memory aggregates and in application-CPU bottleneck analysis |
| `db` | Database host | Included in memory and CPU aggregates, but excluded from the application-CPU bottleneck series |
| `gateway` | Gateway / proxy | Included like `app` |
| `loadgen` | JMeter load generator | **Excluded** from system-under-test aggregates. Used to check whether the load generator itself was saturated. |

Always give load generators the `loadgen` role. Otherwise their CPU is counted as application CPU, which skews the Performance Score, the CPU result dimension and bottleneck analysis.

## Running the Perfmon Collector

The Collector (`collector/collector.mjs`) samples CPU, memory and load average every `INTERVAL_SEC` seconds. It sends a batch every 3 samples to `POST /api/v1/ingest/infrastructure`.

| Variable | Required | Description |
|---|---|---|
| `PERFMON_URL` | Yes (in practice) | Base URL of your Perfmon server. The built-in default is `http://localhost:8080`, so always set it explicitly. |
| `PERFMON_API_KEY` | Yes | API key with the `ingest` scope |
| `PERFMON_PROJECT` | Yes, unless `PERFMON_RUN_ID` is set | Project key, for example `payments` |
| `PERFMON_ENV` | Recommended | Environment name, for example `Performance` |
| `PERFMON_RUN_ID` | No | Attach samples to a specific run; see below |
| `PERFMON_SERVER` | No | Server name (default: hostname) |
| `PERFMON_ROLE` | No | `app`, `db`, `loadgen`, `gateway` (default `app`) |
| `INTERVAL_SEC` | No | Sampling interval in seconds (default 5) |

```bash
PERFMON_URL=https://perfmon.example.com \
PERFMON_API_KEY=pmk_xxxxxxxxxxxxxxxx \
PERFMON_PROJECT=payments \
PERFMON_ENV=Performance \
PERFMON_ROLE=app \
node collector/collector.mjs
```

On a load generator:

```bash
PERFMON_URL=https://perfmon.example.com PERFMON_API_KEY=pmk_xxx \
PERFMON_PROJECT=payments PERFMON_ENV=Performance PERFMON_ROLE=loadgen \
PERFMON_SERVER=jmeter-lg-01 node collector/collector.mjs
```

If a send fails, the Collector keeps up to the 120 most recent samples and retries with the next batch. Press Ctrl+C (SIGINT) to flush the remaining samples before it exits.

### How samples are linked to a run

1. If the payload includes `runId` (or `PERFMON_RUN_ID` is set), the samples belong to that run.
2. Otherwise Perfmon looks for the most recent `RUNNING` run in the same **environment** that had started by the time of the batch's first sample. If it finds one, the samples are linked to it.
3. If no run is running, the samples are still stored. They update server status and live alerts, but no run uses them.

Because of this, a Collector can run permanently on a server. Its data is attached to whichever test is running in that environment.

## Server registration and status

Servers are registered automatically by name the first time they send data, using a unique (project, name) pair. Later payloads update the hostname, OS, CPU cores, memory and role. Each batch also sets the server status from its **last** sample:

| Status | Rule |
|---|---|
| `CRITICAL` | CPU ≥ 90% or memory ≥ 95% |
| `WARNING` | CPU ≥ 75% or memory ≥ 85% |
| `HEALTHY` | Otherwise |

You can also register and manage servers by hand. This requires `MANAGE_PROJECT`.

## Ingestion payload

The Collector sends only CPU, memory, memory used and load. Your own agents can send all of these fields:

```json
{
  "project": "payments",
  "environment": "Performance",
  "runId": "PF-2026-10-06-000127",
  "server": { "name": "app-01", "hostname": "app-01.internal", "os": "Linux 6.8",
              "cpuCores": 8, "memoryMb": 32768, "diskGb": 200, "role": "app" },
  "metrics": [
    { "ts": 1791273600000, "cpuPct": 63.2, "memoryPct": 71.0, "memoryUsedMb": 23260,
      "diskPct": 41.0, "diskReadBps": 120000, "diskWriteBps": 380000,
      "netInBps": 5200000, "netOutBps": 7400000, "loadAvg1m": 4.1,
      "processes": 312, "tcpConnections": 845, "fileDescriptors": 4100 }
  ]
}
```

`ts` accepts epoch seconds, epoch milliseconds or an ISO string. A request can contain up to 50,000 metric rows and a body of up to 20 MB.

```bash
curl -s -X POST "$PERFMON_URL/api/v1/ingest/infrastructure" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d @server-metrics.json
```

The response looks like `{ "accepted": 1, "serverId": "...", "serviceId": null, "runId": "<uuid or null>" }`.

## Viewing a run's infrastructure

`GET /runs/:id/infrastructure` returns:

- `servers`: one row per server with average and maximum CPU, average and maximum memory, maximum disk, average network in/out, maximum load, maximum TCP connections and maximum file descriptors
- `series`: values per time bucket and server for CPU, memory, disk, disk read/write, network in/out, load, TCP connections, processes and file descriptors

```bash
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/infrastructure" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

curl -s "$PERFMON_URL/api/v1/servers?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

The run timeline (`/runs/:id/timeline`) also overlays CPU and memory on the load-test charts.

## How infrastructure data is used

| Feature | Metric used |
|---|---|
| SLA rule `cpu_pct` | CPU **p90** across non-loadgen servers for the run |
| SLA rule `memory_pct` | Maximum memory across non-loadgen servers |
| Result dimension CPU (no CPU SLA rule) | CPU p90 ≥ 90% FAIL, ≥ 80% WARNING |
| Performance Score, Infrastructure factor | CPU p90 above 70% and memory max above 80% reduce the score |
| Regression detection | CPU average +15 pts and memory max +15 pts against the baseline (defaults) |
| Bottleneck analysis | Correlation between P95 and application CPU; load generator CPU p90 ≥ 80% |
| Capacity planning | CPU average per run against TPS (Utilization Law) |
| Alerts | `CPU`, `MEMORY`, `DISK` rules (averaged over the rule window, per server) |

## Related chapters

- [JVM Monitoring](18-jvm-monitoring.md)
- [Database Monitoring](19-database-monitoring.md)
- [Bottleneck Analysis](26-bottleneck-analysis.md)
- [Prometheus Integration](32-prometheus-integration.md)
