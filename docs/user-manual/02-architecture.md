# Architecture

This section describes how Perfmon is built and how data moves from a load generator to the dashboards and analysis results. Understanding the data flow makes it much easier to configure integrations correctly and to diagnose problems: almost every "metrics are missing" issue can be located at one of the stages described here.

## Components

| Component | Technology | Responsibility |
|---|---|---|
| Backend API | Node.js, Fastify (`backend/src`) | REST API under `/api/v1`, ingestion endpoints, authentication and RBAC, artifact handling, analysis engine, background job worker |
| Report content server | Same backend process, second listener (`REPORT_CONTENT_PORT`, default `8081`) | Serves extracted HTML reports from a separate origin with a CSP sandbox |
| PostgreSQL | PostgreSQL 16 | Metadata (projects, tests, runs, artifacts), time-series metric tables, background job queue, audit log |
| Optional time-series database | PostgreSQL (`TIMESERIES_DB_URL`) | Separate database for metric tables; defaults to `DATABASE_URL` |
| Object storage | Local disk, S3/MinIO or Azure Blob (`STORAGE_DRIVER`) | Artifact files and extracted HTML reports |
| Frontend | React SPA served by nginx (`frontend/src`) | Web UI; nginx proxies `/api/` to the backend with buffering disabled for Server-Sent Events |
| Perfmon Collector | Node.js script (`collector/collector.mjs`) | Optional host agent that sends CPU, memory and load metrics |

## Data flow

```text
            +---------------+         +--------------------- Perfmon backend ---------------------+
JMeter ---->| Backend       |  HTTP   | /api/v1/ingest/influx/write   InfluxDB line protocol       |
            | Listener      +-------->| /api/v1/runs/{runId}/metrics  JSON samples / aggregates    |
CI/CD ----->| curl / API    |         | /api/v1/metrics               generic multi-run batches    |
Collector ->+---------------+         | /api/v1/ingest/infrastructure server, JVM, DB metrics       |
                                      |                                                             |
                                      | In-memory per-second aggregation + latency histograms      |
                                      |   -> batched upserts every INGEST_FLUSH_INTERVAL_MS         |
                                      | Job queue (PostgreSQL, SKIP LOCKED): artifact processing,   |
                                      |   JTL import, run finalization, re-analysis, notifications  |
                                      +------------+-------------------+--------------------+-------+
                                                   |                   |                    |
                                              PostgreSQL         Object storage    Report content origin
                                                   |                                  (:8081, sandboxed)
React SPA <------------- REST + SSE ---------------+
```

### Ingestion path

1. A client sends data to one of the ingestion endpoints. Each request is authenticated, checked for the `INGEST_METRICS` permission and passed through a per-key token-bucket rate limiter.
2. The request is mapped to a run by its Run ID (or UUID). Data for runs in `SCHEDULED` or `QUEUED` status moves the run to `RUNNING` and sets its start time to the earliest timestamp received. Runs in any other status reject live data with `409 Conflict`.
3. Samples and aggregates are accumulated in memory per run, per second and per transaction. Raw samples are recorded in a log-bucketed latency histogram.
4. Buckets that have not been touched for one second are flushed in a single transaction into `run_metrics`, `transaction_metrics`, `response_code_metrics`, `error_metrics` and `api_metrics`. The buffer is also flushed when it exceeds `INGEST_MAX_BUFFER` entries, when a run is completed, and on `POST /api/v1/ingest/flush`.
5. After each flush the backend publishes a `metrics` event on the live event hub, and the run's `live_last_ingest_at` timestamp is updated.

### Metric sources

Every metric row carries a `source`. A run can hold metrics from more than one source at the same time:

| Source | Produced by | Notes |
|---|---|---|
| `live` | Backend Listener, `POST /runs/:id/metrics`, `POST /metrics` | Preferred source for charts and summaries |
| `jtl` | Processing of an uploaded JTL artifact | Replaced completely when a new JTL version is processed |
| `html_report` | Parsing of an uploaded JMeter HTML report | Summary and transaction table only, no time series |

When a run has several sources, charts and the primary summary use `live` first, then `jtl`, then `import`. The HTML report summary is always kept separately and is used for the reconciliation check (live versus report).

### Artifact path

Uploads are streamed to a temporary file while the SHA-256 checksum is computed, validated, stored in object storage and recorded as a new artifact version. Files that need processing (HTML reports, JTL files and logs) produce an `artifact.process` background job. See [Uploading HTML Reports](10-uploading-html-reports.md) and [Artifact Management](11-artifact-management.md).

### Analysis path

`POST /api/v1/runs/:id/complete` flushes buffered metrics, sets the end time, sets the run to `ANALYZING` and queues a `run.finalize` job. The job computes summaries, evaluates SLAs, resolves the baseline, analyses bottlenecks, detects regressions, generates insights, and computes the performance score and result before setting the final status. See [Running Tests](07-running-tests.md).

