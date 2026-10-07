import type { FastifyInstance } from 'fastify';
import { one, query, tsPool } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { typed, z } from '../lib/http.js';
import { Conds, projectFilter, requireAny, timeWindow, parseTime } from '../lib/scope.js';
import { resolveRun } from '../ingest/runCache.js';
import { RUN_SELECT, runDto } from '../runs/dto.js';
import { compareRuns } from './compare.js';
import { loadTrend } from './trends.js';
import { capacityModel, projectCapacity, testSlaP95 } from './capacity.js';

const SUMMARY_LATERAL = `LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id
  ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END LIMIT 1) s ON true`;
const n = (v: unknown) => (v == null ? null : Number(v));
const uuidOpt = z.string().uuid().optional();
const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) };

async function assertTest(orgId: string, testId: string) {
  const t = await one(`SELECT t.id, t.project_id, t.environment_id FROM performance_tests t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND p.organization_id = $2`, [testId, orgId]);
  if (!t) throw notFound('Test', testId);
  return t;
}

export async function analyticsRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_RUN') };

  // ------------------------------------------------------------------ Overview
  r.get('/overview', {
    ...view,
    schema: {
      tags: ['Analytics'], summary: 'Overview dashboard: KPIs, trend, slow transactions, infra health, recent runs and alerts',
      querystring: z.object({ projectId: uuidOpt, applicationId: uuidOpt, environmentId: uuidOpt, from: z.string().optional(), to: z.string().optional() }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    const { from, to } = timeWindow(q.from, q.to, 30);

    // Run scope (time-bounded)
    const rc = new Conds([p.orgId]);
    rc.raw('r.organization_id = $1').raw('r.deleted_at IS NULL');
    if (projectId) rc.add('r.project_id = ?', projectId);
    if (q.applicationId) rc.add('r.application_id = ?', q.applicationId);
    if (q.environmentId) rc.add('r.environment_id = ?', q.environmentId);
    const scopeOnly = rc.where();
    const scopeParams = [...rc.params];
    rc.add('COALESCE(r.started_at, r.created_at) >= ?', from).add('COALESCE(r.started_at, r.created_at) <= ?', to);
    const W = rc.where();
    const P = rc.params;

    const tc = new Conds([p.orgId]);
    tc.raw('pr.organization_id = $1').raw('t.archived_at IS NULL');
    if (projectId) tc.add('t.project_id = ?', projectId);
    if (q.applicationId) tc.add('t.application_id = ?', q.applicationId);
    if (q.environmentId) tc.add('t.environment_id = ?', q.environmentId);

    const ac = new Conds([p.orgId]);
    ac.raw('pr.organization_id = $1');
    if (projectId) ac.add('al.project_id = ?', projectId);
    if (q.environmentId) ac.add('(al.run_id IS NULL OR r.environment_id = ?)', q.environmentId);
    if (q.applicationId) ac.add('(al.run_id IS NULL OR r.application_id = ?)', q.applicationId);

    const [agg, tests, running, sla, regs, alertCount, trend, dist, recent, alerts] = await Promise.all([
      one(`SELECT count(*)::int total,
                  avg(s.tps_avg) FILTER (WHERE r.status = 'COMPLETED') avg_tps,
                  avg(s.p95) FILTER (WHERE r.status = 'COMPLETED') avg_p95,
                  avg(s.error_pct) FILTER (WHERE r.status = 'COMPLETED') avg_err,
                  count(*) FILTER (WHERE r.result IN ('PASS','PASS_WITH_WARNINGS'))::int passed,
                  count(*) FILTER (WHERE r.result IN ('PASS','PASS_WITH_WARNINGS','FAIL'))::int judged
           FROM test_runs r ${SUMMARY_LATERAL} WHERE ${W}`, P),
      one(`SELECT count(*)::int n FROM performance_tests t JOIN projects pr ON pr.id = t.project_id WHERE ${tc.where()}`, tc.params),
      one(`SELECT count(*)::int n FROM test_runs r WHERE ${scopeOnly} AND r.status = 'RUNNING'`, scopeParams),
      one(`SELECT count(*) FILTER (WHERE sr.status NOT IN ('FAIL','NO_DATA'))::int passed, count(*) FILTER (WHERE sr.status <> 'NO_DATA')::int evaluated
           FROM sla_results sr JOIN test_runs r ON r.id = sr.run_id WHERE ${W}`, P),
      one(`SELECT count(*)::int n FROM regressions g JOIN test_runs r ON r.id = g.run_id WHERE ${W} AND g.direction = 'REGRESSION'`, P),
      one(`SELECT count(*)::int n FROM alerts al JOIN projects pr ON pr.id = al.project_id LEFT JOIN test_runs r ON r.id = al.run_id WHERE ${ac.where()} AND al.status = 'FIRING'`, ac.params),
      query(`SELECT * FROM (SELECT r.id, r.run_key, COALESCE(r.started_at, r.created_at) started_at, t.name test_name, r.build_number, r.result, r.performance_score, s.tps_avg, s.p95, s.error_pct
                            FROM test_runs r JOIN performance_tests t ON t.id = r.test_id ${SUMMARY_LATERAL}
                            WHERE ${W} AND r.status = 'COMPLETED' ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 200) x ORDER BY started_at`, P),
      query(`SELECT COALESCE(r.result, r.status) AS result, count(*)::int AS count FROM test_runs r WHERE ${W} GROUP BY 1 ORDER BY 2 DESC`, P),
      query(`${RUN_SELECT} WHERE ${W} ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 10`, P),
      query(`SELECT al.id, al.title, al.severity, al.status, al.fired_at, r.run_key FROM alerts al JOIN projects pr ON pr.id = al.project_id LEFT JOIN test_runs r ON r.id = al.run_id
             WHERE ${ac.where()} ORDER BY al.fired_at DESC LIMIT 10`, ac.params),
    ]);

    // Slowest transactions: latest completed run per test in the window, primary metric source
    const slow = await query(
      `WITH latest AS (
         SELECT DISTINCT ON (r.test_id) r.id, r.run_key, t.name test_name FROM test_runs r JOIN performance_tests t ON t.id = r.test_id
         WHERE ${W} AND r.status = 'COMPLETED' ORDER BY r.test_id, COALESCE(r.started_at, r.created_at) DESC),
       src AS (
         SELECT DISTINCT ON (x.run_id) x.run_id, x.source FROM transactions x JOIN latest l ON l.id = x.run_id
         ORDER BY x.run_id, CASE x.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END)
       SELECT x.name, l.test_name, l.run_key, x.p95, x.tps, x.error_pct FROM transactions x JOIN src ON src.run_id = x.run_id AND src.source = x.source
       JOIN latest l ON l.id = x.run_id WHERE x.p95 IS NOT NULL ORDER BY x.p95 DESC LIMIT 10`, P);

    // Infrastructure health: servers in scope with their latest sample
    const sc = new Conds([p.orgId]);
    sc.raw('pr.organization_id = $1');
    if (projectId) sc.add('s.project_id = ?', projectId);
    if (q.environmentId) sc.add('s.environment_id = ?', q.environmentId);
    if (q.applicationId) sc.add('(s.application_id = ? OR s.application_id IS NULL)', q.applicationId);
    const servers = await query(
      `SELECT s.id, s.name, s.role, s.status, s.last_seen_at, e.name environment_name FROM servers s JOIN projects pr ON pr.id = s.project_id
       LEFT JOIN environments e ON e.id = s.environment_id WHERE ${sc.where()} ORDER BY s.last_seen_at DESC NULLS LAST, s.name LIMIT 50`, sc.params);
    const lastSamples = servers.length
      ? await query(`SELECT DISTINCT ON (server_id) server_id, cpu_pct, memory_pct, ts FROM server_metrics WHERE server_id = ANY($1::uuid[]) AND ts > now() - interval '30 days' ORDER BY server_id, ts DESC`, [servers.map((s) => s.id)], tsPool)
      : [];
    const lastBy = new Map(lastSamples.map((x) => [x.server_id, x]));

    return {
      kpis: {
        activeTests: tests?.n ?? 0,
        totalRuns: agg?.total ?? 0,
        runningRuns: running?.n ?? 0,
        avgTps: n(agg?.avg_tps), avgP95: n(agg?.avg_p95), avgErrorPct: n(agg?.avg_err),
        slaCompliance: sla?.evaluated ? (sla.passed / sla.evaluated) * 100 : null,
        regressions: regs?.n ?? 0,
        activeAlerts: alertCount?.n ?? 0,
        passRate: agg?.judged ? (agg.passed / agg.judged) * 100 : null,
      },
      trend: trend.map((t) => ({ runId: t.id, runKey: t.run_key, startedAt: new Date(t.started_at).toISOString(), testName: t.test_name, buildNumber: t.build_number ?? null, tps: n(t.tps_avg), p95: n(t.p95), errorPct: n(t.error_pct), result: t.result ?? null, score: n(t.performance_score) })),
      topSlowTransactions: slow.map((t) => ({ name: t.name, testName: t.test_name, runKey: t.run_key, p95: Number(t.p95), tps: n(t.tps), errorPct: n(t.error_pct) })),
      infraHealth: servers.map((s) => {
        const last = lastBy.get(s.id);
        return { serverId: s.id, name: s.name, role: s.role ?? null, environmentName: s.environment_name ?? null, status: s.status, cpuPct: n(last?.cpu_pct), memoryPct: n(last?.memory_pct), lastSeenAt: s.last_seen_at ?? last?.ts ?? null };
      }),
      recentRuns: recent.map(runDto),
      recentAlerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, firedAt: a.fired_at, runKey: a.run_key ?? null })),
      resultDistribution: dist,
    };
  });

  // ------------------------------------------------------------------ Trends
  r.get('/trends', {
    ...view,
    schema: {
      tags: ['Analytics'], summary: 'Cross-run trends with degradation detection (slope + consecutive worsening, per test+environment)',
      querystring: z.object({ projectId: uuidOpt, testId: uuidOpt, environmentId: uuidOpt, applicationId: uuidOpt, groupBy: z.enum(['build', 'release', 'date']).default('date'), from: z.string().optional(), to: z.string().optional() }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    if (q.testId) await assertTest(p.orgId, q.testId);
    return loadTrend({ orgId: p.orgId, projectId, testId: q.testId, environmentId: q.environmentId, applicationId: q.applicationId, groupBy: q.groupBy, from: parseTime(q.from), to: parseTime(q.to) });
  });

  // ------------------------------------------------------------------ Capacity
  r.get('/capacity/model', {
    ...view,
    schema: { tags: ['Analytics'], summary: 'Latency-vs-load model fitted from completed runs (estimate)', querystring: z.object({ testId: uuidOpt, environmentId: uuidOpt, projectId: uuidOpt }) },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    if (!q.testId && !q.environmentId) throw badRequest('Provide testId and/or environmentId');
    const projectId = await projectFilter(req, q.projectId);
    if (q.testId) await assertTest(p.orgId, q.testId);
    const { fit, slaP95, ...res } = await capacityModel({ orgId: p.orgId, projectId, testId: q.testId, environmentId: q.environmentId });
    // Fitted coefficients (P95 = a + b·TPS, or e^(a + b·TPS)) so clients can draw the curve; still an estimate.
    const fitParams = fit ? { type: fit.type, a: fit.a, b: fit.b, r2: fit.r2, n: fit.n, minTps: fit.minTps, maxTps: fit.maxTps } : null;
    return { ...res, fit: fitParams, slaP95 };
  });

  r.post('/capacity/project', {
    ...view,
    schema: {
      tags: ['Analytics'], summary: 'Project latency/CPU/users at a target load (labelled estimate with assumptions and confidence)',
      body: z.object({
        testId: z.string().uuid().optional(), currentTps: z.number().positive(), targetTps: z.number().positive(),
        currentUsers: z.number().int().positive().optional(), targetUsers: z.number().int().positive().optional(),
        currentP95: z.number().positive(), slaP95: z.number().positive().optional(), currentCpu: z.number().min(0).max(100).optional(),
      }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const b = req.body;
    let fit = null;
    let slaFromTest: number | null = null;
    if (b.testId) {
      await assertTest(p.orgId, b.testId);
      const m = await capacityModel({ orgId: p.orgId, projectId: p.projectId ?? null, testId: b.testId });
      fit = m.fit;
      slaFromTest = await testSlaP95(b.testId);
    }
    return projectCapacity(b, fit, slaFromTest);
  });

  // ------------------------------------------------------------------ Compare
  r.post('/compare', {
    ...view,
    schema: { tags: ['Analytics'], summary: 'Compare 2–6 runs (first run is the reference)', body: z.object({ runIds: z.array(z.string().min(1)).min(2).max(6) }) },
  }, async (req) => {
    const p = principalOf(req);
    const refs = await Promise.all(req.body.runIds.map((id) => resolveRun(id, p)));
    if (new Set(refs.map((x) => x.id)).size !== refs.length) throw badRequest('runIds must be distinct');
    return compareRuns(refs.map((x) => x.id));
  });

  const comparisonDto = (c: any) => ({ id: c.id, name: c.name, projectId: c.project_id, runIds: c.run_ids, runKeys: c.run_keys ?? [], createdBy: c.created_by_name ?? null, createdById: c.created_by, createdAt: c.created_at });
  const COMPARISON_SELECT = `SELECT c.*, u.name created_by_name, (SELECT array_agg(tr.run_key ORDER BY array_position(c.run_ids, tr.id)) FROM test_runs tr WHERE tr.id = ANY(c.run_ids)) run_keys
    FROM comparisons c JOIN projects pr ON pr.id = c.project_id LEFT JOIN users u ON u.id = c.created_by`;

  r.get('/comparisons', { ...view, schema: { tags: ['Analytics'], summary: 'Saved comparisons', querystring: z.object({ projectId: uuidOpt }) } }, async (req) => {
    const p = principalOf(req);
    const projectId = await projectFilter(req, req.query.projectId);
    const rows = await query(`${COMPARISON_SELECT} WHERE pr.organization_id = $1 AND ($2::uuid IS NULL OR c.project_id = $2) ORDER BY c.created_at DESC LIMIT 200`, [p.orgId, projectId]);
    return rows.map(comparisonDto);
  });

  r.post('/comparisons', {
    preHandler: requireAny('EXECUTE_TEST', 'CREATE_DASHBOARD', 'EXPORT_REPORT'),
    schema: { tags: ['Analytics'], summary: 'Save a comparison', body: z.object({ name: z.string().min(1).max(200), runIds: z.array(z.string().min(1)).min(2).max(6), projectId: z.string().uuid().optional() }) },
  }, async (req, reply) => {
    const p = principalOf(req);
    const refs = await Promise.all(req.body.runIds.map((id) => resolveRun(id, p)));
    const projectId = req.body.projectId ?? refs[0].projectId;
    await projectFilter(req, projectId);
    const row = await one(`INSERT INTO comparisons (project_id, name, run_ids, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [projectId, req.body.name, refs.map((x) => x.id), p.kind === 'user' ? p.id : null]);
    await audit(req, { action: 'comparison.create', resourceType: 'comparison', resourceId: row!.id, details: { name: req.body.name, runIds: refs.map((x) => x.runKey) } });
    reply.code(201);
    return comparisonDto(await one(`${COMPARISON_SELECT} WHERE c.id = $1`, [row!.id]));
  });

  r.delete('/comparisons/:id', {
    preHandler: requireAny('EXECUTE_TEST', 'CREATE_DASHBOARD', 'EXPORT_REPORT'),
    schema: { tags: ['Analytics'], summary: 'Delete a saved comparison', params: z.object({ id: z.string().uuid() }) },
  }, async (req) => {
    const p = principalOf(req);
    const c = await one(`SELECT c.* FROM comparisons c JOIN projects pr ON pr.id = c.project_id WHERE c.id = $1 AND pr.organization_id = $2`, [req.params.id, p.orgId]);
    if (!c) throw notFound('Comparison', req.params.id);
    if (p.projectId && c.project_id !== p.projectId) throw forbidden('API key is not authorized for this project');
    if (c.created_by && p.kind === 'user' && c.created_by !== p.id && !p.permissions.has('MANAGE_PROJECT')) throw forbidden('Only the owner or a project manager can delete this comparison');
    await query(`DELETE FROM comparisons WHERE id = $1`, [c.id]);
    await audit(req, { action: 'comparison.delete', resourceType: 'comparison', resourceId: c.id, details: { name: c.name } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ Regressions
  r.get('/regressions', {
    ...view,
    schema: {
      tags: ['Analytics'], summary: 'Regressions / improvements across runs',
      querystring: z.object({ projectId: uuidOpt, testId: uuidOpt, environmentId: uuidOpt, runId: z.string().optional(), severity: z.string().optional(), direction: z.string().optional(), scope: z.string().optional(), from: z.string().optional(), to: z.string().optional(), ...page }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    const c = new Conds([p.orgId]);
    c.raw('r.organization_id = $1').raw('r.deleted_at IS NULL');
    if (projectId) c.add('r.project_id = ?', projectId);
    if (q.testId) c.add('r.test_id = ?', q.testId);
    if (q.environmentId) c.add('r.environment_id = ?', q.environmentId);
    if (q.runId) c.add('r.id = ?', (await resolveRun(q.runId, p)).id);
    if (q.severity) c.add('g.severity = ANY(?)', q.severity.split(',').map((s) => s.trim().toUpperCase()));
    if (q.direction) c.add('g.direction = ANY(?)', q.direction.split(',').map((s) => s.trim().toUpperCase()));
    if (q.scope) c.add('g.scope = ANY(?)', q.scope.split(',').map((s) => s.trim().toUpperCase()));
    if (q.from) c.add('g.created_at >= ?', parseTime(q.from));
    if (q.to) c.add('g.created_at <= ?', parseTime(q.to));
    const lim = c.param(q.pageSize);
    const off = c.param((q.page - 1) * q.pageSize);
    const rows = await query(
      `SELECT count(*) OVER() __total, g.*, r.run_key, t.name test_name, b.run_key baseline_run_key
       FROM regressions g JOIN test_runs r ON r.id = g.run_id JOIN performance_tests t ON t.id = r.test_id LEFT JOIN test_runs b ON b.id = g.baseline_run_id
       WHERE ${c.where()} ORDER BY g.created_at DESC, CASE g.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, g.change_pct DESC NULLS LAST
       LIMIT ${lim} OFFSET ${off}`, c.params);
    return {
      items: rows.map((g) => ({
        id: g.id, runId: g.run_id, runKey: g.run_key, testName: g.test_name, baselineRunKey: g.baseline_run_key ?? null, scope: g.scope, transaction: g.transaction,
        metric: g.metric, previousValue: g.previous_value, currentValue: g.current_value, changePct: g.change_pct, thresholdPct: g.threshold_pct,
        direction: g.direction, severity: g.severity, likelyImpacted: g.likely_impacted ?? [], createdAt: g.created_at,
      })),
      total: rows.length ? Number(rows[0].__total) : 0, page: q.page, pageSize: q.pageSize,
    };
  });

  // ------------------------------------------------------------------ Insights
  r.get('/insights', {
    ...view,
    schema: {
      tags: ['Analytics'], summary: 'Performance insights with recommendations across runs',
      querystring: z.object({ projectId: uuidOpt, testId: uuidOpt, runId: z.string().optional(), category: z.string().optional(), severity: z.string().optional(), from: z.string().optional(), to: z.string().optional(), ...page }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    const c = new Conds([p.orgId]);
    c.raw('r.organization_id = $1').raw('r.deleted_at IS NULL');
    if (projectId) c.add('r.project_id = ?', projectId);
    if (q.testId) c.add('r.test_id = ?', q.testId);
    if (q.runId) c.add('r.id = ?', (await resolveRun(q.runId, p)).id);
    if (q.category) c.add('i.category = ANY(?)', q.category.split(',').map((s) => s.trim().toUpperCase()));
    if (q.severity) c.add('i.severity = ANY(?)', q.severity.split(',').map((s) => s.trim().toUpperCase()));
    if (q.from) c.add('i.created_at >= ?', parseTime(q.from));
    if (q.to) c.add('i.created_at <= ?', parseTime(q.to));
    const lim = c.param(q.pageSize);
    const off = c.param((q.page - 1) * q.pageSize);
    const rows = await query(
      `SELECT count(*) OVER() __total, i.*, r.run_key, t.name test_name,
              COALESCE((SELECT json_agg(json_build_object('title', rc.title, 'description', rc.description, 'priority', rc.priority)
                                 ORDER BY CASE rc.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END)
                        FROM recommendations rc WHERE rc.insight_id = i.id), '[]'::json) recs
       FROM insights i JOIN test_runs r ON r.id = i.run_id JOIN performance_tests t ON t.id = r.test_id
       WHERE ${c.where()} ORDER BY i.created_at DESC, CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END
       LIMIT ${lim} OFFSET ${off}`, c.params);
    return {
      items: rows.map((i) => ({
        id: i.id, runId: i.run_id, runKey: i.run_key, testName: i.test_name, category: i.category, severity: i.severity, title: i.title, description: i.description,
        evidence: i.evidence ?? [], confidence: i.confidence, confidenceLabel: i.confidence_label, component: i.component, createdAt: i.created_at, recommendations: i.recs ?? [],
      })),
      total: rows.length ? Number(rows[0].__total) : 0, page: q.page, pageSize: q.pageSize,
    };
  });

  // ------------------------------------------------------------------ SLA summary
  r.get('/sla/summary', {
    ...view,
    schema: { tags: ['Analytics'], summary: 'SLA compliance across runs', querystring: z.object({ projectId: uuidOpt, testId: uuidOpt, from: z.string().optional(), to: z.string().optional() }) },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const projectId = await projectFilter(req, q.projectId);
    const { from, to } = timeWindow(q.from, q.to, 30);
    const c = new Conds([p.orgId]);
    c.raw('r.organization_id = $1').raw('r.deleted_at IS NULL');
    if (projectId) c.add('r.project_id = ?', projectId);
    if (q.testId) c.add('r.test_id = ?', q.testId);
    c.add('COALESCE(r.started_at, r.created_at) >= ?', from).add('COALESCE(r.started_at, r.created_at) <= ?', to);
    const [tot, runs, top] = await Promise.all([
      one(`SELECT count(*) FILTER (WHERE sr.status NOT IN ('FAIL','NO_DATA'))::int passed, count(*) FILTER (WHERE sr.status <> 'NO_DATA')::int evaluated
           FROM sla_results sr JOIN test_runs r ON r.id = sr.run_id WHERE ${c.where()}`, c.params),
      query(`SELECT r.run_key, t.name test_name, COALESCE(r.started_at, r.created_at) started_at,
                    count(*) FILTER (WHERE sr.status NOT IN ('FAIL','NO_DATA'))::int passed, count(*) FILTER (WHERE sr.status <> 'NO_DATA')::int evaluated,
                    count(*) FILTER (WHERE sr.status = 'FAIL')::int violations
             FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN sla_results sr ON sr.run_id = r.id
             WHERE ${c.where()} GROUP BY r.id, t.name ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 200`, c.params),
      query(`SELECT sr.metric, sr.transaction, count(*)::int count FROM sla_results sr JOIN test_runs r ON r.id = sr.run_id
             WHERE ${c.where()} AND sr.status = 'FAIL' GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 20`, c.params),
    ]);
    return {
      compliance: tot?.evaluated ? (tot.passed / tot.evaluated) * 100 : null,
      runs: runs.map((x) => ({ runKey: x.run_key, testName: x.test_name, startedAt: x.started_at, passPct: x.evaluated ? (x.passed / x.evaluated) * 100 : null, violations: x.violations })),
      topViolations: top.map((x) => ({ metric: x.metric, transaction: x.transaction ?? null, count: x.count })),
    };
  });
}
