# Perfmon API contracts (v1)

All endpoints live under `/api/v1`, require `Authorization: Bearer <JWT | pmk_ API key>` unless noted, and
return errors as `{ timestamp, status, error, message, path, details? }`. JSON uses **camelCase for new
endpoints**; inventory endpoints return DB rows (snake_case) as they do today — the frontend handles both.
Run identifiers accept either the UUID or the friendly Run ID (`PF-YYYY-MM-DD-NNNNNN`).

Implemented today (see `backend/src`): auth, runs, run analysis (`/runs/:id/*`), ingestion, artifacts/HTML reports,
inventory (projects, applications, environments, servers, services, tests, releases, builds, SLA profiles).
The sections below define the remaining modules. Backend and frontend MUST follow these shapes.

---

## 1. Overview — `analytics/routes.ts`

`GET /overview?projectId&applicationId&environmentId&from&to` (from/to = ISO or epoch ms; default last 30 days)

```ts
{
  kpis: { activeTests: number; totalRuns: number; runningRuns: number; avgTps: number|null; avgP95: number|null;
          avgErrorPct: number|null; slaCompliance: number|null; regressions: number; activeAlerts: number;
          passRate: number|null },
  trend: { runId: string; runKey: string; startedAt: string; testName: string; buildNumber: string|null;
           tps: number|null; p95: number|null; errorPct: number|null; result: string|null; score: number|null }[],  // chronological
  topSlowTransactions: { name: string; testName: string; runKey: string; p95: number; tps: number|null; errorPct: number|null }[],
  infraHealth: { serverId: string; name: string; role: string|null; environmentName: string|null; status: string; cpuPct: number|null; memoryPct: number|null; lastSeenAt: string|null }[],
  recentRuns: RunDto[],      // same shape as GET /runs items
  recentAlerts: { id: string; title: string; severity: string; status: string; firedAt: string; runKey: string|null }[],
  resultDistribution: { result: string; count: number }[]
}
```

## 2. Trends — `analytics/routes.ts`

`GET /trends?projectId&testId&environmentId&groupBy=build|release|date&from&to`

```ts
{
  groupBy: string,
  points: { key: string; label: string; runKey: string; runId: string; startedAt: string; buildNumber: string|null; releaseVersion: string|null;
            metrics: { p95: number|null; p99: number|null; avgRt: number|null; tps: number|null; errorPct: number|null;
                       cpuAvg: number|null; slaPassPct: number|null; score: number|null } }[],
  degradation: { metric: string; direction: 'DEGRADING'|'IMPROVING'|'STABLE'; slopePerStep: number; r2: number;
                 consecutiveWorse: number; changePct: number|null; severity: 'INFO'|'WARNING'|'CRITICAL'; message: string }[]
}
```

## 3. Capacity planning — `analytics/routes.ts`

`GET /capacity/model?testId&environmentId` — fit a latency-vs-load model from completed runs.

```ts
{ observations: { runKey: string; users: number|null; tps: number|null; p95: number|null; cpuAvg: number|null }[],
  model: { type: 'linear'|'exponential'|'insufficient'; r2: number|null; description: string } ,
  estimatedSaturationTps: number|null, notes: string[] }
```

`POST /capacity/project` body `{ testId?, currentTps, targetTps, currentUsers?, targetUsers?, currentP95, slaP95?, currentCpu? }`

```ts
{ label: 'Estimate', method: string, confidence: 'LOW'|'MEDIUM'|'HIGH',
  projected: { p95: number|null; cpuPct: number|null; users: number|null; tpsPerUser: number|null },
  meetsSla: boolean|null, headroomPct: number|null, assumptions: string[],
  curve: { tps: number; p95: number }[] }
```

## 4. Cross-run analysis — `analytics/routes.ts`

- `POST /compare` body `{ runIds: string[] (2..6) }` → result of `compareRuns()` in `analytics/compare.ts`
  (`{ runs, metrics[{key,label,unit,better,values[],changes[],verdicts[]}], transactions[], endpoints[], sla[] }`).
- `GET /comparisons?projectId` / `POST /comparisons {name, runIds, projectId?}` / `DELETE /comparisons/:id` — saved comparisons.
- `GET /regressions?projectId&testId&severity&direction&from&to&page&pageSize` →
  `{ items: { id, runId, runKey, testName, baselineRunKey, scope, transaction, metric, previousValue, currentValue, changePct, thresholdPct, direction, severity, likelyImpacted, createdAt }[], total }`
