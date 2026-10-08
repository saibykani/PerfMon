# Artifact Management

An artifact is any file attached to a run: the JTL results file, the JMeter HTML report, the `.jmx` test plan, JMeter and server logs, screenshots, configuration files, PDFs and so on. Perfmon stores every artifact against exactly one run, versions it, records its SHA-256 checksum, and processes the file types it understands (HTML reports, JTL files and logs) in the background. This chapter covers uploading, versioning, previewing, downloading, deleting and restoring artifacts, how processing works, and where the files are physically stored.

For the HTML report specifically (packaging, the parsed summary, the sandboxed viewer and reconciliation) see [Uploading HTML Reports](10-uploading-html-reports.md).

## Where to find artifacts

| Place | Path | What it shows |
|---|---|---|
| Artifacts page | Reporting → **Artifacts** (`/artifacts`) | Every artifact of all runs you can see, with search, filters, sorting and paging (25 per page) |
| Run detail, **Artifacts** tab | `/runs/<RunID>/artifacts` | The artifacts of one run, with an upload drop zone |
| Run detail, **HTML Report** tab | `/runs/<RunID>/html-report` | The latest HTML report of the run in the sandboxed viewer |
| Global search | Search box in the top bar | Artifacts are one of the searchable result types |

## Permissions

| Action | Permission | Roles that have it by default |
|---|---|---|
| List, search, preview, download | `VIEW_RUN` | All roles |
| Upload, replace (new version), re-process | `UPLOAD_ARTIFACT` | Super admin, Admin, Performance engineer, QA engineer, Developer; API keys with the `ingest` scope |
| Delete and restore | `DELETE_ARTIFACT` | Super admin, Admin, Performance engineer |

Buttons you are not allowed to use are hidden in the UI. See [Users, roles & API keys](00e-users-and-api-keys.md).

## Artifact kinds

Every artifact has one kind. If you do not choose one, Perfmon detects it from the file extension.

| Kind | Auto-detected from | Content check | Processed? | Previewable? |
|---|---|---|---|---|
| `HTML_REPORT` | `.html`, `.htm` | A valid ZIP containing an `index.html`, or a single text `.html` file | Yes: extracted, parsed, served in the viewer | No (use the HTML Report tab) |
| `JTL` | `.jtl` | Text file, or gzip/zip compressed | Yes: imported as metrics (source `jtl`) | Yes |
| `CSV` | `.csv` | Text file | No (but see the note below) | Yes |
| `JMX` | `.jmx` | Text file | No | Yes |
| `LOG` | `.log`, `.txt`, `.out` | Text file, or gzip/zip compressed | Yes: indexed as log entries (service `jmeter`) | Yes |
| `SERVER_LOG`, `APP_LOG` | choose explicitly | Text file, or gzip/zip compressed | Yes: indexed as log entries (service = artifact name) | Yes |
| `CONFIG` | `.properties`, `.yaml`, `.yml`, `.conf`, `.ini` | Text file | No | Yes |
| `TEST_DATA`, `JSON`, `XML` | `.json`, `.xml` (`TEST_DATA`: choose explicitly) | Text file | No | Yes |
| `SCREENSHOT` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp` | Must be PNG, JPEG, GIF or WebP by content | No | Yes (image) |
| `PDF` | `.pdf` | Must be a real PDF | No | No |
| `EXCEL` | `.xlsx`, `.xls` | Must be an Excel file | No | No |
| `ZIP` | `.zip` | Must be a valid ZIP | No | No |
| `OTHER` | anything else | None beyond the executable check | No | No |

Automatic corrections:

- A `.csv` file whose first line starts with `timeStamp,` (a JMeter CSV results file) is stored as `JTL` and imported.
- A `.zip` uploaded as `ZIP` that contains a JMeter dashboard (`content/js/dashboard.js` next to an `index.html`) is stored as `HTML_REPORT`.

Rejected files:

- Executables and scripts by extension: `.exe`, `.dll`, `.so`, `.dylib`, `.bat`, `.cmd`, `.com`, `.msi`, `.scr`, `.ps1`, `.vbs`, `.jar`, `.war`, `.ear`, `.apk`, `.app`, `.dmg`, `.pif`, `.cpl`, `.hta`, `.lnk`, `.reg`.
- Any file whose content is a Windows (PE) or Linux (ELF) executable, whatever its name.
- Empty files, and files whose content does not match the kind (for example a `PDF` that is not a PDF).

## Uploading artifacts

### From the Artifacts page

1. Open Reporting → **Artifacts** and click **Upload artifact**.
2. **Run** (required): type or paste the Run ID (`PF-...`), or pick one of the 30 most recent runs from the suggestions.
3. **Type**: leave **Auto-detect** or choose a kind.
4. **Name** (optional): defaults to the file name (`jmeter-report` for HTML reports). The same type and name on the same run creates a new version instead of a new artifact.
5. **Description** (optional).
6. **File**: drop a file on the drop zone or click to browse. HTML reports must be uploaded as a `.zip` of the report folder.
7. Click **Upload**. A message confirms "Stored as version N", or tells you the file was identical to the latest version.

### From a run

Open the run, select the **Artifacts** tab and drop one or more files on the drop zone ("Drop files here or click to browse"). The **Kind: auto-detect** selector and the **Name (optional)** field apply to the files you drop. The table refreshes every 3 seconds while a file is still being processed.

### From the API or CI

Upload with `multipart/form-data` to the run. Only one file per request is accepted.

```bash
# HTML report (zip of the JMeter report directory)
(cd report && zip -qr ../report.zip .)
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=HTML_REPORT -F file=@report.zip "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"

