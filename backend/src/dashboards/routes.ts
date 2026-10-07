import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query, tx } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { typed, z, assertProject } from '../lib/http.js';
import { Conds, likeEscape } from '../lib/scope.js';
import { PANEL_TYPES, SOURCES, GROUP_BYS, runPanelQueries, type QueryBody } from './query.js';
import { seedDefaultDashboards } from './defaults.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAR_TYPES = ['project', 'application', 'environment', 'test', 'run', 'transaction', 'endpoint', 'server', 'service', 'build', 'custom'] as const;

export const panelQuerySchema = z.object({
  source: z.enum(SOURCES),
  metric: z.string().max(60).optional(),
  metrics: z.array(z.string().max(60)).max(12).optional(),
  aggregation: z.enum(['avg', 'max', 'min', 'sum', 'last']).optional(),
  groupBy: z.enum(GROUP_BYS).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  markdown: z.string().max(20000).optional(),
});
const panelSchema = z.object({
  id: z.string().max(64).optional(),
  title: z.string().max(200).default(''),
  type: z.enum(PANEL_TYPES as [string, ...string[]]),
  query: panelQuerySchema,
  options: z.record(z.string(), z.any()).default({}),
  grid: z.object({ x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(1000), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(60) }),
});
const variableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/, 'letters, digits and underscore'),
  label: z.string().max(100).nullable().optional(),
  type: z.enum(VAR_TYPES),
  customValues: z.array(z.string().max(200)).max(500).nullable().optional(),
  defaultValue: z.string().max(500).nullable().optional(),
  multi: z.boolean().optional(),
  includeAll: z.boolean().optional(),
});
const dashboardBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(30).optional(),
  timeRange: z.record(z.string(), z.any()).optional(),
  refreshInterval: z.number().int().min(5).max(86400).nullable().optional(),
  isShared: z.boolean().optional(),
  panels: z.array(panelSchema).max(100).optional(),
  variables: z.array(variableSchema).max(30).optional(),
  version: z.number().int().optional(),   // optimistic concurrency on PUT (optional)
});
type DashboardBody = z.infer<typeof dashboardBody>;

