import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { typed, z, idParams, assertProject } from '../lib/http.js';
import { encryptSecret } from '../lib/crypto.js';
import { enqueue } from '../jobs/queue.js';
import { sendTestNotification } from './notifiers.js';

/** Alert rule catalogue (drives the rule editor). */
export const ALERT_RULE_TYPES = [
  { type: 'HIGH_RESPONSE_TIME', label: 'High average response time (running test)', defaultOperator: '>', unit: 'ms', needsThreshold: true, scope: 'LIVE' },
  { type: 'HIGH_P95', label: 'High P95 response time (running test)', defaultOperator: '>', unit: 'ms', needsThreshold: true, scope: 'LIVE' },
  { type: 'HIGH_P99', label: 'High P99 response time (running test)', defaultOperator: '>', unit: 'ms', needsThreshold: true, scope: 'LIVE' },
  { type: 'LOW_TPS', label: 'Low throughput (running test)', defaultOperator: '<', unit: 'tps', needsThreshold: true, scope: 'LIVE' },
  { type: 'HIGH_ERROR_RATE', label: 'High error rate (running test)', defaultOperator: '>', unit: '%', needsThreshold: true, scope: 'LIVE' },
  { type: 'CPU', label: 'Server CPU utilization', defaultOperator: '>', unit: '%', needsThreshold: true, scope: 'INFRA' },
  { type: 'MEMORY', label: 'Server memory utilization', defaultOperator: '>', unit: '%', needsThreshold: true, scope: 'INFRA' },
  { type: 'DISK', label: 'Server disk utilization', defaultOperator: '>', unit: '%', needsThreshold: true, scope: 'INFRA' },
  { type: 'JVM_HEAP', label: 'JVM heap utilization', defaultOperator: '>', unit: '%', needsThreshold: true, scope: 'INFRA' },
  { type: 'GC', label: 'JVM GC pause', defaultOperator: '>', unit: 'ms', needsThreshold: true, scope: 'INFRA' },
  { type: 'SLA_VIOLATION', label: 'SLA violation at run completion', defaultOperator: '>', unit: 'violations', needsThreshold: false, scope: 'COMPLETION' },
  { type: 'TEST_FAILURE', label: 'Test failed / aborted / result FAIL', defaultOperator: '>', unit: '', needsThreshold: false, scope: 'COMPLETION' },
  { type: 'REGRESSION', label: 'Regression vs baseline at run completion', defaultOperator: '>', unit: '%', needsThreshold: false, scope: 'COMPLETION' },
] as const;
const RULE_TYPE_KEYS = ALERT_RULE_TYPES.map((t) => t.type) as unknown as [string, ...string[]];
const CHANNEL_TYPES = ['IN_APP', 'EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK'] as const;
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

const filtersSchema = z.object({
  environmentId: z.string().uuid().nullish(),
  testId: z.string().uuid().nullish(),
  transaction: z.string().max(300).nullish(),
  serverId: z.string().uuid().nullish(),
}).default({});

const ruleBody = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  type: z.enum(RULE_TYPE_KEYS),
  metric: z.string().max(100).nullish(),
  operator: z.enum(['>', '>=', '<', '<=']).optional(),
  threshold: z.number().nullish(),
  severity: z.enum(SEVERITIES).default('WARNING'),
  windowSec: z.number().int().min(10).max(86400).default(60),
  filters: filtersSchema,
  channelIds: z.array(z.string().uuid()).max(20).default([]),
  cooldownSec: z.number().int().min(0).max(7 * 86400).default(300),
  enabled: z.boolean().default(true),
});

const channelBody = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(CHANNEL_TYPES),
  config: z.object({ recipients: z.array(z.string().email()).max(50).optional(), url: z.string().url().max(2000).optional() }).passthrough().default({}),
  secret: z.string().min(1).max(4000).nullish(),
  enabled: z.boolean().default(true),
});

const ruleDto = (r: any) => ({
  id: r.id, projectId: r.project_id, projectName: r.project_name ?? undefined, name: r.name, description: r.description, type: r.type, metric: r.metric,
  operator: r.operator, threshold: r.threshold, severity: r.severity, windowSec: r.window_sec, filters: r.filters ?? {}, channelIds: r.channel_ids ?? [],
  cooldownSec: r.cooldown_sec, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
  openAlerts: r.open_alerts != null ? Number(r.open_alerts) : undefined, lastFiredAt: r.last_fired_at ?? null,
});

