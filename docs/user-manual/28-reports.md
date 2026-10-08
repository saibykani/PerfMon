# Reports

Perfmon builds reports from the analysis it has already stored: run summaries, SLA results, regressions, bottlenecks, insights and infrastructure metrics. A report is a fixed snapshot. It does not change when the run data changes later, but you can regenerate it at any time to get a new version. Every report can be previewed in the browser and downloaded as PDF, HTML, Excel, CSV or JSON. This chapter covers the report types, how reports are generated (automatically and on demand), versioning, the formats, and the REST API.

## Where to find it

| Place | What you can do |
|---|---|
| Reporting → **Reports** (`/reports`) | List, filter and search reports, create a **New report**, download, delete |
| Report page (`/reports/<id>`) | Preview, download in every format, **Regenerate**, delete |
| Run header (any run, `/runs/<RunID>`) | **Generate report** creates a Test execution report for the run and opens it |
| Analysis → **Compare Runs** (`/compare`) | **Generate report** creates a Comparison report from the selected runs |
| `/reports?new=1` | Opens the Reports page with the **New report** dialog already open |

## Permissions

| Action | Permission | Roles that have it by default |
|---|---|---|
| List reports, open a report, see the preview | `VIEW_REPORT` | Every role, including Viewer |
| Create, regenerate, download (any format), delete | `EXPORT_REPORT` | Admin, Performance engineer, QA engineer, Developer, SRE, Architect, Manager |

Users without `EXPORT_REPORT` see "No export permission" in the **Download** column. API keys get these permissions through the `read` scope (`VIEW_REPORT`, `EXPORT_REPORT`); the `ingest` scope does not include them. A key can carry both scopes. See [Users, roles & API keys](00e-users-and-api-keys.md).

## Report types

> The tables in this section describe the report types available in the current version. New types will be added to these tables when they are released.

| Type (API value) | UI label | Subject | Required input | Audience |
|---|---|---|---|---|
| `TEST_EXECUTION` | Test execution | One run | `runId`. The run must be finished: it cannot be `SCHEDULED`, `QUEUED` or `RUNNING` | Engineering |
| `COMPARISON` | Comparison | 2 to 6 runs, the first is the reference for change % | `runIds` (2 to 6, all different) | Engineering |
| `EXECUTIVE` | Executive summary | One project over a period | `projectId`; optional `params.from` / `params.to` (default: the last 30 days), `params.testId`, `params.environmentId` | Executive |

### Sections per type

The sections appear in this order. A section is left out when there is nothing to show (for example, no baseline or no infrastructure data).

| Type | Sections |
|---|---|
| Test execution | Result and score header · Run identity · Summary · Key metrics (vs baseline, when there is one) · Comparison with baseline · Result & score breakdown · Throughput over time · Response time over time · SLA results · Top transactions by volume (top 25) · Slowest transactions (P95) · Errors · Regressions & improvements · Bottleneck analysis · Insights · Recommendations · Infrastructure summary · Servers · Data consistency (live vs JMeter HTML report) |
| Comparison | Runs compared · Summary · Key metrics · P95 by run · Average TPS by run · SLA results by run · Transactions — P95 (largest changes first) · API endpoints — average response time · Recorded regressions |
| Executive summary | Executive summary · Key figures · Result distribution · P95 trend · Throughput trend · Trend signals · Top regressions · Slowest transactions (latest run of each test) · Runs in period |

The **Data consistency** section is included only when the run has both live metrics and an uploaded JMeter HTML report (see [Uploading HTML Reports](10-uploading-html-reports.md)).

### Download formats

| Format | `format=` | File content |
|---|---|---|
| PDF | `pdf` (default) | Printable document with the result header, KPI tiles, tables and charts |
| HTML | `html` | One self-contained page: inline styles and SVG charts, no scripts and no external files. It can be archived or e-mailed as is |
| Excel | `xlsx` | A **Summary** sheet (header, result, key/value, KPI, text and list sections) plus one sheet per table, findings and chart section. The header row is frozen |
| CSV | `csv` | All sections one after another in one file. Each section starts with a `# <section title>` line. UTF-8 with BOM and CRLF line endings, so Excel opens it correctly |
| JSON | `json` | The report's content model (`title`, `type`, `version`, `generatedAt`, `subject`, `result`, `sections[]`) plus `id` and `params`. Use it for automation |

Downloaded files are named `<RunID>-<type>-v<version>.<ext>`, for example `PF-2026-10-06-000127-test-execution-v2.pdf`. Reports without a single run (comparison, executive) have no Run ID prefix: `comparison-v1.xlsx`.

## Automatic reports

When a run is completed (from the UI, the API or a CI pipeline), Perfmon analyzes it and then automatically queues a **Test execution** report. Automatic reports are shown with "· automatic" next to the version and "Automatic" in **Created by**. You do not need to do anything to get them. The report reflects the run as it was analyzed. If you upload a JTL or HTML report later, or change the SLA profile, click **Regenerate** to get a report with the new data.

