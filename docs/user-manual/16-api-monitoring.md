# API Monitoring

API Monitoring shows your load test traffic by **HTTP endpoint** (method plus normalized path) rather than by JMeter sampler name. Perfmon normalizes request URLs so that every concrete call to the same route is counted as one endpoint. For example, `GET /api/v1/merchant/12345` and `GET /api/v1/merchant/98765` both become `GET /api/v1/merchant/{id}`. Each endpoint gets request counts, throughput, latency, errors and status codes, plus a drill-down with history across runs.

## Where to find it

| Location | Route | Shows |
|---|---|---|
| Observability → APIs | `/apis` | Endpoints for the selected project, test and run |
| Run detail | `/runs/<Run ID>` | The endpoint table for one run |
| [Run Comparison](22-run-comparison.md) | `/compare` | Endpoint average and error % across 2-6 runs |

## How endpoints are identified

Perfmon works out the endpoint from each sample:

1. If the sample has a URL (an absolute `http(s)://` URL or a path starting with `/`), Perfmon uses the URL's path. The method comes from the sample, or from a label like `POST /api/v1/payment`, and defaults to `GET`.
2. If there is no URL but the label looks like `METHOD /path`, the label is used.
3. Otherwise no endpoint can be inferred. The sample still counts toward its transaction, but not toward API metrics.

The query string and fragment are removed, and a trailing slash is dropped.

### Normalization rules

Perfmon replaces a path segment with `{id}` when it matches any of these patterns:

| Pattern | Example segment |
|---|---|
| Numeric | `12345` |
| UUID | `3f2c1a9e-8b7d-4c3e-9f10-2a6b5c4d3e21` |
| Long hexadecimal (12+ characters) | `a3f9c2e1b7d4` |
| Long token containing digits (16+ characters, letters/digits/`_`/`-`) | `tok_9f8e7d6c5b4a3f2e` |
| Email address | `jane@example.com` |
| Date prefix `YYYY-MM-DD` | `2026-10-06` |
| Prefixed ID (2-6 letters, `-` or `_`, then a digit) | `TXN-0001234`, `PF-2026-10-06-000127` |
| Already templated | `{merchantId}` (kept as-is) |

Segments are URL-decoded before they are matched.

```text
GET  /api/v1/merchant/12345/orders/2026-10-06   ->  GET  /api/v1/merchant/{id}/orders/{id}
POST /api/v1/payment?retry=1                    ->  POST /api/v1/payment
GET  /users/jane@example.com/                   ->  GET  /users/{id}
```

If you want the JMeter label to drive endpoint grouping, name your samplers `METHOD /path`, for example `POST /api/v1/payment`.

## Endpoint table

| Column | Description |
|---|---|
| Method, Endpoint | HTTP method and normalized path template |
| Requests, Errors, Error % | Sample and failure counts |
| TPS | Requests ÷ duration of the run (or of the selected window) |
| Avg, Min, Max | Response times in ms |
| P95, P99 | Shown only when **every** interval of the endpoint has a latency histogram, which needs raw samples. Otherwise the value is empty. |
| Status codes | Count per HTTP status code |

Perfmon leaves endpoint percentiles empty rather than approximating them. To get endpoint P95/P99, upload a JTL file or send raw JSON samples. See [JMeter Integration](09-jmeter-integration.md).

## Endpoint drill-down

Select an endpoint to see:

- A time series of request count, TPS, errors, average, P95 and P99 for each time bucket. Perfmon picks the bucket size so the run fits in about 300 points.
- The status code distribution.
- The latency distribution and the overall P95/P99, merged from histograms.
- History: the 20 most recent runs of the same test, with request count, average and error %.

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/runs/:id/endpoints?from&to` | Endpoint table for a run |
| GET | `/runs/:id/endpoints/:endpointId` | Drill-down (`endpointId` is the UUID from the table) |
| GET | `/runs/:id/errors?groupBy=endpoint` | Errors grouped by endpoint |
| POST | `/compare` | Includes an `endpoints[]` comparison for 2-6 runs |

```bash
# Endpoint table
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/endpoints" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

# Drill-down
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/endpoints/$ENDPOINT_ID" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

# Errors grouped by endpoint
curl -s "$PERFMON_URL/api/v1/runs/PF-2026-10-06-000127/errors?groupBy=endpoint" \
  -H "Authorization: Bearer $PERFMON_TOKEN"
```

Example item:

```json
{
  "id": "6d0e...", "method": "POST", "endpoint": "/api/v1/payment",
  "requests": 18240, "errors": 37, "errorPct": 0.2, "tps": 50.7,
  "avg": 405.1, "min": 81, "max": 4100, "p95": 832, "p99": 1490,
  "statusCodes": { "200": 18203, "502": 21, "504": 16 }
}
```

The error-analysis endpoint (`/runs/:id/errors`) also accepts `groupBy=response_code|transaction|message|error_type|time`. Each group includes `pctOfErrors` and `pctOfAll`.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| No endpoints listed | Samples had no URL and labels were not `METHOD /path` | Save the URL in the JTL (`jmeter.save.saveservice.url=true`) or rename samplers |
| P95/P99 empty | Only pre-aggregated data (Backend Listener) | Upload the JTL or send raw JSON samples |
| One real route split into several | A dynamic segment did not match a normalization rule (for example a short alphanumeric code) | Use a templated label `METHOD /path/{code}` |
| Different routes merged | Two routes differ only in an ID-like segment | Expected: ID-like segments are treated as parameters |

## Related chapters

- [Transactions](15-transactions.md)
- [Run Comparison](22-run-comparison.md)
- [JMeter Integration](09-jmeter-integration.md)
