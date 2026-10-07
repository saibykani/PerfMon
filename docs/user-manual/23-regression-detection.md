# Regression Detection

Every time a run is analyzed, Perfmon compares it with its **baseline** and records each **regression** (a metric that got worse by more than its threshold) and each **improvement** (a metric that got better by more than its threshold). Findings are recorded for the whole run, for each transaction and for infrastructure. They feed the run result, the Performance Score, insights, alerts, events and reports. The Regression page shows them across all runs.

## Where to find it

| Location | Route | Shows |
|---|---|---|
| Analysis → Regression | `/regression` | Regression feed across runs. Filters for project, test, severity, direction and time; severity KPIs; improvements; a chart of regressions over time. |
| Run detail | `/runs/<Run ID>` | The regressions and improvements of one run (part of the run's insights) |

## Which baseline is used

The baseline is chosen in this order:

1. The **run baseline**: the baseline set on the run (`baselineRunId`)
2. The **test baseline**: the run marked as the test's baseline (`POST /runs/:id/baseline`, permission `EDIT_TEST`)
3. The **previous completed run** of the same test **in the same environment** that started before this run

If no baseline can be found (for example on the first run of a test), regression detection is skipped. The Score's Regression factor then shows "No baseline". Each finding stores the baseline Run ID (`baselineRunKey`), so you can always see what it was compared against.

Mark a known-good run as the test baseline:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs/PF-2026-10-01-000120/baseline" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"baseline": true}'
```

## Default thresholds

| Setting | Default | Applies to |
|---|---|---|
| `p95Pct` | 10% | P95 increase (run and transaction) |
| `p99Pct` | 15% | P99 increase (run and transaction) |
| `avgPct` | 10% | Average response time increase (run) |
| `tpsDropPct` | 10% | TPS decrease (run) |
| `errorRateIncreasePts` | 1 percentage point | Error rate increase (run and transaction) |
| `cpuIncreasePts` | 15 points | CPU average increase (infrastructure) |
| `memoryIncreasePts` | 15 points | Memory maximum increase (infrastructure) |
| `minAbsoluteMs` | 25 ms | Minimum absolute change for P95, P99 and average |
| `minTransactionSamples` | 30 | Minimum samples in **both** runs before a transaction is checked |

Database latency (`db_latency_avg`) uses a fixed rule that cannot be configured: more than 25% increase **and** at least 5 ms.

Error rate, CPU and memory thresholds are in **percentage points**, not relative percent. Going from 0.5% to 1.4% errors is +0.9 points, which is below the default threshold of 1 point, even though it is a relative increase of 80%.

## Rules in detail

| Scope | Metric | Regression when | CRITICAL when | Improvement |
|---|---|---|---|---|
| RUN | `p95`, `p99`, `avg_rt` | Increase > threshold % **and** abs. change ≥ 25 ms | Increase ≥ 2 × threshold | Decrease > threshold % (and ≥ 25 ms) |
| RUN | `tps` | Decrease > 10% | Decrease ≥ 20% | Increase > 10% |
| RUN | `error_pct` | Increase > 1 pt | Increase > **3** × threshold (3 pts) | Decrease > 1 pt |
| TRANSACTION | `p95`, `p99` | As for RUN, with ≥ 30 samples in both runs | Increase ≥ 2 × threshold | As for RUN |
| TRANSACTION | `error_pct` | Increase > 1 pt, ≥ 30 samples in both runs | Never; always WARNING | Not reported |
| INFRA | `cpu_avg` | Increase > 15 pts | Increase > 2 × threshold (30 pts) | Not reported |
| INFRA | `mem_max` | Increase > 15 pts | Increase > 30 pts | Not reported |
| INFRA | `db_latency_avg` | Increase > 25% and ≥ 5 ms | Increase ≥ 50% | Decrease > 25% |

Regressions are `WARNING` or `CRITICAL`. Improvements are always `INFO` with direction `IMPROVEMENT`. For every finding, Perfmon stores the previous and current values, the change % (relative, even for point-based metrics), the threshold used, and the **likely impacted components**: bottleneck candidates with at least 45% confidence (see [Bottleneck Analysis](26-bottleneck-analysis.md)).

### Why the minimum thresholds exist

- **Minimum absolute change (25 ms):** a P95 moving from 40 ms to 46 ms is +15%, but operationally it doesn't matter. The 25 ms floor prevents such alerts.
- **Minimum transaction samples (30):** percentiles from a handful of requests vary too much from run to run, so the comparison would not be meaningful.

## What happens when regressions are found

| Effect | Detail |
|---|---|
| Run result | The **Regression** dimension becomes WARNING. A regression on its own never makes a run FAIL. |
| Performance Score | Regression factor = 100 − 25 × CRITICAL − 10 × WARNING (minimum 0); weight 10 by default |
| Insights | "N performance regressions vs baseline" (CRITICAL if any finding is CRITICAL), with the recommendation "Review changes since baseline" |
| Event | A `REGRESSION` event is added to the run's timeline |
| Alerts | `REGRESSION` alert rules fire at run completion |
| Run summary | "Performance Regression: YES" and the largest finding |

## Using the Regression page

1. Open **Analysis → Regression** (`/regression`).
2. Filter by project, test, severity (`CRITICAL`, `WARNING`, `INFO`), direction (`REGRESSION`, `IMPROVEMENT`) and time range.
3. The KPI cards count findings by severity. The chart shows how the findings are spread over time.
4. Each card shows the run, the baseline, the scope or transaction, the metric, previous → current, the change and the threshold. Select it to open the run or to compare it with its baseline in [Run Comparison](22-run-comparison.md).

## Changing thresholds

Thresholds are organization settings (`regression_thresholds`). An administrator changes them under **Platform → Administration** (`/admin`), or through `PUT /admin/settings/regression_thresholds` (API contract section 11). You only need to send the keys you want to change; the others keep their defaults. New thresholds apply from the next analysis. To re-check an existing run, re-analyze it:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/reanalyze" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

## REST API

`GET /regressions` accepts `projectId`, `testId`, `environmentId`, `runId`, `severity`, `direction`, `scope`, `from`, `to`, `page` and `pageSize`. Severity, direction and scope accept comma-separated lists.

```bash
curl -s "$PERFMON_URL/api/v1/regressions?projectId=$PROJECT_ID&direction=REGRESSION&severity=CRITICAL,WARNING" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

```json
{
  "items": [
    { "runKey": "PF-2026-10-06-000127", "baselineRunKey": "PF-2026-10-01-000120",
      "scope": "TRANSACTION", "transaction": "Checkout_Pay", "metric": "p95",
      "previousValue": 640, "currentValue": 812, "changePct": 26.9, "thresholdPct": 10,
      "direction": "REGRESSION", "severity": "CRITICAL",
      "likelyImpacted": ["Database (payments-db)"], "createdAt": "2026-10-06T11:02:40Z" }
  ],
  "total": 1, "page": 1, "pageSize": 50
}
```

The findings of one run are also included in `GET /runs/:id/insights` (`regressions`).

## Related chapters

- [Run Comparison](22-run-comparison.md)
- [Performance Trends](24-performance-trends.md), which covers gradual degradation across many builds
- [Alerts](21-alerts.md)
