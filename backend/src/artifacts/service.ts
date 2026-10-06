import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, open as fsOpen } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, notFound, tooLarge } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';
import { storage, safeFileName } from '../storage/storage.js';
import { enqueue, registerJob } from '../jobs/queue.js';
import { selfMetrics } from '../selfmon/registry.js';
import { inferKind, isBlocked, validateContent, type ArtifactKind, SERVE_TYPES } from './validation.js';
import { listZip, checkZipLimits, findReportRoot, forEachZipEntry } from './zip.js';
import { parseJMeterReport } from '../reports/htmlReportParser.js';
import { parseJtlStream } from '../ingest/jtl.js';
import { aggregator, deleteRunMetrics } from '../ingest/aggregator.js';
import { resolveRun } from '../ingest/runCache.js';
import { publishRunEvent } from '../live/hub.js';

const FOLDER: Record<string, string> = {
  HTML_REPORT: 'reports', JTL: 'jtl', CSV: 'csv', JMX: 'jmx', LOG: 'logs', SERVER_LOG: 'logs', APP_LOG: 'logs', SCREENSHOT: 'screenshots',
  CONFIG: 'config', TEST_DATA: 'test-data', JSON: 'other', XML: 'other', PDF: 'other', EXCEL: 'other', ZIP: 'other', OTHER: 'other',
};

export interface StagedFile { path: string; dir: string; size: number; sha256: string; head: Buffer; filename: string }

/** Stream an upload to a temp file while computing SHA-256 and enforcing the size limit. */
export async function stageUpload(stream: Readable, filename: string): Promise<StagedFile> {
  const dir = await mkdtemp(join(tmpdir(), 'perfmon-up-'));
  const path = join(dir, 'upload.bin');
  const hash = createHash('sha256');
  let size = 0;
  const head: Buffer[] = [];
  let headLen = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > config.maxUploadBytes) return cb(tooLarge(`File exceeds the ${Math.round(config.maxUploadBytes / 1048576)} MB upload limit`));
      hash.update(chunk);
      if (headLen < 8192) { head.push(chunk.subarray(0, 8192 - headLen)); headLen += Math.min(chunk.length, 8192 - headLen); }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, createWriteStream(path));
    if ((stream as any).truncated) throw tooLarge(`File exceeds the ${Math.round(config.maxUploadBytes / 1048576)} MB upload limit`);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  if (size === 0) { await rm(dir, { recursive: true, force: true }); throw badRequest('Uploaded file is empty'); }
  return { path, dir, size, sha256: hash.digest('hex'), head: Buffer.concat(head), filename };
}

/** Optional external malware scan integration point (MALWARE_SCAN_URL). */
async function malwareScan(f: StagedFile): Promise<'CLEAN' | 'NOT_SCANNED' | 'INFECTED' | 'ERROR'> {
  if (!config.malwareScanUrl) return 'NOT_SCANNED';
  try {
    const res = await fetch(config.malwareScanUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: f.sha256, filename: f.filename, size: f.size }), signal: AbortSignal.timeout(15000) });
    const j = (await res.json()) as { clean?: boolean };
    return j.clean === false ? 'INFECTED' : 'CLEAN';
  } catch { return 'ERROR'; }
}

