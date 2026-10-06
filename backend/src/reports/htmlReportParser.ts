/**
 * JMeter HTML dashboard report parser.
 *
 * Sources, in order of preference:
 *   1. statistics.json (JMeter >= 5.0)
 *   2. content/js/dashboard.js  (createTable($("#statisticsTable"), {...}))
 *   3. index.html (single-file / partial reports; "Start Time"/"End Time" infos)
 * Error, top-5 errors, APDEX and response-code tables are parsed when present.
 * Every field is optional — missing values are reported as warnings, never guessed.
 */
export const PARSER_VERSION = '1.2.0';

export interface ParsedStats {
  label: string;
  samples: number | null;
  failures: number | null;
  errorPct: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  median: number | null;
  percentiles: Record<string, number | null>; // keys: p90, p95, p99, p75 ...
  throughput: number | null;
  receivedKbSec: number | null;
  sentKbSec: number | null;
}

export interface ParsedReport {
  parserVersion: string;
  generatedAt: string | null;
  startTime: string | null;
  endTime: string | null;
  startMs: number | null;
  endMs: number | null;
  sourceFile: string | null;
  overall: ParsedStats | null;
  transactions: ParsedStats[];
  errors: { type: string; count: number | null; pctInErrors: number | null; pctInAll: number | null }[];
  topErrors: { sampler: string; samples: number | null; errors: number | null; top: { error: string; count: number | null }[] }[];
  apdex: { overall: { apdex: number | null; t: number | null; f: number | null } | null; items: { label: string; apdex: number | null; t: number | null; f: number | null }[] } | null;
  responseCodes: { code: string; count: number }[];
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Extract the JSON object literal passed to createTable($("#<id>"), {...}, ...) */
export function extractCreateTable(js: string, id: string): any | null {
  const marker = `createTable($("#${id}"),`;
  let i = js.indexOf(marker);
  if (i < 0) {
    const m = new RegExp(`createTable\\(\\$\\(["']#${id}["']\\)\\s*,`).exec(js);
    if (!m) return null;
    i = m.index + m[0].length - 1;
  } else i += marker.length - 1;
  const start = js.indexOf('{', i);
  if (start < 0) return null;
  // brace-match respecting strings
  let depth = 0, inStr = false, q = '', esc = false;
  for (let k = start; k < js.length; k++) {
    const ch = js[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const literal = js.slice(start, k + 1);
        try { return JSON.parse(literal); } catch { return null; }
      }
    }
  }
  return null;
}

function pctKey(title: string): string | null {
  const m = /(\d+(?:\.\d+)?)\s*(?:th|st|nd|rd)?\s*(?:pct|percentile|%)/i.exec(title);
  if (!m) return null;
  const v = Number(m[1]);
  return v === 99.9 ? 'p999' : `p${String(v).replace('.', '')}`;
}

function rowFromTitles(titles: string[], data: unknown[]): ParsedStats {
  const idx = (re: RegExp) => titles.findIndex((t) => re.test(t));
  const get = (re: RegExp, fallback: number) => {
    const i = idx(re);
    return num(data[i >= 0 ? i : fallback]);
  };
  const percentiles: Record<string, number | null> = {};
  titles.forEach((t, i) => { const k = pctKey(t); if (k) percentiles[k] = num(data[i]); });
  if (!Object.keys(percentiles).length) {
    percentiles.p90 = num(data[8]); percentiles.p95 = num(data[9]); percentiles.p99 = num(data[10]);
  }
  return {
    label: String(data[Math.max(0, idx(/label|sampler|transaction/i))] ?? data[0]),
    samples: get(/#\s*samples|samples/i, 1),
    failures: get(/^fail|#\s*errors|ko/i, 2),
    errorPct: get(/error\s*%/i, 3),
    avg: get(/^average|^mean/i, 4),
    min: get(/^min/i, 5),
    max: get(/^max/i, 6),
    median: get(/median/i, 7),
    percentiles,
    throughput: get(/transactions\/s|throughput/i, 11),
    receivedKbSec: get(/received/i, 12),
    sentKbSec: get(/sent/i, 13),
  };
}

function fromStatisticsJson(json: Record<string, any>): { overall: ParsedStats | null; items: ParsedStats[] } {
  const conv = (label: string, s: any): ParsedStats => ({
    label: s.transaction ?? label,
    samples: num(s.sampleCount), failures: num(s.errorCount), errorPct: num(s.errorPct),
    avg: num(s.meanResTime), min: num(s.minResTime), max: num(s.maxResTime), median: num(s.medianResTime),
    percentiles: { p90: num(s.pct1ResTime), p95: num(s.pct2ResTime), p99: num(s.pct3ResTime) },
    throughput: num(s.throughput), receivedKbSec: num(s.receivedKBytesPerSec), sentKbSec: num(s.sentKBytesPerSec),
  });
  let overall: ParsedStats | null = null;
  const items: ParsedStats[] = [];
  for (const [k, v] of Object.entries(json)) {
    if (k === 'Total') overall = conv(k, v);
    else items.push(conv(k, v));
  }
  return { overall, items };
}

function parseInfos(html: string) {
  const val = (label: string) => {
    const re = new RegExp(`${label}[^<]*</td>\\s*<td[^>]*>\\s*"?([^"<]+)"?\\s*</td>`, 'i');
    return re.exec(html)?.[1]?.trim() ?? null;
  };
  return { startTime: val('Start Time'), endTime: val('End Time'), sourceFile: val('Source file') };
}

function parseResponseCodes(graphJs: string, warnings: string[]): { code: string; count: number }[] {
  const start = graphJs.indexOf('responseCodesPerSecondInfos');
  if (start < 0) return [];
  const block = graphJs.slice(start, start + 2_000_000);
  const gran = num(/"granularity"\s*:\s*(\d+)/.exec(block)?.[1]) ?? 1000;
  const out: { code: string; count: number }[] = [];
  const seriesRe = /\{"data"\s*:\s*(\[\[[^\]]*\](?:,\s*\[[^\]]*\])*\])\s*,\s*"isOverall"\s*:\s*\w+\s*,\s*"label"\s*:\s*"([^"]+)"/g;
  for (const m of block.matchAll(seriesRe)) {
    try {
      const pts = JSON.parse(m[1]) as [number, number][];
      const count = Math.round(pts.reduce((a, [, v]) => a + v * (gran / 1000), 0));
      out.push({ code: m[2], count });
    } catch { /* ignore */ }
    if (out.length > 200) break;
  }
  if (out.length) warnings.push('Response-code counts are derived from the per-second chart data (approximate).');
  return out;
}

