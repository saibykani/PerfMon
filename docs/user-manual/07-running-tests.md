# Running Tests

A test run is one execution of a performance test. Perfmon does not start load generators itself: you create a run, execute JMeter (or any other tool) with the run's Run ID, send metrics and artifacts to Perfmon, and finally complete the run. Completion triggers the analysis workflow that produces the summary, SLA evaluation, regressions, bottlenecks, insights, the performance score and the result. This section describes the full lifecycle.

## Where to find runs

Open Testing → Test Runs (`/runs`). The list supports search (Run ID, test, build, commit, tag), a status filter, sorting and paging, and refreshes every 10 seconds. While a run is `RUNNING`, its KPIs are computed live. Selecting a run opens the run detail page (`/runs/<RunID>`, tabs at `/runs/<RunID>/<tab>`). Running tests are also shown in Observability → Live Monitoring (`/live`).

## Run lifecycle overview

```text
              POST /runs                first data point            POST /runs/:id/complete
 (SCHEDULED) ----------> QUEUED  -----------------------> RUNNING ---------------------------> ANALYZING
                           |      or POST /runs/:id/start                                         |
                           |                                                                     | run.finalize job
                           | POST /runs/:id/cancel                                               v
                           v                                                  COMPLETED / FAILED / ABORTED
                       CANCELLED
```

| Status | Meaning | Accepts live metrics |
|---|---|---|
| `SCHEDULED` | Created for a future start (`scheduledAt`) | Yes (first data moves it to `RUNNING`) |
| `QUEUED` | Created and waiting for data (default) | Yes (first data moves it to `RUNNING`) |
| `RUNNING` | Data is arriving or the run was started explicitly | Yes |
| `ANALYZING` | Completion requested; the analysis job is running | No (`409`) |
| `COMPLETED` | Analysis finished, normal end | No (`409`) |
| `FAILED` | Completed with status `FAILED` (the execution itself failed) | No |
| `ABORTED` | Aborted before the planned end | No |
| `CANCELLED` | Cancelled before any execution | No |

Artifacts (HTML reports, JTL files, logs) can be uploaded in any status, including after completion.

## Step 1: Create the run

`POST /api/v1/runs` creates a run and returns its Run ID. Requires `EXECUTE_TEST` (users with `PERFORMANCE_ENGINEER` or `QA_ENGINEER` roles, administrators, or API keys with the `ingest` scope).

Identify the test either by `testId` or by names:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{
    "project": "payments",
    "application": "merchant-payments",
    "environment": "Performance",
    "test": "200 TPS Payment Load",
    "buildNumber": "104",
    "releaseVersion": "2.4.0",
    "branch": "main",
    "commit": "a1b2c3d",
    "tags": ["nightly"],
    "triggeredBy": "CI",
    "ciSystem": "jenkins",
    "ciUrl": "https://ci.example.com/job/payments-perf/104/"
  }'
