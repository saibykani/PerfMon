# Performance Insights

Every time a run is analysed, Perfmon turns the numbers into a short list of **insights**: plain-language findings such as "P95 increased by 24%", "Error rate 2.31%" or "Likely bottleneck: Database (payments-db)", each with its evidence, a severity and, where useful, a **recommendation** with a priority. The analysis also computes the run's **Performance Score** (0 to 100). This chapter explains where insights appear, every rule that produces them, the Performance Insights page, the score, and the API.

## Where to find insights

| Place | Path | Content |
|---|---|---|
| Performance Insights page | Analysis → **Performance Insights** (`/insights`) | Insights of all runs in the selected project, test and time range, with search, filters, grouping, a category chart and recurring findings |
| One run on the Insights page | `/insights?run=<RunID>` | Only that run's insights |
| Run detail → **Insights** tab | `/runs/<RunID>/insights` | The run's insights, the **Bottleneck candidates**, the **Recommendations** sorted by priority, and the **Regressions & improvements vs baseline** table |
| Run detail → **Overview** | `/runs/<RunID>` | The summary of the main finding, likely bottleneck and recommendation |
| Run header | Score badge | The Performance Score with its **Score breakdown** |

Viewing requires `VIEW_RUN`. Re-running the analysis requires `EXECUTE_TEST`.

## When insights are generated

Insights are produced by the run analysis, never while the test is still running:

1. When the run is completed (`POST /api/v1/runs/<RunID>/complete` or **Complete** in the run header).
2. When someone clicks **Re-analyze** in the run header (`POST /api/v1/runs/<RunID>/reanalyze`).
3. Automatically, when an HTML report or JTL finishes processing on a run that is already finished.

Each analysis **replaces** the run's insights and recommendations. Re-analyse after changing the SLA profile, the baseline, or after adding infrastructure data.

## Insight rules

Each insight has a category, a severity (`CRITICAL`, `WARNING`, `INFO`) and a title. "Baseline" means the run's baseline, the test's baseline, or otherwise the previous completed run of the same test and environment ([Run Comparison](22-run-comparison.md)).

| Category | Title (example) | Produced when | Severity | Recommendation (priority) |
|---|---|---|---|---|
| Latency | **P95 increased by 24%** | A baseline exists and run P95 changed by 5% or more | `CRITICAL` above +20%, `WARNING` above +10%, otherwise `INFO` | Above +10% and a bottleneck candidate of at least 45% exists: the recommendation of that candidate (HIGH) |
| Improvement | **P95 improved by 12%** | Same check, P95 went down | `INFO` | — |
| Bottleneck | **Likely bottleneck: Database (payments-db)** | One insight for each of the top 3 bottleneck candidates with at least 45% confidence | `WARNING` from 65% confidence, otherwise `INFO` | The candidate's recommendation (HIGH from 65%, otherwise MEDIUM) |
| Bottleneck | **Insufficient evidence for bottleneck attribution** | No candidate reached 45% and the analysis reported data gaps | `INFO` | — |
| Infrastructure | **CPU sustained above 85%** | Application CPU p90 of 85% or more | `CRITICAL` | Investigate CPU saturation (HIGH) |
| Infrastructure | **CPU remained below 60%** | Application CPU never exceeded 60% | `INFO` | — |
| JVM | **JVM heap above 90%** | JVM heap usage peaked at 90% or more | `WARNING` | Investigate GC behaviour (MEDIUM) |
| Errors | **Error rate 2.31%** | Run error rate of 1% or more; evidence lists the top 3 error types | `CRITICAL` from 5%, otherwise `WARNING` | Analyse failing requests (HIGH from 5%, otherwise MEDIUM) |
| Latency | **Long latency tail** | P99 is at least 4 times the median and above 500 ms | `INFO` | Investigate tail latency (LOW) |
| Latency | **Slowest transaction: Checkout** | Always when transaction statistics exist; evidence lists the top 3 transactions by P95 with their TPS | `INFO` | — |
| Regression | **3 performance regressions vs baseline** | Regression detection found regressions; evidence lists up to 6 | `CRITICAL` if any regression is critical, otherwise `WARNING` | Review changes since baseline (HIGH) |
| Improvement | **2 performance improvements vs baseline** | Regression detection found improvements | `INFO` | — |
| SLA | **2 SLA violations** | SLA rules with status FAIL; evidence lists up to 8 with the measured value and the threshold | `CRITICAL` | — |
| Data quality | **Percentiles are approximate** | The run's percentiles come from interval-reported values (JMeter Backend Listener) | `INFO` | Improve measurement accuracy (LOW) |
| Data quality | **Live metrics and HTML report disagree** | The reconciliation check found differences above tolerance | `WARNING` | — |
| Data quality | **No load-test metrics** | The run has no metrics at all (this is then the only insight) | `WARNING` | — |

