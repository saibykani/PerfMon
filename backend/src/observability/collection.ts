import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, pool, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { typed, z } from '../lib/http.js';
import { connectorFor } from '../integrations/connectors/index.js';
import type { ImportQuery, RunWindow } from '../integrations/connectors/types.js';
import { loadCredentials, toRecord } from '../integrations/routes.js';
import { storeImportedSeries } from '../integrations/store.js';
import { SAMPLE_SEC, sampleOnce, samplerStatus, secondsSinceSample, setContinuous } from '../kubernetes/sampler.js';
import { selfMetrics } from '../selfmon/registry.js';
import { bucketStart } from './pure.js';

/**
 * Continuous collection: integration imports on a timer, independent of runs.
 *
 *  - INFLUXDB / PROMETHEUS / DYNATRACE: every `intervalSec` the connector's import (`importRun`, mappings or defaults)
 *    runs for the window [watermark, now − lag) cut at step boundaries; points are appended with
 *    storeImportedSeries(append) — windows never overlap (watermark = end of the last window), so nothing is
 *    duplicated. run_id = the RUNNING run of the schedule's environment, else NULL.
 *  - KUBERNETES: the pod/node sampler runs continuously for the connection (every SAMPLE_SEC).
 *
 * One scheduler per process (setInterval, unref). A schedule tick is executed by ONE instance: a session
 * advisory lock per schedule plus an atomic "due" claim (UPDATE … WHERE last_run_at <= now() − interval).
 * Memory is bounded: ≤ 3 schedules in flight per process and a catch-up window of ≤ 6 h per tick.
 */

export const METRIC_TYPES = ['INFLUXDB', 'PROMETHEUS', 'DYNATRACE'] as const;
export const COLLECTABLE_TYPES = [...METRIC_TYPES, 'KUBERNETES'] as const;
const LOCK_NS = 727301;
const TICK_MS = 5_000;
const RELOAD_MS = 15_000;
const MAX_IN_FLIGHT = 3;
const MAX_CATCHUP_MS = 6 * 3_600_000;

/** Import resolution and ingestion lag per source (seconds). Dynatrace's minimum resolution is 1 min. */
export function collectionStep(type: string) { return type === 'DYNATRACE' ? { stepSec: 60, lagSec: 120 } : { stepSec: 10, lagSec: 20 }; }

/** Next window [from, to) for a schedule: to = bucket boundary of (now − lag); from = watermark or to − interval; capped catch-up. */
export function nextWindow(nowMs: number, type: string, intervalSec: number, watermarkMs: number | null) {
  const { stepSec, lagSec } = collectionStep(type);
  const to = bucketStart(nowMs - lagSec * 1000, stepSec);
  let from = watermarkMs ?? to - intervalSec * 1000;
  if (to - from > MAX_CATCHUP_MS) from = bucketStart(to - MAX_CATCHUP_MS, stepSec);
  return { from, to, stepSec };
}

/** Deterministic per-schedule jitter (0 … min(10 s, 10 % of the interval)) so schedules don't fire together. */
export function jitterMs(id: string, intervalSec: number) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % Math.max(1, Math.min(10_000, intervalSec * 100));
}

let timer: NodeJS.Timeout | null = null;
let schedules: any[] = [];
let lastReload = 0;
const inFlight = new Set<string>();
let log: (m: string) => void = () => undefined;

async function reload() {
  lastReload = Date.now();
  schedules = await query(
    `SELECT c.*, i.type, i.status AS integration_status FROM observability_collection c JOIN integrations i ON i.id = c.integration_id
      WHERE c.enabled AND i.status = 'ENABLED'`);
  setContinuous(schedules.filter((s) => s.type === 'KUBERNETES').map((s) => s.integration_id));
}

