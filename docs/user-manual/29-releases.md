# Releases

A release is a deployable version of a product inside a project, for example `2.4.0` or `2026.10.1`. Linking runs to releases lets you see which performance tests were executed against a version, how they ended, and how P95 developed from one release to the next. Releases are usually created automatically by CI when a run is created with a `releaseVersion`; you can also create and maintain them by hand on the Releases page.

> **Implementation status.** Releases are a lightweight inventory feature: create, edit, delete, list, link runs, and use the release as a grouping key in Trends and dashboards. There is no release-level verdict, release comparison or approval workflow. The section [What is not implemented](#what-is-not-implemented) lists the gaps.

## Concepts

| Object | What it is | Unique per | Created by |
|---|---|---|---|
| Release | A version of the project: name, version, optional application, environment, build number, branch, commit, deployment date and notes | Project + version | The Releases page, `POST /api/v1/releases`, or automatically when a run is created with `releaseVersion` |
| Build | A CI build: build number, branch, commit, CI system and CI URL, optionally linked to a release | Project + build number | Automatically when a run is created with `buildNumber` (there is no other way to create one) |
| Run | One test execution. Can be linked to one release and one build | — | [Running Tests](07-running-tests.md) |

## Permissions

| Action | Permission | Roles that have it by default |
|---|---|---|
| View releases and builds | `VIEW_PROJECT` | All roles; API keys with `ingest` or `read` scope |
| Create, edit, delete releases | `MANAGE_PROJECT` | Super admin, Admin, Performance engineer |
| Create a release implicitly through run creation (`releaseVersion`) | `EXECUTE_TEST` | Super admin, Admin, Performance engineer, QA engineer; API keys with `ingest` scope |

An `ingest` API key cannot call `POST /api/v1/releases` (it lacks `MANAGE_PROJECT`), but it can create releases implicitly by passing `releaseVersion` when it creates a run. That is the recommended way for CI.

## Creating releases automatically from CI

Pass `releaseVersion` (and normally `buildNumber`) when you create the run:

```bash
RUN_ID=$(curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/runs" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"project":"payments","application":"merchant-payments","environment":"Performance",
       "test":"200 TPS Payment Load","buildNumber":"104","releaseVersion":"2.4.0",
       "branch":"main","commit":"a1b2c3d","ciSystem":"jenkins",
       "ciUrl":"https://ci.example.com/job/payments-perf/104/"}' | jq -r .runId)
```

What happens:

| Situation | Result |
|---|---|
| No release with version `2.4.0` exists in the project | A release is created with name and version `2.4.0`, the test's application and environment, and the run's build number, branch and commit |
| A release with version `2.4.0` already exists | It is reused unchanged; the run is linked to it |
| `buildNumber` is given | The build is created (or reused) and linked to the release. Branch and commit of an existing build are kept unless the new run supplies them |
| Only `buildNumber` is given, and that build is already linked to a release | The run is linked to the build's release |
| Neither is given | The run has no release |

The run's `version` field defaults to `releaseVersion` when you do not send a separate `version`. Runs created from the UI (**New run** dialog) have a **Release version** field with the same behaviour ("Links (or creates) the release").

## The Releases page

Open Reporting → **Releases** (`/releases`).

### KPIs

| KPI | Meaning |
|---|---|
| **Releases** | Number of releases in the list |
| **Deployed** | Releases that have a deployment date |
| **Runs linked** | Runs linked to these releases |
| **Releases with failures** | Releases with at least one run whose result is FAIL |
| **Latest** | The newest release (by deployment date, then creation time) and how long ago it was deployed |

### Table

Columns: **Release** (name), **Version**, **Build**, **Branch**, **Commit**, **Deployed** ("not deployed" when there is no date), **Environment** ("Any" when none), **Application** (hidden by default), **Tests** (tests that ran against the release), **Runs**, **Failures**. Use the **All projects** selector to show one project. The table can be sorted and exported.

### Release details

Click a row to open the release drawer:

- Build, branch, commit, deployment date, creation date and the number of runs, plus the notes.
- **P95 by run**: one bar per linked run, colored by result (red for FAIL, amber for PASS WITH WARNINGS). Hover a bar for the Run ID, test, P95 and result.
- **Associated runs**: Run ID (link to the run), test, build, start time, TPS, P95, error % and result.
- **Builds**: build number, branch, commit, CI system (linked to the CI URL when known) and creation time.

Users with `MANAGE_PROJECT` see **Edit release** and **Delete** in the drawer footer, and edit and delete icons in each table row.

## Creating and editing a release manually

1. On the Releases page click **New release** (requires `MANAGE_PROJECT`).
2. Fill in the form:

| Field | Required | Notes |
|---|---|---|
| **Project** | Yes | Fixed after creation |
| **Name** | Yes | Up to 120 characters, for example "October release" |
| **Version** | Yes | Up to 60 characters; unique within the project |
| **Application** | No | Leave empty for a release covering all applications |
| **Environment** | No | Shown as "Any" when empty |
| **Build number**, **Branch**, **Commit** | No | Informational |
| **Deployment date** | No | Date and time of the deployment |
| **Notes** | No | Up to 5000 characters, shown in the drawer |

3. Click **Create release**. If you set a deployment date, Perfmon also records a `DEPLOYMENT` event "Deployed <name> <version>" for the project, application and environment, which appears in Observability → **Events & Annotations** and as an annotation on charts ([Dashboards](13-dashboards.md)). The confirmation reads "Release 2.4.0 created — deployment event recorded".

To edit, use the pencil icon or **Edit release**, change the fields and click **Save changes**.

Releases also appear on the project page (Inventory → Projects → project → **Releases** tab, the 20 most recent) and in the global search (by version or name).

## Deleting a release

Click the delete icon or **Delete** and confirm **Delete release**. Only the release record is removed: its runs are kept but no longer linked to a release, and its builds are kept without a release. The deletion is written to the audit log.

## Linking an existing run to a release

There is no control for this in the UI. Use the run update API with the release's UUID (from `GET /api/v1/releases`), which requires `EXECUTE_TEST`:

```bash
REL_ID=$(curl -s -G "$PERFMON_URL/api/v1/releases" -H "authorization: Bearer $PERFMON_API_KEY" \
  --data-urlencode "projectId=<project-uuid>" | jq -r '.[] | select(.version=="2.4.0") | .id')

curl -s -X PATCH "$PERFMON_URL/api/v1/runs/$RUN_ID" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d "{\"releaseId\": \"$REL_ID\"}" | jq '{runId, releaseVersion}'
```

Send `{"releaseId": null}` to unlink a run.

## Using releases in analysis

| Feature | How releases are used |
|---|---|
| [Performance Trends](24-performance-trends.md) | **Group by release**: one point per release (the latest completed run per test and environment), ordered by deployment date, or creation date when there is none. Runs without a release fall back to their `version` field; runs with neither are left out |
| [Dashboard Builder](14-dashboard-builder.md) | Panels can group cross-run data by `release`; runs without one appear as "(no release)" |
| Run list API | `GET /api/v1/runs?release=2.4` filters runs by release version (partial match) |
| Run header and reports | The run header shows "rel <version>"; the Test Execution report shows "Version / release" |
| Executive Performance dashboard | The default dashboard for release readiness: pass rate, SLA compliance, throughput and latency trends, regressions ([Dashboards](13-dashboards.md)) |

To compare two releases, compare a representative run of each with [Run Comparison](22-run-comparison.md), or use Trends grouped by release.

## API reference

All paths are relative to `/api/v1`.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /releases?projectId=<uuid>` | `VIEW_PROJECT` | Releases with `run_count`, `failed_runs`, `tests`, `application_name`, `environment_name`; newest deployment first. API keys bound to a project see only that project |
| `POST /releases` | `MANAGE_PROJECT` | Create a release (`201`). Body below |
| `GET /releases/:id` | `VIEW_PROJECT` | Release with `runs` (Run ID, status, result, build, start, test, P95, TPS, error %) and `builds` |
| `PATCH /releases/:id` | `MANAGE_PROJECT` | Update any field except `projectId`; send `null` to clear an optional field |
| `DELETE /releases/:id` | `MANAGE_PROJECT` | Delete; runs and builds are kept, unlinked |
| `GET /builds?projectId=<uuid>` | `VIEW_PROJECT` | Up to 500 builds, newest first, with `release_version` and `run_count` |
| `PATCH /runs/:id` with `releaseId` | `EXECUTE_TEST` | Link or unlink a run |

Request body for `POST /releases`:

| Field | Type | Required |
|---|---|---|
| `projectId` | UUID | Yes |
| `name` | string, 1 to 120 | Yes |
| `version` | string, 1 to 60 | Yes |
| `applicationId`, `environmentId` | UUID or `null` | No |
| `buildNumber` | string up to 60 | No |
| `branch` | string up to 200 | No |
| `commit` | string up to 100 | No |
| `deploymentDate` | ISO 8601 date-time | No |
| `notes` | string up to 5000 | No |

```bash
curl -s --fail-with-body -X POST "$PERFMON_URL/api/v1/releases" \
  -H "authorization: Bearer $PERFMON_TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"<project-uuid>","name":"October release","version":"2026.10.1",
       "buildNumber":"118","branch":"release/2026.10","commit":"9f8e7d6",
       "deploymentDate":"2026-10-08T06:00:00Z","notes":"Payment service upgraded to Java 21"}'
