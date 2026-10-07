# Set up JMeter for Perfmon

This chapter installs Java and Apache JMeter on a load generator, adds the Perfmon Backend Listener to a test plan, and runs it so results stream live into Perfmon. No Perfmon plugin is needed: JMeter's built-in **InfluxdbBackendListenerClient** talks to Perfmon's InfluxDB-compatible endpoint.

For every parameter in depth (and the JSON API for custom senders) see [JMeter Integration](09-jmeter-integration.md).

## 1. Install Java

JMeter 5.6 needs Java 8+; use **Java 17**.

**Windows**

1. Download a JDK 17 installer (for example Eclipse Temurin: <https://adoptium.net/temurin/releases/?version=17>) and run it. Tick *Set JAVA_HOME* and *Add to PATH*.
2. Open a new PowerShell window and check: `java -version`.

**Linux**

```bash
sudo apt-get install -y openjdk-17-jre-headless     # Debian/Ubuntu
sudo dnf install -y java-17-openjdk-headless         # RHEL/Fedora
java -version
```

## 2. Install Apache JMeter

Download the **binaries** zip/tgz of JMeter 5.6.x from <https://jmeter.apache.org/download_jmeter.cgi> and unpack it.

**Windows**

```powershell
Expand-Archive .\apache-jmeter-5.6.3.zip -DestinationPath C:\tools
$env:Path += ";C:\tools\apache-jmeter-5.6.3\bin"     # add permanently via System Properties → Environment Variables
jmeter -v
```

**Linux**

```bash
tar -xzf apache-jmeter-5.6.3.tgz -C /opt
echo 'export PATH=$PATH:/opt/apache-jmeter-5.6.3/bin' >> ~/.bashrc && source ~/.bashrc
jmeter -v
```

### Heap size

Give JMeter enough memory for the load you generate (non-GUI mode):

```bash
export HEAP="-Xms1g -Xmx2g -XX:MaxMetaspaceSize=256m"     # Linux / macOS, before running jmeter
```

```powershell
$env:HEAP = "-Xms1g -Xmx2g -XX:MaxMetaspaceSize=256m"     # Windows (jmeter.bat reads HEAP)
```

## 3. Get the connection details from Perfmon

You need three values:

| Property | Example | Where it comes from |
|---|---|---|
| `perfmon.url` | `http://perfmon.example.com:8080` | Perfmon API address reachable from this load generator |
| `perfmon.token` | `pmk_1a2b3c4d_…` | Administration → API keys → **Create key**, scope **ingest** ([details](00e-users-and-api-keys.md)) |
| `perfmon.runId` | `PF-2026-10-07-000127` | A new run per execution: **New run** on the test page, the API, or the wrapper script |

Create a run from the command line (the wrapper script does this for you):

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"project":"payments","application":"merchant-payments","environment":"Performance","test":"200 TPS Payment Load","buildNumber":"104"}'
```

The response contains `runId` and `ingest.jmeterInfluxListenerUrl`, the exact listener URL for this run. Add `"createTestIfMissing": true` to create the test on first use (the project, application and environment must already exist).

## 4. Add the Backend Listener to your test plan

Open the plan in the JMeter GUI (`jmeter` / `jmeter.bat`):

1. Right-click **Test Plan → Add → Listener → Backend Listener**.
2. **Backend Listener implementation**: `org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient`.
3. Fill in the parameters:

| Parameter | Value |
|---|---|
| `influxdbMetricsSender` | `org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender` |
| `influxdbUrl` | `${__P(perfmon.url)}/api/v1/ingest/influx/write?runId=${__P(perfmon.runId)}` |
| `application` | `${__P(perfmon.runId)}` |
| `measurement` | `jmeter` |
| `summaryOnly` | `false` |
| `samplersRegex` | `.*` |
| `percentiles` | `50;75;90;95;99;99.9` |
| `testTitle` | `${__P(perfmon.runId)}` |
| `eventTags` | *(empty, or e.g. `build=104`)* |
| `influxdbToken` | `${__P(perfmon.token)}` |

4. Save the plan. Because every value is a property (`${__P(...)}`), the same `.jmx` works for every run and environment, and the API key is never stored in the file.

> Shortcut: download [perfmon-sample-test.jmx](/samples/perfmon-sample-test.jmx). It already contains this listener, a thread group driven by properties, and three HTTP requests against `httpbin.org`. Open it, replace the requests with your own, and keep the listener.

## 5. Put the properties in user.properties (optional)

Instead of passing `-J` options every time, add them to `JMETER_HOME/bin/user.properties` (or a file passed with `-q`). A template: [user.properties](/samples/user.properties).

```properties
perfmon.url=http://perfmon.example.com:8080
# perfmon.token is better passed on the command line or from a secret store
# perfmon.runId changes every run — pass it with -Jperfmon.runId=...
backend_influxdb.send_interval=5
```

## 6. Run the test (non-GUI)

Always run real load in non-GUI mode.

**Linux / macOS**

```bash
jmeter -n -t plan.jmx -l results.jtl -e -o report \
  -Jperfmon.url="$PERFMON_URL" -Jperfmon.runId="$RUN_ID" -Jperfmon.token="$PERFMON_API_KEY" \
  -Jusers=50 -Jrampup=60 -Jduration=600
