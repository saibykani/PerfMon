# Security

This chapter describes how Perfmon authenticates people and tools, what each role may do, how secrets are stored, how uploaded HTML is isolated, which rate limits apply and what is written to the audit log. It closes with a hardening checklist for self-hosted and cloud deployments. Everything here reflects the backend code (`backend/src/auth`, `lib/crypto.ts`, `app.ts`, `artifacts`, `audit`) and the shipped hosting files (`render.yaml`, `vercel.json`, `infrastructure/docker/nginx.conf`).

## Overview

| Area | Mechanism | Configuration |
|---|---|---|
| User sign-in | Email + password (bcrypt), optional Google sign-in, JWT sessions | `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REMEMBER_EXPIRES_IN`, `GOOGLE_CLIENT_ID` |
| Tool access | API keys `pmk_...` with scopes `ingest` / `read`, optional project binding, expiry and rate limit | Administration → API keys |
| Authorization | Role-based permissions (users), scope-based permissions (API keys), organization and project scoping | `backend/src/auth/rbac.ts` |
| Stored secrets | AES-256-GCM encryption of integration credentials, notification channel secrets and sensitive test data | `ENCRYPTION_KEY` |
| Uploaded HTML | Served from a sandboxed origin with a CSP `sandbox` policy and short-lived signed URLs | `REPORT_CONTENT_ORIGIN`, `REPORT_CONTENT_PORT` |
| Abuse protection | Global API rate limit, stricter limits on auth endpoints, per-key ingestion token bucket, login lockout | `API_RATE_LIMIT_PER_MIN`, `INGEST_RATE_LIMIT_PER_SEC` |
| Accountability | Audit log of security-relevant actions, including denied requests | Administration → Audit log |

## Authentication

Every request to `/api/v1` must carry a credential, except these public routes: `POST /auth/login`, `POST /auth/google`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `GET /auth/config`, `GET /api/v1/health`, the API documentation under `/api/docs`, the self-monitoring endpoint `/metrics`, and the signed report-content URLs under `/report-content/`. Anything else without a valid credential is answered with `401 UNAUTHORIZED` "Authentication required".

Accepted credentials:

| Credential | How it is sent | Notes |
|---|---|---|
| User session (JWT) | `Authorization: Bearer <JWT>` | Issued by `POST /auth/login` or `POST /auth/google` |
| API key | `Authorization: Bearer pmk_...`, `Authorization: Token pmk_...` or `X-API-Key: pmk_...` | `Token` is what the JMeter Backend Listener sends for `influxdbToken` |
| API key in the query string | `?apiKey=`, `?p=` or `?token=` | Only on the InfluxDB-compatible endpoints (`/ingest/influx/...`), for JMeter versions without `influxdbToken` |
| JWT in the query string | `?access_token=<JWT>` | Only on streaming (`/stream`) endpoints, because the browser's EventSource cannot set headers |

> Query-string credentials can end up in proxy and backend request logs. Prefer headers wherever the client supports them.

### Sessions (JWT)

| Property | Value |
|---|---|
| Signing | HMAC with `JWT_SECRET`, issuer `perfmon`; every token has a unique ID (`jti`) |
| Lifetime | `JWT_EXPIRES_IN` (default `12h`) |
| "Keep me signed in" | Login body `remember: true` issues a token valid for `JWT_REMEMBER_EXPIRES_IN` (default `30d`) |
| Storage in the browser | With **Keep me signed in** the token is kept in `localStorage`, otherwise in `sessionStorage` (cleared when the browser session ends) |
| Logout | `POST /auth/logout` stores the token's `jti` in `revoked_tokens`; the token is rejected from then on |
| Role or status changes | Permissions are re-read from the database at most 30 seconds after a change (per-instance cache); the administration endpoints clear the cache immediately on the instance that handled the change |
| Deactivated users | A deactivated user's existing tokens stop working, because every request re-checks `is_active` |

What revokes sessions and what does not:

| Event | Effect on existing tokens |
|---|---|
| Sign out | That one token is revoked |
| User deactivated (Administration → Users) | All of the user's tokens stop working |
| `JWT_SECRET` changed | All tokens of all users become invalid (everyone signs in again) |
| Password changed or reset | **Not revoked.** Other sessions of that user stay valid until they expire. Deactivate and reactivate the user to cut off every session immediately |

