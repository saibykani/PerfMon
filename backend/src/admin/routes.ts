import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query, pool, tsPool } from '../db/pool.js';
import { requirePermission, principalOf, invalidateUserCache } from '../auth/principal.js';
import { PERMISSIONS, ROLES } from '../auth/rbac.js';
import { audit } from '../audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { typed, z, idParams, assertProject, toCsv } from '../lib/http.js';
import { generateApiKey, randomToken, sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { DEFAULT_SETTINGS, allSettings, getSetting, setSetting, type SettingKey } from '../analytics/settings.js';
import { selfMetrics } from '../selfmon/registry.js';
import { liveConnections } from '../live/hub.js';
import { storage } from '../storage/storage.js';
import { aggregator } from '../ingest/aggregator.js';
import { sendEmail } from '../alerts/email.js';

const BCRYPT_COST = 10;
const PASSWORD_RULE = z.string().min(8, 'Password must be at least 8 characters').max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and digits');

// ------------------------------------------------------------------ settings validation
const pct = z.number().min(0).max(1000);
const SETTING_SCHEMAS: Record<SettingKey, z.ZodTypeAny> = {
  score_weights: z.object({ sla: pct, responseTime: pct, throughput: pct, errorRate: pct, infrastructure: pct, regression: pct }).partial()
    .refine((w) => Object.values(w).some((v) => (v as number) > 0), 'At least one weight must be > 0'),
  regression_thresholds: z.object({
    p95Pct: pct, p99Pct: pct, avgPct: pct, tpsDropPct: pct, errorRateIncreasePts: pct, cpuIncreasePts: pct, memoryIncreasePts: pct,
    minTransactionSamples: z.number().int().min(0).max(1e9), minAbsoluteMs: z.number().min(0).max(1e6),
  }).partial(),
  default_result_thresholds: z.object({ errorPctFail: z.number().min(0).max(100), errorPctWarn: z.number().min(0).max(100) }).partial(),
  retention: z.object({
    rawMetricsDays: z.number().int().min(1).max(36500), aggregatedMetricsDays: z.number().int().min(1).max(36500), artifactsDays: z.number().int().min(1).max(36500),
    reportsDays: z.number().int().min(1).max(36500), logsDays: z.number().int().min(1).max(36500), auditDays: z.number().int().min(30).max(36500),
  }).partial(),
  live: z.object({ defaultRefreshSec: z.number().int().min(1).max(3600) }).partial(),
};

// ------------------------------------------------------------------ retention
type RetentionKey = keyof typeof DEFAULT_SETTINGS.retention;
interface RetentionType { dataType: string; label: string; setting: RetentionKey; tables: { table: string; where: string; db?: 'ts' }[] }

/** Org-scoped retention catalogue. `where` uses $1 = organization id, $2 = cutoff. */
const RUN_SCOPE = `run_id IN (SELECT id FROM test_runs WHERE organization_id = $1)`;
const RETENTION_TYPES: RetentionType[] = [
  {
    dataType: 'raw_metrics', label: 'Per-second load-test and infrastructure metrics', setting: 'rawMetricsDays',
    tables: [
      ...['run_metrics', 'transaction_metrics', 'api_metrics', 'response_code_metrics', 'error_metrics'].map((t) => ({ table: t, where: `ts < $2 AND ${RUN_SCOPE}`, db: 'ts' as const })),
      ...['server_metrics', 'jvm_metrics', 'database_metrics', 'service_metrics'].map((t) => ({
        table: t, db: 'ts' as const,
        where: `ts < $2 AND (${RUN_SCOPE} OR (run_id IS NULL AND ${t === 'service_metrics' ? 'service_id IN (SELECT s.id FROM services s JOIN projects p ON p.id = s.project_id WHERE p.organization_id = $1)' : t === 'server_metrics' ? 'server_id IN (SELECT s.id FROM servers s JOIN projects p ON p.id = s.project_id WHERE p.organization_id = $1)' : '(server_id IN (SELECT s.id FROM servers s JOIN projects p ON p.id = s.project_id WHERE p.organization_id = $1) OR service_id IN (SELECT s.id FROM services s JOIN projects p ON p.id = s.project_id WHERE p.organization_id = $1))'}))`,
      })),
      { table: 'metric_points', where: `ts < $2 AND project_id IN (SELECT id FROM projects WHERE organization_id = $1)`, db: 'ts' },
    ],
  },
  {
    dataType: 'aggregated_metrics', label: 'Run summaries, transaction statistics and analysis results', setting: 'aggregatedMetricsDays',
    tables: ['run_summary', 'transactions', 'sla_results', 'regressions', 'recommendations', 'insights'].map((t) => ({
      table: t, where: `run_id IN (SELECT id FROM test_runs WHERE organization_id = $1 AND COALESCE(ended_at, started_at, created_at) < $2)`,
    })),
  },
  { dataType: 'artifacts', label: 'Artifacts (files in object storage + metadata)', setting: 'artifactsDays', tables: [{ table: 'artifacts', where: `created_at < $2 AND project_id IN (SELECT id FROM projects WHERE organization_id = $1)` }] },
  { dataType: 'reports', label: 'Generated reports', setting: 'reportsDays', tables: [{ table: 'reports', where: `created_at < $2 AND project_id IN (SELECT id FROM projects WHERE organization_id = $1)` }] },
  { dataType: 'logs', label: 'Indexed log entries', setting: 'logsDays', tables: [{ table: 'log_entries', where: `ts < $2 AND (${RUN_SCOPE} OR application_id IN (SELECT a.id FROM applications a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1))` }] },
  { dataType: 'audit', label: 'Audit log', setting: 'auditDays', tables: [{ table: 'audit_logs', where: `ts < $2 AND organization_id = $1` }] },
];
const BATCH = 5000;

async function retentionEstimate(orgId: string, t: RetentionType, cutoff: Date) {
  let rows = 0;
  for (const tb of t.tables) {
    const r = await one(`SELECT count(*)::bigint n FROM ${tb.table} WHERE ${tb.where}`, [orgId, cutoff], tb.db === 'ts' ? tsPool : pool);
    rows += Number(r?.n ?? 0);
  }
  return rows;
}

async function cutoffFor(orgId: string, t: RetentionType) {
  const ret = await getSetting(orgId, 'retention');
  const days = Number((ret as any)[t.setting]);
  return { days, cutoff: new Date(Date.now() - days * 86400000) };
}

/** Executes a confirmed purge in batches. Artifacts: storage objects are removed before their rows. */
async function executePurge(orgId: string, t: RetentionType, cutoff: Date) {
  let deleted = 0;
  const perTable: Record<string, number> = {};
  if (t.dataType === 'artifacts') {
    let storageObjects = 0;
    for (;;) {
      const batch = await query(`SELECT id FROM artifacts WHERE ${t.tables[0].where} LIMIT 200`, [orgId, cutoff]);
      if (!batch.length) break;
      const ids = batch.map((b) => b.id);
      const versions = await query(`SELECT storage_key, extracted_prefix FROM artifact_versions WHERE artifact_id = ANY($1::uuid[])`, [ids]);
      for (const v of versions) {
        try { await storage.delete(v.storage_key); storageObjects++; } catch (e) { console.error('[retention] storage delete failed', v.storage_key, (e as Error).message); }
        if (v.extracted_prefix) { try { storageObjects += await storage.deletePrefix(v.extracted_prefix); } catch { /* best effort */ } }
      }
      await query(`DELETE FROM artifacts WHERE id = ANY($1::uuid[])`, [ids]);
      deleted += ids.length;
    }
    perTable.artifacts = deleted;
    perTable.storage_objects = storageObjects;
    return { deleted, perTable };
  }
  for (const tb of t.tables) {
    let n = 0;
    for (;;) {
      const res = await (tb.db === 'ts' ? tsPool : pool).query(`DELETE FROM ${tb.table} WHERE ctid IN (SELECT ctid FROM ${tb.table} WHERE ${tb.where} LIMIT ${BATCH})`, [orgId, cutoff]);
      n += res.rowCount ?? 0;
      if ((res.rowCount ?? 0) < BATCH) break;
    }
    perTable[tb.table] = n;
    deleted += n;
  }
  return { deleted, perTable };
}

// ------------------------------------------------------------------ DTOs
const userDto = (u: any) => ({
  id: u.id, email: u.email, name: u.name, isActive: u.is_active, roles: (u.roles ?? []).filter(Boolean), lastLoginAt: u.last_login_at, createdAt: u.created_at,
  updatedAt: u.updated_at, lockedUntil: u.locked_until, failedLoginCount: u.failed_login_count, preferredView: u.preferred_view,
});
const keyDto = (k: any) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, projectId: k.project_id, projectName: k.project_name ?? null, rateLimitPerSec: k.rate_limit_per_sec,
  createdAt: k.created_at, expiresAt: k.expires_at, revokedAt: k.revoked_at, lastUsedAt: k.last_used_at, createdByName: k.created_by_name ?? null,
  rotatedFromId: k.rotated_from_id, status: k.revoked_at ? 'REVOKED' : k.expires_at && new Date(k.expires_at) <= new Date() ? 'EXPIRED' : 'ACTIVE',
});
const KEY_SELECT = `SELECT k.*, u.name AS created_by_name, p.name AS project_name FROM api_keys k LEFT JOIN users u ON u.id = k.created_by LEFT JOIN projects p ON p.id = k.project_id`;
const USER_SELECT = `SELECT u.*, array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL) AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id`;