```

Response (`201 Created`):

```json
{
  "id": "8d0c6f8e-2f0e-4d64-9a51-7b1b0d1f0c11",
  "runId": "PF-2026-10-06-000127",
  "status": "QUEUED",
  "ingest": {
    "metrics": "/api/v1/runs/PF-2026-10-06-000127/metrics",
    "jmeterInfluxListenerUrl": "http://localhost:3000/api/v1/ingest/influx/write?runId=PF-2026-10-06-000127",
    "artifacts": "/api/v1/runs/PF-2026-10-06-000127/artifacts",
    "complete": "/api/v1/runs/PF-2026-10-06-000127/complete"
  },
  "run": { "runId": "PF-2026-10-06-000127", "status": "QUEUED", "...": "..." }
}
```

`jmeterInfluxListenerUrl` is built from the server's `PUBLIC_URL` setting. Make sure that address is reachable from your load generators, or substitute the API address.

### Request fields

| Field | Description |
|---|---|
| `testId` | UUID of the performance test. Alternative to the name fields |
| `project`, `application`, `environment`, `test` | Names used to resolve the test. `project` matches key, name or ID; `application` matches code or name; `environment` matches name or type; `test` matches the name (case-insensitive) |
| `createTestIfMissing`, `testType` | Create the test when it is not found (application and environment are then required) |
| `runId` | Custom Run ID instead of a generated one; see [Run IDs](08-run-ids.md) |
| `executionId` | External execution identifier (up to 200 characters) |
| `buildNumber` (alias `buildId`), `version`, `releaseVersion`, `branch`, `commit` | Build and release metadata. A release and a build record are created or reused automatically |
| `tester`, `tags`, `description` | Descriptive metadata. `tester` defaults to the user's name |
| `virtualUsers`, `targetTps` | Default to the test's current load profile |
| `status` | `QUEUED` (default), `SCHEDULED` or `RUNNING`. `RUNNING` sets the start time immediately (or to `startedAt`) |
| `scheduledAt`, `startedAt` | ISO timestamps |
| `triggeredBy` | `MANUAL`, `CI`, `API` or `SCHEDULE`. Defaults to `API` for API keys and `MANUAL` for users |
| `ciSystem`, `ciUrl` | Link back to the CI job |

## Step 2: Start the test and send data

You normally do not need to start a run explicitly: the first data point received through any ingestion endpoint switches a `SCHEDULED` or `QUEUED` run to `RUNNING`, sets `startedAt` to the earliest data timestamp and records a `TEST_START` event. To mark the run as running before data arrives:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/start" -H "authorization: Bearer $PERFMON_API_KEY"
```

Send data with any of the following methods (they can be combined):

| Method | Endpoint | Section |
|---|---|---|
| JMeter Backend Listener (InfluxDB line protocol) | `POST /api/v1/ingest/influx/write?runId=<RunID>` | [JMeter Integration](09-jmeter-integration.md) |
| JSON raw samples or aggregates | `POST /api/v1/runs/<RunID>/metrics` | [JMeter Integration](09-jmeter-integration.md) |
| Infrastructure metrics (Collector) | `POST /api/v1/ingest/infrastructure` | [Live Monitoring](12-live-monitoring.md) |
| JTL file after the test | `POST /api/v1/runs/<RunID>/artifacts` (`kind=JTL`) | [Artifact Management](11-artifact-management.md) |
| JMeter HTML report | `POST /api/v1/runs/<RunID>/artifacts` (`kind=HTML_REPORT`) | [Uploading HTML Reports](10-uploading-html-reports.md) |

