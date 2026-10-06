import type { FastifyInstance } from 'fastify';
import { one, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, conflict } from '../lib/errors.js';
import { typed, z, pageQuery, paged, orderBy } from '../lib/http.js';
import { enqueue } from '../jobs/queue.js';
import { resolveRun, invalidateRun } from '../ingest/runCache.js';
import { windowStats } from '../metrics/series.js';
import { config } from '../config.js';
import { createRun, startRun, completeRun, getSummary } from './service.js';
import { runDto, summaryDto, RUN_SELECT } from './dto.js';
import { resolveBaseline } from '../analytics/compare.js';
import { buildRunSummaryText } from '../reports/summaryText.js';

const STATUSES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED', 'CANCELLED', 'ANALYZING'] as const;

const createSchema = z.object({
  testId: z.string().uuid().optional(),
  project: z.string().optional(),
  application: z.string().optional(),
  environment: z.string().optional(),
  test: z.string().optional(),
  createTestIfMissing: z.boolean().optional(),
  testType: z.enum(['LOAD', 'STRESS', 'SPIKE', 'SOAK', 'ENDURANCE', 'VOLUME', 'CAPACITY', 'SCALABILITY', 'BASELINE']).optional(),
  runId: z.string().optional(),
  executionId: z.string().max(200).optional(),
  buildNumber: z.string().max(100).optional(),
  buildId: z.string().max(100).optional(),
  version: z.string().max(100).optional(),
  releaseVersion: z.string().max(100).optional(),
  branch: z.string().max(200).optional(),
  commit: z.string().max(100).optional(),
  tester: z.string().max(200).optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  description: z.string().max(5000).optional(),
  virtualUsers: z.number().int().min(0).optional(),
  targetTps: z.number().min(0).optional(),
  status: z.enum(['SCHEDULED', 'QUEUED', 'RUNNING']).optional(),
  scheduledAt: z.string().optional(),
  startedAt: z.string().optional(),
  triggeredBy: z.enum(['MANUAL', 'CI', 'API', 'SCHEDULE']).optional(),
  ciSystem: z.string().max(60).optional(),
  ciUrl: z.string().max(1000).optional(),
});