function due(s: any, now: number) {
  if (inFlight.has(s.integration_id)) return false;
  const last = s.last_run_at ? new Date(s.last_run_at).getTime() : 0;
  if (s.type === 'KUBERNETES') return now - last >= SAMPLE_SEC * 1000 && secondsSinceSample(s.integration_id) >= SAMPLE_SEC;
  return now - last >= s.interval_sec * 1000 + jitterMs(s.integration_id, s.interval_sec);
}

async function tick() {
  try {
    if (Date.now() - lastReload > RELOAD_MS) await reload();
    const now = Date.now();
    for (const s of schedules) {
      if (inFlight.size >= MAX_IN_FLIGHT) break;
      if (due(s, now)) runSchedule(s.integration_id).catch((e) => log(`[obs-collection] ${s.integration_id}: ${(e as Error).message}`));
    }
  } catch (e) {
    log(`[obs-collection] ${(e as Error).message}`);
  }
}

/** Executes one schedule tick if this instance wins the lock and the schedule is still due. */
export async function runSchedule(integrationId: string, force = false) {
  if (inFlight.has(integrationId)) return { skipped: 'in flight' };
  inFlight.add(integrationId);
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [LOCK_NS, integrationId])).rows[0].ok;
    if (!locked) return { skipped: 'locked by another instance' };
    const claim = await client.query(
      `UPDATE observability_collection c SET last_run_at = now(), last_status = 'RUNNING', updated_at = now()
         FROM integrations i
        WHERE c.integration_id = $1 AND i.id = c.integration_id AND c.enabled AND i.status = 'ENABLED'
          AND ($2::boolean OR c.last_run_at IS NULL OR c.last_run_at <= now() - make_interval(secs => CASE WHEN i.type = 'KUBERNETES' THEN $3 ELSE c.interval_sec END * 0.9))
        RETURNING c.*, i.type`, [integrationId, force, SAMPLE_SEC]);
    const s = claim.rows[0];
    if (!s) return { skipped: 'not due' };
    // keep the in-memory copy in sync so `due` sees the new last_run_at before the next reload
    const mem = schedules.find((x) => x.integration_id === integrationId);
    if (mem) mem.last_run_at = s.last_run_at;
    let result: { status: string; points: number; error: string | null; watermark?: Date | null };
    try {
      result = s.type === 'KUBERNETES' ? await collectKubernetes(integrationId) : await collectMetrics(s);
    } catch (e) {
      result = { status: 'ERROR', points: 0, error: (e as Error).message.slice(0, 1000) };
    }
    await client.query(
      `UPDATE observability_collection SET last_status = $2, last_error = $3, points = $4::int, watermark = COALESCE($5::timestamptz, watermark),
              total_points = total_points + $4::int, updated_at = now() WHERE integration_id = $1`,
      [integrationId, result.status, result.error, result.points, result.watermark ?? null]);
    selfMetrics.inc('integration_imported_points', result.points);
    return result;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NS, integrationId]).catch(() => undefined);
    client.release();
    inFlight.delete(integrationId);
  }
}

async function collectKubernetes(id: string) {
  const pts = await sampleOnce(id);
  const st = samplerStatus(id);
  if (st.lastError) return { status: 'ERROR', points: pts, error: st.lastError };
  return { status: pts ? 'OK' : 'NO_DATA', points: pts, error: null };
}