## Creating a report in the UI

### Step 1: Open the dialog

Go to Reporting → **Reports** and click **New report**. (Shortcuts: **Generate report** on a run or on the Compare Runs page creates the report directly, without the dialog.)

### Step 2: Choose the report type

Select **Test execution**, **Comparison** or **Executive summary** under **Report type**. A one-line description of the selected type appears below.

### Step 3: Choose the subject

| Type | Field | How to fill it in |
|---|---|---|
| Test execution | **Run** | Search for the run by Run ID or test name and pick it. Only finished runs can be reported (completed, failed or aborted) |
| Comparison | **Runs (n/6)** | Add 2 to 6 runs with **Add a run…**. Run A is the reference. Use the run chips to remove a run or make another run the reference |
| Executive summary | **Project**, **Period** | Pick the project and a period: **7 days**, **30 days**, **90 days** or **Custom** (from/to dates) |

### Step 4: Optional title

**Title (optional)** accepts up to 200 characters, for example "Release 4.2 sign-off". If you leave it empty, Perfmon uses the type and subject:

| Type | Default title |
|---|---|
| Test execution | `Test Execution Report — <RunID>` |
| Comparison | `Comparison Report — <RunID A> vs <RunID B> ...` (from Compare Runs: `Run comparison — ...`) |
| Executive summary | `Executive Summary — <Project> (<from> to <to>)` |

### Step 5: Generate

Click **Generate report**. The report is queued, and you are taken to its page. The page refreshes itself while the status is **Pending** ("Waiting for a worker…") or **Generating**. Reports usually take a few seconds. When the status changes to **Ready**, the preview appears and the download buttons are enabled.

## Report status

| Status (API) | UI label | Meaning |
|---|---|---|
| `QUEUED` | Pending | Waiting for a background worker |
| `GENERATING` | Generating | A worker is building the content |
| `READY` | Ready | Preview and downloads are available |
| `FAILED` | Failed | Generation failed. The error is shown on the report page and as a tooltip on the status badge. Click **Try again** or **Regenerate** |

A failed generation is retried once (automatic reports: up to three attempts in total). If a report stays `QUEUED` or `GENERATING` for more than 2 minutes with no generation job left, Perfmon marks it `FAILED` with the message "Generation did not complete (the job failed or was lost). Regenerate to try again."

## The report page

| Area | Content |
|---|---|
| Header | Title, type badge, version, status, download buttons (**PDF**, **HTML**, **Excel**, **CSV**, **JSON**), **Regenerate**, delete |
| Left panel | Runs (links to the runs), Project, Period (executive), Created by, Created, Generated, Result with score, list of sections |
| Preview | The rendered HTML report |

The preview is rendered by the server without scripts and shown in a fully sandboxed frame. Report content can never run code in the application.

## Versions and regeneration

Each report belongs to a **subject**. Generating a report for the same subject again creates the next version (v1, v2, ...). Older versions are kept until you delete them.

| Type | Subject (version counter is shared by) |
|---|---|
| Test execution | The run |
| Comparison | The ordered list of runs (A, B, C ... in that order) |
| Executive summary | The project + test filter + environment filter. The period is **not** part of the subject, so executive reports for different periods of the same project share one version counter |

**Regenerate** creates a new version with the same type, title and parameters, built from the current data. Use it after re-analysis, after uploading a JTL or HTML report, or after changing SLA profiles.

## Finding reports

The Reports list has these filters, which are kept in the page URL so filtered views can be bookmarked:

| Filter | Values |
|---|---|
| Type | All types, Test execution, Comparison, Executive summary |
| Status | All statuses, Pending, Generating, Ready, Failed |
| Project | All projects or one project |
| Run ID | Shows the run's own reports **and** comparison reports that include the run |
| Search | Title or Run ID (partial match) |

The list refreshes automatically while any report on the page is pending or generating.

## Deleting a report

Click the trash icon in the list or on the report page and confirm. Only that version is deleted. The run data is not affected, and the report can be generated again. Through the API, deletion requires `?confirm=true`.

## REST API

All endpoints are under `/api/v1`.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| GET | `/reports` | `VIEW_REPORT` | List. Query: `projectId`, `runId`, `type` and `status` (comma-separated), `q`, `page`, `pageSize` (1 to 200, default 25) |
| POST | `/reports` | `EXPORT_REPORT` | Queue a report. Returns `201 {id, status, version}` |
| GET | `/reports/:id` | `VIEW_REPORT` | Metadata and `content` (`null` until `READY`) |
| GET | `/reports/:id/preview` | `VIEW_REPORT` | Rendered HTML (`409` unless `READY`) |
| GET | `/reports/:id/export?format=pdf\|html\|csv\|json\|xlsx` | `EXPORT_REPORT` | Download (`409` unless `READY`) |
| POST | `/reports/:id/regenerate` | `EXPORT_REPORT` | New version with the same parameters. Returns `201 {id, status, version}` |
| DELETE | `/reports/:id?confirm=true` | `EXPORT_REPORT` | Delete this version |

