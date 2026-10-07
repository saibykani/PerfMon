/**
 * Import JMeter results that the Backend Listener wrote to an external InfluxDB.
 *
 * Reads the raw `jmeter` measurement (and the `events` annotations) for a time window,
 * rebuilds the line-protocol points and stores them through the same path as the live
 * listener (ingestLinePoints) — so summaries, transactions, SLA and comparison behave
 * exactly as if JMeter had sent the data to Perfmon directly.
 *
 *  - v1 (InfluxDB 1.x): InfluxQL `SELECT * ... GROUP BY *` (tags come back as series tags)
 *  - v2 (InfluxDB 2.x / Cloud): Flux with pivot(), annotated CSV
 */
import type { LinePoint } from '../ingest/lineProtocol.js';
import type { Credentials, IntegrationRecord } from './connectors/types.js';
import { ConnectorError, authHeaders, basic, expectOk, http, joinUrl, requireUrl } from './connectors/http.js';

export interface JmeterQuery { measurement: string; application?: string | null; from: Date; to: Date }

const CHUNK_MS = 30 * 60_000;      // query in 30-minute slices to bound memory
const MAX_POINTS = 2_000_000;
const FLUX_META = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_measurement']);

const isV1 = (i: IntegrationRecord) => String(i.config?.version ?? 'v2').toLowerCase() === 'v1';
const iqlStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const iqlIdent = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
const fluxStr = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function v1Auth(i: IntegrationRecord, c: Credentials): Record<string, string> {
  if (c.username) return { authorization: basic(c.username, c.password ?? '') };
  if (c.token) return { authorization: `Token ${c.token}` };
  return authHeaders(i, c, 'Token');
}

/** Splits one CSV line, honouring double-quoted fields with "" escapes. */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Converts a pivoted Flux annotated-CSV response into line points (tags = string columns, fields = numeric). */
export function fluxCsvToPoints(csv: string, numericCols?: Set<string>): LinePoint[] {
  const points: LinePoint[] = [];
  let header: string[] | null = null;
  let types: string[] | null = null;
  for (const raw of csv.split(/\r?\n/)) {
    if (!raw.trim()) { header = null; types = null; continue; }
    if (raw.startsWith('#')) {
      const cells = splitCsv(raw);
      if (cells[0] === '#datatype') types = cells;
      continue;
    }
    const cells = splitCsv(raw);
    if (!header) { header = cells; continue; }
    const row: Record<string, string> = {};
    header.forEach((h, k) => { row[h] = cells[k] ?? ''; });
    if (row.error) throw new ConnectorError(`InfluxDB query error: ${row.error}`);
    const ts = Date.parse(row._time);
    if (!Number.isFinite(ts)) continue;
    const p: LinePoint = { measurement: row._measurement, tags: {}, fields: {}, timestamp: ts };
    header.forEach((h, k) => {
      if (FLUX_META.has(h) || row[h] === '') return;
      const t = types?.[k] ?? '';
      const numeric = /^(double|long|unsignedLong)$/.test(t) || (!t && numericCols?.has(h));
      if (numeric) { const n = Number(row[h]); if (Number.isFinite(n)) p.fields[h] = n; }
      else if (h === 'text') p.fields[h] = row[h];
      else p.tags[h] = row[h];
    });
    points.push(p);
  }
  return points;
}

/** Converts an InfluxQL `SELECT * ... GROUP BY *` JSON response (epoch=ms) into line points. */
export function influxQlToPoints(json: any): LinePoint[] {
  const points: LinePoint[] = [];
  for (const res of json?.results ?? []) {
    if (res.error) throw new ConnectorError(`InfluxDB query error: ${res.error}`);
    for (const s of res.series ?? []) {
      const cols: string[] = s.columns ?? [];
      const ti = cols.indexOf('time');
      for (const row of s.values ?? []) {
        const ts = typeof row[ti] === 'number' ? row[ti] : Date.parse(row[ti]);
        if (!Number.isFinite(ts)) continue;
        const p: LinePoint = { measurement: s.name, tags: { ...(s.tags ?? {}) }, fields: {}, timestamp: ts };
        cols.forEach((c, k) => {
          if (k === ti || row[k] == null) return;
          if (typeof row[k] === 'number') p.fields[c] = row[k];
          else if (c === 'text') p.fields[c] = String(row[k]);
          else if (typeof row[k] === 'string') p.tags[c] = row[k];
        });
        for (const k of Object.keys(p.tags)) if (p.tags[k] === '') delete p.tags[k];
        points.push(p);
      }
    }
  }
  return points;
}