const channelDto = (c: any) => ({
  id: c.id, name: c.name, type: c.type, config: c.config ?? {}, enabled: c.enabled, hasSecret: !!c.secret_ciphertext, createdAt: c.created_at, updatedAt: c.updated_at ?? c.created_at,
});

const alertDto = (a: any) => ({
  id: a.id, ruleId: a.rule_id, ruleName: a.rule_name ?? null, projectId: a.project_id, type: a.type, severity: a.severity, status: a.status, subject: a.subject,
  title: a.title, message: a.message, value: a.value, threshold: a.threshold, runId: a.run_id, runKey: a.run_key ?? null, serverId: a.server_id, serverName: a.server_name ?? null,
  firedAt: a.fired_at, acknowledgedAt: a.acknowledged_at, acknowledgedBy: a.acknowledged_by_name ?? null, resolvedAt: a.resolved_at, lastEvaluatedAt: a.last_evaluated_at,
});

const ALERT_SELECT = `
  SELECT a.*, r.name AS rule_name, tr.run_key, s.name AS server_name, u.name AS acknowledged_by_name
  FROM alerts a JOIN projects p ON p.id = a.project_id
  LEFT JOIN alert_rules r ON r.id = a.rule_id LEFT JOIN test_runs tr ON tr.id = a.run_id
  LEFT JOIN servers s ON s.id = a.server_id LEFT JOIN users u ON u.id = a.acknowledged_by`;

async function ownedAlert(req: FastifyRequest, id: string) {
  const p = principalOf(req);
  const a = await one(`${ALERT_SELECT} WHERE a.id = $1 AND p.organization_id = $2`, [id, p.orgId]);
  if (!a || (p.projectId && p.projectId !== a.project_id)) throw notFound('Alert', id);
  return a;
}

async function ownedRule(req: FastifyRequest, id: string) {
  const p = principalOf(req);
  const r = await one(`SELECT r.*, p.organization_id FROM alert_rules r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`, [id]);
  if (!r || r.organization_id !== p.orgId || (p.projectId && p.projectId !== r.project_id)) throw notFound('Alert rule', id);
  return r;
}

async function ownedChannel(req: FastifyRequest, id: string) {
  const c = await one(`SELECT * FROM notification_channels WHERE id = $1 AND organization_id = $2`, [id, principalOf(req).orgId]);
  if (!c) throw notFound('Notification channel', id);
  return c;
}

