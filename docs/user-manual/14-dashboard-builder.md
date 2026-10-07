# Dashboard Builder

The Dashboard Builder is where you create and edit dashboards. You place panels on a 12-column grid, choose a visualization for each one, describe its data with a Perfmon panel query, and add variables so viewers can switch project, environment, test, run and other filters. Panel queries use Perfmon's metric model. You never write PromQL, Flux or SQL.

> **Implementation status.** This chapter follows the dashboard contract (API contract, section 5). The dashboards backend module was still being built when this was written. The panel types, query fields and variable types below are the contracted ones.

## Opening the builder

1. Go to **Observability → Dashboards** (`/dashboards`).
2. Choose **New dashboard**, or open an existing dashboard (`/dashboards/<uid>`) and switch to edit mode.
3. Set the name, description, tags, project, default time range, refresh interval and whether the dashboard is shared.
4. Add panels and variables, then **Save**. Each save increments the dashboard `version`.

You need `CREATE_DASHBOARD` to create a dashboard and `EDIT_DASHBOARD` to save changes.

## Layout grid

Each panel has a `grid` position `{ x, y, w, h }`:

| Field | Meaning |
|---|---|
| `x` | Column offset, 0-11 |
| `y` | Row offset |
| `w` | Width in columns (1-12) |
| `h` | Height in rows; one row is 40 px |

A full-width chart is `w: 12`. Two charts side by side are `w: 6` each. A row of four KPI tiles is `w: 3` each.

## Panel types

| Type | Use for |
|---|---|
| `kpi`, `stat` | Single values with optional delta and sparkline |
| `line`, `area` | Time series |
| `bar`, `stacked_bar` | Category comparisons |
| `histogram` | Distributions |
| `heatmap`, `latency_heatmap` | Time by latency bucket |
| `scatter` | Correlations (for example TPS against P95) |
| `gauge`, `sla_gauge` | A value against a target |
| `donut` | Shares (for example response codes) |
| `table` | Tabular results |
| `timeline` | Events and annotations |
| `percentiles` | P50/P90/P95/P99 series |
| `tps`, `users` | Throughput and active threads |
| `error_distribution` | Errors by response code or type |
| `endpoint_ranking`, `transaction_ranking` | Top-N slowest or busiest |
| `bottleneck` | Bottleneck candidates with confidence labels |
| `text` | Markdown notes, runbooks and links |

## Panel query

```ts
type PanelQuery = {
  source: 'run_series'|'runs'|'transactions'|'endpoints'|'infra'|'jvm'|'database'|'sla'
        |'regressions'|'errors'|'kpi'|'bottleneck'|'latency_heatmap'|'alerts'|'text';
  metric?: string;
  metrics?: string[];
  aggregation?: 'avg'|'max'|'min'|'sum'|'last';
  groupBy?: 'run'|'build'|'release'|'transaction'|'endpoint'|'server'|'environment'|'test'|'day'|'response_code'|'error_type';
  limit?: number;
  sort?: 'asc'|'desc';
  markdown?: string;   // text panels only
};
```

### Metrics

| Family | Metric keys |
|---|---|
| Load test | `tps`, `p50`, `p90`, `p95`, `p99`, `avg_rt`, `max_rt`, `error_pct`, `errors`, `requests`, `users` |
| Server | `cpu_pct`, `memory_pct`, `disk_pct`, `net_bps` |
| JVM | `heap_pct`, `gc_pause_ms`, `threads` |
| Database | `db_latency_ms`, `db_connections` |
| Analysis | `sla_pass_pct`, `score` |

### Sources

