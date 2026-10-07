# Quick start: from zero to your first live test

This walkthrough takes you from an empty machine to a JMeter test streaming live into Perfmon, with results analysed and stored under a **Run ID**. Plan about 20 minutes. Every step links to the chapter with the full details.

## How the pieces fit together

```text
 ┌────────────────────┐   InfluxDB line protocol (every 5 s)    ┌──────────────────────────────┐
 │  JMeter            │ ──────────────────────────────────────► │  Perfmon API  (:8080)        │
 │  Backend Listener  │   POST /api/v1/ingest/influx/write      │  ├ live aggregation + SSE    │
 └────────────────────┘        ?runId=PF-…  + API key           │  ├ analysis jobs (SLA, …)    │
                                                                │  └ PostgreSQL + object store │
 ┌────────────────────┐   CPU / memory every 5 s                │                              │
 │  Perfmon Collector │ ──────────────────────────────────────► │                              │
 │  (on app servers)  │   POST /api/v1/ingest/infrastructure    └──────────────┬───────────────┘
 └────────────────────┘                                                        │ REST + live stream
                                                                               ▼
 After the test: upload results.jtl + HTML report  ──────────►   Perfmon UI (:3000) — live charts,
 POST /api/v1/runs/{runId}/artifacts                              transactions, SLA, comparison, reports
```

You do **not** need InfluxDB: Perfmon speaks the InfluxDB protocol itself, so JMeter's built-in listener sends straight to Perfmon. If your team already writes JMeter results to its own InfluxDB, see [InfluxDB (optional)](00c-influxdb-setup.md) — you can keep that setup and import the results into Perfmon.

## Step 1 — Install and start Perfmon

On the machine that will host Perfmon (needs Docker Desktop or Docker Engine with Compose):

```bash
git clone https://github.com/saibykani/PerfMon.git
cd PerfMon
docker compose up -d --build
```

When the containers are healthy (2–5 minutes on first build), open **http://localhost:3000**. Details, hardware sizing, ports and production settings: [Prerequisites, installation & hosts](00a-prerequisites-and-hosts.md).

Check the API from any machine that will send data:

```bash
curl http://perfmon-host:8080/api/v1/health          # {"status":"UP",...}
```

```powershell
Invoke-RestMethod http://perfmon-host:8080/api/v1/health
```

## Step 2 — Sign in

![Perfmon sign-in](/docs/img/login.png)
*The sign-in page. The status chip at the top right shows whether the API is reachable and how fast it responds.*

With the default Docker configuration the first administrator is `admin@perfmon.local` with the password from `DEMO_ADMIN_PASSWORD` (`Perfmon@123` unless you changed it). **Change it** right away — click your initials at the top right → **Change password** — or set `DEMO_ADMIN_PASSWORD` before the first start on shared servers.

## Step 3 — Create users for your team (optional)

Platform → **Administration → Users → Invite user**. Pick a role (Performance Engineer, QA Engineer, Developer, SRE, Architect, Manager, Viewer, Admin). Without a password Perfmon generates a one-time "set your password" link. See [Users, roles & API keys](00e-users-and-api-keys.md).

## Step 4 — Create the inventory: project → application → environment → test

Perfmon organises everything as **Organization → Project → Application → Environment → Performance test → Run**.

1. Inventory → **Projects → New project** (for example *Payments*, key `payments`).
2. Open the project → **Applications → New application** (for example *Merchant Payments*, code `merchant-payments`).
3. Add an **environment** to the application (for example *Performance*, type `PERFORMANCE`).
4. Testing → **Performance Tests → New test** (for example *200 TPS Payment Load*, type `LOAD`), linked to that application and environment. Add SLA rules now or later.

Details: [Projects](03-projects.md), [Applications](04-applications.md), [Environments](05-environments.md), [Performance tests](06-performance-tests.md).

## Step 5 — Create an API key for JMeter

Administration → **API keys → Create key**: name `jmeter-loadgen`, scope **ingest**, optionally bind it to the project. Copy the key (`pmk_…`) — it is shown **once**. Store it in your CI secret store or a local environment variable:

```bash
export PERFMON_URL=http://perfmon-host:8080
export PERFMON_API_KEY=pmk_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx
```

```powershell
$env:PERFMON_URL = "http://perfmon-host:8080"
$env:PERFMON_API_KEY = "pmk_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx"
```

## Step 6 — Prepare JMeter

Install Java 17 and Apache JMeter 5.6.x, then add a **Backend Listener** (`InfluxdbBackendListenerClient`) to your test plan that points at Perfmon. The easiest start is the ready-made sample plan, which already contains the listener:

- [perfmon-sample-test.jmx](/samples/perfmon-sample-test.jmx) — 3 HTTP requests against a public test API, with the Perfmon listener
- [run-perfmon-test.sh](/samples/run-perfmon-test.sh) / [run-perfmon-test.ps1](/samples/run-perfmon-test.ps1) — create the run, run JMeter, upload results, complete the run

Full instructions: [Set up JMeter for Perfmon](00b-jmeter-setup.md).

## Step 7 — Run the test

The wrapper script does everything in one go:

```bash
chmod +x run-perfmon-test.sh
PERFMON_PROJECT=payments PERFMON_APPLICATION=merchant-payments PERFMON_ENVIRONMENT=Performance \
PERFMON_TEST="200 TPS Payment Load" ./run-perfmon-test.sh perfmon-sample-test.jmx
```

```powershell
$env:PERFMON_PROJECT="payments"; $env:PERFMON_APPLICATION="merchant-payments"
$env:PERFMON_ENVIRONMENT="Performance"; $env:PERFMON_TEST="200 TPS Payment Load"
.\run-perfmon-test.ps1 -Plan .\perfmon-sample-test.jmx
```

It prints the Run ID (for example `PF-2026-10-07-000127`) and a link to the live view.

**Without the script:** open the test (Testing → Performance Tests → your test) and click **New run**. Perfmon creates the run and shows its Run ID together with the ready-to-paste JMeter command line and listener settings. Run JMeter with those values, then upload the results on the run's **Artifacts** tab and click **Complete**.

## Step 8 — Watch it live

Open Observability → **Live Monitoring** and pick the run, or follow the link the script printed. Throughput, response-time percentiles, errors and active threads update every few seconds. Percentiles from the Backend Listener carry a "≈" because JMeter reports them per interval.

![Run detail](/docs/img/run-detail.png)
*A run after analysis: result, performance score, KPIs with deltas against the baseline, and the run summary.*

## Step 9 — Review the results

When JMeter finishes, the script uploads `results.jtl` and the HTML report and completes the run. Perfmon then computes the summary, evaluates SLA rules, compares against the baseline, detects regressions and bottlenecks, and assigns a result (PASS, PASS WITH WARNINGS, FAIL or INCONCLUSIVE) and a performance score. Open the run from Testing → **Test Runs**.

Next steps:

- Mark a good run as **baseline** so later runs are compared with it ([Run comparison](22-run-comparison.md), [Regression detection](23-regression-detection.md)).
- Monitor the servers under test during runs: [Monitor servers during a test](00d-server-monitoring.md).
- Automate it in your pipeline: [CI/CD integration](30-ci-cd-integration.md).

## Troubleshooting the first run

| Symptom | Likely cause | Fix |
|---|---|---|
| Sign-in says "API unreachable" | Backend not running, or the UI cannot reach it | `docker compose ps`; `curl :8080/api/v1/health` |
| JMeter log: `401` from the listener | Missing or wrong API key | Check `-Jperfmon.token`; the key must have the **ingest** scope |
| JMeter log: `403` | Key bound to another project | Use a key for this project or an unbound key |
| JMeter log: `404 Run … not found` | Run ID typo, or the run was created in another organization | Use the Run ID printed by the script |
| JMeter log: `409 … COMPLETED` | Data sent to a finished run | Create a new run for every execution |
| Live view stays empty | Listener disabled, wrong `measurement`, or firewall | See [JMeter troubleshooting](00b-jmeter-setup.md#troubleshooting) |