async function collectMetrics(s: any) {
  const row = await one(`SELECT * FROM integrations WHERE id = $1`, [s.integration_id]);
  const connector = connectorFor(row.type);
  if (!connector?.importRun) throw new Error(`${row.type} integrations do not support metric import`);
  const queries: ImportQuery[] = Array.isArray(row.config?.mappings) && row.config.mappings.length ? row.config.mappings : connector.defaultQueries?.(toRecord(row)) ?? [];
  if (!queries.length) throw new Error('No mappings configured and the connector has no defaults');

  // where the data belongs: the schedule's environment (→ project/application), else the integration's project
  let projectId: string | null = row.project_id;
  let applicationId: string | null = null;
  let environmentId: string | null = s.environment_id ?? null;
  if (environmentId) {
    const env = await one(`SELECT project_id, application_id FROM environments WHERE id = $1`, [environmentId]);
    if (!env) throw new Error('The schedule\'s environment no longer exists');
    projectId = env.project_id; applicationId = env.application_id;
  }
  if (!projectId) throw new Error('Set an environment on the schedule or bind the integration to a project');
  const run = environmentId ? await one(`SELECT id, run_key FROM test_runs WHERE environment_id = $1 AND status = 'RUNNING' AND deleted_at IS NULL ORDER BY started_at DESC NULLS LAST LIMIT 1`, [environmentId]) : null;

  const w = nextWindow(Date.now(), row.type, s.interval_sec, s.watermark ? new Date(s.watermark).getTime() : null);
  if (w.to <= w.from) return { status: 'NO_DATA', points: 0, error: null };
  const from = new Date(w.from);
  const to = new Date(w.to);
  // connectors treat `to` as inclusive (InfluxQL time <=, Prometheus end) → ask up to to − 1 ms; storage keeps from ≤ t < to
  const win: RunWindow = { id: run?.id ?? '', runKey: run?.run_key ?? 'continuous', projectId, applicationId: applicationId ?? '', environmentId: environmentId ?? '', from, to: new Date(w.to - 1), stepSec: w.stepSec };
  const { series, warnings } = await connector.importRun(toRecord(row), await loadCredentials(row.id), win, queries);
  const stored = await storeImportedSeries({ ...win, id: run?.id ?? null, applicationId, environmentId, to }, row.type.toLowerCase(), series, { append: true });
  const all = [...warnings.filter((x) => !/no data for/.test(x)), ...stored.warnings];
  const failedAll = series.length === 0 && warnings.length >= queries.length && warnings.some((x) => !/no data for/.test(x));
  await query(`UPDATE integrations SET last_import_at = now(), health = CASE WHEN $2 THEN 'DOWN' ELSE 'HEALTHY' END, last_error = $3,
                 last_connected_at = CASE WHEN $2 THEN last_connected_at ELSE now() END, updated_at = now() WHERE id = $1`,
    [row.id, failedAll, failedAll ? all[0] ?? 'Import failed' : null]);
  if (failedAll) return { status: 'ERROR', points: 0, error: all[0] ?? 'Import failed', watermark: null };
  return { status: stored.imported ? 'OK' : 'NO_DATA', points: stored.imported, error: all.length ? all.slice(0, 3).join(' | ').slice(0, 1000) : null, watermark: to };
}

export function startCollectionScheduler(logger?: (m: string) => void) {
  if (timer || process.env.OBS_COLLECTION_DISABLED === 'true') return;
  if (logger) log = logger;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}
export function stopCollectionScheduler() { if (timer) clearInterval(timer); timer = null; }

/* ------------------------------------------------------------------ routes */

