import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { typed, z, idParams, assertProject } from '../lib/http.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { enqueue } from '../jobs/queue.js';
import { resolveRun, type RunRef } from '../ingest/runCache.js';
import { insertGeneric, ingestLinePoints } from '../ingest/routes.js';
import { aggregator, deleteRunMetrics } from '../ingest/aggregator.js';
import { completeRun } from '../runs/service.js';
import { fetchJmeterPoints, inferIntervalSec } from './jmeterInflux.js';
import { selfMetrics } from '../selfmon/registry.js';
import { allConnectors, connectorFor } from './connectors/index.js';
import type { Credentials, ImportQuery, IntegrationRecord, RunWindow } from './connectors/types.js';
import { OTLP_RUN_ATTRIBUTES } from './connectors/opentelemetry.js';
import { storeImportedSeries } from './store.js';

const TYPES = ['JMETER', 'INFLUXDB', 'PROMETHEUS', 'GRAFANA', 'DYNATRACE', 'OPENTELEMETRY', 'JENKINS', 'GITHUB_ACTIONS', 'GITLAB', 'AZURE_DEVOPS'] as const;
const AUTH = ['NONE', 'TOKEN', 'BASIC', 'API_KEY'] as const;

const querySchema = z.object({
  metric: z.string().min(1).max(120),
  query: z.string().min(1).max(5000),
  target: z.enum(['server', 'jvm', 'database', 'service', 'custom']),
  serverName: z.string().max(200).optional(),
  serviceName: z.string().max(200).optional(),
  scale: z.number().optional(),
  transform: z.enum(['invert_pct']).optional(),
  role: z.string().max(60).optional(),
});

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(TYPES),
  url: z.string().max(2000).nullish(),
  authType: z.enum(AUTH).default('NONE'),
  config: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), z.string().max(8000).nullable()).optional(),
  projectId: z.string().uuid().nullish(),
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
});

/** Config must never carry secrets: reject well-known secret keys sent in `config`. */
const SECRET_KEY = /^(token|password|apiToken|apiKey|secret|pat|privateToken)$/i;

