# JMeter Integration

Perfmon is designed JMeter-first, and it needs no Perfmon plugin. It exposes an InfluxDB-compatible write endpoint, so JMeter's built-in `InfluxdbBackendListenerClient` can stream live metrics straight into a Perfmon run. After the test you can add the JTL results file and the JMeter HTML report to the same run for exact percentiles, the reconciliation check and long-term storage. This section explains each integration path, gives a step-by-step guide to the Backend Listener, and documents the JSON ingestion API for custom senders.

## Integration options

| Option | When data arrives | Endpoint | Percentiles | Typical use |
|---|---|---|---|---|
| Backend Listener (InfluxDB line protocol) | Live, every send interval (default 5 s) | `POST /api/v1/ingest/influx/write?runId=<RunID>` | Interval-reported by JMeter, approximate when combined (≈) | Live monitoring of any JMeter test |
| JSON raw samples | Live or batch | `POST /api/v1/runs/<RunID>/metrics` | Histogram-based, about 2.5% resolution | Custom senders, other load tools |
| JSON aggregates | Live or batch | `POST /api/v1/runs/<RunID>/metrics` or `POST /api/v1/metrics` | As reported | CI tools that only know aggregates |
| JTL import | After the test | `POST /api/v1/runs/<RunID>/artifacts` with `kind=JTL` | Histogram-based, about 2.5% resolution | Exact post-run analysis, tests without network access to Perfmon |
| HTML report | After the test | `POST /api/v1/runs/<RunID>/artifacts` with `kind=HTML_REPORT` | As computed by JMeter | Archiving, report viewer, reconciliation |

