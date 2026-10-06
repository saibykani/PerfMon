import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { one, query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { audit } from '../audit/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { typed, z, pageQuery, paged, orderBy, idParams } from '../lib/http.js';
import { storage, safeFileName, assertSafeKey } from '../storage/storage.js';
import { enqueue } from '../jobs/queue.js';
import { resolveRun } from '../ingest/runCache.js';
import { ARTIFACT_KINDS, SERVE_TYPES, type ArtifactKind } from './validation.js';
import { stageUpload, storeArtifact, reportViewerUrl, versionFor, verifyReportToken, type StagedFile } from './service.js';
import { config } from '../config.js';

const TEXT_KINDS = new Set(['JTL', 'CSV', 'JMX', 'LOG', 'SERVER_LOG', 'APP_LOG', 'CONFIG', 'TEST_DATA', 'JSON', 'XML']);

async function readMultipart(req: FastifyRequest) {
  if (!req.isMultipart()) throw badRequest('Expected multipart/form-data with a "file" field');
  const fields: Record<string, string> = {};
  let staged: StagedFile | null = null;
  for await (const part of req.parts({ limits: { fileSize: config.maxUploadBytes, files: 1 } })) {
    if (part.type === 'file') {
      if (staged) { part.file.resume(); continue; }
      staged = await stageUpload(part.file, part.filename || 'upload.bin');
    } else fields[part.fieldname] = String(part.value ?? '');
  }
  if (!staged) throw badRequest('No file provided (multipart field "file")');
  return { fields, staged };
}

function artifactDto(a: any, v?: any) {
  return {
    id: a.id, runId: a.run_id, runKey: a.run_key, kind: a.kind, name: a.name, description: a.description, source: a.source,
    currentVersion: a.current_version, createdAt: a.created_at, updatedAt: a.updated_at,
    latest: v ? versionDto(v) : undefined,
  };
}
function versionDto(v: any) {
  return {
    id: v.id, version: v.version, originalFilename: v.original_filename, mimeType: v.mime_type, sizeBytes: Number(v.size_bytes), sha256: v.sha256,
    uploadedBy: v.uploaded_by_name, uploadedAt: v.uploaded_at, processingStatus: v.processing_status, processingError: v.processing_error,
    scanStatus: v.scan_status, metadata: v.metadata, hasViewer: !!v.extracted_prefix,
  };
}

export async function artifactRoutes(app: FastifyInstance) {
  const r = typed(app);

  r.get('/artifacts', {
    preHandler: requirePermission('VIEW_RUN'),
    schema: { tags: ['Artifacts'], summary: 'Search artifacts across runs', querystring: z.object({ ...pageQuery, projectId: z.string().uuid().optional(), runId: z.string().optional(), kind: z.enum(ARTIFACT_KINDS).optional(), uploadedBy: z.string().optional(), includeDeleted: z.coerce.boolean().optional() }) },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query;
    const params: unknown[] = [p.orgId];
    const conds = ['pr.organization_id = $1'];
    if (!q.includeDeleted) conds.push('a.deleted_at IS NULL');
    if (q.projectId) { params.push(q.projectId); conds.push(`a.project_id = $${params.length}`); }
    if (q.runId) { const run = await resolveRun(q.runId, p); params.push(run.id); conds.push(`a.run_id = $${params.length}`); }
    if (q.kind) { params.push(q.kind); conds.push(`a.kind = $${params.length}`); }
    if (q.uploadedBy) { params.push(`%${q.uploadedBy}%`); conds.push(`v.uploaded_by_name ILIKE $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`, q.q.toLowerCase());
      conds.push(`(a.name ILIKE $${params.length - 1} OR v.original_filename ILIKE $${params.length - 1} OR r.run_key ILIKE $${params.length - 1} OR v.sha256 = $${params.length})`);
    }
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(
      `SELECT a.*, r.run_key, t.name AS test_name, v.id AS v_id, v.version, v.original_filename, v.mime_type, v.size_bytes, v.sha256, v.uploaded_by_name, v.uploaded_at,
              v.processing_status, v.processing_error, v.scan_status, v.metadata, v.extracted_prefix, count(*) OVER() AS __total
       FROM artifacts a JOIN projects pr ON pr.id = a.project_id JOIN test_runs r ON r.id = a.run_id JOIN performance_tests t ON t.id = a.test_id
       LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version
       WHERE ${conds.join(' AND ')}
       ORDER BY ${orderBy(q.sort, q.order, { name: 'a.name', kind: 'a.kind', size: 'v.size_bytes', uploaded: 'v.uploaded_at', run: 'r.run_key' }, 'v.uploaded_at')}
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const res = paged(rows, q.page, q.pageSize);
    return { ...res, items: res.items.map((a: any) => ({ ...artifactDto(a, { ...a, id: a.v_id }), testName: a.test_name, deletedAt: a.deleted_at })) };
  });

  r.get('/runs/:runId/artifacts', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Artifacts'], summary: 'List artifacts of a run', params: z.object({ runId: z.string() }) } }, async (req) => {
    const run = await resolveRun(req.params.runId, principalOf(req));
    const rows = await query(
      `SELECT a.*, $2::text AS run_key, v.id AS v_id, v.version, v.original_filename, v.mime_type, v.size_bytes, v.sha256, v.uploaded_by_name, v.uploaded_at, v.processing_status, v.processing_error, v.scan_status, v.metadata, v.extracted_prefix
       FROM artifacts a LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version
       WHERE a.run_id = $1 AND a.deleted_at IS NULL ORDER BY v.uploaded_at DESC`, [run.id, run.runKey]);
    return rows.map((a) => artifactDto(a, { ...a, id: a.v_id }));
  });

  const uploadHandler = async (req: FastifyRequest, runIdOrKey: string, artifactId: string | null) => {
    const p = principalOf(req);
    const { fields, staged } = await readMultipart(req);
    try {
      const kind = fields.kind ? (fields.kind.toUpperCase() as ArtifactKind) : null;
      if (kind && !ARTIFACT_KINDS.includes(kind)) throw badRequest(`Unknown artifact kind '${fields.kind}'`);
      const res = await storeArtifact({ runIdOrKey, principal: p, staged, kind, name: fields.name, description: fields.description, source: (fields.source?.toUpperCase() as any) || (p.kind === 'api_key' ? 'API' : 'UPLOAD'), artifactId });
      await audit(req, { action: res.duplicate ? 'artifact.upload_duplicate' : 'artifact.upload', resourceType: 'artifact', resourceId: res.artifact.id, details: { runId: res.artifact.run_id, kind: res.kind, version: res.version.version, sha256: staged.sha256, size: staged.size, filename: staged.filename } });
      return { duplicate: res.duplicate, artifact: artifactDto(res.artifact, res.version), message: res.duplicate ? 'Identical file (same SHA-256) already stored as the latest version — no new version created.' : `Stored as version ${res.version.version}` };
    } catch (e) {
      await audit(req, { action: 'artifact.upload', resourceType: 'artifact', result: 'FAILURE', details: { run: runIdOrKey, filename: staged.filename, error: (e as Error).message } });
      throw e;
    } finally {
      await rm(staged.dir, { recursive: true, force: true });
    }
  };

  r.post('/runs/:runId/artifacts', {
    preHandler: requirePermission('UPLOAD_ARTIFACT'),
    schema: {
      tags: ['Artifacts'], summary: 'Upload an artifact (multipart: file, kind?, name?, description?)', consumes: ['multipart/form-data'],
      description: 'Kinds: ' + ARTIFACT_KINDS.join(', ') + '. HTML reports: upload the JMeter report directory as .zip (or a single .html). Re-uploading with the same kind+name creates a new version; identical content (SHA-256) is detected and not duplicated.',
      params: z.object({ runId: z.string() }),
    },
  }, async (req) => uploadHandler(req, req.params.runId, null));

  r.post('/artifacts/:id/versions', {
    preHandler: requirePermission('UPLOAD_ARTIFACT'),
    schema: { tags: ['Artifacts'], summary: 'Replace an artifact by uploading a new version', consumes: ['multipart/form-data'], params: idParams },
  }, async (req) => {
    const a = await one(`SELECT a.run_id FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.organization_id = $2`, [req.params.id, principalOf(req).orgId]);
    if (!a) throw notFound('Artifact', req.params.id);
    return uploadHandler(req, a.run_id, req.params.id);
  });

  r.get('/artifacts/:id', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Artifacts'], summary: 'Artifact with version history', params: idParams } }, async (req) => {
    const { art } = await versionFor(req.params.id, 'latest', principalOf(req).orgId);
    const versions = await query(`SELECT * FROM artifact_versions WHERE artifact_id = $1 ORDER BY version DESC`, [art.id]);
    return { ...artifactDto(art, versions[0]), versions: versions.map(versionDto) };
  });

  r.delete('/artifacts/:id', {
    preHandler: requirePermission('DELETE_ARTIFACT'),
    schema: { tags: ['Artifacts'], summary: 'Soft-delete an artifact (files are retained until a confirmed retention purge)', params: idParams, querystring: z.object({ confirm: z.coerce.boolean().default(false) }) },
  }, async (req) => {
    if (!req.query.confirm) throw badRequest('Deletion requires confirmation: repeat the request with ?confirm=true');
    const { art } = await versionFor(req.params.id, 'latest', principalOf(req).orgId);
    await query(`UPDATE artifacts SET deleted_at = now() WHERE id = $1`, [art.id]);
    await audit(req, { action: 'artifact.delete', resourceType: 'artifact', resourceId: art.id, details: { runId: art.run_id, name: art.name, kind: art.kind } });
    return { ok: true };
  });

  r.post('/artifacts/:id/restore', { preHandler: requirePermission('DELETE_ARTIFACT'), schema: { tags: ['Artifacts'], summary: 'Restore a soft-deleted artifact', params: idParams } }, async (req) => {
    const { art } = await versionFor(req.params.id, 'latest', principalOf(req).orgId);
    await query(`UPDATE artifacts SET deleted_at = NULL WHERE id = $1`, [art.id]);
    await audit(req, { action: 'artifact.restore', resourceType: 'artifact', resourceId: art.id });
    return { ok: true };
  });

  const versionParams = z.object({ id: z.string().uuid(), version: z.union([z.literal('latest'), z.coerce.number().int().min(1)]) });

  r.get('/artifacts/:id/versions/:version/download', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Artifacts'], summary: 'Download the original file', params: versionParams } }, async (req, reply) => {
    const { art, v } = await versionFor(req.params.id, req.params.version as any, principalOf(req).orgId);
    const stream = await storage.get(v.storage_key);
    await audit(req, { action: 'artifact.download', resourceType: 'artifact', resourceId: art.id, details: { version: v.version } });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safeFileName(v.original_filename)}"`)
      .header('content-length', v.size_bytes)
      .header('x-checksum-sha256', v.sha256)
      .send(stream);
  });

  r.get('/artifacts/:id/versions/:version/preview', {
    preHandler: requirePermission('VIEW_RUN'),
    schema: { tags: ['Artifacts'], summary: 'Preview: text (first 256 KB) or image bytes', params: versionParams },
  }, async (req, reply) => {
    const { art, v } = await versionFor(req.params.id, req.params.version as any, principalOf(req).orgId);
    if (art.kind === 'SCREENSHOT' && /^image\/(png|jpeg|gif|webp)$/.test(v.mime_type)) {
      return reply.header('content-type', v.mime_type).header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'").send(await storage.get(v.storage_key));
    }
    if (!TEXT_KINDS.has(art.kind) || !/^text\/|json|xml/.test(v.mime_type ?? '')) return { previewable: false, mimeType: v.mime_type };
    const stream = await storage.get(v.storage_key);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of stream) { chunks.push(c as Buffer); n += (c as Buffer).length; if (n >= 256 * 1024) { (stream as any).destroy?.(); break; } }
    const content = Buffer.concat(chunks).subarray(0, 256 * 1024).toString('utf8');
    return { previewable: true, mimeType: v.mime_type, truncated: Number(v.size_bytes) > 256 * 1024, content };
  });

  r.post('/artifacts/:id/versions/:version/reprocess', { preHandler: requirePermission('UPLOAD_ARTIFACT'), schema: { tags: ['Artifacts'], summary: 'Re-run processing (parse report / import JTL / index logs)', params: versionParams } }, async (req) => {
    const { art, v } = await versionFor(req.params.id, req.params.version as any, principalOf(req).orgId);
    await query(`UPDATE artifact_versions SET processing_status = 'QUEUED', processing_error = NULL WHERE id = $1`, [v.id]);
    const jobId = await enqueue('artifact.process', { versionId: v.id }, { runId: art.run_id, priority: 3 });
    await audit(req, { action: 'artifact.reprocess', resourceType: 'artifact', resourceId: art.id, details: { version: v.version } });
    return { jobId };
  });

  // HTML report for a run: latest version + parsed summary + sandboxed viewer URL + history
  r.get('/runs/:runId/html-report', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['Artifacts'], summary: 'HTML report for a run (viewer URL, metadata, parsed statistics, versions)', params: z.object({ runId: z.string() }), querystring: z.object({ version: z.coerce.number().int().optional() }) } }, async (req) => {
    const run = await resolveRun(req.params.runId, principalOf(req));
    const art = await one(`SELECT * FROM artifacts WHERE run_id = $1 AND kind = 'HTML_REPORT' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`, [run.id]);
    if (!art) return { available: false };
    const versions = await query(`SELECT * FROM artifact_versions WHERE artifact_id = $1 ORDER BY version DESC`, [art.id]);
    const v = req.query.version ? versions.find((x) => x.version === req.query.version) : versions[0];
    if (!v) throw notFound('Report version', String(req.query.version));
    const summary = await one(`SELECT * FROM html_report_summaries WHERE artifact_version_id = $1`, [v.id]);
    return {
      available: true,
      artifact: artifactDto({ ...art, run_key: run.runKey }, v),
      version: versionDto(v),
      versions: versions.map(versionDto),
      viewerUrl: v.extracted_prefix ? reportViewerUrl(v.id, v.entry_file ?? 'index.html') : null,
      downloadUrl: `/api/v1/artifacts/${art.id}/versions/${v.version}/download`,
      summary,
    };
  });
}

