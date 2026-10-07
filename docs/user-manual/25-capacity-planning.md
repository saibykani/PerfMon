# Capacity Planning

Capacity Planning estimates how much load your system can handle and what response times and CPU usage to expect at a target load. It uses your completed runs and states its assumptions explicitly. **Every capacity figure is an estimate.** Perfmon labels each projection `Estimate`, gives it a confidence level (`LOW`, `MEDIUM`, `HIGH`), names the method used, and lists its assumptions. Confirm any capacity decision with a load test at the target level.

## Where to find it

**Analysis → Capacity Planning** (`/capacity`). The page has two parts:

1. **Model**: a latency-against-load curve fitted to your completed runs, with an estimated saturation point.
2. **Projection**: enter the current and target load to get projected P95, CPU and users.

## Building the latency-vs-load model

The model uses the **100 most recent completed runs** for the selected test and/or environment. At least one of the two must be selected. Each run provides one observation:

| Field | Source |
|---|---|
| `users` | Peak users, or the run's configured virtual users |
| `tps` | Average TPS |
| `p95` | Run P95 (primary source) |
| `cpuAvg` | Average CPU of non-loadgen servers |

### Fitting rules

| Requirement | If not met |
|---|---|
| At least 3 runs with both TPS and P95 | "at least 3 runs at different load levels are needed" |
| At least 3 distinct load levels, and highest TPS at least 1.2 × lowest TPS | "Runs were executed at similar load levels (TPS range < 20%)..." |
| P95 actually changes with load | "Latency does not vary with load in the recorded runs." |

Perfmon fits two models and reports R² in normal (not logarithmic) space so the two can be compared:

- **Linear:** `P95 ≈ a + b × TPS`
- **Exponential:** `P95 ≈ e^(a + b × TPS)`. Only considered when latency grows with TPS.

The simpler linear model is kept unless the exponential model's R² is at least **0.02 higher**. Fit quality is reported as follows:

| R² | Description |
|---|---|
| ≥ 0.8 | good fit |
| ≥ 0.5 | moderate fit |
| < 0.5 | weak fit; treat projections with caution |

The best way to get a usable model is to run a step or stress test at several clearly different load levels.

### Estimated saturation point

Perfmon collects saturation candidates. Each one is an estimate with its own explanation:

1. **Observed throughput plateau**: a run in which users kept rising but TPS levelled off while latency grew (detected during run analysis)
2. **Fitted model reaches the P95 SLA**: needs a model with R² ≥ 0.5 and a run-scope P95 rule in the test's SLA profile (the critical value, otherwise the warning value). If the result is more than 1.25 × the highest measured TPS, it is flagged as extrapolated.
3. **CPU trend reaches 85%**: a linear fit of CPU against TPS across 3 or more runs with CPU data, with R² ≥ 0.5 (Utilization Law)

`estimatedSaturationTps` is the **lowest** of these candidates. The model's `notes` explain which candidates were used and every data limitation, for example approximate percentiles or too few runs with infrastructure metrics.

```bash
curl -s "$PERFMON_URL/api/v1/capacity/model?testId=$TEST_ID" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

## Projecting a target load

Projection inputs:

| Field | Required | Meaning |
|---|---|---|
| `currentTps` | Yes | Throughput measured today |
| `targetTps` | Yes | Throughput you want to plan for |
| `currentP95` | Yes | P95 measured at `currentTps` (ms) |
| `testId` | No | Uses the test's fitted model and its P95 SLA |
| `currentCpu` | No | CPU % at `currentTps`; enables the Utilization Law |
| `currentUsers`, `targetUsers` | No | For the users estimate |
| `slaP95` | No | P95 SLA in ms (overrides the test's SLA) |

### Method chosen

| Condition | Method |
|---|---|
| Fitted model available with R² ≥ 0.5 and latency rising with load | Fitted linear/exponential curve, scaled so it passes through your current P95 |
| No usable fit, but `currentCpu` given | Utilization Law `U = X × D` with M/M/1-style queueing growth `R ∝ 1 / (1 − U)` |
| Neither | Linear throughput scaling only; latency is not projected |

When CPU is known, every method treats the load as **saturated** once projected utilization reaches 98%. Beyond that, latency is reported as unbounded and `meetsSla` is `false`.

### Confidence

| Method | Starting confidence |
|---|---|
| Fitted model | `HIGH` if R² ≥ 0.8 and at least 5 runs; otherwise `MEDIUM` |
| Utilization Law | `MEDIUM` if the target is no more than 1.5 × current load and projected CPU is at most 70%; otherwise `LOW` |
| Linear only | `LOW` |

Confidence is then lowered one level when the target TPS is beyond 1.25 × the highest measured TPS (fitted model), and again when the target is more than 2 × the current load. A saturated projection is never `HIGH`.

### Outputs

| Field | Meaning |
|---|---|
| `label` | Always `Estimate` |
| `method`, `confidence`, `assumptions[]` | How the projection was made and what it assumes |
| `projected.p95` | Projected P95 at the target (null if it cannot be projected or is saturated) |
| `projected.cpuPct` | `currentCpu × targetTps / currentTps`, capped at 100. The assumptions say so when the uncapped value exceeds 100%. |
| `projected.users`, `projected.tpsPerUser` | From the current TPS per user (Little's Law reasoning, assuming the same think time) |
| `meetsSla` | Projected P95 ≤ SLA (null if there is no SLA or no projection) |
| `headroomPct` | (SLA − projected P95) / SLA × 100; without an SLA, 100 − projected CPU |
| `curve[]` | Up to 25 projected points from 0.5 × the lower load to 1.2 × the higher load |

```bash
curl -s -X POST "$PERFMON_URL/api/v1/capacity/project" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{ "testId": "'"$TEST_ID"'", "currentTps": 150, "targetTps": 240,
        "currentP95": 620, "currentCpu": 52, "currentUsers": 300 }'
```

```json
{
  "label": "Estimate",
  "method": "Fitted exponential latency-vs-throughput model from 6 completed runs, anchored to the current P95",
  "confidence": "MEDIUM",
  "projected": { "p95": 905.4, "cpuPct": 83.2, "users": 480, "tpsPerUser": 0.5 },
  "meetsSla": true, "headroomPct": 24.6,
  "assumptions": [
    "P95 SLA of 1200 ms taken from the test's SLA profile.",
    "Latency follows the fitted exponential curve (R² 0.87) measured between 60 and 180 TPS.",
    "CPU saturation (100%) expected near 288.5 TPS; projections beyond that are not meaningful.",
    "CPU scales linearly with throughput (Utilization Law): 52% × 1.6.",
    "..."
  ],
  "curve": [ { "tps": 75, "p95": 401.2 } ]
}
```

## Reading estimates responsibly

- Always read the **assumptions**. A projection that assumes CPU is the only bottleneck can be badly off when the database, connection pools or locks give out first.
- Prefer interpolation to extrapolation. Projections inside the measured TPS range are much more reliable than those beyond it.
- Approximate percentiles (≈, from interval-reported data) make the fit less certain. The model notes say when this applies.
- Use [Bottleneck Analysis](26-bottleneck-analysis.md) to find which resource is likely to limit you first, then confirm the estimate with a stress test.

## Related chapters

- [Performance Trends](24-performance-trends.md)
- [Bottleneck Analysis](26-bottleneck-analysis.md)
- [SLA / SLO](20-sla-slo.md)