# JTL results, test plan and a server log
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=JTL -F file=@results.jtl "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=JMX -F file=@plan.jmx "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=SERVER_LOG -F name=payments-api -F description="App server 1" \
  -F file=@payments-api.log.gz "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
```

Multipart fields:

| Field | Required | Description |
|---|---|---|
| `file` | Yes | The file. Only the first file part is used |
| `kind` | No | One of the kinds above (case-insensitive). Auto-detected when omitted |
| `name` | No | Logical name. Same run + kind + name = new version of the same artifact |
| `description` | No | Free text |
| `source` | No | `UPLOAD`, `CI`, `API`, `SYSTEM` or `COLLECTOR`. Defaults to `API` for API keys and `UPLOAD` for users |

The run is identified by its Run ID or its internal UUID. Example response:

```json
{
  "duplicate": false,
  "artifact": {
    "id": "6f1c0e2a-...", "runId": "...", "runKey": "PF-2026-10-06-000127", "kind": "JTL", "name": "results.jtl",
    "source": "API", "currentVersion": 1,
    "latest": { "version": 1, "originalFilename": "results.jtl", "mimeType": "text/csv", "sizeBytes": 18234567,
                "sha256": "9b2e...", "processingStatus": "QUEUED", "scanStatus": "NOT_SCANNED", "hasViewer": false }
  },
  "message": "Stored as version 1"
}
```

A complete CI flow (create run, run JMeter, upload artifacts, complete the run) is in [CI/CD Integration](30-ci-cd-integration.md).

## Limits

| Limit | Value | Configuration |
|---|---|---|
| Maximum file size | 512 MB | `MAX_UPLOAD_MB` |
| Files per request | 1 | Fixed |
| Form fields per request | 20 | Fixed |
| ZIP archives: number of entries | 50,000 | Fixed |
| ZIP archives: total uncompressed size | 4 GB | Fixed |
| ZIP archives: single entry | 1 GB | Fixed |
| ZIP archives: compression ratio | Entries over 10 MB may not expand more than 200× (zip-bomb protection) | Fixed |
| Text preview | First 256 KB | Fixed |
| Log indexing | Up to 2,000,000 entries per file; each message (including stack-trace continuation lines) up to 4,000 characters | Fixed |

Files larger than the limit are rejected with HTTP `413` and the message "File exceeds the 512 MB upload limit". ZIP entries with absolute paths, `..` segments or symbolic links are skipped during extraction.

## Versions and duplicates

Perfmon identifies an artifact by **run + kind + name**.

- Uploading a file with the same kind and name to the same run creates **version 2, 3, ...** of that artifact. All versions are kept and can be downloaded and previewed. For HTML reports, only the latest version feeds the run summary.
- If the new file has the same SHA-256 as the **latest** version, nothing is stored. The response contains `"duplicate": true` and the message "Identical file (same SHA-256) already stored as the latest version — no new version created."
- Each new version records up to 5 other artifacts (in any run) that already contain the same content, in `metadata.duplicateOf`. Search the Artifacts page for a full SHA-256 to find them.

### Replacing an artifact

Upload a new version of a specific artifact, whatever the new file is called:

- UI: click the **Replace (upload new version)** action of the artifact and choose a file.
- API:

```bash
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F file=@results-rerun.jtl "$PERFMON_URL/api/v1/artifacts/<artifact-id>/versions"
```

A replacement keeps the artifact's kind and name.

### Version history

Click the version number (`v3`) or the **Version history** action. The dialog lists every version with file name, size, upload time, uploader, SHA-256, processing status and the processing error if any. The latest version is marked **CURRENT**. From there you can preview, download or re-process any version.

```bash
curl -s "$PERFMON_URL/api/v1/artifacts/<artifact-id>" -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq '{name, kind, currentVersion, versions: [.versions[] | {version, originalFilename, sizeBytes, sha256, processingStatus}]}'
```

## Searching and filtering

The Artifacts page toolbar offers:

| Control | Effect | API parameter |
|---|---|---|
| Search box | File name, artifact name, Run ID (partial match) or the **full** SHA-256 (exact match) | `q` |
| **All types** | One kind | `kind` |
| **All projects** | One project | `projectId` |
| **Run ID** | One run | `runId` |
| **Uploaded by** | Uploader name (partial match) | `uploadedBy` |
| **Include deleted** | Also show soft-deleted artifacts (marked DELETED) | `includeDeleted=true` |

Columns can be sorted by File, Type, Size, Uploaded and Run. The table can be exported. The filters are kept in the page URL, so a filtered view can be bookmarked or shared.

```bash
# All JTL files of one project, newest first
curl -s -G "$PERFMON_URL/api/v1/artifacts" -H "authorization: Bearer $PERFMON_API_KEY" \
  --data-urlencode "projectId=<project-uuid>" --data-urlencode "kind=JTL" \
  --data-urlencode "sort=uploaded" --data-urlencode "order=desc" --data-urlencode "pageSize=100"

