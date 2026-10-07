# Uploading HTML Reports

JMeter's HTML dashboard report is the reference document most teams share after a test. Perfmon stores it with the run, extracts it so that it can be viewed in the browser without downloading, parses its statistics into structured data, and compares those statistics with the live or JTL metrics of the same run. This section describes how to produce and upload the report, what happens to it after upload, how to view it securely and how to diagnose processing problems.

## Producing the report

Generate the dashboard at the end of a non-GUI run:

```bash
jmeter -n -t plan.jmx -l results.jtl -e -o report/
```

or afterwards from an existing JTL:

```bash
jmeter -g results.jtl -o report/
```

The output directory contains `index.html`, `statistics.json`, `content/` (including `content/js/dashboard.js` and `content/js/graph.js`) and `sbadmin2-1.0.7/`. Perfmon parses `statistics.json` (JMeter 5.0 and later) first and falls back to `content/js/dashboard.js` and `index.html`.

## Packaging the report as a ZIP

Upload the whole directory as one ZIP archive. `index.html` may be at the root of the archive or inside a single top-level folder; Perfmon locates the report root automatically (it prefers the folder whose `index.html` sits next to `content/js/dashboard.js`).

```bash
# Linux / macOS: zip the contents of report/
(cd report && zip -qr ../report.zip .)
```

```powershell
# Windows PowerShell
Compress-Archive -Path .\report\* -DestinationPath .\report.zip -Force
```

A single `.html` file is also accepted. In that case only `index.html` is stored and statistics are parsed only if the file inlines the dashboard data; prefer the ZIP.

## Uploading

### From the UI

Open the run under Testing → Test Runs (`/runs/<RunID>`) and use its artifacts tab, or open Reporting → Artifacts (`/artifacts`). Select the ZIP file and the type HTML report.

### From the API

`POST /api/v1/runs/:runId/artifacts` with `multipart/form-data`. Requires `UPLOAD_ARTIFACT` (roles `PERFORMANCE_ENGINEER`, `QA_ENGINEER`, `DEVELOPER`, administrators, and API keys with the `ingest` scope).

| Multipart field | Required | Description |
|---|---|---|
| `file` | Yes | The ZIP (or `.html`). Exactly one file per request |
| `kind` | Recommended | `HTML_REPORT`. Without it, a `.zip` containing `content/js/dashboard.js` is recognized as an HTML report automatically and a `.html` file is treated as an HTML report |
| `name` | No | Artifact name, default `jmeter-report`. Uploads with the same kind and name become new versions of the same artifact |
| `description` | No | Free text |
| `source` | No | `UPLOAD`, `CI`, `API`, `SYSTEM` or `COLLECTOR`. Defaults to `API` for API keys and `UPLOAD` for users |

```bash
curl -s --fail-with-body \
  -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=HTML_REPORT -F name=jmeter-report -F source=CI \
  -F "file=@report.zip;type=application/zip" \
  "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/artifacts"
```

Response:

```json
{
  "duplicate": false,
  "artifact": {
    "id": "3f1d6c1e-...",
    "runKey": "PF-2026-10-06-000127",
    "kind": "HTML_REPORT",
    "name": "jmeter-report",
    "currentVersion": 1,
    "latest": {
      "version": 1,
      "originalFilename": "report.zip",
      "mimeType": "application/zip",
      "sizeBytes": 1843321,
      "sha256": "9b2f...",
      "processingStatus": "QUEUED",
      "scanStatus": "NOT_SCANNED",
      "hasViewer": false
    }
  },
  "message": "Stored as version 1"
}
```

The upload returns as soon as the file is stored; extraction and parsing continue in the background. Reports can be uploaded in any run status, including after the run is completed.

## Processing pipeline

```text
Upload -> Validate -> Checksum -> Store -> Job -> Extract -> Parse -> Summary -> Associate -> Update
```

