# Run Perfmon 24/7 in the cloud (Render + Neon)

The Perfmon website (perf-mon.vercel.app) is only the user interface. The **backend API** and the **PostgreSQL database** must run somewhere that is always on. This chapter puts them on free cloud services so Perfmon no longer depends on anyone's laptop:

| Part | Service | Cost | Notes |
|---|---|---|---|
| Web UI | Vercel | free | Already deployed from GitHub on every push |
| Backend API | Render web service | free | Sleeps after ~15 min without traffic; the keep-alive job keeps it awake |
| Database | Neon PostgreSQL | free | 0.5 GB storage; suspends when idle and resumes in about a second |
| Keep-alive | GitHub Actions | free | `.github/workflows/keepalive.yml` pings the API every 10 minutes |

```text
 Browser ──► perf-mon.vercel.app ──/api/*──► perfmon-api.onrender.com ──► Neon PostgreSQL
                                                   ▲
 GitHub Actions (every 10 min) ── /api/v1/health ──┘   keeps the free service awake
```

If the API is asleep anyway, the website waits for it ("Waking up the Perfmon server…") and continues automatically — no error is shown unless it fails to start within 2½ minutes.

## 1. Create the database (Neon)

1. Go to <https://neon.tech> → **Sign up** (GitHub login is fine).
2. **Create project**: name `perfmon`, PostgreSQL 16, region close to your users (e.g. *AWS Asia Pacific (Singapore)*).
3. On the project dashboard open **Connect**, turn **Connection pooling off**, and copy the connection string. It looks like:

```text
postgresql://neondb_owner:XXXXXXXX@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Use the **direct** string (host without `-pooler`): Perfmon's job queue uses PostgreSQL `LISTEN/NOTIFY`, which a pooled connection does not support. Perfmon creates all tables itself on first start.

## 2. Create the backend (Render)

1. Go to <https://render.com> → **Sign up with GitHub** and allow access to the `PerfMon` repository.
2. **New → Blueprint** → select the `PerfMon` repository → Render reads `render.yaml`.
3. Fill in the two secret values it asks for:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `DEMO_ADMIN_PASSWORD` — the password for the first administrator (`admin@perfmon.local`), at least 8 characters with letters and digits
4. Click **Apply**. The first build takes 5–10 minutes. When the service shows **Live**, open `https://<service-name>.onrender.com/api/v1/health` — it should answer `{"status":"UP",...}`.

`render.yaml` configures everything else: free plan, Docker build, health check, generated `JWT_SECRET` and `ENCRYPTION_KEY`, uploads stored in PostgreSQL (`STORAGE_DRIVER=postgres`, max 50 MB per file), CORS for perf-mon.vercel.app.

## 3. Point the website at the backend

The UI forwards `/api/*` to the backend. Replace the backend address in **both** `vercel.json` and `frontend/vercel.json`:

```json
{ "source": "/api/:path*", "destination": "https://perfmon-api.onrender.com/api/:path*" },
{ "source": "/report-content/:path*", "destination": "https://perfmon-api.onrender.com/report-content/:path*" }
```

Commit and push — Vercel redeploys in about a minute. If Render named your service differently, use that URL, and also set it for the keep-alive job: GitHub → repository **Settings → Secrets and variables → Actions → Variables → New variable** `PERFMON_API_URL` = `https://<your-service>.onrender.com`.

## 4. Keep it awake

`.github/workflows/keepalive.yml` runs every 10 minutes on GitHub's free runners and calls `/api/v1/health`, so the free Render service does not go to sleep. Check it under the repository's **Actions** tab (run it once manually with **Run workflow**). GitHub pauses scheduled workflows in repositories with no activity for 60 days — any push re-enables it.

## 5. Move existing data (optional)

To copy projects, tests and runs from a local Perfmon (Docker) into Neon, stop the local backend and run on the machine with the local database:

```bash
docker exec -e TARGET='postgresql://neondb_owner:XXXX@ep-....aws.neon.tech/neondb?sslmode=require' \
  perfmon-dev-postgres-1 sh -c 'pg_dump -U perfmon -d perfmon --no-owner --no-privileges | psql "$TARGET"'
```

Do this **before** the Render service starts for the first time (or on an empty Neon database), then start/redeploy the Render service. Integration credentials were encrypted with the old `ENCRYPTION_KEY` and must be re-entered under Platform → Integrations; everyone signs in again.

## Limits of the free tiers and when to upgrade

| Limit | Effect | Upgrade |
|---|---|---|
| Render free: 512 MB RAM, sleeps when idle, 750 instance hours/month | Very large uploads or many concurrent live tests may be slow | Render *Starter* plan; switch `plan: starter` in `render.yaml` |
| Neon free: 0.5 GB storage | Metrics + uploaded artifacts fill it over time — set retention under Administration → Retention | Neon *Launch* plan, or S3/R2 for uploads (`STORAGE_DRIVER=s3`) |
| Upload size 50 MB | Bigger JTL files are rejected | Raise `MAX_UPLOAD_MB` after moving uploads to S3/R2 |