# Where else was this exact file uploaded?
curl -s -G "$PERFMON_URL/api/v1/artifacts" -H "authorization: Bearer $PERFMON_API_KEY" \
  --data-urlencode "q=9b2e4c...full-64-hex-sha256..."
```

`pageSize` is 1 to 500 (default 50); `sort` accepts `name`, `kind`, `size`, `uploaded` and `run`.

## Previewing and downloading

**Preview** (eye icon) is available for text kinds (`JTL`, `CSV`, `JMX`, `LOG`, `SERVER_LOG`, `APP_LOG`, `CONFIG`, `TEST_DATA`, `JSON`, `XML`) and `SCREENSHOT`. Text previews show the first 256 KB ("Showing the first 256 KB"). Compressed logs and other binary files show "This file type ... cannot be previewed. Download it instead."

**Download** always returns the original file, byte for byte, with its original file name. The response carries the checksum in the `x-checksum-sha256` header so you can verify it:

```bash
curl -s -OJ -D headers.txt "$PERFMON_URL/api/v1/artifacts/<artifact-id>/versions/latest/download" \
  -H "authorization: Bearer $PERFMON_API_KEY"
grep -i x-checksum-sha256 headers.txt
sha256sum results.jtl
```

Use a version number instead of `latest` for older versions. Every download is written to the audit log.

## Processing

`HTML_REPORT`, `JTL`, `LOG`, `SERVER_LOG` and `APP_LOG` artifacts are processed by the background job worker (job type `artifact.process`). Other kinds are stored only and show the status `SKIPPED`.

| What is processed | Result |
|---|---|
| `HTML_REPORT` | The archive is extracted to storage, `statistics.json` and `dashboard.js` are parsed into the HTML report summary and the `html_report` transaction statistics, and the sandboxed viewer becomes available. See [Uploading HTML Reports](10-uploading-html-reports.md) |
| `JTL` | Samples are imported as metrics with source `jtl` (exact histogram percentiles). A new version replaces the metrics of the previous one. If the run has no start or end time yet, the JTL defines them. See [JMeter Integration](09-jmeter-integration.md#jtl-import) |
| `LOG`, `SERVER_LOG`, `APP_LOG` | Lines starting with a timestamp (for example `2026-10-06 10:30:01,123 ERROR [main] com.x.Y: message`) become log entries with level, logger and message; lines without a timestamp are appended to the previous entry (stack traces). Results appear in the run's **Logs** tab |

When an `HTML_REPORT` or `JTL` finishes processing on a run that is already `COMPLETED`, `FAILED` or `ABORTED`, Perfmon automatically re-runs the analysis of the run (SLA, regression, bottlenecks, insights, score).

### Processing statuses

| Status | Meaning |
|---|---|
| `QUEUED` | Waiting for the job worker |
| `PROCESSING` | Being processed |
| `COMPLETED` | Done. Details are in the version's `metadata.processing` |
| `FAILED` | Processing failed; hover the status (or open the version history) to see the error |
| `SKIPPED` | This kind is stored without processing |

### Re-processing

Re-run processing for a version, for example after a parser fix or a failed import. In the UI use the **Re-process** action (run Artifacts tab or version history).

```bash
curl -s -X POST "$PERFMON_URL/api/v1/artifacts/<artifact-id>/versions/latest/reprocess" \
  -H "authorization: Bearer $PERFMON_API_KEY"
