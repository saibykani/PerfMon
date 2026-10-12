# CI/CD Examples

Copy-ready pipeline recipes for Perfmon. [CI/CD Integration](30-ci-cd-integration.md) explains the model (create run, stream, upload, complete, wait, gate) and every API field; this chapter is the practical companion: one portable script that does all the Perfmon calls, thin wrappers for GitHub Actions, GitLab CI, Jenkins and Azure DevOps, and recipes for common variations (JTL only, other load tools, gate-only jobs).

Full, long-form pipelines that do not need the helper script live in the repository folder `docs/ci/`:

| File | CI system |
|---|---|
| `docs/ci/github-actions.yml` | GitHub Actions (copy to `.github/workflows/performance.yml`) |
| `docs/ci/gitlab-ci.yml` | GitLab CI |
| `docs/ci/Jenkinsfile` | Jenkins (declarative) |
| `docs/ci/azure-pipelines.yml` | Azure DevOps |

## Before you start

| You need | How |
|---|---|
| An API key with scope `ingest` | Platform -> Administration -> API keys, or `POST /api/v1/api-keys`. The `pmk_...` secret is shown once. See [Users, roles & API keys](00e-users-and-api-keys.md). |
| Two CI secrets | `PERFMON_URL` = backend base URL **without** `/api/v1` and without a trailing slash (for example `https://perfmon-api.example.com`); `PERFMON_API_KEY` = the `pmk_...` key. |
| Project, application, environment | Created in Perfmon ([Projects](03-projects.md)). The pipeline refers to them by name/key/code. |
| A JMeter plan with the Backend Listener (for live streaming) | `influxdbUrl = ${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}`, `influxdbToken = ${__P(perfmon.apiKey)}`. See [Set up JMeter for Perfmon](00b-jmeter-setup.md). |
| Tools on the agent | `bash`, `curl`, `jq`, `zip`; Java 17+ and JMeter 5.6+ for JMeter jobs. |

Every call authenticates with `Authorization: Bearer $PERFMON_API_KEY` (the header `X-API-Key: pmk_...` is accepted too).

## The Perfmon calls used here

| Step | Call | Permission (scope `ingest` has all of them) |
|---|---|---|
| Create run | `POST /api/v1/runs` -> `runId` | `EXECUTE_TEST` (+ `CREATE_TEST` with `createTestIfMissing`) |
| Stream JMeter metrics | `POST /api/v1/ingest/influx/write?runId=<RUN_ID>` (done by JMeter) | `INGEST_METRICS` |
| Send JSON metrics (non-JMeter tools) | `POST /api/v1/runs/<RUN_ID>/metrics` | `INGEST_METRICS` |
| Upload report / JTL / logs | `POST /api/v1/runs/<RUN_ID>/artifacts` (multipart, one file per request) | `UPLOAD_ARTIFACT` |
| Complete | `POST /api/v1/runs/<RUN_ID>/complete` `{"status":"COMPLETED"\|"FAILED"\|"ABORTED"}` | `EXECUTE_TEST` |
| Abort | `POST /api/v1/runs/<RUN_ID>/abort` `{"reason":"..."}` | `EXECUTE_TEST` |
| Wait / gate | `GET /api/v1/runs/<RUN_ID>` -> `status`, `result`, `performanceScore`, `resultBreakdown.reasons` | `VIEW_RUN` |
| Build-log summary | `GET /api/v1/runs/<RUN_ID>/summary-text` | `VIEW_RUN` |
| Debug slow analysis | `GET /api/v1/runs/<RUN_ID>/jobs` | `VIEW_RUN` |

## 1. The portable helper script

Save this as `perf/perfmon.sh` in the repository that holds your test plans and make it executable (`chmod +x perf/perfmon.sh`). All CI wrappers below call it, so the Perfmon logic exists in one place.

