# Users, roles & API keys

People sign in with a user account; tools (JMeter, the Collector, CI pipelines) authenticate with API keys. Both are managed under Platform → **Administration**.

## Users

Administration → **Users** (permission MANAGE_USERS).

![Administration](/docs/img/admin.png)
*Administration → Users.*

### Create a user

1. Click **Invite user**.
2. Enter the name, email and one or more **roles**.
3. Either set an initial password (8+ characters with letters and digits), or leave it empty: Perfmon then creates a one-time **set-your-password link** valid for 72 hours. If email is configured on the server the link is also emailed; otherwise copy it from the dialog and send it to the person.

### Manage users

| Action | How |
|---|---|
| Change roles or name | Pencil icon on the user row |
| Reset a forgotten password | Key icon (*Send password reset link*) on the row — a one-time link valid 24 hours |
| Block access | Person-with-cross icon (*Deactivate*) — the user can no longer sign in; history and audit entries stay |
| Unlock after failed logins | Deactivate and *Reactivate* the user (the failed-attempt lockout is cleared) |
| Change your own password | Click your initials at the top right → **Change password** |

You cannot deactivate yourself or remove your own user-management permission.

## Roles

| Role | Typical person | Can |
|---|---|---|
| Super admin / Admin | Platform owner | Everything, including users, API keys, settings and retention |
| Performance engineer | Designs and runs tests | Projects, tests, runs, ingestion, artifacts, dashboards, alerts, SLA, reports, API keys |
| QA engineer | Runs tests, reviews results | Tests, runs, ingestion, artifacts, dashboards, reports |
| Developer | Investigates latency and errors | View everything, upload artifacts, dashboards, reports |
| SRE | Infrastructure and alerting | View everything, dashboards, alerts, integrations, reports |
| Architect | Capacity and bottlenecks | View everything, dashboards, SLA, reports |
| Manager | Executive view | View everything, dashboards, reports |
| Viewer | Read-only | View projects, runs and reports |

The exact permission list per role is under Administration → **Roles & permissions**.

## API keys

Administration → **API keys** (permission MANAGE_API_KEYS).

### Create a key

1. Click **Create key**.
2. **Name** — where it is used, e.g. *JMeter load generators* or *Jenkins checkout pipeline*.
3. **Scopes**:
   - **ingest** — create, start and complete runs, push metrics (JMeter listener, Collector, OTLP), upload artifacts, import from InfluxDB. Use this for JMeter and CI.
   - **read** — read runs, metrics and reports (dashboards in other tools, scripts).
4. **Project** (recommended) — the key only works for that project.
5. Optional **rate limit** and **expiry**.
6. Copy the key shown after saving (`pmk_<8 characters>_<secret>`). **It is shown once** — Perfmon only stores a hash. If you lose it, rotate the key.

### Use a key

| Client | How to pass the key |
|---|---|
| curl / scripts | `Authorization: Bearer pmk_…` or `X-API-Key: pmk_…` |
| JMeter Backend Listener | parameter `influxdbToken` (sent as `Authorization: Token pmk_…`) |
| Perfmon Collector | `PERFMON_API_KEY` |

### Rotate and revoke

- **Rotate** issues a new secret with the same settings and revokes the old key immediately — update the secret in JMeter/CI right after.
- **Revoke** disables the key permanently.

Every create, rotate and revoke is recorded in Administration → **Audit log**.
