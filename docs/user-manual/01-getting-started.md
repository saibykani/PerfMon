# Getting Started

Perfmon is a performance engineering platform built around Apache JMeter. It is the central place to record load test executions, stream live metrics while a test runs, store JMeter HTML reports and other artifacts, and analyse every run against SLAs, baselines and previous builds. Every metric, artifact, insight and report in Perfmon belongs to exactly one test run, identified by a human-readable **Run ID** such as `PF-2026-10-06-000127`. This section walks you through signing in, understanding the core concepts and executing your first monitored JMeter test.

## Prerequisites

| Requirement | Notes |
|---|---|
| A running Perfmon deployment | `docker compose up --build` from the repository root starts the full stack (see [Architecture](02-architecture.md)). |
| A Perfmon user account | The first administrator is created at startup from `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD`. |
| Apache JMeter 5.x | Required only for JMeter-based tests. No Perfmon plugin is needed. |
| `curl` (and optionally `jq`) | Used in the examples throughout this manual. |

Default endpoints of the Docker Compose stack:

| Service | URL | Purpose |
|---|---|---|
| Perfmon UI | `http://localhost:3000` | Web application (nginx, proxies `/api/` to the backend) |
| API and Swagger | `http://localhost:8080/api/docs` | REST API under `/api/v1`, interactive OpenAPI documentation |
| Report sandbox origin | `http://localhost:8081` | Serves uploaded HTML reports in a CSP sandbox |
| MinIO console | `http://localhost:9001` | Object storage for artifacts |