```bash
#!/usr/bin/env bash
# perfmon.sh - minimal Perfmon client for CI pipelines.
#   perfmon.sh create                  -> prints the Run ID
#   perfmon.sh upload <RUN_ID> <KIND> <FILE> [NAME]
#   perfmon.sh complete <RUN_ID> [COMPLETED|FAILED|ABORTED]
#   perfmon.sh gate <RUN_ID>           -> waits for the analysis, exit 1 on FAIL
# Env: PERFMON_URL, PERFMON_API_KEY (required)
#      PERFMON_PROJECT, PERFMON_APPLICATION, PERFMON_ENVIRONMENT, PERFMON_TEST (create)
#      BUILD_NUMBER, BRANCH, COMMIT_SHA, CI_JOB_URL, CI_SYSTEM, RELEASE_VERSION (optional metadata)
#      PERFMON_ANALYSIS_TIMEOUT_SEC (default 900), PERFMON_FAIL_ON_INCONCLUSIVE (default false)
set -euo pipefail
: "${PERFMON_URL:?PERFMON_URL is required}" "${PERFMON_API_KEY:?PERFMON_API_KEY is required}"
API="${PERFMON_URL%/}/api/v1"
AUTH=(-H "Authorization: Bearer $PERFMON_API_KEY")

cmd="${1:-}"; shift || true
case "$cmd" in
  create)
    body=$(jq -n \
      --arg project "${PERFMON_PROJECT:?}" --arg application "${PERFMON_APPLICATION:?}" \
      --arg environment "${PERFMON_ENVIRONMENT:?}" --arg test "${PERFMON_TEST:?}" \
      --arg build "${BUILD_NUMBER:-}" --arg branch "${BRANCH:-}" --arg commit "${COMMIT_SHA:-}" \
      --arg ciUrl "${CI_JOB_URL:-}" --arg ciSystem "${CI_SYSTEM:-ci}" --arg release "${RELEASE_VERSION:-}" \
      '{project:$project, application:$application, environment:$environment, test:$test,
        createTestIfMissing:true, testType:"LOAD", triggeredBy:"CI", ciSystem:$ciSystem}
       + (if $build   != "" then {buildNumber:$build}      else {} end)
       + (if $branch  != "" then {branch:$branch}          else {} end)
       + (if $commit  != "" then {commit:$commit}          else {} end)
       + (if $ciUrl   != "" then {ciUrl:$ciUrl}            else {} end)
       + (if $release != "" then {releaseVersion:$release} else {} end)')
    curl -fsS -X POST "$API/runs" "${AUTH[@]}" -H "Content-Type: application/json" -d "$body" | jq -r .runId
    ;;
  upload)
    run="$1" kind="$2" file="$3" name="${4:-}"
    [ -s "$file" ] || { echo "skip upload: $file missing or empty" >&2; exit 0; }
    args=(-F "kind=$kind" -F source=CI -F "file=@$file")
    [ -n "$name" ] && args+=(-F "name=$name")
    curl -fsS -X POST "$API/runs/$run/artifacts" "${AUTH[@]}" "${args[@]}" | jq -c '{duplicate, message}'
    ;;
  complete)
    run="$1" status="${2:-COMPLETED}"
    curl -fsS -X POST "$API/runs/$run/complete" "${AUTH[@]}" -H "Content-Type: application/json" \
      -d "{\"status\":\"$status\"}" | jq -c '{runId, status}'
    ;;
  gate)
    run="$1"; deadline=$(( $(date +%s) + ${PERFMON_ANALYSIS_TIMEOUT_SEC:-900} ))
    while :; do
      json=$(curl -fsS "$API/runs/$run" "${AUTH[@]}")
      status=$(jq -r .status <<<"$json")
      case "$status" in COMPLETED|FAILED|ABORTED|CANCELLED) break ;; esac
      [ "$(date +%s)" -lt "$deadline" ] || { echo "analysis not finished in time (status $status)" >&2; exit 1; }
      echo "run $run is $status - waiting..."; sleep 10
    done
    result=$(jq -r '.result // "NONE"' <<<"$json")
    echo "Run $run: status=$status result=$result score=$(jq -r '.performanceScore // "n/a"' <<<"$json")"
    jq -r '.resultBreakdown.reasons // [] | .[] | "  - " + .' <<<"$json"
    curl -fsS "$API/runs/$run/summary-text" "${AUTH[@]}" || true
    case "$result" in
      PASS|PASS_WITH_WARNINGS) exit 0 ;;
      INCONCLUSIVE) [ "${PERFMON_FAIL_ON_INCONCLUSIVE:-false}" = "true" ] && exit 1 || exit 0 ;;
      *) exit 1 ;;   # FAIL or no result
    esac
    ;;
  *) echo "usage: $0 create|upload|complete|gate ..." >&2; exit 2 ;;
esac
```

