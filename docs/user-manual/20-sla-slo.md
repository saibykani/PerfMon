# SLA / SLO

Service-level objectives (SLOs) in Perfmon are grouped into **SLA profiles**. A profile is a named set of rules, each with a warning threshold, a critical threshold, or both. You attach a profile to a performance test, and Perfmon evaluates it automatically against every completed run of that test, for the run as a whole and for individual transactions. SLA results feed the run result (PASS / PASS_WITH_WARNINGS / FAIL / INCONCLUSIVE), the Performance Score, insights, alerts and reports.

## Where to find it

| Location | Route | Shows |
|---|---|---|
| Analysis → SLA / SLO | `/sla` | Page "SLA & SLO": compliance overview, per-run pass %, top violations, profile editor |
| Run detail, SLA tab | `/runs/<Run ID>/sla` | Every rule result for one run |
| Performance test settings | `/tests/<id>` | The SLA profile assigned to the test |

Editing profiles requires the `CONFIGURE_SLA` permission. Without it, the page is read-only.

## Supported metrics

| Metric key | Label | Unit | Better | Scopes | Run-level value used |
|---|---|---|---|---|---|
| `avg_rt` | Average response time | ms | Lower | Run, Transaction | Average |
| `p50` | P50 | ms | Lower | Run, Transaction | Median |
| `p90` | P90 | ms | Lower | Run, Transaction | P90 |
| `p95` | P95 | ms | Lower | Run, Transaction | P95 |
| `p99` | P99 | ms | Lower | Run, Transaction | P99 |
| `max_rt` | Max response time | ms | Lower | Run, Transaction | Max |
| `error_pct` | Error rate | % | Lower | Run, Transaction | Error % |
| `tps` | Throughput (TPS) | tps | Higher | Run, Transaction | Average TPS |
| `cpu_pct` | CPU (p90) | % | Lower | Run | CPU p90 of non-loadgen servers |
| `memory_pct` | Memory (max) | % | Lower | Run | Max memory of non-loadgen servers |
| `heap_pct` | JVM heap (max) | % | Lower | Run | Max heap used / heap max |
| `gc_pause_ms` | GC pause (max) | ms | Lower | Run | Max GC pause |
| `db_latency_ms` | DB query latency (avg) | ms | Lower | Run | Average DB query latency |

Percentile rules use the run's primary data source: live, then JTL, then import, then HTML report. If that source only has interval-reported percentiles, the evaluated value is the approximate (≈) one. See [Transactions](15-transactions.md#percentile-accuracy).

## How a rule is evaluated

Each rule has a **direction**:

- **Lower is better** (`LOWER`): the rule is breached when the value is **greater than or equal to** the threshold.
- **Higher is better** (`HIGHER`): the rule is breached when the value is **less than** the threshold.

| Status | Condition |
|---|---|
| `FAIL` | Critical threshold breached |
| `WARNING` | Warning threshold breached, critical not breached |
| `PASS` | Neither threshold breached |
| `NO_DATA` | The metric is missing for this run (for example, there was no CPU collector) |

A rule needs at least one of a warning value or a critical value.

**Transaction-scope** rules apply to every transaction whose name matches the **transaction pattern**. The pattern is a case-insensitive glob in which `*` matches any characters, for example `Checkout_*` or `*`. If no pattern is set, the rule applies to all transactions. Each transaction gets the **worst** status of the rules that apply to it, shown as its SLA status. Transactions with no matching rule show `NO_SLA`.

### SLA compliance

```text
SLA compliance % = assertions not FAIL / assertions evaluated (excluding NO_DATA) × 100
```

A `WARNING` result counts as **passed** for compliance, because the hard (critical) threshold held. The SLA page colours compliance green at 95% or more, amber at 80-95%, and red below 80%.

## Creating a profile

1. Open **Analysis → SLA / SLO** (`/sla`) and select **New** in the Profiles card.
2. Enter a **Profile name** (for example "Checkout API - production SLO"), choose the **Project**, and add a **Description** saying what the objective protects and who owns it.
3. Select **Add rule** for each objective:
   - **Metric**, **Scope** (Run or Transaction) and, for transaction scope, a **Transaction pattern**
   - **Direction** (defaults from the metric), **Warning** and/or **Critical** values. The **Unit** is defined by the metric.
   - An optional **Rule name**, which is shown in reports