async function ownedUser(req: FastifyRequest, id: string) {
  const u = await one(`${USER_SELECT} WHERE u.id = $1 AND u.organization_id = $2 GROUP BY u.id`, [id, principalOf(req).orgId]);
  if (!u) throw notFound('User', id);
  return u;
}

/** Only SUPER_ADMINs may grant/revoke SUPER_ADMIN; the last active SUPER_ADMIN cannot be demoted or deactivated. */
async function guardRoles(req: FastifyRequest, target: any | null, newRoles: string[] | undefined, deactivate: boolean) {
  const p = principalOf(req);
  const unknown = (newRoles ?? []).filter((r) => !ROLES[r]);
  if (unknown.length) throw badRequest(`Unknown role(s): ${unknown.join(', ')}`);
  const touchesSuper = (newRoles?.includes('SUPER_ADMIN') ?? false) !== (target?.roles ?? []).includes('SUPER_ADMIN') && newRoles !== undefined;
  if ((touchesSuper || (deactivate && (target?.roles ?? []).includes('SUPER_ADMIN'))) && !p.roles.includes('SUPER_ADMIN')) throw forbidden('Only a SUPER_ADMIN can grant, revoke or deactivate SUPER_ADMIN accounts');
  if (target && (target.roles ?? []).includes('SUPER_ADMIN') && (deactivate || (newRoles && !newRoles.includes('SUPER_ADMIN')))) {
    const others = await one(`SELECT count(*)::int n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
                              WHERE r.name = 'SUPER_ADMIN' AND u.is_active AND u.organization_id = $1 AND u.id <> $2`, [p.orgId, target.id]);
    if (!others?.n) throw conflict('This is the last active SUPER_ADMIN; assign another SUPER_ADMIN first');
  }
}