/**
 * Report content server. Serves extracted HTML reports from a separate origin
 * (REPORT_CONTENT_ORIGIN / REPORT_CONTENT_PORT) with a CSP sandbox so uploaded
 * HTML/JS never executes with Perfmon's origin privileges. Access is granted
 * by short-lived HMAC-signed URL tokens (iframes cannot send Authorization headers).
 */
export async function reportContentRoutes(app: FastifyInstance) {
  app.get('/report-content/:token/*', async (req: FastifyRequest<{ Params: { token: string; '*': string } }>, reply: FastifyReply) => {
    const versionId = verifyReportToken(req.params.token);
    if (!versionId) return reply.code(403).type('text/plain').send('Report link expired or invalid. Reopen the report from Perfmon.');
    const v = await one(`SELECT extracted_prefix FROM artifact_versions WHERE id = $1`, [versionId]);
    if (!v?.extracted_prefix) return reply.code(404).type('text/plain').send('Not found');
    let rel = (req.params['*'] || 'index.html').split('?')[0];
    try { rel = decodeURIComponent(rel); } catch { return reply.code(400).send(); }
    if (rel.endsWith('/') || rel === '') rel += 'index.html';
    const key = `${v.extracted_prefix}/${rel}`;
    try { assertSafeKey(key); } catch { return reply.code(400).type('text/plain').send('Bad path'); }
    const head = await storage.head(key);
    if (!head) return reply.code(404).type('text/plain').send('Not found');
    const frameAncestors = [config.publicUrl, ...config.corsOrigins].filter(Boolean).join(' ');
    return reply
      .header('content-type', SERVE_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream')
      .header('content-security-policy', `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; frame-ancestors 'self' ${frameAncestors}; form-action 'none'`)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('cache-control', 'private, max-age=300')
      .send(await storage.get(key));
  });
}
