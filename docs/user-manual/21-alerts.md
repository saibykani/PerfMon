# Alerts

Perfmon alerts you while a test is running (response time, throughput, errors), when infrastructure crosses a threshold (CPU, memory, disk, JVM heap, GC), and when a run finishes with SLA violations, a failure or a regression. Each alert is created by an **alert rule** and delivered through one or more **notification channels**: in-app, email, Slack, Microsoft Teams or a generic webhook.

## Where to find it

**Analysis → Alerts** (`/alerts`) opens the page "Alerts & notifications", which has three tabs:

| Tab | URL | Contents |
|---|---|---|
| Alerts | `/alerts` | Alert instances with status and severity filters; the badge shows how many are firing |
| Rules | `/alerts?tab=rules` | Alert rules: create, edit, enable/disable, delete |
| Channels | `/alerts?tab=channels` | Notification channels: create, test, delete |

In-app notifications are listed per user and can be marked as read (see the REST API section).

| Action | Permission |
|---|---|
| View alerts, rules, channels | `VIEW_PROJECT` |
| Acknowledge or resolve alerts; manage rules and channels | `CONFIGURE_ALERT` |

## Rule types

| Type | Label | Scope | Default operator | Unit | What is measured |
|---|---|---|---|---|---|
| `HIGH_RESPONSE_TIME` | High average response time | Live | `>` | ms | Average over the window, per running run (optionally one transaction) |
| `HIGH_P95` | High P95 response time | Live | `>` | ms | P95 over the window |
| `HIGH_P99` | High P99 response time | Live | `>` | ms | P99 over the window |
| `LOW_TPS` | Low throughput | Live | `<` | tps | Average TPS over the window |
| `HIGH_ERROR_RATE` | High error rate | Live | `>` | % | Error % over the window |
| `CPU` | Server CPU utilization | Infra | `>` | % | Average CPU over the window, per server |
| `MEMORY` | Server memory utilization | Infra | `>` | % | Average memory over the window, per server |
| `DISK` | Server disk utilization | Infra | `>` | % | Average disk over the window, per server |
| `JVM_HEAP` | JVM heap utilization | Infra | `>` | % | Maximum heap % over the window, per server |
| `GC` | JVM GC pause | Infra | `>` | ms | Maximum GC pause over the window, per server |
| `SLA_VIOLATION` | SLA violation at run completion | Completion | - | violations | Fires when the run has one or more failed SLA assertions |
| `TEST_FAILURE` | Test failed / aborted / result FAIL | Completion | - | - | Fires when status is `FAILED` or `ABORTED`, or the result is `FAIL` |
| `REGRESSION` | Regression vs baseline at run completion | Completion | - | % | Fires when regression detection finds at least one regression |

Live and infrastructure rules need a **threshold**. Completion rules do not. Their conditions come from [SLA / SLO](20-sla-slo.md) and [Regression Detection](23-regression-detection.md).

## Rule settings

| Setting | Default | Notes |
|---|---|---|
| Name, Description | - | The description can hold a runbook link, owner or other context |
| Operator | Per type | `>`, `>=`, `<`, `<=` |
| Threshold | - | Required for Live and Infra rules |
| Severity | `WARNING` | `INFO`, `WARNING`, `CRITICAL` |
| Window | 60 s | 10 s to 86,400 s; the look-back for Live and Infra rules |
| Cooldown | 300 s | After an alert resolves, the same rule and subject do not fire again within this period |
| Filters | None | Environment, Test, Transaction (Live rules), Server (CPU/MEMORY/DISK) |
| Notification channels | None | **In-app** notification is always added |
| Enabled | On | Disabling a rule resolves its open alerts |

## How alerts are evaluated

- **Live and infrastructure rules** are checked every **15 seconds**.
  - Live rules check every `RUNNING` run in the rule's project that matches the environment and test filters.
  - Infrastructure rules check every server in the project that reported within the window.
- **Completion rules** are checked once, after a run is analyzed.
- Alerts are tracked per **subject**. The subject is the Run ID (plus ` / <transaction>` if the rule filters on a transaction), or the server name for infrastructure rules. While an alert is open, Perfmon updates its value instead of creating a new alert.
- When the condition clears, the alert is **resolved automatically**, and a resolution notification is sent. Live alerts also resolve when their run stops running.

### Alert lifecycle

```text
FIRING --(Acknowledge)--> ACKNOWLEDGED --(condition clears / Resolve)--> RESOLVED
   \______________________________(condition clears / Resolve)_______________/
```

Only `FIRING` alerts can be acknowledged. You can add an optional comment when you acknowledge or resolve an alert. Each alert keeps an **Event history**: FIRED, NOTIFIED or NOTIFY_FAILED (per channel), ACKNOWLEDGED and RESOLVED.

