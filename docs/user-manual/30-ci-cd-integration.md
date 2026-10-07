# CI/CD Integration

Perfmon is designed to be driven from a pipeline. A CI job creates a test run, streams live JMeter metrics while the test executes, uploads the JMeter HTML report and JTL file, completes the run and then waits for Perfmon's analysis to decide whether the build passes. Every pipeline execution becomes one Perfmon run with its own [Run ID](08-run-ids.md), linked to the build number, branch, commit and CI job URL, so a regression found in Perfmon can always be traced back to the exact build that introduced it.

This section explains the integration model, the API calls involved and the quality gate. Complete, copy-ready pipelines for GitHub Actions, Jenkins, GitLab CI and Azure DevOps are in [CI/CD Examples](42-ci-cd-examples.md) and in the repository folder `docs/ci/`.

## How a pipeline talks to Perfmon

```text
CI job                                   Perfmon backend (/api/v1)
------                                   -------------------------
1. POST /runs  (names + build metadata) ---> creates run, returns runId (PF-YYYY-MM-DD-NNNNNN)
2. jmeter -n ... (Backend Listener)      ---> POST /ingest/influx/write?runId=<RUN_ID>   (live, every few seconds)
3. jmeter -e -o report                       (HTML dashboard generated locally)
4. POST /runs/<RUN_ID>/artifacts         ---> kind=HTML_REPORT (zip)  -> extract, parse, summary
5. POST /runs/<RUN_ID>/artifacts         ---> kind=JTL                -> exact percentiles from raw samples
6. POST /runs/<RUN_ID>/complete          ---> flush, ANALYZING, analysis job queued
7. GET  /runs/<RUN_ID>  (poll)           <--- status COMPLETED/FAILED/ABORTED + result + score
8. Quality gate: result FAIL -> exit 1
```

