import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { typed, z, assertProject } from '../lib/http.js';
import { Conds, projectFilter, requireAny, parseTime } from '../lib/scope.js';
import { resolveRun } from '../ingest/runCache.js';

const EVENT_TYPES = ['DEPLOYMENT', 'TEST_START', 'TEST_END', 'ALERT', 'INCIDENT', 'CONFIG_CHANGE', 'APP_RESTART', 'DB_RESTART', 'REGRESSION', 'REPORT', 'OTHER'] as const;
const uuidOpt = z.string().uuid().optional();

const eventDto = (e: any) => ({
  id: e.id, projectId: e.project_id, applicationId: e.application_id, environmentId: e.environment_id, environmentName: e.environment_name ?? null,
  runId: e.run_id, runKey: e.run_key ?? null, type: e.type, severity: e.severity, ts: e.ts, title: e.title, description: e.description, source: e.source, data: e.data ?? {},
});
const annotationDto = (a: any) => ({
  id: a.id, projectId: a.project_id, runId: a.run_id, runKey: a.run_key ?? null, environmentId: a.environment_id, dashboardId: a.dashboard_id,
  ts: a.ts, tsEnd: a.ts_end, title: a.title, text: a.text, tags: a.tags ?? [], createdBy: a.created_by, createdByName: a.created_by_name, createdAt: a.created_at,
});

/** Resolve an optional run reference and require it to belong to the given project. */
async function runInProject(req: FastifyRequest, runRef: string | null | undefined, projectId: string) {
  if (!runRef) return null;
  const ref = await resolveRun(runRef, principalOf(req));
  if (ref.projectId !== projectId) throw badRequest(`Run ${ref.runKey} does not belong to this project`);
  return ref;
}
async function envInProject(environmentId: string | null | undefined, projectId: string) {
  if (!environmentId) return;
  const e = await one(`SELECT 1 FROM environments WHERE id = $1 AND project_id = $2`, [environmentId, projectId]);
  if (!e) throw badRequest('Environment does not belong to this project');
}
async function appInProject(applicationId: string | null | undefined, projectId: string) {
  if (!applicationId) return;
  const a = await one(`SELECT 1 FROM applications WHERE id = $1 AND project_id = $2`, [applicationId, projectId]);
  if (!a) throw badRequest('Application does not belong to this project');
}
async function dashboardInOrg(dashboardId: string | null | undefined, orgId: string) {
  if (!dashboardId) return;
  const d = await one(`SELECT 1 FROM dashboards WHERE id = $1 AND organization_id = $2`, [dashboardId, orgId]);
  if (!d) throw badRequest('Dashboard not found in this organization');
}

const ANNOTATION_SELECT = `SELECT a.*, r.run_key FROM annotations a JOIN projects pr ON pr.id = a.project_id LEFT JOIN test_runs r ON r.id = a.run_id`;

