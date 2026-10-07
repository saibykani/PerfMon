# Transactions

A transaction is a named step of your load test, such as a JMeter sampler or Transaction Controller label like `Login`, `Search` or `Checkout_Pay`. Perfmon computes statistics for every transaction in every run: request count, throughput, response time percentiles, errors and SLA status. You can then drill into one transaction to see its timeline, response codes, failures, latency distribution and history across earlier runs.

## Where to find transactions

| Location | Route | Shows |
|---|---|---|
| Observability → Transactions | `/transactions` | Transactions for the selected project, test and run |
| Run detail, Transactions tab | `/runs/<Run ID>/transactions` | The transaction table for one run |
| Transaction drill-down | `/runs/<Run ID>/transactions?name=<transaction>` | Detail for one transaction |

Run pages accept the friendly Run ID, for example `PF-2026-10-06-000127`. See [Run IDs](08-run-ids.md).

## Transaction table columns

| Column | Description |
|---|---|
| Name | Sampler or transaction label |
| Samples | Number of requests |
| Errors / Error % | Failed samples, and failed as a percentage of all samples |
| TPS | Average throughput over the run, or over the zoomed window |
| Avg, Min, Max, Median | Response times in ms |
| P90, P95, P99 | Percentiles in ms |
| Std dev | Standard deviation, when sum-of-squares data is available |
| Received / Sent KB/s | Network throughput |
| SLA status | Worst SLA result for this transaction: `PASS`, `WARNING`, `FAIL`, `NO_DATA`, or `NO_SLA` when no rule applies |
| Percentile method | `exact_histogram`, `source_reported` or `interval_weighted_approx` |

The table is sorted by sample count, highest first.

### Which data source is used

A run can have data from more than one source. Perfmon uses the first one available in this order:

1. `live`: JMeter Backend Listener / live ingestion
2. `jtl`: uploaded JTL file
3. `import`: imported metrics
4. `html_report`: statistics parsed from an uploaded JMeter HTML report

To read a specific source, pass `?source=jtl` (or another source) to the API.

### Stored statistics and zoomed windows

When a run has finished, Perfmon stores its transaction statistics during analysis, and the table shows those stored values. If you zoom the timeline, or the run is still `RUNNING`, Perfmon recomputes the statistics for the selected window. In that case the SLA status column is empty, because SLAs are only evaluated for the whole run.

## Percentile accuracy

- **Exact (histogram-merged):** when raw samples were ingested (JTL upload or JSON samples), each time bucket stores a latency histogram with about 2.5% relative precision. Percentiles for any window are computed by merging those histograms. They are never averaged.
- **Approximate (≈):** the JMeter Backend Listener reports percentiles per interval. Percentiles cannot be combined exactly, so Perfmon returns a sample-weighted average of the interval values and labels it `interval_weighted_approx`. The UI marks these values with ≈.
- **Source-reported:** a single interval or an HTML report value, shown exactly as reported.

## Drilling into a transaction

1. Open a run and go to its Transactions tab.
2. Select a transaction name.
3. The drill-down shows:
   - **Stats** for the run, or for the selected window
   - **Series**: TPS, percentiles and errors over time
   - **Response codes**: counts by code and success flag
   - **Failures**: the top 50 failure groups by error type, response code and message
   - **Latency distribution**: only when raw samples exist
   - **SLA**: the rule results for this transaction
   - **History**: the 20 most recent completed runs of the same test that have `live` or `jtl` data for this transaction, in chronological order, with samples, TPS, average, P95, P99 and error %
4. Select a point in the history to open that run.

## How transactions feed analysis

| Feature | How transactions are used |
|---|---|
| [SLA / SLO](20-sla-slo.md) | `TRANSACTION`-scope rules are matched by glob pattern (for example `Checkout_*`) |
| [Regression Detection](23-regression-detection.md) | P95, P99 and error-rate regressions per transaction; both runs need at least 30 samples |
| [Run Comparison](22-run-comparison.md) | Transactions are matched by name across 2-6 runs |
| [Performance Insights](27-performance-insights.md) | Generates a "Slowest transaction" insight with the top 3 by P95 |

Transactions are matched by **exact name**. If you rename a sampler, the old and new names are treated as different transactions, and regression detection cannot compare them.

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/runs/:id/transactions?from&to&step&source` | Transaction table |
| GET | `/runs/:id/transactions/detail?name=&from&to&source` | Drill-down |
| GET | `/runs/:id/stats?transaction=&from&to` | KPIs for one transaction and window |
| GET | `/runs/:id/latency-distribution?transaction=` | Histogram buckets (raw samples only) |
| GET | `/runs/:id/raw?table=transaction_metrics&metric=<name>&format=csv` | Raw per-interval rows |

`from` and `to` accept ISO timestamps or epoch milliseconds.

```bash
# Transaction table of a run
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/transactions" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

# Drill-down for one transaction
curl -s -G "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/transactions/detail" \
  --data-urlencode "name=Checkout_Pay" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

# Raw interval data for one transaction as CSV
curl -s -G "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/raw" \
  --data-urlencode "table=transaction_metrics" --data-urlencode "metric=Checkout_Pay" \
  --data-urlencode "format=csv" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -o checkout_pay.csv
```

Example item from the transaction table:

```json
{
  "name": "Checkout_Pay", "samples": 18240, "errors": 37, "errorPct": 0.2,
  "tps": 50.7, "avg": 412.3, "min": 88, "max": 4120, "median": 365,
  "p90": 690, "p95": 840, "p99": 1510, "stddev": 210.4,
  "receivedKbSec": 120.5, "sentKbSec": 18.2,
  "slaStatus": "PASS", "percentileMethod": "exact_histogram"
}
```

## Tips

- Give transactions stable, meaningful names (`Checkout_Pay`, not `HTTP Request 7`). Names are the key for SLAs, regressions and history.
- Upload the JTL file after a Backend Listener run. Exact percentiles from the JTL are then available alongside the live data.
- Very low-volume transactions (fewer than 30 samples) are skipped by regression detection. Their percentiles vary too much from run to run.

## Related chapters

- [API Monitoring](16-api-monitoring.md)
- [SLA / SLO](20-sla-slo.md)
- [Uploading HTML Reports](10-uploading-html-reports.md)