- `GET /insights?projectId&category&severity&from&to&page&pageSize` →
  `{ items: { id, runId, runKey, testName, category, severity, title, description, evidence, confidence, confidenceLabel, component, createdAt, recommendations: {title, description, priority}[] }[], total }`
- `GET /sla/summary?projectId&from&to` → `{ compliance: number|null, runs: { runKey, testName, startedAt, passPct, violations }[], topViolations: { metric, transaction, count }[] }`

## 5. Dashboards — `dashboards/routes.ts`

```ts
type Panel = { id: string; title: string; type: PanelType; query: PanelQuery; options: Record<string, any>;
               grid: { x: number; y: number; w: number; h: number } };   // 12-column grid, h in 40px rows
type Variable = { name: string; label?: string; type: 'project'|'application'|'environment'|'test'|'run'|'transaction'|'endpoint'|'server'|'service'|'build'|'custom';
                  customValues?: string[]; defaultValue?: string|null; multi?: boolean; includeAll?: boolean };
type PanelType = 'kpi'|'stat'|'line'|'area'|'bar'|'stacked_bar'|'histogram'|'heatmap'|'scatter'|'gauge'|'donut'|'table'|'timeline'
               |'percentiles'|'tps'|'error_distribution'|'sla_gauge'|'users'|'latency_heatmap'|'endpoint_ranking'|'transaction_ranking'|'bottleneck'|'text';
```

- `GET /dashboards?projectId&q` → `{ id, uid, name, description, tags, projectId, isSystem, isShared, ownerName, updatedAt, panelCount }[]`
- `POST /dashboards` body `{ name, description?, projectId?, tags?, timeRange?, refreshInterval?, isShared?, panels?, variables? }` → Dashboard
- `GET /dashboards/:uid` → `{ id, uid, name, description, tags, projectId, isSystem, isShared, timeRange, refreshInterval, version, panels: Panel[], variables: Variable[], updatedAt }`
- `PUT /dashboards/:uid` full save (same body as POST) → Dashboard (version + 1). System dashboards can be edited by users with EDIT_DASHBOARD.
- `DELETE /dashboards/:uid?confirm=true`, `POST /dashboards/:uid/clone {name?}`, `GET /dashboards/:uid/export` (JSON), `POST /dashboards/import {dashboard}`.
- `GET /dashboards/variable-options?type&projectId&applicationId&environmentId&testId&runId&q` → `{ value: string; label: string }[]`

### Panel query (metric abstraction — never PromQL/Flux in the UI)

```ts
type PanelQuery = {
  source: 'run_series'|'runs'|'transactions'|'endpoints'|'infra'|'jvm'|'database'|'sla'|'regressions'|'errors'|'kpi'|'bottleneck'|'latency_heatmap'|'alerts'|'text';
  metric?: string;          // tps|p50|p90|p95|p99|avg_rt|max_rt|error_pct|errors|requests|users|cpu_pct|memory_pct|disk_pct|net_bps|heap_pct|gc_pause_ms|threads|db_latency_ms|db_connections|sla_pass_pct|score
  metrics?: string[];       // multiple series (e.g. percentiles: ['p50','p90','p95','p99'])
  aggregation?: 'avg'|'max'|'min'|'sum'|'last';
  groupBy?: 'run'|'build'|'release'|'transaction'|'endpoint'|'server'|'environment'|'test'|'day'|'response_code'|'error_type';
  limit?: number; sort?: 'asc'|'desc';
  markdown?: string;        // text panels
}
```

`POST /dashboards/query` body
`{ panels: { id: string; type: PanelType; query: PanelQuery }[], vars: Record<string, string|string[]|null>, timeRange: { from: number; to: number } | { runId: string } }`

Variables (`$project`, `$application`, `$environment`, `$test`, `$run`, `$transaction`, `$endpoint`, `$server`, `$service`, `$build`) are
resolved server-side; `null`/`'All'` means unfiltered. When `$run` is set (or `timeRange.runId`), run-scoped sources use that run;
otherwise the latest completed run matching the filters is used and cross-run sources span the time range.

Response `{ results: Record<panelId, PanelResult> }`:

```ts
type PanelResult =
  | { kind: 'timeseries'; unit?: string; series: { name: string; key?: string; data: [number, number|null][] }[]; percentileMethod?: string; runKey?: string }
  | { kind: 'stat'; unit?: string; value: number|null; label?: string; delta?: number|null; better?: 'lower'|'higher'; sparkline?: number[]; status?: 'pass'|'warn'|'fail'|null }
  | { kind: 'categories'; unit?: string; categories: string[]; series: { name: string; data: (number|null)[] }[] }
  | { kind: 'table'; columns: { key: string; header: string; unit?: string }[]; rows: Record<string, any>[] }
  | { kind: 'heatmap'; times: number[]; buckets: string[]; cells: [number, number, number][] }
  | { kind: 'items'; items: { title: string; subtitle?: string; severity?: string; value?: string; link?: string }[] }
  | { kind: 'text'; markdown: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };
```

Default system dashboards (seeded by `seedDefaultDashboards(orgId, projectId)` in `dashboards/defaults.ts`):
Executive Performance, JMeter Test, Infrastructure, Application, API Performance, SLA, Regression, Capacity, Run Comparison.

## 6. Search — `search/routes.ts`

`GET /search?q&limit=20` → `{ items: { type: 'Run'|'Test'|'Application'|'Project'|'Build'|'Release'|'Transaction'|'Endpoint'|'Artifact'|'Report'|'Dashboard'; id: string; title: string; subtitle?: string; url: string }[] }`
(`url` is a frontend route, e.g. `/runs/PF-...`, `/tests/<id>`, `/runs/PF-.../transactions?name=...`.)

## 7. Events & annotations — `events/routes.ts`

- `GET /events?projectId&environmentId&runId&type&from&to&limit` → event rows (camelCase)
- `POST /events {projectId, type, title, description?, ts?, environmentId?, applicationId?, runId?, severity?}`
- `GET /annotations?projectId&runId&dashboardId&q&from&to` (full-text search via `q`)
- `POST /annotations {projectId, title, text?, ts, tsEnd?, tags?, runId?, environmentId?, dashboardId?}`, `PATCH /annotations/:id`, `DELETE /annotations/:id`

## 8. Reports — `reports/routes.ts` (+ job `report.generate`)

- Types: `TEST_EXECUTION, EXECUTIVE, ENGINEERING, REGRESSION, SLA, CAPACITY, INFRASTRUCTURE, TREND, COMPARISON`
- `GET /reports?projectId&runId&type&page&pageSize` → `{ items: { id, type, title, version, status, runId, runKey, projectId, createdBy, createdAt, params }[], total }`
- `POST /reports {type, projectId?, runId?, runIds?, title?, params?}` → `{ id, status: 'QUEUED' }` (re-generating the same type+run creates version N+1)
- `GET /reports/:id` → `{ id, type, title, version, status, error, params, createdAt, content: ReportContent|null }`
- `GET /reports/:id/export?format=pdf|html|csv|json|xlsx` → file download
- `DELETE /reports/:id?confirm=true`

```ts
type ReportContent = {
  title: string; type: string; generatedAt: string; version: number; audience: 'EXECUTIVE'|'ENGINEERING';
  subject: { runKey?: string; runKeys?: string[]; testName?: string; projectName?: string; environment?: string; build?: string };
  result?: { status: string; score: number|null; breakdown: Record<string, string> };
  sections: { id: string; title: string; kind: 'kv'|'kpis'|'table'|'text'|'list'|'findings'|'chart'; data: any }[];
}
// kv: [label, value][] ; kpis: {label, value, unit?, status?}[] ; table: {columns:{key,header}[], rows:[]} ;
// text: string ; list: string[] ; findings: {severity, title, description}[] ;
// chart: { type:'line'|'bar', unit?, series:{name, data:[x,y][]}[] }
```

## 9. Alerts & notifications — `alerts/routes.ts`

- `GET /alerts?projectId&status&severity&page&pageSize` → `{ items: { id, ruleId, ruleName, type, severity, status, subject, title, message, value, threshold, runId, runKey, serverName, firedAt, acknowledgedAt, resolvedAt }[], total, counts: { FIRING, ACKNOWLEDGED, RESOLVED } }`
- `GET /alerts/:id` (+ `events[]`), `POST /alerts/:id/acknowledge`, `POST /alerts/:id/resolve`
- `GET /alert-rules?projectId`, `POST /alert-rules`, `PATCH /alert-rules/:id`, `DELETE /alert-rules/:id`
  body `{ projectId, name, description?, type, metric?, operator, threshold?, severity, windowSec, filters: { environmentId?, testId?, transaction?, serverId? }, channelIds: string[], cooldownSec, enabled }`