All calls authenticate with an API key (see [Security](35-security.md)). Perfmon never connects back into your CI system for this workflow; the CI connectors on the Integrations page are optional and only used for connection tests and documentation (see [CI integration records](#ci-integration-records-optional)).

## Prerequisites

| Item | Where | Notes |
|---|---|---|
| Project, application and environment | Inventory -> Projects `/projects` | The pipeline refers to them by project key or name, application code or name, environment name or type. See [Projects](03-projects.md), [Applications](04-applications.md), [Environments](05-environments.md). |
| Performance test | Testing -> Performance Tests `/tests` | Optional: with `createTestIfMissing: true` the pipeline creates the test on first use. Attach an SLA profile for meaningful PASS/FAIL results ([SLA / SLO](20-sla-slo.md)). |
| API key with scope `ingest` | Platform -> Administration `/admin` (API keys), or `POST /api/v1/api-keys` | The secret (`pmk_...`) is shown once. Optionally bind the key to one project and set an expiry and a per-key ingest rate limit. |
| CI secrets | Your CI system | `PERFMON_URL` (backend base URL, without `/api/v1`) and `PERFMON_API_KEY`. |
| Tools on the agent | Build agent | Java 17+, JMeter 5.6+ (5.2+ for `influxdbToken`), `curl`, `jq`, `zip`. |
| Network path | Agent -> backend | The agent must reach `PERFMON_URL` over HTTPS. When the UI is hosted on Vercel, pipelines may also use the UI URL because `/api/*` is proxied, but calling the backend directly avoids an extra hop for metric streaming. |

### What the `ingest` scope allows

An API key carries no roles; its permissions come from its scopes (`backend/src/auth/rbac.ts`):

| Scope | Permissions granted |
|---|---|
| `ingest` | `VIEW_PROJECT`, `VIEW_RUN`, `EXECUTE_TEST`, `INGEST_METRICS`, `UPLOAD_ARTIFACT`, `CREATE_TEST` |
| `read` | `VIEW_PROJECT`, `VIEW_RUN`, `VIEW_REPORT`, `EXPORT_REPORT` |

`ingest` covers every call in the pipeline: creating, starting, completing and aborting runs (`EXECUTE_TEST`), streaming metrics (`INGEST_METRICS`), uploading artifacts (`UPLOAD_ARTIFACT`) and reading the run back (`VIEW_RUN`). A key bound to a project is rejected (`403 FORBIDDEN`, "API key is not authorized for this project") for runs of any other project.

## Step 1 - Create the run

`POST /api/v1/runs` creates the run and returns the Run ID. Identify the test either by `testId` (UUID) or by names:

```bash
BODY=$(jq -n --arg build "$BUILD_NUMBER" --arg branch "$BRANCH" --arg commit "$COMMIT_SHA" --arg ciUrl "$JOB_URL" \
  '{project: "payments", application: "merchant-payments", environment: "Performance", test: "200 TPS Payment Load",
    createTestIfMissing: true, testType: "LOAD",
    buildNumber: $build, branch: $branch, commit: $commit,
    triggeredBy: "CI", ciSystem: "jenkins", ciUrl: $ciUrl}')

RUN_ID=$(curl -fsS -X POST "$PERFMON_URL/api/v1/runs" \
  -H "Authorization: Bearer $PERFMON_API_KEY" -H "Content-Type: application/json" \
  -d "$BODY" | jq -r .runId)
```

| Field | Required | Meaning |
|---|---|---|
| `project` | yes (unless `testId`) | Project key, name or UUID |
| `test` | yes (unless `testId`) | Performance test name (case-insensitive) |
| `application` | for auto-create | Application code or name; also narrows the test lookup |
| `environment` | for auto-create | Environment name or type (for example `Performance` or `PERFORMANCE`) |
| `createTestIfMissing` | no | Create the test when no test with that name exists |
| `testType` | no | `LOAD`, `STRESS`, `SPIKE`, `SOAK`, `ENDURANCE`, `VOLUME`, `CAPACITY`, `SCALABILITY`, `BASELINE` (default `LOAD`) |
| `buildNumber` (alias `buildId`) | no | Creates or reuses a build record for the project |
| `releaseVersion` | no | Creates or reuses a release and links the build to it ([Releases](29-releases.md)) |
| `branch`, `commit`, `version`, `tester`, `tags[]`, `description` | no | Run metadata, searchable on the Test Runs page |
| `virtualUsers`, `targetTps` | no | Override the load profile values; `targetTps` is used by the result classification |
| `triggeredBy` | no | `MANUAL`, `CI`, `API`, `SCHEDULE` (default `API` for API keys) |
| `ciSystem`, `ciUrl` | no | Free text (max 60 chars) and a link back to the CI job |
| `status` | no | `QUEUED` (default), `SCHEDULED` or `RUNNING` |
| `runId` | no | Caller-supplied Run ID (3-64 chars, letters, digits, `.`, `_`, `-`); must be unique |

The response (`201 Created`) contains the Run ID and ready-made ingestion URLs:

```json
{
  "id": "6f1c2a8e-...",
  "runId": "PF-2026-10-06-000127",
  "status": "QUEUED",
  "ingest": {
    "metrics": "/api/v1/runs/PF-2026-10-06-000127/metrics",
    "jmeterInfluxListenerUrl": "https://perfmon.example.com/api/v1/ingest/influx/write?runId=PF-2026-10-06-000127",
    "artifacts": "/api/v1/runs/PF-2026-10-06-000127/artifacts",
    "complete": "/api/v1/runs/PF-2026-10-06-000127/complete"
  },
  "run": { "...": "full run object" }
}
```

> `jmeterInfluxListenerUrl` is built from the backend's `PUBLIC_URL` setting. If `PUBLIC_URL` points at the UI (for example a Vercel domain that proxies `/api/*`) the URL still works; otherwise build the URL yourself from `PERFMON_URL`.

A run created as `QUEUED` switches to `RUNNING` automatically when the first metrics arrive. You can also call `POST /api/v1/runs/<RUN_ID>/start` explicitly.

## Step 2 - Run JMeter with live streaming

Run JMeter in non-GUI mode. The test plan contains a Backend Listener using JMeter's built-in `InfluxdbBackendListenerClient`; Perfmon exposes an InfluxDB-compatible write endpoint, so no plugin is needed.

```bash
jmeter -n -t perf/payment-load.jmx -l results.jtl -j jmeter.log -e -o report \
  -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.apiKey="$PERFMON_API_KEY"
```

| Backend Listener parameter | Value |
|---|---|
| `influxdbMetricsSender` | `org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender` |
| `influxdbUrl` | `${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}` |
| `influxdbToken` | `${__P(perfmon.apiKey)}` (sent as `Authorization: Token pmk_...`, accepted by Perfmon) |
| `application` | Your application name |
| `measurement` | `jmeter` |
| `summaryOnly` | `false` (per-transaction metrics) |
| `percentiles` | `50;90;95;99` |

The listener posts every few seconds; Perfmon answers `204` like InfluxDB. The ingestion endpoints are excluded from the global API rate limit but have a per-key token bucket (`INGEST_RATE_LIMIT_PER_SEC`, default 100 requests/s, burst 2x). Details and alternatives (JSON batch ingestion, `.jtl` only) are in [JMeter Integration](09-jmeter-integration.md) and [Set up JMeter for Perfmon](00b-jmeter-setup.md). A ready-made test plan and wrapper scripts are on the Help page under Downloads.

If JMeter exits with a non-zero code, keep going: upload whatever was produced and complete the run with `status: "FAILED"` so the run does not stay `RUNNING`.

## Step 3 - Upload the HTML report and JTL

Upload artifacts with `multipart/form-data` to `POST /api/v1/runs/<RUN_ID>/artifacts`:

| Form field | Required | Values |
|---|---|---|
| `file` | yes | Exactly one file per request |
| `kind` | no (inferred from the extension) | `HTML_REPORT`, `JTL`, `CSV`, `JMX`, `LOG`, `SCREENSHOT`, `SERVER_LOG`, `APP_LOG`, `CONFIG`, `TEST_DATA`, `JSON`, `XML`, `PDF`, `EXCEL`, `ZIP`, `OTHER` |
| `name` | no | Logical artifact name; re-uploading the same `kind` + `name` creates a new version (HTML reports default to `jmeter-report`) |
| `description` | no | Free text |
| `source` | no | `UPLOAD`, `CI`, `API`, `SYSTEM`, `COLLECTOR` (default `API` for API keys) |

```bash
(cd report && zip -qr ../report.zip .)
curl -fsS -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts" -H "Authorization: Bearer $PERFMON_API_KEY" \
  -F kind=HTML_REPORT -F name=jmeter-report -F source=CI -F "file=@report.zip"
curl -fsS -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts" -H "Authorization: Bearer $PERFMON_API_KEY" \
  -F kind=JTL -F source=CI -F "file=@results.jtl"
```

The HTML report must be a `.zip` of the report directory (containing `index.html`, `content/`, ...) or a single `.html` file. Uploads are limited to `MAX_UPLOAD_MB` (default 512 MB). An identical file (same SHA-256) is detected and not stored twice; the response then contains `"duplicate": true`. Processing (extraction, parsing, JTL import) runs asynchronously in the background job worker. See [Uploading HTML Reports](10-uploading-html-reports.md) and [Artifact Management](11-artifact-management.md).

## Step 4 - Complete the run

```bash
curl -fsS -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/complete" \
  -H "Authorization: Bearer $PERFMON_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"COMPLETED"}'
```

The optional body accepts `status` (`COMPLETED`, `FAILED`, `ABORTED`), `endedAt` (ISO time) and `reason`. Completion flushes buffered metrics, sets the end time, marks the run `ANALYZING` and queues the analysis (summary, SLA, regression against the baseline, bottlenecks, insights, performance score and result, then the Test Execution report). Completing an already finished run is idempotent: it only re-runs the analysis.

To stop a run early use `POST /runs/<RUN_ID>/abort` (body `{ "reason": "..." }`); a `QUEUED` or `SCHEDULED` run that never started can be cancelled with `POST /runs/<RUN_ID>/cancel`.

## Step 5 - Wait for the analysis

Poll `GET /api/v1/runs/<RUN_ID>` until `status` leaves `ANALYZING`:

```bash
while :; do
  RUN=$(curl -fsS "$PERFMON_URL/api/v1/runs/$RUN_ID" -H "Authorization: Bearer $PERFMON_API_KEY")
  case "$(jq -r .status <<<"$RUN")" in COMPLETED|FAILED|ABORTED|CANCELLED) break ;; esac
  sleep 10
done
jq '{runId, status, result, performanceScore, reasons: .resultBreakdown.reasons}' <<<"$RUN"
```

Useful fields of the run object:

| Field | Meaning |
|---|---|
| `status` | `SCHEDULED`, `QUEUED`, `RUNNING`, `ANALYZING`, `COMPLETED`, `FAILED`, `ABORTED`, `CANCELLED` |
| `result` | `PASS`, `PASS_WITH_WARNINGS`, `FAIL`, `INCONCLUSIVE` (null until analysed) |
| `resultBreakdown` | Per-dimension verdicts (SLA, TPS, Error Rate, CPU, Regression, ...) and `reasons[]` |
| `performanceScore`, `scoreBreakdown` | Weighted 0-100 score ([Performance Insights](27-performance-insights.md)) |
| `summary` | Primary KPIs (requests, TPS, p50-p99.9, error %) |
| `counts.pending_jobs` | Background jobs still queued or processing for the run |

`GET /api/v1/runs/<RUN_ID>/summary-text` returns a plain-text summary suitable for build logs, and `GET /api/v1/runs/<RUN_ID>/jobs` lists the run's background jobs if you need to debug a slow analysis.

> Artifact processing that finishes after the run is complete (for example a large JTL) triggers a re-analysis automatically. The pipeline gates on the result available when the status first becomes final; the run page always shows the latest analysis.

## Step 6 - Quality gate

How the result is derived (`backend/src/analytics/score.ts`):

| Result | When |
|---|---|
| `FAIL` | The run was completed with `status: FAILED`, or any dimension is `FAIL` (an SLA rule at critical level, error rate at or above the default fail threshold of 5% when no SLA rule covers it, CPU p90 at or above 90%, TPS below 80% of `targetTps`) |
| `PASS_WITH_WARNINGS` | No failures, but at least one warning (including any detected regression) |
| `PASS` | Every evaluated dimension passed |
| `INCONCLUSIVE` | No samples, fewer than 100 samples, or the run was aborted (unless already `FAIL`) |

Recommended gate:

| Result | Pipeline action |
|---|---|
| `PASS` | Succeed |
| `PASS_WITH_WARNINGS` | Succeed, flag the build (warning / unstable) |
| `INCONCLUSIVE` | Warn by default; fail when you require a verdict (`PERFMON_FAIL_ON_INCONCLUSIVE=true` in the examples) |
| `FAIL` | Fail the build (`exit 1`) |
| Timeout waiting for analysis | Fail the build and investigate the job queue |

Default thresholds (error rate warn 1% / fail 5%), regression thresholds and score weights are configurable by administrators in Platform -> Administration (Settings), see [Data Retention](38-data-retention.md) for the settings API and [Regression Detection](23-regression-detection.md).

## Linking builds, releases and baselines

- Every run created with `buildNumber` is attached to a build record of the project; `releaseVersion` also creates or reuses a release. The Releases page (`/releases`) and the Trends page (`/trends`, group by build or release) use these links.
- The first good run can be promoted to the test's baseline with `POST /runs/<RUN_ID>/baseline` (requires `EDIT_TEST`, which the `ingest` scope does not include; use a user token or do it in the UI). New runs of the test are compared against the baseline automatically.
- Use `tags` (for example `["nightly","ci"]`) to filter runs on the Test Runs page and in the API (`GET /runs?tags=nightly`).

## CI integration records (optional)

Platform -> Integrations (`/integrations`) offers records of type `JENKINS`, `GITHUB_ACTIONS`, `GITLAB` and `AZURE_DEVOPS`. They store the CI system URL and an encrypted credential and provide a connection test; they do not trigger pipelines and are not required for the workflow above.

| Type | Credential fields | Connection test |
|---|---|---|
| `JENKINS` | `username`, `apiToken` (basic auth) | `GET <url>/api/json` |
| `GITHUB_ACTIONS` | `token`; config `repository` (owner/name) | `GET /repos/<repository>` or `GET /user` on `https://api.github.com` (or your GitHub Enterprise `/api/v3` URL) |
| `GITLAB` | `token` (read_api) | `GET /api/v4/version` with `PRIVATE-TOKEN` (default URL `https://gitlab.com`) |
| `AZURE_DEVOPS` | `token` (PAT, Build: read) | `GET <url>/_apis/projects?api-version=7.0` |

The integration's `docs` text (shown on the Integrations page and returned by `GET /api/v1/integrations/types`) contains a short pipeline recipe for each system.

## Collecting server metrics during CI runs

Run the Perfmon Collector on the systems under test (or import from Prometheus, InfluxDB or Dynatrace after the run) so the analysis can correlate latency with CPU, memory, JVM and database metrics:

```bash
PERFMON_URL=https://perfmon-api.example.com PERFMON_API_KEY=pmk_... \
PERFMON_PROJECT=payments PERFMON_ENV=Performance PERFMON_ROLE=app \
node collector/collector.mjs
```

Without `PERFMON_RUN_ID` the collector's data is attached to whichever run is `RUNNING` in that environment. See [Infrastructure Monitoring](17-infrastructure-monitoring.md), [Prometheus Integration](32-prometheus-integration.md), [InfluxDB Integration](31-influxdb-integration.md) and [Dynatrace Integration](33-dynatrace-integration.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401 UNAUTHORIZED` on every call | Wrong or revoked key, or the key expired. Check `PERFMON_API_KEY` and the key status in Administration -> API keys. |
| `403 FORBIDDEN` "Missing permission: EDIT_TEST" | The call needs a permission the `ingest` scope does not grant (for example setting a baseline). |
| `404 NOT_FOUND` "Performance test '...' not found" | The names do not match. Add `createTestIfMissing: true` with `application` and `environment`, or use `testId`. |
| `409 CONFLICT` "live metrics are only accepted for SCHEDULED, QUEUED or RUNNING runs" | The run was already completed or aborted. Create a new run per pipeline execution. |
| `429 RATE_LIMITED` from the listener | Too many requests per second for the key. Raise the key's `rateLimitPerSec` or `INGEST_RATE_LIMIT_PER_SEC`. |
| `413 PAYLOAD_TOO_LARGE` on upload | The file exceeds `MAX_UPLOAD_MB`. Compress the JTL (a gzip file is accepted when uploaded with `kind=JTL`) or raise the limit. |
| Pipeline times out waiting for analysis | The background worker is disabled (`ENABLE_WORKER=false`) or overloaded. Check `GET /runs/<RUN_ID>/jobs` and Administration -> Jobs. |

More in [Troubleshooting](39-troubleshooting.md).