async function setRoles(userId: string, roles: string[]) {
  await query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  if (roles.length) await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = ANY($2)`, [userId, roles]);
}

async function issueResetLink(userId: string, hours: number) {
  const token = randomToken(32);
  await query(`UPDATE users SET password_reset_token_hash = $2, password_reset_expires_at = now() + make_interval(hours => $3) WHERE id = $1`, [userId, sha256(token), hours]);
  return { link: `${config.publicUrl.replace(/\/$/, '')}/reset-password?token=${token}`, expiresAt: new Date(Date.now() + hours * 3600000) };
}

// process CPU % between health calls
let cpuPrev = { t: process.hrtime.bigint(), u: process.cpuUsage() };
function processCpuPct() {
  const t = process.hrtime.bigint();
  const u = process.cpuUsage();
  const elapsedUs = Number(t - cpuPrev.t) / 1000;
  const used = (u.user - cpuPrev.u.user) + (u.system - cpuPrev.u.system);
  cpuPrev = { t, u };
  return elapsedUs > 0 ? Math.round((used / elapsedUs) * 1000) / 10 : null;
}

const r1 = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

const auditQuery = z.object({
  q: z.string().optional(), action: z.string().optional(), resourceType: z.string().optional(), resourceId: z.string().optional(), user: z.string().optional(),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(), from: z.string().optional(), to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

function auditWhere(orgId: string, q: z.infer<typeof auditQuery>) {
  const params: unknown[] = [orgId];
  const conds = ['organization_id = $1'];
  const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace(/\?/g, `$${params.length}`)); };
  if (q.action) add(q.action.includes('*') ? 'action LIKE ?' : 'action = ?', q.action.replace(/\*/g, '%'));
  if (q.resourceType) add('resource_type = ?', q.resourceType);
  if (q.resourceId) add('resource_id = ?', q.resourceId);
  if (q.user) add('(user_email ILIKE ? OR user_id::text = ?)', q.user.includes('@') || !/^[0-9a-f-]{36}$/i.test(q.user) ? `%${q.user}%` : q.user);
  if (q.result) add('result = ?', q.result);
  const date = (s: string) => { const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s); if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date '${s}'`); return d; };
  if (q.from) add('ts >= ?', date(q.from));
  if (q.to) add('ts <= ?', date(q.to));
  if (q.q) add(`(action ILIKE ? OR resource_type ILIKE ? OR resource_id ILIKE ? OR user_email ILIKE ? OR details::text ILIKE ?)`, `%${q.q}%`);
  return { where: conds.join(' AND '), params };
}

