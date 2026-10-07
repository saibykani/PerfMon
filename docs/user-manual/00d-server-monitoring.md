# Monitor servers during a test

Response times only tell half the story. To see *why* a test slowed down, send the CPU and memory of the servers under test to Perfmon while the test runs. Perfmon correlates them with the run, so the run's infrastructure views, the bottleneck analysis and the insights can say things like "P95 rose when app-01 CPU passed 90%".

There are three ways to get server metrics into a run:

| Method | Best for | Chapter |
|---|---|---|
| **Perfmon Collector** — a small Node.js agent on each server | Servers you can install software on | this chapter |
| **InfluxDB / Prometheus / Dynatrace integration** — Perfmon pulls the metrics for the run window | Servers already monitored by Telegraf, Prometheus or Dynatrace | [InfluxDB](00c-influxdb-setup.md#5-server-metrics-from-influxdb-telegraf), Integrations |
| **OpenTelemetry** — OTLP/HTTP metrics to `/api/v1/ingest/otlp/v1/metrics` | Services instrumented with OpenTelemetry | Integrations |

## The Perfmon Collector

`collector/collector.mjs` has no dependencies and runs on Windows, Linux and macOS with Node.js 18+. Every 5 seconds it samples CPU %, memory %, memory used and the 1-minute load average, and sends them in batches to `POST /api/v1/ingest/infrastructure`. The server registers itself by name on first contact.

### Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PERFMON_URL` | yes | `http://localhost:8080` | Perfmon API |
| `PERFMON_API_KEY` | yes | — | API key with scope **ingest** |
| `PERFMON_PROJECT` | yes | — | Project key, e.g. `payments` |
| `PERFMON_ENV` | yes | — | Environment name, e.g. `Performance` |
| `PERFMON_RUN_ID` | no | — | Fixed Run ID. Without it, data is correlated to the environment's **RUNNING** run |
| `PERFMON_SERVER` | no | host name | Name shown in Perfmon |
| `PERFMON_ROLE` | no | `app` | `app`, `db`, `loadgen` or `gateway` |
| `INTERVAL_SEC` | no | `5` | Sampling interval; batches are sent every 3 samples |

Leave `PERFMON_RUN_ID` empty for a permanent agent: it then attaches its data to whichever run is RUNNING in that environment.

### Run it

**Linux**

```bash
scp collector/collector.mjs app-01:/opt/perfmon/collector.mjs
ssh app-01
PERFMON_URL=http://perfmon.example.com:8080 PERFMON_API_KEY=pmk_… \
PERFMON_PROJECT=payments PERFMON_ENV=Performance PERFMON_ROLE=app \
node /opt/perfmon/collector.mjs
```

**Windows**

```powershell
$env:PERFMON_URL="http://perfmon.example.com:8080"; $env:PERFMON_API_KEY="pmk_…"
$env:PERFMON_PROJECT="payments"; $env:PERFMON_ENV="Performance"; $env:PERFMON_ROLE="db"
node C:\perfmon\collector.mjs
```

### Run it as a service

**Linux (systemd)** — sample unit: [perfmon-collector.service](/samples/perfmon-collector.service)

```bash
sudo useradd --system --no-create-home perfmon
sudo cp perfmon-collector.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now perfmon-collector
journalctl -u perfmon-collector -f
```

**Windows** — run it at start-up with Task Scheduler (*Create Task → Trigger: At startup → Action: `node.exe C:\perfmon\collector.mjs`*, with the variables set as system environment variables), or wrap it as a service with NSSM (`nssm install PerfmonCollector "C:\Program Files\nodejs\node.exe" C:\perfmon\collector.mjs`).

### Where the data appears

- **Observability → Infrastructure** — servers, latest CPU/memory and health.
- On a run: the infrastructure charts next to throughput and response time, used by the bottleneck analysis and insights.

## System Monitor — the Perfmon server itself

Observability → **System Monitor** shows the machine that runs the Perfmon backend, live every 2 seconds:

- CPU (total, user/system and every core), memory, swap/page file, every disk, network throughput per interface
- the top processes by CPU (administrators only)
- Perfmon's own responsiveness (Node.js event-loop delay) and memory

Warnings appear when CPU, memory or a disk crosses 90%, or when Perfmon itself becomes slow — useful when the Perfmon server also acts as a load generator in a lab. The overview page shows the same machine in its **This machine** card.

![System Monitor](/docs/img/system-monitor.png)
*Observability → System Monitor.*

API: `GET /api/v1/system/host` (permission VIEW_RUN). Monitoring starts with the first request and stops automatically 90 seconds after the last viewer leaves.
