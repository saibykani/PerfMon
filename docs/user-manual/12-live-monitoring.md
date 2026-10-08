# Live Monitoring

Live Monitoring shows a running test while it happens: throughput, response-time percentiles, errors, active users and server CPU and memory update every few seconds without reloading the page. It works with any data source that sends metrics to a run during the test, most commonly the JMeter Backend Listener ([JMeter Integration](09-jmeter-integration.md)). This chapter explains the Live Monitoring page, what each number means, how the data gets there, and how to consume the live stream from your own tools.

## Where to find it

| Place | Path | Use |
|---|---|---|
| Live Monitoring page | Observability → **Live Monitoring** (`/live`) | All running and recently finished tests, one selected at a time |
| One run | `/live/<RunID>` | Direct link, for example to share with the team during a test |
| Run detail, **Live Metrics** tab | `/runs/<RunID>/live` | The same live view inside the run page. A run that is `RUNNING` opens on this tab automatically |

Viewing live data requires the `VIEW_RUN` permission, which every role has.

## Step by step: watch a test live

1. Create a run and note its Run ID ([Running Tests](07-running-tests.md)).
2. Start JMeter with the Backend Listener pointing at `.../api/v1/ingest/influx/write?runId=<RunID>` ([Set up JMeter](00b-jmeter-setup.md)).
3. Open Observability → **Live Monitoring**. When the first metrics arrive the run switches from `QUEUED` to `RUNNING`, appears in the **Runs** list with a **LIVE** badge, and is opened automatically if no other run is selected.
4. Watch the KPIs and charts. Change the refresh interval with the **Refresh** selector if needed.
5. Optional: start the Perfmon Collector on the servers under test to see CPU and memory next to the load metrics ([Monitor servers during a test](00d-server-monitoring.md)).
6. When JMeter ends, complete the run (the wrapper scripts and CI examples do this). The page shows a **Run finished** banner and opens the final result 8 seconds later.

## The Runs list

The left-hand list contains up to 50 runs of your organization that are:

- `RUNNING`, or
- `ANALYZING`, or
- finished less than 15 minutes ago.

When a project is selected in the global project filter, only that project's runs are listed. Each entry shows the test name, Run ID, environment and four figures: **TPS**, **P95**, **Err** (error %) and **Elapsed** (for running tests) or **Dur** (duration). For running tests the figures cover the last 60 seconds; for finished runs they cover the whole run. The list refreshes every 5 seconds.

If no test is running the page shows "No test is running right now" with a link to **Browse recent runs**.

## The live view

### Status bar

| Element | Meaning |
|---|---|
| **LIVE** | The run is `RUNNING`. Otherwise the run status is shown (for example `ANALYZING`) |
| **Connected** / **Connecting…** | State of the browser's stream connection. "Live connection interrupted — retrying…" means the browser lost the connection and reconnects automatically |
| **last data Ns ago** | Time since Perfmon last stored metrics for this run. After 30 seconds without data the text turns into a warning: "no metrics received recently" |
| **elapsed** | Time since the run started |
| **Refresh** 2s / 5s / 10s / 30s | How often the server pushes an update. Default 5 seconds; your choice is remembered in this browser |

### Last 60 seconds

| KPI | Meaning |
|---|---|
| **TPS** | Average transactions per second over the last 60 seconds |
| **P95**, **P99** | Response-time percentiles over the last 60 seconds |
| **Error %** | Failed samples / all samples. Shown amber from 1%, red from 5% |
| **Users** | Peak active threads (JMeter) in the window |
| **CPU**, **Memory** | Average CPU and memory of the servers that sent infrastructure data for this run in the last 30 seconds. Amber from 80%, red from 90%. "—" when no Collector data is linked to the run |

### Totals

**Requests**, **Errors** (with error %), **Avg TPS** (with the peak TPS), **Avg RT**, **P95**, **P99** and **Peak users**, all for the whole run so far.

### Charts

Four synchronized charts (hovering one shows the same moment in all of them):

| Chart | Series |
|---|---|
| **Active users** | Active threads |
| **Throughput** | TPS |
| **Response time** | P50, P90, P95, P99 and Avg (dashed) in ms |
| **Error rate** | Error % |

The charts use 5-second buckets. Data that arrives late for a bucket that is already displayed replaces it on the next update, so the last few points can still change slightly.

### Approximate percentiles (≈)

JMeter's Backend Listener sends percentiles that JMeter computed per send interval. Perfmon cannot combine those exactly across intervals, so percentiles that span several intervals (the 60-second P95, the run totals, and charts with buckets longer than the send interval) are approximations and are shown with **≈**. Raw JSON samples and JTL imports produce exact histogram percentiles without the marker. See [JMeter Integration](09-jmeter-integration.md#percentile-accuracy).

### When the run finishes

When the run leaves `RUNNING` (completed, failed or aborted), a banner appears: "Run finished." (or "Run aborted.") with the final result and performance score as soon as the analysis is done ("Analysis in progress…" until then). After 8 seconds Perfmon opens the run's result page. Click **Stay here** to remain on the live view, or **View result** to go immediately. On the run's **Live Metrics** tab a finished run shows its recorded timeline instead, with the note that live streaming is only active while a test is `RUNNING`.

## How live data flows

```text
JMeter Backend Listener ─┐
JSON metrics API ────────┼─► ingestion ─► in-memory aggregator ─► flush (every 1 s) ─► database
Perfmon Collector ───────┘                                                     │
                                                                               ▼
Browser ◄── Server-Sent Events ◄── /runs/<RunID>/stream (reads the database every Refresh seconds,
                                                         pushes status changes immediately)
```