export function parseJMeterReport(files: { statisticsJson?: string | null; dashboardJs?: string | null; indexHtml?: string | null; graphJs?: string | null }): ParsedReport {
  const warnings: string[] = [];
  let overall: ParsedStats | null = null;
  let transactions: ParsedStats[] = [];

  const dash = files.dashboardJs ?? '';
  const statTable = dash ? extractCreateTable(dash, 'statisticsTable') : null;
  if (files.statisticsJson) {
    try {
      const r = fromStatisticsJson(JSON.parse(files.statisticsJson));
      overall = r.overall;
      transactions = r.items;
    } catch (e) { warnings.push(`statistics.json could not be parsed: ${(e as Error).message}`); }
  }
  if (statTable) {
    const titles: string[] = statTable.titles ?? [];
    const o = statTable.overall?.data ? rowFromTitles(titles, statTable.overall.data) : null;
    const items = (statTable.items ?? []).map((it: any) => rowFromTitles(titles, it.data ?? []));
    if (!overall) { overall = o; transactions = items; }
    else if (o) {
      // dashboard.js may contain custom percentile columns not in statistics.json
      overall.percentiles = { ...o.percentiles, ...Object.fromEntries(Object.entries(overall.percentiles).filter(([, v]) => v != null)) };
    }
  }
  if (!overall && !transactions.length) warnings.push('No statistics table found (statistics.json / content/js/dashboard.js missing). Summary values are unavailable.');

  const errorsTable = dash ? extractCreateTable(dash, 'errorsTable') : null;
  const errors = (errorsTable?.items ?? []).map((it: any) => ({ type: String(it.data?.[0] ?? ''), count: num(it.data?.[1]), pctInErrors: num(it.data?.[2]), pctInAll: num(it.data?.[3]) }));
  if (dash && !errorsTable) warnings.push('Errors table not found in report.');

  const top5 = dash ? extractCreateTable(dash, 'top5ErrorsBySamplerTable') : null;
  const topErrors = (top5?.items ?? []).map((it: any) => {
    const d = it.data ?? [];
    const top: { error: string; count: number | null }[] = [];
    for (let i = 3; i + 1 < d.length; i += 2) if (d[i]) top.push({ error: String(d[i]), count: num(d[i + 1]) });
    return { sampler: String(d[0] ?? ''), samples: num(d[1]), errors: num(d[2]), top };
  });

  const apdexTable = dash ? extractCreateTable(dash, 'apdexTable') : null;
  const apdex = apdexTable ? {
    overall: apdexTable.overall?.data ? { apdex: num(apdexTable.overall.data[0]), t: num(apdexTable.overall.data[1]), f: num(apdexTable.overall.data[2]) } : null,
    items: (apdexTable.items ?? []).map((it: any) => ({ label: String(it.data?.[3] ?? ''), apdex: num(it.data?.[0]), t: num(it.data?.[1]), f: num(it.data?.[2]) })),
  } : null;

  const infos = files.indexHtml ? parseInfos(files.indexHtml) : { startTime: null, endTime: null, sourceFile: null };
  const toMs = (s: string | null) => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
  const responseCodes = files.graphJs ? parseResponseCodes(files.graphJs, warnings) : [];

  if (overall) {
    for (const [k, label] of [['samples', 'sample count'], ['avg', 'average'], ['throughput', 'throughput']] as const) {
      if (overall[k] == null) warnings.push(`Overall ${label} not present in report`);
    }
    if (overall.percentiles.p95 == null) warnings.push('P95 not present in report (custom percentile configuration?)');
  }
  return {
    parserVersion: PARSER_VERSION,
    generatedAt: new Date().toISOString(),
    startTime: infos.startTime, endTime: infos.endTime, startMs: toMs(infos.startTime), endMs: toMs(infos.endTime), sourceFile: infos.sourceFile,
    overall, transactions, errors, topErrors, apdex, responseCodes, warnings,
  };
}