/** Validates threshold presence, channel ownership and filter references for a rule. */
async function validateRule(req: FastifyRequest, b: { projectId: string; type: string; threshold?: number | null; channelIds: string[]; filters: any }) {
  const def = ALERT_RULE_TYPES.find((t) => t.type === b.type)!;
  if (def.needsThreshold && (b.threshold == null || !Number.isFinite(b.threshold))) throw badRequest(`threshold is required for ${b.type} rules`);
  if (b.channelIds.length) {
    const ok = await query(`SELECT id FROM notification_channels WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [principalOf(req).orgId, b.channelIds]);
    if (ok.length !== new Set(b.channelIds).size) throw badRequest('One or more notification channels do not exist');
  }
  const f = b.filters ?? {};
  const check = async (table: string, id: string | null | undefined, label: string) => {
    if (!id) return;
    const row = await one(`SELECT 1 FROM ${table} WHERE id = $1 AND project_id = $2`, [id, b.projectId]);
    if (!row) throw badRequest(`${label} filter does not belong to the selected project`);
  };
  await check('environments', f.environmentId, 'Environment');
  await check('performance_tests', f.testId, 'Test');
  await check('servers', f.serverId, 'Server');
}

function validateChannel(type: string, config: any, secret: string | null | undefined, hasExistingSecret = false) {
  if (type === 'EMAIL' && !(config?.recipients?.length)) throw badRequest('EMAIL channels require config.recipients');
  if (type === 'WEBHOOK') {
    if (!config?.url) throw badRequest('WEBHOOK channels require config.url');
    if (!/^https?:\/\//i.test(config.url)) throw badRequest('Webhook URL must be http(s)');
  }
  if ((type === 'SLACK' || type === 'TEAMS') && !secret && !hasExistingSecret) throw badRequest(`${type} channels require the incoming-webhook URL as "secret"`);
  if ((type === 'SLACK' || type === 'TEAMS') && secret && !/^https:\/\//i.test(secret)) throw badRequest(`${type} webhook URL must start with https://`);
}

const cleanFilters = (f: any) => Object.fromEntries(Object.entries(f ?? {}).filter(([, v]) => v != null && v !== ''));

export async function alertRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };
  const configure = { preHandler: requirePermission('CONFIGURE_ALERT') };

  // ------------------------------------------------------------------ Alerts
  r.get('/alerts', {
    ...view,
    schema: {
      tags: ['Alerts'], summary: 'Alert instances (firing, acknowledged, resolved)',
      querystring: z.object({
        projectId: z.string().uuid().optional(), status: z.string().optional(), severity: z.string().optional(), runId: z.string().optional(), q: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
      }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const params: unknown[] = [p.orgId];
    const conds = ['p.organization_id = $1'];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (p.projectId) add('a.project_id = ?', p.projectId);
    if (q.projectId) add('a.project_id = ?', q.projectId);
    if (q.severity) add('a.severity = ANY(?)', q.severity.split(',').map((s) => s.trim().toUpperCase()));
    if (q.runId) add('(tr.run_key = ? OR tr.id::text = ?)', q.runId);
    if (q.q) add('(a.title ILIKE ? OR a.subject ILIKE ?)', `%${q.q}%`);
    const countParams = [...params];
    const countConds = [...conds];
    if (q.status) add('a.status = ANY(?)', q.status.split(',').map((s) => s.trim().toUpperCase()));
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(
      `${ALERT_SELECT.replace('SELECT a.*,', 'SELECT count(*) OVER() AS __total, a.*,')} WHERE ${conds.join(' AND ')}
       ORDER BY CASE a.status WHEN 'FIRING' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END, a.fired_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const counts = await query(
      `SELECT a.status, count(*)::int n FROM alerts a JOIN projects p ON p.id = a.project_id LEFT JOIN test_runs tr ON tr.id = a.run_id WHERE ${countConds.join(' AND ')} GROUP BY 1`, countParams);
    const c: Record<string, number> = { FIRING: 0, ACKNOWLEDGED: 0, RESOLVED: 0 };
    for (const row of counts) c[row.status] = row.n;
    return { items: rows.map(alertDto), total: rows.length ? Number(rows[0].__total) : 0, page: q.page, pageSize: q.pageSize, counts: c };
  });

  r.get('/alerts/:id', { ...view, schema: { tags: ['Alerts'], summary: 'Alert detail with its event history', params: idParams } }, async (req) => {
    const a = await ownedAlert(req, req.params.id);
    const events = await query(
      `SELECT e.id, e.ts, e.kind, e.channel_id, c.name AS channel_name, c.type AS channel_type, e.details FROM alert_events e
       LEFT JOIN notification_channels c ON c.id = e.channel_id WHERE e.alert_id = $1 ORDER BY e.ts, e.id`, [a.id]);
    const rule = a.rule_id ? await one(`SELECT * FROM alert_rules WHERE id = $1`, [a.rule_id]) : null;
    return {
      ...alertDto(a),
      rule: rule ? ruleDto(rule) : null,
      events: events.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, channelId: e.channel_id, channelName: e.channel_name, channelType: e.channel_type, details: e.details })),
    };
  });

  r.post('/alerts/:id/acknowledge', { ...configure, schema: { tags: ['Alerts'], summary: 'Acknowledge a firing alert', params: idParams, body: z.object({ comment: z.string().max(2000).optional() }).optional() } }, async (req) => {
    const p = principalOf(req);
    const a = await ownedAlert(req, req.params.id);
    if (a.status !== 'FIRING') throw badRequest(`Alert is ${a.status}; only FIRING alerts can be acknowledged`);
    await query(`UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`, [a.id, p.kind === 'user' ? p.id : null]);
    await query(`INSERT INTO alert_events (alert_id, kind, details) VALUES ($1,'ACKNOWLEDGED',$2)`, [a.id, JSON.stringify({ by: p.name, comment: req.body?.comment ?? null })]);
    await audit(req, { action: 'alert.acknowledge', resourceType: 'alert', resourceId: a.id, details: { title: a.title } });
    return alertDto(await ownedAlert(req, a.id));
  });

  r.post('/alerts/:id/resolve', { ...configure, schema: { tags: ['Alerts'], summary: 'Resolve an alert manually', params: idParams, body: z.object({ comment: z.string().max(2000).optional() }).optional() } }, async (req) => {
    const p = principalOf(req);
    const a = await ownedAlert(req, req.params.id);
    if (a.status === 'RESOLVED') throw badRequest('Alert is already resolved');
    await query(`UPDATE alerts SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`, [a.id]);
    await query(`INSERT INTO alert_events (alert_id, kind, details) VALUES ($1,'RESOLVED',$2)`, [a.id, JSON.stringify({ by: p.name, manual: true, comment: req.body?.comment ?? null })]);
    const rule = a.rule_id ? await one(`SELECT channel_ids FROM alert_rules WHERE id = $1`, [a.rule_id]) : null;
    await enqueue('alert.notify', { alertId: a.id, channelIds: rule?.channel_ids ?? [], status: 'RESOLVED' }, { priority: 1 });
    await audit(req, { action: 'alert.resolve', resourceType: 'alert', resourceId: a.id, details: { title: a.title } });
    return alertDto(await ownedAlert(req, a.id));
  });

  // ------------------------------------------------------------------ Alert rules
  r.get('/alert-rules/types', { ...view, schema: { tags: ['Alerts'], summary: 'Alert rule type catalogue' } }, async () => ALERT_RULE_TYPES);

  r.get('/alert-rules', { ...view, schema: { tags: ['Alerts'], summary: 'Alert rules', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(
      `SELECT r.*, p.name AS project_name,
              (SELECT count(*) FROM alerts a WHERE a.rule_id = r.id AND a.status <> 'RESOLVED') AS open_alerts,
              (SELECT max(fired_at) FROM alerts a WHERE a.rule_id = r.id) AS last_fired_at
       FROM alert_rules r JOIN projects p ON p.id = r.project_id
       WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR r.project_id = $2) ORDER BY p.name, r.name`,
      [p.orgId, req.query.projectId ?? p.projectId ?? null]);
    return rows.map(ruleDto);
  });

  r.post('/alert-rules', { ...configure, schema: { tags: ['Alerts'], summary: 'Create alert rule', body: ruleBody } }, async (req, reply) => {
    const p = principalOf(req);
    const b = req.body;
    await assertProject(req, b.projectId);
    await validateRule(req, b);
    const def = ALERT_RULE_TYPES.find((t) => t.type === b.type)!;
    const row = await one(
      `INSERT INTO alert_rules (project_id, name, description, type, metric, operator, threshold, severity, window_sec, filters, channel_ids, cooldown_sec, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [b.projectId, b.name, b.description ?? null, b.type, b.metric ?? null, b.operator ?? def.defaultOperator, b.threshold ?? null, b.severity, b.windowSec,
        JSON.stringify(cleanFilters(b.filters)), b.channelIds, b.cooldownSec, b.enabled, p.kind === 'user' ? p.id : null]);
    await audit(req, { action: 'alert_rule.create', resourceType: 'alert_rule', resourceId: row.id, details: { name: b.name, type: b.type, threshold: b.threshold } });
    reply.code(201);
    return ruleDto(row);
  });

  r.patch('/alert-rules/:id', { ...configure, schema: { tags: ['Alerts'], summary: 'Update alert rule', params: idParams, body: ruleBody.omit({ projectId: true }).partial() } }, async (req) => {
    const before = await ownedRule(req, req.params.id);
    const b = req.body;
    const merged = {
      projectId: before.project_id, type: b.type ?? before.type, threshold: b.threshold !== undefined ? b.threshold : before.threshold,
      channelIds: b.channelIds ?? before.channel_ids ?? [], filters: b.filters ?? before.filters ?? {},
    };
    await validateRule(req, merged);
    const map: Record<string, [string, (v: any) => unknown]> = {
      name: ['name', (v) => v], description: ['description', (v) => v ?? null], type: ['type', (v) => v], metric: ['metric', (v) => v ?? null], operator: ['operator', (v) => v],
      threshold: ['threshold', (v) => v ?? null], severity: ['severity', (v) => v], windowSec: ['window_sec', (v) => v], filters: ['filters', (v) => JSON.stringify(cleanFilters(v))],
      channelIds: ['channel_ids', (v) => v], cooldownSec: ['cooldown_sec', (v) => v], enabled: ['enabled', (v) => v],
    };
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    for (const [k, [col, fn]] of Object.entries(map)) {
      if ((b as any)[k] === undefined) continue;
      params.push(fn((b as any)[k]));
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('Nothing to update');
    const row = await one(`UPDATE alert_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
    // Disabling a rule resolves its open alerts
    if (b.enabled === false) {
      const closed = await query(`UPDATE alerts SET status = 'RESOLVED', resolved_at = now() WHERE rule_id = $1 AND status <> 'RESOLVED' RETURNING id`, [row.id]);
      for (const a of closed) await query(`INSERT INTO alert_events (alert_id, kind, details) VALUES ($1,'RESOLVED','{"reason":"rule disabled"}')`, [a.id]);
    }
    await audit(req, { action: 'alert_rule.update', resourceType: 'alert_rule', resourceId: row.id, details: { before: ruleDto(before), changes: b } });
    return ruleDto(row);
  });

  r.delete('/alert-rules/:id', { ...configure, schema: { tags: ['Alerts'], summary: 'Delete alert rule (open alerts are resolved; history is kept)', params: idParams } }, async (req) => {
    const rule = await ownedRule(req, req.params.id);
    const closed = await query(`UPDATE alerts SET status = 'RESOLVED', resolved_at = now() WHERE rule_id = $1 AND status <> 'RESOLVED' RETURNING id`, [rule.id]);
    for (const a of closed) await query(`INSERT INTO alert_events (alert_id, kind, details) VALUES ($1,'RESOLVED','{"reason":"rule deleted"}')`, [a.id]);
    await query(`DELETE FROM alert_rules WHERE id = $1`, [rule.id]);
    await audit(req, { action: 'alert_rule.delete', resourceType: 'alert_rule', resourceId: rule.id, details: { name: rule.name, type: rule.type } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Notification channels
  r.get('/notification-channels', { ...view, schema: { tags: ['Alerts'], summary: 'Notification channels (secrets are never returned)' } }, async (req) => {
    const rows = await query(`SELECT * FROM notification_channels WHERE organization_id = $1 ORDER BY name`, [principalOf(req).orgId]);
    return rows.map(channelDto);
  });

  r.post('/notification-channels', { ...configure, schema: { tags: ['Alerts'], summary: 'Create notification channel (secret = Slack/Teams webhook URL or webhook signing key, stored encrypted)', body: channelBody } }, async (req, reply) => {
    const p = principalOf(req);
    const b = req.body;
    validateChannel(b.type, b.config, b.secret);
    const row = await one(
      `INSERT INTO notification_channels (organization_id, name, type, config, secret_ciphertext, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.orgId, b.name, b.type, JSON.stringify(b.config ?? {}), b.secret ? encryptSecret(b.secret) : null, b.enabled, p.kind === 'user' ? p.id : null]);
    await audit(req, { action: 'notification_channel.create', resourceType: 'notification_channel', resourceId: row.id, details: { name: b.name, type: b.type, hasSecret: !!b.secret } });
    reply.code(201);
    return channelDto(row);
  });

  r.patch('/notification-channels/:id', {
    ...configure,
    schema: { tags: ['Alerts'], summary: 'Update notification channel (omit secret to keep it, null to clear it)', params: idParams, body: channelBody.omit({ type: true }).partial() },
  }, async (req) => {
    const ch = await ownedChannel(req, req.params.id);
    const b = req.body;
    const config = b.config ?? ch.config;
    validateChannel(ch.type, config, b.secret === undefined ? null : b.secret, b.secret === undefined && !!ch.secret_ciphertext);
    const row = await one(
      `UPDATE notification_channels SET name = COALESCE($2, name), config = $3, enabled = COALESCE($4, enabled),
         secret_ciphertext = CASE WHEN $5::boolean THEN $6 ELSE secret_ciphertext END, updated_at = now() WHERE id = $1 RETURNING *`,
      [ch.id, b.name ?? null, JSON.stringify(config ?? {}), b.enabled ?? null, b.secret !== undefined, b.secret ? encryptSecret(b.secret) : null]);
    await audit(req, { action: 'notification_channel.update', resourceType: 'notification_channel', resourceId: ch.id, details: { name: row.name, secretChanged: b.secret !== undefined, fields: Object.keys(b).filter((k) => k !== 'secret') } });
    return channelDto(row);
  });

  r.delete('/notification-channels/:id', { ...configure, schema: { tags: ['Alerts'], summary: 'Delete notification channel (removed from alert rules)', params: idParams } }, async (req) => {
    const ch = await ownedChannel(req, req.params.id);
    await query(`UPDATE alert_rules SET channel_ids = array_remove(channel_ids, $1::uuid), updated_at = now() WHERE $1::uuid = ANY(channel_ids)`, [ch.id]);
    await query(`DELETE FROM notification_channels WHERE id = $1`, [ch.id]);
    await audit(req, { action: 'notification_channel.delete', resourceType: 'notification_channel', resourceId: ch.id, details: { name: ch.name, type: ch.type } });
    return { ok: true };
  });

  r.post('/notification-channels/:id/test', { ...configure, schema: { tags: ['Alerts'], summary: 'Send a test notification through the channel', params: idParams } }, async (req) => {
    const p = principalOf(req);
    const ch = await ownedChannel(req, req.params.id);
    const t0 = performance.now();
    try {
      await sendTestNotification(ch.id, p.orgId);
      await audit(req, { action: 'notification_channel.test', resourceType: 'notification_channel', resourceId: ch.id, details: { ok: true } });
      return { ok: true, latencyMs: Math.round(performance.now() - t0), message: `Test notification sent via ${ch.type} channel "${ch.name}"` };
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await audit(req, { action: 'notification_channel.test', resourceType: 'notification_channel', resourceId: ch.id, result: 'FAILURE', details: { error: message } });
      return { ok: false, latencyMs: Math.round(performance.now() - t0), message };
    }
  });

  // ------------------------------------------------------------------ In-app notifications (per-user read state)
  const userOnly = (req: FastifyRequest) => {
    const p = principalOf(req);
    if (p.kind !== 'user') throw forbidden('Notifications are only available to user sessions');
    return p;
  };

  r.get('/notifications', { schema: { tags: ['Notifications'], summary: 'In-app notifications for the current user', querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(30), unreadOnly: z.coerce.boolean().optional() }) } }, async (req) => {
    const p = userOnly(req);
    const rows = await query(
      `SELECT n.id, n.title, n.body, n.severity, n.link, n.alert_id, n.created_at, (nr.user_id IS NOT NULL) AS read
       FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $2
       WHERE n.organization_id = $1 AND (n.user_id IS NULL OR n.user_id = $2) AND ($4::boolean IS NOT TRUE OR nr.user_id IS NULL)
       ORDER BY n.created_at DESC LIMIT $3`, [p.orgId, p.id, req.query.limit, req.query.unreadOnly ?? null]);
    const unread = await one(
      `SELECT count(*)::int n FROM notifications n WHERE n.organization_id = $1 AND (n.user_id IS NULL OR n.user_id = $2)
         AND NOT EXISTS (SELECT 1 FROM notification_reads nr WHERE nr.notification_id = n.id AND nr.user_id = $2)`, [p.orgId, p.id]);
    return { items: rows.map((n) => ({ ...n, createdAt: n.created_at, alertId: n.alert_id })), unread: unread?.n ?? 0 };
  });

  r.post('/notifications/read-all', { schema: { tags: ['Notifications'], summary: 'Mark all notifications as read' } }, async (req) => {
    const p = userOnly(req);
    const res = await query(
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT n.id, $2 FROM notifications n WHERE n.organization_id = $1 AND (n.user_id IS NULL OR n.user_id = $2)
       ON CONFLICT DO NOTHING RETURNING notification_id`, [p.orgId, p.id]);
    return { ok: true, marked: res.length };
  });

  r.post('/notifications/:id/read', { schema: { tags: ['Notifications'], summary: 'Mark a notification as read', params: idParams } }, async (req) => {
    const p = userOnly(req);
    const n = await one(`SELECT id FROM notifications WHERE id = $1 AND organization_id = $2 AND (user_id IS NULL OR user_id = $3)`, [req.params.id, p.orgId, p.id]);
    if (!n) throw notFound('Notification', req.params.id);
    await query(`INSERT INTO notification_reads (notification_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [n.id, p.id]);
    return { ok: true };
  });
}
