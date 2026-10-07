# InfluxDB (optional): connect it and see JMeter results in Perfmon

**You do not need InfluxDB to use Perfmon.** Perfmon accepts the InfluxDB line protocol itself, so JMeter's Backend Listener can send straight to Perfmon (see [Set up JMeter](00b-jmeter-setup.md)). This chapter is for teams that already write JMeter results to their own InfluxDB, want to keep their Grafana dashboards, or have historical results in InfluxDB.

## Choose your setup

| Your situation | Recommended setup | Live in Perfmon? |
|---|---|---|
| New to Perfmon, no InfluxDB | Backend Listener → **Perfmon** only | Yes |
| You use JMeter → InfluxDB → Grafana and want to keep it | **Two Backend Listeners**: one → InfluxDB, one → Perfmon | Yes |
| JMeter can only reach your InfluxDB (not Perfmon), or results are already in InfluxDB | Listener → InfluxDB, then **Import from InfluxDB** into a Perfmon run | After the import |
| You want server metrics (Telegraf CPU/memory/disk) from InfluxDB next to a run | InfluxDB **integration** + metric import | After the import |

```text
 Option A (two listeners, live)            Option B (import after the test)
 JMeter ─┬─► InfluxDB ─► Grafana           JMeter ─► InfluxDB ─► Grafana
         └─► Perfmon (live)                                └──► Perfmon: Run → "Import from InfluxDB"
```

## 1. Install InfluxDB

Skip this if you already have an InfluxDB server.

### Option 1 — the InfluxDB that ships with Perfmon's Docker stack

`docker compose up` already starts **InfluxDB 2.7** on port `8086` with:

| Setting | Value |
|---|---|
| URL | `http://perfmon-host:8086` (inside Docker: `http://influxdb:8086`) |
| Organization | `perfmon` |
| Bucket | `jmeter` |
| Token | value of `INFLUX_TOKEN` in `.env` (default `perfmon-dev-influx-token` — change it) |
| Web UI | `http://perfmon-host:8086` — user `perfmon`, password from `INFLUX_PASSWORD` |

### Option 2 — standalone InfluxDB 2.x with Docker

```bash
docker run -d --name influxdb2 -p 8086:8086 -v influxdb2:/var/lib/influxdb2 \
  -e DOCKER_INFLUXDB_INIT_MODE=setup \
  -e DOCKER_INFLUXDB_INIT_USERNAME=admin -e DOCKER_INFLUXDB_INIT_PASSWORD='Change-Me-123' \
  -e DOCKER_INFLUXDB_INIT_ORG=perf -e DOCKER_INFLUXDB_INIT_BUCKET=jmeter \
  -e DOCKER_INFLUXDB_INIT_ADMIN_TOKEN='replace-with-a-long-random-token' \
  influxdb:2.7
```

Create a separate, least-privilege token for JMeter (write) and one for Perfmon (read):

```bash
docker exec influxdb2 influx bucket list --org perf                         # note the jmeter bucket ID
docker exec influxdb2 influx auth create --org perf --description jmeter-write  --write-bucket <BUCKET_ID>
docker exec influxdb2 influx auth create --org perf --description perfmon-read --read-bucket  <BUCKET_ID>
```

### Option 3 — InfluxDB 1.8 with Docker

```bash
docker run -d --name influxdb18 -p 8086:8086 -v influxdb18:/var/lib/influxdb \
  -e INFLUXDB_DB=jmeter -e INFLUXDB_HTTP_AUTH_ENABLED=true \
  -e INFLUXDB_ADMIN_USER=admin -e INFLUXDB_ADMIN_PASSWORD='Change-Me-123' \
  -e INFLUXDB_USER=jmeter -e INFLUXDB_USER_PASSWORD='Jmeter-Pass-123' \
  influxdb:1.8
```

A ready-made Compose file with InfluxDB 1.8 **and** Grafana (ports chosen so they do not clash with Perfmon): [influxdb-grafana-compose.yml](/samples/influxdb-grafana-compose.yml).

```bash
docker compose -f influxdb-grafana-compose.yml up -d
```

## 2. Point the JMeter Backend Listener at InfluxDB