export async function eventRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };

  // ------------------------------------------------------------------ Events
  r.get('/events', {
    ...view,
    schema: {
      tags: ['Events'], summary: 'Events (deployments, test start/end, alerts, incidents, config changes…)',
      querystring: z.object({ projectId: uuidOpt, environmentId: uuidOpt, applicationId: uuidOpt, runId: z.string().optional(), type: z.string().optional(), severity: z.string().optional(), q: z.string().optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).default(200) }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    const c = new Conds([p.orgId]);
    c.raw('pr.organization_id = $1');
    if (projectId) c.add('e.project_id = ?', projectId);
    if (q.environmentId) c.add('e.environment_id = ?', q.environmentId);
    if (q.applicationId) c.add('e.application_id = ?', q.applicationId);
    if (q.runId) c.add('e.run_id = ?', (await resolveRun(q.runId, p)).id);
    if (q.type) c.add('e.type = ANY(?)', q.type.split(',').map((s) => s.trim().toUpperCase()));
    if (q.severity) c.add('e.severity = ANY(?)', q.severity.split(',').map((s) => s.trim().toUpperCase()));
    if (q.q) c.add(`(e.title ILIKE ? OR e.description ILIKE ?)`, `%${q.q.replace(/[\\%_]/g, (x) => '\\' + x)}%`);
    if (q.from) c.add('e.ts >= ?', parseTime(q.from));
    if (q.to) c.add('e.ts <= ?', parseTime(q.to));
    const lim = c.param(q.limit);
    const rows = await query(
      `SELECT e.*, r.run_key, env.name environment_name FROM events e JOIN projects pr ON pr.id = e.project_id
       LEFT JOIN test_runs r ON r.id = e.run_id LEFT JOIN environments env ON env.id = e.environment_id
       WHERE ${c.where()} ORDER BY e.ts DESC LIMIT ${lim}`, c.params);
    return rows.map(eventDto);
  });

  r.post('/events', {
    preHandler: requireAny('EXECUTE_TEST', 'MANAGE_PROJECT'),
    schema: {
      tags: ['Events'], summary: 'Record an event (e.g. a deployment marker from CI)',
      body: z.object({
        projectId: z.string().uuid(), type: z.enum(EVENT_TYPES), title: z.string().min(1).max(300), description: z.string().max(5000).optional(),
        ts: z.union([z.string(), z.number()]).optional(), environmentId: z.string().uuid().optional(), applicationId: z.string().uuid().optional(),
        runId: z.string().optional(), severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(), data: z.record(z.string(), z.any()).optional(),
      }),
    },
  }, async (req, reply) => {
    const b = req.body;
    await assertProject(req, b.projectId);
    const run = await runInProject(req, b.runId, b.projectId);
    await envInProject(b.environmentId, b.projectId);
    await appInProject(b.applicationId, b.projectId);
    const p = principalOf(req);
    const row = await one(
      `INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, ts, title, description, source, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.projectId, b.applicationId ?? run?.applicationId ?? null, b.environmentId ?? run?.environmentId ?? null, run?.id ?? null, b.type, b.severity ?? 'INFO',
        parseTime(b.ts) ?? new Date(), b.title, b.description ?? null, p.kind === 'api_key' ? 'api' : 'user', JSON.stringify(b.data ?? {})]);
    await audit(req, { action: 'event.create', resourceType: 'event', resourceId: row!.id, details: { type: b.type, title: b.title, runId: run?.runKey } });
    reply.code(201);
    return eventDto({ ...row, run_key: run?.runKey ?? null });
  });

  r.delete('/events/:id', {
    preHandler: requirePermission('MANAGE_PROJECT'),
    schema: { tags: ['Events'], summary: 'Delete an event', params: z.object({ id: z.string().uuid() }) },
  }, async (req) => {
    const p = principalOf(req);
    const e = await one(`SELECT e.* FROM events e JOIN projects pr ON pr.id = e.project_id WHERE e.id = $1 AND pr.organization_id = $2`, [req.params.id, p.orgId]);
    if (!e) throw notFound('Event', req.params.id);
    await query(`DELETE FROM events WHERE id = $1`, [e.id]);
    await audit(req, { action: 'event.delete', resourceType: 'event', resourceId: e.id, details: { title: e.title } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Annotations
  r.get('/annotations', {
    ...view,
    schema: {
      tags: ['Events'], summary: 'Annotations (full-text search with q; tag filter with tags=a,b)',
      querystring: z.object({ projectId: uuidOpt, runId: z.string().optional(), dashboardId: uuidOpt, environmentId: uuidOpt, q: z.string().optional(), tags: z.string().optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().min(1).max(2000).default(500) }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    const c = new Conds([p.orgId]);
    c.raw('pr.organization_id = $1');
    if (projectId) c.add('a.project_id = ?', projectId);
    if (q.runId) c.add('a.run_id = ?', (await resolveRun(q.runId, p)).id);
    if (q.dashboardId) c.add('a.dashboard_id = ?', q.dashboardId);
    if (q.environmentId) c.add('a.environment_id = ?', q.environmentId);
    if (q.tags) c.add('a.tags && ?', q.tags.split(',').map((s) => s.trim()).filter(Boolean));
    if (q.q?.trim()) {
      const term = q.q.trim();
      c.add(`(a.search @@ plainto_tsquery('simple', ?) OR EXISTS (SELECT 1 FROM unnest(a.tags) tg WHERE lower(tg) = lower(?)) OR a.title ILIKE '%' || ? || '%')`, term);
    }
    if (q.from) c.add('COALESCE(a.ts_end, a.ts) >= ?', parseTime(q.from));
    if (q.to) c.add('a.ts <= ?', parseTime(q.to));
    const lim = c.param(q.limit);
    const order = q.q?.trim() ? `ts_rank(a.search, plainto_tsquery('simple', ${c.param(q.q.trim())})) DESC, a.ts DESC` : 'a.ts DESC';
    const rows = await query(`${ANNOTATION_SELECT} WHERE ${c.where()} ORDER BY ${order} LIMIT ${lim}`, c.params);
    return rows.map(annotationDto);
  });

  const annotationBody = {
    title: z.string().min(1).max(300), text: z.string().max(10000).nullable().optional(), ts: z.union([z.string(), z.number()]),
    tsEnd: z.union([z.string(), z.number()]).nullable().optional(), tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    runId: z.string().nullable().optional(), environmentId: z.string().uuid().nullable().optional(), dashboardId: z.string().uuid().nullable().optional(),
  };
  const annotate = requireAny('EDIT_DASHBOARD', 'EXECUTE_TEST', 'MANAGE_PROJECT');

  r.post('/annotations', {
    preHandler: annotate,
    schema: { tags: ['Events'], summary: 'Create an annotation', body: z.object({ projectId: z.string().uuid(), ...annotationBody }) },
  }, async (req, reply) => {
    const b = req.body;
    const p = principalOf(req);
    await assertProject(req, b.projectId);
    const run = await runInProject(req, b.runId, b.projectId);
    await envInProject(b.environmentId, b.projectId);
    await dashboardInOrg(b.dashboardId, p.orgId);
    const ts = parseTime(b.ts)!;
    const tsEnd = parseTime(b.tsEnd ?? undefined) ?? null;
    if (tsEnd && tsEnd < ts) throw badRequest('tsEnd must be after ts');
    const row = await one(
      `INSERT INTO annotations (project_id, run_id, environment_id, dashboard_id, ts, ts_end, title, text, tags, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.projectId, run?.id ?? null, b.environmentId ?? run?.environmentId ?? null, b.dashboardId ?? null, ts, tsEnd, b.title, b.text ?? null,
        [...new Set(b.tags ?? [])], p.kind === 'user' ? p.id : null, p.name]);
    await audit(req, { action: 'annotation.create', resourceType: 'annotation', resourceId: row!.id, details: { title: b.title, runId: run?.runKey } });
    reply.code(201);
    return annotationDto(await one(`${ANNOTATION_SELECT} WHERE a.id = $1`, [row!.id]));
  });

  async function ownedAnnotation(req: FastifyRequest, id: string) {
    const p = principalOf(req);
    const a = await one(`${ANNOTATION_SELECT} WHERE a.id = $1 AND pr.organization_id = $2`, [id, p.orgId]);
    if (!a) throw notFound('Annotation', id);
    if (p.projectId && a.project_id !== p.projectId) throw forbidden('API key is not authorized for this project');
    // Authors may edit their own annotations; others need dashboard edit or project management rights.
    if (a.created_by && p.kind === 'user' && a.created_by !== p.id && !p.permissions.has('EDIT_DASHBOARD') && !p.permissions.has('MANAGE_PROJECT')) {
      throw forbidden('Only the author or a dashboard editor can modify this annotation');
    }
    return a;
  }

  r.patch('/annotations/:id', {
    preHandler: annotate,
    schema: { tags: ['Events'], summary: 'Update an annotation', params: z.object({ id: z.string().uuid() }), body: z.object(annotationBody).partial() },
  }, async (req) => {
    const a = await ownedAnnotation(req, req.params.id);
    const b = req.body;
    const p = principalOf(req);
    const sets: string[] = [];
    const params: unknown[] = [a.id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.text !== undefined) set('text', b.text);
    if (b.ts !== undefined) set('ts', parseTime(b.ts));
    if (b.tsEnd !== undefined) set('ts_end', b.tsEnd == null ? null : parseTime(b.tsEnd));
    if (b.tags !== undefined) set('tags', [...new Set(b.tags)]);
    if (b.runId !== undefined) set('run_id', b.runId ? (await runInProject(req, b.runId, a.project_id))!.id : null);
    if (b.environmentId !== undefined) { await envInProject(b.environmentId, a.project_id); set('environment_id', b.environmentId); }
    if (b.dashboardId !== undefined) { await dashboardInOrg(b.dashboardId, p.orgId); set('dashboard_id', b.dashboardId); }
    if (!sets.length) throw badRequest('Nothing to update');
    const newTs = b.ts !== undefined ? parseTime(b.ts)! : new Date(a.ts);
    const newEnd = b.tsEnd !== undefined ? (b.tsEnd == null ? null : parseTime(b.tsEnd)!) : a.ts_end ? new Date(a.ts_end) : null;
    if (newEnd && newEnd < newTs) throw badRequest('tsEnd must be after ts');
    await query(`UPDATE annotations SET ${sets.join(', ')} WHERE id = $1`, params);
    const row = await one(`${ANNOTATION_SELECT} WHERE a.id = $1`, [a.id]);
    await audit(req, { action: 'annotation.update', resourceType: 'annotation', resourceId: a.id, details: b as Record<string, unknown> });
    return annotationDto(row);
  });

  r.delete('/annotations/:id', {
    preHandler: annotate,
    schema: { tags: ['Events'], summary: 'Delete an annotation', params: z.object({ id: z.string().uuid() }) },
  }, async (req) => {
    const a = await ownedAnnotation(req, req.params.id);
    await query(`DELETE FROM annotations WHERE id = $1`, [a.id]);
    await audit(req, { action: 'annotation.delete', resourceType: 'annotation', resourceId: a.id, details: { title: a.title } });
    return { ok: true };
  });
}
