# Data Retention

Perfmon keeps everything it receives until an administrator explicitly deletes it. A retention policy defines *how old* data must be before it may be purged, but **nothing is deleted automatically**: every purge is a two-step request and confirmation, executed in the foreground and recorded in the audit log. This chapter explains what is stored, the retention settings, the purge workflow in the UI and the API, what retention does not cover, and the other platform settings that live next to retention (score weights, regression and result thresholds).

> "Data is never deleted automatically: create a purge request and confirm it explicitly." — the note returned by `GET /api/v1/admin/retention` and shown on the Retention tab.

## What Perfmon stores

| Data | Where | Grows with |
|---|---|---|
| Per-interval metrics of runs (run, transaction, API, response code, error) and infrastructure, JVM, database and service metrics, generic metric points | PostgreSQL (the time-series pool; the same database unless `TIMESERIES_DB_URL` points elsewhere) | Test duration × transactions × send interval; collector and import volume |
| Run summaries, transaction statistics, SLA results, regressions, recommendations, insights | PostgreSQL | Number of runs |
| Artifacts (JTL, HTML reports and their extracted files, logs, screenshots, ...) | Object storage (`STORAGE_DRIVER`: `local`, `s3`, `azure` or `postgres`) plus metadata rows | Upload size; every new version is kept |
| Indexed log entries (from `LOG`, `SERVER_LOG`, `APP_LOG` artifacts) | PostgreSQL | Log volume (up to 2 million lines per file) |
| Generated reports (Reports module) | PostgreSQL (content model; files are rendered on download) | Number of report versions |
| Audit log | PostgreSQL | User and API activity |
| Inventory, tests, runs, dashboards, alerts, events, settings | PostgreSQL | Small |

With `STORAGE_DRIVER=postgres` (the `render.yaml` default) uploaded files live in the database too, so on a Neon free database (0.5 GB) artifacts are usually the first thing to fill it.

## Retention policy

Platform → Administration → **Retention** (`/admin/retention`, permission `MANAGE_SETTINGS`).

| UI label | Setting key | Default | Allowed | What a purge deletes | Age is measured by |
|---|---|---|---|---|---|
| Raw metrics | `rawMetricsDays` | 90 days | 1 – 36,500 | Rows in `run_metrics`, `transaction_metrics`, `api_metrics`, `response_code_metrics`, `error_metrics`, `server_metrics`, `jvm_metrics`, `database_metrics`, `service_metrics`, `metric_points` | Metric timestamp |
| Aggregated metrics | `aggregatedMetricsDays` | 730 days | 1 – 36,500 | Run summaries, transaction statistics, SLA results, regressions, recommendations, insights (`run_summary`, `transactions`, `sla_results`, `regressions`, `recommendations`, `insights`) | Run end time (or start/creation time if it never ended) |
| Artifacts | `artifactsDays` | 365 days | 1 – 36,500 | Artifact records with all versions, **and their files in object storage** (including extracted HTML report files); soft-deleted artifacts are included | Artifact creation time |
| Reports | `reportsDays` | 730 days | 1 – 36,500 | Generated report versions (`reports`) | Report creation time |
| Logs | `logsDays` | 30 days | 1 – 36,500 | Indexed log entries (`log_entries`) | Log line timestamp |
| Audit log | `auditDays` | 365 days | 30 – 36,500 | Audit entries (`audit_logs`) | Entry timestamp |

Each data type is purged independently. Purging raw metrics of an old run leaves its summary, SLA verdict and result in place, so run lists, trends and comparisons based on summaries keep working; per-second charts of that run become empty. Purging aggregated metrics removes the summary data but **not the run itself**: the run stays listed with its status, result and score.

### Change the policy

1. Open Administration → **Retention**.
2. In **Retention policy**, pick a preset or **Custom…** and enter the number of days for each data type (the field shows the allowed range when a value is invalid).
3. Click **Save policy**. The **Eligible for purge (estimates)** table is refreshed with the new cut-off dates.

Saving the policy deletes nothing. The change is audited as `settings.update` with the before and after values.

## Purging data

### In the UI