## Notification channels

| Type | Configuration | Notes |
|---|---|---|
| `IN_APP` | None | Always used, even if no channels are selected |
| `EMAIL` | `config.recipients` (up to 50 addresses) | The server needs SMTP configured (`SMTP_HOST`) |
| `SLACK` | `secret` = Slack incoming-webhook URL (`https://`) | Stored encrypted |
| `TEAMS` | `secret` = Teams incoming-webhook URL (`https://`) | Sent as a MessageCard |
| `WEBHOOK` | `config.url` (http/https); optional signing `secret` | JSON POST with an HMAC signature |

Secrets are encrypted at rest and are never returned. Responses only show `hasSecret: true`. Use the test action on a channel (`POST /notification-channels/:id/test`) to send a test notification; the response includes `ok`, `latencyMs` and a message. Each delivery is recorded in the alert's history as `NOTIFIED` or, with the error message, `NOTIFY_FAILED`. A failure on one channel does not stop delivery to the other channels.

### Webhook payload

```json
{
  "source": "perfmon",
  "alertId": "8a1f...", "orgId": "...", "severity": "CRITICAL", "status": "FIRING",
  "title": "Checkout P95 above 2 s: P95 2310ms on PF-2026-10-06-000127",
  "message": "P95 over the last 60s is 2310ms (threshold > 2000ms).",
  "link": "https://perfmon.example.com/runs/PF-2026-10-06-000127",
  "value": 2310, "threshold": 2000, "runKey": "PF-2026-10-06-000127",
  "sentAt": "2026-10-06T10:21:15.000Z"
}
```

When a signing secret is set, the request includes `x-perfmon-signature: sha256=<hex HMAC-SHA256 of the JSON body>`. Verify it with the same secret:

```python
import hmac, hashlib
def valid(body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)
```

## Creating a rule

1. Go to **Analysis → Alerts → Rules** and select **New rule**.
2. Choose the **Rule type**, then set **Condition** (operator and threshold), **Window**, **Severity** and **Cooldown**.
3. Optionally restrict it with **Filters**: environment, test, transaction or server.
4. Pick the **Notification channels** and save.

```bash
curl -s -X POST "$PERFMON_URL/api/v1/alert-rules" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "projectId": "'"$PROJECT_ID"'",
    "name": "Checkout P95 above 2 s",
    "type": "HIGH_P95", "operator": ">", "threshold": 2000,
    "severity": "CRITICAL", "windowSec": 60, "cooldownSec": 300,
    "filters": { "transaction": "Checkout_Pay" },
    "channelIds": ["'"$SLACK_CHANNEL_ID"'"]
  }'
```

Create a Slack channel:

```bash
curl -s -X POST "$PERFMON_URL/api/v1/notification-channels" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "#perf-alerts", "type": "SLACK", "secret": "https://hooks.slack.com/services/T000/B000/XXXX" }'
```

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/alerts?projectId&status&severity&runId&q&page&pageSize` | Alerts plus `counts` per status |
| GET | `/alerts/:id` | Alert detail with rule and event history |
| POST | `/alerts/:id/acknowledge` | Acknowledge (`{ "comment": "..." }` optional) |
| POST | `/alerts/:id/resolve` | Resolve manually |
| GET | `/alert-rules/types` | Rule type catalogue |
| GET / POST | `/alert-rules` | List / create rules |
| PATCH / DELETE | `/alert-rules/:id` | Update / delete a rule (open alerts are resolved; history is kept) |
| GET / POST | `/notification-channels` | List / create channels |
| PATCH / DELETE | `/notification-channels/:id` | Update (omit `secret` to keep it, `null` to clear it) / delete |
| POST | `/notification-channels/:id/test` | Send a test notification |
| GET | `/notifications?limit&unreadOnly` | In-app notifications for the current user |
| POST | `/notifications/:id/read`, `/notifications/read-all` | Mark notifications as read |

```bash
curl -s "$PERFMON_URL/api/v1/alerts?status=FIRING&severity=CRITICAL" \
  -H "Authorization: Bearer $PERFMON_TOKEN"

curl -s -X POST "$PERFMON_URL/api/v1/alerts/$ALERT_ID/acknowledge" \
  -H "Authorization: Bearer $PERFMON_TOKEN" -H "Content-Type: application/json" \
  -d '{"comment": "Investigating DB pool, see INC-4411"}'
```

In-app notifications are only available to user sessions, not API keys.

## Related chapters

- [SLA / SLO](20-sla-slo.md)
- [Regression Detection](23-regression-detection.md)
- [Live Monitoring](12-live-monitoring.md)