export async function adminRoutes(app: FastifyInstance) {
  const r = typed(app);
  const users = { preHandler: requirePermission('MANAGE_USERS') };
  const keys = { preHandler: requirePermission('MANAGE_API_KEYS') };
  const auditPerm = { preHandler: requirePermission('VIEW_AUDIT') };
  const settings = { preHandler: requirePermission('MANAGE_SETTINGS') };

  // ================================================================== Users
  r.get('/admin/users', { ...users, schema: { tags: ['Administration'], summary: 'Users with roles', querystring: z.object({ q: z.string().optional(), includeInactive: z.coerce.boolean().default(true) }) } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(`${USER_SELECT} WHERE u.organization_id = $1 AND ($2::text IS NULL OR u.email ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%') AND ($3 OR u.is_active)
                              GROUP BY u.id ORDER BY u.is_active DESC, u.name`, [p.orgId, req.query.q ?? null, req.query.includeInactive]);
    return rows.map(userDto);
  });

  r.post('/admin/users', {
    ...users,
    schema: { tags: ['Administration'], summary: 'Create user (without password a one-time password-set link is returned)', body: z.object({ email: z.string().email().max(254), name: z.string().min(1).max(120), roles: z.array(z.string()).min(1).max(10), password: PASSWORD_RULE.optional() }) },
  }, async (req, reply) => {
    const p = principalOf(req);
    const b = req.body;
    await guardRoles(req, null, b.roles, false);
    if (await one(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [b.email])) throw conflict(`A user with email ${b.email} already exists`);
    const hash = await bcrypt.hash(b.password ?? randomToken(24), BCRYPT_COST);
    const u = await one(`INSERT INTO users (organization_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [p.orgId, b.email.toLowerCase(), b.name, hash]);
    await setRoles(u.id, b.roles);
    let setPassword: { link: string; expiresAt: Date; emailed: boolean } | null = null;
    if (!b.password) {
      const l = await issueResetLink(u.id, 72);
      const emailed = await sendEmail(b.email, 'Your Perfmon account', `Hello ${b.name},\n\nAn account was created for you on Perfmon. Set your password with this link (valid 72 hours):\n${l.link}\n`).catch(() => false);
      setPassword = { ...l, emailed };
    }
    await audit(req, { action: 'user.create', resourceType: 'user', resourceId: u.id, details: { email: b.email, roles: b.roles, passwordSet: !!b.password } });
    reply.code(201);
    return { ...userDto(await ownedUser(req, u.id)), setPasswordLink: setPassword?.link ?? null, setPasswordExpiresAt: setPassword?.expiresAt ?? null, emailed: setPassword?.emailed ?? false };
  });

  r.patch('/admin/users/:id', {
    ...users,
    schema: { tags: ['Administration'], summary: 'Update user name / roles / active flag', params: idParams, body: z.object({ name: z.string().min(1).max(120).optional(), roles: z.array(z.string()).min(1).max(10).optional(), isActive: z.boolean().optional() }) },
  }, async (req) => {
    const p = principalOf(req);
    const target = await ownedUser(req, req.params.id);
    const b = req.body;
    if (b.isActive === false && target.id === p.id) throw badRequest('You cannot deactivate your own account');
    if (b.roles && target.id === p.id && !b.roles.some((x) => ROLES[x]?.permissions.includes('MANAGE_USERS'))) throw badRequest('You cannot remove your own user-management permission');
    await guardRoles(req, target, b.roles, b.isActive === false);
    await query(`UPDATE users SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_at = now(),
                   failed_login_count = CASE WHEN $3 IS TRUE THEN 0 ELSE failed_login_count END, locked_until = CASE WHEN $3 IS TRUE THEN NULL ELSE locked_until END WHERE id = $1`,
      [target.id, b.name ?? null, b.isActive ?? null]);
    if (b.roles) await setRoles(target.id, b.roles);
    invalidateUserCache(target.id);
    const action = b.isActive === false ? 'user.deactivate' : b.isActive === true && !target.is_active ? 'user.activate' : 'user.update';
    await audit(req, { action, resourceType: 'user', resourceId: target.id, details: { email: target.email, before: { name: target.name, roles: target.roles, isActive: target.is_active }, after: b } });
    return userDto(await ownedUser(req, target.id));
  });

  r.post('/admin/users/:id/reset-link', { ...users, schema: { tags: ['Administration'], summary: 'Generate a one-time password reset link (valid 24h)', params: idParams } }, async (req) => {
    const target = await ownedUser(req, req.params.id);
    if (!target.is_active) throw badRequest('User is deactivated');
    const l = await issueResetLink(target.id, 24);
    const emailed = await sendEmail(target.email, 'Perfmon password reset', `Hello ${target.name},\n\nReset your Perfmon password using this link (valid 24 hours):\n${l.link}\n`).catch(() => false);
    await audit(req, { action: 'user.reset_link', resourceType: 'user', resourceId: target.id, details: { email: target.email, emailed } });
    return { link: l.link, expiresAt: l.expiresAt, emailed };
  });

  // ================================================================== Roles & permissions
  r.get('/admin/roles', { ...users, schema: { tags: ['Administration'], summary: 'Roles with permissions and user counts' } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(
      `SELECT r.name, r.description, r.is_system,
              COALESCE((SELECT array_agg(pm.code ORDER BY pm.code) FROM role_permissions rp JOIN permissions pm ON pm.id = rp.permission_id WHERE rp.role_id = r.id), '{}') AS permissions,
              (SELECT count(*)::int FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.organization_id = $1 AND u.is_active) AS user_count
       FROM roles r ORDER BY r.name`, [p.orgId]);
    const order = Object.keys(ROLES);
    return rows.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((x) => ({ name: x.name, description: x.description, isSystem: x.is_system, permissions: x.permissions, userCount: x.user_count }));
  });

  r.get('/admin/permissions', { ...users, schema: { tags: ['Administration'], summary: 'Permission catalogue' } }, async () =>
    Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description, roles: Object.entries(ROLES).filter(([, d]) => d.permissions.includes(code as any)).map(([n]) => n) })));

  // ================================================================== API keys
  r.get('/api-keys', { ...keys, schema: { tags: ['API Keys'], summary: 'API keys (secrets are never returned)', querystring: z.object({ includeRevoked: z.coerce.boolean().default(true), projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(`${KEY_SELECT} WHERE k.organization_id = $1 AND ($2 OR k.revoked_at IS NULL) AND ($3::uuid IS NULL OR k.project_id = $3) ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
      [p.orgId, req.query.includeRevoked, req.query.projectId ?? null]);
    return rows.map(keyDto);
  });

  const keyBody = z.object({
    name: z.string().min(1).max(120),
    scopes: z.array(z.enum(['ingest', 'read'])).min(1).max(2),
    projectId: z.string().uuid().nullish(),
    expiresAt: z.string().nullish(),
    rateLimitPerSec: z.number().int().min(1).max(100000).nullish(),
  });
  const parseExpiry = (s: string | null | undefined) => {
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw badRequest('expiresAt must be an ISO date');
    if (d.getTime() <= Date.now()) throw badRequest('expiresAt must be in the future');
    return d;
  };

  async function createKey(req: FastifyRequest, b: z.infer<typeof keyBody>, rotatedFrom: string | null) {
    const p = principalOf(req);
    const k = generateApiKey();
    const row = await one(
      `INSERT INTO api_keys (organization_id, project_id, name, prefix, key_hash, scopes, rate_limit_per_sec, created_by, expires_at, rotated_from_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [p.orgId, b.projectId ?? null, b.name, k.prefix, k.hash, [...new Set(b.scopes)], b.rateLimitPerSec ?? null, p.kind === 'user' ? p.id : null, parseExpiry(b.expiresAt), rotatedFrom]);
    const full = await one(`${KEY_SELECT} WHERE k.id = $1`, [row.id]);
    return { ...keyDto(full), secret: k.full };
  }

  r.post('/api-keys', { ...keys, schema: { tags: ['API Keys'], summary: 'Create API key — the secret is returned ONCE', body: keyBody } }, async (req, reply) => {
    if (req.body.projectId) await assertProject(req, req.body.projectId);
    const key = await createKey(req, req.body, null);
    await audit(req, { action: 'api_key.create', resourceType: 'api_key', resourceId: key.id, details: { name: key.name, prefix: key.prefix, scopes: key.scopes, projectId: key.projectId, expiresAt: key.expiresAt, rateLimitPerSec: key.rateLimitPerSec } });
    reply.code(201);
    return key;
  });

  r.post('/api-keys/:id/rotate', { ...keys, schema: { tags: ['API Keys'], summary: 'Rotate: issue a new secret with the same settings and revoke the old key', params: idParams, body: z.object({ expiresAt: z.string().nullish() }).optional() } }, async (req) => {
    const p = principalOf(req);
    const old = await one(`SELECT * FROM api_keys WHERE id = $1 AND organization_id = $2`, [req.params.id, p.orgId]);
    if (!old) throw notFound('API key', req.params.id);
    if (old.revoked_at) throw badRequest('Key is already revoked');
    const keepExpiry = old.expires_at && new Date(old.expires_at) > new Date() ? new Date(old.expires_at).toISOString() : null;
    const key = await createKey(req, { name: old.name, scopes: old.scopes, projectId: old.project_id, rateLimitPerSec: old.rate_limit_per_sec, expiresAt: req.body?.expiresAt !== undefined ? req.body.expiresAt : keepExpiry }, old.id);
    await query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [old.id]);
    await audit(req, { action: 'api_key.rotate', resourceType: 'api_key', resourceId: old.id, details: { name: old.name, oldPrefix: old.prefix, newKeyId: key.id, newPrefix: key.prefix } });
    return key;
  });

  r.delete('/api-keys/:id', { ...keys, schema: { tags: ['API Keys'], summary: 'Revoke API key', params: idParams } }, async (req) => {
    const p = principalOf(req);
    const k = await one(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND organization_id = $2 RETURNING id, name, prefix`, [req.params.id, p.orgId]);
    if (!k) throw notFound('API key', req.params.id);
    await audit(req, { action: 'api_key.revoke', resourceType: 'api_key', resourceId: k.id, details: { name: k.name, prefix: k.prefix } });
    return { ok: true };
  });

  // ================================================================== Audit
  r.get('/admin/audit', { ...auditPerm, schema: { tags: ['Administration'], summary: 'Search the audit log', querystring: auditQuery } }, async (req) => {
    const q = req.query;
    const { where, params } = auditWhere(principalOf(req).orgId, q);
    const total = await one(`SELECT count(*)::bigint n FROM audit_logs WHERE ${where}`, params);
    const items = await query(`SELECT id, ts, user_id, user_email, api_key_id, action, resource_type, resource_id, ip, user_agent, result, details FROM audit_logs WHERE ${where}
                               ORDER BY ts DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return {
      items: items.map((a) => ({ id: a.id, ts: a.ts, userId: a.user_id, userEmail: a.user_email, apiKeyId: a.api_key_id, action: a.action, resourceType: a.resource_type, resourceId: a.resource_id, ip: a.ip, userAgent: a.user_agent, result: a.result, details: a.details })),
      total: Number(total?.n ?? 0), page: q.page, pageSize: q.pageSize,
    };
  });

  r.get('/admin/audit/export', { ...auditPerm, schema: { tags: ['Administration'], summary: 'Export the (filtered) audit log as CSV (max 100k rows)', querystring: auditQuery.omit({ page: true, pageSize: true }) } }, async (req, reply) => {
    const { where, params } = auditWhere(principalOf(req).orgId, { ...req.query, page: 1, pageSize: 1 });
    const rows = await query(`SELECT ts, user_email, api_key_id, action, resource_type, resource_id, result, ip, user_agent, details FROM audit_logs WHERE ${where} ORDER BY ts DESC, id DESC LIMIT 100000`, params);
    await audit(req, { action: 'audit.export', resourceType: 'audit_log', details: { rows: rows.length, filters: req.query } });
    const csv = toCsv(rows.map((x) => ({ ...x, ts: new Date(x.ts).toISOString() })), ['ts', 'user_email', 'api_key_id', 'action', 'resource_type', 'resource_id', 'result', 'ip', 'user_agent', 'details']);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="perfmon-audit-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });

  // ================================================================== Settings
  r.get('/admin/settings', { ...settings, schema: { tags: ['Administration'], summary: 'Platform settings (score weights, regression thresholds, retention, ...)' } }, async (req) => {
    const p = principalOf(req);
    const values = await allSettings(p.orgId);
    const meta = await query(`SELECT s.key, s.updated_at, u.name AS updated_by FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.organization_id = $1`, [p.orgId]);
    return { ...values, _meta: Object.fromEntries(meta.map((m) => [m.key, { updatedAt: m.updated_at, updatedBy: m.updated_by }])), _defaults: DEFAULT_SETTINGS };
  });

  r.put('/admin/settings/:key', { ...settings, schema: { tags: ['Administration'], summary: 'Update one settings group (merged over defaults)', params: z.object({ key: z.string() }), body: z.record(z.string(), z.unknown()) } }, async (req) => {
    const p = principalOf(req);
    const key = req.params.key as SettingKey;
    if (!(key in DEFAULT_SETTINGS)) throw notFound('Setting', req.params.key);
    const parsed = SETTING_SCHEMAS[key].safeParse(req.body);
    if (!parsed.success) throw badRequest(`Invalid value for ${key}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`, parsed.error.issues);
    const unknownKeys = Object.keys(req.body).filter((k) => !(k in (DEFAULT_SETTINGS[key] as object)));
    if (unknownKeys.length) throw badRequest(`Unknown field(s) for ${key}: ${unknownKeys.join(', ')}`);
    const before = await getSetting(p.orgId, key);
    const merged = { ...(before as object), ...(parsed.data as object) };
    if (key === 'default_result_thresholds' && (merged as any).errorPctWarn > (merged as any).errorPctFail) throw badRequest('errorPctWarn must be ≤ errorPctFail');
    await setSetting(p.orgId, key, merged, p.kind === 'user' ? p.id : null);
    await audit(req, { action: 'settings.update', resourceType: 'setting', resourceId: key, details: { before, after: merged } });
    return { key, value: await getSetting(p.orgId, key) };
  });

  // ================================================================== Retention
  r.get('/admin/retention', { ...settings, schema: { tags: ['Administration'], summary: 'Retention policy with estimates of rows eligible for purge' } }, async (req) => {
    const p = principalOf(req);
    const policy = await getSetting(p.orgId, 'retention');
    const estimates = [];
    for (const t of RETENTION_TYPES) {
      const { days, cutoff } = await cutoffFor(p.orgId, t);
      estimates.push({ dataType: t.dataType, label: t.label, retentionDays: days, cutoff, rows: await retentionEstimate(p.orgId, t, cutoff) });
    }
    const pending = await query(`SELECT * FROM retention_purges WHERE organization_id = $1 AND status = 'PENDING_CONFIRMATION' ORDER BY requested_at DESC`, [p.orgId]);
    return { policy, estimates, pending: pending.map(purgeDto), note: 'Data is never deleted automatically: create a purge request and confirm it explicitly.' };
  });

  const purgeDto = (x: any) => ({
    id: x.id, dataType: x.data_type, cutoff: x.cutoff, estimatedRows: x.estimated_rows, status: x.status, requestedAt: x.requested_at, requestedBy: x.requested_by_name ?? x.requested_by ?? null,
    confirmedBy: x.confirmed_by_name ?? x.confirmed_by ?? null, confirmedAt: x.confirmed_at, executedAt: x.executed_at, deletedRows: x.deleted_rows, error: x.error ?? null, details: x.details ?? {},
  });
  const PURGE_SELECT = `SELECT rp.*, u1.name AS requested_by_name, u2.name AS confirmed_by_name FROM retention_purges rp LEFT JOIN users u1 ON u1.id = rp.requested_by LEFT JOIN users u2 ON u2.id = rp.confirmed_by`;

  r.get('/admin/retention/purges', { ...settings, schema: { tags: ['Administration'], summary: 'Purge requests history' } }, async (req) =>
    (await query(`${PURGE_SELECT} WHERE rp.organization_id = $1 ORDER BY rp.requested_at DESC LIMIT 200`, [principalOf(req).orgId])).map(purgeDto));

  r.post('/admin/retention/purges', { ...settings, schema: { tags: ['Administration'], summary: 'Request a purge (PENDING_CONFIRMATION — nothing is deleted yet)', body: z.object({ dataType: z.enum(RETENTION_TYPES.map((t) => t.dataType) as [string, ...string[]]) }) } }, async (req, reply) => {
    const p = principalOf(req);
    const t = RETENTION_TYPES.find((x) => x.dataType === req.body.dataType)!;
    const { days, cutoff } = await cutoffFor(p.orgId, t);
    const rows = await retentionEstimate(p.orgId, t, cutoff);
    await query(`UPDATE retention_purges SET status = 'CANCELLED' WHERE organization_id = $1 AND data_type = $2 AND status = 'PENDING_CONFIRMATION'`, [p.orgId, t.dataType]);
    const row = await one(`INSERT INTO retention_purges (organization_id, data_type, cutoff, estimated_rows, requested_by, details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.orgId, t.dataType, cutoff, rows, p.kind === 'user' ? p.id : null, JSON.stringify({ retentionDays: days, tables: t.tables.map((x) => x.table) })]);
    await audit(req, { action: 'retention.purge_request', resourceType: 'retention_purge', resourceId: row.id, details: { dataType: t.dataType, cutoff, estimatedRows: rows } });
    reply.code(201);
    return purgeDto(await one(`${PURGE_SELECT} WHERE rp.id = $1`, [row.id]));
  });

  r.post('/admin/retention/purges/:id/confirm', {
    ...settings,
    schema: { tags: ['Administration'], summary: 'Confirm and execute a pending purge (batched deletes; artifacts also removed from storage)', params: idParams },
  }, async (req) => {
    const p = principalOf(req);
    const pr = await one(`SELECT * FROM retention_purges WHERE id = $1 AND organization_id = $2`, [req.params.id, p.orgId]);
    if (!pr) throw notFound('Purge request', req.params.id);
    if (pr.status !== 'PENDING_CONFIRMATION') throw conflict(`Purge request is ${pr.status}`);
    if (Date.now() - new Date(pr.requested_at).getTime() > 24 * 3600000) throw badRequest('Purge request is older than 24h — create a new request to refresh the estimate');
    const t = RETENTION_TYPES.find((x) => x.dataType === pr.data_type);
    if (!t) throw badRequest(`Unknown data type ${pr.data_type}`);
    const claimed = await one(`UPDATE retention_purges SET status = 'EXECUTING', confirmed_by = $2, confirmed_at = now() WHERE id = $1 AND status = 'PENDING_CONFIRMATION' RETURNING id`, [pr.id, p.kind === 'user' ? p.id : null]);
    if (!claimed) throw conflict('Purge request was already confirmed');
    try {
      const res = await executePurge(p.orgId, t, new Date(pr.cutoff));
      await query(`UPDATE retention_purges SET status = 'EXECUTED', executed_at = now(), deleted_rows = $2, details = details || $3 WHERE id = $1`, [pr.id, res.deleted, JSON.stringify({ perTable: res.perTable })]);
      await audit(req, { action: 'retention.purge_execute', resourceType: 'retention_purge', resourceId: pr.id, details: { dataType: pr.data_type, cutoff: pr.cutoff, deletedRows: res.deleted, perTable: res.perTable } });
    } catch (e) {
      await query(`UPDATE retention_purges SET status = 'FAILED', error = $2 WHERE id = $1`, [pr.id, (e as Error).message.slice(0, 2000)]);
      await audit(req, { action: 'retention.purge_execute', resourceType: 'retention_purge', resourceId: pr.id, result: 'FAILURE', details: { error: (e as Error).message } });
      throw e;
    }
    return purgeDto(await one(`${PURGE_SELECT} WHERE rp.id = $1`, [pr.id]));
  });

  r.post('/admin/retention/purges/:id/cancel', { ...settings, schema: { tags: ['Administration'], summary: 'Cancel a pending purge', params: idParams } }, async (req) => {
    const p = principalOf(req);
    const row = await one(`UPDATE retention_purges SET status = 'CANCELLED' WHERE id = $1 AND organization_id = $2 AND status = 'PENDING_CONFIRMATION' RETURNING id, data_type`, [req.params.id, p.orgId]);
    if (!row) throw conflict('Purge request not found or not pending');
    await audit(req, { action: 'retention.purge_cancel', resourceType: 'retention_purge', resourceId: row.id, details: { dataType: row.data_type } });
    return purgeDto(await one(`${PURGE_SELECT} WHERE rp.id = $1`, [row.id]));
  });

  // ================================================================== Background jobs
  // Jobs are global (not org-scoped in the schema); visibility is limited to MANAGE_SETTINGS holders.
  r.get('/admin/jobs', {
    ...settings,
    schema: { tags: ['Administration'], summary: 'Background jobs with status statistics', querystring: z.object({ status: z.string().optional(), type: z.string().optional(), runId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) }) },
  }, async (req) => {
    const q = req.query;
    const params: unknown[] = [];
    const conds: string[] = ['true'];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)); };
    if (q.status) add('j.status = ANY(?)', q.status.split(',').map((s) => s.trim().toUpperCase()));
    if (q.type) add('j.type = ?', q.type);
    if (q.runId) add('r.run_key = ?', q.runId);
    const where = conds.join(' AND ');
    const items = await query(
      `SELECT count(*) OVER() AS __total, j.id, j.type, j.status, j.payload, j.result, j.error, j.run_id, r.run_key, j.priority, j.attempts, j.max_attempts, j.run_after, j.locked_by,
              j.created_at, j.started_at, j.finished_at, EXTRACT(EPOCH FROM (j.finished_at - j.started_at)) * 1000 AS duration_ms
       FROM background_jobs j LEFT JOIN test_runs r ON r.id = j.run_id WHERE ${where} ORDER BY j.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    const stats = await query(`SELECT status, count(*)::int n FROM background_jobs GROUP BY status`);
    const s: Record<string, number> = { QUEUED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
    for (const x of stats) s[x.status] = x.n;
    const types = await query(`SELECT type, count(*)::int n, count(*) FILTER (WHERE status = 'FAILED')::int failed FROM background_jobs GROUP BY type ORDER BY type`);
    return {
      items: items.map((j) => ({
        id: j.id, type: j.type, status: j.status, payload: j.payload, result: j.result, error: j.error ? String(j.error).split('\n')[0].slice(0, 500) : null, errorDetail: j.error,
        runId: j.run_id, runKey: j.run_key, priority: j.priority, attempts: j.attempts, maxAttempts: j.max_attempts, runAfter: j.run_after, lockedBy: j.locked_by,
        createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at, durationMs: j.duration_ms == null ? null : Math.round(Number(j.duration_ms)),
      })),
      total: items.length ? Number(items[0].__total) : 0, page: q.page, pageSize: q.pageSize, stats: s, types,
    };
  });

  r.post('/admin/jobs/:id/retry', { ...settings, schema: { tags: ['Administration'], summary: 'Retry a failed job', params: idParams } }, async (req) => {
    const j = await one(`UPDATE background_jobs SET status = 'QUEUED', attempts = 0, error = NULL, run_after = now(), locked_at = NULL, locked_by = NULL, finished_at = NULL
                         WHERE id = $1 AND status = 'FAILED' RETURNING id, type`, [req.params.id]);
    if (!j) {
      const exists = await one(`SELECT status FROM background_jobs WHERE id = $1`, [req.params.id]);
      if (!exists) throw notFound('Job', req.params.id);
      throw conflict(`Only FAILED jobs can be retried (job is ${exists.status})`);
    }
    await query(`NOTIFY perfmon_jobs`).catch(() => undefined);
    await audit(req, { action: 'job.retry', resourceType: 'job', resourceId: j.id, details: { type: j.type } });
    return { ok: true, id: j.id, status: 'QUEUED' };
  });

  // ================================================================== System health
  r.get('/system/health', { ...settings, schema: { tags: ['System'], summary: 'Platform self-monitoring: API, DB, ingestion, jobs, live, storage, process' } }, async () => {
    const m = selfMetrics;
    const c = (k: string) => m.counters.get(k) ?? 0;
    const t0 = performance.now();
    let dbOk = true;
    let sizeBytes: number | null = null;
    try { sizeBytes = Number((await one(`SELECT pg_database_size(current_database()) AS s`))?.s ?? 0); } catch { dbOk = false; }
    const dbPingMs = performance.now() - t0;
    const jobs = await one(
      `SELECT count(*) FILTER (WHERE status = 'QUEUED')::int queued, count(*) FILTER (WHERE status = 'PROCESSING')::int processing,
              count(*) FILTER (WHERE status = 'FAILED' AND COALESCE(finished_at, created_at) > now() - interval '24 hours')::int failed24h,
              count(*) FILTER (WHERE status = 'COMPLETED' AND finished_at > now() - interval '24 hours')::int completed24h,
              avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE status = 'COMPLETED' AND finished_at > now() - interval '24 hours') avg_ms
       FROM background_jobs`).catch(() => null);
    let st: { ok: boolean; detail?: string };
    try { st = await Promise.race([storage.health(), new Promise<{ ok: boolean; detail: string }>((res) => setTimeout(() => res({ ok: false, detail: 'health check timed out' }), 5000))]); }
    catch (e) { st = { ok: false, detail: (e as Error).message }; }
    const requests = c('api_requests');
    const errors5xx = c('api_errors_5xx');
    const errors4xx = c('api_errors_4xx');
    const mem = process.memoryUsage();
    const status = !dbOk ? 'DOWN' : !st.ok || (jobs?.failed24h ?? 0) > 50 || pool.waitingCount > 5 ? 'DEGRADED' : 'UP';
    return {
      status,
      uptimeSec: Math.round((Date.now() - m.startedAt) / 1000),
      version: process.env.npm_package_version ?? '1.0.0',
      api: {
        requests, rps: r1(m.rate('api_requests'), 2), latencyP50: r1(m.quantile('api_latency_ms', 0.5)), latencyP95: r1(m.quantile('api_latency_ms', 0.95)), latencyP99: r1(m.quantile('api_latency_ms', 0.99)),
        errors4xx, errors5xx, errorRatePct: requests ? r1(((errors4xx + errors5xx) / requests) * 100, 2) : 0,
      },
      db: { ok: dbOk, pingMs: r1(dbPingMs), latencyP50: r1(m.quantile('db_query_ms', 0.5), 2), latencyP95: r1(m.quantile('db_query_ms', 0.95), 2), poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount, sizeBytes },
      ingestion: {
        samplesPerSec: r1(m.rate('ingest_samples')), pointsPerSec: r1(m.rate('ingest_points') + m.rate('ingest_infra_points') + m.rate('ingest_otlp_points')), rowsWritten: c('ingest_rows_written'),
        failures: c('ingest_failures'), bufferSize: aggregator.size, flushP95Ms: r1(m.quantile('ingest_flush_ms', 0.95)), rateLimited: c('ingest_rate_limited'), parseErrors: c('ingest_parse_errors'),
      },
      jobs: { queued: jobs?.queued ?? null, processing: jobs?.processing ?? null, failed24h: jobs?.failed24h ?? null, completed24h: jobs?.completed24h ?? null, avgDurationMs: jobs?.avg_ms == null ? null : Math.round(Number(jobs.avg_ms)) },
      live: { connections: liveConnections.count },
      artifacts: { uploaded: c('artifacts_uploaded'), processed: c('artifacts_processed'), failed: c('artifacts_failed'), processingP95Ms: r1(m.quantile('artifact_processing_ms', 0.95)) },
      process: { heapUsedMb: r1(mem.heapUsed / 1048576), rssMb: r1(mem.rss / 1048576), cpuPct: processCpuPct(), nodeVersion: process.version, pid: process.pid },
      storage: { driver: storage.name, ok: st.ok, detail: st.detail ?? null },
      alertsFired: c('alerts_fired'),
    };
  });
}