- `GET /alert-rules/types` → catalog `{ type, label, defaultOperator, unit, needsThreshold }[]`
- `GET /notification-channels`, `POST /notification-channels {name, type: 'IN_APP'|'EMAIL'|'SLACK'|'TEAMS'|'WEBHOOK', config: {recipients?|url?}, secret?}` (secret = webhook URL/token; stored encrypted, never returned — responses show `hasSecret: true`), `PATCH`, `DELETE`, `POST /notification-channels/:id/test`
- `GET /notifications?limit` → `{ items: { id, title, body, severity, link, created_at, read: boolean }[], unread: number }`, `POST /notifications/:id/read`, `POST /notifications/read-all`

## 10. Integrations — `integrations/routes.ts`

- `GET /integrations/types` → `{ type, label, category, authTypes[], fields: { key, label, required, secret?, placeholder? }[], supportsImport: boolean, docs: string }[]`
- `GET /integrations?projectId` → `{ id, name, type, url, authType, config, status, health, lastConnectedAt, lastError, hasCredentials }[]` (never secrets)
- `POST /integrations {name, type, url?, authType, config, credentials?: Record<string,string>, projectId?}`, `PATCH /integrations/:id`, `DELETE /integrations/:id`
- `POST /integrations/:id/test` → `{ ok: boolean; latencyMs: number; message: string; details?: any }` (updates health/lastConnectedAt)
- `POST /integrations/:id/import { runId, queries?: { metric: string; query: string; target: 'server'|'jvm'|'database'|'service'|'custom'; serverName?: string; serviceName?: string }[] }`
  → `{ imported: number; series: number; warnings: string[] }` — pulls data for the run's time window from InfluxDB (Flux/InfluxQL), Prometheus (PromQL `query_range`) or Dynatrace (Metrics API v2) and stores it in Perfmon's metric model, correlated to the Run ID.

## 11. Administration — `admin/routes.ts`

- Users: `GET /admin/users`, `POST /admin/users {email, name, roles[], password?}` (returns a one-time password-set link when no password), `PATCH /admin/users/:id {name?, roles?, isActive?}`, `POST /admin/users/:id/reset-link`
- Roles: `GET /admin/roles` → `{ name, description, permissions[] , userCount }[]`, `GET /admin/permissions`
- API keys: `GET /api-keys` → `{ id, name, prefix, scopes, projectId, rateLimitPerSec, createdAt, expiresAt, revokedAt, lastUsedAt, createdByName }[]`,
  `POST /api-keys {name, scopes: ('ingest'|'read')[], projectId?, expiresAt?, rateLimitPerSec?}` → `{ ...key, secret }` (**secret shown once**),
  `POST /api-keys/:id/rotate` → `{ ...newKey, secret }` (old key revoked), `DELETE /api-keys/:id` (revoke)
- Audit: `GET /admin/audit?q&action&resourceType&user&result&from&to&page&pageSize` → `{ items, total }`; `GET /admin/audit/export?…` → CSV
- Settings: `GET /admin/settings` → all keys from `analytics/settings.ts`; `PUT /admin/settings/:key` (value object)
- Retention: `GET /admin/retention` → policy + `estimates: { dataType, rows, cutoff }[]`; `POST /admin/retention/purges {dataType}` → PENDING_CONFIRMATION purge;
  `POST /admin/retention/purges/:id/confirm` (executes, audited); `POST /admin/retention/purges/:id/cancel`; `GET /admin/retention/purges`
- Jobs: `GET /admin/jobs?status&type&page` → `{ items, total, stats: { QUEUED, PROCESSING, COMPLETED, FAILED } }`, `POST /admin/jobs/:id/retry`
- System health: `GET /system/health` →
  `{ status, uptimeSec, version, api: { requests, rps, latencyP50, latencyP95, latencyP99, errors4xx, errors5xx, errorRatePct }, db: { latencyP50, latencyP95, poolTotal, poolIdle, poolWaiting, sizeBytes },
     ingestion: { samplesPerSec, pointsPerSec, rowsWritten, failures, bufferSize, flushP95Ms, rateLimited }, jobs: { queued, processing, failed24h, completed24h, avgDurationMs },
     live: { connections }, artifacts: { uploaded, processed, failed }, process: { heapUsedMb, rssMb, cpuPct, nodeVersion }, storage: { driver, ok, detail }, alertsFired }`
