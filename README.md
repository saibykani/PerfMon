# PerfMon

**Performance Engineering. Observability. Intelligence.**

Perfmon is a performance engineering platform for Performance Engineers, QA, SREs, Developers, Architects and Managers.
It is the central place to run and track load tests (JMeter first), ingest live metrics, store HTML reports and artifacts, analyse runs,
detect regressions and bottlenecks, and produce stakeholder reports — every data point traceable to a **Run ID** (e.g. `PF-2026-10-06-000127`).

> **Status:** under active development, delivered in phases (see [Roadmap](#roadmap)). This README describes what is implemented today.

## Architecture

```
            ┌──────────────┐        ┌────────────────────────── Perfmon backend (Node.js / Fastify) ──────────────────────────┐
JMeter ────►│ Backend      │  HTTP  │ /api/v1/ingest/influx/write  (InfluxDB line protocol — JMeter's built-in listener)      │
            │ Listener     ├───────►│ /api/v1/runs/{runId}/metrics (JSON samples / aggregates, batched)                      │
CI/CD ─────►│ curl / API   │        │ /api/v1/ingest/infrastructure (Perfmon Collector: CPU, memory, JVM, DB)               │
Collector ─►└──────────────┘        │                                                                                         │
                                    │ In-memory per-second aggregation + latency histograms → batched upserts                │
                                    │ Job queue (PostgreSQL SKIP LOCKED): report parsing, JTL import, analysis, notifications │
                                    └───────────────┬────────────────────────────┬───────────────────────────┬───────────────┘
                                                    │                            │                           │
                                              PostgreSQL                  Object storage               Report content origin
                                         (metadata + time series)   (local / S3 / MinIO / Azure)     (:8081, CSP-sandboxed HTML)
                                                    │
React SPA (Vite, ECharts) ◄──── REST + SSE ─────────┘
```

Hierarchy: `Organization → Project → Application → Environment → Performance Test → Test Run (Run ID) → metrics / artifacts / analysis`.

### Key design decisions
- **Accurate percentiles.** Raw samples are aggregated into log-bucketed histograms (~2.5% resolution), so percentiles over any window are merged from histograms, never averaged. Pre-aggregated sources (JMeter Backend Listener) are stored as reported and labelled *approximate* (≈) when combined.
- **No plugin needed for JMeter.** Perfmon exposes an InfluxDB-compatible write endpoint, so JMeter's stock `InfluxdbBackendListenerClient` streams directly to Perfmon.
- **Files out of the database.** Artifacts go to object storage; PostgreSQL stores metadata, SHA-256 checksums and versions.
- **Uploaded HTML is sandboxed.** JMeter reports are served from a separate origin with a CSP `sandbox` header and short-lived signed URLs.

## Implemented so far (Phase 1 — foundation)

| Area | Status |
|---|---|
| Monorepo (backend, frontend, collector), Docker / docker-compose | ✅ |
| PostgreSQL schema (all core tables, indexes) + migrations | ✅ |
| Authentication: login, logout (token revocation), password reset, change password, lockout | ✅ |
| RBAC: 9 roles, 23 permissions, API keys with scopes | ✅ (API-key management UI pending) |
| Standard error format, rate limiting, secure headers, audit logging | ✅ |
| OpenAPI / Swagger at `/api/docs` | ✅ |
| Run lifecycle API: create (Run ID), start, complete, abort, cancel, baseline, soft delete | ✅ |
| Ingestion: JSON batch, InfluxDB line protocol (JMeter), infrastructure collector | 🧪 implemented, end-to-end verification in progress |
| Artifact upload/versioning/SHA-256 dedupe, HTML report extraction + parser, JTL import, log indexing | 🧪 implemented, end-to-end verification in progress |
| Analytics engine: summaries, SLA, regression, bottleneck, insights, score, result | 🧪 implemented, end-to-end verification in progress |
| Frontend: login, layout/navigation, theming, Test Runs list | ✅ |
| Remaining UI modules, dashboards, demo data, reports export, integrations | 🚧 next phases |

## Quick start (Docker)

```bash
docker compose up --build
```

Open http://localhost:3000 and sign in with the demo administrator configured through environment variables
(`DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD`; development defaults are in `docker-compose.yml` — **override them for any shared environment**).

| Service | URL |
|---|---|
| Perfmon UI | http://localhost:3000 |
| API + Swagger | http://localhost:8080/api/docs |
| Report sandbox origin | http://localhost:8081 |
| MinIO console | http://localhost:9001 |

## Local development

```bash
docker compose -f docker-compose.dev.yml up -d      # PostgreSQL (5433), Redis (6380), MinIO (9000)
cp backend/.env.example backend/.env
npm install
npm run dev --workspace backend                      # http://localhost:8080
npm run dev --workspace frontend                     # http://localhost:5173 (proxies /api)
```

## Environment variables

See [`backend/.env.example`](backend/.env.example). Most important:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `TIMESERIES_DB_URL` | Optional separate time-series PostgreSQL |
| `STORAGE_DRIVER` | `local`, `s3` (S3/MinIO) or `azure` |
| `OBJECT_STORAGE_URL`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY` | S3/MinIO |
| `JWT_SECRET`, `ENCRYPTION_KEY` | **Required**; never commit real values |
| `REPORT_CONTENT_ORIGIN`, `REPORT_CONTENT_PORT` | Separate origin for sandboxed HTML reports |
| `INGEST_RATE_LIMIT_PER_SEC` | Default per-API-key ingestion limit |
| `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, `SEED_DEMO_DATA` | First-start bootstrap |

## API examples

```bash
# Log in
TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@perfmon.local","password":"<password>"}' | jq -r .token)

# Create a run (by names) — returns the Run ID and ingestion URLs
curl -s -X POST localhost:8080/api/v1/runs -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"project":"payments","application":"merchant-payments","environment":"Performance","test":"200 TPS Payment Load","buildNumber":"104","branch":"main","commit":"a1b2c3d"}'

# Send aggregated metrics
curl -s -X POST localhost:8080/api/v1/runs/PF-2026-10-06-000127/metrics -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '[{"timestamp":"2026-10-06T10:30:00Z","transaction":"Payment","requests":100,"errors":2,"avgResponseTime":850,"p95":1200,"p99":1800}]'

# Upload the JMeter HTML report (zip of the report directory)
curl -s -X POST localhost:8080/api/v1/runs/PF-2026-10-06-000127/artifacts -H "authorization: Bearer $TOKEN" \
  -F kind=HTML_REPORT -F file=@report.zip

# Complete the run → SLA, regression, bottleneck analysis, insights, final report
curl -s -X POST localhost:8080/api/v1/runs/PF-2026-10-06-000127/complete -H "authorization: Bearer $TOKEN"
```

### JMeter (no plugin)
Add **Backend Listener → `org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient`**:

| Parameter | Value |
|---|---|
| `influxdbUrl` | `http://<perfmon>:8080/api/v1/ingest/influx/write?runId=<RUN_ID>` |
| `influxdbToken` | Perfmon API key (`pmk_…`, scope `ingest`) |
| `application` | your application name |
| `summaryOnly` | `false` |
| `percentiles` | `50;90;95;99` |

## Roadmap

1. **Foundation** — setup, auth, RBAC, PostgreSQL, Docker ✅
2. **Performance testing** — projects/apps/environments/tests UI, runs, Run IDs, JMeter ingestion, demo data
3. **Observability** — run detail tabs, charts, dashboards & builder, filters, live monitoring (SSE)
4. **Reports** — artifacts UI, HTML report viewer, report history
5. **Analysis** — SLA, comparison, regression, bottlenecks, insights UI
6. **Infrastructure** — server, JVM, DB, application monitoring
7. **Integrations** — InfluxDB, Prometheus, Dynatrace, CI/CD, OpenTelemetry
8. **Enterprise** — alerts, audit, retention, reporting exports, scaling

## License

Proprietary — all rights reserved (update as appropriate).
