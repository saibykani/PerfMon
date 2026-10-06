import type { PoolClient } from 'pg';
import { one, query, tx, pool, type Queryable } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { aggregator } from '../ingest/aggregator.js';
import { invalidateRun, resolveRun } from '../ingest/runCache.js';
import { publishRunEvent } from '../live/hub.js';
import { windowStats, runSource } from '../metrics/series.js';
import type { Principal } from '../auth/principal.js';

/** User-friendly Run ID: PF-YYYY-MM-DD-NNNNNN (global sequence, UTC date). */
export async function nextRunKey(db: Queryable = pool, at = new Date()) {
  const r = await one<{ n: number }>(`SELECT nextval('run_number_seq') AS n`, [], db);
  const d = at.toISOString().slice(0, 10);
  return `PF-${d}-${String(r!.n).padStart(6, '0')}`;
}

export interface CreateRunInput {
  testId?: string;
  project?: string;
  application?: string;
  environment?: string;
  test?: string;
  createTestIfMissing?: boolean;
  testType?: string;
  runId?: string;                // caller-supplied friendly run id (must be unique)
  executionId?: string;
  buildNumber?: string;
  version?: string;
  releaseVersion?: string;
  branch?: string;
  commit?: string;
  tester?: string;
  tags?: string[];
  description?: string;
  virtualUsers?: number;
  targetTps?: number;
  status?: 'SCHEDULED' | 'QUEUED' | 'RUNNING';
  scheduledAt?: string;
  startedAt?: string;
  triggeredBy?: 'MANUAL' | 'CI' | 'API' | 'SCHEDULE';
  ciSystem?: string;
  ciUrl?: string;
}

