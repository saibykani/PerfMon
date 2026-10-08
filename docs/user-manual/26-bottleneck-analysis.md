# Bottleneck Analysis

When a run is analysed, Perfmon looks for the component that most likely limited performance: the database, the application CPU, memory, JVM garbage collection, the database connection pool, the load generator, error spikes, or a general throughput limit. It does this by correlating the run's P95 response time with every infrastructure series recorded during the run and by comparing with the baseline run. Each candidate gets a **confidence** between 0 and 95% and a conservative label. Correlation is evidence, not proof: the analysis tells you where to look first, it does not declare a root cause.

## Where to find the results

Bottleneck analysis has no page of its own. Its results appear in these places:

| Place | What you see |
|---|---|
| Run detail → **Overview** | The summary block **Likely bottleneck**: the top candidate if its confidence is at least 45%, otherwise "No clear bottleneck" |
| Run detail → **Insights** (`/runs/<RunID>/insights`) | The **Bottleneck candidates** card: every candidate with its category, confidence meter, correlation with response time (r) and evidence, plus the **Data gaps limiting the analysis** |
| Analysis → **Performance Insights** (`/insights`) | Insights of category Bottleneck for the top 3 candidates with at least 45% confidence, with recommendations. The **Bottleneck candidates** KPI filters to them. See [Performance Insights](27-performance-insights.md) |
| Dashboards | The **Bottleneck panel** widget (Performance group) lists the candidates of the selected run, a throughput saturation finding and evidence gaps ([Dashboard Builder](14-dashboard-builder.md)) |
| Reports | The Test Execution report (Reporting → **Reports**) contains a **Bottleneck analysis** table with up to 10 candidates |
| Regression findings | Candidates with at least 45% confidence are stored as the "likely impacted components" of each regression ([Regression Detection](23-regression-detection.md)) |

Viewing requires `VIEW_RUN`. Re-running the analysis requires `EXECUTE_TEST`.

## When the analysis runs

| Trigger | How |
|---|---|
| Run completion | `POST /api/v1/runs/<RunID>/complete` (or **Complete** in the run header) queues the analysis pipeline: summary → SLA → bottleneck → regression → insights → score and result |
| Manual | **Re-analyze** button in the run header, or `POST /api/v1/runs/<RunID>/reanalyze` |
| New results file | When an HTML report or JTL finishes processing on a run that is already `COMPLETED`, `FAILED` or `ABORTED`, the analysis is re-run automatically |

Re-analyse after you add infrastructure data, upload a JTL, or set a different baseline. Each analysis replaces the previous result.

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/reanalyze" -H "authorization: Bearer $PERFMON_API_KEY"
# {"jobId":"..."}
```

## What data it uses

| Data | Source | Required? |
|---|---|---|
| P95, TPS, active users and error % over time | The run's load-test metrics (live, JTL or imported) | Yes. Without metrics the analysis reports "No load-test metrics recorded for this run" |
| Server CPU and memory | Perfmon Collector on the servers (`server_metrics`) | Recommended |
| JVM heap and GC pauses | Collector JVM metrics | Optional |
| Database latency, slow queries, active and maximum connections | Collector database metrics | Optional |
| Baseline run | The run's baseline, the test's baseline, or the previous completed run of the same test and environment | Optional; improves database and CPU evidence |

Server roles matter. Servers with the role `loadgen` are used only for the load-generator check. For the **Application CPU** series, servers with the roles `loadgen` and `db` are excluded. Give every server the correct `PERFMON_ROLE` ([Infrastructure Monitoring](17-infrastructure-monitoring.md#server-roles)).

All series are bucketed to a common step so they can be compared point by point: 5 seconds for runs up to 15 minutes, 15 seconds up to one hour, 60 seconds for longer runs (never shorter than the longest reporting interval of the run).

## Candidates and how they are detected

| Component (as displayed) | Category | Considered when | Evidence shown |
|---|---|---|---|
| **Database** (or `Database (<service name>)`) | `DATABASE` | Any database latency data exists | DB latency baseline → current (or start → end of the run), P95 baseline → current, correlation r, "Application CPU remained moderate" when app CPU p90 is below 70%, number of slow queries |
| **Database connection pool** | `CONNECTION_POOL` | Active connections reached at least 80% of `maxConnections` | Peak pool usage %, correlation r |
| **Application CPU** | `CPU` | Any server CPU data from non-loadgen, non-db servers | CPU p90 and max, correlation r, baseline average CPU → current. If CPU p90 is below 60% the confidence is capped at 30% |
| **Server memory** | `MEMORY` | Memory peaked at 85% or more | Peak memory % |
| **JVM garbage collection** | `JVM` | Any JVM GC data exists | Max GC pause, peak heap %, correlation r, baseline max GC pause. Confidence grows with GC pauses above 200 ms and heap above 80% |
| **Load generator** | `LOAD_GENERATOR` | A `loadgen` server had CPU p90 of 80% or more | "results may be limited by the load generator rather than the system under test" |
| **Error spikes under load** | `ERRORS` | Error rate peaked at 2% or more and correlates with P95 (r above 0.5) | Peak error %, correlation r |
| **System throughput limit** | `SATURATION` | Users grew more than 20% in the second half of the run while TPS stayed flat and P95 correlates with users (r above 0.6) | User growth %, the TPS plateau, correlation r |

"Correlation r" is the Pearson correlation between the P95 series and the resource series over the buckets where both have data (at least 5 common points). r close to 1 means latency and the resource rose and fell together.

### Throughput saturation

The saturation check needs at least 10 points of users and TPS. When it fires, the analysis also records the TPS plateau and the user count at which it was reached (`analysis.saturation.atTps`, `atUsers`). This is the practical capacity of the tested configuration; see [Capacity Planning](25-capacity-planning.md) for planning beyond it.

## Confidence

For most candidates the confidence is a weighted score:

| Part | Weight | Meaning |
|---|---|---|
| Correlation | 35% | Positive correlation r between P95 and the resource (negative values count as 0) |
| Magnitude | 35% | How far the resource moved: increase vs baseline or vs the start of the run, how far above a threshold (CPU p90 above 60%, pool above 80%, memory above 85%, GC pause above 200 ms or heap above 80%, ...) |
| Corroboration | 20% | Supporting signals, for example moderate CPU together with rising DB latency, slow queries, a pool at 95%, heap above 90% |
| Data sufficiency | 10% | Number of aligned points; 30 or more give full weight |

The result is capped at **95%**: Perfmon never reports a bottleneck as certain. The throughput-limit candidate uses 50% plus 40% × r (capped at 90%).

| Confidence | Label |
|---|---|
| 80% and above | **Strong correlation** |
| 65% to 79% | **Likely bottleneck** |
| 45% to 64% | **Possible bottleneck** |
| below 45% | **Insufficient evidence** |

Only candidates with at least 45% are used elsewhere (Overview summary, insights, regression impact, report summary text). All candidates, including weak ones, are listed on the run's Insights tab, sorted by confidence.

## Data gaps

The analysis states what limited it:

| Message | Meaning and fix |
|---|---|
| No infrastructure, JVM or database metrics were collected for this run — bottleneck attribution is limited to load-test metrics. | Run the Perfmon Collector on the servers under test ([Monitor servers during a test](00d-server-monitoring.md)) |
| Fewer than 10 data points — correlations are unreliable. | The run was too short for its bucket size. Run longer tests (several minutes at steady load) |
| P95 series is derived from interval-reported percentiles (approximate). | Data came from the JMeter Backend Listener. Upload the JTL for exact percentiles and re-analyse |

When no candidate reaches 45% and there are data gaps, Perfmon creates an insight "Insufficient evidence for bottleneck attribution" listing the gaps.

## Reading the results: an example

```text
Database (payments-db)                 DATABASE       Likely bottleneck  72%
  Correlation with response time: r = 0.81
  - DB latency changed from 18ms → 64ms (baseline → current)
  - P95 changed from 640ms → 1120ms
  - Correlation between P95 and DB latency: r = 0.81
  - Application CPU remained moderate (p90 52%)
  - 37 slow queries recorded