| Source | Scope | Typical panels |
|---|---|---|
| `run_series` | One run, over time | `line`, `percentiles`, `tps`, `users` |
| `kpi` | One run, single value | `kpi`, `stat`, `gauge` |
| `transactions`, `endpoints` | One run, per item | `table`, `transaction_ranking`, `endpoint_ranking` |
| `infra`, `jvm`, `database` | One run, or the time range | `line`, `area`, `table` |
| `errors` | One run | `error_distribution`, `donut` |
| `latency_heatmap` | One run; needs raw samples | `latency_heatmap` |
| `bottleneck` | One run | `bottleneck` |
| `runs` | Across runs | `line` grouped by `build`/`release`/`day` |
| `sla`, `regressions`, `alerts` | Across runs | `sla_gauge`, `table`, `bar` |
| `text` | None | `text` |

A latency heatmap needs raw samples (JTL upload or JSON samples). For runs that only have pre-aggregated data, the panel returns an `empty` result that explains why.

### Example panels

P95 by build for the selected test:

```json
{
  "id": "p95-by-build",
  "title": "P95 by build",
  "type": "line",
  "query": { "source": "runs", "metric": "p95", "groupBy": "build" },
  "options": {},
  "grid": { "x": 0, "y": 0, "w": 8, "h": 6 }
}
```

The 10 slowest transactions of the selected run:

```json
{
  "id": "slow-txn",
  "title": "Slowest transactions (P95)",
  "type": "transaction_ranking",
  "query": { "source": "transactions", "metric": "p95", "sort": "desc", "limit": 10 },
  "options": {},
  "grid": { "x": 8, "y": 0, "w": 4, "h": 6 }
}
```

## Variables

Variables appear as drop-downs above the panels and are referenced as `$name`.

| Field | Meaning |
|---|---|
| `name` | Referenced as `$name`; must be unique within the dashboard |
| `label` | Display label |
| `type` | `project`, `application`, `environment`, `test`, `run`, `transaction`, `endpoint`, `server`, `service`, `build`, `custom` |
| `customValues` | Values for a `custom` variable |
| `defaultValue` | Initial selection |
| `multi` | Allow several values |
| `includeAll` | Offer **All**, which means unfiltered |

Options for each variable come from `GET /dashboards/variable-options`. Each variable's options are narrowed by the variables above it. For example, the `test` options depend on the selected project and environment.

## Panel results

A panel returns one of these result kinds: `timeseries`, `stat`, `categories`, `table`, `heatmap`, `items`, `text`, `empty` or `error`. A time-series result can include `percentileMethod`. When it is `interval_weighted_approx`, the values are approximate and the UI marks them with ≈. See [Dashboards](13-dashboards.md#percentile-accuracy-on-panels).

## Saving through the API

`PUT /dashboards/:uid` is a full save. Send the complete panel and variable lists, not just the changes.

```bash
curl -s -X POST "$PERFMON_URL/api/v1/dashboards" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Checkout - team view",
    "projectId": "'"$PROJECT_ID"'",
    "tags": ["checkout", "team"],
    "isShared": true,
    "refreshInterval": 10,
    "variables": [
      { "name": "environment", "type": "environment", "includeAll": true },
      { "name": "run", "type": "run", "includeAll": false }
    ],
    "panels": [
      { "id": "tps", "title": "Throughput", "type": "tps",
        "query": { "source": "run_series", "metric": "tps" }, "options": {},
        "grid": { "x": 0, "y": 0, "w": 6, "h": 6 } },
      { "id": "pct", "title": "Percentiles", "type": "percentiles",
        "query": { "source": "run_series", "metrics": ["p50","p90","p95","p99"] }, "options": {},
        "grid": { "x": 6, "y": 0, "w": 6, "h": 6 } }
    ]
  }'
```

Before you save, you can test panel definitions with `POST /dashboards/query`. See [Dashboards](13-dashboards.md#examples).

## Good practice

- Put KPI tiles in the top row and detailed charts below them.
- Use a `run` variable on single-run dashboards and a `test` variable plus a time range on trend dashboards.
- Add a `text` panel that explains what the dashboard is for and who owns it.
- Keep tables to 10-20 rows with `limit`, and link to the run analysis pages for full detail.

## Related chapters

- [Dashboards](13-dashboards.md)
- [Transactions](15-transactions.md)
- [Performance Trends](24-performance-trends.md)