const dto = (r: any) => ({
  integrationId: r.integration_id, integrationName: r.integration_name, type: r.type, projectId: r.project_id ?? null,
  enabled: r.enabled, intervalSec: r.interval_sec, effectiveIntervalSec: r.type === 'KUBERNETES' ? SAMPLE_SEC : r.interval_sec,
  environmentId: r.environment_id ?? null, environmentName: r.environment_name ?? null,
  lastRunAt: r.last_run_at ?? null, lastStatus: r.last_status ?? null, lastError: r.last_error ?? null, points: r.points ?? 0, totalPoints: Number(r.total_points ?? 0),
  watermark: r.watermark ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

const LIST = `SELECT c.*, i.name AS integration_name, i.type, i.project_id, e.name AS environment_name
                FROM observability_collection c JOIN integrations i ON i.id = c.integration_id LEFT JOIN environments e ON e.id = c.environment_id`;

async function ownedIntegration(req: FastifyRequest, id: string) {
  const p = principalOf(req);
  const row = await one(`SELECT * FROM integrations WHERE id = $1 AND organization_id = $2`, [id, p.orgId]);
  if (!row || (p.projectId && row.project_id && row.project_id !== p.projectId)) throw notFound('Integration', id);
  return row;
}

export async function collectionRoutes(app: FastifyInstance) {
  const r = typed(app);
  const tags = ['Observability'];
  startCollectionScheduler((m) => app.log.warn(m));

  r.get('/observability/collection', { preHandler: requirePermission('VIEW_PROJECT'), schema: { tags, summary: 'Continuous collection schedules with last run status' } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(`${LIST} WHERE i.organization_id = $1 AND ($2::uuid IS NULL OR i.project_id = $2 OR i.project_id IS NULL) ORDER BY i.name`, [p.orgId, p.projectId ?? null]);
    return rows.map(dto);
  });

  r.post('/observability/collection', {
    preHandler: requirePermission('MANAGE_INTEGRATIONS'),
    schema: {
      tags, summary: 'Create or update the continuous collection schedule of an integration',
      body: z.object({ integrationId: z.string().uuid(), enabled: z.boolean().default(true), intervalSec: z.number().int().min(60).max(86400).default(60), environmentId: z.string().uuid().nullish() }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const b = req.body;
    const row = await ownedIntegration(req, b.integrationId);
    if (!(COLLECTABLE_TYPES as readonly string[]).includes(row.type)) throw badRequest(`Continuous collection supports ${COLLECTABLE_TYPES.join(', ')} integrations (got ${row.type})`);
    if (b.environmentId) {
      const env = await one(`SELECT e.id, e.project_id FROM environments e JOIN projects pr ON pr.id = e.project_id WHERE e.id = $1 AND pr.organization_id = $2`, [b.environmentId, p.orgId]);
      if (!env) throw badRequest('Environment not found');
      if (row.project_id && env.project_id !== row.project_id) throw badRequest('The environment belongs to a different project than the integration');
      if (p.projectId && env.project_id !== p.projectId) throw badRequest('API key is not authorized for this environment');
    } else if (row.type !== 'KUBERNETES' && !row.project_id && b.enabled) {
      throw badRequest('Choose an environment (environmentId) or bind the integration to a project so collected data has an owner');
    }
    await query(
      `INSERT INTO observability_collection (integration_id, organization_id, environment_id, enabled, interval_sec, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (integration_id) DO UPDATE SET environment_id = EXCLUDED.environment_id, enabled = EXCLUDED.enabled, interval_sec = EXCLUDED.interval_sec,
         last_error = CASE WHEN EXCLUDED.enabled THEN NULL ELSE observability_collection.last_error END,
         last_status = CASE WHEN EXCLUDED.enabled THEN observability_collection.last_status ELSE 'DISABLED' END, updated_at = now()`,
      [row.id, p.orgId, b.environmentId ?? null, b.enabled, b.intervalSec, p.kind === 'user' ? p.id : null]);
    lastReload = 0;   // pick up the change on the next tick
    await audit(req, { action: 'observability.collection.update', resourceType: 'integration', resourceId: row.id, details: { enabled: b.enabled, intervalSec: b.intervalSec, environmentId: b.environmentId ?? null } });
    return dto(await one(`${LIST} WHERE c.integration_id = $1`, [row.id]));
  });

  r.delete('/observability/collection/:integrationId', {
    preHandler: requirePermission('MANAGE_INTEGRATIONS'),
    schema: { tags, summary: 'Remove a collection schedule (collected data is kept)', params: z.object({ integrationId: z.string().uuid() }) },
  }, async (req) => {
    const row = await ownedIntegration(req, req.params.integrationId);
    await query(`DELETE FROM observability_collection WHERE integration_id = $1`, [row.id]);
    lastReload = 0;
    await audit(req, { action: 'observability.collection.delete', resourceType: 'integration', resourceId: row.id });
    return { ok: true };
  });
}