## Step 3: Complete the run

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/complete" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"status":"COMPLETED"}'
```

| Body field | Description |
|---|---|
| `status` | Final status after analysis: `COMPLETED` (default), `FAILED` or `ABORTED` |
| `endedAt` | ISO end time. Defaults to the end of the last metric interval received, or the current time if there is no data |
| `reason` | Free text stored as the result reason |

The body is optional. The call returns immediately with the run in status `ANALYZING`.

### Completion workflow

What happens after `POST /runs/:id/complete`:

1. **Flush.** All metrics buffered in memory for the run are written to the database.
2. **End time.** `endedAt` is set (see above); `startedAt` is filled from the first metric if it was never set.
3. **ANALYZING.** The status becomes `ANALYZING`, a `TEST_END` event is recorded and a `status` event is pushed to live viewers.
4. **Job.** A `run.finalize` background job is queued. The job runs the analysis pipeline:
   1. Summary: per-source run summaries (`live`, `jtl`, ...) and transaction statistics are computed and stored.
   2. SLA: the test's SLA profile is evaluated against the summary.
   3. Baseline: the baseline run is resolved in this order: the run's own baseline, the test's baseline, otherwise the previous `COMPLETED` run of the same test in the same environment.
   4. Bottleneck analysis: candidate components with confidence values, saturation and data gaps.
   5. Regression detection against the baseline (thresholds: P95 +10%, P99 +15%, average +10%, TPS -10%, error rate +1 point, CPU and memory +15 points by default).
   6. Reconciliation: live or JTL metrics are compared with the uploaded HTML report, if any.
   7. Insights and recommendations.
   8. Performance score (0 to 100) and result classification.
5. **Final status.** The run is set to the status requested in step 3 (`COMPLETED` by default), a final Test Execution report is queued, completion alerts are evaluated, a `REGRESSION` event is recorded when regressions were found, and a `status` event with result and score is pushed to live viewers.

Monitor progress:

```bash
curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID" -H "authorization: Bearer $PERFMON_API_KEY" | jq '{status, result, performanceScore, counts}'
curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID/jobs" -H "authorization: Bearer $PERFMON_API_KEY" | jq '.[] | {type, status, attempts, error}'
```

`counts.pending_jobs` in the run detail shows the number of `QUEUED` or `PROCESSING` jobs for the run.

### Repeated completion

- Completing a run that is already `COMPLETED`, `FAILED`, `ABORTED` or `CANCELLED` does not change its status; it only queues the analysis again.
- Completing a run that is still `ANALYZING` restarts the completion workflow (flush, end time, new `run.finalize` job). This is the recovery action for a run stuck in `ANALYZING`; see [Troubleshooting](39-troubleshooting.md).

## Results and score

| Result | Rule |
|---|---|
| `PASS` | No dimension is `WARNING` or `FAIL` |
| `PASS_WITH_WARNINGS` | At least one dimension is `WARNING`, none is `FAIL` |
| `FAIL` | At least one dimension is `FAIL`, or the run's status is `FAILED` |
| `INCONCLUSIVE` | No samples; fewer than 100 samples; or the run was `ABORTED` (unless already `FAIL`) |

Dimensions in the result breakdown: `SLA`, `TPS` (TPS SLA rule, otherwise target TPS: at least 95% passes, at least 80% warns), `P95`, `Error Rate` (SLA rule, otherwise 1% warning and 5% failure by default), `CPU` (SLA rule, otherwise CPU P90 of 80% warning and 90% failure), and `Regression` (any regression produces a warning).

The performance score is a weighted average of factor scores: SLA compliance 30, response time 20, throughput 15, error rate 15, infrastructure utilization 10, regression 10 (default weights). Factors without data are excluded and the remaining weights are renormalized. The full breakdown is returned in `scoreBreakdown`.

## Other run operations

| Operation | Endpoint | Permission | Notes |
|---|---|---|---|
| Abort | `POST /runs/:id/abort` `{reason?}` | `EXECUTE_TEST` | Same workflow as complete with final status `ABORTED` |
| Cancel | `POST /runs/:id/cancel` | `EXECUTE_TEST` | Only `SCHEDULED` or `QUEUED` runs; otherwise `409` |
| Re-analyze | `POST /runs/:id/reanalyze` | `EXECUTE_TEST` | Queues `run.reanalyze`; returns `{jobId}`; status unchanged |
| Set baseline | `POST /runs/:id/baseline` `{baseline: true or false}` | `EDIT_TEST` | One baseline per test |
| Update metadata | `PATCH /runs/:id` | `EXECUTE_TEST` | Description, tags, build, version, branch, commit, tester, virtual users, target TPS, release, baseline run |
| Delete | `DELETE /runs/:id?confirm=true` | `DELETE_RUN` | Soft delete |
| Summary text | `GET /runs/:id/summary-text` | `VIEW_RUN` | Plain-text run summary |
| Background jobs | `GET /runs/:id/jobs` | `VIEW_RUN` | Last 100 jobs of the run |

Uploading an HTML report or JTL to a run that is already finished automatically queues `run.reanalyze` after the file is processed.

## Listing runs through the API

```bash
curl -s -G "$PERFMON_URL/api/v1/runs" -H "authorization: Bearer $TOKEN" \
  --data-urlencode 'status=RUNNING,ANALYZING' --data-urlencode 'branch=main' \
  --data-urlencode 'sort=start' --data-urlencode 'order=desc' --data-urlencode 'pageSize=20' | jq '.items[] | {runId, status, result}'
```

Filters: `projectId`, `applicationId`, `environmentId`, `testId`, `status`, `result` (comma-separated), `build`, `branch`, `commit`, `tester`, `release`, `version`, `tags`, `from`, `to`, `minDuration`, `maxDuration`, `baselineOnly`, `q`.

## Related sections

- [Run IDs](08-run-ids.md)
- [JMeter Integration](09-jmeter-integration.md)
- [Live Monitoring](12-live-monitoring.md)
- [Troubleshooting](39-troubleshooting.md)