const newUid = () => `d-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

async function loadDashboard(uid: string) {
  const d = await one(`SELECT d.*, u.name owner_name FROM dashboards d LEFT JOIN users u ON u.id = d.owner_id WHERE d.uid = $1`, [uid]);
  if (!d) return null;
  const [panels, variables] = await Promise.all([
    query(`SELECT * FROM dashboard_panels WHERE dashboard_id = $1 ORDER BY position, grid_y, grid_x`, [d.id]),
    query(`SELECT * FROM dashboard_variables WHERE dashboard_id = $1 ORDER BY position, name`, [d.id]),
  ]);
  return { d, panels, variables };
}

function dashboardDto({ d, panels, variables }: NonNullable<Awaited<ReturnType<typeof loadDashboard>>>) {
  return {
    id: d.id, uid: d.uid, name: d.name, description: d.description, tags: d.tags ?? [], projectId: d.project_id, isSystem: d.is_system, isShared: d.is_shared,
    ownerId: d.owner_id, ownerName: d.owner_name ?? null, timeRange: d.time_range, refreshInterval: d.refresh_interval, version: d.version,
    panels: panels.map((p) => ({ id: p.id, title: p.title, type: p.type, query: p.query, options: p.options ?? {}, grid: { x: p.grid_x, y: p.grid_y, w: p.grid_w, h: p.grid_h } })),
    variables: variables.map((v) => ({ name: v.name, label: v.label ?? undefined, type: v.type, customValues: v.custom_values ?? undefined, defaultValue: v.default_value, multi: v.multi, includeAll: v.include_all })),
    createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

/** Visible = same org, (shared | system | own), and inside an API key's project binding. */
function assertVisible(req: FastifyRequest, d: any) {
  const p = principalOf(req);
  if (!d || d.organization_id !== p.orgId) return false;
  if (p.projectId && d.project_id && d.project_id !== p.projectId) return false;
  return d.is_shared || d.is_system || (p.kind === 'user' && d.owner_id === p.id);
}
function assertEditable(req: FastifyRequest, d: any) {
  const p = principalOf(req);
  if (!d.is_shared && !d.is_system && !(p.kind === 'user' && d.owner_id === p.id)) throw forbidden('Only the owner can modify a private dashboard');
}

async function writeChildren(c: PoolClient, dashboardId: string, b: DashboardBody, keepIds: Set<string>) {
  await c.query(`DELETE FROM dashboard_panels WHERE dashboard_id = $1`, [dashboardId]);
  await c.query(`DELETE FROM dashboard_variables WHERE dashboard_id = $1`, [dashboardId]);
  let pos = 0;
  for (const p of b.panels ?? []) {
    const id = p.id && UUID_RE.test(p.id) && keepIds.has(p.id) ? p.id : randomUUID();
    const w = Math.min(p.grid.w, 12 - p.grid.x);
    await c.query(`INSERT INTO dashboard_panels (id, dashboard_id, title, type, query, options, grid_x, grid_y, grid_w, grid_h, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, dashboardId, p.title, p.type, JSON.stringify(p.query), JSON.stringify(p.options ?? {}), p.grid.x, p.grid.y, Math.max(1, w), p.grid.h, pos++]);
  }
  const names = new Set<string>();
  pos = 0;
  for (const v of b.variables ?? []) {
    if (names.has(v.name)) throw badRequest(`Duplicate variable name '${v.name}'`);
    names.add(v.name);
    await c.query(`INSERT INTO dashboard_variables (dashboard_id, name, label, type, custom_values, default_value, multi, include_all, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [dashboardId, v.name, v.label ?? null, v.type, v.customValues ?? null, v.defaultValue ?? null, v.multi ?? false, v.includeAll ?? true, pos++]);
  }
}

async function createDashboard(req: FastifyRequest, b: DashboardBody, extra: { isSystem?: boolean } = {}) {
  const p = principalOf(req);
  const projectId = b.projectId ?? p.projectId ?? null;
  if (projectId) await assertProject(req, projectId);
  const uid = newUid();
  await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO dashboards (organization_id, project_id, uid, name, description, tags, is_system, is_shared, time_range, refresh_interval, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [p.orgId, projectId, uid, b.name, b.description ?? null, [...new Set(b.tags ?? [])], extra.isSystem ?? false, b.isShared ?? true,
        JSON.stringify(b.timeRange ?? { type: 'relative', value: '24h' }), b.refreshInterval ?? null, p.kind === 'user' ? p.id : null]);
    await writeChildren(c, ins.rows[0].id, b, new Set());
  });
  return uid;
}

/** Lazily create the default dashboards for projects that do not have them yet (idempotent). */
async function ensureDefaults(orgId: string, projectId: string | null) {
  const missing = await query(
    `SELECT p.id FROM projects p WHERE p.organization_id = $1 AND p.archived_at IS NULL AND ($2::uuid IS NULL OR p.id = $2)
       AND (SELECT count(*) FROM dashboards d WHERE d.project_id = p.id AND d.is_system) < 9`, [orgId, projectId]);
  for (const m of missing) await seedDefaultDashboards(orgId, m.id);
}

export async function dashboardRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };
  const uidParam = z.object({ uid: z.string().min(1).max(100) });

  r.get('/dashboards', {
    ...view,
    schema: { tags: ['Dashboards'], summary: 'List dashboards (system dashboards are created per project on first use)', querystring: z.object({ projectId: z.string().uuid().optional(), q: z.string().optional(), tag: z.string().optional() }) },
  }, async (req) => {
    const p = principalOf(req);
    const projectId = req.query.projectId ?? p.projectId ?? null;
    if (req.query.projectId) await assertProject(req, req.query.projectId);
    await ensureDefaults(p.orgId, projectId);
    const c = new Conds([p.orgId]);
    c.raw('d.organization_id = $1');
    c.add('(d.is_shared OR d.is_system OR d.owner_id = ?)', p.kind === 'user' ? p.id : null);
    if (projectId) c.add('(d.project_id = ? OR d.project_id IS NULL)', projectId);
    if (p.projectId) c.add('(d.project_id = ? OR d.project_id IS NULL)', p.projectId);
    if (req.query.q) c.add(`(d.name ILIKE ? OR d.description ILIKE ? OR EXISTS (SELECT 1 FROM unnest(d.tags) tg WHERE tg ILIKE ?))`, `%${likeEscape(req.query.q)}%`);
    if (req.query.tag) c.add('? = ANY(d.tags)', req.query.tag);
    const rows = await query(
      `SELECT d.id, d.uid, d.name, d.description, d.tags, d.project_id, d.is_system, d.is_shared, d.updated_at, u.name owner_name,
              (SELECT count(*) FROM dashboard_panels dp WHERE dp.dashboard_id = d.id)::int panel_count
       FROM dashboards d LEFT JOIN users u ON u.id = d.owner_id WHERE ${c.where()} ORDER BY d.is_system DESC, d.name LIMIT 500`, c.params);
    return rows.map((d) => ({ id: d.id, uid: d.uid, name: d.name, description: d.description, tags: d.tags ?? [], projectId: d.project_id, isSystem: d.is_system, isShared: d.is_shared, ownerName: d.owner_name ?? null, updatedAt: d.updated_at, panelCount: d.panel_count }));
  });

  r.post('/dashboards', { preHandler: requirePermission('CREATE_DASHBOARD'), schema: { tags: ['Dashboards'], summary: 'Create a dashboard', body: dashboardBody } }, async (req, reply) => {
    const uid = await createDashboard(req, req.body);
    const full = (await loadDashboard(uid))!;
    await audit(req, { action: 'dashboard.create', resourceType: 'dashboard', resourceId: full.d.id, details: { uid, name: req.body.name } });
    reply.code(201);
    return dashboardDto(full);
  });

  // Static routes registered before /dashboards/:uid
  r.post('/dashboards/query', {
    preHandler: requirePermission('VIEW_RUN'),
    schema: {
      tags: ['Dashboards'], summary: 'Execute panel queries (metric abstraction + server-side variable resolution)',
      body: z.object({
        panels: z.array(z.object({ id: z.string().min(1).max(64), type: z.enum(PANEL_TYPES as [string, ...string[]]), query: panelQuerySchema })).max(100),
        vars: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])).default({}),
        timeRange: z.union([z.object({ from: z.number(), to: z.number() }), z.object({ runId: z.string().min(1) })]).default({ from: Date.now() - 86400000, to: Date.now() }),
      }),
    },
  }, async (req) => {
    const b = req.body;
    if ('from' in b.timeRange && b.timeRange.from > b.timeRange.to) throw badRequest('timeRange.from must be before timeRange.to');
    return runPanelQueries(principalOf(req), b as QueryBody, req.log);
  });

  r.get('/dashboards/variable-options', {
    ...view,
    schema: {
      tags: ['Dashboards'], summary: 'Values for a dashboard variable',
      querystring: z.object({ type: z.enum(VAR_TYPES), projectId: z.string().optional(), applicationId: z.string().optional(), environmentId: z.string().optional(), testId: z.string().optional(), runId: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    // Ignore "All"/empty selections passed through from the UI
    const clean = (v?: string) => (v && !['all', '$__all', '*', 'null'].includes(v.toLowerCase()) ? v : undefined);
    const projectId = clean(q.projectId), applicationId = clean(q.applicationId), environmentId = clean(q.environmentId), testId = clean(q.testId), runRef = clean(q.runId);
    for (const [k, v] of Object.entries({ projectId, applicationId, environmentId, testId })) if (v && !UUID_RE.test(v)) throw badRequest(`${k} must be a UUID`);
    const c = new Conds([p.orgId]);
    const proj = projectId ?? p.projectId ?? null;
    const like = q.q ? `%${likeEscape(q.q)}%` : null;
    const lim = () => c.param(q.limit);
    const scope = (alias: string, opts: { app?: boolean; env?: boolean; test?: boolean } = {}) => {
      c.raw('pr.organization_id = $1');
      if (proj) c.add(`${alias}.project_id = ?`, proj);
      if (opts.app && applicationId) c.add(`${alias}.application_id = ?`, applicationId);
      if (opts.env && environmentId) c.add(`${alias}.environment_id = ?`, environmentId);
      if (opts.test && testId) c.add(`${alias}.test_id = ?`, testId);
    };
    switch (q.type) {
      case 'project': {
        c.raw('pr.organization_id = $1').raw('pr.archived_at IS NULL');
        if (p.projectId) c.add('pr.id = ?', p.projectId);
        if (like) c.add('(pr.name ILIKE ? OR pr.key ILIKE ?)', like);
        return query(`SELECT pr.id AS value, pr.name AS label FROM projects pr WHERE ${c.where()} ORDER BY pr.name LIMIT ${lim()}`, c.params);
      }
      case 'application': {
        scope('a');
        if (like) c.add('(a.name ILIKE ? OR a.code ILIKE ?)', like);
        return query(`SELECT a.id AS value, a.name AS label FROM applications a JOIN projects pr ON pr.id = a.project_id WHERE ${c.where()} AND a.archived_at IS NULL ORDER BY a.name LIMIT ${lim()}`, c.params);
      }
      case 'environment': {
        scope('e', { app: true });
        if (like) c.add('e.name ILIKE ?', like);
        return query(`SELECT e.id AS value, e.name || ' (' || a.name || ')' AS label FROM environments e JOIN applications a ON a.id = e.application_id JOIN projects pr ON pr.id = e.project_id WHERE ${c.where()} ORDER BY a.name, e.name LIMIT ${lim()}`, c.params);
      }
      case 'test': {
        scope('t', { app: true, env: true });
        if (like) c.add('t.name ILIKE ?', like);
        return query(`SELECT t.id AS value, t.name || ' · ' || e.name AS label FROM performance_tests t JOIN environments e ON e.id = t.environment_id JOIN projects pr ON pr.id = t.project_id WHERE ${c.where()} AND t.archived_at IS NULL ORDER BY t.name LIMIT ${lim()}`, c.params);
      }
      case 'run': {
        scope('r', { app: true, env: true, test: true });
        c.raw('r.deleted_at IS NULL');
        if (like) c.add('(r.run_key ILIKE ? OR r.build_number ILIKE ?)', like);
        return query(
          `SELECT r.run_key AS value, r.run_key || ' · ' || t.name || COALESCE(' · build ' || r.build_number, '') || ' · ' || COALESCE(r.result, r.status) AS label
           FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN projects pr ON pr.id = r.project_id
           WHERE ${c.where()} ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT ${lim()}`, c.params);
      }
      case 'transaction': {
        scope('r', { app: true, env: true, test: true });
        c.raw('r.deleted_at IS NULL');
        if (runRef) c.add('(r.id::text = ? OR r.run_key = ?)', runRef);
        const runWhere = c.where();
        const nameCond = like ? `AND x.name ILIKE ${c.param(like)}` : '';
        // Without a run: transactions of the 20 most recent matching runs
        return query(
          `SELECT DISTINCT x.name AS value, x.name AS label FROM transactions x
           WHERE x.run_id IN (SELECT r.id FROM test_runs r JOIN projects pr ON pr.id = r.project_id WHERE ${runWhere} ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 20)
           ${nameCond} ORDER BY 1 LIMIT ${lim()}`, c.params);
      }
      case 'endpoint': {
        c.raw('pr.organization_id = $1');
        if (proj) c.add('a.project_id = ?', proj);
        if (applicationId) c.add('a.id = ?', applicationId);
        if (like) c.add(`(ep.method || ' ' || ep.path_template) ILIKE ?`, like);
        return query(`SELECT ep.id AS value, ep.method || ' ' || ep.path_template AS label FROM api_endpoints ep JOIN applications a ON a.id = ep.application_id JOIN projects pr ON pr.id = a.project_id WHERE ${c.where()} ORDER BY ep.path_template, ep.method LIMIT ${lim()}`, c.params);
      }
      case 'server': case 'service': {
        const t = q.type === 'server' ? 'servers' : 'services';
        scope('s', { env: true });
        if (applicationId) c.add('(s.application_id IS NULL OR s.application_id = ?)', applicationId);
        if (like) c.add('s.name ILIKE ?', like);
        return query(`SELECT s.id AS value, s.name ${q.type === 'server' ? `|| COALESCE(' (' || s.role || ')', '')` : `|| ' (' || s.kind || ')'`} AS label FROM ${t} s JOIN projects pr ON pr.id = s.project_id WHERE ${c.where()} ORDER BY s.name LIMIT ${lim()}`, c.params);
      }
      case 'build': {
        scope('r', { app: true, env: true, test: true });
        c.raw('r.deleted_at IS NULL').raw('r.build_number IS NOT NULL');
        if (like) c.add('r.build_number ILIKE ?', like);
        return query(
          `SELECT r.build_number AS value, r.build_number AS label FROM test_runs r JOIN projects pr ON pr.id = r.project_id WHERE ${c.where()}
           GROUP BY r.build_number ORDER BY max(COALESCE(r.started_at, r.created_at)) DESC LIMIT ${lim()}`, c.params);
      }
      default:
        return []; // custom variables carry their own values
    }
  });

  r.post('/dashboards/import', {
    preHandler: requirePermission('CREATE_DASHBOARD'),
    schema: { tags: ['Dashboards'], summary: 'Import a dashboard (JSON from /export)', body: z.object({ dashboard: z.record(z.string(), z.any()), projectId: z.string().uuid().optional() }) },
  }, async (req, reply) => {
    const raw = (req.body.dashboard.dashboard ?? req.body.dashboard) as Record<string, unknown>;
    const parsed = dashboardBody.safeParse({ ...raw, projectId: req.body.projectId ?? raw.projectId ?? undefined });
    if (!parsed.success) throw badRequest('Invalid dashboard definition', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const uid = await createDashboard(req, parsed.data);
    const full = (await loadDashboard(uid))!;
    await audit(req, { action: 'dashboard.import', resourceType: 'dashboard', resourceId: full.d.id, details: { uid, name: parsed.data.name } });
    reply.code(201);
    return dashboardDto(full);
  });

  r.post('/dashboards/seed-defaults', {
    preHandler: requirePermission('EDIT_DASHBOARD'),
    schema: { tags: ['Dashboards'], summary: 'Create any missing default (system) dashboards for a project', body: z.object({ projectId: z.string().uuid() }) },
  }, async (req) => {
    await assertProject(req, req.body.projectId);
    const created = await seedDefaultDashboards(principalOf(req).orgId, req.body.projectId);
    if (created) await audit(req, { action: 'dashboard.seed_defaults', resourceType: 'project', resourceId: req.body.projectId, details: { created } });
    return { created };
  });

  r.get('/dashboards/:uid', { ...view, schema: { tags: ['Dashboards'], summary: 'Dashboard with panels and variables', params: uidParam } }, async (req) => {
    const full = await loadDashboard(req.params.uid);
    if (!full || !assertVisible(req, full.d)) throw notFound('Dashboard', req.params.uid);
    return dashboardDto(full);
  });

  r.put('/dashboards/:uid', {
    preHandler: requirePermission('EDIT_DASHBOARD'),
    schema: { tags: ['Dashboards'], summary: 'Save a dashboard (full replace; version + 1)', params: uidParam, body: dashboardBody },
  }, async (req) => {
    const cur = await loadDashboard(req.params.uid);
    if (!cur || !assertVisible(req, cur.d)) throw notFound('Dashboard', req.params.uid);
    assertEditable(req, cur.d);
    const b = req.body;
    if (b.version != null && b.version !== cur.d.version) throw conflict(`Dashboard was modified by someone else (version ${cur.d.version}); reload and retry`, { currentVersion: cur.d.version });
    const projectId = b.projectId === undefined ? cur.d.project_id : b.projectId;
    if (projectId && projectId !== cur.d.project_id) await assertProject(req, projectId);
    await tx(async (c) => {
      await c.query(
        `UPDATE dashboards SET name = $2, description = $3, tags = $4, time_range = $5, refresh_interval = $6, is_shared = $7, project_id = $8, version = version + 1, updated_at = now() WHERE id = $1`,
        [cur.d.id, b.name, b.description ?? null, [...new Set(b.tags ?? [])], JSON.stringify(b.timeRange ?? cur.d.time_range), b.refreshInterval ?? null,
          cur.d.is_system ? true : b.isShared ?? cur.d.is_shared, projectId]);
      await writeChildren(c, cur.d.id, b, new Set(cur.panels.map((x) => x.id)));
    });
    const full = (await loadDashboard(req.params.uid))!;
    await audit(req, { action: 'dashboard.update', resourceType: 'dashboard', resourceId: cur.d.id, details: { uid: cur.d.uid, version: full.d.version, panels: full.panels.length } });
    return dashboardDto(full);
  });

  r.delete('/dashboards/:uid', {
    preHandler: requirePermission('DELETE_DASHBOARD'),
    schema: { tags: ['Dashboards'], summary: 'Delete a dashboard (requires ?confirm=true)', params: uidParam, querystring: z.object({ confirm: z.coerce.boolean().default(false) }) },
  }, async (req) => {
    if (!req.query.confirm) throw badRequest('Deletion requires confirmation: repeat the request with ?confirm=true');
    const cur = await loadDashboard(req.params.uid);
    if (!cur || !assertVisible(req, cur.d)) throw notFound('Dashboard', req.params.uid);
    if (cur.d.is_system) throw conflict('System dashboards cannot be deleted; clone it to customise, or edit it in place');
    assertEditable(req, cur.d);
    await query(`DELETE FROM dashboards WHERE id = $1`, [cur.d.id]);
    await audit(req, { action: 'dashboard.delete', resourceType: 'dashboard', resourceId: cur.d.id, details: { uid: cur.d.uid, name: cur.d.name } });
    return { ok: true };
  });

  r.post('/dashboards/:uid/clone', {
    preHandler: requirePermission('CREATE_DASHBOARD'),
    schema: { tags: ['Dashboards'], summary: 'Clone a dashboard', params: uidParam, body: z.object({ name: z.string().min(1).max(200).optional(), projectId: z.string().uuid().optional() }).optional() },
  }, async (req, reply) => {
    const cur = await loadDashboard(req.params.uid);
    if (!cur || !assertVisible(req, cur.d)) throw notFound('Dashboard', req.params.uid);
    const src = dashboardDto(cur);
    const uid = await createDashboard(req, {
      name: req.body?.name ?? `${src.name} (copy)`, description: src.description, projectId: req.body?.projectId ?? src.projectId, tags: src.tags.filter((t: string) => t !== 'system'),
      timeRange: src.timeRange, refreshInterval: src.refreshInterval, isShared: true, panels: src.panels as any, variables: src.variables as any,
    });
    const full = (await loadDashboard(uid))!;
    await audit(req, { action: 'dashboard.clone', resourceType: 'dashboard', resourceId: full.d.id, details: { from: cur.d.uid, uid } });
    reply.code(201);
    return dashboardDto(full);
  });

  r.get('/dashboards/:uid/export', { ...view, schema: { tags: ['Dashboards'], summary: 'Export a dashboard as JSON', params: uidParam } }, async (req, reply) => {
    const cur = await loadDashboard(req.params.uid);
    if (!cur || !assertVisible(req, cur.d)) throw notFound('Dashboard', req.params.uid);
    const d = dashboardDto(cur);
    const body = {
      perfmonDashboard: 1, exportedAt: new Date().toISOString(),
      dashboard: { name: d.name, description: d.description, tags: d.tags, projectId: d.projectId, timeRange: d.timeRange, refreshInterval: d.refreshInterval, isShared: d.isShared,
        panels: d.panels.map(({ id: _id, ...p }) => p), variables: d.variables },
    };
    const safe = d.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'dashboard';
    return reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="${safe}.json"`).send(JSON.stringify(body, null, 2));
  });
}