# {"jobId":"..."}
```

Requires `UPLOAD_ARTIFACT`.

## Deleting and restoring

Deleting an artifact is a **soft delete**: the artifact disappears from the run and from searches, but its files and versions are kept. In the UI click **Delete** and confirm. Through the API the confirmation is a query parameter:

```bash
curl -s -X DELETE "$PERFMON_URL/api/v1/artifacts/<artifact-id>?confirm=true" \
  -H "authorization: Bearer $PERFMON_API_KEY"
# {"ok":true}
```

Without `?confirm=true` the request fails with "Deletion requires confirmation: repeat the request with ?confirm=true".

To restore: on the Artifacts page tick **Include deleted**, then click **Restore** on the artifact (or `POST /api/v1/artifacts/<artifact-id>/restore`). Uploading a new file with the same kind and name to the run also restores the artifact and adds a version.

Files are physically removed only by a confirmed **retention purge** of the data type `artifacts` (Platform → Administration, permission `MANAGE_SETTINGS`). The default artifact retention is 365 days, measured from the artifact's creation. Nothing is purged automatically: an administrator creates a purge request (`POST /api/v1/admin/retention/purges` with `{"dataType":"artifacts"}`) and confirms it within 24 hours (`POST /api/v1/admin/retention/purges/<id>/confirm`). The purge deletes the stored files, the extracted HTML report files and the database records.

## Storage

Artifacts are stored by a pluggable storage driver selected with `STORAGE_DRIVER`.

| `STORAGE_DRIVER` | Where files go | Settings |
|---|---|---|
| `local` (default) | A directory on the backend host | `LOCAL_STORAGE_PATH` (default `./storage-data`) |
| `s3` | Amazon S3 or any S3-compatible store (MinIO, Ceph, ...) | `OBJECT_STORAGE_URL` (endpoint; empty for AWS), `OBJECT_STORAGE_BUCKET` (default `perfmon`), `OBJECT_STORAGE_REGION` (default `us-east-1`), `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY`, `OBJECT_STORAGE_FORCE_PATH_STYLE` (default `true`) |
| `azure` | Azure Blob Storage | `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_CONTAINER` (default `perfmon`) |
| `postgres` | Inside the PostgreSQL database, in 4 MB chunks | None. Meant for hosts without a persistent disk and modest volumes; prefer S3-compatible storage for large report archives |

The S3 and Azure drivers create the bucket or container on start-up if it does not exist. With `local`, make sure the directory is on a persistent volume and included in your backups.

Files are stored under a predictable key:

```text
projects/<project-key>/tests/<test-name>-<test-id-prefix>/runs/<RunID>/<folder>/<artifact-id>/v<version>/<file-name>
```

`<folder>` is `reports`, `jtl`, `csv`, `jmx`, `logs`, `screenshots`, `config`, `test-data` or `other`, depending on the kind. Extracted HTML reports are stored next to the original under `.../v<version>/site/`. File names are sanitized (only letters, digits, `.`, `_` and `-`).

### Optional malware scanning

Set `MALWARE_SCAN_URL` to an HTTP service of your own. For every upload Perfmon sends `POST <url>` with `{"sha256": "...", "filename": "...", "size": 123}` and a 15-second timeout. A response of `{"clean": false}` rejects the upload ("File rejected by malware scanner"); any other answer marks the version `CLEAN`. If the scanner cannot be reached the upload is accepted with scan status `ERROR`. Without `MALWARE_SCAN_URL` the status is `NOT_SCANNED`. Perfmon sends only the checksum and metadata, not the file content.

## Audit trail

Uploads (including duplicates and failures), downloads, deletions, restores and re-processing are recorded in the audit log with the user or API key, the run, the version and the checksum. The run's **Audit** tab shows the entries for that run and its artifacts.

## API reference

All paths are relative to `/api/v1`.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /artifacts` | `VIEW_RUN` | Search artifacts across runs (`q`, `projectId`, `runId`, `kind`, `uploadedBy`, `includeDeleted`, `page`, `pageSize`, `sort`, `order`) |
| `GET /runs/:runId/artifacts` | `VIEW_RUN` | Artifacts of one run (latest version each) |
| `POST /runs/:runId/artifacts` | `UPLOAD_ARTIFACT` | Upload (multipart: `file`, `kind`, `name`, `description`, `source`) |
| `POST /artifacts/:id/versions` | `UPLOAD_ARTIFACT` | Upload a new version of an artifact |
| `GET /artifacts/:id` | `VIEW_RUN` | Artifact with its full version history |
| `GET /artifacts/:id/versions/:version/download` | `VIEW_RUN` | Original file (`:version` = number or `latest`) |
| `GET /artifacts/:id/versions/:version/preview` | `VIEW_RUN` | Text preview (first 256 KB) or screenshot image |
| `POST /artifacts/:id/versions/:version/reprocess` | `UPLOAD_ARTIFACT` | Queue processing again |
| `DELETE /artifacts/:id?confirm=true` | `DELETE_ARTIFACT` | Soft delete |
| `POST /artifacts/:id/restore` | `DELETE_ARTIFACT` | Restore a soft-deleted artifact |
| `GET /runs/:runId/html-report` | `VIEW_RUN` | Latest HTML report: viewer URL, parsed summary, versions |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `400` "Executable and script files are not accepted as artifacts" | The extension is blocked. If you need to keep such a file with the run (for example a `.ps1` wrapper script), put it in a `.zip` and upload it as `ZIP` |
| `400` "File validation failed: ..." | The content does not match the kind, for example a binary file uploaded as `LOG`. Choose the correct kind or let it auto-detect |
| `400` "ZIP does not contain an index.html" | Zip the **contents** of the JMeter report directory, see [Uploading HTML Reports](10-uploading-html-reports.md) |
| `413` "File exceeds the ... MB upload limit" | Compress the file (gzip for JTL and logs) or raise `MAX_UPLOAD_MB`; also check the body limit of any reverse proxy in front of Perfmon |
| `"duplicate": true` | The file is identical to the latest version. Nothing to do |
| Status stays `QUEUED` | The job worker is not running (`ENABLE_WORKER=false` on every backend instance) or is busy. Administrators can check the job queue in Platform → Administration → **Platform health** |
| Status `FAILED` | Hover the status to read the error, fix the file and upload a new version, or click **Re-process** |
| `404` "Run ... not found" | Wrong Run ID, or the run belongs to another organization |
| `403` "API key is not authorized for this project" | The API key is bound to a different project than the run |

## Related sections

- [Uploading HTML Reports](10-uploading-html-reports.md)
- [JMeter Integration](09-jmeter-integration.md)
- [Running Tests](07-running-tests.md)
- [Run IDs](08-run-ids.md)
- [CI/CD Integration](30-ci-cd-integration.md)
- [Users, roles & API keys](00e-users-and-api-keys.md)
