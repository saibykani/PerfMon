# Prerequisites, installation & hosts

This chapter lists what you need, how to install Perfmon, which hosts and ports are involved, and how to check that every machine can reach the others.

## What runs where

A typical setup has three kinds of machines. In a small lab they can all be one machine.

| Role | Example host name | Runs | Needs network access to |
|---|---|---|---|
| Perfmon server | `perfmon.example.com` | Perfmon UI, API, PostgreSQL, Redis, MinIO (Docker) | — |
| Load generator | `loadgen-01` | Apache JMeter (+ Java) | Perfmon API `:8080`, the system under test |
| System under test | `app-01`, `db-01` | Your application; optionally the Perfmon Collector | Perfmon API `:8080` (only if the Collector is installed) |
| Engineers' browsers | — | Perfmon UI | Perfmon UI `:3000` (and `:8081` for HTML reports) |

```text
  Engineer browser ──► :3000 UI ─┐
                                 │        perfmon.example.com (Docker)
  loadgen-01 (JMeter) ──► :8080 API ──► PostgreSQL :5433 · Redis :6380 · MinIO :9000
                                 │
  app-01 (Collector) ──► :8080 API
```

## Hardware guidance

These are starting points for the Perfmon server, not hard limits. Live ingestion is aggregated per second, so the size of a test matters less than the number of transactions and how long you keep the data.

| Usage | CPU | Memory | Disk |
|---|---|---|---|
| Trial / single engineer | 2 vCPU | 4 GB | 20 GB |
| Team (a few concurrent runs, months of history) | 4 vCPU | 8 GB | 100 GB SSD |
| Department (many concurrent runs, large HTML reports) | 8 vCPU | 16 GB | 250 GB+ SSD, external object storage |

Keep at least 15–20% of the disk free. The **System Monitor** page (Observability → System Monitor) shows the Perfmon server's CPU, memory and disk live, and warns when the disk is nearly full.

The load generator needs its own sizing: JMeter typically needs 1–2 GB of heap for a few hundred threads with the non-GUI mode. Do not run large tests on the Perfmon server itself.

## Software

| Machine | Software | Version |
|---|---|---|
| Perfmon server | Docker Desktop (Windows/macOS) or Docker Engine + Compose plugin (Linux) | Compose v2 |
| Perfmon server (development only) | Node.js | 20 or later |
| Load generator | Java (JDK or JRE) | 17 recommended (11 minimum) |
| Load generator | Apache JMeter | 5.6.x — <https://jmeter.apache.org/download_jmeter.cgi> |
| App servers (optional) | Node.js for the Perfmon Collector | 18 or later |

## Install Perfmon with Docker (recommended)

```bash
git clone https://github.com/saibykani/PerfMon.git
cd PerfMon
docker compose up -d --build
docker compose ps        # wait until backend is "healthy"
```

Open **http://localhost:3000** (or `http://perfmon.example.com:3000`).

### Settings to change for a shared server

Create a `.env` file next to `docker-compose.yml` before the first start:

```ini
# secrets — use long random values
JWT_SECRET=replace-with-64-random-characters
ENCRYPTION_KEY=replace-with-32-random-characters
POSTGRES_PASSWORD=replace-me
MINIO_ROOT_PASSWORD=replace-me

# first administrator (created only when no users exist)
DEMO_ADMIN_EMAIL=perf-admin@example.com
DEMO_ADMIN_PASSWORD=Choose-A-Strong-Passw0rd

# public URLs as users reach them
PUBLIC_URL=http://perfmon.example.com:3000
REPORT_CONTENT_ORIGIN=http://perfmon.example.com:8081

# do not show the demo password on the sign-in page and do not load demo data
SHOW_DEMO_CREDENTIALS=false
SEED_DEMO_DATA=false
```

Generate random values with `openssl rand -hex 32` (Linux/macOS) or `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')` (PowerShell).

### Optional extras

```bash
docker compose --profile observability up -d   # adds Prometheus (:9090) and Grafana (:3002)
```

The stack always includes an **InfluxDB 2.7** container (`:8086`, org `perfmon`, bucket `jmeter`, token from `INFLUX_TOKEN`). Perfmon itself does not need it; it is there for teams that also want JMeter data in InfluxDB/Grafana — see [InfluxDB (optional)](00c-influxdb-setup.md).

## Install for development (without the UI container)

```bash
docker compose -f docker-compose.dev.yml up -d     # PostgreSQL :5433, Redis :6380, MinIO :9000/:9001
cp backend/.env.example backend/.env
npm install
npm run dev --workspace backend                    # API on http://localhost:8080
npm run dev --workspace frontend                   # UI on http://localhost:5173
```

## Hosts & ports

| Service | Default URL / port | Who connects | Notes |
|---|---|---|---|
| Perfmon UI | `http://perfmon-host:3000` | Browsers | Docker `frontend` container (nginx) |
| Perfmon API | `http://perfmon-host:8080/api/v1` | UI, JMeter, Collector, CI | Health: `/api/v1/health` |
| API documentation (Swagger) | `http://perfmon-host:8080/api/docs` | Developers | Interactive OpenAPI |
| HTML report sandbox | `http://perfmon-host:8081` | Browsers | Serves uploaded JMeter HTML reports on a separate origin |
| PostgreSQL | `perfmon-host:5433` | Backend only | Do not expose publicly |
| Redis | `perfmon-host:6380` | Backend only | Do not expose publicly |
| MinIO (object storage) | `:9000` API, `:9001` console | Backend; admins | Artifacts and reports |
| InfluxDB (optional) | `http://perfmon-host:8086` | JMeter, Grafana | Not used by Perfmon unless you add an integration |
| Prometheus (optional) | `http://perfmon-host:9090` | Grafana | `--profile observability` |
| Grafana (optional) | `http://perfmon-host:3002` | Browsers | `--profile observability` |

## Firewall rules

| From | To | Port | Why |
|---|---|---|---|
| Engineers' networks | Perfmon server | 3000, 8081 | UI and HTML report viewer |
| Load generators | Perfmon server | 8080 | Live metrics and artifact upload |
| App/DB servers with the Collector | Perfmon server | 8080 | Server metrics |
| CI agents | Perfmon server | 8080 | Create runs, upload results |
| Perfmon server | Your InfluxDB / Prometheus / Dynatrace | 8086 / 9090 / 443 | Only for integrations you configure |

If you publish Perfmon behind a reverse proxy on one HTTPS host name, route `/api/` to port 8080 and everything else to the UI; then JMeter uses `https://perfmon.example.com` as `perfmon.url`.

## Verify connectivity

From each load generator and app server:

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" http://perfmon.example.com:8080/api/v1/health
# 200 0.012s
```

```powershell
Measure-Command { Invoke-RestMethod http://perfmon.example.com:8080/api/v1/health } | Select-Object TotalMilliseconds
Test-NetConnection perfmon.example.com -Port 8080
```

Then check that your API key works (replace the key):

```bash
curl -s http://perfmon.example.com:8080/api/v1/auth/me -H "authorization: Bearer pmk_xxxxxxxx_xxxx" | head -c 300
```