Notes:

- `PASS_WITH_WARNINGS` exits 0 (the wrappers below print a warning). Change the `case` if your team wants warnings to fail the build.
- `INCONCLUSIVE` (no samples, fewer than 100 samples, or an aborted run) passes unless `PERFMON_FAIL_ON_INCONCLUSIVE=true`.
- The HTML report must be uploaded as a `.zip` of the report directory (or a single `.html`). Re-uploading the same `kind` + `name` creates a new artifact version; an identical file is detected and reported as `"duplicate": true`.

### The JMeter part (same in every CI system)

```bash
RUN_ID=$(perf/perfmon.sh create)
echo "Perfmon Run ID: $RUN_ID"

set +e
jmeter -n -t perf/payment-load.jmx -l results.jtl -j jmeter.log -e -o report \
  -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.apiKey="$PERFMON_API_KEY"
JMETER_EXIT=$?
set -e

[ -f report/index.html ] && (cd report && zip -qr ../report.zip .)
perf/perfmon.sh upload "$RUN_ID" HTML_REPORT report.zip jmeter-report
perf/perfmon.sh upload "$RUN_ID" JTL results.jtl
perf/perfmon.sh upload "$RUN_ID" LOG jmeter.log
perf/perfmon.sh complete "$RUN_ID" "$([ $JMETER_EXIT -eq 0 ] && echo COMPLETED || echo FAILED)"
perf/perfmon.sh gate "$RUN_ID"
```

Always upload and complete, even when JMeter fails; otherwise the run stays `RUNNING`.

## 2. GitHub Actions

`.github/workflows/performance.yml` (secrets `PERFMON_URL`, `PERFMON_API_KEY` under Settings -> Secrets and variables -> Actions):

```yaml
name: Performance test (Perfmon)
on:
  workflow_dispatch: {}
  schedule:
    - cron: "0 2 * * *"        # nightly
permissions:
  contents: read
jobs:
  load-test:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    env:
      PERFMON_URL: ${{ secrets.PERFMON_URL }}
      PERFMON_API_KEY: ${{ secrets.PERFMON_API_KEY }}
      PERFMON_PROJECT: payments
      PERFMON_APPLICATION: merchant-payments
      PERFMON_ENVIRONMENT: Performance
      PERFMON_TEST: 200 TPS Payment Load
      BUILD_NUMBER: ${{ github.run_number }}
      BRANCH: ${{ github.ref_name }}
      COMMIT_SHA: ${{ github.sha }}
      CI_SYSTEM: github-actions
      CI_JOB_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
      JMETER_VERSION: "5.6.3"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }
      - name: Install JMeter
        run: |
          curl -fsSL "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz" | tar -xz -C "$HOME"
          echo "$HOME/apache-jmeter-${JMETER_VERSION}/bin" >> "$GITHUB_PATH"
      - name: Create Perfmon run
        run: echo "RUN_ID=$(perf/perfmon.sh create)" >> "$GITHUB_ENV"
      - name: Run JMeter
        id: jmeter
        continue-on-error: true
        run: |
          jmeter -n -t perf/payment-load.jmx -l results.jtl -j jmeter.log -e -o report \
            -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.apiKey="$PERFMON_API_KEY"
      - name: Upload results and complete the run
        if: always() && env.RUN_ID != ''
        run: |
          [ -f report/index.html ] && (cd report && zip -qr ../report.zip .)
          perf/perfmon.sh upload "$RUN_ID" HTML_REPORT report.zip jmeter-report
          perf/perfmon.sh upload "$RUN_ID" JTL results.jtl
          perf/perfmon.sh upload "$RUN_ID" LOG jmeter.log
          perf/perfmon.sh complete "$RUN_ID" ${{ steps.jmeter.outcome == 'success' && 'COMPLETED' || 'FAILED' }}
      - name: Quality gate
        if: always() && env.RUN_ID != ''
        run: perf/perfmon.sh gate "$RUN_ID"
```

The long version with a job summary table and workflow artifacts is `docs/ci/github-actions.yml`.

## 3. GitLab CI

Variables `PERFMON_URL` and `PERFMON_API_KEY` under Settings -> CI/CD -> Variables (masked, protected):

