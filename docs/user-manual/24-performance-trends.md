# Performance Trends

Performance Trends shows how key metrics change across many runs: by date, by build or by release. It also flags **gradual degradation** that a single run-to-baseline comparison can miss. For example, P95 might grow 3% with every build: no individual build crosses the 10% regression threshold, but over eight builds the system is 25% slower. Trends catches that by fitting a line through the series and counting consecutive steps that got worse.

## Where to find it

**Analysis → Trends** (`/trends`). Choose a project and optionally a test, environment and application, a grouping (date, build or release), and a time range.

The Overview page (`/`) also shows a short chronological trend of recent completed runs.

## Trend metrics

| Key | Label | Better | Unit | Change measured as |
|---|---|---|---|---|
| `p95` | P95 | Lower | ms | Relative % |
| `p99` | P99 | Lower | ms | Relative % |
| `avgRt` | Average response time | Lower | ms | Relative % |
| `tps` | Throughput (TPS) | Higher | tps | Relative % |
| `errorPct` | Error rate | Lower | % | Absolute points |
| `cpuAvg` | CPU average | Lower | % | Absolute points |
| `slaPassPct` | SLA compliance | Higher | % | Absolute points |
| `score` | Performance score | Higher | 0-100 | Absolute points |

Values come from each run's primary summary (live, then JTL, then import, then HTML report). `cpuAvg` is the average CPU of non-loadgen servers during the run. Percentiles inherit their run's percentile method: runs fed only by the Backend Listener have approximate (≈) percentiles.

## Grouping

| `groupBy` | One point per | Order | Runs left out |
|---|---|---|---|
| `date` (default) | Completed run | Start time | None |
| `build` | Latest completed run per test + environment + build number | Natural numeric order when every build number is numeric or dotted (for example `1.10` after `1.9`); otherwise by time | Runs without a build number |
| `release` | Latest completed run per test + environment + release version | Release deployment date (or its creation date) | Runs without a release or version |

Only runs with status `COMPLETED` are included, and at most the **500 most recent** runs in the selected range. When the selection covers several test + environment combinations, point labels include the test name, and degradation is evaluated separately for each combination.

## Degradation detection

For each metric and each test + environment series with **at least 3 points**, Perfmon calculates:

- **Slope and R²**: an ordinary least-squares line through the values, with the step index (1st, 2nd, 3rd point...) as x.
- **Consecutive worse**: counting back from the newest point, how many steps in a row got worse by more than a small tolerance. The tolerance is 0.05 points for error rate, 0.5 points for the other point-based metrics, and 1% of the previous value for relative metrics.
- **Overall change**: from the first point to the last.

A change is **significant** when:

| Metric type | Significant overall change |
|---|---|
| Relative (`p95`, `p99`, `avgRt`, `tps`) | 5% or more |
| `errorPct` | 0.5 points or more |
| `score` | 5 points or more |
| `cpuAvg`, `slaPassPct` | 2 points or more |

### Direction

| Direction | Rule |
|---|---|
| `DEGRADING` | (slope in the worse direction **and** R² ≥ 0.5 **and** significant **and** last value worse than first) **or** 3 or more consecutive worse steps |
| `IMPROVING` | Slope in the better direction, R² ≥ 0.5, significant, last value better than first |
| `STABLE` | Otherwise |

### Severity

| Severity | Rule |
|---|---|
| `CRITICAL` | Degrading **and** (4 or more consecutive worse steps **or** a large total change: relative 25% or more, error rate 2 points or more, score 15 points or more, CPU / SLA 10 points or more) |
| `WARNING` | Degrading, not critical |
| `INFO` | Improving or stable |

Results are sorted with degrading first, then improving, then stable. Within each group, they are sorted by severity. Each result has a readable message, for example:

```text
P95 is degrading: 512 ms (Build 118) → 655 ms (Build 125), +27.9%; trend +3.6% per build (R² 0.91), worse in 4 consecutive builds.
```

## Trends compared with regression detection

| | Regression detection | Trends |
|---|---|---|
| Compares | One run against its baseline | A series of runs |
| Catches | Step changes larger than the thresholds | Slow drift and repeated small losses |
| Scope | Run, transaction, infrastructure | Run-level metrics |
| Output | Regression and improvement findings | Degrading / improving / stable per metric |

Use both. A run can pass regression detection against the previous build and still be part of a degrading trend.

## REST API

`GET /trends?projectId&testId&environmentId&applicationId&groupBy=build|release|date&from&to`

`from` and `to` accept ISO timestamps or epoch milliseconds.

```bash
curl -s "$PERFMON_URL/api/v1/trends?testId=$TEST_ID&environmentId=$ENV_ID&groupBy=build" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

```json
{
  "groupBy": "build",
  "points": [
    { "key": "118", "label": "Build 118", "runKey": "PF-2026-09-12-000101", "buildNumber": "118",
      "releaseVersion": "4.1.0",
      "metrics": { "p95": 512, "p99": 980, "avgRt": 240, "tps": 152.1, "errorPct": 0.12,
                   "cpuAvg": 48.0, "slaPassPct": 100, "score": 92 } }
  ],
  "degradation": [
    { "metric": "p95", "direction": "DEGRADING", "slopePerStep": 18.2, "r2": 0.91,
      "consecutiveWorse": 4, "changePct": 27.93, "severity": "CRITICAL", "message": "P95 is degrading: ..." }
  ]
}
```

## Tips

- Pass a build number (and a release version) when you create runs from CI. Trends by build only include runs that have one. See [CI/CD Integration](30-ci-cd-integration.md).
- Keep load profiles stable within a series. Otherwise the trend shows the change in workload, not in the system.
- Filter to a single test and environment to get one clean series.

## Related chapters

- [Regression Detection](23-regression-detection.md)
- [Releases](29-releases.md)
- [Capacity Planning](25-capacity-planning.md)