```

Here `$PERFMON_TOKEN` is a user JWT or an API key whose owner has `MANAGE_PROJECT`; an `ingest`-scope key is not enough. A second release with an existing version in the same project is rejected with `409 CONFLICT` ("A resource with the same unique key already exists").

## What is not implemented

The following are **not** available in the current version:

| Gap | Workaround |
|---|---|
| A release-level result, score or go/no-go verdict | Use the results of the linked runs, the **Failures** column, and the Executive Performance dashboard |
| Comparing two releases directly | Compare representative runs ([Run Comparison](22-run-comparison.md)) or use Trends grouped by release |
| Linking an existing run to a release from the UI | `PATCH /api/v1/runs/:id` with `releaseId` (see above) |
| Creating, editing or deleting builds | Builds are created only by run creation with `buildNumber`; `GET /api/v1/builds` is read-only and builds are shown only in the release drawer |
| A deployment event when the deployment date is **edited** | The `DEPLOYMENT` event is recorded only when a release is **created** with a deployment date. Add the event yourself on the Events & Annotations page if you set the date later |
| Opening a release from a global-search result | The result opens the Releases page; click the release in the table |
| Filtering the Releases page by application or environment | Filter by project; use the table sort or export |
| Release status, approvals or release notes beyond the free-text **Notes** field | — |

There is no separate releases module in the backend: release endpoints are part of the inventory API, and automatic creation happens in run creation.

## Related sections

- [Running Tests](07-running-tests.md)
- [CI/CD Integration](30-ci-cd-integration.md)
- [Performance Trends](24-performance-trends.md)
- [Run Comparison](22-run-comparison.md)
- [Projects](03-projects.md)
- [Dashboards](13-dashboards.md)
