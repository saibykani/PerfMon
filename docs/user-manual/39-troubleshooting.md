# Troubleshooting

This chapter collects the error messages Perfmon actually returns, grouped by area, with the cause and the fix for each. Messages are quoted exactly as the backend or the UI produces them; parts in angle brackets (`<RUN_ID>`) are filled in at runtime. Start with [How to read an error](#how-to-read-an-error), then jump to the area you are working in.

## How to read an error

Every API error uses the same JSON envelope:

```json
{
  "timestamp": "2026-10-06T10:31:02.114Z",
  "status": 409,
  "error": "CONFLICT",
  "message": "Run PF-2026-10-06-000127 is COMPLETED; live metrics are only accepted for SCHEDULED, QUEUED or RUNNING runs",
  "path": "/api/v1/ingest/influx/write",
  "details": null
}
```

| `status` / `error` | Meaning | First thing to check |
|---|---|---|
| `400 VALIDATION_ERROR` | The request body, query or a business rule was rejected. Schema errors start with "Invalid request:" followed by the field and the reason | `message` and `details` name the field |
| `401 UNAUTHORIZED` | No credential, or the credential is invalid, expired or revoked ("Authentication required") | The `Authorization` / `X-API-Key` header |
| `403 FORBIDDEN` | Authenticated but not allowed ("Missing permission: ...", or a project restriction) | Role or API key scope; Administration → Audit log, result `DENIED` |
| `404 NOT_FOUND` | Object does not exist in your organization, or wrong URL ("Route POST /x not found") | Run ID / UUID; the `/api/v1` prefix |
| `409 CONFLICT` | The object is in the wrong state, or a unique value already exists ("A resource with the same unique key already exists") | The run or report status |
| `413 PAYLOAD_TOO_LARGE` | Body or file too large ("Request or file exceeds the size limit") | `MAX_UPLOAD_MB`, proxy limits |
| `423 ACCOUNT_LOCKED` | Too many failed logins | Wait 15 minutes |
| `429 RATE_LIMITED` | Rate limit exceeded | Batch requests, raise the limit |
| `500 INTERNAL_ERROR` | "An unexpected error occurred" — the details are only in the backend log (`unhandled error`) | Backend log |

Other generic messages: `400` "Invalid identifier format" (a malformed UUID in the URL) and `400` "Deletion requires confirmation: repeat the request with ?confirm=true" (runs, artifacts, reports, dashboards).

Where to look next:

| Tool | Where | Shows |
|---|---|---|
| Audit log | Administration → **Audit log** (`/admin/audit`) | Failed logins, denied requests (`access.denied`), uploads and their failures |
| Background jobs | Administration → **Background jobs** (`/admin/jobs`), or `GET /api/v1/runs/<RUN_ID>/jobs` | Analysis, artifact processing and report jobs with their errors; **Retry** for failed jobs |
| Platform health | Administration → **Platform health** (`/admin/health`) | API, database, ingestion, jobs, storage; overall `UP` / `DEGRADED` / `DOWN` |
| Health endpoint | `GET /api/v1/health` (no login) | `{"status":"UP"}` when the API and database respond |
| API reference | `/api/docs` | Every endpoint with its schema |

## Sign-in and sessions

| Message | Cause | Fix |
|---|---|---|
| "That email and password don’t match. Try again or reset your password." (API: `401` "Invalid email or password") | Wrong password, unknown e-mail, or the user is deactivated | Check the address; use **Forgot password?**; ask an administrator whether the account is active |
| "Account temporarily locked after repeated failed logins. Try again later." (`423`) | 10 failed passwords in a row; the account is locked for 15 minutes | Wait 15 minutes, reset the password, or have an administrator deactivate and reactivate the user (clears the lock) |
| "Too many attempts — please wait a minute and try again." (`429`) | More than 20 sign-in attempts per minute from your address | Wait one minute |
| "Enter your email and password." | A field is empty | Fill in both fields |
| "There is no active Perfmon account for `<email>`. Ask an administrator to invite you." (`403 NO_ACCOUNT`) | Google sign-in succeeded, but no active Perfmon user has that e-mail. Google sign-in never creates accounts | An administrator invites the person with exactly that address (Administration → Users → **Invite user**) |
| "Google sign-in could not be verified. Please try again." | The Google token was rejected (wrong client ID, expired, unverified e-mail) or the backend could not reach `oauth2.googleapis.com` within 10 s | Check `GOOGLE_CLIENT_ID` matches the OAuth client; allow outbound HTTPS from the backend |
| No "Continue with Google" button | `GOOGLE_CLIENT_ID` is not set on the backend, or Google's script was blocked (the bundled nginx CSP allows scripts only from the Perfmon origin) | Set the variable and restart; see [Security](35-security.md#google-sign-in-optional) |
| "Couldn’t reach the Perfmon server. Check your internet connection and try again." | The browser could not connect at all | Check the network; open `<UI URL>/api/v1/health` |
| "The Perfmon server could not be reached. Please try again in a moment." | The UI received a 404/405/502+ or non-JSON answer for an API call: the `/api` proxy points to the wrong backend, or `VITE_API_BASE_URL` is wrong | Fix the backend address in `vercel.json` and `frontend/vercel.json` (Vercel) or the nginx `proxy_pass` (Docker) |
| "Perfmon is taking longer than usual to start. Please try again in a minute." | The backend did not answer its health check within 5 minutes (see [Cold start](#deployment-and-cold-start)) | Check the hosting dashboard and backend logs |
| "Reset link is invalid or has expired" | The link was already used or is older than its validity (self-service 30 minutes, admin link 24 hours, invitation 72 hours) | Request a new link |
| No reset e-mail arrives | SMTP is not configured. The reset link is then written to the backend log: `[auth] SMTP not configured — password reset link for <email>: <link>` | Configure `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM`, or an administrator uses the key icon (*Send password reset link*) on the user row and passes on the link shown |
| "Current password is incorrect" | Change-password with a wrong current password | Re-enter it, or use a reset link |
| "Password must be at least 8 characters" / "Password must contain letters and digits" | Password rule (8–200 characters, letters and digits) | Choose a compliant password |
| Signed out unexpectedly, sent back to the sign-in page | Any `401` ends the session in the UI: the token expired (12 hours, or 30 days with **Keep me signed in**), you signed out in that browser, the user was deactivated, or `JWT_SECRET` changed (for example after a redeploy that generated a new one) | Sign in again; keep `JWT_SECRET` stable across deployments |
| "You do not have permission to perform this action." (API: `403` "Missing permission: `<PERMISSION>`") | Your roles lack the permission; Administration tabs you may not use are hidden | Ask an administrator for a suitable role ([Security](35-security.md#roles-and-their-permissions)) |
| Backend log: `[bootstrap] No users exist and DEMO_ADMIN_PASSWORD is not set — set it to create the initial administrator.` | Empty database and no initial password configured | Set `DEMO_ADMIN_PASSWORD` (8+ characters, letters and digits) and restart; sign in as `DEMO_ADMIN_EMAIL` |

### User administration

| Message | Cause and fix |
|---|---|
| "A user with email `<email>` already exists" | E-mail addresses are unique (case-insensitive). Edit the existing user instead |
| "Unknown role(s): `<ROLE>`" | Only the built-in roles exist (see Roles & permissions) |
| "Only a SUPER_ADMIN can grant, revoke or deactivate SUPER_ADMIN accounts" | You are an `ADMIN`; ask a `SUPER_ADMIN` |
| "This is the last active SUPER_ADMIN; assign another SUPER_ADMIN first" | Promote someone else first |
| "You cannot deactivate your own account" / "You cannot remove your own user-management permission" | Have another administrator do it |
| "User is deactivated" | Reset links are only issued for active users; reactivate first |

## API keys

| Message | Cause | Fix |
|---|---|---|
| `401` "Authentication required" | Missing header, misspelled key, revoked key or expired key. Also when the key is sent in a form Perfmon does not accept | Send `Authorization: Bearer pmk_...`, `Authorization: Token pmk_...` or `X-API-Key: pmk_...`. Check the key's status in Administration → **API keys** (Revoked / Expired); rotate it if the secret was lost |
| `403` "Missing permission: EDIT_TEST" (or another permission) | The call needs a permission the key's scopes do not grant (`ingest` and `read` only; see [Security](35-security.md#api-keys)) | Use a user session for administrative calls, such as setting a baseline |
| `403` "API key is not authorized for this project" | The key is bound to another project than the run, integration or project you address | Use a key bound to that project (or an unbound key) |
| `400` "API key is not authorized for this project" | Same, when creating a run with `POST /runs` | As above |
| `404` "Run '`<RUN_ID>`' not found" | Typo in the Run ID, a deleted run, or a run of another organization | Copy the Run ID from the Test Runs page or the create-run response |
| "expiresAt must be an ISO date" / "expiresAt must be in the future" | Invalid expiry when creating or rotating | Use a future ISO date, for example `2027-01-31T00:00:00Z` |
| "Key is already revoked" | Rotating a revoked key | Create a new key |
| Pipeline worked yesterday, `401` today | The key expired or was rotated (rotation revokes the old secret immediately) | Update the CI secret with the new key |

## JMeter, live ingestion and runs

Most listener problems show up in `jmeter.log` as `Error writing metrics` with the HTTP status. A JMeter-side checklist is in [Set up JMeter for Perfmon](00b-jmeter-setup.md#troubleshooting).

| Message | Cause | Fix |
|---|---|---|
| `400` "Run ID is required: add ?runId=<RUN_ID> to the listener URL or a TAG_runId listener parameter" | The listener URL has no `runId` and no point carries a `runId` tag or a Run ID in `application` | Use `influxdbUrl=<perfmon>/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}` and pass `-Jperfmon.runId=...` |
| `400` "Unable to parse line protocol" | None of the lines could be parsed; `details` lists the parse errors | Send InfluxDB line protocol with `Content-Type: text/plain`; check custom senders for escaping |
| `404` "Run '`<RUN_ID>`' not found" | `perfmon.runId` is empty or wrong | Print the property; create the run first |
| `409` "Run `<RUN_ID>` is `<STATUS>`; live metrics are only accepted for SCHEDULED, QUEUED or RUNNING runs" | The run was already completed, aborted or is being analysed | Create a new run for every execution |
| `429` "Ingestion rate limit exceeded (`<N>` requests/sec). Batch more samples per request or raise the key's limit." | More than `INGEST_RATE_LIMIT_PER_SEC` (default 100/s, burst 200) per key | Send larger batches; raise the key's **Rate limit** or the server default |
| `413` "Request or file exceeds the size limit" | Ingestion body larger than 50 MB (20 MB for `/ingest/infrastructure`) | Split the batch |
| `400` "Aggregate metrics require runId. Never store performance metrics without a run." | `POST /api/v1/metrics` with an aggregate that has no `runId` | Add `runId`, or use `POST /runs/<RUN_ID>/metrics` |
| `400` "Invalid timestamp '`<value>`'" | A timestamp that is neither epoch nor ISO 8601 | Send epoch milliseconds or ISO 8601 |
| Live view stays empty, no errors | The listener `measurement` is not `jmeter`, or data arrived for another run | Set `measurement=jmeter` or add `&measurement=<name>` to the URL; check the Run ID |
| Only totals, no transactions | `summaryOnly=true` | Set `summaryOnly=false` |
| Collector: "project (key or id) or runId is required" / "server is required for server metrics" / "service is required for serviceMetrics" | Incomplete `/ingest/infrastructure` payload | Set `PERFMON_PROJECT` (or `PERFMON_RUN_ID`) and the server/service name ([Infrastructure Monitoring](17-infrastructure-monitoring.md)) |

### Creating and controlling runs

| Message | Cause | Fix |
|---|---|---|
| "Provide testId, or project + application + environment + test names" | `POST /runs` without a test reference | Send `testId`, or `project` and `test` (plus `application`/`environment`) |
| "Project '`<name>`' not found" | No project with that key, name or ID in your organization | Use the project key from Inventory → Projects |
| "Performance test '`<name>`' not found" | No test with that name (case-insensitive) for the given application/environment | Fix the name, or add `"createTestIfMissing": true` |
| "application and environment are required to auto-create a test" | `createTestIfMissing` without `application` or `environment` | Add both |
| "Application '`<name>`' not found" / "Environment '`<name>`' not found" | Unknown application code/name or environment name/type for that project | See [Applications](04-applications.md) and [Environments](05-environments.md) |
| "runId may contain letters, digits, ".", "_" and "-" (3-64 chars)" | Invalid caller-supplied Run ID | Omit `runId` to get a generated one, or fix it |
| "Run ID `<RUN_ID>` already exists" | Caller-supplied Run ID reused | Make it unique (for example include the build number) |
| "Run `<RUN_ID>` is `<STATUS>` and cannot be started" | `POST /runs/<id>/start` on a run that is not `SCHEDULED` or `QUEUED` | Nothing to do if it is already `RUNNING`; otherwise create a new run |
| "Only SCHEDULED or QUEUED runs can be cancelled (run is `<STATUS>`)" | Cancel on a started run | Use `POST /runs/<id>/abort` instead |
| "Nothing to update" | `PATCH /runs/<id>` with an empty body | Send at least one field |
| Run stays `ANALYZING` | The analysis job failed or no worker is running (`ENABLE_WORKER=false`, backend restarted) | Check `GET /runs/<RUN_ID>/jobs` and Administration → Background jobs; retry the failed job, or call `POST /runs/<RUN_ID>/complete` again — on an `ANALYZING` run this restarts the completion workflow ([Running Tests](07-running-tests.md)) |
| Run stays `QUEUED` | No metrics arrived, so it never switched to `RUNNING` | Check the listener (above), or call `POST /runs/<RUN_ID>/start` |
| Result `INCONCLUSIVE` | Fewer than 100 samples, no samples, or the run was aborted | Run longer, check that metrics or a JTL arrived; see [CI/CD Integration](30-ci-cd-integration.md#step-6---quality-gate) |

Background jobs are retried up to 3 times with growing delays (5 s, 10 s, 20 s ... capped at 5 minutes); jobs stuck in `PROCESSING` for 15 minutes (for example after a crash) are re-queued automatically. **Retry** works only on failed jobs: "Only FAILED jobs can be retried (job is `<STATUS>`)".

## JTL and artifact uploads

| Message | Cause | Fix |
|---|---|---|
| "Expected multipart/form-data with a "file" field" | The request was not `multipart/form-data` | Use `curl -F file=@results.jtl ...` (not `-d`/`--data-binary`) |
| "No file provided (multipart field "file")" | The form field has another name | Name the field `file` |
| "Uploaded file is empty" | Zero-byte file (JMeter wrote nothing) | Check that `-l results.jtl` was set and JMeter ran |
| `413` "File exceeds the `<N>` MB upload limit" | Larger than `MAX_UPLOAD_MB` (default 512; 50 on the Render blueprint) | Gzip the JTL (accepted with `kind=JTL`), raise `MAX_UPLOAD_MB`, and check proxy limits (bundled nginx: 600 MB) |
| "Unknown artifact kind '`<kind>`'" | Typo in `kind` | Use one of `HTML_REPORT`, `JTL`, `CSV`, `JMX`, `LOG`, `SCREENSHOT`, `SERVER_LOG`, `APP_LOG`, `CONFIG`, `TEST_DATA`, `JSON`, `XML`, `PDF`, `EXCEL`, `ZIP`, `OTHER` |
| "File validation failed: JTL artifact must be a text file" | Binary content uploaded as JTL | Upload the CSV/XML results file, plain or gzip |
| "Executable and script files are not accepted as artifacts" | Blocked extension (`.exe`, `.jar`, `.ps1`, `.bat`, ...) | Zip scripts you want to archive is not possible either if they are executables; keep them in version control |
| "File validation failed: Executable content is not allowed" | The content is a Windows or Linux executable, whatever its name | Do not upload binaries |
| "File rejected by malware scanner" | `MALWARE_SCAN_URL` reported the file as not clean | Check the file |
| Response `"duplicate": true`, "Identical file (same SHA-256) already stored as the latest version — no new version created." | The same file was uploaded again | Nothing to do. To re-import it, use **Reprocess** on the artifact (`POST /artifacts/<id>/versions/<v>/reprocess`) |
| JTL imported but run charts unchanged | The run also has live data; live data stays the primary source and the JTL is kept as a second source | Compare sources on the run page; see [JMeter Integration](09-jmeter-integration.md#jtl-import) |
| Processing stays `QUEUED` | No worker is processing jobs | See [Background jobs](#creating-and-controlling-runs) above |
| Processing `FAILED` | The error text is stored on the version (`processingError`) | Open the artifact; fix and **Reprocess** |

## HTML reports and the report viewer

| Message | Cause | Fix |
|---|---|---|
| "ZIP does not contain an index.html — compress the JMeter report output directory (index.html, content/, sbadmin2-1.0.7/...)" | The ZIP was created from the wrong folder | `cd report && zip -qr ../report.zip .` |
| "HTML report must be a .zip of the report directory or a single .html file" | `kind=HTML_REPORT` with another file type | Upload a `.zip` or `.html` |
| "File validation failed: HTML report .zip is not a valid ZIP archive" / "Invalid ZIP archive: ..." | Corrupt or renamed archive (for example `.tar.gz`) | Create a real ZIP |
| "... archive has more than 50000 entries" / "archive expands beyond the 4 GB limit" / "entry `<name>` is too large" / "entry `<name>` has a suspicious compression ratio" | Zip-bomb protection | Upload only the report directory |
| Processing `FAILED`: "report file too large to parse" | `statistics.json`, `dashboard.js`, `graph.js` or `index.html` exceeds 64 MB | Generate the report from a smaller JTL or with fewer transactions |
| Viewer: "Report link expired or invalid. Reopen the report from Perfmon." (`403`) | Viewer URLs are signed and expire after 1 hour (or `JWT_SECRET` changed) | Reopen the report from the run page |
| Viewer: "Bad path" (`400`) | A path inside the report was rejected as unsafe | Regenerate the report with JMeter; do not edit its links |
| Viewer frame stays blank or is refused | The UI origin is not in `PUBLIC_URL`/`CORS_ORIGINS` (used for `frame-ancestors`), or the UI's CSP `frame-src` does not include the report origin (bundled nginx allows `http://localhost:8081` and `https:`) | Align `PUBLIC_URL`, `CORS_ORIGINS`, `REPORT_CONTENT_ORIGIN` and the CSP |

More detail in [Uploading HTML Reports](10-uploading-html-reports.md#troubleshooting).

## Integrations

### Saving and testing

| Message | Cause | Fix |
|---|---|---|
| "Secrets must be sent in "credentials", not "config" (`<keys>`)" | A token or password was put into `config` | Move it to the credential fields |
| "url must start with http:// or https://" | Invalid URL | Include the scheme |
| "config.version must be v1 or v2" | InfluxDB version field | Use `v1` or `v2` |
| "Invalid credential name '`<name>`'" | Credential names must start with a letter (letters, digits, `_ . -`, up to 60 characters) | Rename |
| "Connection timed out after 10s" | The remote system did not answer within 10 s | Check the URL, firewall and proxy between the Perfmon backend and the system |
| "Connection refused (host reachable but nothing is listening on that port)" | Wrong port or service down | Check the port |
| "Host not found (DNS lookup failed)" | Unknown host name from the backend's point of view | Use a name the backend can resolve (in Docker, not `localhost`) |
| "TLS error (`<code>`)" | Certificate problem (self-signed, expired, wrong name) | Use a valid certificate or the correct host name |
| "`<system>`: authentication failed (HTTP 401) — check the credentials" (or 403) | Wrong or insufficient token/password | Re-enter the credentials; check token scopes |
| "`<system>`: endpoint not found (HTTP 404) — check the URL" | Wrong base URL or path prefix | Fix the URL |
| "Integration URL is not configured" | Empty URL | Enter the URL |
| "GitHub token is not configured" / "GitLab token is not configured" / "Azure DevOps personal access token is not configured" | Missing credential | Enter the token |
| "Azure DevOps returned a non-JSON response (sign-in page?) — check the PAT" | The PAT was rejected and Azure DevOps answered with a sign-in page | Create a PAT with Build (read) |
| Health `DEGRADED` | The test succeeded but took more than 3 s | Check network latency |
| Credentials suddenly "authentication failed" after a migration or redeploy | `ENCRYPTION_KEY` changed; stored credentials can no longer be decrypted and are treated as missing | Re-enter the credentials ([Security](35-security.md#encryption-of-stored-secrets)) |

### Importing JMeter results from InfluxDB

| Message | Cause | Fix |
|---|---|---|
| "Choose an InfluxDB integration" | The selected integration is not of type `INFLUXDB` | Pick the InfluxDB integration |
| "Integration is disabled" | Status `DISABLED` | Enable it |
| "Integration is bound to a different project than the run" | Project mismatch | Use an unbound integration or one of the run's project |
| "Run `<RUN_ID>` is ANALYZING; wait for analysis to finish or use another run" (or `CANCELLED`) | Wrong run state | Wait, or create a new run |
| "Run `<RUN_ID>` has no start time — give the test's time window (from / to)" | A run that never received data | Send `from` and `to` |
| ""to" must be after "from"" / "The time window is limited to 7 days per import" | Invalid window | Narrow the window |
| "No "`<measurement>`" points found in `<integration>` between `<from>` and `<to>`. Check the time window, measurement and application tag." | Nothing in that window | Check the clock, the measurement name (`jmeter`) and the `application` filter |
| "The integration needs a database (InfluxDB 1.x) — edit it under Platform → Integrations" / "The integration needs an organization and bucket (InfluxDB 2.x) — edit it under Platform → Integrations" | Incomplete integration configuration | Edit the integration |
| "More than 2,000,000 points in the window — narrow the time range or filter by application" | Too much data for one import | Narrow the window or filter by application |
| "InfluxDB query error: ..." | InfluxDB rejected the query | Check database/bucket names and the token's read permission |

Other import endpoints: "`<TYPE>` integrations do not support metric import", "No queries given and no mappings configured for this integration", "Run `<RUN_ID>` has not started yet — nothing to import". OpenTelemetry: "No data points could be correlated to a run: add the perfmon.run_id resource attribute or ?runId=<RUN_ID>". Step-by-step setup is in [InfluxDB (optional)](00c-influxdb-setup.md).

## Reports

| Message | Cause | Fix |
|---|---|---|
| "runId is required for a TEST_EXECUTION report" | Missing run | Select a run |
| "Run `<RUN_ID>` is `<STATUS>`; generate the report once it has finished" | The run is `SCHEDULED`, `QUEUED` or `RUNNING` | Complete the run first |
| "Run `<RUN_ID>` does not belong to this project" | `projectId` and run disagree | Omit `projectId` or fix it |
| "runIds must contain at least two runs for a COMPARISON report" / "runIds contains the same run twice" | Comparison needs 2–6 distinct runs | Choose distinct runs |
| "projectId is required for an EXECUTIVE report" | Missing project | Select a project |
| "\`from\` must be before \`to\`" | Invalid period | Fix the dates |
| "Test does not belong to this project" / "Environment does not belong to this project" | Filter from another project | Pick a test/environment of the project |
| "Report is `<STATUS>`; it can be downloaded once READY" / "Report is `<STATUS>`" (preview) | Generation still running or failed | Wait for `READY`; regenerate if `FAILED` |
| "Generation did not complete (the job failed or was lost). Regenerate to try again." | A report stayed `QUEUED`/`GENERATING` for more than 2 minutes without a live job, so it was marked `FAILED` | Click **Regenerate**; check Background jobs if it repeats |
| "Report type `<TYPE>` cannot be generated" | Only `TEST_EXECUTION`, `COMPARISON` and `EXECUTIVE` can be (re)generated | Use a supported type |

## Dashboards

| Message | Cause | Fix |
|---|---|---|
| "Only the owner can modify a private dashboard" | A private dashboard of another user | Clone it, or ask the owner to share it |
| "Dashboard was modified by someone else (version `<N>`); reload and retry" | Concurrent edit (optimistic locking) | Reload, re-apply your change, save |
| "System dashboards cannot be deleted; clone it to customise, or edit it in place" | Deleting a built-in dashboard | Clone it instead |
| "Duplicate variable name '`<name>`'" | Two dashboard variables share a name | Rename one |
| "timeRange.from must be before timeRange.to" | Invalid time range | Fix the range |
| "`<projectId|applicationId|environmentId|testId>` must be a UUID" | A filter value is not an ID | Select the value from the picker |
| "Invalid dashboard definition" | Imported JSON does not match the schema; `details` lists the paths | Fix the listed fields |

See [Dashboards](13-dashboards.md) and [Dashboard Builder](14-dashboard-builder.md).

## Administration and retention

| Message | Cause | Fix |
|---|---|---|
| "Purge request is older than 24h — create a new request to refresh the estimate" | Confirmation more than 24 hours after the request | Request the purge again |
| "Purge request is `<STATUS>`" / "Purge request was already confirmed" / "Purge request not found or not pending" | The request was already executed, cancelled or confirmed by someone else | Check **Purge history** |
| "Invalid value for `<key>`: ..." / "Unknown field(s) for `<key>`: ..." | Settings validation | See [Data Retention](38-data-retention.md#platform-settings-api) |
| "errorPctWarn must be ≤ errorPctFail" | Inconsistent default result thresholds | Lower the warning threshold |

## Deployment and cold start

| Message or symptom | Cause | Fix |
|---|---|---|
| Backend exits: "Invalid configuration: - JWT_SECRET must be set (>= 16 chars)" / "- ENCRYPTION_KEY must be set (>= 16 chars)" | Missing or short secrets | Set both to long random values (`render.yaml` generates them) |
| Log warning "[perfmon] WARNING: JWT_SECRET uses the development default. Override it in production." (same for `ENCRYPTION_KEY`) | Docker Compose defaults (`change-me-...`) with `NODE_ENV=production` | Override both |
| Log "[perfmon] fatal startup error: ..." | Startup failed (database unreachable, migration error, storage init) | Read the error; check `DATABASE_URL` (Neon: direct, non-pooler host, `sslmode=require`) |
| UI banner "Connecting to Perfmon… `<N>`s — starting up, this usually takes under a minute. You don’t need to do anything." | The backend is asleep or restarting (Render free tier sleeps after about 15 minutes idle). The UI waits for `/api/v1/health` and then repeats the request once | Wait. Reads and sign-in are retried automatically for up to 5 minutes |
| "Perfmon is taking longer than usual to start. Please try again in a minute." | The backend did not become healthy within 5 minutes, **or** the interrupted request was an upload or another change that is not repeated automatically (to avoid doing it twice) | Retry the action once the banner disappears; for long outages check the Render dashboard |
| Backend still falls asleep | Keep-alive not active | The backend pings its own `/api/v1/health` every 4 minutes when `RENDER_EXTERNAL_URL` (set by Render) or `KEEP_AWAKE_URL` is present and `KEEP_AWAKE` is not `false`; failures are logged as `[keep-awake] <url> failed: ...`. The GitHub workflow `.github/workflows/keepalive.yml` pings every 10 minutes ([Run Perfmon 24/7](00f-deploy-24x7.md#4-keep-it-awake)) |
| Browser console: CORS error | The UI calls the API on another origin (`VITE_API_BASE_URL`) that is not listed in `CORS_ORIGINS` | Add the UI origin to `CORS_ORIGINS` (comma-separated) and restart |
| `404` "Route `<METHOD>` `<path>` not found" | Wrong path, typically a missing `/api/v1` prefix or `PERFMON_URL` already ending in `/api/v1` | Use the base URL without `/api/v1` and append it in the calls |
| `jmeterInflux ListenerUrl` in the create-run response points to the UI or `localhost` | It is built from `PUBLIC_URL` | Build the listener URL from your `PERFMON_URL` instead, or fix `PUBLIC_URL` |
| Uploads fail on Render at 50 MB | `MAX_UPLOAD_MB=50` in `render.yaml` (uploads are stored in PostgreSQL) | Move uploads to S3/R2 (`STORAGE_DRIVER=s3`) and raise the limit |
| Platform health `DEGRADED` | Storage health check failed, more than 50 failed jobs in 24 hours, or more than 5 requests waiting for a database connection | Open the Platform health tab for the failing part |
| Platform health `DOWN` | The database does not respond | Check the database service |

## Related sections

- [Getting Started](01-getting-started.md)
- [Set up JMeter for Perfmon](00b-jmeter-setup.md)
- [Users, roles & API keys](00e-users-and-api-keys.md)
- [Run Perfmon 24/7 in the cloud](00f-deploy-24x7.md)
- [JMeter Integration](09-jmeter-integration.md)
- [Uploading HTML Reports](10-uploading-html-reports.md)
- [CI/CD Integration](30-ci-cd-integration.md)
- [Security](35-security.md)
- [Data Retention](38-data-retention.md)
