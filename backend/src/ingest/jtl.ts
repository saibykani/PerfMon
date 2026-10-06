import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { RawSample } from './aggregator.js';

/**
 * Streaming JTL parser (CSV with header, or XML). Emits batches of RawSample.
 * Handles quoted CSV fields containing commas, quotes and newlines.
 */
const DEFAULT_HEADER = ['timeStamp', 'elapsed', 'label', 'responseCode', 'responseMessage', 'threadName', 'dataType', 'success', 'failureMessage', 'bytes', 'sentBytes', 'grpThreads', 'allThreads', 'URL', 'Latency', 'IdleTime', 'Connect'];

export function parseCsvLine(line: string, state: { buf: string[]; field: string; inQuote: boolean }): string[] | null {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (state.inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { state.field += '"'; i++; }
        else state.inQuote = false;
      } else state.field += ch;
    } else if (ch === '"') state.inQuote = true;
    else if (ch === ',') { state.buf.push(state.field); state.field = ''; }
    else state.field += ch;
  }
  if (state.inQuote) { state.field += '\n'; return null; } // record continues on next line
  state.buf.push(state.field);
  const rec = state.buf;
  state.buf = [];
  state.field = '';
  return rec;
}

function parseTimestamp(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v.replace(' ', 'T'));
  return Number.isFinite(t) ? t : NaN;
}

function rowToSample(cols: Record<string, number>, rec: string[]): RawSample | null {
  const g = (k: string) => (cols[k] !== undefined ? rec[cols[k]] : undefined);
  const ts = parseTimestamp(g('timeStamp') ?? '');
  const elapsed = Number(g('elapsed'));
  const label = g('label');
  if (!label || !Number.isFinite(ts) || !Number.isFinite(elapsed)) return null;
  const num = (k: string) => { const v = g(k); const n = v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
  return {
    ts, elapsed, label,
    success: (g('success') ?? 'true').toLowerCase() === 'true',
    responseCode: g('responseCode') ?? null,
    responseMessage: g('responseMessage') ?? null,
    failureMessage: g('failureMessage') || null,
    bytes: num('bytes'), sentBytes: num('sentBytes'),
    latency: num('Latency'), connect: num('Connect'),
    url: g('URL') || null,
    allThreads: num('allThreads'),
  };
}

const XML_ATTR = /(\w+)="([^"]*)"/g;
const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export async function parseJtlStream(input: Readable, onBatch: (b: RawSample[]) => Promise<void>, batchSize = 5000) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let cols: Record<string, number> | null = null;
  let isXml: boolean | null = null;
  const state = { buf: [] as string[], field: '', inQuote: false };
  let batch: RawSample[] = [];
  let total = 0;
  let skipped = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const push = async (s: RawSample | null) => {
    if (!s) { skipped++; return; }
    batch.push(s);
    total++;
    if (s.ts < minTs) minTs = s.ts;
    if (s.ts + s.elapsed > maxTs) maxTs = s.ts + s.elapsed;
    if (batch.length >= batchSize) { await onBatch(batch); batch = []; }
  };

  for await (const line of rl) {
    if (isXml === null) {
      if (!line.trim()) continue;
      isXml = line.trimStart().startsWith('<');
      if (!isXml) {
        const first = parseCsvLine(line, state);
        if (!first) continue;
        if (first.includes('timeStamp') || first.includes('elapsed')) { cols = Object.fromEntries(first.map((h, i) => [h.trim(), i])); continue; }
        cols = Object.fromEntries(DEFAULT_HEADER.map((h, i) => [h, i]));
        await push(rowToSample(cols, first));
        continue;
      }
    }
    if (isXml) {
      const m = /<(httpSample|sample)\s([^>]*?)\/?>/.exec(line);
      if (!m) continue;
      const a: Record<string, string> = {};
      for (const [, k, v] of m[2].matchAll(XML_ATTR)) a[k] = decodeXml(v);
      const ts = Number(a.ts);
      const elapsed = Number(a.t);
      if (!a.lb || !Number.isFinite(ts) || !Number.isFinite(elapsed)) { skipped++; continue; }
      await push({
        ts, elapsed, label: a.lb, success: a.s !== 'false', responseCode: a.rc ?? null, responseMessage: a.rm ?? null,
        bytes: a.by ? Number(a.by) : null, sentBytes: a.sby ? Number(a.sby) : null, latency: a.lt ? Number(a.lt) : null,
        connect: a.ct ? Number(a.ct) : null, allThreads: a.na ? Number(a.na) : null,
      });
      continue;
    }
    const rec = parseCsvLine(line, state);
    if (!rec) continue;
    await push(rowToSample(cols!, rec));
  }
  if (batch.length) await onBatch(batch);
  return { total, skipped, startTs: Number.isFinite(minTs) ? minTs : null, endTs: Number.isFinite(maxTs) ? maxTs : null, format: isXml ? 'xml' : 'csv' };
}
