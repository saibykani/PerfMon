# Database Monitoring

Database Monitoring records database-side metrics during a test: connections, connection pool usage, query latency, slow queries, locks, deadlocks, CPU, memory and transactions per second. Perfmon links these to the Run ID. It can then tell you whether higher response times line up with database latency or pool exhaustion, and it can apply SLAs and regression checks to database figures.

## Where to find it

| Location | Route | Shows |
|---|---|---|
| Observability → Databases | `/databases` | Databases (services of kind `database`) in the selected project and environment |
| Run detail, Database view | `/runs/<Run ID>` | Database series for the run window, per database |

## Sending database metrics

Send database metrics to `POST /api/v1/ingest/infrastructure` in the `database` array. Identify the database with a `service` of kind `database`. The service is registered automatically by name within the project and environment.

| Field | Unit | Description |
|---|---|---|
| `ts` | epoch s/ms or ISO | Sample time |
| `engine` | text | For example `postgresql`, `oracle`, `mysql` |
| `connections` | count | Open connections |
| `activeConnections` | count | Connections executing work |
| `maxConnections` | count | Pool or server limit. **Required for pool utilization.** |
| `queryLatencyMs` | ms | Average query latency in the interval |
| `slowQueries` | count | Slow queries in the interval |
| `locks`, `deadlocks` | count | Lock waits and deadlocks |
| `cpuPct`, `memoryPct` | % | Database host or instance utilization |
| `transactionsPerSec` | tps | Database transaction rate |

```json
{
  "project": "payments",
  "environment": "Performance",
  "service": { "name": "payments-db", "kind": "database", "technology": "PostgreSQL 16" },
  "database": [
    { "ts": "2026-10-06T10:15:00Z", "engine": "postgresql", "connections": 64,
      "activeConnections": 41, "maxConnections": 100, "queryLatencyMs": 7.8,
      "slowQueries": 2, "locks": 3, "deadlocks": 0, "cpuPct": 48.5,
      "memoryPct": 62.0, "transactionsPerSec": 910 }
  ]
}
```

```bash
curl -s -X POST "$PERFMON_URL/api/v1/ingest/infrastructure" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d @db-metrics.json
```

You can also pull database metrics from Prometheus exporters (for example `postgres_exporter`) or from Dynatrace through an integration import. See [Prometheus Integration](32-prometheus-integration.md).

## Viewing database metrics for a run

`GET /runs/:id/database` returns `targets` (database services with technology and engine) and `series` for each time bucket and database. The series include connections, active connections, max connections, query latency, slow queries, locks, deadlocks, CPU, memory and transactions per second.

```bash
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/database" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

## Run-level database figures

| Figure | Definition |
|---|---|
| DB latency avg / max | Average and maximum `queryLatencyMs` |
| DB active connections max | Maximum `activeConnections` |
| Pool utilization max | Maximum of `activeConnections / maxConnections × 100` |
| Slow queries | Sum of `slowQueries` |
| Locks max | Maximum `locks` |
| DB CPU avg | Average `cpuPct` |

## How database data is used

| Feature | Behaviour |
|---|---|
| [SLA / SLO](20-sla-slo.md) | Rule metric `db_latency_ms` (DB query latency, average), run scope |
| [Regression Detection](23-regression-detection.md) | `db_latency_avg` is flagged when it rises more than **25%** and by at least **5 ms** against the baseline. CRITICAL at 50% or more. This threshold is fixed and is not part of the configurable regression settings. |
| [Run Comparison](22-run-comparison.md) | "DB latency avg" and "DB active conns max" (lower is better) |
| [Bottleneck Analysis](26-bottleneck-analysis.md) | **Database** and **Database connection pool** candidates |
| [Performance Insights](27-performance-insights.md) | Latency insights include "DB latency X → Y" when both runs have database data |

### Database bottleneck candidates

**Database** is evaluated whenever the run has database latency samples. Its confidence combines:

- how closely P95 correlates with database latency over time
- how much database latency increased: against the baseline run if there is one, otherwise from the first quarter to the last quarter of the run
- corroborating signals: application CPU stayed moderate (p90 below 70%), and slow queries were recorded
- whether there are enough data points (30 or more aligned points count fully)

**Database connection pool** is evaluated only when pool utilization reached **80% or more**. Its confidence is higher when utilization reached 95% or more.

The component name includes the database service name, for example `Database (payments-db)`. Confidence is always shown with its label (Strong correlation, Likely bottleneck, Possible bottleneck, Insufficient evidence) and is never shown as certain. See [Bottleneck Analysis](26-bottleneck-analysis.md).

## Recommendations you may see

| Recommendation | Trigger |
|---|---|
| Investigate database latency | Database candidate with confidence 45% or more |
| Review connection pool sizing | Connection pool candidate with confidence 45% or more |

## Practical guidance

- Always send `maxConnections`. Without it, Perfmon cannot calculate pool utilization or detect connection pool exhaustion.
- Report latency as an average per interval. Do not send cumulative totals.
- Sample at the same interval as your server metrics (5-15 s) so correlations line up.
- There are no database-specific alert rule types. Use SLA rules on `db_latency_ms` together with an `SLA_VIOLATION` alert.

## Related chapters

- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [JVM Monitoring](18-jvm-monitoring.md)
- [Bottleneck Analysis](26-bottleneck-analysis.md)