"Application CPU" is measured on all servers linked to the run except those with the role `loadgen`. The thresholds above are fixed; regression thresholds are configurable ([Regression Detection](23-regression-detection.md)) and SLA thresholds come from the SLA profile ([SLA / SLO](20-sla-slo.md)).

### Recommendations

| Recommendation | Given for | Advice (abridged) |
|---|---|---|
| Investigate CPU saturation | CPU | CPU-intensive operations, thread contention, insufficient capacity: scale out or optimise hot paths |
| Investigate database latency | Database bottleneck | Slow queries, missing indexes, locks, connection-pool utilization |
| Review connection pool sizing | Connection-pool bottleneck | Pool size, connection hold times, long-running transactions |
| Investigate GC behaviour | JVM | Heap sizing, allocation rate, GC tuning or a low-pause collector |
| Investigate memory pressure | Memory bottleneck | Leaks (heap growth over time), cache sizing, swap |
| Scale the load generator | Load-generator bottleneck | Add load generators or reduce threads per node before trusting the results |
| Throughput limit reached | Saturation | Identify the limiting resource; this is the practical capacity of the configuration |
| Analyse failing requests | Errors | Error breakdown by response code and endpoint, timeout settings |
| Review changes since baseline | Regressions | Code, configuration and infrastructure changes between the builds, most regressed transactions first |
| Investigate tail latency | Long latency tail | Lock contention, GC pauses, cold caches, slow dependencies |
| Improve measurement accuracy | Approximate percentiles | Send raw samples (JTL or JSON samples) for exact percentiles |

Recommendations are listed by priority (HIGH, MEDIUM, LOW) on the run's Insights tab and attached to their insight on the Performance Insights page.

### Confidence