| Stage | What Perfmon does |
|---|---|
| Upload | The multipart file is streamed to a temporary file. The size limit (`MAX_UPLOAD_MB`, default 512 MB) is enforced while streaming (`413` when exceeded); empty files are rejected. The first 8 KB are kept for content sniffing |
| Validate | The file name must not have an executable or script extension (`.exe`, `.dll`, `.bat`, `.ps1`, `.jar`, ...). For a ZIP: the archive must be readable, contain at most 50,000 entries, expand to at most 4 GB in total and 1 GB per entry, and have no entry larger than 10 MB with a compression ratio above 200 (zip-bomb protection). An `HTML_REPORT` ZIP must contain an `index.html`. Magic bytes must match the declared type (ZIP signature for `.zip`, text content for `.html`); executable content is rejected. If `MALWARE_SCAN_URL` is configured, the scanner is called and infected files are rejected |
| Checksum | The SHA-256 of the file is computed while it is streamed in the upload stage. After validation it is compared with the latest version of the same artifact (same run, kind and name): an identical file is not stored again and the response has `"duplicate": true`. Identical files in other artifacts or runs are listed in the new version's `metadata.duplicateOf` |
| Store | The original file is written to object storage under `projects/<project>/tests/<test>/runs/<RunID>/reports/<artifact-id>/v<N>/<file>`, and an artifact version row is created with checksum, size, MIME type, uploader, `scanStatus` and `processingStatus = QUEUED` |
| Job | In the same database transaction an `artifact.process` job is queued (priority 3). The upload is audited (`artifact.upload`) |
| Extract | A worker downloads the archive, determines the report root and extracts every file below it to `.../v<N>/site/`. Entry paths are normalized; absolute paths, drive letters, `..` segments (zip-slip) and symbolic links are skipped |
| Parse | `statistics.json`, `content/js/dashboard.js`, `index.html` and `content/js/graph.js` are read (up to 64 MB each) and parsed by the HTML report parser (version 1.2.0): overall statistics, per-transaction statistics, errors, top 5 errors by sampler, APDEX, response codes, start and end time. Missing values become warnings, never guesses |
| Summary | The parsed data is stored per version (`html_report_summaries`). For the latest version only, the run summary with source `html_report` and the per-transaction table with source `html_report` are replaced; their percentiles are marked `source_reported` |
| Associate | The extracted location and entry file are recorded on the version, which enables the report viewer (`hasViewer: true`) for that version of the run's report. The run's reconciliation (live or JTL metrics versus the report) now has both sides |
| Update | The version is set to `processingStatus = COMPLETED` with processing details in `metadata` (extracted file count, report root, number of transactions, warnings). If the run is already `COMPLETED`, `FAILED` or `ABORTED`, a `run.reanalyze` job is queued so that insights and the reconciliation reflect the report. Live viewers receive an `artifact` event |

On an error in any background stage the version is set to `processingStatus = FAILED` with the message in `processingError`, and the job is retried up to three times with back-off.

### Processing statuses

| `processingStatus` | Meaning |
|---|---|
| `QUEUED` | Stored, waiting for a worker |
| `PROCESSING` | Being extracted and parsed |
| `COMPLETED` | Viewer and parsed statistics available |
| `FAILED` | See `processingError`; can be reprocessed |
| `SKIPPED` | The artifact kind needs no processing |

## Checking the result

```bash
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/html-report" \
  -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq '{available, status: .version.processingStatus, error: .version.processingError, viewerUrl, downloadUrl,
         samples: .summary.overall.samples, p95: .summary.overall.percentiles.p95, warnings: .summary.warnings}'
```

`GET /api/v1/runs/:runId/html-report` returns the most recently updated HTML report artifact of the run:

| Field | Description |
|---|---|
| `available` | `false` if the run has no HTML report |
| `artifact`, `version`, `versions` | Artifact, selected version and full version history |
| `viewerUrl` | Signed URL of the extracted report (only when extraction completed) |
| `downloadUrl` | Download of the original ZIP |
| `summary` | Parsed statistics of the selected version (`overall`, `transactions`, `errors`, `top_errors`, `response_codes`, `apdex`, `warnings`) |

Add `?version=<n>` to view an older version.

Wait for processing in a script:

```bash
for i in $(seq 1 60); do
  S=$(curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID/html-report" -H "authorization: Bearer $PERFMON_API_KEY" | jq -r .version.processingStatus)
  echo "report: $S"; [ "$S" = COMPLETED ] || [ "$S" = FAILED ] && break; sleep 5
done
```

## Viewing reports securely

Uploaded HTML and JavaScript are untrusted content. Perfmon therefore never renders a report on the application's own origin:

- Extracted reports are served by the report content server, a separate listener on `REPORT_CONTENT_PORT` (default `8081`) addressed through `REPORT_CONTENT_ORIGIN` (for example `http://localhost:8081`). If no separate origin is configured, the main API serves the content itself under `/report-content/`, still sandboxed.
- Every response carries `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; frame-ancestors 'self' <PUBLIC_URL> <CORS_ORIGINS>; form-action 'none'`, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Scripts in the report run in an opaque sandbox: they cannot read Perfmon cookies or storage, cannot call the Perfmon API with your credentials and cannot submit forms.
- Because an iframe cannot send an `Authorization` header, access is granted by a signed URL: `/report-content/<token>/index.html`. The token contains the version ID and an expiry time, signed with HMAC-SHA256 using a key derived from `JWT_SECRET`. Tokens are valid for one hour. An expired or tampered link returns `403 Report link expired or invalid. Reopen the report from Perfmon.`
- File paths inside the token are checked against the extracted location; path traversal is rejected.

To get a fresh link, reopen the report in the UI or call `GET /runs/:runId/html-report` again.

## Versions and replacement

Uploading another report with the same name to the same run creates version 2, 3, and so on. All versions remain downloadable and viewable; only the latest version feeds the run summary. Upload an identical file again and Perfmon answers `"duplicate": true` without creating a version. To replace a specific artifact explicitly use `POST /api/v1/artifacts/:id/versions` with the same multipart fields. See [Artifact Management](11-artifact-management.md).

## Reprocessing

After a fix (for example a parser update) or a failure, reprocess a version:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/artifacts/<artifact-id>/versions/latest/reprocess" \
  -H "authorization: Bearer $PERFMON_API_KEY"
# {"jobId":"..."}
```

## Reconciliation with live metrics

When a run has both an HTML report and live or JTL metrics, `GET /api/v1/runs/:id/reconciliation` compares them:

| Metric | Tolerance (OK) |
|---|---|
| Requests, errors | 0.1% |
| Error % | 0.05 percentage points |
| Average | 2% or 5 ms |
| Median, P90, P95, P99 | 5% or 25 ms |
| Min, max | 5 ms |
| TPS | 2% or 0.05 |
| Received / sent KB/s | 3% or 0.5 KB/s |

Each metric is `OK`, `MINOR` (within three times the tolerance) or `MISMATCH`; the overall status is `CONSISTENT`, `MINOR_DIFFERENCES`, `INCONSISTENT` or `NOT_AVAILABLE`. Percentile differences are expected when the live data came from the Backend Listener (interval-reported percentiles) and, to a lesser degree, from histogram resolution (about 2.5%). A large difference in request counts usually means the listener's `samplersRegex` or `summaryOnly` excluded samplers, or that the report was generated from a different JTL.

## Troubleshooting

| Symptom | Likely cause and action |
|---|---|
| `400 ZIP does not contain an index.html` | The ZIP was created from the wrong folder. Zip the contents of the report output directory |
| `400 HTML report must be a .zip of the report directory or a single .html file` | `kind=HTML_REPORT` with another file type |
| `400 HTML report .zip is not a valid ZIP archive` / `Invalid ZIP archive` | Corrupted or non-ZIP file (for example `.tar.gz` renamed) |
| `400 ... suspicious compression ratio` or `expands beyond the 4 GB limit` | Archive rejected by zip-bomb protection |
| `413 PAYLOAD_TOO_LARGE` | File larger than `MAX_UPLOAD_MB` (or the reverse proxy limit, 600 MB in the bundled nginx) |
| `processingStatus` stays `QUEUED` | No worker is processing jobs (`ENABLE_WORKER=false` or backend down); check `GET /runs/:id/jobs` |
| `FAILED` with `report file too large to parse` | One of the parsed files exceeds 64 MB |
| Viewer shows `403 Report link expired` | Signed URL older than one hour; reopen the report |
| Viewer frame refuses to load | The UI's origin is missing from `PUBLIC_URL` / `CORS_ORIGINS` (frame-ancestors) or the UI's CSP `frame-src` does not include the report origin |

See [Troubleshooting](39-troubleshooting.md) for a complete checklist.

## Related sections

- [Artifact Management](11-artifact-management.md)
- [JMeter Integration](09-jmeter-integration.md)
- [Running Tests](07-running-tests.md)
