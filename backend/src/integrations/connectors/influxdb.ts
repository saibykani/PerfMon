import type { Connector, Credentials, ImportQuery, ImportedSeries, IntegrationRecord, RunWindow } from './types.js';
import { ConnectorError, authHeaders, basic, expectOk, http, joinUrl, probe, requireUrl, statusMessage } from './http.js';

/**
 * InfluxDB connector.
 *  - v2 (InfluxDB 2.x / Cloud): Flux via POST /api/v2/query (annotated CSV), auth "Token <token>".
 *  - v1 (InfluxDB 1.x):          InfluxQL via GET /query (JSON), auth basic (username/password) or token.
 *
 * Users configure *mappings* (measurement + field + tags → Perfmon metric). Perfmon generates the
 * Flux/InfluxQL itself; raw Flux/InfluxQL is accepted for advanced cases but never required by the UI.
 */

export interface InfluxSelector { measurement: string; field: string; tags: Record<string, string> }

/** Parses "measurement:field" or "measurement:field{tag=value,tag2=value2}". Returns null for raw queries. */
export function parseSelector(q: string): InfluxSelector | null {
  const m = /^\s*([^:{}\s]+):([^{}\s]+)\s*(?:\{([^}]*)\})?\s*$/.exec(q);
  if (!m) return null;
  const tags: Record<string, string> = {};
  for (const part of (m[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new ConnectorError(`Invalid tag filter '${part}' in '${q}'`);
    tags[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { measurement: m[1], field: m[2], tags };
}

const fluxStr = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const iqlIdent = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const iqlStr = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

export function buildFlux(bucket: string, sel: InfluxSelector, w: { from: Date; to: Date; stepSec: number }) {
  const filters = [`r._measurement == ${fluxStr(sel.measurement)}`, `r._field == ${fluxStr(sel.field)}`,
    ...Object.entries(sel.tags).map(([k, v]) => `r[${fluxStr(k)}] == ${fluxStr(v)}`)];
  return [
    `from(bucket: ${fluxStr(bucket)})`,
    `  |> range(start: ${w.from.toISOString()}, stop: ${w.to.toISOString()})`,
    `  |> filter(fn: (r) => ${filters.join(' and ')})`,
    `  |> aggregateWindow(every: ${w.stepSec}s, fn: mean, createEmpty: false)`,
  ].join('\n');
}

export function buildInfluxQL(sel: InfluxSelector, w: { from: Date; to: Date; stepSec: number }, groupTags: string[] = ['host']) {
  const where = [`time >= ${iqlStr(w.from.toISOString())}`, `time <= ${iqlStr(w.to.toISOString())}`, ...Object.entries(sel.tags).map(([k, v]) => `${iqlIdent(k)} = ${iqlStr(v)}`)];
  const group = [`time(${w.stepSec}s)`, ...groupTags.map(iqlIdent)].join(', ');
  return `SELECT mean(${iqlIdent(sel.field)}) AS "value" FROM ${iqlIdent(sel.measurement)} WHERE ${where.join(' AND ')} GROUP BY ${group} fill(none)`;
}

/** Parses InfluxDB v2 annotated CSV into series (grouped by result+table). */
export function parseAnnotatedCsv(csv: string): { labels: Record<string, string>; points: [number, number][] }[] {
  const out = new Map<string, { labels: Record<string, string>; points: [number, number][] }>();
  let header: string[] | null = null;
  const splitCsv = (line: string) => {
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) { header = null; continue; }
    if (line.startsWith('#')) { header = null; continue; }
    const cells = splitCsv(line);
    if (!header) { header = cells; continue; }
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    if (row.error) throw new ConnectorError(`InfluxDB query error: ${row.error}`);
    const t = Date.parse(row._time);
    const v = Number(row._value);
    if (!Number.isFinite(t) || row._value === '' || !Number.isFinite(v)) continue;
    const key = `${row.result}|${row.table}`;
    let s = out.get(key);
    if (!s) {
      const labels: Record<string, string> = {};
      for (const h of header) if (h && !h.startsWith('_') && h !== 'result' && h !== 'table' && row[h] !== '') labels[h] = row[h];
      if (row._measurement) labels._measurement = row._measurement;
      if (row._field) labels._field = row._field;
      out.set(key, (s = { labels, points: [] }));
    }
    s.points.push([t, v]);
  }
  return [...out.values()];
}

/** Parses an InfluxQL JSON response (epoch=ms). */
export function parseInfluxQlJson(json: any): { labels: Record<string, string>; points: [number, number][] }[] {
  const out: { labels: Record<string, string>; points: [number, number][] }[] = [];
  for (const res of json?.results ?? []) {
    if (res.error) throw new ConnectorError(`InfluxDB query error: ${res.error}`);
    for (const s of res.series ?? []) {
      const ti = (s.columns as string[]).indexOf('time');
      const vi = (s.columns as string[]).findIndex((c: string) => c !== 'time');
      const points: [number, number][] = [];
      for (const row of s.values ?? []) {
        const t = typeof row[ti] === 'number' ? row[ti] : Date.parse(row[ti]);
        const v = Number(row[vi]);
        if (Number.isFinite(t) && row[vi] != null && Number.isFinite(v)) points.push([t, v]);
      }
      out.push({ labels: { ...(s.tags ?? {}), _measurement: s.name }, points });
    }
  }
  return out;
}

const isV1 = (i: IntegrationRecord) => String(i.config?.version ?? 'v2').toLowerCase() === 'v1';

function v1Auth(i: IntegrationRecord, c: Credentials): Record<string, string> {
  if (c.username) return { authorization: basic(c.username, c.password ?? '') };
  if (c.token) return { authorization: `Token ${c.token}` };
  return authHeaders(i, c, 'Token');
}

async function runV2(i: IntegrationRecord, c: Credentials, flux: string) {
  const base = requireUrl(i);
  const org = i.config?.org;
  if (!org) throw new ConnectorError('config.org is required for InfluxDB v2');
  const r = await http(joinUrl(base, `/api/v2/query?org=${encodeURIComponent(org)}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/csv', ...(c.token ? { authorization: `Token ${c.token}` } : authHeaders(i, c, 'Token')) },
    body: JSON.stringify({ query: flux, type: 'flux', dialect: { annotations: ['datatype', 'group', 'default'], header: true } }),
  });
  expectOk(r, 'InfluxDB query');
  return parseAnnotatedCsv(r.text);
}

async function runV1(i: IntegrationRecord, c: Credentials, influxQl: string) {
  const base = requireUrl(i);
  const db = i.config?.database;
  if (!db) throw new ConnectorError('config.database is required for InfluxDB v1');
  const qs = new URLSearchParams({ db, q: influxQl, epoch: 'ms' });
  if (i.config?.retentionPolicy) qs.set('rp', i.config.retentionPolicy);
  const r = await http(joinUrl(base, `/query?${qs}`), { headers: { accept: 'application/json', ...v1Auth(i, c) } });
  expectOk(r, 'InfluxDB query');
  return parseInfluxQlJson(r.json);
}

/** Telegraf-style defaults (cpu/mem/disk/net per host). Users override with config.mappings. */
const DEFAULTS: ImportQuery[] = [
  { metric: 'cpu_pct', target: 'server', query: 'cpu:usage_idle{cpu=cpu-total}', transform: 'invert_pct' },
  { metric: 'memory_pct', target: 'server', query: 'mem:used_percent' },
  { metric: 'disk_pct', target: 'server', query: 'disk:used_percent{path=/}' },
  { metric: 'load_avg_1m', target: 'server', query: 'system:load1' },
];

export const influxConnector: Connector = {
  type: 'INFLUXDB',
  label: 'InfluxDB',
  category: 'METRICS',
  authTypes: ['TOKEN', 'BASIC', 'NONE'],
  fields: [
    { key: 'version', label: 'API version (v2 = Flux, v1 = InfluxQL)', required: true, placeholder: 'v2' },
    { key: 'org', label: 'Organization (v2)', required: false, placeholder: 'my-org' },
    { key: 'bucket', label: 'Bucket (v2)', required: false, placeholder: 'telegraf' },
    { key: 'database', label: 'Database (v1)', required: false, placeholder: 'telegraf' },
    { key: 'token', label: 'API token', required: false, secret: true },
    { key: 'username', label: 'Username (v1 basic auth)', required: false, secret: true },
    { key: 'password', label: 'Password (v1 basic auth)', required: false, secret: true },
  ],
  supportsImport: true,
  docs: 'Pulls server/JVM/database metrics for a run window from InfluxDB. Configure config.mappings as [{ metric, target, query: "measurement:field{tag=value}", serverName?, scale?, transform? }] — Perfmon generates Flux (v2, POST /api/v2/query) or InfluxQL (v1, GET /query); raw Flux/InfluxQL is also accepted in "query". Default mappings follow Telegraf (cpu, mem, disk, system). Series are split by the host tag and stored per server, correlated to the Run ID.',
  defaultQueries: () => DEFAULTS,

  async test(i, c) {
    return probe(async () => {
      const base = requireUrl(i);
      if (isV1(i)) {
        const ping = await http(joinUrl(base, '/ping'));
        if (ping.status !== 204 && !ping.ok) throw new ConnectorError(statusMessage(ping, 'InfluxDB /ping'));
        const r = expectOk(await http(joinUrl(base, `/query?${new URLSearchParams({ q: 'SHOW DATABASES' })}`), { headers: v1Auth(i, c) }), 'InfluxDB SHOW DATABASES');
        const dbs = (r.json?.results?.[0]?.series?.[0]?.values ?? []).map((v: any[]) => v[0]);
        const missing = i.config?.database && !dbs.includes(i.config.database);
        return { message: `Connected to InfluxDB ${ping.headers.get('x-influxdb-version') ?? '1.x'}; ${dbs.length} database(s)${missing ? ` — WARNING: database '${i.config.database}' not found` : ''}`, details: { databases: dbs.slice(0, 50) } };
      }
      const r = expectOk(await http(joinUrl(base, `/api/v2/buckets?limit=100${i.config?.org ? `&org=${encodeURIComponent(i.config.org)}` : ''}`), { headers: c.token ? { authorization: `Token ${c.token}` } : authHeaders(i, c, 'Token') }), 'InfluxDB buckets');
      const buckets = (r.json?.buckets ?? []).map((b: any) => b.name);
      const missing = i.config?.bucket && !buckets.includes(i.config.bucket);
      return { message: `Connected to InfluxDB ${r.headers.get('x-influxdb-version') ?? '2.x'}; ${buckets.length} bucket(s) visible${missing ? ` — WARNING: bucket '${i.config.bucket}' not visible to this token` : ''}`, details: { buckets: buckets.slice(0, 50) } };
    });
  },

  async importRun(i, c, run: RunWindow, queries) {
    const series: ImportedSeries[] = [];
    const warnings: string[] = [];
    for (const q of queries) {
      try {
        const sel = parseSelector(q.query);
        let raw;
        if (isV1(i)) {
          raw = await runV1(i, c, sel ? buildInfluxQL(sel, run, i.config?.groupByTags ?? ['host']) : q.query);
        } else {
          const bucket = i.config?.bucket;
          if (sel && !bucket) throw new ConnectorError('config.bucket is required for InfluxDB v2');
          raw = await runV2(i, c, sel ? buildFlux(bucket, sel, run) : q.query);
        }
        if (!raw.length) warnings.push(`${q.metric}: no data for '${q.query}' in the run window`);
        for (const s of raw) series.push({ query: q, labels: s.labels, points: s.points });
      } catch (e) {
        warnings.push(`${q.metric}: ${(e as Error).message}`);
      }
    }
    return { series, warnings };
  },
};