async function queryV1(i: IntegrationRecord, c: Credentials, measurement: string, application: string | null | undefined, from: Date, to: Date) {
  const db = i.config?.database;
  if (!db) throw new ConnectorError('The integration needs a database (InfluxDB 1.x) — edit it under Platform → Integrations');
  const where = [`time >= ${iqlStr(from.toISOString())}`, `time < ${iqlStr(to.toISOString())}`];
  if (application) where.push(`"application" = ${iqlStr(application)}`);
  const q = `SELECT * FROM ${iqlIdent(measurement)} WHERE ${where.join(' AND ')} GROUP BY *`;
  const qs = new URLSearchParams({ db, q, epoch: 'ms' });
  if (i.config?.retentionPolicy) qs.set('rp', i.config.retentionPolicy);
  const r = expectOk(await http(joinUrl(requireUrl(i), `/query?${qs}`), { headers: { accept: 'application/json', ...v1Auth(i, c) }, timeoutMs: 60_000 }), 'InfluxDB query');
  return influxQlToPoints(r.json);
}

async function queryV2(i: IntegrationRecord, c: Credentials, measurement: string, application: string | null | undefined, from: Date, to: Date) {
  const org = i.config?.org;
  const bucket = i.config?.bucket;
  if (!org || !bucket) throw new ConnectorError('The integration needs an organization and bucket (InfluxDB 2.x) — edit it under Platform → Integrations');
  const filter = [`r._measurement == ${fluxStr(measurement)}`, ...(application ? [`r.application == ${fluxStr(application)}`] : [])].join(' and ');
  const flux = [
    `from(bucket: ${fluxStr(bucket)})`,
    `|> range(start: ${from.toISOString()}, stop: ${to.toISOString()})`,
    `|> filter(fn: (r) => ${filter})`,
    `|> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`,
  ].join('\n  ');
  const r = expectOk(await http(joinUrl(requireUrl(i), `/api/v2/query?org=${encodeURIComponent(org)}`), {
    method: 'POST', timeoutMs: 60_000,
    headers: { 'content-type': 'application/json', accept: 'application/csv', ...(c.token ? { authorization: `Token ${c.token}` } : authHeaders(i, c, 'Token')) },
    body: JSON.stringify({ query: flux, type: 'flux', dialect: { annotations: ['datatype', 'group', 'default'], header: true } }),
  }), 'InfluxDB query');
  return fluxCsvToPoints(r.text);
}

/** Reads the JMeter measurement and its `events` annotations for the window, in time slices. */
export async function fetchJmeterPoints(i: IntegrationRecord, c: Credentials, q: JmeterQuery): Promise<LinePoint[]> {
  const run = isV1(i) ? queryV1 : queryV2;
  const out: LinePoint[] = [];
  for (let t = q.from.getTime(); t < q.to.getTime(); t += CHUNK_MS) {
    const a = new Date(t);
    const b = new Date(Math.min(q.to.getTime(), t + CHUNK_MS));
    const pts = await run(i, c, q.measurement, q.application, a, b);
    for (const p of pts) out.push(p);
    if (out.length > MAX_POINTS) throw new ConnectorError(`More than ${MAX_POINTS.toLocaleString()} points in the window — narrow the time range or filter by application`);
  }
  // JMeter writes start/end annotations to the `events` measurement; missing ones are not an error
  const ev = await run(i, c, 'events', q.application, q.from, q.to).catch(() => []);
  return out.concat(ev.map((p) => ({ ...p, measurement: 'events' })));
}

/** Median gap between distinct point timestamps, i.e. JMeter's send interval (seconds). */
export function inferIntervalSec(points: LinePoint[]): number {
  const ts = [...new Set(points.map((p) => p.timestamp ?? 0))].filter(Boolean).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let k = 1; k < ts.length; k++) gaps.push(ts[k] - ts[k - 1]);
  if (!gaps.length) return 5;
  gaps.sort((a, b) => a - b);
  const s = Math.round(gaps[gaps.length >> 1] / 1000);
  return s >= 1 && s <= 60 ? s : 5;
}