### Passwords

| Rule | Value |
|---|---|
| Minimum length | 8 characters (maximum 200) |
| Composition | Must contain letters and digits |
| Hashing | bcrypt, cost 10 (older hashes with a higher cost are transparently re-hashed at the next login) |
| Change own password | Click your initials at the top right → **Change password** (`POST /auth/change-password`, needs the current password) |

The same rule applies when an administrator sets an initial password, when a user sets a password from a link and on the reset page ("8+ characters with letters and numbers").

Password links are one-time tokens; only their SHA-256 hash is stored:

| Link | Created by | Valid for |
|---|---|---|
| Self-service reset | **Forgot password?** on the sign-in page (`POST /auth/forgot-password`) | 30 minutes |
| Admin reset link | Administration → Users → key icon (`POST /admin/users/:id/reset-link`) | 24 hours |
| Set-your-password link for a new user | Administration → Users → **Invite user** without a password | 72 hours |

`POST /auth/forgot-password` always answers "If the account exists, a reset link has been sent." so that it cannot be used to discover accounts. Links are emailed when SMTP is configured (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`). Without SMTP the self-service link is written to the backend log (`[auth] SMTP not configured — password reset link for ...`), and admin-generated links are shown in the dialog for you to pass on. Treat backend logs as sensitive for that reason.

### Login lockout

| Rule | Value |
|---|---|
| Threshold | 10 consecutive failed passwords for the same account |
| Lock duration | 15 minutes |
| Response while locked | `423 ACCOUNT_LOCKED` "Account temporarily locked after repeated failed logins. Try again later." |
| Reset | A successful login, a password reset, a successful Google sign-in, or an administrator deactivating and reactivating the user |

Unknown e-mail addresses, inactive users and wrong passwords all receive the same `401` "Invalid email or password". Every failed attempt is audited (`auth.login`, result `FAILURE`, with the reason).

### Google sign-in (optional)

"Continue with Google" appears on the sign-in page only when the backend has `GOOGLE_CLIENT_ID` set (the page reads it from `GET /auth/config`).

1. In the Google Cloud console create an OAuth client of type *Web application* and add the Perfmon UI's origin (for example `https://perf-mon.vercel.app`) as an authorized JavaScript origin.
2. Set `GOOGLE_CLIENT_ID=<client id>` on the backend and restart it.
3. Make sure every person who should use Google sign-in already has a Perfmon user **with the same e-mail address** (Administration → Users → **Invite user**).

How it is verified (`POST /auth/google`): the backend sends the Google ID token to `https://oauth2.googleapis.com/tokeninfo` (outbound HTTPS required, 10 s timeout) and accepts it only if the audience equals `GOOGLE_CLIENT_ID`, the issuer is `accounts.google.com`, the e-mail is verified and the token is not expired. Google sign-in **never creates accounts**: an unknown or deactivated e-mail receives `403 NO_ACCOUNT` "There is no active Perfmon account for <email>. Ask an administrator to invite you." The **Keep me signed in** box applies to Google sign-in as well.

> The bundled nginx configuration of the Docker UI sets `script-src 'self'`, which blocks Google's sign-in script; the button then stays hidden. Extend the CSP (script, frame and connect sources for `accounts.google.com`) if you want Google sign-in behind that nginx. The Vercel configuration sets no CSP.

### Initial administrator

On first start with an empty user table, the backend creates the administrator `DEMO_ADMIN_EMAIL` (default `admin@perfmon.local`) with the password from `DEMO_ADMIN_PASSWORD`. If that variable is empty, no user is created and the log says so. `SHOW_DEMO_CREDENTIALS=true` prints these credentials on the sign-in page — keep it `false` for any shared deployment (it is `false` by default and in `render.yaml`).

## Authorization (RBAC)

Users receive permissions through roles; API keys receive permissions through scopes. A request that lacks a permission fails with `403 FORBIDDEN` "Missing permission: <PERMISSION>" and is recorded in the audit log as `access.denied`.

### Permissions

| Permission | Allows |
|---|---|
| `VIEW_PROJECT` | View projects, applications, environments and inventory |
| `MANAGE_PROJECT` | Create/edit/delete projects, applications, environments, servers, releases |
| `CREATE_TEST` | Create performance tests |
| `EDIT_TEST` | Edit performance tests and load profiles |
| `DELETE_TEST` | Delete performance tests |
| `EXECUTE_TEST` | Create, start, complete and abort test runs |
| `DELETE_RUN` | Delete test runs |
| `VIEW_RUN` | View test runs and metrics |
| `INGEST_METRICS` | Send metrics to the ingestion API |
| `UPLOAD_ARTIFACT` | Upload artifacts and HTML reports |
| `DELETE_ARTIFACT` | Delete artifacts |
| `CREATE_DASHBOARD` | Create dashboards |
| `EDIT_DASHBOARD` | Edit dashboards |
| `DELETE_DASHBOARD` | Delete dashboards |
| `CONFIGURE_ALERT` | Configure alert rules and notification channels |
| `CONFIGURE_SLA` | Configure SLA/SLO profiles |
| `VIEW_REPORT` | View reports |
| `EXPORT_REPORT` | Generate and export reports |
| `MANAGE_USERS` | Manage users and roles |
| `MANAGE_INTEGRATIONS` | Manage integrations |
| `MANAGE_API_KEYS` | Create, rotate and revoke API keys |
| `VIEW_AUDIT` | View the audit log |
| `MANAGE_SETTINGS` | Manage platform settings, retention and scoring |

### Roles and their permissions

`SUPER_ADMIN` and `ADMIN` have every permission. The other roles (PE = `PERFORMANCE_ENGINEER`, QA = `QA_ENGINEER`, DEV = `DEVELOPER`):

| Permission | PE | QA | DEV | SRE | ARCHITECT | MANAGER | VIEWER |
|---|---|---|---|---|---|---|---|
| `VIEW_PROJECT`, `VIEW_RUN`, `VIEW_REPORT` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `MANAGE_PROJECT` | ✓ | | | | | | |
| `CREATE_TEST`, `EDIT_TEST` | ✓ | ✓ | | | | | |
| `DELETE_TEST` | ✓ | | | | | | |
| `EXECUTE_TEST`, `INGEST_METRICS` | ✓ | ✓ | | | | | |
| `DELETE_RUN` | ✓ | | | | | | |
| `UPLOAD_ARTIFACT` | ✓ | ✓ | ✓ | | | | |
| `DELETE_ARTIFACT` | ✓ | | | | | | |
| `CREATE_DASHBOARD` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `EDIT_DASHBOARD` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `DELETE_DASHBOARD` | ✓ | | | | | | |
| `CONFIGURE_ALERT` | ✓ | | | ✓ | | | |
| `CONFIGURE_SLA` | ✓ | | | | ✓ | | |
| `EXPORT_REPORT` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `MANAGE_INTEGRATIONS` | | | | ✓ | | | |
| `MANAGE_API_KEYS` | ✓ | | | | | | |
| `MANAGE_USERS`, `VIEW_AUDIT`, `MANAGE_SETTINGS` | | | | | | | |

The live matrix is shown under Platform → Administration → **Roles & permissions** (`GET /api/v1/admin/roles`, `GET /api/v1/admin/permissions`). Roles are fixed in code; custom roles are not implemented.

### Guard rails for administrators

| Rule | Message |
|---|---|
| Only a `SUPER_ADMIN` can grant, revoke or deactivate `SUPER_ADMIN` accounts | "Only a SUPER_ADMIN can grant, revoke or deactivate SUPER_ADMIN accounts" |
| The last active `SUPER_ADMIN` cannot be demoted or deactivated | "This is the last active SUPER_ADMIN; assign another SUPER_ADMIN first" |
| You cannot deactivate yourself | "You cannot deactivate your own account" |
| You cannot remove your own user-management permission | "You cannot remove your own user-management permission" |

### Scoping

- **Organization.** Every query is limited to the caller's organization. Objects of another organization are reported as not found (`404`), not as forbidden.
- **Project-bound API keys.** A key created with a project only works for that project. Run, artifact and ingestion calls for other projects fail with `403` "API key is not authorized for this project" (`POST /runs` answers `400` with the same text). The run list is filtered to the key's project automatically.
- **Private dashboards.** Only the owner can modify a dashboard that is neither shared nor a system dashboard ("Only the owner can modify a private dashboard").

## API keys

Manage keys under Platform → Administration → **API keys** (`/admin/api-keys`, permission `MANAGE_API_KEYS`). Step-by-step instructions are in [Users, roles & API keys](00e-users-and-api-keys.md).

| Property | Value |
|---|---|
| Format | `pmk_<8 hex characters>_<32-character random secret>` (24 random bytes, base64url) |
| Storage | Only the SHA-256 hash of the full key and its prefix (`pmk_xxxxxxxx`) are stored; the secret is returned once, in the create or rotate response |
| Scopes | `ingest`, `read` (one or both) |
| Project binding | Optional; recommended for every CI or load-generator key |
| Expiry | Optional (UI presets 30, 90, 180 days, 1 year, custom date, or *Never (not recommended)*); `expiresAt` must be in the future |
| Rate limit | Optional per-key ingestion limit `rateLimitPerSec` (1 – 100,000); empty uses `INGEST_RATE_LIMIT_PER_SEC` |
| Status | `ACTIVE`, `EXPIRED` or `REVOKED`; **Last used** is updated at most once a minute |
| Rotate | Issues a new secret with the same name, scopes, project and rate limit (and the remaining expiry) and revokes the old key immediately |
| Revoke | Permanent; revoked and expired keys are rejected with `401` |

Scopes map to permissions as follows; an API key never has any other permission:

| Scope | Permissions |
|---|---|
| `ingest` | `VIEW_PROJECT`, `VIEW_RUN`, `EXECUTE_TEST`, `INGEST_METRICS`, `UPLOAD_ARTIFACT`, `CREATE_TEST` |
| `read` | `VIEW_PROJECT`, `VIEW_RUN`, `VIEW_REPORT`, `EXPORT_REPORT` |

Consequences: API keys cannot set baselines (`EDIT_TEST`), delete anything, manage users, integrations or settings, or read the audit log. Administrative automation needs a user session from `POST /auth/login`.

API endpoints (all require `MANAGE_API_KEYS`):

| Method and path | Purpose |
|---|---|
| `GET /api/v1/api-keys` | List keys (never returns secrets); `?includeRevoked=false`, `?projectId=` |
| `POST /api/v1/api-keys` | Create: `{"name","scopes":["ingest"],"projectId","expiresAt","rateLimitPerSec"}` → `201` with `secret` |
| `POST /api/v1/api-keys/:id/rotate` | Rotate; optional body `{"expiresAt": "..."}` → new key with `secret` |
| `DELETE /api/v1/api-keys/:id` | Revoke |

## Encryption of stored secrets

Secrets that Perfmon needs to use later (and therefore cannot hash) are encrypted with AES-256-GCM (`backend/src/lib/crypto.ts`):

| Detail | Value |
|---|---|
| Key | Derived from the `ENCRYPTION_KEY` environment variable with scrypt (fixed application salt), 256 bits |
| Format | base64(12-byte random IV, 16-byte authentication tag, ciphertext) per value |
| Encrypted data | Integration credentials (`integration_credentials.ciphertext`), notification channel secrets such as Slack/Teams webhook URLs or signing keys (`notification_channels.secret_ciphertext`), and sensitive performance-test data values (`test_data`, flagged as sensitive or with a key matching password/secret/token/api key/credential/private) |
| Returned by the API | Never. Integrations return only `credentialKeys` (the names), channels never return the secret, sensitive test data is shown as `••••••••` |

Related protections:

- Integration `config` must not contain secrets. Keys named `token`, `password`, `apiToken`, `apiKey`, `secret`, `pat` or `privateToken` in `config` are rejected: "Secrets must be sent in "credentials", not "config" (...)".
- Audit entries for integrations record which credential *names* changed, never values.

**Changing `ENCRYPTION_KEY`** makes every stored secret unreadable. There is no re-encryption tool. Integration credentials that cannot be decrypted are treated as missing (connection tests then fail with an authentication error); re-enter them under Platform → Integrations, and re-enter notification channel secrets under Analysis → Alerts (`/alerts`). Keep the key stable and back it up with the database.

## Isolation of uploaded HTML reports

JMeter HTML reports contain JavaScript. Perfmon never runs that code with the Perfmon UI's privileges:

| Layer | Behaviour |
|---|---|
| Separate origin | With `REPORT_CONTENT_ORIGIN` set (Docker default `http://localhost:8081`), extracted reports are served by a second listener on `REPORT_CONTENT_PORT` (default `8081`). With `REPORT_CONTENT_ORIGIN` empty (as in `render.yaml`) they are served by the API host under `/report-content/`, still sandboxed |
| Signed URLs | The viewer URL contains a token signed with HMAC-SHA256 (derived from `JWT_SECRET`) that names one report version and expires after **1 hour**. Expired or forged tokens get `403` "Report link expired or invalid. Reopen the report from Perfmon." |
| CSP sandbox | `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; frame-ancestors 'self' <PUBLIC_URL> <CORS_ORIGINS>; form-action 'none'`. Without `allow-same-origin` the report runs in an opaque origin, so its scripts cannot read Perfmon's storage (where the session token lives) or call the API as the user |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, max-age=300` |
| Path safety | Paths are normalized; traversal and unsafe storage keys are rejected ("Bad path") |

Upload-time checks (all artifacts):

| Check | Rule |
|---|---|
| Blocked extensions | `.exe .dll .so .dylib .bat .cmd .com .msi .scr .ps1 .vbs .jar .war .ear .apk .app .dmg .pif .cpl .hta .lnk .reg` — "Executable and script files are not accepted as artifacts" |
| Content sniffing | Windows PE and ELF executables are rejected regardless of name; each kind must match its content (for example a `JTL` must be text or gzip) |
| ZIP protection | Entry paths with `..`, absolute paths or drive letters are skipped (zip-slip), symbolic links are skipped, at most 50,000 entries, 4 GB uncompressed in total, 1 GB per entry, and entries over 10 MB with a compression ratio above 200 are rejected |
| Size | `MAX_UPLOAD_MB` (default 512, 50 in `render.yaml`); one file per request |
| Malware scan hook | Optional: when `MALWARE_SCAN_URL` is set, Perfmon POSTs `{"sha256","filename","size"}` (metadata only, not the file) and rejects the upload if the answer contains `"clean": false` ("File rejected by malware scanner"). If the scanner is unreachable the file is accepted with scan status `ERROR`; without the variable the status is `NOT_SCANNED` |
| Duplicates | SHA-256 of every file is stored; identical re-uploads are not stored twice |

Other served content:

- **Downloads** are always sent as `application/octet-stream` with `Content-Disposition: attachment`, so browsers never render them inline.
- **Screenshot previews** are sent with `Content-Security-Policy: default-src 'none'` and `nosniff`.
- **Generated reports** (Reports module) are rendered without scripts; the HTML preview and HTML export carry `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors *`.

## Rate limits and request limits

| Limit | Default | Scope | Response when exceeded |
|---|---|---|---|
| Global API limit | 1,200 requests per minute (`API_RATE_LIMIT_PER_MIN`) | Per credential: the `Authorization` header value, else `X-API-Key`, else client IP | `429 RATE_LIMITED` "Rate limit exceeded, retry in Ns" |
| `POST /auth/login` | 20 per minute | Per IP (or credential header) | `429` |
| `POST /auth/google` | 20 per minute | Per IP | `429` |
| `POST /auth/forgot-password` | 5 per minute | Per IP | `429` |
| `POST /auth/reset-password` | 10 per minute | Per IP | `429` |
| Ingestion token bucket (`ingest/rateLimit.ts`) | 100 requests per second, burst 200 (`INGEST_RATE_LIMIT_PER_SEC`; `0` disables it) | Per API key or user; per-key override `rateLimitPerSec` | `429 RATE_LIMITED` "Ingestion rate limit exceeded (N requests/sec). Batch more samples per request or raise the key's limit." |
| JSON request body | 10 MB | All JSON endpoints except ingestion | `413 PAYLOAD_TOO_LARGE` "Request or file exceeds the size limit" |
| Ingestion bodies | 50 MB (`/runs/:runId/metrics`, `/metrics`, `/ingest/influx/...`), 20 MB (`/ingest/infrastructure`) | Per request | `413` |
| Uploads | `MAX_UPLOAD_MB`, 1 file and 20 form fields per request | Per request | `413` "File exceeds the N MB upload limit" |

Notes:

- The ingestion endpoints under `/ingest/`, `POST /runs/:runId/metrics` and the report content are exempt from the global limit and use the token bucket instead. `POST /api/v1/metrics` is subject to both.
- Both limiters keep their counters in memory per backend instance; with several replicas each one counts separately.
- The backend trusts `X-Forwarded-For` (Fastify `trustProxy`), so the client IP used for IP-based limits and in audit entries comes from your reverse proxy. Do not expose the backend directly to the internet without a proxy that sets this header.

## Audit log

Platform → Administration → **Audit log** (`/admin/audit`, permission `VIEW_AUDIT`) lists security-relevant actions, newest first.

| Field | Content |
|---|---|
| Time | Server timestamp |
| User / API key | The user's e-mail, or the API key ID for calls made with a key |
| Action | For example `auth.login`, `api_key.rotate`, `artifact.upload`, `access.denied` |
| Resource | Resource type and ID |
| Result | `SUCCESS`, `FAILURE` or `DENIED` |
| Context | Client IP, user agent (first 300 characters), JSON details |

Recorded actions include:

| Area | Actions |
|---|---|
| Authentication | `auth.login`, `auth.login_google` (success and failure with reason), `auth.logout`, `auth.change_password`, `auth.forgot_password`, `auth.reset_password` |
| Users and keys | `user.create`, `user.update`, `user.activate`, `user.deactivate`, `user.reset_link`, `api_key.create`, `api_key.rotate`, `api_key.revoke` |
| Access control | `access.denied` — written automatically for every `403` response |
| Runs and artifacts | `run.create`, `run.start`, `run.complete`, `run.abort`, `run.cancel`, `run.update`, `run.delete`, `run.reanalyze`, `run.set_baseline`, `artifact.upload`, `artifact.upload_duplicate`, `artifact.download`, `artifact.delete`, `artifact.restore`, `artifact.reprocess` |
| Configuration | `settings.update`, `integration.*`, `notification_channel.*`, `alert_rule.*`, `sla.*`, `dashboard.*`, `project.*`, `test.*`, `report.create`, `report.delete` |
| Data lifecycle | `retention.purge_request`, `retention.purge_execute`, `retention.purge_cancel`, `audit.export`, `job.retry` |

Search and export:

- The UI filters by free text, action (wildcards such as `api_key.*`), resource type, user e-mail, result and time range, and offers **Export CSV**.
- API: `GET /api/v1/admin/audit?action=auth.*&result=FAILURE&from=2026-10-01&page=1&pageSize=50` (page size up to 500) and `GET /api/v1/admin/audit/export` (CSV, at most 100,000 rows; the export itself is audited).
- Audit writes never break the request they describe; a failed write is logged on the server.
- The log has no edit or delete endpoint. Old entries are removed only by a confirmed retention purge; the audit retention cannot be set below 30 days (default 365). See [Data Retention](38-data-retention.md).

## Secrets handling checklist

| Secret | Where it lives | Recommendation |
|---|---|---|
| `JWT_SECRET` | Backend environment | At least 16 characters (startup fails otherwise: "JWT_SECRET must be set (>= 16 chars)"). Use a long random value; `render.yaml` generates one. Changing it signs everyone out and invalidates report viewer links |
| `ENCRYPTION_KEY` | Backend environment | At least 16 characters (startup fails otherwise). Generate once, back it up, never change it casually (see above) |
| `DATABASE_URL`, `TIMESERIES_DB_URL` | Backend environment | Use TLS (`sslmode=require` for Neon) |
| `OBJECT_STORAGE_ACCESS_KEY` / `OBJECT_STORAGE_SECRET_KEY`, `AZURE_STORAGE_CONNECTION_STRING` | Backend environment | Least-privilege credentials for the one bucket/container |
| `SMTP_PASSWORD` | Backend environment | Application-specific password |
| `DEMO_ADMIN_PASSWORD` | Backend environment | Only used to create the first administrator; change that password after the first sign-in |
| API keys `pmk_...` | CI secret stores, JMeter command line | One key per pipeline or load-generator pool, scope `ingest`, bound to the project, with an expiry. Pass via `-Jperfmon.token` or environment variables, never commit them in `.jmx` files |
| Integration credentials | Perfmon database (encrypted) | Enter them in the `credentials` fields only; use read-only tokens on the remote system |

With Docker Compose, `JWT_SECRET` and `ENCRYPTION_KEY` default to development values starting with `change-me`; in production (`NODE_ENV=production`) the backend logs a warning if they are still in use. Override both before exposing the stack.

## Hosting notes

### Backend HTTP hardening (`app.ts`)

| Setting | Value |
|---|---|
| Helmet | Enabled with its default security headers; `contentSecurityPolicy` disabled for the JSON API (the UI sets its own CSP); `Cross-Origin-Resource-Policy: same-site` |
| CORS | Allowed origins from `CORS_ORIGINS` (comma-separated, default `http://localhost:5173,http://localhost:3000`); no credentials (cookies) — authentication uses headers; methods `GET HEAD POST PUT PATCH DELETE`; exposed headers `content-disposition`, `x-checksum-sha256` |
| TLS | The backend listens on plain HTTP (`PORT`, default 8080). Terminate HTTPS in front of it (Render, nginx, a load balancer) |
| Error responses | Uniform envelope `{timestamp, status, error, message, path, details?}`; unexpected errors return only "An unexpected error occurred" (details go to the server log) |

### Docker UI (nginx)

`infrastructure/docker/nginx.conf` adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin` and a CSP (`default-src 'self'; script-src 'self'; ... frame-src 'self' http://localhost:8081 https:; object-src 'none'`). If you publish the report-content origin under another name than `http://localhost:8081`, add it to `frame-src` and set `REPORT_CONTENT_ORIGIN` accordingly. The proxy allows uploads up to 600 MB (`client_max_body_size`).

### Render + Vercel (`render.yaml`, `vercel.json`)

| Item | Setting |
|---|---|
| Secrets | `JWT_SECRET` and `ENCRYPTION_KEY` use `generateValue: true`; `DATABASE_URL` and `DEMO_ADMIN_PASSWORD` are entered manually (`sync: false`) |
| Demo data | `SEED_DEMO_DATA=false`, `SHOW_DEMO_CREDENTIALS=false` |
| Origins | `PUBLIC_URL` and `CORS_ORIGINS` set to `https://perf-mon.vercel.app` — change both if your UI has another domain |
| Report content | `REPORT_CONTENT_ORIGIN=""`: reports are served by the API host under `/report-content/` and proxied by Vercel, still CSP-sandboxed |
| Uploads | `STORAGE_DRIVER=postgres`, `MAX_UPLOAD_MB=50` |
| UI headers (Vercel) | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`; no CSP is configured |
| Proxy | `vercel.json` rewrites `/api/*` and `/report-content/*` to the Render service |

### Public endpoints to consider

| Endpoint | Exposes | Consider |
|---|---|---|
| `/api/docs` | The OpenAPI description (no data) | Acceptable; block at the proxy if policy requires |
| `/metrics` | Perfmon's own Prometheus metrics (request rates, latencies, job counts) | Restrict at the proxy to your monitoring network |
| `/api/v1/health` | `{"status":"UP"}` | Needed for health checks and keep-alive |

### Hardening checklist

1. Set long random `JWT_SECRET` and `ENCRYPTION_KEY`; store them in a secret manager and back up `ENCRYPTION_KEY`.
2. Serve UI and API over HTTPS only; keep `CORS_ORIGINS` and `PUBLIC_URL` limited to your UI domain(s).
3. Keep `SHOW_DEMO_CREDENTIALS=false` and `SEED_DEMO_DATA=false` in shared environments; change the initial administrator password.
4. Give people the least-privileged role; reserve `SUPER_ADMIN`/`ADMIN` for platform owners.
5. Use project-bound `ingest` keys with an expiry for CI and JMeter; rotate them regularly and revoke unused ones (check **Last used**).
6. Configure SMTP so that reset links are not written to logs.
7. Restrict `/metrics` at the proxy; keep the backend behind a proxy that sets `X-Forwarded-For`.
8. Set `MALWARE_SCAN_URL` if your policy requires scanning uploads.
9. Review the audit log for `FAILURE` and `DENIED` results; export it before purging old entries.

## Related sections

- [Users, roles & API keys](00e-users-and-api-keys.md)
- [Run Perfmon 24/7 in the cloud](00f-deploy-24x7.md)
- [JMeter Integration](09-jmeter-integration.md)
- [Uploading HTML Reports](10-uploading-html-reports.md)
- [CI/CD Integration](30-ci-cd-integration.md)
- [Data Retention](38-data-retention.md)
- [Troubleshooting](39-troubleshooting.md)
