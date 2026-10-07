# Applications

An application is a system under test inside a project, such as a REST API, a web shop or a batch service. Applications own environments and performance tests, and they are the level at which Perfmon builds its inventory of normalized API endpoints. A project usually contains several applications.

## Where to find applications

Open Inventory → Applications (`/applications`) for the application inventory across all projects, or open a project under Inventory → Projects (`/projects/<id>`) to see the applications of that project.

## Application fields

| Field | Required | Rules | Description |
|---|---|---|---|
| `projectId` | Yes | UUID | Owning project (fixed after creation) |
| `code` | Yes | 1 to 60 characters | Short identifier, for example `merchant-payments`. Accepted by `POST /runs` as `"application"` |
| `name` | Yes | 1 to 120 characters | Display name. Also accepted (case-insensitive) by `POST /runs` |
| `description` | No | Up to 2000 characters | Free text |
| `owner`, `team` | No | Up to 120 characters each | Ownership information |
| `technology` | No | Up to 200 characters | For example `Java 21, Spring Boot, PostgreSQL` |
| `repository` | No | Up to 500 characters | Source repository URL |
| `version` | No | Up to 60 characters | Current version |

The inventory list adds counts of environments (with their names), services, active tests and runs.

## Creating an application

Requires `MANAGE_PROJECT`.

```bash
curl -s -X POST "$PERFMON_URL/api/v1/applications" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "projectId": "<project-id>",
    "code": "merchant-payments",
    "name": "Merchant Payments API",
    "team": "Payments Core",
    "technology": "Java 21, Spring Boot"
  }'
```

## Viewing applications

```bash
# Inventory (optionally filtered by project)
curl -s "$PERFMON_URL/api/v1/applications?projectId=<project-id>" -H "authorization: Bearer $TOKEN"

# One application with its environments, services and tests
curl -s "$PERFMON_URL/api/v1/applications/<application-id>" -H "authorization: Bearer $TOKEN"
```

## Updating and archiving

```bash
curl -s -X PATCH "$PERFMON_URL/api/v1/applications/<application-id>" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"version":"2.4.0","owner":"jane.doe"}'

# Archive (soft delete): hidden from the inventory, history is kept
curl -s -X DELETE "$PERFMON_URL/api/v1/applications/<application-id>" -H "authorization: Bearer $TOKEN"
```

All fields except `projectId` can be changed.

## API endpoint inventory

When raw samples are ingested (JSON samples or JTL import), Perfmon infers an HTTP method and a normalized path template for each sample from its label and URL, and registers it as an API endpoint of the run's application. Endpoint statistics then become available per run (`GET /api/v1/runs/:id/endpoints`). Pre-aggregated data from the JMeter Backend Listener contains no URLs, so it does not populate the endpoint inventory.

## Naming recommendations

- Keep `code` stable; CI pipelines and the JMeter wrapper scripts refer to the application by code.
- Use one application per independently deployable system so that regressions and trends are not mixed.

## Related sections

- [Projects](03-projects.md)
- [Environments](05-environments.md)
- [Performance Tests](06-performance-tests.md)