Request body of `POST /reports`:

| Field | Type | Used by | Description |
|---|---|---|---|
| `type` | `TEST_EXECUTION`, `COMPARISON`, `EXECUTIVE` | All | Report type |
| `runId` | string (Run ID or UUID) | Test execution | The finished run |
| `runIds` | array of 2 to 6 strings | Comparison | Runs, first = reference |
| `projectId` | UUID | Executive (required unless the API key is bound to a project); optional check for the others | Project |
| `title` | string, 1 to 200 | All | Optional custom title |
| `params.from`, `params.to` | ISO time | Executive | Period. Default: the 30 days before `to` (default `to` = now) |
| `params.testId`, `params.environmentId` | UUID | Executive | Optional filters (API only; the UI dialog does not offer them) |

### Examples

Set up the variables once (`PERFMON_TOKEN` is a user JWT from `POST /api/v1/auth/login`, or an API key with the `read` scope):

```bash
export PERFMON_URL=http://perfmon.example.com:8080
export PERFMON_TOKEN=pmk_0a1b2c3d_REPLACE_ME
```

Generate a test execution report, wait until it is ready, and download the PDF:

```bash
REPORT_ID=$(curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/reports" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"TEST_EXECUTION","runId":"PF-2026-10-06-000127","title":"Release 4.2 sign-off"}' | jq -r .id)

until [ "$(curl -s "$PERFMON_URL/api/v1/reports/$REPORT_ID" -H "Authorization: Bearer $PERFMON_TOKEN" | jq -r .status)" = "READY" ]; do
  sleep 3   # add a limit and check for FAILED in real pipelines
done

curl -s --fail-with-body -H "Authorization: Bearer $PERFMON_TOKEN" \
  -o sign-off.pdf "$PERFMON_URL/api/v1/reports/$REPORT_ID/export?format=pdf"
```

Comparison report of three runs (the first is the reference):

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/reports" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"COMPARISON","runIds":["PF-2026-10-01-000120","PF-2026-10-03-000124","PF-2026-10-06-000127"]}'
# {"id":"…","status":"QUEUED","version":1}
```

Executive summary for September:

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/reports" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"EXECUTIVE","projectId":"<project-uuid>","params":{"from":"2026-09-01T00:00:00Z","to":"2026-09-30T23:59:59Z"}}'
```

Find the automatic report of a run and download it as Excel:

```bash
ID=$(curl -s "$PERFMON_URL/api/v1/reports?runId=PF-2026-10-06-000127&type=TEST_EXECUTION&status=READY" \
  -H "Authorization: Bearer $PERFMON_TOKEN" | jq -r '.items[0].id')
curl -s --fail-with-body -H "Authorization: Bearer $PERFMON_TOKEN" \
  -o run-report.xlsx "$PERFMON_URL/api/v1/reports/$ID/export?format=xlsx"
```

### Error responses

| Status | Typical message | Fix |
|---|---|---|
| `400` | `runId is required for a TEST_EXECUTION report` / `runIds must contain at least two runs for a COMPARISON report` / `runIds contains the same run twice` / `projectId is required for an EXECUTIVE report` | Complete the request body |
| `400` | `` `from` must be before `to` `` | Correct the period |
| `400` | `Deletion requires confirmation: repeat the request with ?confirm=true` | Add `?confirm=true` |
| `403` | Missing permission | Use a user or key with `EXPORT_REPORT` (key scope `read`) |
| `404` | Report or run not found | Check the ID; API keys bound to a project only see that project's reports |
| `409` | `Run … is RUNNING; generate the report once it has finished` | Complete the run first |
| `409` | `Report is QUEUED; it can be downloaded once READY` | Poll `GET /reports/:id` until `READY` |

## Related: plain-text run summary

Separately from reports, every completed run has a short plain-text summary (Run ID, test, result, duration, users, TPS, average RT, P95, P99, error %, SLA, regression yes/no, major finding, recommendation). It is shown on the run's Overview tab and available at `GET /api/v1/runs/<RunID>/summary-text` (permission `VIEW_RUN`). It is useful for chat notifications and CI logs.

## Tips

- For release sign-off, upload the JTL before you generate the report, so the percentiles are exact rather than approximate (≈). See [JMeter Integration](09-jmeter-integration.md#percentile-accuracy).
- For a comparison, put the older, known-good run first. Then "worse" means a regression.
- Keep executive reports filtered to one test or environment (API `params.testId` / `params.environmentId`) when a project mixes very different load profiles.

## Related chapters

- [Run Comparison](22-run-comparison.md)
- [SLA / SLO](20-sla-slo.md)
- [Regression Detection](23-regression-detection.md)
- [Performance Trends](24-performance-trends.md)
- [Uploading HTML Reports](10-uploading-html-reports.md)
- [CI/CD Integration](30-ci-cd-integration.md)