| Step | Detail |
|---|---|
| Ingestion | Metrics are accepted only while the run is `SCHEDULED`, `QUEUED` or `RUNNING`. The first accepted data switches the run to `RUNNING`, sets its start time and records a `TEST_START` event |
| Aggregation | Samples are buffered in memory and written to the database by a flush every `INGEST_FLUSH_INTERVAL_MS` (default 1000 ms). Each flush updates the run's last-ingest time, which drives "last data Ns ago" |
| Infrastructure | Collector data sent with a `runId`, or without one while a run of the same environment is `RUNNING`, is linked to that run and feeds the CPU and Memory KPIs ([Infrastructure Monitoring](17-infrastructure-monitoring.md#how-samples-are-linked-to-a-run)) |
| Stream | Each open live view holds one Server-Sent Events connection. On every refresh tick the server reads the latest buckets (re-sending the last 10 seconds so late data is merged), the 60-second and total KPIs, and the infrastructure averages, and pushes them as one `metrics` event. Status changes (`RUNNING`, `ANALYZING`, `CANCELLED`, final result) are pushed immediately as `status` events |
| Several backend replicas | Because each stream reads from the database, viewers see the data no matter which replica ingested it |

The number of open live connections is shown to administrators (`MANAGE_SETTINGS`) in Platform → Administration → **Platform health**.

## Using the live stream from your own tools

### List running tests

```bash
curl -s "$PERFMON_URL/api/v1/live/runs" -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq '.[] | {run_key, status, test_name, environment_name, tps: .last60s.tpsAvg, p95: .last60s.p95, errorPct: .last60s.errorPct}'
```

Optional query parameter `projectId=<project-uuid>`. API keys bound to a project only see that project. `last60s` is filled only for `RUNNING` runs; `totals` covers the whole run.

### Subscribe to a run

`GET /api/v1/runs/<RunID>/stream` returns `text/event-stream`.

| Query parameter | Default | Description |
|---|---|---|
| `interval` | `5` | Seconds between `metrics` events, 1 to 60 |
| `access_token` | — | A user JWT, for clients that cannot send an `Authorization` header (browsers' `EventSource`). API keys must be sent in the `Authorization` header instead |

```bash
curl -N -s "$PERFMON_URL/api/v1/runs/$RUN_ID/stream?interval=5" \
  -H "authorization: Bearer $PERFMON_API_KEY"
```

```text
event: metrics
data: {"run":{"status":"RUNNING","result":null,"performance_score":null,"started_at":"2026-10-06T10:30:00.000Z","ended_at":null,"live_last_ingest_at":"2026-10-06T10:41:12.411Z"},"points":[{"t":1791282600000,"count":1000,"errors":3,"tps":200,"errorPct":0.3,"avg":412,"p50":380,"p90":610,"p95":720,"p99":1180,"users":100,"min":95,"max":2210}],"step":5,"percentileMethod":"interval_weighted_approx","totals":{...},"last60s":{...},"infra":{"cpu":"54.2","mem":"61.0"}}

: ping

event: status
data: {"status":"ANALYZING"}
```

| Event | When | Content |
|---|---|---|
| `metrics` | Immediately after connecting, then every `interval` seconds | `run` (status, result, score, start/end, last ingest), `points` (time buckets: `t` epoch ms, `count`, `errors`, `tps`, `errorPct`, `avg`, `min`, `max`, `p50`, `p90`, `p95`, `p99`, `users`), `step` (bucket seconds), `percentileMethod`, `totals`, `last60s`, `infra` (`cpu`, `mem`) |
| `status` | When the run status changes | `status`, and for the final status also `result` and `score` |
| `error` | If a tick fails on the server | `message` |
| `: ping` comment | Every 15 seconds | Keeps proxies from closing an idle connection |

Merge `points` by their `t` value: a later event can contain an updated version of a bucket you already have.

### Behind a reverse proxy

The stream sets `x-accel-buffering: no` so nginx does not buffer it. Other proxies and load balancers must also have response buffering disabled for `/api/v1/runs/*/stream` and an idle timeout longer than 15 seconds; otherwise the page stays at **Connecting…** or updates in bursts.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The run never appears in the list | No data was accepted yet: check the Backend Listener URL, the Run ID and the API key (`ingest` scope); check the JMeter log for HTTP errors. A run that finished more than 15 minutes ago is no longer listed; open it from Testing → Test Runs |
| "last data Ns ago — no metrics received recently" | JMeter stopped sending: the test ended without completing the run, the load generator lost network access, or the listener queue is blocked. The run stays `RUNNING` until it is completed or aborted |
| Ingestion returns `409` | The run is already `ANALYZING` or finished; create a new run for a new test |
| **Connecting…** never turns into **Connected** | A proxy buffers or blocks Server-Sent Events, or your session expired (log in again) |
| CPU and Memory show "—" | No Collector data is linked to the run. Start the Collector with the same project and environment, or pass `runId` |
| Percentiles marked ≈ | Expected with the Backend Listener. Upload the JTL after the test for exact percentiles |

## Related sections

- [JMeter Integration](09-jmeter-integration.md)
- [Running Tests](07-running-tests.md)
- [Monitor servers during a test](00d-server-monitoring.md)
- [Infrastructure Monitoring](17-infrastructure-monitoring.md)
- [Dashboards](13-dashboards.md)
- [Alerts](21-alerts.md)
