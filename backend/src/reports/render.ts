import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { csvEscape } from '../lib/http.js';
import { fmtNum, type ChartData, type Column, type Kpi, type ReportContent, type Section } from './content.js';

/**
 * Report renderers. All formats render from the stored ReportContent model.
 * Visual language: black / white / grey; colour only for pass / warn / fail.
 */

const INK = '#111111', INK2 = '#555555', INK3 = '#8a8a8a', RULE = '#d9d9d9', SOFT = '#f4f4f4';
const PASS = '#15803d', WARN = '#b45309', FAIL = '#c62828';
const SERIES = [INK, INK3, '#444444', '#b0b0b0'];

/** pass / warn / fail / null for any status-like value. */
export function tone(v: unknown): 'pass' | 'warn' | 'fail' | null {
  const s = String(v ?? '').toUpperCase();
  if (['PASS', 'COMPLETED', 'BETTER', 'IMPROVEMENT', 'OK', 'CONSISTENT', 'HEALTHY', 'READY'].includes(s)) return 'pass';
  if (['PASS_WITH_WARNINGS', 'WARNING', 'MEDIUM', 'MINOR', 'MINOR_DIFFERENCES', 'ABORTED'].includes(s)) return 'warn';
  if (['FAIL', 'FAILED', 'CRITICAL', 'WORSE', 'REGRESSION', 'HIGH', 'MISMATCH', 'INCONSISTENT'].includes(s)) return 'fail';
  return null;
}
const toneColor = (t: ReturnType<typeof tone>) => (t === 'pass' ? PASS : t === 'warn' ? WARN : t === 'fail' ? FAIL : INK2);
const STATUS_COLS = new Set(['status', 'verdict', 'severity', 'direction', 'result', 'sla']);
const label = (v: unknown) => String(v ?? '').replace(/_/g, ' ');

export function cellText(v: unknown, col?: Column): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') {
    const signed = col?.unit === '%' && /^(change|c\d+)$/.test(col.key);
    return `${signed && v > 0 ? '+' : ''}${fmtNum(v, Math.abs(v) >= 100 ? 0 : 2)}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16).replace('T', ' ') + ' UTC';
  if (col && STATUS_COLS.has(col.key)) return label(v);
  return String(v);
}
const kpiValue = (k: Kpi) => (k.value == null ? 'n/a' : typeof k.value === 'number' ? fmtNum(k.value, Math.abs(k.value) >= 100 ? 0 : 2) : String(k.value));
const subjectLine = (c: ReportContent) => {
  const s = c.subject;
  return [s.runKey, s.runKeys?.join(' vs '), s.testName, s.projectName, s.environment, s.build ? `Build ${s.build}` : null,
    s.from && s.to ? `${s.from.slice(0, 10)} → ${s.to.slice(0, 10)}` : null].filter(Boolean).join(' · ');
};

/* ------------------------------------------------------------------ chart geometry */

interface Geo { w: number; h: number; pad: { l: number; r: number; t: number; b: number } }
function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function lineGeometry(c: ChartData, g: Geo) {
  const xs = c.series.flatMap((s) => s.data.map((d) => Number(d[0])));
  const ys = c.series.flatMap((s) => s.data.map((d) => d[1]).filter((v): v is number => v != null));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = niceMax(Math.max(...ys, 0));
  const iw = g.w - g.pad.l - g.pad.r, ih = g.h - g.pad.t - g.pad.b;
  const sx = (x: number) => g.pad.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
  const sy = (y: number) => g.pad.t + ih - (y / yMax) * ih;
  const lines = c.series.map((s) => {
    const segs: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (const [x, y] of s.data) { if (y == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([sx(Number(x)), sy(y)]); }
    if (cur.length) segs.push(cur);
    return { name: s.name, segs };
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: sy(yMax * f), label: fmtNum(yMax * f, yMax * f >= 10 ? 0 : 2) }));
  const fmtX = (t: number) => { const d = new Date(t); return x1 - x0 > 2 * 86400000 ? d.toISOString().slice(5, 10) : d.toISOString().slice(11, 16); };
  const xticks = [0, 0.5, 1].map((f) => ({ x: g.pad.l + f * iw, label: fmtX(x0 + f * (x1 - x0)) }));
  return { lines, ticks, xticks, iw, ih };
}
function barGeometry(c: ChartData, g: Geo) {
  const data = c.series[0]?.data ?? [];
  const max = niceMax(Math.max(...data.map((d) => d[1] ?? 0), 0));
  const iw = g.w - g.pad.l - g.pad.r;
  const rowH = (g.h - g.pad.t - g.pad.b) / Math.max(1, data.length);
  return { max, bars: data.map(([name, v], i) => ({ name: String(name), v, y: g.pad.t + i * rowH, h: Math.max(4, rowH * 0.62), w: v == null ? 0 : (v / max) * iw })), rowH };
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function chartSvg(c: ChartData) {
  if (c.type === 'bar') {
    const n = c.series[0]?.data.length ?? 0;
    const g: Geo = { w: 720, h: Math.max(80, n * 24 + 16), pad: { l: 230, r: 70, t: 8, b: 8 } };
    const { bars } = barGeometry(c, g);
    return `<svg viewBox="0 0 ${g.w} ${g.h}" width="100%" role="img" aria-label="bar chart" xmlns="http://www.w3.org/2000/svg" font-family="inherit" font-size="11">
