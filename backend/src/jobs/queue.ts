import { hostname } from 'node:os';
import { pool, query, one, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { selfMetrics } from '../selfmon/registry.js';

/**
 * Durable job queue on PostgreSQL (FOR UPDATE SKIP LOCKED + LISTEN/NOTIFY).
 * Used for: HTML report parsing, artifact processing, run finalization (SLA,
 * regression, bottleneck, insights), report generation, notifications, retention.
 * Multiple backend replicas can run workers safely.
 */
export type JobHandler = (payload: any, job: { id: string; runId: string | null; attempts: number }) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();
export const registerJob = (type: string, handler: JobHandler) => handlers.set(type, handler);

export async function enqueue(type: string, payload: Record<string, unknown> = {}, opts: { runId?: string | null; priority?: number; delayMs?: number; maxAttempts?: number } = {}, db: Queryable = pool) {
  const row = await one<{ id: string }>(
    `INSERT INTO background_jobs (type, payload, run_id, priority, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, $6) RETURNING id`,
    [type, JSON.stringify(payload), opts.runId ?? null, opts.priority ?? 5, String(opts.delayMs ?? 0), opts.maxAttempts ?? 3], db);
  await db.query(`NOTIFY perfmon_jobs`).catch(() => undefined);
  selfMetrics.inc('jobs_enqueued');
  return row!.id;
}

const workerId = `${hostname()}:${process.pid}`;
let running = 0;
let stopped = false;
let wake: (() => void) | null = null;

async function claim() {
  return one(
    `UPDATE background_jobs SET status = 'PROCESSING', locked_at = now(), locked_by = $1, started_at = COALESCE(started_at, now()), attempts = attempts + 1
     WHERE id = (SELECT id FROM background_jobs WHERE status = 'QUEUED' AND run_after <= now()
                 ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, type, payload, run_id, attempts, max_attempts`, [workerId]);
}

async function execute(job: any) {
  const handler = handlers.get(job.type);
  const t0 = performance.now();
  try {
    if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);
    const result = await handler(job.payload, { id: job.id, runId: job.run_id, attempts: job.attempts });
    await query(`UPDATE background_jobs SET status = 'COMPLETED', result = $2, finished_at = now(), locked_at = NULL, error = NULL WHERE id = $1`, [job.id, JSON.stringify(result ?? null)]);
    selfMetrics.inc('jobs_completed');
  } catch (e) {
    const msg = (e as Error).stack || String(e);
    const retry = job.attempts < job.max_attempts;
    await query(
      `UPDATE background_jobs SET status = $2, error = $3, locked_at = NULL,
         run_after = now() + ($4 || ' seconds')::interval, finished_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END WHERE id = $1`,
      [job.id, retry ? 'QUEUED' : 'FAILED', msg.slice(0, 4000), String(Math.min(300, 5 * 2 ** job.attempts))]);
    selfMetrics.inc(retry ? 'jobs_retried' : 'jobs_failed');
    console.error(`[jobs] ${job.type} ${job.id} failed (attempt ${job.attempts}/${job.max_attempts}):`, (e as Error).message);
  } finally {
    selfMetrics.observe('job_duration_ms', performance.now() - t0);
  }
}

async function loop() {
  while (!stopped) {
    while (running < config.workerConcurrency) {
      let job;
      try { job = await claim(); } catch (e) { console.error('[jobs] claim failed', (e as Error).message); break; }
      if (!job) break;
      running++;
      execute(job).finally(() => { running--; wake?.(); });
    }
    await new Promise<void>((res) => { wake = res; setTimeout(res, 2000); });
    wake = null;
  }
}

export async function startWorker() {
  // Recover jobs whose worker died mid-flight.
  await query(`UPDATE background_jobs SET status = 'QUEUED', locked_at = NULL WHERE status = 'PROCESSING' AND locked_at < now() - interval '15 minutes'`);
  const listener = await pool.connect();
  await listener.query('LISTEN perfmon_jobs');
  listener.on('notification', () => wake?.());
  listener.on('error', (e) => console.error('[jobs] listener error', e.message));
  setInterval(async () => {
    try {
      const r = await one(`SELECT count(*) FILTER (WHERE status='QUEUED') AS queued, count(*) FILTER (WHERE status='PROCESSING') AS processing FROM background_jobs WHERE status IN ('QUEUED','PROCESSING')`);
      selfMetrics.set('jobs_queued', Number(r?.queued ?? 0));
      selfMetrics.set('jobs_processing', Number(r?.processing ?? 0));
      await query(`UPDATE background_jobs SET status = 'QUEUED', locked_at = NULL WHERE status = 'PROCESSING' AND locked_at < now() - interval '15 minutes'`);
    } catch { /* ignore */ }
  }, 10000).unref();
  loop();
  return () => { stopped = true; listener.release(); };
}

export async function waitForJobs(runId: string, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await one(`SELECT count(*)::int AS n FROM background_jobs WHERE run_id = $1 AND status IN ('QUEUED','PROCESSING')`, [runId]);
    if (!r || r.n === 0) return true;
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}