Add a Backend Listener (`InfluxdbBackendListenerClient`) as in [Set up JMeter](00b-jmeter-setup.md#4-add-the-backend-listener-to-your-test-plan), with these values:

| Parameter | InfluxDB 2.x | InfluxDB 1.8 |
|---|---|---|
| `influxdbUrl` | `http://influx-host:8086/api/v2/write?org=perf&bucket=jmeter` | `http://influx-host:8086/write?db=jmeter&u=jmeter&p=Jmeter-Pass-123` |
| `influxdbToken` | the **write** token | *(empty)* |
| `application` | a stable name, e.g. `checkout-load` — you filter on it later | same |
| `measurement` | `jmeter` | `jmeter` |
| `summaryOnly` | `false` | `false` |
| `percentiles` | `50;75;90;95;99;99.9` | same |
| `testTitle` | e.g. `${__P(perfmon.runId,checkout)}` | same |

Run the test and check that points arrive:

```bash
# 2.x
docker exec influxdb2 influx query 'from(bucket:"jmeter") |> range(start:-15m) |> filter(fn:(r)=>r._measurement=="jmeter") |> limit(n:3)' --org perf
# 1.8
curl -G 'http://influx-host:8086/query' -u admin:Change-Me-123 --data-urlencode "db=jmeter" \
  --data-urlencode "q=SELECT count(\"count\") FROM jmeter WHERE time > now() - 15m"
```

## 3. See it in Perfmon — Option A: a second listener (live)

Keep the InfluxDB listener and add **another** Backend Listener that points at Perfmon (`influxdbUrl=${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}`, `influxdbToken=${__P(perfmon.token)}`). JMeter sends the same statistics to both. Grafana keeps working, and Perfmon gets the run live with analysis, SLA and comparison.

## 4. See it in Perfmon — Option B: import from InfluxDB

### 4.1 Add the InfluxDB integration (once)

1. Platform → **Integrations → Add integration** (opens the **Catalog**) → **InfluxDB → Add**.
2. Fill in:

| Field | InfluxDB 2.x | InfluxDB 1.8 |
|---|---|---|
| Name | `Team InfluxDB` | `Team InfluxDB 1.8` |
| URL | `http://influx-host:8086` (as reachable **from the Perfmon server**) | same |
| API version | `v2` | `v1` |
| Organization / Bucket | `perf` / `jmeter` | — |
| Database | — | `jmeter` |
| Authentication | Token → the **read** token | Basic → user + password |
| Project | optional — limits the integration to one project | same |

3. Save, then click **Test** on the integration row. A healthy integration reports the InfluxDB version and the visible buckets/databases — for example *"Connected to InfluxDB v2.7.12; 3 bucket(s) visible"*.

![Integrations](/docs/img/integrations.png)
*Platform → Integrations: configured integrations with health, Test and Import actions.*

### 4.2 Import a test's results into a run

1. Create the run that should hold the results: open the test (Testing → Performance Tests) → **New run**. For a historical test you can do this after the fact.
2. Open the run → **Import from InfluxDB** (run header).
3. Choose the integration, keep measurement `jmeter`, enter the **application** tag you used in the listener (or leave it empty for all), and set the **From / To** window of the test. For a run that already ran, the window is pre-filled from its start and end time.
4. Leave **Complete the run after importing** ticked for a new run, then click **Import**.

![Import from InfluxDB](/docs/img/import-influx.png)
*Run → Import from InfluxDB. Perfmon reads the JMeter measurement for the window and stores it in this run.*

What happens:

- Perfmon reads the `jmeter` measurement (every transaction; `all`/`ok`/`ko` statistics; `pct50.0` … `pct99.9`; response codes and messages; the `internal` thread counts) and the `events` start/end annotations, in 30-minute slices.
- The data is stored exactly as if the listener had sent it to Perfmon live (source *import*), so the run gets KPIs, transactions, errors, threads, SLA evaluation, baseline comparison, regression detection, insights and a performance score. Percentiles are marked "≈" because JMeter reports them per interval.
- Importing again **replaces** the earlier import for that run, so you can widen the window or change the filter safely.

The same through the API (for scripts and CI):

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs/$RUN_ID/import/influx-jmeter" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"integrationId":"<integration-id>","measurement":"jmeter","application":"checkout-load",
       "from":"2026-10-07T09:00:00Z","to":"2026-10-07T09:30:00Z","complete":true}'
# {"runId":"PF-…","points":488,"events":2,"transactions":2,"from":"…","to":"…","status":"ANALYZING"}
```

The key or user needs the **INGEST_METRICS** permission (API-key scope *ingest*). Find the integration ID with `GET /api/v1/integrations` (field `id`). A window is limited to 7 days per import.

| Message | Meaning |
|---|---|
| `No "jmeter" points found … for application "…"` | Wrong window, measurement or application tag — check them in InfluxDB |
| `The integration needs a database (InfluxDB 1.x)` / `an organization and bucket (InfluxDB 2.x)` | Complete the integration settings |
| `InfluxDB query: 401` | The token/user cannot read the bucket/database |
| `Run … has no start time — give the test's time window` | New run: set From and To |

## 5. Server metrics from InfluxDB (Telegraf)

If Telegraf writes server metrics to InfluxDB, the same integration can pull them into a run: Platform → Integrations → **Import** on the integration row → pick the run. By default Perfmon reads the Telegraf measurements `cpu` (`usage_idle`, inverted to CPU %), `mem` (`used_percent`), `disk` (`used_percent`, path `/`) and `system` (`load1`), split by the `host` tag, and shows them under the run's infrastructure views. Change or add queries in the dialog (format `measurement:field{tag=value}`) or save them as the integration's metric mappings.

## 6. Grafana (optional)

1. Start Grafana — `docker compose --profile observability up -d` (Perfmon stack, port **3002**) or the sample compose file (port **3003**).
2. Sign in (`admin` / `admin`, then change it) → **Connections → Data sources → Add data source → InfluxDB**.
   - 2.x: Query language **Flux**, URL `http://influxdb:8086`, Organization, Token, Default bucket `jmeter`.
   - 1.8: Query language **InfluxQL**, URL, Database `jmeter`, user and password.
3. **Dashboards → New → Import** a community JMeter dashboard: ID **5496** (*Apache JMeter Dashboard using Core InfluxdbBackendListenerClient*, InfluxQL) or **13644** (Flux / InfluxDB 2). These are community dashboards, not maintained by Perfmon.

Grafana and Perfmon complement each other: Grafana for ad-hoc time-series views, Perfmon for the Run ID history, SLA verdicts, baselines, regression detection, reports and the HTML report archive.