${bars.map((b) => `<text x="${g.pad.l - 8}" y="${b.y + b.h / 2 + 4}" text-anchor="end" fill="${INK2}">${esc(b.name.length > 38 ? b.name.slice(0, 37) + '…' : b.name)}</text>
<rect x="${g.pad.l}" y="${b.y}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" fill="${INK}" rx="1"/>
<text x="${(g.pad.l + b.w + 6).toFixed(1)}" y="${b.y + b.h / 2 + 4}" fill="${INK}">${b.v == null ? 'n/a' : esc(fmtNum(b.v, b.v >= 100 ? 0 : 2))}${c.unit ? ' ' + esc(c.unit) : ''}</text>`).join('\n')}
</svg>`;
  }
  const g: Geo = { w: 720, h: 220, pad: { l: 52, r: 12, t: 12, b: 26 } };
  const { lines, ticks, xticks } = lineGeometry(c, g);
  return `<svg viewBox="0 0 ${g.w} ${g.h}" width="100%" role="img" aria-label="line chart" xmlns="http://www.w3.org/2000/svg" font-family="inherit" font-size="10">
${ticks.map((t) => `<line x1="${g.pad.l}" x2="${g.w - g.pad.r}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="${RULE}" stroke-width="1"/><text x="${g.pad.l - 6}" y="${(t.y + 3).toFixed(1)}" text-anchor="end" fill="${INK3}">${esc(t.label)}</text>`).join('')}
${xticks.map((t, i) => `<text x="${t.x.toFixed(1)}" y="${g.h - 8}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" fill="${INK3}">${esc(t.label)}</text>`).join('')}
${lines.map((l, i) => l.segs.map((seg) => `<polyline fill="none" stroke="${SERIES[i % SERIES.length]}" stroke-width="${i === 0 ? 1.8 : 1.4}"${i % 2 ? ' stroke-dasharray="4 3"' : ''} points="${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`).join('')).join('\n')}
</svg>
<div class="legend">${c.series.map((s, i) => `<span><i style="border-top:2px ${i % 2 ? 'dashed' : 'solid'} ${SERIES[i % SERIES.length]}"></i>${esc(s.name)}${c.unit ? ` (${esc(c.unit)})` : ''}</span>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ HTML */

const CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:${INK}}
body{font:13px/1.5 'Google Sans','Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;padding:32px 40px;max-width:1080px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:15px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid ${INK}}
.sub{color:${INK2}}.meta{color:${INK3};font-size:11px;margin-top:2px}
.result{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin:18px 0 6px;padding:14px 16px;border:1px solid ${RULE};border-radius:6px}
.result .big{font-size:18px;font-weight:700}.score{font-size:26px;font-weight:700}.score small{font-size:12px;color:${INK3};font-weight:400}
.tag{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.t-pass{color:${PASS}}.t-warn{color:${WARN}}.t-fail{color:${FAIL}}.t-none{color:${INK2}}
.dims{display:flex;gap:6px;flex-wrap:wrap}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:5px 8px;border-bottom:1px solid ${RULE};text-align:left;vertical-align:top}
th{font-weight:600;color:${INK2};background:${SOFT};white-space:nowrap}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:0 24px}.kv div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid ${RULE};padding:4px 0}
.kv dt{color:${INK2}}.kv dd{margin:0;font-weight:500;text-align:right;word-break:break-word}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.kpi{border:1px solid ${RULE};border-radius:6px;padding:10px 12px;border-top:3px solid ${INK}}.kpi.pass{border-top-color:${PASS}}.kpi.warn{border-top-color:${WARN}}.kpi.fail{border-top-color:${FAIL}}
.kpi .l{color:${INK2};font-size:11px}.kpi .v{font-size:19px;font-weight:700}.kpi .v small{font-size:11px;font-weight:400;color:${INK3};margin-left:2px}.kpi .d{font-size:11px;color:${INK3}}
.findings{list-style:none;padding:0;margin:0}.findings li{padding:8px 0;border-bottom:1px solid ${RULE}}.findings b{margin-left:6px}.findings p{margin:3px 0 0;color:${INK2}}
.note{color:${INK3};font-size:11px;margin-top:6px}.legend{display:flex;gap:16px;font-size:11px;color:${INK2};margin-top:2px}.legend i{display:inline-block;width:18px;margin-right:5px;vertical-align:middle}
.chart{border:1px solid ${RULE};border-radius:6px;padding:10px}.mono{font-family:ui-monospace,Consolas,monospace}
footer{margin-top:36px;color:${INK3};font-size:11px;border-top:1px solid ${RULE};padding-top:8px}
@media print{body{padding:0}h2{break-after:avoid}.kpi,.chart,tr{break-inside:avoid}}
`;

function tag(v: unknown) { const t = tone(v); return `<span class="tag t-${t ?? 'none'}">${esc(label(v))}</span>`; }

function sectionHtml(s: Section): string {
  let body = '';
  switch (s.kind) {
    case 'kv':
      body = (s.data as [string, unknown][]).length ? `<dl class="kv">${(s.data as [string, unknown][]).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(cellText(v))}</dd></div>`).join('')}</dl>` : '';
      break;
    case 'kpis':
      body = `<div class="kpis">${(s.data as Kpi[]).map((k) => {
        const t = tone(k.status);
        const d = k.deltaPct != null ? `${k.deltaPct > 0 ? '+' : ''}${fmtNum(k.deltaPct, 1)}% vs baseline (${k.baseline == null ? 'n/a' : fmtNum(k.baseline, 2)})` : k.baseline === undefined ? '' : 'no baseline value';
        return `<div class="kpi ${t ?? ''}"><div class="l">${esc(k.label)}${t ? ` ${tag(k.status)}` : ''}</div><div class="v">${esc(kpiValue(k))}${k.unit && k.value != null ? `<small>${esc(k.unit)}</small>` : ''}</div><div class="d">${esc(d)}</div></div>`;
      }).join('')}</div>`;
      break;
    case 'table': {
      const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] };
      if (rows.length) {
        body = `<table><thead><tr>${columns.map((c) => `<th${rows.some((r) => typeof r[c.key] === 'number') ? ' style="text-align:right"' : ''}>${esc(c.header)}${c.unit ? ` <span style="font-weight:400">(${esc(c.unit)})</span>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => {
          const v = r[c.key];
          if (STATUS_COLS.has(c.key) && v) return `<td>${tag(v)}</td>`;
          return `<td${typeof v === 'number' ? ' class="n"' : ''}>${esc(cellText(v, c))}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table>`;
      }
      break;
    }
    case 'text': body = `<p>${esc(s.data)}</p>`; break;
    case 'list': body = (s.data as string[]).length ? `<ul>${(s.data as string[]).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''; break;
    case 'findings': body = (s.data as any[]).length ? `<ul class="findings">${(s.data as any[]).map((f) => `<li>${tag(f.severity)}<b>${esc(f.title)}</b><p>${esc(f.description)}</p></li>`).join('')}</ul>` : ''; break;
    case 'chart': body = `<div class="chart">${chartSvg(s.data as ChartData)}</div>`; break;
  }
  return `<section id="${esc(s.id)}"><h2>${esc(s.title)}</h2>${body}${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</section>`;
}

export function renderHtml(c: ReportContent): string {
  const r = c.result;
  const rt = tone(r?.status);
  const result = r ? `<div class="result"><div><div class="meta">Result</div><div class="big t-${rt ?? 'none'}">${esc(label(r.status))}</div></div>
${r.score != null ? `<div><div class="meta">Score</div><div class="score">${r.score}<small>/100</small></div></div>` : ''}
<div class="dims">${Object.entries(r.breakdown ?? {}).map(([k, v]) => `<span class="tag t-${tone(v) ?? 'none'}">${esc(k)}: ${esc(label(v))}</span>`).join('')}</div></div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title><style>${CSS}</style></head>
<body><header><h1>${esc(c.title)}</h1><div class="sub">${esc(subjectLine(c))}</div>
<div class="meta">${esc(label(c.type))} report · version ${c.version} · generated ${esc(c.generatedAt.slice(0, 16).replace('T', ' '))} UTC · Perfmon</div></header>
${result}
${c.sections.map(sectionHtml).join('\n')}
<footer>Generated by Perfmon from stored run analysis. Figures are reproducible from the report parameters.</footer></body></html>`;
}

/* ------------------------------------------------------------------ CSV */

export function renderCsv(c: ReportContent): string {
  const out: string[] = [];
  const line = (...v: unknown[]) => out.push(v.map(csvEscape).join(','));
  line('Report', c.title); line('Type', c.type); line('Version', c.version); line('Generated', c.generatedAt); line('Subject', subjectLine(c));
  if (c.result) { line('Result', c.result.status); line('Score', c.result.score); for (const [k, v] of Object.entries(c.result.breakdown ?? {})) line(`Result: ${k}`, v); }
  for (const s of c.sections) {
    out.push('');
    line(`# ${s.title}`);
    switch (s.kind) {
      case 'kv': for (const [k, v] of s.data as [string, unknown][]) line(k, v); break;
      case 'kpis': line('Metric', 'Value', 'Unit', 'Baseline', 'Change %', 'Status'); for (const k of s.data as Kpi[]) line(k.label, k.value, k.unit ?? '', k.baseline, k.deltaPct, k.status ?? ''); break;
      case 'table': { const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] }; line(...columns.map((x) => (x.unit ? `${x.header} (${x.unit})` : x.header || x.key))); for (const r of rows) line(...columns.map((x) => r[x.key])); break; }
      case 'text': line(s.data); break;
      case 'list': for (const x of s.data as string[]) line(x); break;
      case 'findings': line('Severity', 'Title', 'Description'); for (const f of s.data as any[]) line(f.severity, f.title, f.description); break;
      case 'chart': {
        const ch = s.data as ChartData;
        line(ch.xType === 'time' ? 'Time' : 'Category', ...ch.series.map((x) => (ch.unit ? `${x.name} (${ch.unit})` : x.name)));
        const xs = ch.series[0]?.data.map((d) => d[0]) ?? [];
        xs.forEach((x, i) => line(ch.xType === 'time' ? new Date(Number(x)).toISOString() : x, ...ch.series.map((se) => se.data[i]?.[1])));
        break;
      }
    }
    if (s.note) line(`Note: ${s.note}`);
  }
  return '﻿' + out.join('\r\n');
}

