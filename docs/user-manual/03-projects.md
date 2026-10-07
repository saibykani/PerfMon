# Projects

A project is the top-level container inside your organization. It groups the applications, environments, performance tests, runs, releases, dashboards and SLA profiles that belong to one product or team. Project boundaries also act as an access boundary for API keys: a key bound to a project can only see and write data of that project.

## Where to find projects

Open Inventory → Projects (`/projects`). Selecting a project opens its detail page (`/projects/<id>`), which lists the project's applications, environments, tests and recent releases.

## Project fields

| Field | Required | Rules | Description |
|---|---|---|---|
| `key` | Yes | Lowercase letters, digits and dashes, 2 to 41 characters, starting with a letter or digit (`^[a-z0-9][a-z0-9-]{1,40}$`) | Short, stable identifier. Used in artifact storage paths and accepted wherever a project name is expected (for example `"project":"payments"` in `POST /runs`). Cannot be changed after creation. |
| `name` | Yes | 1 to 120 characters | Display name |
| `description` | No | Up to 2000 characters | Free text |

The project list also shows counts of applications, environments, active tests, runs, dashboards, releases and firing alerts, plus the time of the last run.

## Creating a project

Requires the `MANAGE_PROJECT` permission (roles `ADMIN`, `SUPER_ADMIN`, `PERFORMANCE_ENGINEER`).

```bash
curl -s -X POST "$PERFMON_URL/api/v1/projects" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"key":"payments","name":"Payments","description":"Card and wallet payment services"}'
```

A duplicate key returns `409 CONFLICT`.

## Viewing projects

```bash
# All active projects with counts
curl -s "$PERFMON_URL/api/v1/projects" -H "authorization: Bearer $TOKEN"

# Include archived projects
curl -s "$PERFMON_URL/api/v1/projects?includeArchived=true" -H "authorization: Bearer $TOKEN"

# One project with applications, environments, tests and the 20 most recent releases
curl -s "$PERFMON_URL/api/v1/projects/<project-id>" -H "authorization: Bearer $TOKEN"
```

Viewing requires `VIEW_PROJECT`, which every role has.

## Updating and archiving

```bash
# Rename
curl -s -X PATCH "$PERFMON_URL/api/v1/projects/<project-id>" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Payments Platform"}'

# Archive (hidden from the default list; data is kept). Use false to restore.
curl -s -X PATCH "$PERFMON_URL/api/v1/projects/<project-id>" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"archived":true}'
```

## Deleting a project

Deleting a project permanently removes all of its applications, environments, tests, runs and metrics. The request must repeat the project key as confirmation:

```bash
curl -s -X DELETE "$PERFMON_URL/api/v1/projects/<project-id>?confirm=payments" \
  -H "authorization: Bearer $TOKEN"
```

Without the correct `confirm` value the API returns `400` with a message stating the required value. The deletion is recorded in the audit log. Prefer archiving unless the data must be removed.

## Projects and API keys

API keys can be bound to one project. Such a key:

- only lists that project and its runs;
- receives `403 API key is not authorized for this project` when it addresses a run or test of another project.

Use project-bound keys for CI pipelines and load generators so that a leaked key cannot write into other projects.

## Related sections

- [Applications](04-applications.md)
- [Environments](05-environments.md)
- [Performance Tests](06-performance-tests.md)