Bottleneck insights carry a confidence and a label: **Strong correlation** (80% and above), **Likely bottleneck** (65%), **Possible bottleneck** (45%) and **Insufficient evidence**. The wording is deliberately conservative: correlation is evidence, not proof of the root cause. How confidence is computed is described in [Bottleneck Analysis](26-bottleneck-analysis.md#confidence).

## The Performance Insights page

### Step by step

1. Open Analysis → **Performance Insights**.
2. In the filter bar choose the project, optionally a test, and the time range (insights are filtered by the time they were generated). Optionally set an auto-refresh interval.
3. Read the KPI row. Click **Critical**, **Warnings** or **Bottleneck candidates** to filter to them.
4. Look at **Recurring across runs** for findings that keep coming back, and click one to show only that finding.
5. Narrow the list with the search box, severity, confidence and category pills; switch between **Cards** and **Table**.
6. Click a Run ID to open the run, or the affected component or transaction to search for it across all insights.

### KPIs

| KPI | Meaning |
|---|---|
| **Insights** | Number of insights loaded (the latest 500 in the range; "latest N of M" if there are more) |
| **Critical**, **Warnings** | Insights with that severity |
| **Runs affected** | Runs with at least one insight |
| **Bottleneck candidates** | Bottleneck insights rated **Possible bottleneck** or stronger |
| **High-priority actions** | Recommendations with priority HIGH |

### Chart and recurring findings

- **Insights by category**: one bar per category, split by severity. Click a bar to filter by that category.
- **Recurring across runs**: findings whose title (with numbers ignored, so "P95 increased by 24%" and "P95 increased by 31%" count as the same finding) appears in two or more runs. Data-quality insights are excluded; up to 6 are shown, worst severity first, with the number of runs and a link to the latest one.

### Filters, grouping and views

| Control | Options |
|---|---|
| Search box | Title, description, Run ID, test, component, evidence and recommendation titles |
| Severity | **Any severity**, **Critical**, **Warning**, **Info** |
| Confidence | **Any confidence**, **Strong correlation**, **Likely bottleneck or stronger**, **Possible bottleneck or stronger** |
| Category pills | Bottleneck, Latency, Errors, Infrastructure, JVM, Regression, Improvement, SLA, Data quality (with counts; several can be selected) |
| **Group by** | **Run** (default), **Category**, **Severity**, **Test**, **No grouping**. The first 6 groups are expanded; **Expand all** opens the rest |
| **View** | **Cards** (each insight with evidence and recommendations; INFO cards start collapsed) or **Table** (sortable, exportable, with Severity, Category, Insight, Confidence, Affected, Run, Test, Recs and Created columns) |

**Clear filters** resets everything except the filter bar.

## Performance Score

The analysis also computes a Performance Score from 0 to 100. It is a weighted average of six factor scores; factors without data are left out and the remaining weights are renormalized, so a run without an SLA profile or infrastructure data is still scored on what is known.

| Factor | Default weight | Factor score |
|---|---|---|
| SLA compliance | 30 | Percentage of SLA assertions that passed. Left out without an SLA profile |
| Response time | 20 | 100 if P95 is within the run-level P95 SLA target; otherwise reduced by the percentage the target is exceeded (P95 at twice the target scores 0). Left out without a P95 SLA rule |
| Throughput | 15 | Average TPS as a percentage of the run's target TPS, or of the baseline's TPS when there is no target (capped at 100). Left out without either |
| Error rate | 15 | 100 − 20 × error %: 0% errors = 100, 5% or more = 0 |
| Infrastructure utilization | 10 | The lower of: CPU (100 up to a p90 of 70%, falling to 0 at 100%) and memory (100 up to a peak of 80%, falling to 0 at 100%). Left out without infrastructure data |
| Regression | 10 | 100 − 25 per critical regression − 10 per warning regression. Left out without a baseline |

Example: SLA 90, response time 100, throughput 96, error rate 94, no infrastructure data, regression 90. Active weights 30+20+15+15+10 = 90, so the score is (90×30 + 100×20 + 96×15 + 94×15 + 90×10) / 90 = 93.9, rounded to 94.

The score is shown in the run header; open **Score breakdown** to see every factor with its weight, factor score and detail (for example "P95 812 ms vs target 1000 ms" or "No baseline"). The score and the PASS / FAIL result are separate: the result is decided by the rules in [Running Tests](07-running-tests.md#results-and-score), the score summarises quality for trends and comparison.

### Changing the weights

Administrators (`MANAGE_SETTINGS`) change the weights in Platform → Administration → **Settings** → **Performance Score weights** (**Defaults** restores the defaults), or through the API. Each weight is a number from 0 to 1000; at least one must be greater than 0. Weights are relative, they do not need to add up to 100. Fields you leave out keep their current value.

```bash
curl -s -X PUT "$PERFMON_URL/api/v1/admin/settings/score_weights" \
  -H "authorization: Bearer $PERFMON_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"sla": 40, "responseTime": 25, "throughput": 10, "errorRate": 15, "infrastructure": 5, "regression": 5}'
```

New weights apply to runs analysed afterwards. Re-analyse older runs if you want their scores recomputed.

## API

### Insights across runs

`GET /api/v1/insights`

| Parameter | Description |
|---|---|
| `projectId`, `testId` | Restrict to a project or test (UUIDs). API keys bound to a project only see that project |
| `runId` | One run (Run ID or UUID) |
| `category` | Comma-separated, for example `BOTTLENECK,LATENCY` (`LATENCY`, `IMPROVEMENT`, `BOTTLENECK`, `INFRASTRUCTURE`, `JVM`, `ERRORS`, `REGRESSION`, `SLA`, `DATA_QUALITY`) |
| `severity` | Comma-separated, for example `CRITICAL,WARNING` |
| `from`, `to` | Time the insight was generated |
| `page`, `pageSize` | Paging; `pageSize` 1 to 500, default 50 |

```bash
curl -s -G "$PERFMON_URL/api/v1/insights" -H "authorization: Bearer $PERFMON_API_KEY" \
  --data-urlencode "runId=$RUN_ID" --data-urlencode "severity=CRITICAL,WARNING" \
  | jq '.items[] | {severity, category, title, evidence, recommendations: [.recommendations[] | "\(.priority) \(.title)"]}'
```

```json
{
  "severity": "CRITICAL",
  "category": "LATENCY",
  "title": "P95 increased by 24%",
  "evidence": [
    "P95 812 ms → 1.01 s (+24.4%) vs baseline PF-2026-10-01-000120",
    "TPS remained stable (199.4 vs 200.1)",
    "CPU p90 52%",
    "DB latency 18 ms → 64 ms"
  ],
  "recommendations": ["HIGH Investigate database latency"]
}
```

Each item also contains `id`, `runId`, `runKey`, `testName`, `description`, `confidence`, `confidenceLabel`, `component` and `createdAt`. Items are sorted newest first.

### One run

`GET /api/v1/runs/<RunID>/insights` returns `insights` (critical first), `recommendations` (HIGH first), `regressions`, `analysis` (bottlenecks, saturation, data gaps, baseline), `result`, `resultBreakdown`, `score` and `scoreBreakdown`.

```bash
curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID/insights" -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq '{score, result, critical: [.insights[] | select(.severity == "CRITICAL") | .title], todo: [.recommendations[] | select(.priority == "HIGH") | .title]}'
```

Use this in CI to print the findings next to the quality gate ([CI/CD Integration](30-ci-cd-integration.md)).

## Tips

- Set a baseline for each test and environment; without one there are no "P95 increased" or regression insights.
- Run the Collector during tests; the CPU, JVM and bottleneck insights need infrastructure data.
- Attach an SLA profile to the test; SLA violations and two score factors depend on it.
- Upload the JTL after Backend Listener tests to remove the "Percentiles are approximate" finding.
- Use **Recurring across runs** to separate one-off noise from problems that keep coming back.

## Related sections

- [Bottleneck Analysis](26-bottleneck-analysis.md)
- [Regression Detection](23-regression-detection.md)
- [SLA / SLO](20-sla-slo.md)
- [Run Comparison](22-run-comparison.md)
- [Transactions](15-transactions.md)
- [CI/CD Integration](30-ci-cd-integration.md)
