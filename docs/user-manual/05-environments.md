# Environments

An environment is a deployment of an application in which tests are executed, for example `Performance`, `UAT` or `Staging`. Every performance test targets exactly one environment, and infrastructure metrics (servers, services, databases) are associated with environments so that they can be correlated with the runs executed there.

## Where to find environments

Environments do not have their own sidebar entry. They are managed inside their project (Inventory → Projects, `/projects/<id>`) and are listed per application under Inventory → Applications (`/applications`).

## Environment fields

| Field | Required | Rules | Description |
|---|---|---|---|
| `applicationId` | Yes | UUID | Owning application (fixed after creation); the project is taken from the application |
| `name` | Yes | 1 to 80 characters | For example `Performance`. Matched case-insensitively by `POST /runs` |
| `type` | Yes | `DEV`, `QA`, `SIT`, `UAT`, `PERFORMANCE`, `STAGING`, `PRODUCTION` | Environment class. `POST /runs` also accepts the type in place of the name |
| `description` | No | Up to 2000 characters | Free text |
| `baseUrl` | No | Up to 500 characters | Base URL of the system under test |
| `config` | No | JSON object | Free-form configuration (instance sizes, feature flags, ...) |

## Creating an environment

Requires `MANAGE_PROJECT`.

```bash
curl -s -X POST "$PERFMON_URL/api/v1/environments" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "applicationId": "<application-id>",
    "name": "Performance",
    "type": "PERFORMANCE",
    "baseUrl": "https://perf.payments.example.com",
    "config": {"appInstances": 4, "dbInstanceClass": "db.r6g.xlarge"}
  }'
```

## Viewing environments

```bash
# List, optionally filtered by project or application
curl -s "$PERFMON_URL/api/v1/environments?applicationId=<application-id>" -H "authorization: Bearer $TOKEN"

# Detail with servers and services (including databases)
curl -s "$PERFMON_URL/api/v1/environments/<environment-id>" -H "authorization: Bearer $TOKEN"
```

The list includes the number of servers, services, databases and currently `RUNNING` runs.

## Updating an environment

```bash
curl -s -X PATCH "$PERFMON_URL/api/v1/environments/<environment-id>" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"baseUrl":"https://perf2.payments.example.com"}'
```

## Deleting an environment

Deleting an environment removes its tests and runs. Confirmation is required:

```bash
curl -s -X DELETE "$PERFMON_URL/api/v1/environments/<environment-id>?confirm=true" \
  -H "authorization: Bearer $TOKEN"
```

## Environments and infrastructure metrics

The Perfmon Collector and `POST /api/v1/ingest/infrastructure` accept an `environment` (name or ID) and a `project`. When no `runId` is supplied, infrastructure data is correlated with the run that is currently `RUNNING` in the same environment. Run only one test at a time per environment if you rely on this automatic correlation, or pass the Run ID explicitly.

## Related sections

- [Applications](04-applications.md)
- [Performance Tests](06-performance-tests.md)
- [Live Monitoring](12-live-monitoring.md)