async function resolveTest(p: Principal, input: CreateRunInput, client: PoolClient) {
  if (input.testId) {
    const t = await one(`SELECT t.* FROM performance_tests t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND p.organization_id = $2`, [input.testId, p.orgId], client);
    if (!t) throw notFound('Performance test', input.testId);
    return t;
  }
  if (!input.project || !input.test) throw badRequest('Provide testId, or project + application + environment + test names');
  const proj = await one(`SELECT id FROM projects WHERE organization_id = $1 AND (key = $2 OR lower(name) = lower($2) OR id::text = $2)`, [p.orgId, input.project], client);
  if (!proj) throw notFound('Project', input.project);
  const params: unknown[] = [proj.id, input.test];
  let extra = '';
  if (input.application) { params.push(input.application); extra += ` AND (a.code = $${params.length} OR lower(a.name) = lower($${params.length}))`; }
  if (input.environment) { params.push(input.environment); extra += ` AND (lower(e.name) = lower($${params.length}) OR e.type = upper($${params.length}))`; }
  const t = await one(
    `SELECT t.* FROM performance_tests t JOIN applications a ON a.id = t.application_id JOIN environments e ON e.id = t.environment_id
     WHERE t.project_id = $1 AND lower(t.name) = lower($2) ${extra} AND t.archived_at IS NULL ORDER BY t.created_at LIMIT 1`, params, client);
  if (t) return t;
  if (!input.createTestIfMissing) throw notFound('Performance test', input.test);
  if (!input.application || !input.environment) throw badRequest('application and environment are required to auto-create a test');
  const app = await one(`SELECT id FROM applications WHERE project_id = $1 AND (code = $2 OR lower(name) = lower($2))`, [proj.id, input.application], client);
  if (!app) throw notFound('Application', input.application);
  const env = await one(`SELECT id FROM environments WHERE application_id = $1 AND (lower(name) = lower($2) OR type = upper($2)) ORDER BY created_at LIMIT 1`, [app.id, input.environment], client);
  if (!env) throw notFound('Environment', input.environment);
  return one(
    `INSERT INTO performance_tests (project_id, application_id, environment_id, name, test_type, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [proj.id, app.id, env.id, input.test, input.testType ?? 'LOAD', p.kind === 'user' ? p.id : null], client);
}

export async function createRun(p: Principal, input: CreateRunInput) {
  return tx(async (client) => {
    const test = await resolveTest(p, input, client);
    if (p.projectId && p.projectId !== test.project_id) throw badRequest('API key is not authorized for this project');
    const cfg = await one(`SELECT * FROM test_configurations WHERE test_id = $1 AND is_current ORDER BY version DESC LIMIT 1`, [test.id], client);

    let runKey = input.runId?.trim();
    if (runKey) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(runKey)) throw badRequest('runId may contain letters, digits, ".", "_" and "-" (3-64 chars)');
      if (await one(`SELECT 1 FROM test_runs WHERE run_key = $1`, [runKey], client)) throw conflict(`Run ID ${runKey} already exists`);
    } else runKey = await nextRunKey(client);

    // Build & release association (created on the fly for CI pipelines)
    let buildId: string | null = null;
    let releaseId: string | null = null;
    if (input.releaseVersion) {
      const rel = await one(
        `INSERT INTO releases (project_id, application_id, environment_id, name, version, build_number, branch, commit_sha)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7) ON CONFLICT (project_id, version) DO UPDATE SET version = EXCLUDED.version RETURNING id`,
        [test.project_id, test.application_id, test.environment_id, input.releaseVersion, input.buildNumber ?? null, input.branch ?? null, input.commit ?? null], client);
      releaseId = rel.id;
    }
    if (input.buildNumber) {
      const b = await one(
        `INSERT INTO builds (project_id, application_id, release_id, build_number, branch, commit_sha, ci_system, ci_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (project_id, build_number) DO UPDATE SET branch = COALESCE(EXCLUDED.branch, builds.branch), commit_sha = COALESCE(EXCLUDED.commit_sha, builds.commit_sha),
           release_id = COALESCE(EXCLUDED.release_id, builds.release_id) RETURNING id, release_id`,
        [test.project_id, test.application_id, releaseId, input.buildNumber, input.branch ?? null, input.commit ?? null, input.ciSystem ?? null, input.ciUrl ?? null], client);
      buildId = b.id;
      releaseId ??= b.release_id;
    }

    const status = input.status ?? 'QUEUED';
    const startedAt = status === 'RUNNING' ? (input.startedAt ? new Date(input.startedAt) : new Date()) : null;
    const run = await one(
      `INSERT INTO test_runs (run_key, execution_id, organization_id, project_id, application_id, environment_id, test_id, test_configuration_id,
         release_id, build_id, build_number, version, branch, commit_sha, status, tester, triggered_by, ci_system, ci_url, tags, virtual_users, target_tps,
         description, scheduled_at, started_at, baseline_run_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
      [runKey, input.executionId ?? null, p.orgId, test.project_id, test.application_id, test.environment_id, test.id, cfg?.id ?? null,
        releaseId, buildId, input.buildNumber ?? null, input.version ?? input.releaseVersion ?? null, input.branch ?? null, input.commit ?? null, status,
        input.tester ?? (p.kind === 'user' ? p.name : null), input.triggeredBy ?? (p.kind === 'api_key' ? 'API' : 'MANUAL'), input.ciSystem ?? null, input.ciUrl ?? null,
        input.tags ?? [], input.virtualUsers ?? cfg?.virtual_users ?? null, input.targetTps ?? cfg?.target_tps ?? null, input.description ?? null,
        input.scheduledAt ? new Date(input.scheduledAt) : null, startedAt, test.baseline_run_id ?? null, p.kind === 'user' ? p.id : null], client);
    if (status === 'RUNNING') {
      await client.query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, ts, title, source) VALUES ($1,$2,$3,$4,'TEST_START',$5,$6,'api')`,
        [run.project_id, run.application_id, run.environment_id, run.id, startedAt, `Test started (${runKey})`]);
    }
    return run;
  });
}

export async function startRun(p: Principal, idOrKey: string) {
  const ref = await resolveRun(idOrKey, p, true);
  if (!['SCHEDULED', 'QUEUED'].includes(ref.status)) throw conflict(`Run ${ref.runKey} is ${ref.status} and cannot be started`);
  const r = await one(`UPDATE test_runs SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [ref.id]);
  await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, ts, title, source) VALUES ($1,$2,$3,$4,'TEST_START',$5,$6,'api')`,
    [ref.projectId, ref.applicationId, ref.environmentId, ref.id, r.started_at, `Test started (${ref.runKey})`]);
  invalidateRun(ref);
  publishRunEvent(ref.id, 'status', { status: 'RUNNING' });
  return r;
}

/**
 * Run completion workflow:
 * flush buffered metrics -> set end time -> ANALYZING -> enqueue run.finalize
 * (summary, artifacts, HTML report, SLA, regression, bottlenecks, insights, score, final report) -> COMPLETED/FAILED/ABORTED
 */
export async function completeRun(p: Principal | null, idOrKey: string, opts: { status?: 'COMPLETED' | 'FAILED' | 'ABORTED' | 'CANCELLED'; endedAt?: string; reason?: string } = {}) {
  const ref = await resolveRun(idOrKey, p ?? undefined, true);
  const finalStatus = opts.status ?? 'COMPLETED';
  if (['COMPLETED', 'FAILED', 'ABORTED', 'CANCELLED'].includes(ref.status) && ref.status !== 'ANALYZING') {
    // idempotent: completing an already-finished run re-runs analysis only
    await enqueue('run.finalize', { runId: ref.id, finalStatus: ref.status }, { runId: ref.id, priority: 2 });
    return one(`SELECT * FROM test_runs WHERE id = $1`, [ref.id]);
  }
  await aggregator.flush(true, ref.id);
  const src = await runSource(ref.id);
  const last = src ? await one(`SELECT max(ts + make_interval(secs => interval_sec)) AS t, min(ts) AS f FROM run_metrics WHERE run_id = $1 AND source = $2`, [ref.id, src]) : null;
  const endedAt = opts.endedAt ? new Date(opts.endedAt) : last?.t ?? new Date();
  if (finalStatus === 'CANCELLED' && !src) {
    await query(`UPDATE test_runs SET status = 'CANCELLED', ended_at = $2, result_reason = $3, updated_at = now() WHERE id = $1`, [ref.id, endedAt, opts.reason ?? null]);
    invalidateRun(ref);
    publishRunEvent(ref.id, 'status', { status: 'CANCELLED' });
    return one(`SELECT * FROM test_runs WHERE id = $1`, [ref.id]);
  }
  await query(
    `UPDATE test_runs SET status = 'ANALYZING', ended_at = $2, started_at = COALESCE(started_at, $3, $2), result_reason = COALESCE($4, result_reason), updated_at = now() WHERE id = $1`,
    [ref.id, endedAt, last?.f ?? null, opts.reason ?? null]);
  await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, ts, title, source) VALUES ($1,$2,$3,$4,'TEST_END',$5,$6,$7,'api')`,
    [ref.projectId, ref.applicationId, ref.environmentId, ref.id, finalStatus === 'COMPLETED' ? 'INFO' : 'WARNING', endedAt, `Test ${finalStatus.toLowerCase()} (${ref.runKey})`]);
  invalidateRun(ref);
  publishRunEvent(ref.id, 'status', { status: 'ANALYZING' });
  await enqueue('run.finalize', { runId: ref.id, finalStatus }, { runId: ref.id, priority: 2 });
  return one(`SELECT * FROM test_runs WHERE id = $1`, [ref.id]);
}