1. Administration → **Retention** → **Eligible for purge (estimates)** lists, for each data type, the retention, the cut-off date and the number of rows older than the cut-off.
2. Click **Request purge** on a row (disabled when nothing is eligible). Confirm **Create purge request** in the dialog. Nothing is deleted yet; the row now shows a **Pending** chip.
3. Review the request. Another administrator can confirm it, which gives you a four-eyes check if you want one.
4. Click **Confirm…**. The dialog "Confirm purge — this cannot be undone" shows the estimated rows and the cut-off. Type the data type name shown in the dialog (for example `raw_metrics`) and click **Permanently delete**.
5. The purge runs immediately (in the request; large purges can take a while). The result appears in **Purge history** with the number of deleted rows.

Use the **X** button next to a pending request to cancel it.

### Rules

| Rule | Detail |
|---|---|
| One pending request per data type | Creating a new request cancels an older pending one for the same type |
| Requests expire for confirmation after 24 hours | "Purge request is older than 24h — create a new request to refresh the estimate" |
| Fixed cut-off | The cut-off is computed when the request is created and stored with it; data that becomes older afterwards is not included |
| Batched deletion | 5,000 rows per statement; artifacts in batches of 200, files removed from storage before their rows |
| Storage errors | A file that cannot be deleted from storage is logged and skipped (the purge continues) |
| Status values | `PENDING_CONFIRMATION`, `EXECUTING`, `EXECUTED`, `CANCELLED`, `FAILED` (with the error text) |
| Audit | `retention.purge_request`, `retention.purge_execute` (with per-table counts, or `FAILURE` with the error), `retention.purge_cancel` |

PostgreSQL does not return freed space to the operating system immediately; autovacuum makes it reusable for new data. The database size shown under Administration → **Platform health** therefore may not drop right after a purge.

### With the API

The retention endpoints require `MANAGE_SETTINGS`. API keys cannot hold that permission (their scopes are only `ingest` and `read`), so use a user session:

```bash
TOKEN=$(curl -fsS -X POST "$PERFMON_URL/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}' | jq -r .token)
AUTH="Authorization: Bearer $TOKEN"

# Policy, estimates and pending requests
curl -fsS "$PERFMON_URL/api/v1/admin/retention" -H "$AUTH" | jq '{policy, estimates, pending}'

# Change the policy (only the given fields are changed)
curl -fsS -X PUT "$PERFMON_URL/api/v1/admin/settings/retention" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"rawMetricsDays":60,"logsDays":14}'

# Request a purge (nothing is deleted yet)
PURGE_ID=$(curl -fsS -X POST "$PERFMON_URL/api/v1/admin/retention/purges" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"dataType":"raw_metrics"}' | jq -r .id)

# Confirm and execute it (or cancel with .../cancel)
curl -fsS -X POST "$PERFMON_URL/api/v1/admin/retention/purges/$PURGE_ID/confirm" -H "$AUTH" | jq '{status, deletedRows, details}'

# History (last 200 requests)
curl -fsS "$PERFMON_URL/api/v1/admin/retention/purges" -H "$AUTH" | jq '.[] | {dataType, status, cutoff, estimatedRows, deletedRows}'
```

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/admin/retention` | Policy, per-type estimates (`dataType`, `label`, `retentionDays`, `cutoff`, `rows`), pending requests |
| `GET /api/v1/admin/retention/purges` | Purge history |
| `POST /api/v1/admin/retention/purges` | Body `{"dataType": "raw_metrics" \| "aggregated_metrics" \| "artifacts" \| "reports" \| "logs" \| "audit"}` → `201`, status `PENDING_CONFIRMATION` |
| `POST /api/v1/admin/retention/purges/:id/confirm` | Executes the purge; `409` "Purge request is <STATUS>" if it is no longer pending, `409` "Purge request was already confirmed" on a race |
| `POST /api/v1/admin/retention/purges/:id/cancel` | Cancels a pending request; `409` "Purge request not found or not pending" otherwise |

### Scheduling purges yourself

Perfmon has no built-in scheduler for purges. If you want a regular clean-up, run the request-and-confirm calls above from a scheduled job of your own (cron, a CI schedule) with a dedicated administrator account whose password is kept in that system's secret store. Export the audit log first (`GET /api/v1/admin/audit/export`) if you need to keep entries longer than the audit retention.

## What retention does not cover

Be aware of the following data that the retention purge does **not** touch, and of operations that do not delete what you might expect:

| Data or operation | What happens |
|---|---|
| Test runs themselves (`test_runs`) | Never purged by retention. Only their metrics, summaries and analysis results are |
| Deleting a run (`DELETE /runs/:id?confirm=true`, permission `DELETE_RUN`; the UI has no delete button for runs) | Soft delete: the run is hidden, but its metrics, artifacts and analysis stay in the database until the age-based purges remove them. There is no restore endpoint for runs and no hard delete of a single run |
| Deleting an artifact | Soft delete: hidden and restorable (`POST /artifacts/:id/restore`); files stay in storage until an **Artifacts** purge removes them by age |
| Archiving a test or application | Hides it; nothing is deleted |
| Deleting a project (`DELETE /projects/:id?confirm=<project key>`) | Deletes the project's database rows (tests, runs, metrics, artifacts metadata) through cascading deletes. The route does not delete the artifact **files** in object storage; with `local`, `s3` or `azure` storage they remain until removed manually |
| Events and annotations, alerts | Not covered by any retention type |
| Background jobs (`background_jobs`) | Never cleaned up; completed and failed jobs accumulate (visible under Administration → **Background jobs**) |
| Revoked session tokens (`revoked_tokens`) | Never cleaned up. The schema comment mentions a maintenance job, but no such job exists in the code |
| Purge history (`retention_purges`) | Kept |
| Dashboards, SLA profiles, releases, builds, integrations, servers and services | Kept until deleted individually |
| Data in your own InfluxDB, Prometheus or Dynatrace | Never touched; Perfmon only reads from them |

## Platform settings API

The Retention tab shares one settings store with Administration → **Settings** (Performance Score weights, Regression thresholds, Default result thresholds). All groups are per organization, merged over built-in defaults, and require `MANAGE_SETTINGS`.

```bash
# All groups, with _meta (who changed what, when) and _defaults
curl -fsS "$PERFMON_URL/api/v1/admin/settings" -H "$AUTH" | jq 'del(._defaults)'

