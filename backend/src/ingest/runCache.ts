import { one, query } from '../db/pool.js';
import { notFound, conflict, forbidden } from '../lib/errors.js';
import type { Principal } from '../auth/principal.js';
import { publishRunEvent } from '../live/hub.js';

export interface RunRef {
  id: string;
  runKey: string;
  orgId: string;
  projectId: string;
  applicationId: string;
  environmentId: string;
  testId: string;
  status: string;
  startedAt: Date | null;
}

const cache = new Map<string, { at: number; ref: RunRef }>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a run by UUID or user-friendly Run ID (PF-YYYY-MM-DD-NNNNNN). */
export async function resolveRun(idOrKey: string, principal?: Principal, fresh = false): Promise<RunRef> {
  const key = idOrKey.trim();
  const c = cache.get(key);
  let ref: RunRef | undefined = !fresh && c && Date.now() - c.at < 10000 ? c.ref : undefined;
  if (!ref) {
    const row = await one(
      `SELECT id, run_key, organization_id, project_id, application_id, environment_id, test_id, status, started_at
       FROM test_runs WHERE ${UUID_RE.test(key) ? 'id = $1::uuid' : 'run_key = $1'} AND deleted_at IS NULL`, [key]);
    if (!row) throw notFound('Run', key);
    ref = { id: row.id, runKey: row.run_key, orgId: row.organization_id, projectId: row.project_id, applicationId: row.application_id, environmentId: row.environment_id, testId: row.test_id, status: row.status, startedAt: row.started_at };
    cache.set(ref.id, { at: Date.now(), ref });
    cache.set(ref.runKey, { at: Date.now(), ref });
  }
  if (principal) {
    if (principal.orgId !== ref.orgId) throw notFound('Run', key);
    if (principal.projectId && principal.projectId !== ref.projectId) throw forbidden('API key is not authorized for this project');
  }
  return ref;
}

export function invalidateRun(ref: { id: string; runKey: string }) {
  cache.delete(ref.id);
  cache.delete(ref.runKey);
}

const INGESTIBLE = new Set(['SCHEDULED', 'QUEUED', 'RUNNING']);

/** Ensure the run accepts live data; transitions SCHEDULED/QUEUED -> RUNNING on first data. */
export async function ensureIngestible(ref: RunRef, firstTs: Date, allowCompleted = false) {
  if (!INGESTIBLE.has(ref.status) && !allowCompleted) {
    throw conflict(`Run ${ref.runKey} is ${ref.status}; live metrics are only accepted for SCHEDULED, QUEUED or RUNNING runs`);
  }
  if (ref.status === 'SCHEDULED' || ref.status === 'QUEUED') {
    const updated = await query(
      `UPDATE test_runs SET status = 'RUNNING', started_at = COALESCE(started_at, $2), updated_at = now()
       WHERE id = $1 AND status IN ('SCHEDULED','QUEUED') RETURNING started_at`, [ref.id, firstTs]);
    if (updated.length) {
      await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, ts, title, source)
                   VALUES ($1,$2,$3,$4,'TEST_START',$5,$6,'ingestion')`,
        [ref.projectId, ref.applicationId, ref.environmentId, ref.id, updated[0].started_at, `Test started (${ref.runKey})`]);
      publishRunEvent(ref.id, 'status', { status: 'RUNNING' });
    }
    ref.status = 'RUNNING';
    ref.startedAt = ref.startedAt ?? firstTs;
    invalidateRun(ref);
  }
}