function validateConfig(type: string, url: string | null | undefined, cfg: Record<string, unknown>) {
  const leaked = Object.keys(cfg).filter((k) => SECRET_KEY.test(k));
  if (leaked.length) throw badRequest(`Secrets must be sent in "credentials", not "config" (${leaked.join(', ')})`);
  if (url && !/^https?:\/\//i.test(url)) throw badRequest('url must start with http:// or https://');
  if (cfg.mappings !== undefined) {
    const parsed = z.array(querySchema).max(200).safeParse(cfg.mappings);
    if (!parsed.success) throw badRequest('config.mappings must be an array of { metric, query, target, serverName?, serviceName?, scale?, transform? }', parsed.error.issues);
  }
  if (type === 'INFLUXDB' && cfg.version && !['v1', 'v2'].includes(String(cfg.version))) throw badRequest('config.version must be v1 or v2');
}

const dto = (r: any, credentialKeys: string[] = []) => ({
  id: r.id, name: r.name, type: r.type, url: r.url, authType: r.auth_type, config: r.config ?? {}, status: r.status, health: r.health,
  lastConnectedAt: r.last_connected_at, lastError: r.last_error, lastImportAt: r.last_import_at ?? null, hasCredentials: credentialKeys.length > 0, credentialKeys,
  projectId: r.project_id, projectName: r.project_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function owned(req: FastifyRequest, id: string) {
  const p = principalOf(req);
  const row = await one(`SELECT i.*, pr.name AS project_name FROM integrations i LEFT JOIN projects pr ON pr.id = i.project_id WHERE i.id = $1 AND i.organization_id = $2`, [id, p.orgId]);
  if (!row || (p.projectId && row.project_id && row.project_id !== p.projectId)) throw notFound('Integration', id);
  return row;
}

const credentialKeys = async (id: string) => (await query(`SELECT name FROM integration_credentials WHERE integration_id = $1 ORDER BY name`, [id])).map((r) => r.name as string);

async function loadCredentials(id: string): Promise<Credentials> {
  const rows = await query(`SELECT name, ciphertext FROM integration_credentials WHERE integration_id = $1`, [id]);
  const out: Credentials = {};
  for (const r of rows) {
    try { out[r.name] = decryptSecret(r.ciphertext); } catch { /* key rotated / corrupt: treat as missing */ }
  }
  return out;
}

/** Upsert provided credentials; null/'' removes a credential. Values are encrypted (AES-256-GCM). */
async function saveCredentials(id: string, creds: Record<string, string | null> | undefined) {
  if (!creds) return;
  for (const [name, value] of Object.entries(creds)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,59}$/.test(name)) throw badRequest(`Invalid credential name '${name}'`);
    if (value == null || value === '') await query(`DELETE FROM integration_credentials WHERE integration_id = $1 AND name = $2`, [id, name]);
    else await query(
      `INSERT INTO integration_credentials (integration_id, name, ciphertext) VALUES ($1,$2,$3)
       ON CONFLICT (integration_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, created_at = now()`, [id, name, encryptSecret(value)]);
  }
}

const toRecord = (r: any): IntegrationRecord => ({ id: r.id, organizationId: r.organization_id, projectId: r.project_id, name: r.name, type: r.type, url: r.url, authType: r.auth_type, config: r.config ?? {} });

/** Run window for imports: started_at → ended_at (or now while running), step ≤ 600 points. */
async function runWindow(ref: RunRef): Promise<RunWindow> {
  const r = await one(`SELECT started_at, ended_at, created_at FROM test_runs WHERE id = $1`, [ref.id]);
  if (!r.started_at) throw badRequest(`Run ${ref.runKey} has not started yet — nothing to import`);
  const from = new Date(r.started_at);
  const to = r.ended_at ? new Date(r.ended_at) : new Date();
  const span = Math.max(1, (to.getTime() - from.getTime()) / 1000);
  const stepSec = [5, 10, 15, 30, 60, 120, 300, 600].find((s) => span / s <= 600) ?? 900;
  return { id: ref.id, runKey: ref.runKey, projectId: ref.projectId, applicationId: ref.applicationId, environmentId: ref.environmentId, from, to, stepSec };
}

// ---------------------------------------------------------------- OTLP/HTTP JSON
type OtlpAttr = { key: string; value?: Record<string, any> };
export function otlpAttrValue(v: Record<string, any> | undefined): string | null {
  if (!v) return null;
  if (v.stringValue != null) return String(v.stringValue);
  if (v.intValue != null) return String(v.intValue);
  if (v.doubleValue != null) return String(v.doubleValue);
  if (v.boolValue != null) return String(v.boolValue);
  if (v.arrayValue) return JSON.stringify((v.arrayValue.values ?? []).map(otlpAttrValue));
  return null;
}
export const otlpAttrs = (list: OtlpAttr[] | undefined) => {
  const out: Record<string, string> = {};
  for (const a of list ?? []) { const v = otlpAttrValue(a.value); if (a.key && v != null) out[a.key] = v; }
  return out;
};
const nanoToMs = (n: unknown) => {
  if (n == null) return Date.now();
  const s = String(n);
  return s.length > 13 ? Number(BigInt(s) / 1000000n) : Number(s);
};
const dpValue = (dp: any): number | null => {
  const v = dp.asDouble ?? dp.asInt;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface OtlpPoint { runKey: string | null; ts: number; metric: string; value: number; tags: Record<string, string> }

/** Flattens an OTLP ExportMetricsServiceRequest (JSON) into Perfmon metric points. */
export function flattenOtlp(body: any, defaultRunKey?: string | null): { points: OtlpPoint[]; skipped: number } {
  const points: OtlpPoint[] = [];
  let skipped = 0;
  const runOf = (tags: Record<string, string>) => {
    for (const k of OTLP_RUN_ATTRIBUTES) if (tags[k]) return tags[k];
    return defaultRunKey ?? null;
  };
  for (const rm of body?.resourceMetrics ?? []) {
    const resTags = otlpAttrs(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? rm.instrumentationLibraryMetrics ?? []) {
      const scope = sm.scope?.name ?? sm.instrumentationLibrary?.name;
      for (const m of sm.metrics ?? []) {
        const base: Record<string, string> = { ...resTags, ...(scope ? { 'otel.scope': scope } : {}), ...(m.unit ? { unit: m.unit } : {}) };
        const emit = (dp: any, metric: string, value: number | null, extra: Record<string, string> = {}) => {
          if (value == null) { skipped++; return; }
          const tags = { ...base, ...otlpAttrs(dp.attributes), ...extra };
          points.push({ runKey: runOf(tags), ts: nanoToMs(dp.timeUnixNano ?? dp.startTimeUnixNano), metric, value, tags });
        };
        if (m.gauge) for (const dp of m.gauge.dataPoints ?? []) emit(dp, m.name, dpValue(dp));
        else if (m.sum) {
          const temporality = m.sum.aggregationTemporality === 1 || m.sum.aggregationTemporality === 'AGGREGATION_TEMPORALITY_DELTA' ? 'delta' : 'cumulative';
          for (const dp of m.sum.dataPoints ?? []) emit(dp, m.name, dpValue(dp), { temporality, monotonic: String(!!m.sum.isMonotonic) });
        } else if (m.histogram) {
          for (const dp of m.histogram.dataPoints ?? []) {
            const count = Number(dp.count ?? 0);
            const sum = dp.sum != null ? Number(dp.sum) : null;
            emit(dp, `${m.name}.count`, count);
            if (sum != null) emit(dp, `${m.name}.sum`, sum);
            if (sum != null && count > 0) emit(dp, `${m.name}.avg`, sum / count);
          }
        } else skipped += (m.summary?.dataPoints?.length ?? m.exponentialHistogram?.dataPoints?.length ?? 1);
      }
    }
  }
  return { points, skipped };
}

export async function integrationRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };
  const manage = { preHandler: requirePermission('MANAGE_INTEGRATIONS') };

  r.get('/integrations/types', { ...view, schema: { tags: ['Integrations'], summary: 'Supported integration types (fields, auth types, import support, docs)' } }, async () =>
    allConnectors().map((c) => ({ type: c.type, label: c.label, category: c.category, authTypes: c.authTypes, fields: c.fields, supportsImport: c.supportsImport, docs: c.docs, defaultMappings: c.defaultQueries?.({} as any) ?? [] })));

  r.get('/integrations', { ...view, schema: { tags: ['Integrations'], summary: 'Configured integrations (secrets are never returned)', querystring: z.object({ projectId: z.string().uuid().optional(), type: z.string().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(
      `SELECT i.*, pr.name AS project_name, (SELECT array_agg(name ORDER BY name) FROM integration_credentials c WHERE c.integration_id = i.id) AS cred_keys
       FROM integrations i LEFT JOIN projects pr ON pr.id = i.project_id
       WHERE i.organization_id = $1 AND ($2::uuid IS NULL OR i.project_id = $2 OR i.project_id IS NULL) AND ($3::text IS NULL OR i.type = $3) ORDER BY i.name`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null, req.query.type ?? null]);
    return rows.map((row) => dto(row, row.cred_keys ?? []));
  });

  r.get('/integrations/:id', { ...view, schema: { tags: ['Integrations'], summary: 'Integration detail', params: idParams } }, async (req) => {
    const row = await owned(req, req.params.id);
    return dto(row, await credentialKeys(row.id));
  });

  r.post('/integrations', { ...manage, schema: { tags: ['Integrations'], summary: 'Create integration (credentials are encrypted at rest and never returned)', body: bodySchema } }, async (req, reply) => {
    const p = principalOf(req);
    const b = req.body;
    if (!connectorFor(b.type)) throw badRequest(`Unsupported integration type ${b.type}`);
    if (b.projectId) await assertProject(req, b.projectId);
    validateConfig(b.type, b.url, b.config);
    const row = await one(
      `INSERT INTO integrations (organization_id, project_id, name, type, url, auth_type, config, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [p.orgId, b.projectId ?? null, b.name, b.type, b.url?.trim() || null, b.authType, JSON.stringify(b.config), b.status ?? 'ENABLED', p.kind === 'user' ? p.id : null]);
    await saveCredentials(row.id, b.credentials);
    await audit(req, { action: 'integration.create', resourceType: 'integration', resourceId: row.id, details: { name: b.name, type: b.type, url: b.url ?? null, credentialKeys: Object.keys(b.credentials ?? {}) } });
    reply.code(201);
    return dto(row, await credentialKeys(row.id));
  });

  r.patch('/integrations/:id', { ...manage, schema: { tags: ['Integrations'], summary: 'Update integration (credentials: provided keys replaced, null removes)', params: idParams, body: bodySchema.omit({ type: true }).partial() } }, async (req) => {
    const before = await owned(req, req.params.id);
    const b = req.body;
    if (b.projectId) await assertProject(req, b.projectId);
    validateConfig(before.type, b.url, b.config ?? {});
    const row = await one(
      `UPDATE integrations SET name = COALESCE($2, name), url = CASE WHEN $3::boolean THEN $4 ELSE url END, auth_type = COALESCE($5, auth_type),
         config = COALESCE($6::jsonb, config), status = COALESCE($7, status), project_id = CASE WHEN $8::boolean THEN $9::uuid ELSE project_id END,
         health = CASE WHEN $3::boolean OR $5 IS NOT NULL OR $10::boolean THEN 'UNKNOWN' ELSE health END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [before.id, b.name ?? null, b.url !== undefined, b.url?.trim() || null, b.authType ?? null, b.config ? JSON.stringify(b.config) : null, b.status ?? null,
        b.projectId !== undefined, b.projectId ?? null, b.credentials !== undefined]);
    await saveCredentials(before.id, b.credentials);
    await audit(req, { action: 'integration.update', resourceType: 'integration', resourceId: before.id, details: { fields: Object.keys(b).filter((k) => k !== 'credentials'), credentialKeysChanged: Object.keys(b.credentials ?? {}) } });
    return dto({ ...row, project_name: before.project_name }, await credentialKeys(before.id));
  });

  r.delete('/integrations/:id', { ...manage, schema: { tags: ['Integrations'], summary: 'Delete integration and its stored credentials (imported metrics are kept)', params: idParams } }, async (req) => {
    const row = await owned(req, req.params.id);
    await query(`DELETE FROM integrations WHERE id = $1`, [row.id]);
    await audit(req, { action: 'integration.delete', resourceType: 'integration', resourceId: row.id, details: { name: row.name, type: row.type } });
    return { ok: true };
  });

  r.post('/integrations/:id/test', { ...manage, schema: { tags: ['Integrations'], summary: 'Test the connection (≤10s timeout; updates health)', params: idParams } }, async (req) => {
    const row = await owned(req, req.params.id);
    const connector = connectorFor(row.type);
    if (!connector) throw badRequest(`Unsupported integration type ${row.type}`);
    const result = await connector.test(toRecord(row), await loadCredentials(row.id));
    const health = !result.ok ? 'DOWN' : result.latencyMs > 3000 ? 'DEGRADED' : 'HEALTHY';
    await query(`UPDATE integrations SET health = $2, last_error = $3, last_connected_at = CASE WHEN $4 THEN now() ELSE last_connected_at END, updated_at = now() WHERE id = $1`,
      [row.id, health, result.ok ? null : result.message, result.ok]);
    await audit(req, { action: 'integration.test', resourceType: 'integration', resourceId: row.id, result: result.ok ? 'SUCCESS' : 'FAILURE', details: { health, latencyMs: result.latencyMs, message: result.message } });
    return { ...result, health };
  });

  // JMeter results that the Backend Listener wrote to the team's own InfluxDB → a Perfmon run
  r.post('/runs/:runId/import/influx-jmeter', {
    preHandler: requirePermission('INGEST_METRICS'),
    schema: {
      tags: ['Integrations'], summary: 'Import JMeter Backend Listener results from an external InfluxDB into a run',
      description: 'Reads the JMeter measurement (all transactions, statuses, percentiles, response codes, thread counts and `events` annotations) from an InfluxDB integration for the time window and stores it like live listener data (source `import`, replaced on re-import). Finished runs are re-analyzed; `complete: true` completes a not-yet-finished run afterwards.',
      params: z.object({ runId: z.string().min(1) }),
      body: z.object({
        integrationId: z.string().uuid(),
        measurement: z.string().min(1).max(200).default('jmeter'),
        application: z.string().max(300).optional().nullable(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        complete: z.boolean().default(false),
      }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const b = req.body;
    const row = await owned(req, b.integrationId);
    if (row.type !== 'INFLUXDB') throw badRequest('Choose an InfluxDB integration');
    if (row.status === 'DISABLED') throw badRequest('Integration is disabled');
    const ref = await resolveRun(req.params.runId, p, true);
    if (row.project_id && row.project_id !== ref.projectId) throw badRequest('Integration is bound to a different project than the run');
    if (['ANALYZING', 'CANCELLED'].includes(ref.status)) throw badRequest(`Run ${ref.runKey} is ${ref.status}; wait for analysis to finish or use another run`);

    const tr = await one(`SELECT started_at, ended_at FROM test_runs WHERE id = $1`, [ref.id]);
    const from = b.from ? new Date(b.from) : tr.started_at ? new Date(new Date(tr.started_at).getTime() - 60_000) : null;
    const to = b.to ? new Date(b.to) : tr.ended_at ? new Date(new Date(tr.ended_at).getTime() + 60_000) : tr.started_at ? new Date() : null;
    if (!from || !to) throw badRequest(`Run ${ref.runKey} has no start time — give the test's time window (from / to)`);
    if (to <= from) throw badRequest('"to" must be after "from"');
    if (to.getTime() - from.getTime() > 7 * 86_400_000) throw badRequest('The time window is limited to 7 days per import');

    const t0 = performance.now();
    let points;
    try {
      points = await fetchJmeterPoints(toRecord(row), await loadCredentials(row.id), { measurement: b.measurement, application: b.application || null, from, to });
    } catch (e) {
      await query(`UPDATE integrations SET health = 'DOWN', last_error = $2, updated_at = now() WHERE id = $1`, [row.id, (e as Error).message]);
      throw badRequest((e as Error).message);
    }
    const jmeter = points.filter((x) => x.measurement === b.measurement);
    if (!jmeter.length) {
      throw badRequest(`No "${b.measurement}" points found in ${row.name} between ${from.toISOString()} and ${to.toISOString()}${b.application ? ` for application "${b.application}"` : ''}. Check the time window, measurement and application tag.`);
    }

    // re-import replaces earlier imported data for this run
    await aggregator.flush(true, ref.id);
    await deleteRunMetrics(ref.id, 'import');
    await query(`DELETE FROM events WHERE run_id = $1 AND source = 'influx_import'`, [ref.id]);
    const accepted = await ingestLinePoints(p, points, { runKey: ref.runKey, measurement: b.measurement, source: 'import', allowCompleted: true, intervalSec: inferIntervalSec(jmeter) });
    await aggregator.flush(true, ref.id);

    const first = Math.min(...jmeter.map((x) => x.timestamp ?? Infinity));
    const last = Math.max(...jmeter.map((x) => x.timestamp ?? 0));
    await query(`UPDATE test_runs SET started_at = LEAST(COALESCE(started_at, $2), $2), updated_at = now() WHERE id = $1`, [ref.id, new Date(first)]);
    const st = await one(`SELECT status FROM test_runs WHERE id = $1`, [ref.id]);
    let status = st.status as string;
    if (['COMPLETED', 'FAILED', 'ABORTED'].includes(status)) await enqueue('run.reanalyze', { runId: ref.id }, { runId: ref.id, priority: 2 });
    else if (b.complete) status = (await completeRun(p, ref.runKey, { endedAt: new Date(last).toISOString() })).status;
    await query(`UPDATE integrations SET last_import_at = now(), health = 'HEALTHY', last_error = NULL, last_connected_at = now(), updated_at = now() WHERE id = $1`, [row.id]);

    const transactions = new Set(jmeter.map((x) => x.tags.transaction).filter((t) => t && t !== 'all' && t !== 'internal')).size;
    selfMetrics.inc('integration_imported_points', accepted);
    await audit(req, { action: 'integration.import_jmeter', resourceType: 'integration', resourceId: row.id, result: 'SUCCESS',
      details: { runId: ref.runKey, points: jmeter.length, transactions, from, to, durationMs: Math.round(performance.now() - t0) } });
    return { runId: ref.runKey, points: jmeter.length, events: points.length - jmeter.length, transactions, from: new Date(first).toISOString(), to: new Date(last).toISOString(), status };
  });

  r.post('/integrations/:id/import', {
    preHandler: async (req) => {
      const p = principalOf(req);
      if (!p.permissions.has('MANAGE_INTEGRATIONS') && !p.permissions.has('INGEST_METRICS')) throw forbidden('Missing permission: MANAGE_INTEGRATIONS or INGEST_METRICS');
    },
    schema: {
      tags: ['Integrations'], summary: 'Import metrics for a run window from InfluxDB / Prometheus / Dynatrace into Perfmon',
      description: 'Queries default to integration.config.mappings, then to the connector defaults. Data is stored in server/jvm/database/service metrics or metric_points, correlated to the Run ID; finished runs are re-analyzed.',
      params: idParams, body: z.object({ runId: z.string().min(1), queries: z.array(querySchema).max(100).optional() }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const row = await owned(req, req.params.id);
    if (row.status === 'DISABLED') throw badRequest('Integration is disabled');
    const connector = connectorFor(row.type);
    if (!connector?.supportsImport || !connector.importRun) throw badRequest(`${row.type} integrations do not support metric import`);
    const ref = await resolveRun(req.body.runId, p);
    if (row.project_id && row.project_id !== ref.projectId) throw badRequest('Integration is bound to a different project than the run');
    const win = await runWindow(ref);
    const queries: ImportQuery[] = req.body.queries?.length ? req.body.queries : Array.isArray(row.config?.mappings) && row.config.mappings.length ? row.config.mappings : connector.defaultQueries?.(toRecord(row)) ?? [];
    if (!queries.length) throw badRequest('No queries given and no mappings configured for this integration');
    const t0 = performance.now();
    const { series, warnings } = await connector.importRun(toRecord(row), await loadCredentials(row.id), win, queries);
    const stored = await storeImportedSeries(win, row.type.toLowerCase(), series);
    const allWarnings = [...warnings, ...stored.warnings];
    const failedAll = series.length === 0 && warnings.length >= queries.length;
    await query(`UPDATE integrations SET last_import_at = now(), health = CASE WHEN $2 THEN 'DOWN' ELSE 'HEALTHY' END, last_error = $3,
                   last_connected_at = CASE WHEN $2 THEN last_connected_at ELSE now() END, updated_at = now() WHERE id = $1`,
      [row.id, failedAll, failedAll ? allWarnings[0] ?? 'Import failed' : null]);
    if (stored.imported > 0) {
      const st = await one(`SELECT status FROM test_runs WHERE id = $1`, [ref.id]);
      if (['COMPLETED', 'FAILED', 'ABORTED'].includes(st?.status)) await enqueue('run.reanalyze', { runId: ref.id }, { runId: ref.id, priority: 3 });
    }
    selfMetrics.inc('integration_imported_points', stored.imported);
    await audit(req, { action: 'integration.import', resourceType: 'integration', resourceId: row.id, result: failedAll ? 'FAILURE' : 'SUCCESS',
      details: { runId: ref.runKey, queries: queries.length, series: series.length, imported: stored.imported, warnings: allWarnings.slice(0, 10), durationMs: Math.round(performance.now() - t0) } });
    return { imported: stored.imported, series: series.length, warnings: allWarnings, runId: ref.runKey, window: { from: win.from, to: win.to, stepSec: win.stepSec }, servers: stored.servers, services: stored.services };
  });

  // OTLP/HTTP JSON metrics receiver (see connectors/opentelemetry.ts for the mapping)
  r.post('/ingest/otlp/v1/metrics', {
    preHandler: requirePermission('INGEST_METRICS'),
    bodyLimit: 20 * 1024 * 1024,
    schema: {
      tags: ['Ingestion'], summary: 'OpenTelemetry OTLP/HTTP (JSON) metrics receiver',
      description: 'Gauge/sum data points (and histogram count/sum/avg) are stored as metric points with resource + data point attributes as tags. Each point needs a run: attribute perfmon.run_id / runId / run.id, or ?runId=. Points without a run are rejected (partialSuccess).',
      querystring: z.object({ runId: z.string().optional() }),
      body: z.object({ resourceMetrics: z.array(z.any()).max(10000) }).passthrough(),
    },
  }, async (req, reply) => {
    const p = principalOf(req);
    const { points, skipped } = flattenOtlp(req.body, req.query.runId ?? null);
    const byRun = new Map<string, OtlpPoint[]>();
    let rejected = skipped;
    for (const pt of points) {
      if (!pt.runKey) { rejected++; continue; }
      const arr = byRun.get(pt.runKey) ?? [];
      arr.push(pt);
      byRun.set(pt.runKey, arr);
    }
    const errors: string[] = [];
    let accepted = 0;
    for (const [key, pts] of byRun) {
      let ref: RunRef;
      try { ref = await resolveRun(key, p); } catch (e) { rejected += pts.length; errors.push(`run ${key}: ${(e as Error).message}`); continue; }
      await insertGeneric(ref, pts.map((x) => ({ ts: x.ts, metric: x.metric.slice(0, 200), value: x.value, tags: x.tags })), 'otlp');
      accepted += pts.length;
    }
    if (!accepted && (rejected || points.length)) {
      throw badRequest(errors[0] ?? 'No data points could be correlated to a run: add the perfmon.run_id resource attribute or ?runId=<RUN_ID>', { rejectedDataPoints: rejected });
    }
    selfMetrics.inc('ingest_otlp_points', accepted);
    reply.code(200);
    return rejected ? { partialSuccess: { rejectedDataPoints: rejected, errorMessage: errors[0] ?? 'Some data points had no run correlation (perfmon.run_id) or no numeric value' } } : {};
  });
}
