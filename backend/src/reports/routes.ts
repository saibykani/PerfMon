import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { typed, z, idParams, assertProject } from '../lib/http.js';
import { Conds, projectFilter, parseTime, likeEscape } from '../lib/scope.js';
import { resolveRun } from '../ingest/runCache.js';
import { createReport, sweepStaleReports, GENERATABLE_TYPES, type ReportParams } from './generate.js';
import { renderHtml, renderPdf, renderCsv, renderXlsx } from './render.js';
import type { ReportContent } from './content.js';

const FORMATS = ['html', 'pdf', 'csv', 'json', 'xlsx'] as const;
const MIME: Record<(typeof FORMATS)[number], string> = {
  html: 'text/html; charset=utf-8', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const TYPE_LABEL: Record<string, string> = { TEST_EXECUTION: 'Test Execution Report', COMPARISON: 'Comparison Report', EXECUTIVE: 'Executive Summary' };

const SELECT = `
  SELECT rp.id, rp.project_id, rp.run_id, rp.type, rp.title, rp.version, rp.status, rp.params, rp.error, rp.created_by, rp.created_at, rp.updated_at,
         r.run_key, pr.name AS project_name, pr.organization_id, u.name AS created_by_name
  FROM reports rp
  JOIN projects pr ON pr.id = rp.project_id
  LEFT JOIN test_runs r ON r.id = rp.run_id
  LEFT JOIN users u ON u.id = rp.created_by`;

const dto = (x: any) => ({
  id: x.id, type: x.type, title: x.title, version: x.version, status: x.status, error: x.error ?? null,
  runId: x.run_id, runKey: x.run_key ?? null, runKeys: x.params?.runKeys ?? (x.run_key ? [x.run_key] : []),
  projectId: x.project_id, projectName: x.project_name, createdBy: x.created_by_name ?? (x.params?.auto ? 'Automatic' : null), createdById: x.created_by,
  createdAt: x.created_at, updatedAt: x.updated_at, params: x.params ?? {}, auto: !!x.params?.auto,
});

/** Loads a report in the caller's organization (and API-key project binding). */
async function loadReport(req: FastifyRequest, id: string, withContent = false) {
  const p = principalOf(req);
  const row = await one(`${SELECT.replace('rp.created_at, rp.updated_at', `rp.created_at, rp.updated_at${withContent ? ', rp.content' : ''}`)} WHERE rp.id = $1`, [id]);
  if (!row || row.organization_id !== p.orgId || (p.projectId && p.projectId !== row.project_id)) throw notFound('Report', id);
  return row;
}

const fileName = (row: any, ext: string) => {
  const base = `${row.run_key ? row.run_key + '-' : ''}${String(row.type).toLowerCase().replace(/_/g, '-')}-v${row.version}`;
  return `${base.replace(/[^A-Za-z0-9._-]+/g, '-')}.${ext}`;
};

/** CSP for rendered report HTML: no scripts, no external loads (inline styles + SVG only). */
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors *";

export async function reportRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_REPORT') };
  const exportPerm = { preHandler: requirePermission('EXPORT_REPORT') };

  r.get('/reports', {
    ...view,
    schema: {
      tags: ['Reports'], summary: 'List generated reports',
      querystring: z.object({
        projectId: z.string().uuid().optional(), runId: z.string().optional(), type: z.string().optional(), status: z.string().optional(), q: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    await sweepStaleReports();
    const projectId = await projectFilter(req, q.projectId);
    const c = new Conds([p.orgId]);
    c.raw('pr.organization_id = $1');
    if (projectId) c.add('rp.project_id = ?', projectId);
    if (q.runId) {
      // the run's own reports + comparisons that include it
      const ref = await resolveRun(q.runId, p);
      c.add(`(rp.run_id = ?::uuid OR rp.params->'runIds' @> jsonb_build_array(?::text))`, ref.id);
    }
    if (q.type) c.add('rp.type = ANY(?)', q.type.split(',').map((s) => s.trim().toUpperCase()));
    if (q.status) c.add('rp.status = ANY(?)', q.status.split(',').map((s) => s.trim().toUpperCase()));
    if (q.q) c.add(`(rp.title ILIKE ? OR r.run_key ILIKE ?)`, `%${likeEscape(q.q)}%`);
    const lim = c.param(q.pageSize);
    const off = c.param((q.page - 1) * q.pageSize);
    const rows = await query(`${SELECT.replace('SELECT rp.id', 'SELECT count(*) OVER() AS __total, rp.id')} WHERE ${c.where()} ORDER BY rp.created_at DESC LIMIT ${lim} OFFSET ${off}`, c.params);
    const total = rows.length ? Number(rows[0].__total) : 0;
    return { items: rows.map(dto), total, page: q.page, pageSize: q.pageSize, totalPages: Math.ceil(total / q.pageSize) };
  });

  r.post('/reports', {
    ...exportPerm,
    schema: {
      tags: ['Reports'], summary: 'Generate a report (queued; poll GET /reports/:id until READY)',
      description: 'TEST_EXECUTION: runId. COMPARISON: runIds (2–6, first is the reference). EXECUTIVE: projectId + optional from/to (default last 30 days), testId, environmentId. Re-generating the same subject creates version N+1.',
      body: z.object({
        type: z.enum(GENERATABLE_TYPES), projectId: z.string().uuid().optional(), runId: z.string().optional(), runIds: z.array(z.string()).min(2).max(6).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        params: z.object({ from: z.string().optional(), to: z.string().optional(), testId: z.string().uuid().optional(), environmentId: z.string().uuid().optional() }).optional(),
      }),
    },
  }, async (req, reply) => {
    const p = principalOf(req);
    const b = req.body;
    let projectId: string;
    let runId: string | null = null;
    let title: string;
    const params: ReportParams & { runKeys?: string[] } = {};
    if (b.type === 'TEST_EXECUTION') {
      if (!b.runId) throw badRequest('runId is required for a TEST_EXECUTION report');
      const ref = await resolveRun(b.runId, p, true);
      if (b.projectId && b.projectId !== ref.projectId) throw badRequest(`Run ${ref.runKey} does not belong to this project`);
      if (['SCHEDULED', 'QUEUED', 'RUNNING'].includes(ref.status)) throw conflict(`Run ${ref.runKey} is ${ref.status}; generate the report once it has finished`);
      projectId = ref.projectId; runId = ref.id; params.runKeys = [ref.runKey];
      title = b.title ?? `${TYPE_LABEL.TEST_EXECUTION} — ${ref.runKey}`;
    } else if (b.type === 'COMPARISON') {
      const keys = b.runIds ?? [];
      if (keys.length < 2) throw badRequest('runIds must contain at least two runs for a COMPARISON report');
      const refs = await Promise.all(keys.map((k) => resolveRun(k, p)));
      if (new Set(refs.map((x) => x.id)).size !== refs.length) throw badRequest('runIds contains the same run twice');
      projectId = b.projectId ?? refs[0].projectId;
      if (b.projectId) await assertProject(req, b.projectId);
      params.runIds = refs.map((x) => x.id); params.runKeys = refs.map((x) => x.runKey);
      title = b.title ?? `${TYPE_LABEL.COMPARISON} — ${refs.map((x) => x.runKey).join(' vs ')}`;
    } else {
      const pid = b.projectId ?? p.projectId;
      if (!pid) throw badRequest('projectId is required for an EXECUTIVE report');
      const proj = await assertProject(req, pid);
      projectId = proj.id;
      const to = parseTime(b.params?.to) ?? new Date();
      const from = parseTime(b.params?.from) ?? new Date(to.getTime() - 30 * 86400000);
      if (from >= to) throw badRequest('`from` must be before `to`');
      if (b.params?.testId && !(await one(`SELECT 1 FROM performance_tests WHERE id = $1 AND project_id = $2`, [b.params.testId, projectId]))) throw badRequest('Test does not belong to this project');
      if (b.params?.environmentId && !(await one(`SELECT 1 FROM environments WHERE id = $1 AND project_id = $2`, [b.params.environmentId, projectId]))) throw badRequest('Environment does not belong to this project');
      Object.assign(params, { from: from.toISOString(), to: to.toISOString(), testId: b.params?.testId ?? null, environmentId: b.params?.environmentId ?? null });
      const name = (await one(`SELECT name FROM projects WHERE id = $1`, [projectId]))?.name ?? 'Project';
      title = b.title ?? `${TYPE_LABEL.EXECUTIVE} — ${name} (${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)})`;
    }
    const row = await createReport({ type: b.type, projectId, runId, title, params, createdBy: p.kind === 'user' ? p.id : null, priority: 3 });
    await audit(req, { action: 'report.create', resourceType: 'report', resourceId: row.id, details: { type: b.type, title, version: row.version, runId: params.runKeys?.[0] ?? null, runKeys: params.runKeys, projectId } });
    reply.code(201);
    return { id: row.id, status: row.status, version: row.version };
  });

  r.get('/reports/:id', { ...view, schema: { tags: ['Reports'], summary: 'Report metadata + content model (null until READY)', params: idParams } }, async (req) => {
    await sweepStaleReports();
    const row = await loadReport(req, req.params.id, true);
    return { ...dto(row), content: (row.content ?? null) as ReportContent | null };
  });

  r.get('/reports/:id/preview', { ...view, schema: { tags: ['Reports'], summary: 'Rendered HTML (for in-app preview; no scripts)', params: idParams } }, async (req, reply) => {
    const row = await loadReport(req, req.params.id, true);
    if (row.status !== 'READY' || !row.content) throw conflict(`Report is ${row.status}`);
    return reply.header('content-type', MIME.html).header('content-security-policy', HTML_CSP).header('x-content-type-options', 'nosniff').send(renderHtml(row.content));
  });

  r.get('/reports/:id/export', {
    ...exportPerm,
    schema: { tags: ['Reports'], summary: 'Download the report (pdf | html | csv | json | xlsx)', params: idParams, querystring: z.object({ format: z.enum(FORMATS).default('pdf') }) },
  }, async (req, reply) => {
    const row = await loadReport(req, req.params.id, true);
    if (row.status !== 'READY' || !row.content) throw conflict(`Report is ${row.status}; it can be downloaded once READY`);
    const content = row.content as ReportContent;
    const f = req.query.format;
    const body = f === 'html' ? renderHtml(content)
      : f === 'pdf' ? await renderPdf(content)
      : f === 'csv' ? renderCsv(content)
      : f === 'xlsx' ? await renderXlsx(content)
      : JSON.stringify({ id: row.id, ...content, params: row.params }, null, 2);
    reply.header('content-type', MIME[f]).header('content-disposition', `attachment; filename="${fileName(row, f)}"`).header('x-content-type-options', 'nosniff');
    if (f === 'html') reply.header('content-security-policy', HTML_CSP);
    return reply.send(body);
  });

  r.post('/reports/:id/regenerate', { ...exportPerm, schema: { tags: ['Reports'], summary: 'Generate a new version of the report with the same parameters', params: idParams } }, async (req, reply) => {
    const p = principalOf(req);
    const row = await loadReport(req, req.params.id);
    if (!(GENERATABLE_TYPES as readonly string[]).includes(row.type)) throw badRequest(`Report type ${row.type} cannot be generated`);
    const { subjectKey, jobId, auto, ...params } = row.params ?? {};
    const title = String(row.title);
    const created = await createReport({ type: row.type, projectId: row.project_id, runId: row.run_id, title, params, createdBy: p.kind === 'user' ? p.id : null, priority: 3 });
    await audit(req, { action: 'report.create', resourceType: 'report', resourceId: created.id, details: { type: row.type, title, version: created.version, regeneratedFrom: row.id } });
    reply.code(201);
    return { id: created.id, status: created.status, version: created.version };
  });

  r.delete('/reports/:id', {
    ...exportPerm,
    schema: { tags: ['Reports'], summary: 'Delete a report version', params: idParams, querystring: z.object({ confirm: z.coerce.boolean().default(false) }) },
  }, async (req) => {
    if (!req.query.confirm) throw badRequest('Deletion requires confirmation: repeat the request with ?confirm=true');
    const row = await loadReport(req, req.params.id);
    await query(`DELETE FROM reports WHERE id = $1`, [row.id]);
    await audit(req, { action: 'report.delete', resourceType: 'report', resourceId: row.id, details: { type: row.type, title: row.title, version: row.version, runId: row.run_key ?? null } });
    return { ok: true };
  });
}
