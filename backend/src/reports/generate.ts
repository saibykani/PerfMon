import { one, query } from '../db/pool.js';
import { registerJob, enqueue } from '../jobs/queue.js';
import { buildTestExecutionContent, buildComparisonContent, buildExecutiveContent } from './content.js';

export const GENERATABLE_TYPES = ['TEST_EXECUTION', 'COMPARISON', 'EXECUTIVE'] as const;
export type ReportType = (typeof GENERATABLE_TYPES)[number];

export interface ReportParams {
  runIds?: string[];            // COMPARISON (ordered; first = reference)
  from?: string; to?: string;   // EXECUTIVE window (ISO)
  testId?: string | null; environmentId?: string | null;
  subjectKey?: string;          // versioning key (see 004 migration index)
  auto?: boolean;
}

const subjectKey = (type: ReportType, projectId: string, runId: string | null, p: ReportParams) =>
  type === 'TEST_EXECUTION' ? `run:${runId}` : type === 'COMPARISON' ? `runs:${(p.runIds ?? []).join(',')}` : `project:${projectId}|${p.testId ?? '*'}|${p.environmentId ?? '*'}`;

/**
 * Creates a QUEUED report row (version N+1 for the same type + subject) and enqueues generation.
 * Callers validate org / project scoping before calling.
 */
export async function createReport(input: { type: ReportType; projectId: string; runId?: string | null; title: string; params: ReportParams; createdBy?: string | null; priority?: number }) {
  const runId = input.type === 'TEST_EXECUTION' ? input.runId ?? null : null;
  const params: ReportParams = { ...input.params, subjectKey: subjectKey(input.type, input.projectId, runId, input.params) };
  const row = await one<{ id: string; version: number; status: string }>(
    `INSERT INTO reports (project_id, run_id, type, title, version, status, params, created_by)
     VALUES ($1, $2, $3, $4,
       (SELECT COALESCE(max(version), 0) + 1 FROM reports WHERE project_id = $1 AND type = $3 AND params->>'subjectKey' = $5),
       'QUEUED', $6, $7)
     RETURNING id, version, status`,
    [input.projectId, runId, input.type, input.title, params.subjectKey, JSON.stringify(params), input.createdBy ?? null]);
  await enqueue('report.generate', { reportId: row!.id }, { runId, priority: input.priority ?? 5, maxAttempts: 2 });
  return row!;
}

async function generate(reportId: string, attempts: number, maxAttempts: number) {
  const rep = await one(`SELECT rp.*, pr.organization_id FROM reports rp JOIN projects pr ON pr.id = rp.project_id WHERE rp.id = $1`, [reportId]);
  if (!rep) return { skipped: 'report deleted' };
  await query(`UPDATE reports SET status = 'GENERATING', error = NULL, updated_at = now() WHERE id = $1`, [reportId]);
  try {
    const p = (rep.params ?? {}) as ReportParams;
    let content;
    if (rep.type === 'TEST_EXECUTION') {
      if (!rep.run_id) throw new Error('Test execution report has no run');
      content = await buildTestExecutionContent(rep.run_id, rep.version, rep.title);
    } else if (rep.type === 'COMPARISON') {
      if (!p.runIds || p.runIds.length < 2) throw new Error('Comparison report needs at least two runs');
      content = await buildComparisonContent(p.runIds, rep.version, rep.title);
    } else if (rep.type === 'EXECUTIVE') {
      const to = p.to ? new Date(p.to) : new Date(rep.created_at);
      const from = p.from ? new Date(p.from) : new Date(to.getTime() - 30 * 86400000);
      content = await buildExecutiveContent({ orgId: rep.organization_id, projectId: rep.project_id, from, to, testId: p.testId, environmentId: p.environmentId }, rep.version, rep.title);
    } else {
      throw new Error(`Report type ${rep.type} cannot be generated yet`);
    }
    await query(`UPDATE reports SET status = 'READY', content = $2, error = NULL, updated_at = now() WHERE id = $1`, [reportId, JSON.stringify(content)]);
    return { reportId, status: 'READY', sections: content.sections.length };
  } catch (e) {
    const final = attempts >= maxAttempts;
    await query(`UPDATE reports SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [reportId, final ? 'FAILED' : 'QUEUED', (e as Error).message.slice(0, 1000)]);
    throw e; // let the queue retry (or record the failure)
  }
}

/**
 * report.generate payloads:
 *  - { reportId }                                   — row created by POST /reports
 *  - { type, runId, projectId, auto: true }         — automatic final report after run finalization / demo seed
 */
registerJob('report.generate', async (payload, job) => {
  if (payload.reportId) return generate(payload.reportId, job.attempts, 2);
  const type = String(payload.type ?? 'TEST_EXECUTION') as ReportType;
  if (type !== 'TEST_EXECUTION' || !payload.runId) throw new Error(`unsupported automatic report payload: ${JSON.stringify(payload)}`);
  const run = await one(`SELECT r.id, r.run_key, r.project_id FROM test_runs r WHERE r.id = $1 AND r.deleted_at IS NULL`, [payload.runId]);
  if (!run) return { skipped: 'run not found' };
  // Re-running this job (retry) must not create duplicate rows: reuse a row created by this job id.
  const existing = await one(`SELECT id FROM reports WHERE params->>'jobId' = $1`, [job.id]);
  let id = existing?.id as string | undefined;
  if (!id) {
    const params: ReportParams = { auto: true, subjectKey: `run:${run.id}` };
    const row = await one(
      `INSERT INTO reports (project_id, run_id, type, title, version, status, params)
       VALUES ($1, $2, 'TEST_EXECUTION', $3,
         (SELECT COALESCE(max(version), 0) + 1 FROM reports WHERE project_id = $1 AND type = 'TEST_EXECUTION' AND params->>'subjectKey' = $4), 'QUEUED', $5)
       RETURNING id`,
      [run.project_id, run.id, `Test Execution Report — ${run.run_key}`, params.subjectKey, JSON.stringify({ ...params, jobId: job.id })]);
    id = row!.id;
  }
  return generate(id!, job.attempts, 3);
});

/**
 * Rows whose generation job is gone (failed permanently, purged, or claimed by a worker without this handler)
 * would stay QUEUED forever: mark them FAILED so the UI stops polling and offers "Regenerate". Throttled.
 */
let lastSweep = 0;
export async function sweepStaleReports() {
  if (Date.now() - lastSweep < 30000) return;
  lastSweep = Date.now();
  await query(
    `UPDATE reports rp SET status = 'FAILED', error = COALESCE(rp.error, 'Generation did not complete (the job failed or was lost). Regenerate to try again.'), updated_at = now()
     WHERE rp.status IN ('QUEUED','GENERATING') AND rp.updated_at < now() - interval '2 minutes'
       AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.type = 'report.generate' AND j.status IN ('QUEUED','PROCESSING')
                         AND (j.payload->>'reportId' = rp.id::text OR (j.payload->>'reportId' IS NULL AND j.run_id = rp.run_id)))`).catch(() => undefined);
}