> In the examples, `PERFMON_URL` is the base URL of the API, for example `http://localhost:8080` (direct) or `http://localhost:3000` (through the UI's reverse proxy). All API paths start with `/api/v1`.

## Signing in

1. Open the Perfmon UI and sign in with your email address and password.
2. After ten consecutive failed attempts the account is locked for 15 minutes (`423 ACCOUNT_LOCKED`).
3. Sessions use a JWT that expires after `JWT_EXPIRES_IN` (default `12h`).

To obtain a token for API calls:

```bash
export PERFMON_URL=http://localhost:8080
TOKEN=$(curl -s -X POST "$PERFMON_URL/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@perfmon.local","password":"<password>"}' | jq -r .token)

curl -s "$PERFMON_URL/api/v1/auth/me" -H "authorization: Bearer $TOKEN" | jq '.email, .roles'
```

## Authentication options

| Credential | How to send it | Typical use |
|---|---|---|
| User JWT | `Authorization: Bearer <JWT>` | Browser sessions, ad-hoc scripts |
| API key (`pmk_...`) | `Authorization: Bearer pmk_...`, `Authorization: Token pmk_...` or `X-API-Key: pmk_...` | JMeter, CI/CD pipelines, the Perfmon Collector |
| API key in query string | `?apiKey=`, `?p=` or `?token=` (only on `/api/v1/ingest/influx/...`) | InfluxDB-compatible clients that cannot set headers |
| JWT in query string | `?access_token=<JWT>` (only on `/stream` endpoints) | Browser `EventSource` for live monitoring |

API keys carry scopes. The `ingest` scope grants `VIEW_PROJECT`, `VIEW_RUN`, `EXECUTE_TEST`, `INGEST_METRICS`, `UPLOAD_ARTIFACT` and `CREATE_TEST`; the `read` scope grants `VIEW_PROJECT`, `VIEW_RUN`, `VIEW_REPORT` and `EXPORT_REPORT`. A key can be bound to a single project and can have its own ingestion rate limit. Only the SHA-256 hash of a key is stored, so the secret is shown once at creation.

## Core concepts

Perfmon organises data in a strict hierarchy:

```text
Organization
└── Project                    (e.g. payments)
    └── Application            (e.g. merchant-payments)
        └── Environment        (e.g. Performance, type PERFORMANCE)
            └── Performance Test   (e.g. "200 TPS Payment Load", versioned load profile)
                └── Test Run       (Run ID PF-2026-10-06-000127)
                    ├── metrics (live, JTL, HTML report)
                    ├── artifacts (HTML report, JTL, JMX, logs, ...)
                    └── analysis (summary, SLA, regressions, bottlenecks, insights, score, result)
```

| Concept | Section |
|---|---|
| Projects, applications, environments | [Projects](03-projects.md), [Applications](04-applications.md), [Environments](05-environments.md) |
| Performance tests and load profiles | [Performance Tests](06-performance-tests.md) |
| Runs, statuses and the completion workflow | [Running Tests](07-running-tests.md), [Run IDs](08-run-ids.md) |
| Streaming JMeter metrics | [JMeter Integration](09-jmeter-integration.md) |
| HTML reports and other files | [Uploading HTML Reports](10-uploading-html-reports.md), [Artifact Management](11-artifact-management.md) |
| Watching a test in real time | [Live Monitoring](12-live-monitoring.md) |

## Navigating the UI

The sidebar groups pages by purpose. The pages referenced in this part of the manual are:

| Sidebar section | Label | Route |
|---|---|---|
| Perfmon | Overview | `/` |
| Inventory | Projects | `/projects` |
| Inventory | Applications | `/applications` |
| Testing | Performance Tests | `/tests` |
| Testing | Test Runs | `/runs` (run detail: `/runs/<RunID>`) |
| Observability | Live Monitoring | `/live` (single run: `/live/<RunID>`) |
| Reporting | Artifacts | `/artifacts` |
| Platform | Administration | `/admin` |
| Platform | Help & Documentation | `/help` |

> Perfmon is delivered in phases. Some UI modules display "This module is being built." In that case every operation described in this manual is available through the REST API, which is the authoritative interface (see Swagger at `/api/docs`).

## Quick start: your first monitored test

The following sequence creates the inventory, creates a run, streams metrics from JMeter and completes the run. It uses a JWT; in automation use an API key with the `ingest` scope instead.

1. Create a project, an application and an environment:

   ```bash
   H=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')
   PROJECT=$(curl -s "${H[@]}" -X POST "$PERFMON_URL/api/v1/projects" \
     -d '{"key":"payments","name":"Payments"}' | jq -r .id)
   APP=$(curl -s "${H[@]}" -X POST "$PERFMON_URL/api/v1/applications" \
     -d "{\"projectId\":\"$PROJECT\",\"code\":\"merchant-payments\",\"name\":\"Merchant Payments API\"}" | jq -r .id)
   ENV=$(curl -s "${H[@]}" -X POST "$PERFMON_URL/api/v1/environments" \
     -d "{\"applicationId\":\"$APP\",\"name\":\"Performance\",\"type\":\"PERFORMANCE\"}" | jq -r .id)
   ```

2. Create a performance test with a load profile:

   ```bash
   curl -s "${H[@]}" -X POST "$PERFMON_URL/api/v1/tests" -d "{
     \"applicationId\":\"$APP\",\"environmentId\":\"$ENV\",\"name\":\"200 TPS Payment Load\",
     \"testType\":\"LOAD\",\"loadProfile\":{\"virtualUsers\":100,\"durationSec\":1800,\"targetTps\":200}}" | jq .id
   ```

3. Create a run and capture the Run ID:

   ```bash
   RUN_ID=$(curl -s "${H[@]}" -X POST "$PERFMON_URL/api/v1/runs" -d '{
     "project":"payments","application":"merchant-payments","environment":"Performance",
     "test":"200 TPS Payment Load","buildNumber":"104","branch":"main"}' | jq -r .runId)
   echo "$RUN_ID"    # PF-2026-10-06-000127
   ```

4. Run JMeter with the built-in InfluxDB Backend Listener pointed at Perfmon (full instructions in [JMeter Integration](09-jmeter-integration.md)):

   ```bash
   jmeter -n -t plan.jmx -l results.jtl -e -o report/ \
     -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.token="$PERFMON_API_KEY"
   ```

5. Watch the run in Observability → Live Monitoring (`/live/<RunID>`). The run switches from `QUEUED` to `RUNNING` when the first data point arrives.

6. Upload the HTML report and the JTL, then complete the run:

   ```bash
   (cd report && zip -qr ../report.zip .)
   curl -s -H "authorization: Bearer $TOKEN" -F kind=HTML_REPORT -F file=@report.zip \
     "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts" | jq .message
   curl -s -H "authorization: Bearer $TOKEN" -F kind=JTL -F file=@results.jtl \
     "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts" | jq .message
   curl -s -H "authorization: Bearer $TOKEN" -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/complete" | jq .status
   ```

7. Open Testing → Test Runs (`/runs/<RunID>`) to see the summary, SLA evaluation, regressions, insights, score and result once the run reaches `COMPLETED`.

The wrapper scripts [run-perfmon-test.sh](/samples/run-perfmon-test.sh) and [run-perfmon-test.ps1](/samples/run-perfmon-test.ps1) automate steps 3 to 6 (see [Set up JMeter for Perfmon](00b-jmeter-setup.md#the-wrapper-scripts)).

## Health checks

```bash
curl -s "$PERFMON_URL/api/v1/health"          # {"status":"UP","time":"..."}  (no authentication)
curl -s "$PERFMON_URL/metrics" | head          # Prometheus self-monitoring metrics (no authentication)
```

## Next steps

- Read [Architecture](02-architecture.md) to understand how data flows through Perfmon.
- Set up [JMeter Integration](09-jmeter-integration.md) for live metrics.
- Keep [Troubleshooting](39-troubleshooting.md) at hand for your first runs.