```yaml
performance-test:
  stage: test
  image: eclipse-temurin:17-jdk
  timeout: 2h
  variables:
    JMETER_VERSION: "5.6.3"
    PERFMON_PROJECT: payments
    PERFMON_APPLICATION: merchant-payments
    PERFMON_ENVIRONMENT: Performance
    PERFMON_TEST: 200 TPS Payment Load
    CI_SYSTEM: gitlab
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - if: $CI_PIPELINE_SOURCE == "web"
  before_script:
    - apt-get update -qq && apt-get install -y -qq curl jq zip > /dev/null
    - curl -fsSL "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz" | tar -xz -C /opt
    - export PATH="/opt/apache-jmeter-${JMETER_VERSION}/bin:$PATH"
    - export BUILD_NUMBER="$CI_PIPELINE_IID" BRANCH="$CI_COMMIT_REF_NAME" COMMIT_SHA="$CI_COMMIT_SHA" CI_JOB_URL="$CI_JOB_URL"
  script:
    - RUN_ID=$(perf/perfmon.sh create) && echo "Perfmon Run ID $RUN_ID"
    - |
      set +e
      jmeter -n -t perf/payment-load.jmx -l results.jtl -j jmeter.log -e -o report \
        -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.apiKey="$PERFMON_API_KEY"
      JMETER_EXIT=$?
      set -e
      [ -f report/index.html ] && (cd report && zip -qr ../report.zip .)
      perf/perfmon.sh upload "$RUN_ID" HTML_REPORT report.zip jmeter-report
      perf/perfmon.sh upload "$RUN_ID" JTL results.jtl
      perf/perfmon.sh complete "$RUN_ID" "$([ $JMETER_EXIT -eq 0 ] && echo COMPLETED || echo FAILED)"
      perf/perfmon.sh gate "$RUN_ID"
  artifacts:
    when: always
    paths: [report/, results.jtl, jmeter.log]
```

`CI_JOB_URL` is a predefined GitLab variable and is passed through unchanged. Full version: `docs/ci/gitlab-ci.yml`.

## 4. Jenkins (declarative)

Credentials of kind *Secret text*: `perfmon-url`, `perfmon-api-key`. The agent needs Java, JMeter on the `PATH`, `curl`, `jq` and `zip`.

```groovy
pipeline {
  agent { label 'jmeter' }
  options { timeout(time: 120, unit: 'MINUTES') }
  environment {
    PERFMON_URL         = credentials('perfmon-url')
    PERFMON_API_KEY     = credentials('perfmon-api-key')
    PERFMON_PROJECT     = 'payments'
    PERFMON_APPLICATION = 'merchant-payments'
    PERFMON_ENVIRONMENT = 'Performance'
    PERFMON_TEST        = '200 TPS Payment Load'
    CI_SYSTEM           = 'jenkins'
  }
  stages {
    stage('Create run') {
      steps {
        script {
          env.RUN_ID = sh(returnStdout: true, script: '''
            BRANCH="${GIT_BRANCH:-}" COMMIT_SHA="${GIT_COMMIT:-}" CI_JOB_URL="$BUILD_URL" perf/perfmon.sh create
          ''').trim()
          echo "Perfmon Run ID: ${env.RUN_ID}"
        }
      }
    }
    stage('JMeter') {
      steps {
        script {
          env.JMETER_EXIT = sh(returnStatus: true, script: '''
            jmeter -n -t perf/payment-load.jmx -l results.jtl -j jmeter.log -e -o report \
              -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.apiKey="$PERFMON_API_KEY"
          ''').toString()
        }
      }
    }
  }
  post {
    always {
      sh '''
        [ -n "$RUN_ID" ] || exit 0
        [ -f report/index.html ] && (cd report && zip -qr ../report.zip .)
        perf/perfmon.sh upload "$RUN_ID" HTML_REPORT report.zip jmeter-report
        perf/perfmon.sh upload "$RUN_ID" JTL results.jtl
        perf/perfmon.sh complete "$RUN_ID" "$([ "$JMETER_EXIT" = 0 ] && echo COMPLETED || echo FAILED)"
      '''
      script {
        if (env.RUN_ID && sh(returnStatus: true, script: 'perf/perfmon.sh gate "$RUN_ID"') != 0) {
          currentBuild.result = 'FAILURE'
        }
      }
      archiveArtifacts artifacts: 'results.jtl,jmeter.log,report/**', allowEmptyArchive: true
    }
  }
}
```

