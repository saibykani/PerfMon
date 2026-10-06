import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query, tx } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { typed, z, idParams, assertProject } from '../lib/http.js';
import { encryptSecret } from '../lib/crypto.js';
import { SLA_METRICS } from '../analytics/sla.js';

const ENV_TYPES = ['DEV', 'QA', 'SIT', 'UAT', 'PERFORMANCE', 'STAGING', 'PRODUCTION'] as const;
const TEST_TYPES = ['LOAD', 'STRESS', 'SPIKE', 'SOAK', 'ENDURANCE', 'VOLUME', 'CAPACITY', 'SCALABILITY', 'BASELINE'] as const;
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

/** Load a row and check it belongs to the caller's organization through its project. */
async function owned(req: FastifyRequest, table: string, id: string, label: string) {
  const row = await one(`SELECT x.*, p.organization_id FROM ${table} x JOIN projects p ON p.id = x.project_id WHERE x.id = $1`, [id]);
  if (!row || row.organization_id !== principalOf(req).orgId) throw notFound(label, id);
  return row;
}

function updateSql(table: string, id: string, body: Record<string, unknown>, map: Record<string, string>) {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) {
    if (body[k] === undefined) continue;
    params.push(body[k]);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  return [`UPDATE ${table} SET ${sets.join(', ')}${table !== 'servers' && table !== 'services' && table !== 'sla_rules' ? ', updated_at = now()' : ''} WHERE id = $1 RETURNING *`, params] as const;
}