export async function storeArtifact(opts: {
  runIdOrKey: string; principal: any; staged: StagedFile; kind?: ArtifactKind | null; name?: string | null; description?: string | null;
  source?: 'UPLOAD' | 'CI' | 'API' | 'SYSTEM' | 'COLLECTOR'; artifactId?: string | null;
}) {
  const { staged } = opts;
  if (isBlocked(staged.filename)) throw badRequest('Executable and script files are not accepted as artifacts');
  const run = await resolveRun(opts.runIdOrKey, opts.principal);
  let existing: any = null;
  if (opts.artifactId) {
    existing = await one(`SELECT * FROM artifacts WHERE id = $1 AND run_id = $2 AND deleted_at IS NULL`, [opts.artifactId, run.id]);
    if (!existing) throw notFound('Artifact', opts.artifactId);
  }
  let kind: ArtifactKind = existing?.kind ?? opts.kind ?? inferKind(staged.filename);
  // A ZIP that contains a JMeter dashboard is an HTML report.
  if (kind === 'ZIP' || (kind === 'HTML_REPORT' && extname(staged.filename).toLowerCase() === '.zip')) {
    let entries;
    try { entries = await listZip(staged.path); } catch (e) { throw badRequest(`Invalid ZIP archive: ${(e as Error).message}`); }
    try { checkZipLimits(entries); } catch (e) { throw badRequest((e as Error).message); }
    const root = findReportRoot(entries);
    if (kind === 'HTML_REPORT' && root == null) throw badRequest('ZIP does not contain an index.html — compress the JMeter report output directory (index.html, content/, sbadmin2-1.0.7/...)');
    if (kind === 'ZIP' && root != null && entries.some((e) => e.name.includes('content/js/dashboard.js'))) kind = 'HTML_REPORT';
  }
  // CSV with a JTL header is treated as JTL results
  if (kind === 'CSV' && /^timeStamp,|^"timeStamp"/.test(staged.head.toString('utf8', 0, 200))) kind = 'JTL';
  let mime: string;
  try { mime = validateContent(kind, staged.filename, staged.head); } catch (e) { throw badRequest(`File validation failed: ${(e as Error).message}`); }
  const scan = await malwareScan(staged);
  if (scan === 'INFECTED') throw badRequest('File rejected by malware scanner');

  const name = (existing?.name ?? opts.name?.trim()) || (kind === 'HTML_REPORT' ? 'jmeter-report' : staged.filename);
  const proj = await one(`SELECT p.key, t.name AS test_name, t.id AS test_id FROM projects p JOIN performance_tests t ON t.project_id = p.id WHERE p.id = $1 AND t.id = $2`, [run.projectId, run.testId]);

  return tx(async (client) => {
    let art = existing ?? (await one(`SELECT * FROM artifacts WHERE run_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`, [run.id, kind, name], client));
    if (art) {
      const latest = await one(`SELECT * FROM artifact_versions WHERE artifact_id = $1 ORDER BY version DESC LIMIT 1`, [art.id], client);
      if (latest && latest.sha256 === staged.sha256 && !art.deleted_at) {
        return { artifact: art, version: latest, duplicate: true, kind };
      }
    }
    if (!art) {
      art = await one(`INSERT INTO artifacts (run_id, project_id, test_id, kind, name, description, source, current_version, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8) RETURNING *`,
        [run.id, run.projectId, run.testId, kind, name, opts.description ?? null, opts.source ?? 'UPLOAD', opts.principal?.kind === 'user' ? opts.principal.id : null], client);
    } else if (art.deleted_at) {
      await client.query(`UPDATE artifacts SET deleted_at = NULL WHERE id = $1`, [art.id]);
    }
    const version = Number(art.current_version) + 1;
    const testSlug = safeFileName(proj.test_name).toLowerCase();
    const base = `projects/${safeFileName(proj.key)}/tests/${testSlug}-${run.testId.slice(0, 8)}/runs/${run.runKey}/${FOLDER[kind]}/${art.id}/v${version}`;
    const storageKey = `${base}/${safeFileName(staged.filename)}`;
    await storage.put(storageKey, createReadStream(staged.path), mime, staged.size);
    const dupes = await client.query(`SELECT a.name, v.version, r.run_key FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id JOIN test_runs r ON r.id = a.run_id WHERE v.sha256 = $1 LIMIT 5`, [staged.sha256]);
    const v = await one(
      `INSERT INTO artifact_versions (artifact_id, version, storage_key, original_filename, mime_type, size_bytes, sha256, uploaded_by, uploaded_by_name, processing_status, scan_status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [art.id, version, storageKey, staged.filename, mime, staged.size, staged.sha256, opts.principal?.kind === 'user' ? opts.principal.id : null, opts.principal?.name ?? null,
        needsProcessing(kind) ? 'QUEUED' : 'SKIPPED', scan === 'ERROR' ? 'ERROR' : scan, JSON.stringify({ duplicateOf: dupes.rows })], client);
    await client.query(`UPDATE artifacts SET current_version = $2, updated_at = now(), kind = $3 WHERE id = $1`, [art.id, version, kind]);
    if (needsProcessing(kind)) await enqueue('artifact.process', { versionId: v.id }, { runId: run.id, priority: 3 }, client);
    selfMetrics.inc('artifacts_uploaded');
    return { artifact: { ...art, current_version: version, kind }, version: v, duplicate: false, kind };
  });
}

const needsProcessing = (kind: string) => ['HTML_REPORT', 'JTL', 'LOG', 'SERVER_LOG', 'APP_LOG'].includes(kind);

// ---------------------------------------------------------------------------------------------
// Processing jobs
// ---------------------------------------------------------------------------------------------
async function downloadToTemp(key: string) {
  const dir = await mkdtemp(join(tmpdir(), 'perfmon-proc-'));
  const path = join(dir, 'file.bin');
  await pipeline(await storage.get(key), createWriteStream(path));
  return { dir, path };
}

async function readEntryText(stream: Readable, limit = 64 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) { n += c.length; if (n > limit) throw new Error('report file too large to parse'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

async function processHtmlReport(v: any, art: any) {
  const { dir, path } = await downloadToTemp(v.storage_key);
  try {
    const prefix = v.storage_key.replace(/\/[^/]+$/, '') + '/site';
    const files: { statisticsJson?: string; dashboardJs?: string; indexHtml?: string; graphJs?: string } = {};
    let entry = 'index.html';
    const isZip = (await (async () => { const fh = await fsOpen(path, 'r'); const b = Buffer.alloc(4); await fh.read(b, 0, 4, 0); await fh.close(); return b.toString('hex') === '504b0304'; })());
    if (isZip) {
      const entries = await listZip(path);
      checkZipLimits(entries);
      const root = findReportRoot(entries) ?? '';
      let stored = 0;
      await forEachZipEntry(path, async (p, stream, size) => {
        if (!p.startsWith(root)) { stream.resume(); return; }
        const rel = p.slice(root.length);
        if (!rel) { stream.resume(); return; }
        const key = `${prefix}/${rel}`;
        const isParseable = ['statistics.json', 'content/js/dashboard.js', 'index.html', 'content/js/graph.js'].includes(rel);
        if (isParseable) {
          const text = await readEntryText(stream);
          await storage.put(key, Buffer.from(text, 'utf8'), SERVE_TYPES[extname(rel).toLowerCase()]);
          if (rel === 'statistics.json') files.statisticsJson = text;
          if (rel === 'content/js/dashboard.js') files.dashboardJs = text;
          if (rel === 'index.html') files.indexHtml = text;
          if (rel === 'content/js/graph.js') files.graphJs = text;
        } else {
          await storage.put(key, stream, SERVE_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream', size);
        }
        stored++;
      });
      await query(`UPDATE artifact_versions SET metadata = metadata || $2 WHERE id = $1`, [v.id, JSON.stringify({ extractedFiles: stored, reportRoot: root })]);
    } else {
      const html = await readEntryText(createReadStream(path));
      await storage.put(`${prefix}/index.html`, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
      files.indexHtml = html;
      // single-file reports sometimes inline dashboard data
      if (html.includes('createTable(')) files.dashboardJs = html;
      entry = 'index.html';
    }
    const parsed = parseJMeterReport(files);
    await saveParsedReport(v, art, parsed);
    await query(`UPDATE artifact_versions SET extracted_prefix = $2, entry_file = $3 WHERE id = $1`, [v.id, prefix, entry]);
    return { parsed: !!parsed.overall, transactions: parsed.transactions.length, warnings: parsed.warnings };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function saveParsedReport(v: any, art: any, p: ReturnType<typeof parseJMeterReport>) {
  await query(
    `INSERT INTO html_report_summaries (artifact_version_id, run_id, parser_version, report_generated_at, overall, transactions, errors, top_errors, response_codes, apdex, warnings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (artifact_version_id) DO UPDATE SET parsed_at = now(), parser_version = EXCLUDED.parser_version, overall = EXCLUDED.overall, transactions = EXCLUDED.transactions,
       errors = EXCLUDED.errors, top_errors = EXCLUDED.top_errors, response_codes = EXCLUDED.response_codes, apdex = EXCLUDED.apdex, warnings = EXCLUDED.warnings`,
    [v.id, art.run_id, p.parserVersion, p.startTime, JSON.stringify({ ...p.overall, startTime: p.startTime, endTime: p.endTime, sourceFile: p.sourceFile }), JSON.stringify(p.transactions),
      JSON.stringify(p.errors), JSON.stringify(p.topErrors), JSON.stringify(p.responseCodes), p.apdex ? JSON.stringify(p.apdex) : null, p.warnings]);
  // Only the latest version feeds the run's html_report summary
  const latest = await one(`SELECT max(version) v FROM artifact_versions WHERE artifact_id = $1`, [art.id]);
  if (Number(latest.v) !== Number(v.version) || !p.overall) return;
  const o = p.overall;
  const duration = p.startMs && p.endMs ? (p.endMs - p.startMs) / 1000 : o.samples && o.throughput ? o.samples / o.throughput : null;
  await query(
    `INSERT INTO run_summary (run_id, source, total_samples, success_count, failure_count, error_pct, tps_avg, avg_rt, min_rt, max_rt, median_rt, p50, p75, p90, p95, p99, p999,
        received_kb_sec, sent_kb_sec, duration_sec, percentile_method, apdex, extra)
     VALUES ($1,'html_report',$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17,$18,'source_reported',$19,$20)
     ON CONFLICT (run_id, source) DO UPDATE SET computed_at = now(), total_samples = EXCLUDED.total_samples, success_count = EXCLUDED.success_count, failure_count = EXCLUDED.failure_count,
       error_pct = EXCLUDED.error_pct, tps_avg = EXCLUDED.tps_avg, avg_rt = EXCLUDED.avg_rt, min_rt = EXCLUDED.min_rt, max_rt = EXCLUDED.max_rt, median_rt = EXCLUDED.median_rt,
       p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90, p95 = EXCLUDED.p95, p99 = EXCLUDED.p99, p999 = EXCLUDED.p999, received_kb_sec = EXCLUDED.received_kb_sec,
       sent_kb_sec = EXCLUDED.sent_kb_sec, duration_sec = EXCLUDED.duration_sec, apdex = EXCLUDED.apdex, extra = EXCLUDED.extra`,
    [art.run_id, o.samples, o.samples != null && o.failures != null ? o.samples - o.failures : null, o.failures, o.errorPct, o.throughput, o.avg, o.min, o.max, o.median,
      o.percentiles.p75 ?? null, o.percentiles.p90 ?? null, o.percentiles.p95 ?? null, o.percentiles.p99 ?? null, o.percentiles.p999 ?? null, o.receivedKbSec, o.sentKbSec, duration,
      p.apdex?.overall?.apdex ?? null, JSON.stringify({ artifactVersionId: v.id, version: v.version, startTime: p.startTime, endTime: p.endTime })]);
  await query(`DELETE FROM transactions WHERE run_id = $1 AND source = 'html_report'`, [art.run_id]);
  for (const t of p.transactions) {
    await query(
      `INSERT INTO transactions (run_id, name, source, samples, errors, error_pct, tps, avg_rt, min_rt, max_rt, median_rt, p75, p90, p95, p99, received_kb_sec, sent_kb_sec, percentile_method)
       VALUES ($1,$2,'html_report',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'source_reported') ON CONFLICT (run_id, name, source) DO NOTHING`,
      [art.run_id, t.label.slice(0, 300), t.samples ?? 0, t.failures ?? 0, t.errorPct, t.throughput, t.avg, t.min, t.max, t.median, t.percentiles.p75 ?? null, t.percentiles.p90 ?? null, t.percentiles.p95 ?? null, t.percentiles.p99 ?? null, t.receivedKbSec, t.sentKbSec]);
  }
}

async function processJtl(v: any, art: any) {
  const run = await resolveRun(art.run_id, undefined, true);
  await aggregator.flush(true, run.id);
  await deleteRunMetrics(run.id, 'jtl'); // re-processing a new version replaces the JTL-derived metrics
  let input: Readable = await storage.get(v.storage_key);
  if (v.mime_type === 'application/gzip') input = input.pipe(createGunzip());
  const res = await parseJtlStream(input, async (batch) => {
    aggregator.addSamples(run, batch, 'jtl');
    if (aggregator.size > 20000) await aggregator.flush(true, run.id);
  });
  await aggregator.flush(true, run.id);
  // If the run has no live data, the JTL defines the execution window
  if (res.startTs) await query(`UPDATE test_runs SET started_at = COALESCE(started_at, $2), ended_at = COALESCE(ended_at, $3) WHERE id = $1`, [run.id, new Date(res.startTs), res.endTs ? new Date(res.endTs) : null]);
  return res;
}

const LOG_LINE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?:\[[^\]]*\]\s+)?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)?\s*(?:\[([^\]]+)\])?\s*(?:([\w.$]+):\s)?(.*)$/;

async function processLog(v: any, art: any) {
  const run = await one(`SELECT id, application_id, environment_id FROM test_runs WHERE id = $1`, [art.run_id]);
  await query(`DELETE FROM log_entries WHERE artifact_id = $1`, [art.id]);
  let input: Readable = await storage.get(v.storage_key);
  if (v.mime_type === 'application/gzip') input = input.pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });
  let batch: any[] = [];
  let total = 0;
  let last: any = null;
  const flush = async () => {
    if (!batch.length) return;
    const params: unknown[] = [];
    const values = batch.map((e) => { params.push(run.id, e.ts, e.level, e.service, e.logger, e.message, art.id, run.application_id, run.environment_id); const b = params.length - 9; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`; });
    await query(`INSERT INTO log_entries (run_id, ts, level, service, logger, message, artifact_id, application_id, environment_id) VALUES ${values.join(',')}`, params);
    batch = [];
  };
  for await (const line of rl) {
    const m = LOG_LINE.exec(line);
    if (m) {
      const ts = Date.parse(m[1].replace(',', '.').replace(' ', 'T'));
      if (!Number.isFinite(ts)) continue;
      last = { ts: new Date(ts), level: (m[2] ?? 'INFO').replace('WARNING', 'WARN'), service: art.kind === 'LOG' ? 'jmeter' : art.name, logger: m[4] ?? m[3] ?? null, message: (m[5] ?? '').slice(0, 4000) };
      batch.push(last);
      total++;
      if (batch.length >= 1000) await flush();
    } else if (last && line.trim() && last.message.length < 4000) {
      last.message = (last.message + '\n' + line).slice(0, 4000); // stack trace continuation
    }
    if (total > 2_000_000) break;
  }
  await flush();
  return { entries: total };
}

registerJob('artifact.process', async ({ versionId }) => {
  const v = await one(`SELECT * FROM artifact_versions WHERE id = $1`, [versionId]);
  if (!v) return { skipped: 'version not found' };
  const art = await one(`SELECT * FROM artifacts WHERE id = $1`, [v.artifact_id]);
  await query(`UPDATE artifact_versions SET processing_status = 'PROCESSING', processing_error = NULL WHERE id = $1`, [versionId]);
  const t0 = performance.now();
  try {
    let result: unknown = null;
    if (art.kind === 'HTML_REPORT') result = await processHtmlReport(v, art);
    else if (art.kind === 'JTL') result = await processJtl(v, art);
    else if (['LOG', 'SERVER_LOG', 'APP_LOG'].includes(art.kind)) result = await processLog(v, art);
    await query(`UPDATE artifact_versions SET processing_status = 'COMPLETED', metadata = metadata || $2 WHERE id = $1`, [versionId, JSON.stringify({ processing: result })]);
    const run = await one(`SELECT status FROM test_runs WHERE id = $1`, [art.run_id]);
    if (['COMPLETED', 'FAILED', 'ABORTED'].includes(run.status) && ['HTML_REPORT', 'JTL'].includes(art.kind)) await enqueue('run.reanalyze', { runId: art.run_id }, { runId: art.run_id, priority: 4 });
    publishRunEvent(art.run_id, 'artifact', { artifactId: art.id, status: 'COMPLETED' });
    selfMetrics.inc('artifacts_processed');
    return result;
  } catch (e) {
    await query(`UPDATE artifact_versions SET processing_status = 'FAILED', processing_error = $2 WHERE id = $1`, [versionId, (e as Error).message.slice(0, 2000)]);
    selfMetrics.inc('artifacts_failed');
    publishRunEvent(art.run_id, 'artifact', { artifactId: art.id, status: 'FAILED' });
    throw e;
  } finally {
    selfMetrics.observe('artifact_processing_ms', performance.now() - t0);
  }
});

// ---------------------------------------------------------------------------------------------
// Signed URLs for the sandboxed report content server
// ---------------------------------------------------------------------------------------------
const sign = (payload: string) => createHmac('sha256', config.jwtSecret + ':report-content').update(payload).digest('base64url');

export function reportToken(versionId: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${versionId}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyReportToken(token: string): string | null {
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const payload = Buffer.from(p, 'base64url').toString();
  if (!safeEqual(sign(payload), sig)) return null;
  const [versionId, exp] = payload.split('.');
  if (Number(exp) < Date.now() / 1000) return null;
  return versionId;
}

export function reportViewerUrl(versionId: string, entry = 'index.html') {
  const base = config.reportContentOrigin ? config.reportContentOrigin.replace(/\/$/, '') : '';
  return `${base}/report-content/${reportToken(versionId)}/${entry}`;
}

export async function versionFor(artifactId: string, version: number | 'latest', orgId: string) {
  const art = await one(`SELECT a.*, p.organization_id, r.run_key FROM artifacts a JOIN projects p ON p.id = a.project_id JOIN test_runs r ON r.id = a.run_id WHERE a.id = $1`, [artifactId]);
  if (!art || art.organization_id !== orgId) throw notFound('Artifact', artifactId);
  const v = version === 'latest'
    ? await one(`SELECT * FROM artifact_versions WHERE artifact_id = $1 ORDER BY version DESC LIMIT 1`, [artifactId])
    : await one(`SELECT * FROM artifact_versions WHERE artifact_id = $1 AND version = $2`, [artifactId, version]);
  if (!v) throw notFound('Artifact version', String(version));
  return { art, v };
}

export { stat };
