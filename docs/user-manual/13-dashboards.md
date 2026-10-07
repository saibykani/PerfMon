# Dashboards

Dashboards collect panels (charts, KPIs, tables and rankings) about your load tests, infrastructure and analysis results on one page. Perfmon ships a set of system dashboards for each project, and you can create, clone, share, import and export your own. Every panel uses Perfmon's metric abstraction, not PromQL or Flux, so a dashboard behaves the same whether the data arrived through the JMeter Backend Listener, a JTL upload or an integration.

This chapter covers browsing and using dashboards. To build or edit them, see [Dashboard Builder](14-dashboard-builder.md).

> **Implementation status.** The dashboards API in this chapter follows the Perfmon API contract (section 5). The backend module (`dashboards/routes.ts`) and the seeding of default dashboards were still being built when this chapter was written. If an endpoint returns `404`, your server does not include the module yet.

## Where to find dashboards

| Location | Route | Purpose |
|---|---|---|
| Observability → Dashboards | `/dashboards` | Lists all dashboards you can see, with search and tags |
| Dashboard view | `/dashboards/<uid>` | Opens one dashboard; panels load for the selected variables and time range |
| Overview | `/` | The built-in landing page (KPIs, trend, slow transactions, infrastructure health). It is not an editable dashboard. |

Each dashboard has a stable `uid`, which is used in its URL, and a numeric `version` that goes up by one every time it is saved.

## Default system dashboards

Perfmon creates these system dashboards for each project:

| Dashboard | Typical content |
|---|---|
| Executive Performance | Pass rate, SLA compliance, performance score, regressions and trend by build |
| JMeter Test | Users, TPS, percentiles, errors and response codes for a single run |
| Infrastructure | CPU, memory, disk and network per server |
| Application | JVM heap, GC pauses, threads and service health |
| API Performance | Endpoint ranking, endpoint latency and errors |
| SLA | SLA gauge, pass % per run, top violations |
| Regression | Regressions and improvements across runs |
| Capacity | Latency-vs-load and throughput observations |
| Run Comparison | Side-by-side metrics for the selected runs |

System dashboards are flagged `isSystem: true`. Users with the `EDIT_DASHBOARD` permission can edit them. If you want to keep the original intact, clone it first and change the copy.

## Using a dashboard

1. Open **Observability → Dashboards** (`/dashboards`).
2. Search by name or filter by tag, then select a dashboard.
3. Set the **variables** at the top of the page, for example Project, Environment, Test or Run. Choosing **All**, or leaving a variable empty, removes that filter.
4. Pick a **time range**, or select a Run so that run-scoped panels show that run.
5. Optionally set an auto-refresh interval. This is useful while a test is running.
6. Hover over a chart to see values. Panels that link to a run, transaction or endpoint open the matching analysis page when clicked.

### How variables decide which data you see

The server resolves variables (`$project`, `$application`, `$environment`, `$test`, `$run`, `$transaction`, `$endpoint`, `$server`, `$service`, `$build`) before it runs a panel's query:

- If `$run` is set, or the time range is a run (`{ "runId": "PF-..." }`), run-scoped panels use that run.
- If no run is set, run-scoped panels use the **latest completed run** that matches the other filters. Cross-run panels (trends, regressions, SLA history) cover the selected time range.
- `null` or `All` means the variable does not filter the data.

Run variables accept either the run's UUID or its friendly Run ID. See [Run IDs](08-run-ids.md).

### Percentile accuracy on panels

Time-series panels return a `percentileMethod` with their results:

| Method | Meaning | Display |
|---|---|---|
| `exact_histogram` | Percentiles computed by merging latency histograms built from raw samples (JTL or JSON samples). Relative precision is about 2.5%. | Shown as-is |
| `source_reported` | A single interval's percentile, exactly as the source reported it | Shown as-is |
| `interval_weighted_approx` | Several interval-reported percentiles (for example from the JMeter Backend Listener) combined into a sample-weighted average. Percentiles cannot be averaged exactly, so the value is an approximation. | Marked with ≈ |

To get exact percentiles, send raw samples. See [JMeter Integration](09-jmeter-integration.md).

## Sharing, cloning and deleting

| Action | Who can do it | Notes |
|---|---|---|
| View | Anyone with project view access | Shared dashboards (`isShared: true`) are visible to all project members |
| Create / clone / import | `CREATE_DASHBOARD` | A clone gets a new `uid` |
| Edit / save | `EDIT_DASHBOARD` | Each save increments `version` |
| Delete | `DELETE_DASHBOARD` | Requires `?confirm=true` |

## REST API

All endpoints are under `/api/v1` and need a bearer token: either a user JWT or an API key that starts with `pmk_`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/dashboards?projectId&q` | List dashboards (`id, uid, name, description, tags, projectId, isSystem, isShared, ownerName, updatedAt, panelCount`) |
| GET | `/dashboards/:uid` | Full dashboard including `panels`, `variables`, `timeRange`, `refreshInterval`, `version` |
| POST | `/dashboards` | Create a dashboard |
| PUT | `/dashboards/:uid` | Full save; `version` + 1 |
| DELETE | `/dashboards/:uid?confirm=true` | Delete a dashboard |
| POST | `/dashboards/:uid/clone` | Clone (`{ "name": "..." }` optional) |
| GET | `/dashboards/:uid/export` | Export as JSON |
| POST | `/dashboards/import` | Import (`{ "dashboard": { ... } }`) |
| GET | `/dashboards/variable-options?type&projectId&...&q` | Values for a variable drop-down |
| POST | `/dashboards/query` | Run panel queries |

### Examples

List the dashboards of a project:

```bash
curl -s "$PERFMON_URL/api/v1/dashboards?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

Export a dashboard and import it into another Perfmon instance:

```bash
curl -s "$PERFMON_URL/api/v1/dashboards/exec-perf/export" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -o exec-perf.json

curl -s -X POST "$OTHER_PERFMON_URL/api/v1/dashboards/import" \
  -H "Authorization: Bearer $OTHER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"dashboard\": $(cat exec-perf.json)}"
```

Clone a system dashboard:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/dashboards/exec-perf/clone" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Checkout - Executive (team copy)"}'
```

Evaluate two panels for one run:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/dashboards/query" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "panels": [
      { "id": "p1", "type": "percentiles", "query": { "source": "run_series", "metrics": ["p50","p90","p95","p99"] } },
      { "id": "p2", "type": "kpi", "query": { "source": "kpi", "metric": "error_pct" } }
    ],
    "vars": { "project": null },
    "timeRange": { "runId": "PF-2026-10-06-000127" }
  }'
```

The response has the form `{ "results": { "<panelId>": PanelResult } }`. A panel with no data returns `{ "kind": "empty", "message": "..." }` and does not fail the whole request. A failing panel returns `{ "kind": "error", "message": "..." }`.

## Tips

- Pin a Run when you review a finished test, and use a time range when you watch trends across runs.
- Clone system dashboards before you customize them. Updates to the defaults then won't conflict with your changes.
- Use **export** to keep dashboards in version control next to your JMeter test plans.

## Related chapters

- [Dashboard Builder](14-dashboard-builder.md)
- [Live Monitoring](12-live-monitoring.md)
- [Run IDs](08-run-ids.md)