/* ------------------------------------------------------------------ Excel */

export async function renderXlsx(c: ReportContent): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Perfmon';
  wb.created = new Date(c.generatedAt);
  const used = new Set<string>();
  const sheetName = (t: string) => {
    let base = t.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
    let name = base, i = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${i++}`;
    used.add(name.toLowerCase());
    return name;
  };
  const bold = { bold: true } as const;
  const head = (ws: ExcelJS.Worksheet, values: unknown[]) => { const row = ws.addRow(values); row.font = bold; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } }; };
  const statusFont = (v: unknown) => { const t = tone(v); return t ? { color: { argb: 'FF' + toneColor(t).slice(1) }, bold: true } : undefined; };

  const sum = wb.addWorksheet(sheetName('Summary'));
  sum.columns = [{ width: 32 }, { width: 60 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  sum.addRow([c.title]).font = { bold: true, size: 14 };
  sum.addRow(['Type', label(c.type)]); sum.addRow(['Version', c.version]); sum.addRow(['Generated', c.generatedAt]); sum.addRow(['Subject', subjectLine(c)]);
  if (c.result) {
    const r = sum.addRow(['Result', label(c.result.status)]); r.getCell(2).font = statusFont(c.result.status) ?? {};
    sum.addRow(['Score', c.result.score]);
    for (const [k, v] of Object.entries(c.result.breakdown ?? {})) { const row = sum.addRow([`  ${k}`, label(v)]); row.getCell(2).font = statusFont(v) ?? {}; }
  }
  for (const s of c.sections) {
    if (s.kind === 'kv' || s.kind === 'kpis' || s.kind === 'text' || s.kind === 'list') {
      sum.addRow([]);
      sum.addRow([s.title]).font = { bold: true, size: 12 };
      if (s.kind === 'kv') for (const [k, v] of s.data as [string, unknown][]) sum.addRow([k, v as any]);
      if (s.kind === 'kpis') { head(sum, ['Metric', 'Value', 'Unit', 'Baseline', 'Change %', 'Status']); for (const k of s.data as Kpi[]) { const row = sum.addRow([k.label, k.value, k.unit ?? '', k.baseline ?? null, k.deltaPct ?? null, k.status ? label(k.status) : '']); row.getCell(6).font = statusFont(k.status) ?? {}; } }
      if (s.kind === 'text') { const row = sum.addRow([s.data]); sum.mergeCells(row.number, 1, row.number, 6); row.alignment = { wrapText: true, vertical: 'top' }; row.height = Math.min(200, 15 * Math.ceil(String(s.data).length / 110)); }
      if (s.kind === 'list') for (const x of s.data as string[]) sum.addRow([x]);
      if (s.note) sum.addRow([s.note]).font = { italic: true, color: { argb: 'FF8A8A8A' } };
      continue;
    }
    const ws = wb.addWorksheet(sheetName(s.title));
    if (s.kind === 'table') {
      const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] };
      head(ws, columns.map((x) => (x.unit ? `${x.header} (${x.unit})` : x.header || x.key)));
      for (const r of rows) {
        const row = ws.addRow(columns.map((x) => (r[x.key] ?? null) as any));
        columns.forEach((x, i) => { if (STATUS_COLS.has(x.key)) { const f = statusFont(r[x.key]); if (f) row.getCell(i + 1).font = f; } });
      }
      ws.columns.forEach((col, i) => { col.width = Math.min(60, Math.max(10, columns[i] ? columns[i].header.length + 4 : 10, ...rows.slice(0, 200).map((r) => String(r[columns[i]?.key] ?? '').length + 2))); });
    } else if (s.kind === 'findings') {
      head(ws, ['Severity', 'Title', 'Description']);
      for (const f of s.data as any[]) { const row = ws.addRow([f.severity, f.title, f.description]); row.getCell(1).font = statusFont(f.severity) ?? {}; row.alignment = { wrapText: true, vertical: 'top' }; }
      ws.columns = [{ width: 12 }, { width: 50 }, { width: 100 }];
    } else if (s.kind === 'chart') {
      const ch = s.data as ChartData;
      head(ws, [ch.xType === 'time' ? 'Time' : 'Category', ...ch.series.map((x) => (ch.unit ? `${x.name} (${ch.unit})` : x.name))]);
      const xs = ch.series[0]?.data.map((d) => d[0]) ?? [];
      xs.forEach((x, i) => ws.addRow([ch.xType === 'time' ? new Date(Number(x)) : x, ...ch.series.map((se) => se.data[i]?.[1] ?? null)]));
      ws.columns.forEach((col, i) => { col.width = i === 0 ? 40 : 16; });
    }
    if (s.note) ws.addRow([]).getCell(1).value = s.note;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------ PDF */

/** Standard PDF fonts are WinAnsi: replace characters they cannot encode. */
const pdfText = (v: unknown) => String(v ?? '').replace(/→/g, '->').replace(/≈/g, '~').replace(/Δ/g, 'Chg').replace(/∞/g, 'inf').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff–—‘’“”•…€]/g, '?');

export function renderPdf(c: ReportContent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: pdfText(c.title), Author: 'Perfmon', Subject: pdfText(subjectLine(c)) } });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Single-line cells: pdfkit still wraps when a width is given, so clip to the width with an ellipsis.
    const rawText = doc.text.bind(doc);
    const clip = (t: string, w: number) => {
      if (doc.widthOfString(t) <= w) return t;
      while (t.length > 1 && doc.widthOfString(t + '…') > w) t = t.slice(0, -1);
      return t + '…';
    };
    (doc as any).text = (t: any, x?: any, y?: any, o?: any) => rawText(o?.ellipsis && o.width && typeof t === 'string' ? clip(t, o.width) : t, x, y, o);
    const L = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 14;
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
    const font = (bold = false, size = 9, color = INK) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);

    // Header
    font(true, 18).text(pdfText(c.title), L, doc.y, { width: W });
    font(false, 9.5, INK2).text(pdfText(subjectLine(c)), { width: W });
    font(false, 8, INK3).text(pdfText(`${label(c.type)} report · version ${c.version} · generated ${c.generatedAt.slice(0, 16).replace('T', ' ')} UTC`), { width: W });
    doc.moveDown(0.8);
    if (c.result) {
      const y = doc.y;
      // lay out the breakdown chips first (wrapping), then size the box
      font(true, 7.5);
      const chips: { t: string; v: string; x: number; row: number; w: number }[] = [];
      let x = L + 260, row = 0;
      for (const [k, v] of Object.entries(c.result.breakdown ?? {})) {
        const t = pdfText(`${k}: ${label(v)}`);
        const w = doc.widthOfString(t) + 10;
        if (x + w > L + W - 8 && x > L + 260) { x = L + 260; row++; }
        chips.push({ t, v, x, row, w });
        x += w + 5;
      }
      const boxH = 46 + Math.max(0, row) * 16;
      doc.roundedRect(L, y, W, boxH, 4).lineWidth(0.7).strokeColor(RULE).stroke();
      font(false, 7.5, INK3).text('RESULT', L + 12, y + 8);
      font(true, 14, toneColor(tone(c.result.status))).text(pdfText(label(c.result.status)), L + 12, y + 20, { width: 165 });
      if (c.result.score != null) { font(false, 7.5, INK3).text('SCORE', L + 180, y + 8); font(true, 14).text(`${c.result.score}/100`, L + 180, y + 20); }
      for (const ch of chips) {
        const cy = y + 10 + ch.row * 16;
        doc.roundedRect(ch.x, cy, ch.w, 13, 2).lineWidth(0.6).strokeColor(toneColor(tone(ch.v))).stroke();
        font(true, 7.5, toneColor(tone(ch.v))).text(ch.t, ch.x + 5, cy + 3.5, { lineBreak: false });
      }
      doc.x = L; doc.y = y + boxH + 10;
    }

    const heading = (t: string, keep = 40) => {
      ensure(keep);
      doc.moveDown(0.6);
      font(true, 11.5).text(pdfText(t), L, doc.y, { width: W });
      const y = doc.y + 2;
      doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.8).strokeColor(INK).stroke();
      doc.y = y + 6;
    };

    const table = (columns: Column[], rows: Record<string, unknown>[]) => {
      const fs = columns.length > 8 ? 6.8 : 7.6;
      font(false, fs);
      const txt = (r: Record<string, unknown>, col: Column) => pdfText(cellText(r[col.key], col));
      const hdr = (col: Column) => pdfText(col.unit ? `${col.header} (${col.unit})` : col.header);
      const want = columns.map((col) => Math.min(220, Math.max(doc.font('Helvetica-Bold').widthOfString(hdr(col)), ...rows.slice(0, 60).map((r) => doc.font(STATUS_COLS.has(col.key) ? 'Helvetica-Bold' : 'Helvetica').widthOfString(txt(r, col)))) + 10));
      const total = want.reduce((a, b) => a + b, 0);
      const widths = total <= W ? want.map((w) => (w / total) * W) : (() => { // shrink the widest (text) columns first
        const ws = [...want]; let over = total - W;
        while (over > 0.5) { const i = ws.indexOf(Math.max(...ws)); const cut = Math.min(over, ws[i] - 40); if (cut <= 0) break; ws[i] -= cut; over -= cut; }
        const t2 = ws.reduce((a, b) => a + b, 0); return ws.map((w) => (w / t2) * W);
      })();
      const numeric = columns.map((col) => rows.some((r) => typeof r[col.key] === 'number'));
      const rowH = fs + 6;
      const drawHeader = () => {
        doc.rect(L, doc.y, W, rowH + 1).fill(SOFT);
        let x = L; const y = doc.y + 3.5;
        columns.forEach((col, i) => { font(true, fs, INK2).text(hdr(col), x + 4, y, { width: widths[i] - 8, lineBreak: false, ellipsis: true, align: numeric[i] ? 'right' : 'left' }); x += widths[i]; });
        doc.y = y - 3.5 + rowH + 1;
      };
      ensure(rowH * 3);
      drawHeader();
      const lineH = fs * 1.2;
      for (const r of rows) {
        // text columns wrap (up to 4 lines); numbers and statuses stay on one line
        font(false, fs);
        const lines = columns.map((col, i) => (numeric[i] || STATUS_COLS.has(col.key) ? 1 : Math.min(4, Math.max(1, Math.round(doc.heightOfString(txt(r, col), { width: widths[i] - 8 }) / doc.currentLineHeight())))));
        const h = rowH + (Math.max(...lines) - 1) * lineH;
        if (doc.y + h > bottom()) { doc.addPage(); drawHeader(); }
        let x = L; const y = doc.y + 3;
        columns.forEach((col, i) => {
          const v = r[col.key];
          const st = STATUS_COLS.has(col.key) ? tone(v) : null;
          const opts = lines[i] > 1 ? { width: widths[i] - 8, height: lines[i] * lineH + 1, lineGap: 0 } : { width: widths[i] - 8, lineBreak: false, ellipsis: true, align: numeric[i] ? 'right' as const : 'left' as const };
          font(!!st, fs, st ? toneColor(st) : INK).text(txt(r, col), x + 4, y, opts);
          x += widths[i];
        });
        doc.y = y - 3 + h;
        doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.4).strokeColor(RULE).stroke();
      }
      doc.x = L;
    };

    const chart = (ch: ChartData) => {
      if (ch.type === 'bar') {
        const n = ch.series[0]?.data.length ?? 0;
        const g: Geo = { w: W, h: n * 15 + 8, pad: { l: 170, r: 60, t: 4, b: 4 } };
        ensure(g.h + 6);
        const top = doc.y;
        const { bars } = barGeometry(ch, g);
        for (const b of bars) {
          font(false, 7.2, INK2).text(pdfText(b.name), L, top + b.y + b.h / 2 - 3.5, { width: g.pad.l - 8, align: 'right', lineBreak: false, ellipsis: true });
          doc.rect(L + g.pad.l, top + b.y, Math.max(0.5, b.w), b.h).fill(INK);
          font(false, 7.2).text(pdfText(`${b.v == null ? 'n/a' : fmtNum(b.v, b.v >= 100 ? 0 : 2)}${ch.unit ? ' ' + ch.unit : ''}`), L + g.pad.l + b.w + 4, top + b.y + b.h / 2 - 3.5, { lineBreak: false });
        }
        doc.x = L; doc.y = top + g.h + 4;
        return;
      }
      const g: Geo = { w: W, h: 150, pad: { l: 44, r: 8, t: 8, b: 18 } };
      ensure(g.h + 20);
      const top = doc.y;
      const { lines, ticks, xticks } = lineGeometry(ch, g);
      for (const t of ticks) {
        doc.moveTo(L + g.pad.l, top + t.y).lineTo(L + g.w - g.pad.r, top + t.y).lineWidth(0.4).strokeColor(RULE).stroke();
        font(false, 6.5, INK3).text(pdfText(t.label), L, top + t.y - 3, { width: g.pad.l - 5, align: 'right', lineBreak: false });
      }
      xticks.forEach((t, i) => font(false, 6.5, INK3).text(t.label, L + t.x - (i === 0 ? 0 : i === 2 ? 30 : 15), top + g.h - 12, { width: 30, align: i === 0 ? 'left' : i === 2 ? 'right' : 'center', lineBreak: false }));
      lines.forEach((l, i) => {
        for (const seg of l.segs) {
          if (seg.length < 2) continue;
          doc.moveTo(L + seg[0][0], top + seg[0][1]);
          for (const [x, y] of seg.slice(1)) doc.lineTo(L + x, top + y);
          doc.lineWidth(i === 0 ? 1.2 : 0.9).strokeColor(SERIES[i % SERIES.length]);
          if (i % 2) doc.dash(3, { space: 2 }); else doc.undash();
          doc.stroke();
        }
      });
      doc.undash();
      let lx = L + g.pad.l;
      lines.forEach((l, i) => {
        const y = top + g.h + 4;
        doc.moveTo(lx, y + 3).lineTo(lx + 14, y + 3).lineWidth(1.2).strokeColor(SERIES[i % SERIES.length]);
        if (i % 2) doc.dash(3, { space: 2 }); else doc.undash();
        doc.stroke(); doc.undash();
        const t = pdfText(`${l.name}${ch.unit ? ` (${ch.unit})` : ''}`);
        font(false, 7, INK2).text(t, lx + 18, y, { lineBreak: false });
        lx += 18 + doc.widthOfString(t) + 14;
      });
      doc.x = L; doc.y = top + g.h + 16;
    };

    // keep each heading with the start of its body (whole chart / KPI row / first table rows)
    const keepWith = (s: Section) => (s.kind === 'chart' ? ((s.data as ChartData).type === 'bar' ? (s.data as ChartData).series[0].data.length * 15 + 50 : 205) : s.kind === 'kpis' ? 90 : s.kind === 'table' ? 70 : 50);
    for (const s of c.sections) {
      heading(s.title, keepWith(s));
      switch (s.kind) {
        case 'kv': {
          const items = s.data as [string, unknown][];
          const colW = W / 2 - 8;
          for (let i = 0; i < items.length; i += 2) {
            ensure(14);
            const y = doc.y;
            items.slice(i, i + 2).forEach(([k, v], j) => {
              const x = L + j * (colW + 16);
              font(false, 8, INK2).text(pdfText(k), x, y, { width: colW * 0.45, lineBreak: false, ellipsis: true });
              font(true, 8).text(pdfText(cellText(v)), x + colW * 0.45, y, { width: colW * 0.55, align: 'right', lineBreak: false, ellipsis: true });
              doc.moveTo(x, y + 11).lineTo(x + colW, y + 11).lineWidth(0.4).strokeColor(RULE).stroke();
            });
            doc.y = y + 14;
          }
          doc.x = L;
          break;
        }
        case 'kpis': {
          const per = 5, gap = 6, bw = (W - gap * (per - 1)) / per, bh = 46;
          const ks = s.data as Kpi[];
          for (let i = 0; i < ks.length; i += per) {
            ensure(bh + gap);
            const y = doc.y;
            ks.slice(i, i + per).forEach((k, j) => {
              const x = L + j * (bw + gap);
              doc.rect(x, y, bw, bh).lineWidth(0.6).strokeColor(RULE).stroke();
              doc.rect(x, y, bw, 2.5).fill(toneColor(tone(k.status)) === INK2 ? INK : toneColor(tone(k.status)));
              font(false, 7, INK2).text(pdfText(k.label), x + 6, y + 7, { width: bw - 12, lineBreak: false, ellipsis: true });
              font(true, 12.5).text(pdfText(`${kpiValue(k)}${k.unit && k.value != null ? ' ' + k.unit : ''}`), x + 6, y + 18, { width: bw - 12, lineBreak: false, ellipsis: true });
              if (k.deltaPct != null) font(false, 6.5, INK3).text(pdfText(`${k.deltaPct > 0 ? '+' : ''}${fmtNum(k.deltaPct, 1)}% vs baseline`), x + 6, y + 35, { width: bw - 12, lineBreak: false, ellipsis: true });
            });
            doc.y = y + bh + gap;
          }
          doc.x = L;
          break;
        }
        case 'table': { const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] }; if (rows.length) table(columns, rows); break; }
        case 'text': ensure(24); font(false, 9).text(pdfText(s.data), L, doc.y, { width: W, lineGap: 2 }); break;
        case 'list': for (const x of s.data as string[]) { ensure(14); font(false, 8.5).text(pdfText(`•  ${x}`), L, doc.y, { width: W, lineGap: 1.5 }); doc.moveDown(0.2); } break;
        case 'findings':
          for (const f of s.data as any[]) {
            ensure(28);
            const y = doc.y;
            font(true, 7, toneColor(tone(f.severity))).text(pdfText(label(f.severity)), L, y + 1, { width: 60, lineBreak: false });
            font(true, 8.5).text(pdfText(f.title), L + 62, y, { width: W - 62 });
            font(false, 8, INK2).text(pdfText(f.description), L + 62, doc.y + 1, { width: W - 62, lineGap: 1 });
            doc.moveDown(0.4);
          }
          doc.x = L;
          break;
        case 'chart': chart(s.data as ChartData); break;
      }
      if (s.note) { ensure(14); font(false, 7.5, INK3).text(pdfText(s.note), L, doc.y + 3, { width: W }); }
    }

    // Footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - doc.page.margins.bottom + 10;
      doc.page.margins.bottom = 0;
      font(false, 7, INK3).text(pdfText(`${c.title} · v${c.version}`), L, y, { width: W / 2, lineBreak: false, ellipsis: true });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, L + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