```

**Windows**

```powershell
jmeter -n -t plan.jmx -l results.jtl -e -o report `
  "-Jperfmon.url=$env:PERFMON_URL" "-Jperfmon.runId=$RUN_ID" "-Jperfmon.token=$env:PERFMON_API_KEY" `
  -Jusers=50 -Jrampup=60 -Jduration=600
```

The first data point switches the run to **RUNNING**. Open Observability → **Live Monitoring** to watch it.

After the test, upload the results and complete the run:

```bash
(cd report && zip -qr ../report.zip .)
curl -s -H "authorization: Bearer $PERFMON_API_KEY" -F kind=JTL -F file=@results.jtl "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
curl -s -H "authorization: Bearer $PERFMON_API_KEY" -F kind=HTML_REPORT -F file=@report.zip "$PERFMON_URL/api/v1/runs/$RUN_ID/artifacts"
curl -s -X POST -H "authorization: Bearer $PERFMON_API_KEY" "$PERFMON_URL/api/v1/runs/$RUN_ID/complete"
```

### The wrapper scripts

[run-perfmon-test.sh](/samples/run-perfmon-test.sh) (Linux/macOS) and [run-perfmon-test.ps1](/samples/run-perfmon-test.ps1) (Windows) do all of the above: create the run, run JMeter with the Run ID, zip and upload the HTML report and JTL, and complete the run (or mark it FAILED when JMeter exits with an error). Configure them with environment variables:

| Variable | Required | Example |
|---|---|---|
| `PERFMON_URL` | yes | `http://perfmon.example.com:8080` |
| `PERFMON_API_KEY` | yes | `pmk_…` (scope ingest) |
| `PERFMON_PROJECT` | yes | `payments` (project key or name) |
| `PERFMON_APPLICATION` | yes | `merchant-payments` (code or name) |
| `PERFMON_ENVIRONMENT` | yes | `Performance` (name or type) |
| `PERFMON_TEST` | yes | `200 TPS Payment Load` |
| `PERFMON_BUILD` | no | CI build number |
| `JMETER_ARGS` | no | extra JMeter options, e.g. `-Jusers=100 -Jduration=900` |

## Distributed (remote) testing

With JMeter's remote mode (`-R host1,host2`), each engine runs its own Backend Listener. Pass the properties to the engines with `-G` (global) instead of `-J`:

```bash
jmeter -n -t plan.jmx -R loadgen-01,loadgen-02 -l results.jtl \
  -Gperfmon.url="$PERFMON_URL" -Gperfmon.runId="$RUN_ID" -Gperfmon.token="$PERFMON_API_KEY"
```

Every engine must reach the Perfmon API on port 8080. Perfmon adds up the engines' requests, errors and bytes for the same Run ID. The **active threads** chart shows the highest single engine's value, not the sum of all engines — multiply by the engine count when you read virtual users.

## Troubleshooting

Look in `jmeter.log` (next to where you started JMeter) for lines from `InfluxdbBackendListenerClient` / `HttpMetricsSender`.

| Symptom | Cause | Fix |
|---|---|---|
| `Error writing metrics … 401` | No or invalid API key | Pass `-Jperfmon.token=pmk_…`; check the key is not revoked/expired |
| `… 403` | Key lacks the ingest scope, or is bound to another project | Create a key with scope **ingest** for this project |
| `… 404 Run … not found` | Wrong Run ID, or `perfmon.runId` not set | Print the property; use the Run ID of a run in this Perfmon |
| `… 409 Run … is COMPLETED` | Reusing a finished run | Create a new run for each execution |
| `… 413` | Very large batches | Lower `backend_influxdb.send_interval` or `samplersRegex` scope |
| `… 429` | Ingestion rate limit | Raise `INGEST_RATE_LIMIT_PER_SEC` on the server or the key's rate limit |
| `Connection refused` / timeout | Firewall or wrong URL | `curl $PERFMON_URL/api/v1/health` from the load generator |
| Live view empty but no errors | `measurement` changed from `jmeter` | Set it back, or add `&measurement=<name>` to `influxdbUrl` |
| Only totals, no transactions | `summaryOnly=true` | Set `summaryOnly=false` |
| Times look shifted | Load generator clock is wrong | Enable NTP on the load generator |
| Corporate proxy between JMeter and Perfmon | The listener's HTTP sender may not use the proxy | Allow direct access from load generators to the Perfmon API (port 8080) |
