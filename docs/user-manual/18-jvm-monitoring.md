# JVM Monitoring

JVM Monitoring records Java runtime metrics during a test: heap and non-heap memory, garbage collection, threads and loaded classes. Like all infrastructure data, they are tied to the Run ID. Perfmon uses them to check JVM SLA rules, compare runs, raise heap and GC alerts, and assess whether garbage collection is a likely cause of latency.

## Where to find it

| Location | Route | Shows |
|---|---|---|
| Observability → Applications Monitoring | `/app-monitoring` | Application services, their health and runtime metrics |
| Run detail, JVM view | `/runs/<Run ID>` | Heap, GC, threads and classes for the run window, per JVM |

## Sending JVM metrics

The Perfmon Collector only sends host metrics. JVM metrics come from your own exporter (for example a small sidecar that reads JMX or Micrometer values) or from an integration ([Prometheus](32-prometheus-integration.md), [Dynatrace](33-dynatrace-integration.md), [OpenTelemetry](34-opentelemetry.md)). Send them to the same ingestion endpoint as server metrics, in the `jvm` array:

| Field | Unit | Description |
|---|---|---|
| `ts` | epoch s/ms or ISO | Sample time |
| `heapUsedMb`, `heapCommittedMb`, `heapMaxMb` | MB | Heap memory |
| `nonHeapUsedMb` | MB | Metaspace, code cache and other non-heap memory |
| `gcCount` | count | GC collections in the interval |
| `gcTimeMs` | ms | Total GC time in the interval |
| `gcMaxPauseMs` | ms | Longest GC pause in the interval |
| `threadCount`, `peakThreads` | count | Live and peak threads |
| `classesLoaded` | count | Loaded classes |

Identify the JVM with a `server` object, a `service` object, or both. Both are registered automatically by name. Valid service kinds are `loadgen`, `gateway`, `service`, `database`, `cache`, `queue` and `external`.

```json
{
  "project": "payments",
  "environment": "Performance",
  "server": { "name": "app-01", "role": "app" },
  "service": { "name": "payment-service", "kind": "service", "technology": "Java 21 / Spring Boot" },
  "jvm": [
    { "ts": 1791273600000, "heapUsedMb": 1830, "heapCommittedMb": 3072, "heapMaxMb": 4096,
      "nonHeapUsedMb": 210, "gcCount": 3, "gcTimeMs": 41, "gcMaxPauseMs": 18,
      "threadCount": 212, "peakThreads": 230, "classesLoaded": 18450 }
  ]
}
```

```bash
curl -s -X POST "$PERFMON_URL/api/v1/ingest/infrastructure" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d @jvm-metrics.json
```

If the payload has no `runId`, the samples are linked to the `RUNNING` run in the same environment, if there is one. See [Infrastructure Monitoring](17-infrastructure-monitoring.md#how-samples-are-linked-to-a-run).

**Always send `heapMaxMb`.** Heap utilization is calculated as `heapUsedMb / heapMaxMb × 100`. Without `heapMaxMb`, heap percentage SLAs, heap alerts and heap-related analysis cannot be computed.

## Viewing JVM metrics for a run

`GET /runs/:id/jvm` returns:

- `targets`: the JVMs that reported during the run (server and/or service)
- `series`: values per time bucket and server for heap used/committed/max, non-heap used, GC count, GC time, maximum GC pause, threads, peak threads and classes loaded

```bash
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/jvm" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

# Raw JVM rows as CSV
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/raw?table=jvm_metrics&format=csv" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -o jvm.csv
```

To narrow the window, use `from`, `to` and `step` (seconds).

## How JVM data is used in analysis

Run-level JVM figures are computed across all JVM samples linked to the run:

| Figure | Definition |
|---|---|
| Heap max % | Maximum of `heapUsedMb / heapMaxMb × 100` |
| Heap avg % | Average of the same ratio |
| GC pause max | Maximum `gcMaxPauseMs` |
| GC time avg | Average `gcTimeMs` |
| Threads max | Maximum `threadCount` |

| Feature | Behaviour |
|---|---|
| [SLA / SLO](20-sla-slo.md) | Rule metrics `heap_pct` (JVM heap max) and `gc_pause_ms` (GC pause max); run scope only |
| [Run Comparison](22-run-comparison.md) | Metrics "Heap max" and "GC pause max" (lower is better) |
| [Performance Insights](27-performance-insights.md) | A **JVM heap above 90%** insight (WARNING) with the recommendation "Investigate GC behaviour" |
| [Bottleneck Analysis](26-bottleneck-analysis.md) | A **JVM garbage collection** candidate whenever GC data exists; confidence grows with GC pause above 200 ms, heap above 80%, and correlation with P95 |
| [Alerts](21-alerts.md) | `JVM_HEAP` (maximum heap % over the window) and `GC` (maximum pause over the window), evaluated per server |

### Reading GC evidence carefully

A long GC pause does not, on its own, prove that GC caused the slow response times. The bottleneck analysis combines several signals: how closely the GC pause series correlates with P95, how far the pause and heap exceed normal levels, whether heap went above 90%, and whether there are enough data points. The result is reported with a confidence label. When the evidence is weak, Perfmon says so ("Possible bottleneck" or "Insufficient evidence") instead of drawing a conclusion.

## Practical guidance

- Sample every 5-15 seconds. Coarser intervals hide short GC pauses.
- Report `gcMaxPauseMs` per interval, not cumulative since JVM start.
- Name services consistently across environments, for example `payment-service`, so comparisons and dashboards line up.
- If several JVMs run on one host, send a separate `service` for each JVM.

## Related chapters

- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [Database Monitoring](19-database-monitoring.md)
- [Bottleneck Analysis](26-bottleneck-analysis.md)