# Update one group; only the given fields change
curl -fsS -X PUT "$PERFMON_URL/api/v1/admin/settings/default_result_thresholds" -H "$AUTH" \
  -H 'content-type: application/json' -d '{"errorPctWarn":0.5,"errorPctFail":2}'
```

| Key | Fields and defaults | Validation |
|---|---|---|
| `score_weights` | `sla` 30, `responseTime` 20, `throughput` 15, `errorRate` 15, `infrastructure` 10, `regression` 10 | Each 0 – 1000; at least one weight > 0 (weights are renormalized over the factors that have data) |
| `regression_thresholds` | `p95Pct` 10, `p99Pct` 15, `avgPct` 10, `tpsDropPct` 10, `errorRateIncreasePts` 1, `cpuIncreasePts` 15, `memoryIncreasePts` 15, `minTransactionSamples` 30, `minAbsoluteMs` 25 | Percentages and points 0 – 1000; `minTransactionSamples` integer; `minAbsoluteMs` 0 – 1,000,000 |
| `default_result_thresholds` | `errorPctFail` 5, `errorPctWarn` 1 (used when a test has no SLA rule for the error rate) | 0 – 100; `errorPctWarn` must be ≤ `errorPctFail` |
| `retention` | See [Retention policy](#retention-policy) | `auditDays` ≥ 30, others ≥ 1, all ≤ 36,500, integers |
| `live` | `defaultRefreshSec` 5 | 1 – 3600, integer |

Error messages: "Invalid value for <key>: ..." (validation), "Unknown field(s) for <key>: ..." (misspelled field), "errorPctWarn must be ≤ errorPctFail", and `404` "Setting '<key>' not found" for an unknown group. Every change is audited (`settings.update`, with before and after).

## Sizing tips

- Keep **Raw metrics** short (30 – 90 days) and **Aggregated metrics** long: trends, comparisons and release reports use the summaries.
- Upload the JTL only when you need exact percentiles; it is stored as an artifact *and* expanded into raw metrics.
- With `STORAGE_DRIVER=postgres`, purge **Artifacts** regularly or move uploads to S3/R2 (`STORAGE_DRIVER=s3`).
- Watch the database size under Administration → **Platform health** (`GET /api/v1/system/health`, field `db.sizeBytes`).

## Related sections

- [Security](35-security.md)
- [Users, roles & API keys](00e-users-and-api-keys.md)
- [Run Perfmon 24/7 in the cloud](00f-deploy-24x7.md)
- [Uploading HTML Reports](10-uploading-html-reports.md)
- [Regression Detection](23-regression-detection.md)
- [Troubleshooting](39-troubleshooting.md)