export async function runRoutes(app: FastifyInstance) {
  const r = typed(app);

  r.get('/runs', {
    preHandler: requirePermission('VIEW_RUN'),
    schema: {
      tags: ['Runs'], summary: 'List / filter test runs (server-side pagination)',
      querystring: z.object({
        ...pageQuery,
        projectId: z.string().uuid().optional(), applicationId: z.string().uuid().optional(), environmentId: z.string().uuid().optional(), testId: z.string().uuid().optional(),
        status: z.string().optional(), result: z.string().optional(), build: z.string().optional(), branch: z.string().optional(), commit: z.string().optional(),
        tester: z.string().optional(), release: z.string().optional(), version: z.string().optional(), tags: z.string().optional(),
        from: z.string().optional(), to: z.string().optional(), minDuration: z.coerce.number().optional(), maxDuration: z.coerce.number().optional(),
        baselineOnly: z.coerce.boolean().optional(),
      }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const params: unknown[] = [p.orgId];
    const conds = ['r.organization_id = $1', 'r.deleted_at IS NULL'];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (p.projectId) add('r.project_id = ?', p.projectId);
    if (q.projectId) add('r.project_id = ?', q.projectId);
    if (q.applicationId) add('r.application_id = ?', q.applicationId);
    if (q.environmentId) add('r.environment_id = ?', q.environmentId);
    if (q.testId) add('r.test_id = ?', q.testId);
    if (q.status) add('r.status = ANY(?)', q.status.split(',').map((s) => s.trim().toUpperCase()));
    if (q.result) add('r.result = ANY(?)', q.result.split(',').map((s) => s.trim().toUpperCase()));
    if (q.build) add('r.build_number ILIKE ?', `%${q.build}%`);
    if (q.branch) add('r.branch ILIKE ?', `%${q.branch}%`);
    if (q.commit) add('r.commit_sha ILIKE ?', `${q.commit}%`);
    if (q.tester) add('r.tester ILIKE ?', `%${q.tester}%`);
    if (q.release) add('rel.version ILIKE ?', `%${q.release}%`);
    if (q.version) add('r.version ILIKE ?', `%${q.version}%`);
    if (q.tags) add('r.tags && ?', q.tags.split(',').map((s) => s.trim()).filter(Boolean));
    if (q.from) add('COALESCE(r.started_at, r.created_at) >= ?', new Date(q.from));
    if (q.to) add('COALESCE(r.started_at, r.created_at) <= ?', new Date(q.to));
    if (q.minDuration != null) add('EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) >= ?', q.minDuration);
    if (q.maxDuration != null) add('EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) <= ?', q.maxDuration);
    if (q.baselineOnly) conds.push('r.is_baseline');
    if (q.q) add('(r.run_key ILIKE ? OR t.name ILIKE ? OR r.build_number ILIKE ? OR r.commit_sha ILIKE ? OR r.branch ILIKE ? OR ? = ANY(r.tags))', `%${q.q}%`);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const sort = orderBy(q.sort, q.order, {
      runId: 'r.run_key', test: 't.name', environment: 'e.name', build: 'r.build_number', start: 'COALESCE(r.started_at, r.created_at)', duration: 'duration_sec',
      users: 's.users_peak', tps: 's.tps_avg', avgRt: 's.avg_rt', p95: 's.p95', errorPct: 's.error_pct', status: 'r.status', score: 'r.performance_score', result: 'r.result',
    }, 'COALESCE(r.started_at, r.created_at)');
    const rows = await query(`${RUN_SELECT.replace('SELECT r.*,', 'SELECT count(*) OVER() AS __total, r.*,')} WHERE ${conds.join(' AND ')} ORDER BY ${sort} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const res = paged(rows, q.page, q.pageSize);
    // Running runs: compute live KPIs on the fly
    const items = await Promise.all(res.items.map(async (row: any) => {
      if (row.status === 'RUNNING' && row.total_samples == null) {
        const s = await windowStats(row.id).catch(() => null);
        if (s) Object.assign(row, { total_samples: s.totalSamples, tps_avg: s.tpsAvg, avg_rt: s.avgRt, p95: s.p95, p99: s.p99, error_pct: s.errorPct, users_peak: s.usersPeak, percentile_method: s.percentileMethod, summary_source: s.source });
      }
      return runDto(row);
    }));
    return { ...res, items };
  });

  r.post('/runs', {
    preHandler: requirePermission('EXECUTE_TEST'),
    schema: {
      tags: ['Runs'], summary: 'Create a test run and generate its Run ID',
      description: 'Identify the test by `testId` or by names (`project`, `application`, `environment`, `test`). Returns the Run ID and the ingestion endpoints to configure in JMeter/CI.',
      body: createSchema,
    },
  }, async (req, reply) => {
    const p = principalOf(req);
    const body = { ...req.body, buildNumber: req.body.buildNumber ?? req.body.buildId };
    const run = await createRun(p, body);
    await audit(req, { action: 'run.create', resourceType: 'run', resourceId: run.id, details: { runId: run.run_key, testId: run.test_id, build: run.build_number } });
    const base = `${config.publicUrl.replace(/\/$/, '')}/api/v1`;
    reply.code(201);
    return {
      id: run.id, runId: run.run_key, status: run.status,
      ingest: {
        metrics: `/api/v1/runs/${run.run_key}/metrics`,
        jmeterInfluxListenerUrl: `${base}/ingest/influx/write?runId=${run.run_key}`,
        artifacts: `/api/v1/runs/${run.run_key}/artifacts`,
        complete: `/api/v1/runs/${run.run_key}/complete`,
      },
      run: runDto(run),
    };
  });

  const idParam = z.object({ id: z.string() });

  r.get('/runs/:id', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Runs'], summary: 'Run overview (accepts UUID or Run ID)', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const row = await one(`${RUN_SELECT} WHERE r.id = $1`, [ref.id]);
    const { primary, sources } = await getSummary(ref.id, row.status);
    const cfg = row.test_configuration_id ? await one(`SELECT * FROM test_configurations WHERE id = $1`, [row.test_configuration_id]) : null;
    const baseline = await resolveBaseline(ref.id);
    const counts = await one(
      `SELECT (SELECT count(*) FROM artifacts WHERE run_id = $1 AND deleted_at IS NULL)::int artifacts,
              (SELECT count(*) FROM insights WHERE run_id = $1)::int insights,
              (SELECT count(*) FROM regressions WHERE run_id = $1 AND direction = 'REGRESSION')::int regressions,
              (SELECT count(*) FROM alerts WHERE run_id = $1)::int alerts,
              (SELECT count(*) FROM sla_results WHERE run_id = $1 AND status = 'FAIL')::int sla_failures,
              (SELECT count(*) FROM artifacts WHERE run_id = $1 AND kind = 'HTML_REPORT' AND deleted_at IS NULL)::int html_reports,
              (SELECT count(*) FROM background_jobs WHERE run_id = $1 AND status IN ('QUEUED','PROCESSING'))::int pending_jobs`, [ref.id]);
    return {
      ...runDto(row),
      summary: summaryDto(primary),
      summaries: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, summaryDto(v)])),
      configuration: cfg && { version: cfg.version, virtualUsers: cfg.virtual_users, rampUpSec: cfg.ramp_up_sec, rampDownSec: cfg.ramp_down_sec, durationSec: cfg.duration_sec, targetTps: cfg.target_tps, threadGroup: cfg.thread_group, thinkTimeMs: cfg.think_time_ms },
      baseline,
      resultBreakdown: row.result_breakdown,
      scoreBreakdown: row.score_breakdown,
      analysis: row.analysis,
      analyzedAt: row.analyzed_at,
      counts,
    };
  });

  r.patch('/runs/:id', {
    preHandler: requirePermission('EXECUTE_TEST'),
    schema: {
      tags: ['Runs'], summary: 'Update run metadata', params: idParam,
      body: z.object({ description: z.string().max(5000).nullable().optional(), tags: z.array(z.string().max(60)).max(30).optional(), buildNumber: z.string().nullable().optional(), version: z.string().nullable().optional(), branch: z.string().nullable().optional(), commit: z.string().nullable().optional(), tester: z.string().nullable().optional(), virtualUsers: z.number().int().nullable().optional(), targetTps: z.number().nullable().optional(), releaseId: z.string().uuid().nullable().optional(), baselineRunId: z.string().uuid().nullable().optional() }),
    },
  }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const b = req.body;
    const map: Record<string, string> = { description: 'description', tags: 'tags', buildNumber: 'build_number', version: 'version', branch: 'branch', commit: 'commit_sha', tester: 'tester', virtualUsers: 'virtual_users', targetTps: 'target_tps', releaseId: 'release_id', baselineRunId: 'baseline_run_id' };
    const sets: string[] = [];
    const params: unknown[] = [ref.id];
    for (const [k, col] of Object.entries(map)) if ((b as any)[k] !== undefined) { params.push((b as any)[k]); sets.push(`${col} = $${params.length}`); }
    if (!sets.length) throw badRequest('Nothing to update');
    await query(`UPDATE test_runs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await audit(req, { action: 'run.update', resourceType: 'run', resourceId: ref.id, details: b });
    return runDto(await one(`${RUN_SELECT} WHERE r.id = $1`, [ref.id]));
  });

  r.post('/runs/:id/start', { preHandler: requirePermission('EXECUTE_TEST'), schema: { tags: ['Runs'], summary: 'Mark a run as RUNNING', params: idParam } }, async (req) => {
    const run = await startRun(principalOf(req), req.params.id);
    await audit(req, { action: 'run.start', resourceType: 'run', resourceId: run.id, details: { runId: run.run_key } });
    return runDto(run);
  });

  r.post('/runs/:id/complete', {
    preHandler: requirePermission('EXECUTE_TEST'),
    schema: {
      tags: ['Runs'], summary: 'Complete a run and start the analysis workflow',
      description: 'Flushes buffered metrics, sets the end time, marks the run ANALYZING and queues: summary → SLA → regression → bottleneck → insights → score/result → final report. The run becomes COMPLETED (or the provided final status) when analysis finishes.',
      params: idParam,
      body: z.object({ status: z.enum(['COMPLETED', 'FAILED', 'ABORTED']).optional(), endedAt: z.string().optional(), reason: z.string().max(2000).optional() }).optional(),
    },
  }, async (req) => {
    const run = await completeRun(principalOf(req), req.params.id, req.body ?? {});
    await audit(req, { action: 'run.complete', resourceType: 'run', resourceId: run.id, details: { runId: run.run_key, status: req.body?.status ?? 'COMPLETED' } });
    return runDto(run);
  });

  r.post('/runs/:id/abort', { preHandler: requirePermission('EXECUTE_TEST'), schema: { tags: ['Runs'], summary: 'Abort a running test', params: idParam, body: z.object({ reason: z.string().max(2000).optional() }).optional() } }, async (req) => {
    const run = await completeRun(principalOf(req), req.params.id, { status: 'ABORTED', reason: req.body?.reason });
    await audit(req, { action: 'run.abort', resourceType: 'run', resourceId: run.id, details: { runId: run.run_key } });
    return runDto(run);
  });

  r.post('/runs/:id/cancel', { preHandler: requirePermission('EXECUTE_TEST'), schema: { tags: ['Runs'], summary: 'Cancel a scheduled/queued run', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req), true);
    if (!['SCHEDULED', 'QUEUED'].includes(ref.status)) throw conflict(`Only SCHEDULED or QUEUED runs can be cancelled (run is ${ref.status})`);
    await query(`UPDATE test_runs SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [ref.id]);
    invalidateRun(ref);
    await audit(req, { action: 'run.cancel', resourceType: 'run', resourceId: ref.id, details: { runId: ref.runKey } });
    return { ok: true };
  });

  r.post('/runs/:id/reanalyze', { preHandler: requirePermission('EXECUTE_TEST'), schema: { tags: ['Runs'], summary: 'Re-run SLA, regression, bottleneck and insight analysis', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const jobId = await enqueue('run.reanalyze', { runId: ref.id }, { runId: ref.id, priority: 2 });
    await audit(req, { action: 'run.reanalyze', resourceType: 'run', resourceId: ref.id });
    return { jobId };
  });

  r.post('/runs/:id/baseline', {
    preHandler: requirePermission('EDIT_TEST'),
    schema: { tags: ['Runs'], summary: 'Mark (or unmark) a run as the baseline of its test', params: idParam, body: z.object({ baseline: z.boolean().default(true) }).optional() },
  }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    const on = req.body?.baseline ?? true;
    if (on) {
      await query(`UPDATE test_runs SET is_baseline = false WHERE test_id = $1 AND is_baseline`, [ref.testId]);
      await query(`UPDATE test_runs SET is_baseline = true WHERE id = $1`, [ref.id]);
      await query(`UPDATE performance_tests SET baseline_run_id = $2, updated_at = now() WHERE id = $1`, [ref.testId, ref.id]);
    } else {
      await query(`UPDATE test_runs SET is_baseline = false WHERE id = $1`, [ref.id]);
      await query(`UPDATE performance_tests SET baseline_run_id = NULL WHERE id = $1 AND baseline_run_id = $2`, [ref.testId, ref.id]);
    }
    await audit(req, { action: on ? 'run.set_baseline' : 'run.unset_baseline', resourceType: 'run', resourceId: ref.id, details: { runId: ref.runKey } });
    return { ok: true, baseline: on };
  });

  r.delete('/runs/:id', {
    preHandler: requirePermission('DELETE_RUN'),
    schema: { tags: ['Runs'], summary: 'Soft-delete a run (requires ?confirm=true)', params: idParam, querystring: z.object({ confirm: z.coerce.boolean().default(false) }) },
  }, async (req) => {
    if (!req.query.confirm) throw badRequest('Deletion requires confirmation: repeat the request with ?confirm=true');
    const ref = await resolveRun(req.params.id, principalOf(req));
    await query(`UPDATE test_runs SET deleted_at = now() WHERE id = $1`, [ref.id]);
    await query(`UPDATE performance_tests SET baseline_run_id = NULL WHERE baseline_run_id = $1`, [ref.id]);
    invalidateRun(ref);
    await audit(req, { action: 'run.delete', resourceType: 'run', resourceId: ref.id, details: { runId: ref.runKey } });
    return { ok: true };
  });

  r.get('/runs/:id/summary-text', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Runs'], summary: 'Final run summary (plain text)', params: idParam } }, async (req, reply) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    return reply.type('text/plain; charset=utf-8').send(await buildRunSummaryText(ref.id));
  });

  r.get('/runs/:id/jobs', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Runs'], summary: 'Background jobs for a run', params: idParam } }, async (req) => {
    const ref = await resolveRun(req.params.id, principalOf(req));
    return query(`SELECT id, type, status, attempts, max_attempts, error, created_at, started_at, finished_at, result FROM background_jobs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 100`, [ref.id]);
  });
}