## Background jobs

Background work is stored in the `background_jobs` table and processed by a worker inside each backend instance (`ENABLE_WORKER=true`, `WORKER_CONCURRENCY` parallel jobs, default 4). Several backend replicas can process jobs safely.

| Job type | Enqueued by | Purpose |
|---|---|---|
| `artifact.process` | Upload of an HTML report, JTL or log artifact; reprocess endpoint | Extract and parse a report, import a JTL, index log lines |
| `run.finalize` | Run completion | Full analysis and final status |
| `run.reanalyze` | Reanalyze endpoint; processing of an HTML report or JTL for an already finished run | Recompute analysis without changing the status |
| `report.generate` | `run.finalize` | Final Test Execution report |
| `alert.notify` | Alert evaluation | Notification delivery |

Job statuses are `QUEUED`, `PROCESSING`, `COMPLETED` and `FAILED`. A failed job is retried with exponential back-off (5 s, 10 s, 20 s, ... capped at 300 s) up to three attempts. Jobs left in `PROCESSING` for more than 15 minutes (for example after a crash) are returned to the queue. Jobs for a run are listed by `GET /api/v1/runs/:id/jobs`.

## Live updates

The backend exposes a Server-Sent Events stream per run (`GET /api/v1/runs/:id/stream`). The stream polls the database at the requested interval and also forwards status changes published by the in-process event hub, so it works with several backend replicas. See [Live Monitoring](12-live-monitoring.md).

## Percentile accuracy

Percentiles cannot be averaged correctly, so Perfmon records how each percentile was computed and exposes it as `percentileMethod`:

| Method | When | Accuracy |
|---|---|---|
| `exact_histogram` | All data in the window came from raw samples (JSON samples or JTL) | Merged from log-bucketed histograms with about 2.5% relative resolution (bucket growth factor 1.05) |
| `source_reported` | A single pre-aggregated value covers the window, or the value comes from an HTML report | As reported by the source |
| `interval_weighted_approx` | Several pre-aggregated values (for example 5-second Backend Listener intervals) were combined | Count-weighted average of interval percentiles; an approximation. The UI marks such values with "≈" |

## Storage layout

Artifacts are stored under a predictable key:

```text
projects/<project-key>/tests/<test-slug>-<test-id-8>/runs/<RunID>/<folder>/<artifact-id>/v<N>/<file>
```

`<folder>` is `reports`, `jtl`, `csv`, `jmx`, `logs`, `screenshots`, `config`, `test-data` or `other`. Extracted HTML reports are stored next to the original under `.../v<N>/site/`.

## Security architecture

- All `/api/v1` routes require authentication except login, password reset, sign-in configuration and health; `/metrics` and `/report-content/` are public (report content is protected by signed URLs).
- Permissions are checked per route (RBAC with roles such as `PERFORMANCE_ENGINEER`, `QA_ENGINEER`, `VIEWER`).
- A global API rate limit (`API_RATE_LIMIT_PER_MIN`, default 1200 per minute per credential) applies to all routes except ingestion and report content, which use the ingestion limiter instead.
- Uploaded HTML is never served from the application origin. It is served from the report content origin with `Content-Security-Policy: sandbox ...` and short-lived HMAC-signed URLs.
- Security-relevant actions (uploads, deletions, run lifecycle changes, denied access) are written to the audit log.

## Key configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | API port |
| `REPORT_CONTENT_PORT` / `REPORT_CONTENT_ORIGIN` | `8081` / empty | Separate origin for HTML reports; when the origin is empty, report content is served (still sandboxed) by the main API |
| `PUBLIC_URL` | `http://localhost:5173` | Used to build the listener URL returned by `POST /runs` |
| `DATABASE_URL` / `TIMESERIES_DB_URL` | local PostgreSQL / empty | Databases |
| `STORAGE_DRIVER` | `local` | `local`, `s3` or `azure` |
| `MAX_UPLOAD_MB` | `512` | Maximum artifact size |
| `INGEST_RATE_LIMIT_PER_SEC` | `100` | Default ingestion requests per second per credential (burst 2x) |
| `INGEST_FLUSH_INTERVAL_MS` | `1000` | Aggregator flush timer |
| `INGEST_MAX_BUFFER` | `50000` | Buffered buckets before a forced flush |
| `WORKER_CONCURRENCY` / `ENABLE_WORKER` | `4` / `true` | Background job worker |
| `MALWARE_SCAN_URL` | empty | Optional malware scan hook for uploads |
| `JWT_SECRET`, `ENCRYPTION_KEY` | none | Required, at least 16 characters |
