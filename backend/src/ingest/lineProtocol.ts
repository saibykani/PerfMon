/**
 * InfluxDB line protocol parser.
 *   measurement[,tag=value...] field=value[,field=value...] [timestamp]
 * Handles backslash escapes in measurement/tags/field keys and quoted string fields.
 */
export interface LinePoint {
  measurement: string;
  tags: Record<string, string>;
  fields: Record<string, number | string | boolean>;
  timestamp: number | null; // epoch ms
}

function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === '"') inQuote = !inQuote;
    if (ch === sep && !inQuote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const unescape = (s: string) => s.replace(/\\([,= "\\])/g, '$1');

function parseFieldValue(v: string): number | string | boolean {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (/^-?\d+i$/.test(v) || /^\d+u$/.test(v)) return Number(v.slice(0, -1));
  if (/^(t|true|T|TRUE|True)$/.test(v)) return true;
  if (/^(f|false|F|FALSE|False)$/.test(v)) return false;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

// ns/us divide; s/m/h multiply (dividing by 1/1000 etc. produced fractional epoch ms, e.g. 2h → 7200000.000000001)
const PRECISION_DIV: Record<string, number> = { n: 1e6, ns: 1e6, u: 1e3, us: 1e3, ms: 1 };
const PRECISION_MUL: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };

export function toEpochMs(raw: string, precision?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  if (precision && PRECISION_DIV[precision] !== undefined) return n / PRECISION_DIV[precision];
  if (precision && PRECISION_MUL[precision] !== undefined) return n * PRECISION_MUL[precision];
  // auto-detect by magnitude
  if (n > 1e17) return n / 1e6; // ns
  if (n > 1e14) return n / 1e3; // us
  if (n > 1e11) return n;       // ms
  return n * 1000;              // s
}

export function parseLineProtocol(body: string, precision?: string): { points: LinePoint[]; errors: string[] } {
  const points: LinePoint[] = [];
  const errors: string[] = [];
  const lines = body.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line || line.startsWith('#')) continue;
    try {
      // split into [measurement+tags] [fields] [timestamp] on unescaped, unquoted spaces
      const parts = splitUnescaped(line, ' ').filter((p) => p.length);
      if (parts.length < 2) throw new Error('missing fields');
      const [head, fieldStr, ts] = parts;
      const headParts = splitUnescaped(head, ',');
      const measurement = unescape(headParts[0]);
      const tags: Record<string, string> = {};
      for (const t of headParts.slice(1)) {
        const [k, ...rest] = splitUnescaped(t, '=');
        tags[unescape(k)] = unescape(rest.join('='));
      }
      const fields: Record<string, number | string | boolean> = {};
      for (const f of splitUnescaped(fieldStr, ',')) {
        const idx = (() => { for (let i = 0; i < f.length; i++) { if (f[i] === '\\') { i++; continue; } if (f[i] === '=') return i; } return -1; })();
        if (idx < 0) throw new Error(`bad field '${f}'`);
        fields[unescape(f.slice(0, idx))] = parseFieldValue(f.slice(idx + 1));
      }
      const timestamp = ts ? toEpochMs(ts, precision) : null;
      if (timestamp !== null && !Number.isFinite(timestamp)) throw new Error(`bad timestamp '${ts}'`);
      points.push({ measurement, tags, fields, timestamp });
    } catch (e) {
      if (errors.length < 20) errors.push(`line ${ln + 1}: ${(e as Error).message}`);
    }
  }
  return { points, errors };
}
