# Performance Tests

A performance test is the definition of a repeatable test scenario: which application and environment it targets, what kind of test it is, which SLA profile applies and which load profile it uses. Each execution of a performance test is a test run with its own Run ID. Because all runs of a test share the same definition, Perfmon can compare them, maintain a baseline and detect regressions between builds.

## Where to find performance tests

Open Testing → Performance Tests (`/tests`). The detail page (`/tests/<id>`) shows the configuration history, the 25 most recent runs and the test data of the test.

## Test fields

| Field | Required | Rules | Description |
|---|---|---|---|
| `applicationId` | Yes | UUID | Application under test (fixed after creation) |
| `environmentId` | Yes | UUID; must belong to the application | Target environment (fixed after creation) |
| `name` | Yes | 1 to 200 characters | For example `200 TPS Payment Load`. Matched case-insensitively by `POST /runs` |
| `testType` | No | `LOAD` (default), `STRESS`, `SPIKE`, `SOAK`, `ENDURANCE`, `VOLUME`, `CAPACITY`, `SCALABILITY`, `BASELINE` | Kind of test |
| `slaProfileId` | No | UUID | SLA profile evaluated when a run completes |
| `owner` | No | Up to 120 characters | Responsible person |
| `description` | No | Up to 5000 characters | Free text |
| `tags` | No | Up to 30 tags, 60 characters each | Labels for filtering |
| `loadProfile` | No | Object, see below | Initial load profile (configuration version 1) |

### Load profile

| Field | Description |
|---|---|
| `virtualUsers` | Number of concurrent users (threads) |
| `rampUpSec`, `rampDownSec` | Ramp durations in seconds |
| `durationSec` | Steady-state duration in seconds |
| `targetTps` | Target throughput; used by the result classification and the score when no TPS SLA rule exists |
| `threadGroup` | Name of the JMeter thread group |
| `thinkTimeMs` | Think time in milliseconds |
| `properties` | Free-form JSON object (for example JMeter properties) |

## Creating a test

Requires `CREATE_TEST` (roles `PERFORMANCE_ENGINEER`, `QA_ENGINEER`, administrators; also API keys with the `ingest` scope).

```bash
curl -s -X POST "$PERFMON_URL/api/v1/tests" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "applicationId": "<application-id>",
    "environmentId": "<environment-id>",
    "name": "200 TPS Payment Load",
    "testType": "LOAD",
    "slaProfileId": "<sla-profile-id>",
    "tags": ["payments", "nightly"],
    "loadProfile": {"virtualUsers": 100, "rampUpSec": 120, "durationSec": 1800, "targetTps": 200, "threadGroup": "Payments TG"}
  }'
```

### Creating tests implicitly from CI

`POST /api/v1/runs` can create the test on the fly when it does not exist yet. Pass `createTestIfMissing: true` together with the project, application, environment and test names (and optionally `testType`):

```bash
curl -s -X POST "$PERFMON_URL/api/v1/runs" \
  -H "authorization: Bearer $PERFMON_API_KEY" -H 'content-type: application/json' \
  -d '{"project":"payments","application":"merchant-payments","environment":"Performance",
       "test":"Checkout Smoke","createTestIfMissing":true,"testType":"LOAD"}'
```

The project, application and environment must already exist.

## Configuration versions

Load profiles are versioned. Changing the load profile with `PATCH /tests/:id` creates a new configuration version and marks it as current; fields you omit are copied from the previous version. Each run records the configuration version that was current when the run was created, and the run's `virtualUsers` and `targetTps` default to that configuration.

```bash
curl -s -X PATCH "$PERFMON_URL/api/v1/tests/<test-id>" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"loadProfile":{"virtualUsers":150,"targetTps":300}}'
```

Updating requires `EDIT_TEST`. The name, description, test type, SLA profile, owner and tags can also be changed; the application and environment cannot.

## Test data

Store test parameters with the test. Values whose key looks like a secret (`password`, `secret`, `token`, `api_key`, `credential`, `private`) or that are flagged `isSensitive` are encrypted and always returned masked.

```bash
curl -s -X PUT "$PERFMON_URL/api/v1/tests/<test-id>/data" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"key":"merchantCount","value":"5000"},{"key":"clientSecret","value":"s3cr3t"}]}'
```

## Baseline

One run per test can be the baseline. Regression detection and run comparisons use the baseline by default. Mark a run as baseline with `POST /api/v1/runs/:id/baseline` (requires `EDIT_TEST`); see [Running Tests](07-running-tests.md).

## Listing and archiving

```bash
# Filter by project, application, environment or text (name or tag)
curl -s "$PERFMON_URL/api/v1/tests?projectId=<project-id>&q=payment" -H "authorization: Bearer $TOKEN"

# Archive (runs are kept). Requires DELETE_TEST.
curl -s -X DELETE "$PERFMON_URL/api/v1/tests/<test-id>" -H "authorization: Bearer $TOKEN"
```

Archived tests can no longer be resolved by name in `POST /runs`.

## Related sections

- [Running Tests](07-running-tests.md)
- [Run IDs](08-run-ids.md)
- [JMeter Integration](09-jmeter-integration.md)