4. Save. Assign the profile to one or more tests in the test settings (`slaProfileId`).

Changing a profile does **not** re-evaluate runs that were already analyzed. To apply the new rules to an existing run, re-analyze it with `POST /runs/:id/reanalyze`.

## Example profile

```bash
curl -s -X POST "$PERFMON_URL/api/v1/sla/profiles" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "projectId": "'"$PROJECT_ID"'",
    "name": "Checkout API - production SLO",
    "rules": [
      { "metric": "p95", "scope": "RUN", "warningValue": 800, "criticalValue": 1200 },
      { "metric": "error_pct", "scope": "RUN", "warningValue": 0.5, "criticalValue": 1 },
      { "metric": "tps", "scope": "RUN", "criticalValue": 150 },
      { "name": "Checkout steps P95", "metric": "p95", "scope": "TRANSACTION",
        "transactionPattern": "Checkout_*", "warningValue": 1000, "criticalValue": 1500 },
      { "metric": "cpu_pct", "scope": "RUN", "warningValue": 75, "criticalValue": 85 }
    ]
  }'
```

`PUT /sla/profiles/:id` **replaces** the name, description and the whole rule list.

## SLA in the run result

After every run, Perfmon assigns a result. Each dimension is rated PASS, WARNING, FAIL or N/A:

| Dimension | Source |
|---|---|
| SLA | Worst status of all evaluated rules |
| TPS | Run-scope `tps` rule; without one, the run's target TPS: at least 95% of target is PASS, at least 80% is WARNING, below that FAIL |
| P95 | Run-scope `p95` rule |
| Error Rate | Run-scope `error_pct` rule; without one, the defaults: **5% or more FAIL, 1% or more WARNING** |
| CPU | Run-scope `cpu_pct` rule; without one, CPU p90: **90% or more FAIL, 80% or more WARNING** |
| Regression | Any regression against the baseline is WARNING, even CRITICAL ones. Regressions never fail a run by themselves. |

| Result | Rule |
|---|---|
| `FAIL` | Execution status `FAILED`, or any dimension is FAIL |
| `PASS_WITH_WARNINGS` | No FAIL, at least one WARNING |
| `PASS` | All dimensions PASS or N/A |
| `INCONCLUSIVE` | No samples; or the run was `ABORTED` (unless already FAIL); or fewer than **100 samples** (unless already FAIL) |

Administrators can change the default error thresholds (`default_result_thresholds`).

## Performance Score

The Performance Score (0-100) combines weighted factors. The default weights are: SLA compliance 30, Response time 20, Throughput 15, Error rate 15, Infrastructure 10, Regression 10. Factors without data are left out, and the remaining weights are rescaled so they still add up. The SLA factor is the compliance %. The Response-time factor uses the run-scope P95 rule's warning value (or its critical value) as the target. The full factor breakdown is stored with the run, so the score never hides the underlying metrics.

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/sla/metrics` | Supported metrics |
| GET | `/sla/profiles?projectId` | Profiles with rules and `test_count` |
| POST | `/sla/profiles` | Create a profile |
| PUT | `/sla/profiles/:id` | Replace a profile and its rules |
| DELETE | `/sla/profiles/:id` | Delete a profile |
| GET | `/runs/:id/sla` | Results for one run: `profile`, `results`, `total`, `passed`, `failed`, `warnings`, `compliancePct` |
| GET | `/sla/summary?projectId&testId&from&to` | Compliance across runs (default: last 30 days) |

```bash
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/sla" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

curl -s "$PERFMON_URL/api/v1/sla/summary?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

To be notified about violations, create an `SLA_VIOLATION` alert rule. See [Alerts](21-alerts.md).

## Related chapters

- [Alerts](21-alerts.md)
- [Regression Detection](23-regression-detection.md)
- [Reports](28-reports.md)