/** Live summary for running runs; persisted summary for finished runs. */
export async function getSummary(runId: string, status: string) {
  const persisted = await query(`SELECT * FROM run_summary WHERE run_id = $1`, [runId]);
  const bySource = Object.fromEntries(persisted.map((s) => [s.source, s]));
  const primarySource = (await runSource(runId)) ?? null;
  let primary = primarySource ? bySource[primarySource] : null;
  if ((!primary || status === 'RUNNING') && primarySource) {
    const live = await windowStats(runId, { source: primarySource });
    if (live) primary = statsToSummaryRow(runId, live);
  }
  if (!primary && bySource.html_report) primary = bySource.html_report;
  return { primary, sources: bySource };
}

export function statsToSummaryRow(runId: string, s: any) {
  return {
    run_id: runId, source: s.source, computed_at: new Date(),
    total_samples: s.totalSamples, success_count: s.successCount, failure_count: s.failureCount, error_pct: s.errorPct,
    tps_avg: s.tpsAvg, tps_peak: s.tpsPeak, avg_rt: s.avgRt, min_rt: s.minRt, max_rt: s.maxRt, median_rt: s.medianRt,
    p50: s.p50, p75: s.p75, p90: s.p90, p95: s.p95, p99: s.p99, p999: s.p999, stddev_rt: s.stddevRt,
    users_avg: s.usersAvg, users_peak: s.usersPeak, bytes_sent: s.bytesSent, bytes_received: s.bytesReceived,
    sent_kb_sec: s.sentKbSec, received_kb_sec: s.receivedKbSec, duration_sec: s.durationSec, percentile_method: s.percentileMethod,
    sla_pass_pct: null, sla_violations: null, apdex: null, extra: {},
  };
}
