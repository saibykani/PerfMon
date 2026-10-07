# Run Comparison

Run Comparison puts 2 to 6 runs side by side: run KPIs, infrastructure, JVM and database figures, every transaction, every API endpoint, and SLA outcomes. The first run selected (**Run A**) is the reference. Perfmon shows every other run's change against Run A as a percentage, with a better / worse / neutral verdict. You can save comparisons, export them to CSV, and turn them into a COMPARISON report.

## Where to find it

| Location | Route |
|---|---|
| Analysis → Compare Runs | `/compare` |
| Direct link | `/compare?runs=PF-2026-10-01-000120,PF-2026-10-06-000127` |
| From a run (against its baseline) | `GET /runs/:id/comparison` |

The `runs` query parameter accepts friendly Run IDs or UUIDs, separated by commas, in order. The first one is Run A. See [Run IDs](08-run-ids.md).

## Selecting runs

1. Open **Analysis → Compare Runs** (`/compare`).
2. Use the run picker to add 2-6 runs. Two shortcuts are available:
   - **Last 2 runs of test**: the two most recent runs of a chosen test
   - **vs baseline**: a run together with its baseline (see below)
3. Reorder the runs if needed. The first run is the reference (Run A).
4. The URL updates with `?runs=...`, so you can bookmark or share the comparison.

### Baseline resolution

Whenever Perfmon needs "the baseline" of a run (the vs-baseline shortcut, `/runs/:id/comparison`, regression detection, insights), it chooses it in this order:

1. The **run baseline**: the baseline run set on the run itself (`baselineRunId`)
2. The **test baseline**: the run marked as baseline for the test (`POST /runs/:id/baseline`)
3. The **previous completed run** of the same test **in the same environment** that started before this run

A baseline that has been deleted is skipped. When a run is created, it inherits the test baseline. After analysis, the resolved baseline is stored on the run if none was set.

## What is compared

### Run metrics

| Metric | Unit | Better |
|---|---|---|
| TPS, Peak TPS | tps | Higher |
| Avg RT, P50, P90, P95, P99, Max RT | ms | Lower |
| Errors | % | Lower |
| Requests, Peak users, Received KB/s | - | Neutral |
| SLA pass | % | Higher |
| Performance score | 0-100 | Higher |
| CPU avg, CPU max, Memory max | % | Lower |
| Network avg | B/s | Neutral |
| Heap max | % | Lower |
| GC pause max | ms | Lower |
| DB latency avg | ms | Lower |
| DB active conns max | count | Lower |

Metrics with no value in any of the selected runs are left out.

### Change % and verdict

```text
change % (run N) = (value N - value A) / |value A| × 100
```

| Verdict | Rule |
|---|---|
| better | The change is at least 2% in the improving direction |
| worse | The change is at least 2% in the worsening direction |
| neutral | The change is under 2%, the metric is neutral, or there is no value |

If Run A's value is 0 or missing, the change cannot be calculated and is left empty.

The ±2% verdict is a display aid only. It is **not** the regression threshold. Regression detection uses its own thresholds (for example P95 +10%, with a 25 ms minimum). See [Regression Detection](23-regression-detection.md).

### Transactions and endpoints

- **Transactions** are matched by exact name. For each run the table shows samples, TPS, average, P95, P99 and error %, plus the P95 change against Run A. A transaction that is missing in a run shows an empty cell.
- **Endpoints** (method plus normalized path) show samples, average and error %, plus the average change against Run A. See [API Monitoring](16-api-monitoring.md).
- The UI colours cells by the size of the change (heat colouring), so the biggest movers stand out.

### SLA comparison

For each run, the number of SLA assertions per status (`PASS`, `WARNING`, `FAIL`, `NO_DATA`).

### Charts

Grouped bar charts show each metric family (latency, throughput, errors, infrastructure) for all selected runs.

## Percentile method notes

Each compared run includes its `summarySource` (`live`, `jtl`, `import`, `html_report`) and its `percentileMethod`. Compare percentiles with care when the methods differ:

- `exact_histogram`: merged from raw-sample histograms, with about 2.5% relative precision
- `interval_weighted_approx` (≈): a sample-weighted average of interval-reported percentiles. This is not exact, and it can differ from the exact value by more than a few percent, especially for P99.

When one run is exact and another is approximate, a small percentile difference may come from the method rather than from performance. For the most reliable comparisons, upload the JTL for every run.

## Saving, exporting and reporting

| Action | How | Permission |
|---|---|---|
| Save comparison | Name it; it is stored with its run list and project | `EXECUTE_TEST`, `CREATE_DASHBOARD` or `EXPORT_REPORT` |
| Saved list | Reopen saved comparisons for the project | View access |
| Delete saved | Owner, or a user with `MANAGE_PROJECT` | As stated |
| Export CSV | Downloads the comparison tables | View access |
| Generate report | Creates a `COMPARISON` report from the selected runs | `EXPORT_REPORT` |

See [Reports](28-reports.md) for report generation and export formats.

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/compare` | Compare `runIds` (2-6, distinct; the first is the reference) |
| GET | `/runs/:id/comparison?with=<run>` | The run against its baseline, or against the run given in `with` |
| GET | `/runs/:id/kpi-deltas` | KPI change % against the baseline |
| GET | `/comparisons?projectId` | Saved comparisons |
| POST | `/comparisons` | Save `{ name, runIds, projectId? }` |
| DELETE | `/comparisons/:id` | Delete a saved comparison |

```bash
curl -s -X POST "$PERFMON_URL/api/v1/compare" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"runIds": ["PF-2026-10-01-000120", "PF-2026-10-06-000127"]}'
```

Shape of the response (shortened):

```json
{
  "runs": [ { "run_key": "PF-2026-10-01-000120", "summarySource": "jtl", "percentileMethod": "exact_histogram" },
            { "run_key": "PF-2026-10-06-000127", "summarySource": "live", "percentileMethod": "interval_weighted_approx" } ],
  "metrics": [ { "key": "p95", "label": "P95", "unit": "ms", "better": "lower",
                 "values": [612, 745], "changes": [null, 21.7], "verdicts": ["neutral", "worse"] } ],
  "transactions": [ { "name": "Checkout_Pay", "p95": [640, 812], "p95Change": [null, 26.9] } ],
  "endpoints": [ { "endpoint": "POST /api/v1/payment", "avg": [380, 405], "avgChange": [null, 6.6] } ],
  "sla": [ { "PASS": 12, "WARNING": 1 }, { "PASS": 9, "WARNING": 2, "FAIL": 2 } ]
}
```

Save a comparison:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/comparisons" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Release 4.2 vs 4.1 - checkout", "runIds": ["PF-2026-10-01-000120", "PF-2026-10-06-000127"]}'
```

## Tips

- Compare runs of the same test, environment and load profile. Otherwise the differences reflect the setup, not the build.
- Put the older, known-good run first so that "worse" means a regression.
- Check Peak users and Requests first. If they differ a lot, the runs did not apply the same load.

## Related chapters

- [Regression Detection](23-regression-detection.md)
- [Performance Trends](24-performance-trends.md)
- [Reports](28-reports.md)