export async function inventoryRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };
  const manage = { preHandler: requirePermission('MANAGE_PROJECT') };

  // ------------------------------------------------------------------ Projects
  r.get('/projects', { ...view, schema: { tags: ['Projects'], summary: 'List projects with counts', querystring: z.object({ includeArchived: z.coerce.boolean().optional() }) } }, async (req) => {
    const p = principalOf(req);
    return query(
      `SELECT p.*, (SELECT count(*) FROM applications a WHERE a.project_id = p.id)::int AS applications,
              (SELECT count(*) FROM environments e WHERE e.project_id = p.id)::int AS environments,
              (SELECT count(*) FROM performance_tests t WHERE t.project_id = p.id AND t.archived_at IS NULL)::int AS tests,
              (SELECT count(*) FROM test_runs r WHERE r.project_id = p.id AND r.deleted_at IS NULL)::int AS runs,
              (SELECT count(*) FROM dashboards d WHERE d.project_id = p.id)::int AS dashboards,
              (SELECT count(*) FROM releases rl WHERE rl.project_id = p.id)::int AS releases,
              (SELECT count(*) FROM alerts al WHERE al.project_id = p.id AND al.status = 'FIRING')::int AS active_alerts,
              (SELECT max(started_at) FROM test_runs r WHERE r.project_id = p.id) AS last_run_at
       FROM projects p WHERE p.organization_id = $1 ${req.query.includeArchived ? '' : 'AND p.archived_at IS NULL'} ${p.projectId ? 'AND p.id = $2' : ''} ORDER BY p.name`,
      p.projectId ? [p.orgId, p.projectId] : [p.orgId]);
  });

  r.post('/projects', { ...manage, schema: { tags: ['Projects'], summary: 'Create project', body: z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes'), name: z.string().min(1).max(120), description: z.string().max(2000).optional() }) } }, async (req, reply) => {
    const p = principalOf(req);
    const row = await one(`INSERT INTO projects (organization_id, key, name, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [p.orgId, req.body.key, req.body.name, req.body.description ?? null, p.kind === 'user' ? p.id : null]);
    await audit(req, { action: 'project.create', resourceType: 'project', resourceId: row.id, details: { key: row.key } });
    reply.code(201);
    return row;
  });

  r.get('/projects/:id', { ...view, schema: { tags: ['Projects'], summary: 'Project detail with child resources', params: idParams } }, async (req) => {
    await assertProject(req, req.params.id);
    const project = await one(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
    const [applications, environments, tests, releases] = await Promise.all([
      query(`SELECT * FROM applications WHERE project_id = $1 ORDER BY name`, [req.params.id]),
      query(`SELECT e.*, a.name AS application_name FROM environments e JOIN applications a ON a.id = e.application_id WHERE e.project_id = $1 ORDER BY a.name, e.name`, [req.params.id]),
      query(`SELECT t.id, t.name, t.test_type, t.environment_id, t.application_id FROM performance_tests t WHERE t.project_id = $1 AND t.archived_at IS NULL ORDER BY t.name`, [req.params.id]),
      query(`SELECT * FROM releases WHERE project_id = $1 ORDER BY deployment_date DESC NULLS LAST LIMIT 20`, [req.params.id]),
    ]);
    return { ...project, applications, environments, tests, releases };
  });

  r.patch('/projects/:id', { ...manage, schema: { tags: ['Projects'], summary: 'Update / archive project', params: idParams, body: z.object({ name: z.string().min(1).max(120).optional(), description: opt(z.string().max(2000)), archived: z.boolean().optional() }) } }, async (req) => {
    await assertProject(req, req.params.id);
    const b: any = { ...req.body };
    if (b.archived !== undefined) b.archivedAt = b.archived ? new Date() : null;
    const [sql, params] = updateSql('projects', req.params.id, b, { name: 'name', description: 'description', archivedAt: 'archived_at' });
    const row = await one(sql, params as unknown[]);
    await audit(req, { action: 'project.update', resourceType: 'project', resourceId: row.id, details: req.body });
    return row;
  });

  r.delete('/projects/:id', { ...manage, schema: { tags: ['Projects'], summary: 'Delete project and all its data (requires ?confirm=<project key>)', params: idParams, querystring: z.object({ confirm: z.string().optional() }) } }, async (req) => {
    await assertProject(req, req.params.id);
    const p = await one(`SELECT key FROM projects WHERE id = $1`, [req.params.id]);
    if (req.query.confirm !== p.key) throw badRequest(`Deleting a project removes all its tests, runs and metrics. Confirm with ?confirm=${p.key}`);
    await query(`DELETE FROM projects WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'project.delete', resourceType: 'project', resourceId: req.params.id, details: { key: p.key } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Applications
  const appBody = z.object({
    projectId: z.string().uuid(), code: z.string().min(1).max(60), name: z.string().min(1).max(120), description: opt(z.string().max(2000)),
    owner: opt(z.string().max(120)), team: opt(z.string().max(120)), technology: opt(z.string().max(200)), repository: opt(z.string().max(500)), version: opt(z.string().max(60)),
  });
  r.get('/applications', { ...view, schema: { tags: ['Applications'], summary: 'Application inventory', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    return query(
      `SELECT a.*, p.name AS project_name, p.key AS project_key,
              (SELECT count(*) FROM environments e WHERE e.application_id = a.id)::int AS environments,
              (SELECT array_agg(e.name ORDER BY e.name) FROM environments e WHERE e.application_id = a.id) AS environment_names,
              (SELECT count(*) FROM services s WHERE s.application_id = a.id)::int AS services,
              (SELECT count(*) FROM performance_tests t WHERE t.application_id = a.id AND t.archived_at IS NULL)::int AS tests,
              (SELECT count(*) FROM test_runs r WHERE r.application_id = a.id AND r.deleted_at IS NULL)::int AS runs
       FROM applications a JOIN projects p ON p.id = a.project_id
       WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR a.project_id = $2) AND a.archived_at IS NULL ORDER BY p.name, a.name`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null]);
  });
  r.post('/applications', { ...manage, schema: { tags: ['Applications'], summary: 'Create application', body: appBody } }, async (req, reply) => {
    await assertProject(req, req.body.projectId);
    const b = req.body;
    const row = await one(`INSERT INTO applications (project_id, code, name, description, owner, team, technology, repository, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.projectId, b.code, b.name, b.description ?? null, b.owner ?? null, b.team ?? null, b.technology ?? null, b.repository ?? null, b.version ?? null]);
    await audit(req, { action: 'application.create', resourceType: 'application', resourceId: row.id, details: { code: row.code } });
    reply.code(201);
    return row;
  });
  r.get('/applications/:id', { ...view, schema: { tags: ['Applications'], summary: 'Application detail', params: idParams } }, async (req) => {
    const a = await owned(req, 'applications', req.params.id, 'Application');
    const [environments, services, tests] = await Promise.all([
      query(`SELECT * FROM environments WHERE application_id = $1 ORDER BY name`, [a.id]),
      query(`SELECT s.*, e.name AS environment_name FROM services s LEFT JOIN environments e ON e.id = s.environment_id WHERE s.application_id = $1 ORDER BY s.name`, [a.id]),
      query(`SELECT id, name, test_type, environment_id FROM performance_tests WHERE application_id = $1 AND archived_at IS NULL ORDER BY name`, [a.id]),
    ]);
    return { ...a, environments, services, tests };
  });
  r.patch('/applications/:id', { ...manage, schema: { tags: ['Applications'], summary: 'Update application', params: idParams, body: appBody.omit({ projectId: true }).partial() } }, async (req) => {
    await owned(req, 'applications', req.params.id, 'Application');
    const [sql, params] = updateSql('applications', req.params.id, req.body, { code: 'code', name: 'name', description: 'description', owner: 'owner', team: 'team', technology: 'technology', repository: 'repository', version: 'version' });
    const row = await one(sql, params as unknown[]);
    await audit(req, { action: 'application.update', resourceType: 'application', resourceId: row.id, details: req.body });
    return row;
  });
  r.delete('/applications/:id', { ...manage, schema: { tags: ['Applications'], summary: 'Archive application (soft delete)', params: idParams } }, async (req) => {
    await owned(req, 'applications', req.params.id, 'Application');
    await query(`UPDATE applications SET archived_at = now() WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'application.archive', resourceType: 'application', resourceId: req.params.id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Environments
  const envBody = z.object({ applicationId: z.string().uuid(), name: z.string().min(1).max(80), type: z.enum(ENV_TYPES), description: opt(z.string().max(2000)), baseUrl: opt(z.string().max(500)), config: z.record(z.string(), z.unknown()).optional() });
  r.get('/environments', { ...view, schema: { tags: ['Environments'], summary: 'List environments', querystring: z.object({ projectId: z.string().uuid().optional(), applicationId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    return query(
      `SELECT e.*, a.name AS application_name, p.name AS project_name,
              (SELECT count(*) FROM servers s WHERE s.environment_id = e.id)::int AS servers,
              (SELECT count(*) FROM services s WHERE s.environment_id = e.id)::int AS services,
              (SELECT count(*) FROM services s WHERE s.environment_id = e.id AND s.kind = 'database')::int AS databases,
              (SELECT count(*) FROM test_runs r WHERE r.environment_id = e.id AND r.status = 'RUNNING')::int AS running_runs
       FROM environments e JOIN applications a ON a.id = e.application_id JOIN projects p ON p.id = e.project_id
       WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR e.project_id = $2) AND ($3::uuid IS NULL OR e.application_id = $3) ORDER BY a.name, e.name`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null, req.query.applicationId ?? null]);
  });
  r.post('/environments', { ...manage, schema: { tags: ['Environments'], summary: 'Create environment', body: envBody } }, async (req, reply) => {
    const a = await owned(req, 'applications', req.body.applicationId, 'Application');
    const b = req.body;
    const row = await one(`INSERT INTO environments (project_id, application_id, name, type, description, base_url, config) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.project_id, a.id, b.name, b.type, b.description ?? null, b.baseUrl ?? null, JSON.stringify(b.config ?? {})]);
    await audit(req, { action: 'environment.create', resourceType: 'environment', resourceId: row.id, details: { name: row.name } });
    reply.code(201);
    return row;
  });
  r.get('/environments/:id', { ...view, schema: { tags: ['Environments'], summary: 'Environment detail (servers, services, databases)', params: idParams } }, async (req) => {
    const e = await owned(req, 'environments', req.params.id, 'Environment');
    const [servers, services] = await Promise.all([
      query(`SELECT id, name, hostname, ip_address, os, cpu_cores, memory_mb, disk_gb, role, status, last_seen_at FROM servers WHERE environment_id = $1 ORDER BY name`, [e.id]),
      query(`SELECT * FROM services WHERE environment_id = $1 ORDER BY kind, name`, [e.id]),
    ]);
    return { ...e, servers, services };
  });
  r.patch('/environments/:id', { ...manage, schema: { tags: ['Environments'], summary: 'Update environment', params: idParams, body: envBody.omit({ applicationId: true }).partial() } }, async (req) => {
    await owned(req, 'environments', req.params.id, 'Environment');
    const b: any = { ...req.body, config: req.body.config ? JSON.stringify(req.body.config) : undefined };
    const [sql, params] = updateSql('environments', req.params.id, b, { name: 'name', type: 'type', description: 'description', baseUrl: 'base_url', config: 'config' });
    const row = await one(sql, params as unknown[]);
    await audit(req, { action: 'environment.update', resourceType: 'environment', resourceId: row.id, details: req.body });
    return row;
  });
  r.delete('/environments/:id', { ...manage, schema: { tags: ['Environments'], summary: 'Delete environment (requires ?confirm=true; removes its tests and runs)', params: idParams, querystring: z.object({ confirm: z.coerce.boolean().default(false) }) } }, async (req) => {
    if (!req.query.confirm) throw badRequest('Deleting an environment removes its tests and runs. Confirm with ?confirm=true');
    await owned(req, 'environments', req.params.id, 'Environment');
    await query(`DELETE FROM environments WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'environment.delete', resourceType: 'environment', resourceId: req.params.id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Servers (no credentials are ever stored)
  const serverBody = z.object({
    projectId: z.string().uuid(), environmentId: opt(z.string().uuid()), applicationId: opt(z.string().uuid()), name: z.string().min(1).max(200),
    hostname: opt(z.string().max(255)), ipAddress: opt(z.string().max(64)), os: opt(z.string().max(120)), cpuCores: opt(z.number().int()), memoryMb: opt(z.number().int()), diskGb: opt(z.number().int()),
    role: opt(z.enum(['app', 'db', 'loadgen', 'gateway', 'cache', 'queue', 'other'])), tags: z.record(z.string(), z.string()).optional(),
  });
  r.get('/servers', { ...view, schema: { tags: ['Infrastructure'], summary: 'Server inventory with latest utilisation', querystring: z.object({ projectId: z.string().uuid().optional(), environmentId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    return query(
      `SELECT s.id, s.project_id, s.environment_id, s.application_id, s.name, s.hostname, s.ip_address, s.os, s.cpu_cores, s.memory_mb, s.disk_gb, s.role, s.status, s.tags, s.last_seen_at,
              e.name AS environment_name, a.name AS application_name, m.cpu_pct, m.memory_pct, m.disk_pct, m.ts AS metrics_at
       FROM servers s JOIN projects p ON p.id = s.project_id LEFT JOIN environments e ON e.id = s.environment_id LEFT JOIN applications a ON a.id = s.application_id
       LEFT JOIN LATERAL (SELECT cpu_pct, memory_pct, disk_pct, ts FROM server_metrics sm WHERE sm.server_id = s.id ORDER BY ts DESC LIMIT 1) m ON true
       WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR s.project_id = $2) AND ($3::uuid IS NULL OR s.environment_id = $3) ORDER BY e.name NULLS LAST, s.name`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null, req.query.environmentId ?? null]);
  });
  r.post('/servers', { ...manage, schema: { tags: ['Infrastructure'], summary: 'Register server', body: serverBody } }, async (req, reply) => {
    await assertProject(req, req.body.projectId);
    const b = req.body;
    const row = await one(`INSERT INTO servers (project_id, environment_id, application_id, name, hostname, ip_address, os, cpu_cores, memory_mb, disk_gb, role, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.projectId, b.environmentId ?? null, b.applicationId ?? null, b.name, b.hostname ?? null, b.ipAddress ?? null, b.os ?? null, b.cpuCores ?? null, b.memoryMb ?? null, b.diskGb ?? null, b.role ?? null, JSON.stringify(b.tags ?? {})]);
    await audit(req, { action: 'server.create', resourceType: 'server', resourceId: row.id });
    reply.code(201);
    return row;
  });
  r.patch('/servers/:id', { ...manage, schema: { tags: ['Infrastructure'], summary: 'Update server', params: idParams, body: serverBody.omit({ projectId: true }).partial() } }, async (req) => {
    await owned(req, 'servers', req.params.id, 'Server');
    const b: any = { ...req.body, tags: req.body.tags ? JSON.stringify(req.body.tags) : undefined };
    const [sql, params] = updateSql('servers', req.params.id, b, { environmentId: 'environment_id', applicationId: 'application_id', name: 'name', hostname: 'hostname', ipAddress: 'ip_address', os: 'os', cpuCores: 'cpu_cores', memoryMb: 'memory_mb', diskGb: 'disk_gb', role: 'role', tags: 'tags' });
    return one(sql, params as unknown[]);
  });
  r.delete('/servers/:id', { ...manage, schema: { tags: ['Infrastructure'], summary: 'Remove server (and its metrics)', params: idParams, querystring: z.object({ confirm: z.coerce.boolean().default(false) }) } }, async (req) => {
    if (!req.query.confirm) throw badRequest('Removing a server deletes its metric history. Confirm with ?confirm=true');
    await owned(req, 'servers', req.params.id, 'Server');
    await query(`DELETE FROM servers WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'server.delete', resourceType: 'server', resourceId: req.params.id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Services + dependencies (service map)
  const serviceBody = z.object({ projectId: z.string().uuid(), applicationId: opt(z.string().uuid()), environmentId: opt(z.string().uuid()), serverId: opt(z.string().uuid()), name: z.string().min(1).max(200), kind: z.enum(['loadgen', 'gateway', 'service', 'database', 'cache', 'queue', 'external']), technology: opt(z.string().max(120)), dependsOn: z.array(z.string().uuid()).optional() });
  r.get('/services', { ...view, schema: { tags: ['Infrastructure'], summary: 'Services with dependencies', querystring: z.object({ projectId: z.string().uuid().optional(), environmentId: z.string().uuid().optional(), kind: z.string().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(
      `SELECT s.*, e.name AS environment_name, a.name AS application_name,
              COALESCE((SELECT array_agg(target_service_id) FROM service_dependencies d WHERE d.source_service_id = s.id), '{}') AS depends_on
       FROM services s JOIN projects p ON p.id = s.project_id LEFT JOIN environments e ON e.id = s.environment_id LEFT JOIN applications a ON a.id = s.application_id
       WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR s.project_id = $2) AND ($3::uuid IS NULL OR s.environment_id = $3) AND ($4::text IS NULL OR s.kind = $4) ORDER BY s.kind, s.name`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null, req.query.environmentId ?? null, req.query.kind ?? null]);
    return rows;
  });
  r.post('/services', { ...manage, schema: { tags: ['Infrastructure'], summary: 'Create service', body: serviceBody } }, async (req, reply) => {
    await assertProject(req, req.body.projectId);
    const b = req.body;
    const row = await tx(async (c) => {
      const s = await one(`INSERT INTO services (project_id, application_id, environment_id, server_id, name, kind, technology) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.projectId, b.applicationId ?? null, b.environmentId ?? null, b.serverId ?? null, b.name, b.kind, b.technology ?? null], c);
      for (const t of b.dependsOn ?? []) await c.query(`INSERT INTO service_dependencies (source_service_id, target_service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [s.id, t]);
      return s;
    });
    reply.code(201);
    return row;
  });
  r.patch('/services/:id', { ...manage, schema: { tags: ['Infrastructure'], summary: 'Update service / dependencies', params: idParams, body: serviceBody.omit({ projectId: true }).partial() } }, async (req) => {
    await owned(req, 'services', req.params.id, 'Service');
    const { dependsOn, ...rest } = req.body;
    if (Object.keys(rest).length) {
      const [sql, params] = updateSql('services', req.params.id, rest, { applicationId: 'application_id', environmentId: 'environment_id', serverId: 'server_id', name: 'name', kind: 'kind', technology: 'technology' });
      await query(sql, params as unknown[]);
    }
    if (dependsOn) {
      await query(`DELETE FROM service_dependencies WHERE source_service_id = $1`, [req.params.id]);
      for (const t of dependsOn) await query(`INSERT INTO service_dependencies (source_service_id, target_service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, t]);
    }
    return one(`SELECT * FROM services WHERE id = $1`, [req.params.id]);
  });
  r.delete('/services/:id', { ...manage, schema: { tags: ['Infrastructure'], summary: 'Delete service', params: idParams } }, async (req) => {
    await owned(req, 'services', req.params.id, 'Service');
    await query(`DELETE FROM services WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  // ------------------------------------------------------------------ Performance tests + versioned load profile
  const loadProfile = z.object({
    virtualUsers: opt(z.number().int().min(0)), rampUpSec: opt(z.number().int().min(0)), rampDownSec: opt(z.number().int().min(0)), durationSec: opt(z.number().int().min(0)),
    targetTps: opt(z.number().min(0)), threadGroup: opt(z.string().max(200)), thinkTimeMs: opt(z.number().int().min(0)), properties: z.record(z.string(), z.unknown()).optional(),
  });
  const testBody = z.object({
    applicationId: z.string().uuid(), environmentId: z.string().uuid(), name: z.string().min(1).max(200), description: opt(z.string().max(5000)),
    testType: z.enum(TEST_TYPES).default('LOAD'), slaProfileId: opt(z.string().uuid()), owner: opt(z.string().max(120)), tags: z.array(z.string().max(60)).max(30).optional(),
    loadProfile: loadProfile.optional(),
  });

  const testSelect = `
    SELECT t.*, a.name AS application_name, e.name AS environment_name, e.type AS environment_type, p.name AS project_name, sp.name AS sla_profile_name,
           c.version AS config_version, c.virtual_users, c.ramp_up_sec, c.ramp_down_sec, c.duration_sec, c.target_tps, c.thread_group, c.think_time_ms, c.jmx_artifact_id,
           (SELECT count(*) FROM test_runs r WHERE r.test_id = t.id AND r.deleted_at IS NULL)::int AS run_count,
           lr.run_key AS last_run_key, lr.status AS last_run_status, lr.result AS last_run_result, lr.started_at AS last_run_at,
           br.run_key AS baseline_run_key
    FROM performance_tests t JOIN applications a ON a.id = t.application_id JOIN environments e ON e.id = t.environment_id JOIN projects p ON p.id = t.project_id
    LEFT JOIN sla_profiles sp ON sp.id = t.sla_profile_id
    LEFT JOIN test_configurations c ON c.test_id = t.id AND c.is_current
    LEFT JOIN test_runs br ON br.id = t.baseline_run_id
    LEFT JOIN LATERAL (SELECT run_key, status, result, started_at FROM test_runs r WHERE r.test_id = t.id AND r.deleted_at IS NULL ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1) lr ON true`;

  r.get('/tests', { ...view, schema: { tags: ['Performance Tests'], summary: 'List performance tests', querystring: z.object({ projectId: z.string().uuid().optional(), applicationId: z.string().uuid().optional(), environmentId: z.string().uuid().optional(), q: z.string().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    return query(`${testSelect} WHERE p.organization_id = $1 AND t.archived_at IS NULL AND ($2::uuid IS NULL OR t.project_id = $2) AND ($3::uuid IS NULL OR t.application_id = $3)
                  AND ($4::uuid IS NULL OR t.environment_id = $4) AND ($5::text IS NULL OR t.name ILIKE '%' || $5 || '%' OR $5 = ANY(t.tags)) ORDER BY t.name`,
      [p.orgId, q.projectId ?? p.projectId ?? null, q.applicationId ?? null, q.environmentId ?? null, q.q ?? null]);
  });

  r.post('/tests', { preHandler: requirePermission('CREATE_TEST'), schema: { tags: ['Performance Tests'], summary: 'Create performance test (with initial load profile)', body: testBody } }, async (req, reply) => {
    const p = principalOf(req);
    const env = await owned(req, 'environments', req.body.environmentId, 'Environment');
    if (env.application_id !== req.body.applicationId) throw badRequest('Environment does not belong to the selected application');
    const b = req.body;
    const row = await tx(async (c) => {
      const t = await one(`INSERT INTO performance_tests (project_id, application_id, environment_id, name, description, test_type, sla_profile_id, owner, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [env.project_id, b.applicationId, b.environmentId, b.name, b.description ?? null, b.testType, b.slaProfileId ?? null, b.owner ?? null, b.tags ?? [], p.kind === 'user' ? p.id : null], c);
      const lp = b.loadProfile ?? {};
      await c.query(`INSERT INTO test_configurations (test_id, version, virtual_users, ramp_up_sec, ramp_down_sec, duration_sec, target_tps, thread_group, think_time_ms, properties, created_by) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.id, lp.virtualUsers ?? null, lp.rampUpSec ?? null, lp.rampDownSec ?? null, lp.durationSec ?? null, lp.targetTps ?? null, lp.threadGroup ?? null, lp.thinkTimeMs ?? null, JSON.stringify(lp.properties ?? {}), p.kind === 'user' ? p.id : null]);
      return t;
    });
    await audit(req, { action: 'test.create', resourceType: 'test', resourceId: row.id, details: { name: row.name } });
    reply.code(201);
    return one(`${testSelect} WHERE t.id = $1`, [row.id]);
  });

  r.get('/tests/:id', { ...view, schema: { tags: ['Performance Tests'], summary: 'Test detail: configuration history, recent runs, test data (masked)', params: idParams } }, async (req) => {
    await owned(req, 'performance_tests', req.params.id, 'Performance test');
    const t = await one(`${testSelect} WHERE t.id = $1`, [req.params.id]);
    const [configurations, runs, testData] = await Promise.all([
      query(`SELECT * FROM test_configurations WHERE test_id = $1 ORDER BY version DESC`, [t.id]),
      query(`SELECT r.id, r.run_key, r.status, r.result, r.build_number, r.started_at, r.ended_at, r.performance_score, r.is_baseline, s.tps_avg, s.p95, s.error_pct
             FROM test_runs r LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 ELSE 2 END LIMIT 1) s ON true
             WHERE r.test_id = $1 AND r.deleted_at IS NULL ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 25`, [t.id]),
      query(`SELECT id, key, CASE WHEN is_sensitive THEN '••••••••' ELSE value END AS value, is_sensitive, created_at FROM test_data WHERE test_id = $1 ORDER BY key`, [t.id]),
    ]);
    return { ...t, configurations, runs, testData };
  });

  r.patch('/tests/:id', { preHandler: requirePermission('EDIT_TEST'), schema: { tags: ['Performance Tests'], summary: 'Update test; a changed load profile creates a new configuration version', params: idParams, body: testBody.omit({ applicationId: true, environmentId: true }).partial() } }, async (req) => {
    const p = principalOf(req);
    await owned(req, 'performance_tests', req.params.id, 'Performance test');
    const { loadProfile: lp, ...rest } = req.body;
    if (Object.keys(rest).length) {
      const [sql, params] = updateSql('performance_tests', req.params.id, rest, { name: 'name', description: 'description', testType: 'test_type', slaProfileId: 'sla_profile_id', owner: 'owner', tags: 'tags' });
      await query(sql, params as unknown[]);
    }
    if (lp) {
      await tx(async (c) => {
        const cur = await one(`SELECT * FROM test_configurations WHERE test_id = $1 AND is_current ORDER BY version DESC LIMIT 1`, [req.params.id], c);
        await c.query(`UPDATE test_configurations SET is_current = false WHERE test_id = $1`, [req.params.id]);
        await c.query(`INSERT INTO test_configurations (test_id, version, virtual_users, ramp_up_sec, ramp_down_sec, duration_sec, target_tps, thread_group, think_time_ms, jmx_artifact_id, properties, created_by)
                       VALUES ($1, COALESCE((SELECT max(version) FROM test_configurations WHERE test_id = $1),0) + 1, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [req.params.id, lp.virtualUsers ?? cur?.virtual_users ?? null, lp.rampUpSec ?? cur?.ramp_up_sec ?? null, lp.rampDownSec ?? cur?.ramp_down_sec ?? null, lp.durationSec ?? cur?.duration_sec ?? null,
            lp.targetTps ?? cur?.target_tps ?? null, lp.threadGroup ?? cur?.thread_group ?? null, lp.thinkTimeMs ?? cur?.think_time_ms ?? null, cur?.jmx_artifact_id ?? null, JSON.stringify(lp.properties ?? cur?.properties ?? {}), p.kind === 'user' ? p.id : null]);
      });
    }
    await audit(req, { action: 'test.update', resourceType: 'test', resourceId: req.params.id, details: req.body });
    return one(`${testSelect} WHERE t.id = $1`, [req.params.id]);
  });

  r.delete('/tests/:id', { preHandler: requirePermission('DELETE_TEST'), schema: { tags: ['Performance Tests'], summary: 'Archive test (runs are kept)', params: idParams } }, async (req) => {
    await owned(req, 'performance_tests', req.params.id, 'Performance test');
    await query(`UPDATE performance_tests SET archived_at = now() WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'test.archive', resourceType: 'test', resourceId: req.params.id });
    return { ok: true };
  });

  r.put('/tests/:id/data', {
    preHandler: requirePermission('EDIT_TEST'),
    schema: { tags: ['Performance Tests'], summary: 'Set test metadata/data (sensitive values are encrypted and never returned)', params: idParams, body: z.object({ items: z.array(z.object({ key: z.string().min(1).max(120), value: z.string().max(5000).nullable(), isSensitive: z.boolean().default(false) })).max(200) }) },
  }, async (req) => {
    await owned(req, 'performance_tests', req.params.id, 'Performance test');
    const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|credential|private/i;
    await tx(async (c) => {
      for (const it of req.body.items) {
        const sensitive = it.isSensitive || SENSITIVE_KEY.test(it.key);
        await c.query(`INSERT INTO test_data (test_id, key, value, is_sensitive) VALUES ($1,$2,$3,$4) ON CONFLICT (test_id, key) DO UPDATE SET value = EXCLUDED.value, is_sensitive = EXCLUDED.is_sensitive`,
          [req.params.id, it.key, it.value == null ? null : sensitive ? encryptSecret(it.value) : it.value, sensitive]);
      }
    });
    await audit(req, { action: 'test.data_update', resourceType: 'test', resourceId: req.params.id, details: { keys: req.body.items.map((i) => i.key) } });
    return query(`SELECT id, key, CASE WHEN is_sensitive THEN '••••••••' ELSE value END AS value, is_sensitive FROM test_data WHERE test_id = $1 ORDER BY key`, [req.params.id]);
  });

  // ------------------------------------------------------------------ Releases & builds
  const releaseBody = z.object({ projectId: z.string().uuid(), applicationId: opt(z.string().uuid()), environmentId: opt(z.string().uuid()), name: z.string().min(1).max(120), version: z.string().min(1).max(60), buildNumber: opt(z.string().max(60)), branch: opt(z.string().max(200)), commit: opt(z.string().max(100)), deploymentDate: opt(z.string()), notes: opt(z.string().max(5000)) });
  r.get('/releases', { ...view, schema: { tags: ['Releases'], summary: 'Releases with associated runs', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    return query(
      `SELECT rl.*, a.name AS application_name, e.name AS environment_name,
              (SELECT count(*) FROM test_runs r WHERE r.release_id = rl.id AND r.deleted_at IS NULL)::int AS run_count,
              (SELECT count(*) FROM test_runs r WHERE r.release_id = rl.id AND r.result = 'FAIL')::int AS failed_runs,
              (SELECT array_agg(DISTINCT t.name) FROM test_runs r JOIN performance_tests t ON t.id = r.test_id WHERE r.release_id = rl.id) AS tests
       FROM releases rl JOIN projects p ON p.id = rl.project_id LEFT JOIN applications a ON a.id = rl.application_id LEFT JOIN environments e ON e.id = rl.environment_id
       WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR rl.project_id = $2) ORDER BY rl.deployment_date DESC NULLS LAST, rl.created_at DESC`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null]);
  });
  r.post('/releases', { ...manage, schema: { tags: ['Releases'], summary: 'Create release', body: releaseBody } }, async (req, reply) => {
    await assertProject(req, req.body.projectId);
    const b = req.body;
    const row = await one(`INSERT INTO releases (project_id, application_id, environment_id, name, version, build_number, branch, commit_sha, deployment_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.projectId, b.applicationId ?? null, b.environmentId ?? null, b.name, b.version, b.buildNumber ?? null, b.branch ?? null, b.commit ?? null, b.deploymentDate ? new Date(b.deploymentDate) : null, b.notes ?? null]);
    if (row.deployment_date) {
      await query(`INSERT INTO events (project_id, application_id, environment_id, type, ts, title, source, data) VALUES ($1,$2,$3,'DEPLOYMENT',$4,$5,'releases',$6)`,
        [row.project_id, row.application_id, row.environment_id, row.deployment_date, `Deployed ${row.name} ${row.version}`, JSON.stringify({ releaseId: row.id })]);
    }
    await audit(req, { action: 'release.create', resourceType: 'release', resourceId: row.id, details: { version: row.version } });
    reply.code(201);
    return row;
  });
  r.get('/releases/:id', { ...view, schema: { tags: ['Releases'], summary: 'Release detail with runs and builds', params: idParams } }, async (req) => {
    const rl = await owned(req, 'releases', req.params.id, 'Release');
    const [runs, builds] = await Promise.all([
      query(`SELECT r.id, r.run_key, r.status, r.result, r.build_number, r.started_at, t.name AS test_name, s.p95, s.tps_avg, s.error_pct FROM test_runs r JOIN performance_tests t ON t.id = r.test_id
             LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 ELSE 2 END LIMIT 1) s ON true
             WHERE r.release_id = $1 AND r.deleted_at IS NULL ORDER BY r.started_at DESC`, [rl.id]),
      query(`SELECT * FROM builds WHERE release_id = $1 ORDER BY created_at DESC`, [rl.id]),
    ]);
    return { ...rl, runs, builds };
  });
  r.patch('/releases/:id', { ...manage, schema: { tags: ['Releases'], summary: 'Update release', params: idParams, body: releaseBody.omit({ projectId: true }).partial() } }, async (req) => {
    await owned(req, 'releases', req.params.id, 'Release');
    const b: any = { ...req.body, deploymentDate: req.body.deploymentDate ? new Date(req.body.deploymentDate) : req.body.deploymentDate };
    const [sql, params] = updateSql('releases', req.params.id, b, { applicationId: 'application_id', environmentId: 'environment_id', name: 'name', version: 'version', buildNumber: 'build_number', branch: 'branch', commit: 'commit_sha', deploymentDate: 'deployment_date', notes: 'notes' });
    return one(sql.replace(', updated_at = now()', ''), params as unknown[]);
  });
  r.delete('/releases/:id', { ...manage, schema: { tags: ['Releases'], summary: 'Delete release (runs are kept, unlinked)', params: idParams } }, async (req) => {
    await owned(req, 'releases', req.params.id, 'Release');
    await query(`DELETE FROM releases WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'release.delete', resourceType: 'release', resourceId: req.params.id });
    return { ok: true };
  });
  r.get('/builds', { ...view, schema: { tags: ['Releases'], summary: 'Builds', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    return query(`SELECT b.*, rl.version AS release_version, (SELECT count(*) FROM test_runs r WHERE r.build_id = b.id)::int AS run_count FROM builds b JOIN projects p ON p.id = b.project_id LEFT JOIN releases rl ON rl.id = b.release_id
                  WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR b.project_id = $2) ORDER BY b.created_at DESC LIMIT 500`, [p.orgId, req.query.projectId ?? null]);
  });

  // ------------------------------------------------------------------ SLA profiles & rules
  const ruleBody = z.object({
    name: opt(z.string().max(120)), metric: z.enum(Object.keys(SLA_METRICS) as [string, ...string[]]), scope: z.enum(['RUN', 'TRANSACTION']).default('RUN'), transactionPattern: opt(z.string().max(200)),
    direction: z.enum(['LOWER', 'HIGHER']).optional(), warningValue: opt(z.number()), criticalValue: opt(z.number()), unit: opt(z.string().max(20)), enabled: z.boolean().default(true),
  }).refine((r) => r.warningValue != null || r.criticalValue != null, 'Provide a warning and/or critical threshold');
  r.get('/sla/metrics', { ...view, schema: { tags: ['SLA'], summary: 'Supported SLA metrics' } }, async () => SLA_METRICS);
  r.get('/sla/profiles', { ...view, schema: { tags: ['SLA'], summary: 'SLA profiles with rules', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const profiles = await query(`SELECT sp.*, (SELECT count(*) FROM performance_tests t WHERE t.sla_profile_id = sp.id)::int AS test_count FROM sla_profiles sp JOIN projects p ON p.id = sp.project_id
                                  WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR sp.project_id = $2) ORDER BY sp.name`, [p.orgId, req.query.projectId ?? p.projectId ?? null]);
    const rules = profiles.length ? await query(`SELECT * FROM sla_rules WHERE profile_id = ANY($1::uuid[]) ORDER BY position, metric`, [profiles.map((x) => x.id)]) : [];
    return profiles.map((pr) => ({ ...pr, rules: rules.filter((r) => r.profile_id === pr.id) }));
  });
  const saveRules = async (client: any, profileId: string, rules: z.infer<typeof ruleBody>[]) => {
    await client.query(`DELETE FROM sla_rules WHERE profile_id = $1`, [profileId]);
    let i = 0;
    for (const rl of rules) {
      await client.query(`INSERT INTO sla_rules (profile_id, name, metric, scope, transaction_pattern, direction, warning_value, critical_value, unit, enabled, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [profileId, rl.name ?? null, rl.metric, rl.scope, rl.transactionPattern ?? null, rl.direction ?? SLA_METRICS[rl.metric].direction, rl.warningValue ?? null, rl.criticalValue ?? null, rl.unit ?? SLA_METRICS[rl.metric].unit, rl.enabled, i++]);
    }
  };
  r.post('/sla/profiles', { preHandler: requirePermission('CONFIGURE_SLA'), schema: { tags: ['SLA'], summary: 'Create SLA profile', body: z.object({ projectId: z.string().uuid(), name: z.string().min(1).max(120), description: opt(z.string().max(2000)), rules: z.array(ruleBody).max(100).default([]) }) } }, async (req, reply) => {
    await assertProject(req, req.body.projectId);
    const row = await tx(async (c) => {
      const sp = await one(`INSERT INTO sla_profiles (project_id, name, description) VALUES ($1,$2,$3) RETURNING *`, [req.body.projectId, req.body.name, req.body.description ?? null], c);
      await saveRules(c, sp.id, req.body.rules);
      return sp;
    });
    await audit(req, { action: 'sla.create', resourceType: 'sla_profile', resourceId: row.id, details: { name: row.name, rules: req.body.rules.length } });
    reply.code(201);
    return { ...row, rules: await query(`SELECT * FROM sla_rules WHERE profile_id = $1 ORDER BY position`, [row.id]) };
  });
  r.put('/sla/profiles/:id', { preHandler: requirePermission('CONFIGURE_SLA'), schema: { tags: ['SLA'], summary: 'Replace SLA profile and rules', params: idParams, body: z.object({ name: z.string().min(1).max(120), description: opt(z.string().max(2000)), rules: z.array(ruleBody).max(100) }) } }, async (req) => {
    const before = await owned(req, 'sla_profiles', req.params.id, 'SLA profile');
    const oldRules = await query(`SELECT metric, scope, warning_value, critical_value FROM sla_rules WHERE profile_id = $1`, [req.params.id]);
    await tx(async (c) => {
      await c.query(`UPDATE sla_profiles SET name = $2, description = $3, updated_at = now() WHERE id = $1`, [req.params.id, req.body.name, req.body.description ?? null]);
      await saveRules(c, req.params.id, req.body.rules);
    });
    await audit(req, { action: 'sla.update', resourceType: 'sla_profile', resourceId: req.params.id, details: { before: { name: before.name, rules: oldRules }, after: req.body } });
    return { ...(await one(`SELECT * FROM sla_profiles WHERE id = $1`, [req.params.id])), rules: await query(`SELECT * FROM sla_rules WHERE profile_id = $1 ORDER BY position`, [req.params.id]) };
  });
  r.delete('/sla/profiles/:id', { preHandler: requirePermission('CONFIGURE_SLA'), schema: { tags: ['SLA'], summary: 'Delete SLA profile', params: idParams } }, async (req) => {
    await owned(req, 'sla_profiles', req.params.id, 'SLA profile');
    await query(`DELETE FROM sla_profiles WHERE id = $1`, [req.params.id]);
    await audit(req, { action: 'sla.delete', resourceType: 'sla_profile', resourceId: req.params.id });
    return { ok: true };
  });
}