The options complement each other. A recommended setup uses the Backend Listener for live monitoring and uploads both the JTL and the HTML report at the end. Ready-made wrapper scripts that do all of this are described in [Set up JMeter for Perfmon](00b-jmeter-setup.md#the-wrapper-scripts).

## Prerequisites

| Item | Requirement |
|---|---|
| JMeter | 5.2 or later for the `influxdbToken` parameter. With older versions pass the API key in the URL (`&apiKey=pmk_...`) instead |
| Network | Load generators must reach the Perfmon API over HTTP(S), either the API port (`8080`) or the UI's reverse proxy (`/api/`) |
| Credential | A Perfmon API key with the `ingest` scope (`pmk_...`), ideally bound to the project |
| Run | A run in status `SCHEDULED`, `QUEUED` or `RUNNING`, identified by its Run ID |

### Obtaining an API key

API keys have the format `pmk_<8 hex characters>_<secret>`; only a SHA-256 hash is stored, so the secret is displayed once. Keys are managed by users with `MANAGE_API_KEYS` under Platform → Administration (`/admin`); the API contract is `POST /api/v1/api-keys` with `{"name":"jmeter-loadgen","scopes":["ingest"],"projectId":"<project-id>"}`, which returns the key including its one-time `secret`.

> Create keys in the UI under Platform → Administration → **API keys → Create key** (scope **ingest**) — see [Users, roles & API keys](00e-users-and-api-keys.md). For short local trials a user JWT obtained from `POST /api/v1/auth/login` is also accepted as `influxdbToken` (`Authorization: Token <JWT>`); JWTs expire after `JWT_EXPIRES_IN` (default 12 hours), so never use them for long tests or CI.

## Backend Listener: step-by-step setup

### Step 1: Open JMeter and the test plan

Start JMeter in GUI mode (`jmeter` or `jmeter.bat`) and open your test plan (`File → Open`). Verify the plan runs correctly on its own before you add Perfmon.

### Step 2: Create a run and get the Run ID

Each test execution needs its own run. Create it through the API (or let the wrapper scripts do it):

```bash
RUN_ID=$(curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/runs" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"project":"payments","application":"merchant-payments","environment":"Performance",
       "test":"200 TPS Payment Load","buildNumber":"104"}' | jq -r .runId)
echo "$RUN_ID"   # PF-2026-10-06-000127
```

The response also contains `ingest.jmeterInfluxListenerUrl`, the complete listener URL for this run. See [Running Tests](07-running-tests.md) and [Run IDs](08-run-ids.md).

### Step 3: Add a Backend Listener

Right-click the Test Plan (or a Thread Group, to limit the listener to that group) and choose **Add → Listener → Backend Listener**. Placing the listener at Test Plan level captures all samplers of all thread groups.

### Step 4: Select InfluxdbBackendListenerClient

In the **Backend Listener implementation** drop-down select:

```text
org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient
```

JMeter fills the parameter table with the default parameters of this client. Keep the **Async Queue size** at its default (5000) unless JMeter logs that the queue is full.

### Step 5: Configure the parameters

Set the parameters as follows. Using JMeter properties (`${__P(...)}`) keeps the plan reusable: the same `.jmx` works for every run, and the values are passed on the command line.

| Parameter | Value | Explanation |
|---|---|---|
| `influxdbMetricsSender` | `org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender` | Default HTTP sender. Do not change |
| `influxdbUrl` | `${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}` | Perfmon's InfluxDB-compatible endpoint. The `runId` query parameter assigns every point to the run. `/api/v1/ingest/influx/api/v2/write` is accepted as an alias |
| `application` | `${__P(perfmon.runId)}` or your application code | Sent as the `application` tag. Perfmon does not need it, but if it contains a standard Run ID (`PF-YYYY-MM-DD-NNNNNN`) it is used to resolve the run when `runId` is missing from the URL |
| `measurement` | `jmeter` | Measurement name of the sampler metrics. Perfmon expects `jmeter`. If you change it, append `&measurement=<name>` to `influxdbUrl`, otherwise the points are stored as generic metrics and the run charts stay empty |
| `summaryOnly` | `false` | `false` sends per-transaction statistics (transaction table, per-transaction charts, error details). `true` sends only the overall totals |
| `samplersRegex` | `.*` | Regular expression selecting the samplers to report. Restrict it to exclude helper samplers (for example `^(?!Debug).*`) |
| `percentiles` | `50;75;90;95;99;99.9` | Percentiles computed by JMeter per interval. Perfmon stores 50, 75, 90, 95, 99 and 99.9 (fields `pct50.0` ... `pct99.9`); other values are ignored |
| `testTitle` | `${__P(perfmon.runId)}` | Title used for the test start and end annotations. JMeter sends them to the `events` measurement; Perfmon stores them as `TEST_START` and `TEST_END` events of the run |
| `eventTags` | for example `build=104` | Optional tags added to the start/end annotations |
| `influxdbToken` | `${__P(perfmon.token)}` | Perfmon API key. JMeter sends it as `Authorization: Token <key>` |
| `TAG_runId` (optional, add with **Add**) | `${__P(perfmon.runId)}` | Adds a `runId` tag to every point. Alternative way to identify the run when the URL cannot carry a query string |

A complete test plan with this listener is available to download: [perfmon-sample-test.jmx](/samples/perfmon-sample-test.jmx).

### Step 6: Set the API key as influxdbToken

Put the API key into the `influxdbToken` parameter. Recommended: reference a property (`${__P(perfmon.token)}`) and pass the key at start-up so that it is never saved in the `.jmx` file:

```bash
jmeter ... -Jperfmon.token="$PERFMON_API_KEY"
```

Alternatives accepted by the ingestion endpoint:

| Method | Example |
|---|---|
| `influxdbToken` (recommended) | `Authorization: Token pmk_...` |
| Query parameter (JMeter versions without `influxdbToken`) | `...?runId=PF-...&apiKey=pmk_...` (also `p=` or `token=`) |

Query-string keys can appear in proxy and access logs; prefer the token parameter.

### Step 7: Run the test

GUI mode (for debugging only):

1. Define the properties in `user.properties` or start JMeter with `-Jperfmon.url=... -Jperfmon.runId=... -Jperfmon.token=...`.
2. Click **Start**.

Non-GUI mode (recommended for real load):

```bash
jmeter -n -t plan.jmx -l results.jtl -e -o report/ \
  -Jperfmon.url="http://perfmon.example.com:8080" \
  -Jperfmon.runId="$RUN_ID" \
  -Jperfmon.token="$PERFMON_API_KEY"
```

JMeter sends one HTTP request per send interval (property `backend_influxdb.send_interval`, default 5 seconds). The first accepted request switches the run from `QUEUED` to `RUNNING`.

### Step 8: Observe live metrics

Open Observability → Live Monitoring (`/live`) and select the run, or open `/live/<RunID>` directly. Throughput, response time percentiles, errors and active users update without reloading the page. Percentiles from the Backend Listener are shown with "≈" because they are combined from interval values. See [Live Monitoring](12-live-monitoring.md).

Verify from the command line:

```bash
curl -s "$PERFMON_URL/api/v1/runs/$RUN_ID" -H "authorization: Bearer $PERFMON_API_KEY" \
  | jq '{status, liveLastIngestAt, summary: {tps: .summary.tps, p95: .summary.p95, method: .summary.percentileMethod}}'
```

After the test, upload the artifacts and complete the run:

```bash
(cd report && zip -qr ../report.zip .)
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=HTML_REPORT -F file=@report.zip "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=JTL -F file=@results.jtl "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
curl -s --fail-with-body -X POST -H "authorization: Bearer $PERFMON_API_KEY" \
  "$PERFMON_URL/api/v1/runs/$RUN_ID/complete"
```

## Example configuration

The Backend Listener element as it appears in a `.jmx` file (abbreviated to the arguments):

```xml
<BackendListener guiclass="BackendListenerGui" testclass="BackendListener" testname="Perfmon Backend Listener" enabled="true">
  <elementProp name="arguments" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments">
    <collectionProp name="Arguments.arguments">
      <elementProp name="influxdbMetricsSender" elementType="Argument">
        <stringProp name="Argument.name">influxdbMetricsSender</stringProp>
        <stringProp name="Argument.value">org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender</stringProp>
        <stringProp name="Argument.metadata">=</stringProp>
      </elementProp>
      <elementProp name="influxdbUrl" elementType="Argument">
        <stringProp name="Argument.name">influxdbUrl</stringProp>
        <stringProp name="Argument.value">${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}</stringProp>
        <stringProp name="Argument.metadata">=</stringProp>
      </elementProp>
      <!-- application, measurement, summaryOnly, samplersRegex, percentiles,
           testTitle, eventTags, influxdbToken: see /samples/perfmon-sample-test.jmx -->
    </collectionProp>
  </elementProp>
  <stringProp name="classname">org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient</stringProp>
</BackendListener>
```

Equivalent `user.properties` entries for a workstation:

```properties
perfmon.url=http://localhost:8080
perfmon.runId=PF-2026-10-06-000127
perfmon.token=pmk_0a1b2c3d_REPLACE_ME
backend_influxdb.send_interval=5
```

## How Perfmon interprets Backend Listener data

The endpoint parses InfluxDB line protocol (`measurement,tag=value field=value timestamp`), supports escaped characters and quoted string fields, and detects the timestamp unit from its magnitude (seconds, milliseconds, microseconds or nanoseconds) unless `precision=` is given in the URL.

| Line sent by JMeter | Tags | Stored in Perfmon as |
|---|---|---|
| Per-transaction statistics | `transaction=<label>`, `statut=all` | Transaction metrics: `count`, `countError`, `avg`, `min`, `max`, `sb`, `rb`, `pct50.0` ... `pct99.9` |
| Per-transaction OK/KO lines | `statut=ok`, `statut=ko` | Used only when no `statut=all` line exists for the same transaction and timestamp (errors = `ko` count) |
| Overall totals | `transaction=all` | Run-level metrics |
| Error details | `transaction=<label>`, `responseCode=<code>`, `responseMessage=<text>` | Error metrics, classified by type (HTTP, ASSERTION, TIMEOUT, CONNECTION, DNS, SSL, EXCEPTION, OTHER) |
| Active threads | `transaction=internal` | Active users (`maxAT`, or `meanAT`), started threads (`startedT`) and finished threads (`endedT`) |
| Test annotations | measurement `events` | Run events `TEST_START`, `TEST_END` (text containing "end", "finish" or "stop") or `OTHER` |
| Any other measurement | any | Generic metric points named `<measurement>.<field>`, with the tags |

Per-transaction data without an explicit total produces a derived run-level total. The interval length is inferred from the gap between consecutive timestamps of the run (accepted range 1 to 60 seconds; 5 seconds is assumed otherwise).

You can test the endpoint without JMeter:

```bash
NOW_NS=$(( $(date +%s) * 1000000000 ))
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$PERFMON_URL/api/v1/ingest/influx/write?runId=$RUN_ID" \
  -H "authorization: Token $PERFMON_API_KEY" -H 'content-type: text/plain' \
  --data-binary @- <<EOF
jmeter,application=pay,transaction=Login,statut=all count=120,countError=1,avg=230,min=90,max=880,sb=48000,rb=240000,pct90.0=410,pct95.0=520,pct99.0=760 $NOW_NS
jmeter,application=pay,transaction=Login,responseCode=500,responseMessage=Internal\ Server\ Error count=1 $NOW_NS
jmeter,application=pay,transaction=internal minAT=50,maxAT=50,meanAT=50,startedT=50,endedT=0 $NOW_NS
EOF
# Expected: 204
```

Response codes of the line-protocol endpoint:

| Status | Meaning |
|---|---|
| `204` | Accepted (also returned for an empty body) |
| `400` | No Run ID could be determined, or no line could be parsed |
| `401` / `403` | Missing or invalid key; key lacks `INGEST_METRICS`; key bound to another project |
| `404` | Run ID not found |
| `409` | Run is not `SCHEDULED`, `QUEUED` or `RUNNING` (for example already `ANALYZING` or `COMPLETED`) |
| `429` | Ingestion rate limit exceeded |

Requests must use `Content-Type: text/plain`, `application/octet-stream` or `text/x-influxdb-line-protocol` (JMeter uses `text/plain`). Bodies up to 50 MB are accepted.

## Percentile accuracy

JMeter's Backend Listener computes percentiles inside JMeter for each send interval and sends only those values. Percentiles of two intervals cannot be combined exactly, so whenever Perfmon has to cover more than one interval (for example the P95 of the whole run, or a chart zoomed out to 1-minute buckets) it calculates a count-weighted average of the interval percentiles and labels the result `interval_weighted_approx`. The UI marks such values with "≈" and the plain-text run summary adds "(approx.)".

| Data source | `percentileMethod` | Accuracy |
|---|---|---|
| JSON raw samples, JTL import | `exact_histogram` | Every sample is recorded in a log-bucketed histogram (bucket boundaries grow by 5%, about 2.5% resolution). Histograms are merged for any window, never averaged |
| Backend Listener, single interval | `source_reported` | Exactly what JMeter reported for that interval |
| Backend Listener, several intervals | `interval_weighted_approx` | Approximation. Usually close for stable load, can deviate noticeably for skewed distributions or during ramps |
| HTML report | `source_reported` | Computed by JMeter from all samples |

For release decisions based on P95 or P99, upload the JTL (Perfmon then has an `exact_histogram` source) and compare with the HTML report in the reconciliation view (`GET /api/v1/runs/:id/reconciliation`). Small percentile differences between live data and the report are expected.

## JSON ingestion API

Use the JSON API for custom senders, other load tools or scripted backfills. Requires `INGEST_METRICS`.

### Run-scoped batches: POST /api/v1/runs/:runId/metrics

The body can take three shapes:

```json
{ "samples": [ /* RawSample, up to 200000 */ ], "points": [ /* Aggregate, up to 100000 */ ] }
```

```json
{ "metrics": [ /* Aggregate, up to 100000 */ ] }
```

```json
[ /* Aggregate, up to 100000 */ ]
```

Raw sample fields (one JMeter sample result):

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | number or string | Yes | Sample timestamp: epoch seconds, milliseconds or microseconds, or ISO 8601 |
| `label` | string (1 to 300) | Yes | Transaction or sampler name |
| `elapsed` | number (ms) | Yes | Response time |
| `success` | boolean | No (default `true`) | Sample result |
| `responseCode`, `responseMessage`, `failureMessage` | string | No | Used for error classification |
| `bytes`, `sentBytes` | number | No | Received and sent bytes |
| `latency`, `connect` | number (ms) | No | Latency and connect time |
| `url`, `method` | string | No | Used to build the normalized API endpoint inventory |
| `allThreads` | number | No | Active threads at sample time |

Aggregate fields (one interval, one transaction or the run total):

| Field | Description |
|---|---|
| `timestamp` or `ts` | Interval start (epoch or ISO) |
| `intervalSec` | Interval length, 1 to 3600 |
| `transaction` | Transaction name; omit or use `all` / `__all__` for the run total |
| `requests` or `count` | Number of samples |
| `errors` | Number of failed samples |
| `avgResponseTime` or `avg`, `min`, `max` | Response times in ms |
| `p50`, `p75`, `p90`, `p95`, `p99`, `p999` | Percentiles in ms (stored as reported) |
| `sentBytes`, `receivedBytes` | Bytes in the interval |
| `activeUsers` or `activeThreads` | Concurrency |
| `responseCodes` | Map of code to count, for example `{"200": 98, "500": 2}` |
| `errorDetails` | `[{"responseCode": "500", "message": "Internal Server Error", "count": 2}]` |
| `throughput`, `runId` | Accepted but not used on this endpoint (throughput is derived from counts) |

Examples:

```bash
# Raw samples (exact histogram percentiles)
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/metrics" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"samples":[
        {"ts":1791282600000,"label":"POST /api/v1/payment","elapsed":412,"success":true,"responseCode":"200","bytes":2048,"sentBytes":512,"allThreads":50,"url":"https://pay.example.com/api/v1/payment","method":"POST"},
        {"ts":1791282600120,"label":"POST /api/v1/payment","elapsed":1530,"success":false,"responseCode":"503","responseMessage":"Service Unavailable","allThreads":50}
      ]}'
# {"runId":"PF-2026-10-06-000127","accepted":2}

# Pre-aggregated interval (bare array)
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/metrics" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '[{"timestamp":"2026-10-06T10:30:00Z","intervalSec":10,"transaction":"Payment","requests":1000,"errors":3,
        "avgResponseTime":850,"p95":1200,"p99":1800,"activeUsers":100,"responseCodes":{"200":997,"500":3}}]'
```

Send many samples per request rather than one request per sample. A single request can carry up to 200,000 samples or a 50 MB body.

### Multi-run and dimensional data: POST /api/v1/metrics

The generic endpoint accepts an array (or `{"items": [...]}`) mixing aggregates with a `runId` and dimensional points:

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/metrics" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '[
    {"runId":"PF-2026-10-06-000127","timestamp":"2026-10-06T10:30:00Z","transaction":"Payment","requests":100,"errors":2,"avgResponseTime":850,"p95":1200},
    {"runId":"PF-2026-10-06-000127","metric":"queue.depth","value":42,"ts":1791282600000,"tags":{"queue":"payments"}}
  ]'