`BUILD_NUMBER` is set by Jenkins automatically and picked up by the script. Full version (with `UNSTABLE` for warnings): `docs/ci/Jenkinsfile`.

## 5. Azure DevOps

Pipeline variables `PERFMON_URL` and `PERFMON_API_KEY` (mark the key as secret). Secret variables are not exported to scripts automatically, so map them with `env:`.

```yaml
trigger: none
schedules:
  - cron: "0 2 * * *"
    displayName: nightly
    branches: { include: [main] }
    always: true
pool:
  vmImage: ubuntu-latest
variables:
  JMETER_VERSION: "5.6.3"
  PERFMON_PROJECT: payments
  PERFMON_APPLICATION: merchant-payments
  PERFMON_ENVIRONMENT: Performance
  PERFMON_TEST: 200 TPS Payment Load
steps:
  - script: |
      curl -fsSL "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-$(JMETER_VERSION).tgz" | tar -xz -C "$HOME"
      echo "##vso[task.prependpath]$HOME/apache-jmeter-$(JMETER_VERSION)/bin"
    displayName: Install JMeter
  - script: |
      set -euo pipefail
      RUN_ID=$(perf/perfmon.sh create)
      echo "##vso[task.setvariable variable=RUN_ID]$RUN_ID"
      set +e
      jmeter -n -t perf/payment-load.jmx -l results.jtl -j jmeter.log -e -o report \
        -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.apiKey="$PERFMON_API_KEY"
      JMETER_EXIT=$?
      set -e
      [ -f report/index.html ] && (cd report && zip -qr ../report.zip .)
      perf/perfmon.sh upload "$RUN_ID" HTML_REPORT report.zip jmeter-report
      perf/perfmon.sh upload "$RUN_ID" JTL results.jtl
      perf/perfmon.sh complete "$RUN_ID" "$([ $JMETER_EXIT -eq 0 ] && echo COMPLETED || echo FAILED)"
      perf/perfmon.sh gate "$RUN_ID"
    displayName: Load test + Perfmon quality gate
    env:
      PERFMON_URL: $(PERFMON_URL)
      PERFMON_API_KEY: $(PERFMON_API_KEY)
      BUILD_NUMBER: $(Build.BuildNumber)
      BRANCH: $(Build.SourceBranchName)
      COMMIT_SHA: $(Build.SourceVersion)
      CI_SYSTEM: azure-devops
      CI_JOB_URL: $(System.CollectionUri)$(System.TeamProject)/_build/results?buildId=$(Build.BuildId)
```

Full version (separate steps, warnings via `##vso[task.complete result=SucceededWithIssues]`): `docs/ci/azure-pipelines.yml`.

## 6. Variations

### JTL only (no live streaming)

If the agent cannot reach Perfmon during the test (or you do not want a Backend Listener in the plan), skip the `-Jperfmon.*` properties and upload the `.jtl` afterwards. The run stays `QUEUED` until you complete it; percentiles are computed exactly from the raw samples when the JTL is imported.

```bash
RUN_ID=$(perf/perfmon.sh create)
jmeter -n -t perf/payment-load.jmx -l results.jtl -e -o report || STATUS=FAILED
perf/perfmon.sh upload "$RUN_ID" JTL results.jtl
(cd report && zip -qr ../report.zip .) && perf/perfmon.sh upload "$RUN_ID" HTML_REPORT report.zip jmeter-report
perf/perfmon.sh complete "$RUN_ID" "${STATUS:-COMPLETED}"
perf/perfmon.sh gate "$RUN_ID"
```

JTL processing runs in the background job worker. If it finishes after the run was completed, Perfmon re-analyses the run automatically; the gate sees the result available when the status first becomes final.

### Other load tools (k6, Gatling, Locust, custom)

Any tool can feed a run through the JSON batch endpoint `POST /api/v1/runs/<RUN_ID>/metrics`. Send raw samples (exact percentiles) or pre-aggregated points:

```bash
# raw samples: ts (epoch ms or ISO), label, elapsed (ms), success, optional responseCode/bytes/url/method/...
curl -fsS -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/metrics" \
  -H "Authorization: Bearer $PERFMON_API_KEY" -H "Content-Type: application/json" \
  -d '{"samples":[
        {"ts":1767225600000,"label":"GET /api/orders","elapsed":182,"success":true,"responseCode":200},
        {"ts":1767225600120,"label":"POST /api/pay","elapsed":641,"success":false,"responseCode":500,"failureMessage":"timeout"}]}'

# pre-aggregated points per interval: ts, transaction (omit/null = run total), count, errors, avg, p90/p95/p99, activeThreads ...
curl -fsS -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/metrics" \
  -H "Authorization: Bearer $PERFMON_API_KEY" -H "Content-Type: application/json" \
  -d '{"points":[{"ts":1767225605000,"intervalSec":5,"transaction":"Checkout","count":250,"errors":2,"avg":210,"p95":480,"p99":900,"activeThreads":50}]}'
```

Limits per request: 200,000 samples and 100,000 points, 50 MB body. The run switches from `QUEUED` to `RUNNING` on the first data. Pre-aggregated percentiles are stored as reported (they cannot be merged exactly), so prefer raw samples when the tool can export them. Field details are in [JMeter Integration](09-jmeter-integration.md).

### Gate-only job (results produced elsewhere)

A downstream job can gate on an existing run with a key that has only the `read` scope (`VIEW_RUN` is enough for `GET /runs/<RUN_ID>`):

```bash
PERFMON_API_KEY=$PERFMON_READ_KEY perf/perfmon.sh gate "$RUN_ID"
```

### Link runs to a release

Set `RELEASE_VERSION` (for example from a tag) before `perfmon.sh create`; Perfmon creates or reuses the release and links the build to it. See [Releases](29-releases.md) and [Performance Trends](24-performance-trends.md).

```bash
RELEASE_VERSION="${GITHUB_REF_NAME#v}" BUILD_NUMBER="$GITHUB_RUN_NUMBER" perf/perfmon.sh create
```

### Abort on pipeline cancellation

If the CI job is cancelled while JMeter is running, abort the run so it does not stay `RUNNING`:

```bash
trap 'curl -fsS -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/abort" -H "Authorization: Bearer $PERFMON_API_KEY" \
        -H "Content-Type: application/json" -d "{\"reason\":\"CI job cancelled\"}" >/dev/null || true' INT TERM
```

An aborted run's result is `INCONCLUSIVE` unless it already failed.

### Things the `ingest` key cannot do

Setting a run as the test baseline (`POST /api/v1/runs/<RUN_ID>/baseline`) requires `EDIT_TEST`, which API-key scopes do not grant. Promote baselines in the UI or with a user session. See [Regression Detection](23-regression-detection.md).

## Troubleshooting pipeline runs

| Symptom | Fix |
|---|---|
| `curl: (22) ... 401` | `PERFMON_API_KEY` wrong, revoked or expired; check Administration -> API keys. |
| "API key is not authorized for this project" (`400` on `create`, `403` on later calls) | The key is bound to another project. Use a key for this project or an unbound key. |
| `404` "Performance test '...' not found" | Names do not match; `perfmon.sh create` already sends `createTestIfMissing: true`, so check `PERFMON_APPLICATION` and `PERFMON_ENVIRONMENT`. |
| `409` "live metrics are only accepted for SCHEDULED, QUEUED or RUNNING runs" | The run was already completed; create one run per pipeline execution. |
| `413 PAYLOAD_TOO_LARGE` | File larger than `MAX_UPLOAD_MB` (default 512). Compress the JTL or raise the limit. |
| `429 RATE_LIMITED` from the listener | Per-key ingest limit (`INGEST_RATE_LIMIT_PER_SEC`, default 100 requests/s, burst 2x) exceeded. |
| Gate times out | Background worker disabled (`ENABLE_WORKER=false`) or busy. Inspect `GET /api/v1/runs/<RUN_ID>/jobs`. On a free host that sleeps, the first call may also take a while; see [Run Perfmon 24/7 in the cloud](00f-deploy-24x7.md). |

More error messages and fixes: [Troubleshooting](39-troubleshooting.md).

## See also

- [CI/CD Integration](30-ci-cd-integration.md)
- [Run IDs](08-run-ids.md)
- [JMeter Integration](09-jmeter-integration.md)
- [Set up JMeter for Perfmon](00b-jmeter-setup.md)
- [Uploading HTML Reports](10-uploading-html-reports.md)
- [SLA / SLO](20-sla-slo.md)
- [Security](35-security.md)