Application CPU                        CPU            Insufficient evidence  21%
  Correlation with response time: r = 0.34
  - Application CPU p90 52%, max 66%
  - Correlation between P95 and CPU: r = 0.34
  - Average CPU baseline 49% → current 50%
```

Interpretation: response time rose together with database latency while the application servers had CPU headroom. Start with the database (slow queries, indexes, locks, pool), not with scaling the application tier. The matching recommendation in Performance Insights is "Investigate database latency".

## Using the results through the API

The candidates are part of the run:

```bash
curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID" -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq '.analysis | {bottlenecks: [.bottlenecks[] | {component, category, confidence, label, correlation}], saturation, gaps}'
```

```json
{
  "bottlenecks": [
    { "component": "Database (payments-db)", "category": "DATABASE", "confidence": 0.72, "label": "Likely bottleneck", "correlation": 0.81 },
    { "component": "Application CPU", "category": "CPU", "confidence": 0.21, "label": "Insufficient evidence", "correlation": 0.34 }
  ],
  "saturation": { "detected": false, "atTps": null, "atUsers": null, "evidence": [] },
  "gaps": []
}
```

`GET /api/v1/runs/<RunID>/insights` returns the same `analysis` object together with the run's insights, recommendations and regressions. Each candidate also has an `evidence` array of plain-text lines.

A CI gate on the top candidate:

```bash
TOP=$(curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID" -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq -r '([.analysis.bottlenecks[]? | select(.confidence >= 0.65)][0] // empty) | "\(.component) (\(.label))"')
[ -n "$TOP" ] && echo "::warning::Likely bottleneck: $TOP"
```

## Getting better results

- Run the Collector on application, database and load-generator hosts with correct roles; JVM and database metrics enable the GC, database and pool candidates.
- Hold a steady load long enough to collect at least 30 buckets (for example 3 minutes at the 5-second step).
- Keep a stable baseline per test and environment, so "baseline → current" evidence is available ([Run Comparison](22-run-comparison.md)).
- Upload the JTL to replace approximate Backend Listener percentiles with exact ones, then re-analyse.
- Treat a **Load generator** candidate as a test-validity problem first: fix the load generator before trusting the other results.

## Related sections

- [Performance Insights](27-performance-insights.md)
- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [JVM Monitoring](18-jvm-monitoring.md)
- [Database Monitoring](19-database-monitoring.md)
- [Regression Detection](23-regression-detection.md)
- [Capacity Planning](25-capacity-planning.md)