# {"accepted":2,"runs":["PF-2026-10-06-000127"]}
```

Aggregates without `runId` are rejected ("Never store performance metrics without a run"). Dimensional points (`metric` and `value`) without a run are stored as project-level metric points.

### Forcing a flush

Ingested data becomes visible after the aggregator flush (about one second). Tests and CI can force it:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/ingest/flush" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' -d "{\"runId\":\"$RUN_ID\"}"
```

## JTL import

JMeter writes every sample to the results file given with `-l`. Upload it to the run after the test:

```bash
curl -s --fail-with-body -H "authorization: Bearer $PERFMON_API_KEY" \
  -F kind=JTL -F file=@results.jtl "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
```

CSV (with or without header) and XML JTL files are supported, also gzip-compressed. The import stores metrics with source `jtl`, computes exact histogram percentiles, and sets the run's start and end time if they are still empty. When the run also has live data, live data remains the primary source for charts and the JTL data is kept as a second source. See [Artifact Management](11-artifact-management.md) for details.

Recommended JTL settings (`user.properties`):

```properties
jmeter.save.saveservice.output_format=csv
jmeter.save.saveservice.print_field_names=true
jmeter.save.saveservice.timestamp_format=ms
jmeter.save.saveservice.url=true
jmeter.save.saveservice.thread_counts=true
jmeter.save.saveservice.latency=true
jmeter.save.saveservice.connect_time=true
```

## Rate limits and sizing

| Limit | Default | Configuration |
|---|---|---|
| Ingestion requests per second per credential | 100, burst 200 | `INGEST_RATE_LIMIT_PER_SEC`; per-key override `rate_limit_per_sec` |
| Body size of ingestion requests | 50 MB | Fixed |
| Samples per JSON request | 200,000 | Fixed |
| Aggregates per JSON request | 100,000 | Fixed |

A Backend Listener sends one request per interval per JMeter engine, which is far below the limit. Rate-limited requests receive `429 RATE_LIMITED`; batch more data per request instead of raising the limit.

## Security recommendations

- Use a dedicated API key with only the `ingest` scope, bound to the project.
- Pass the key through `-Jperfmon.token` or an environment variable; do not store it in the `.jmx` file or in version control.
- Use HTTPS between load generators and Perfmon in shared networks.
- Revoke keys that are no longer needed.

## Related sections

- [Uploading HTML Reports](10-uploading-html-reports.md)
- [Live Monitoring](12-live-monitoring.md)
- [Troubleshooting](39-troubleshooting.md)
- [Set up JMeter for Perfmon](00b-jmeter-setup.md)
