import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { csvEscape } from '../lib/http.js';
import { fmtNum, fmtSigned, type ChartData, type Column, type Kpi, type ReportContent, type Section, type SummaryData } from './content.js';

/**
 * Report renderers. Every format renders from the stored ReportContent model (also older stored
 * models without chapters). Visual language: black / white / grey; colour only for PASS / WARN / FAIL.
 * Charts are vector (inline SVG in HTML, paths in PDF) and share one geometry builder.
 */

const INK = '#111111', INK2 = '#4a4a4a', INK3 = '#8a8a8a', RULE = '#dedede', SOFT = '#f3f3f3', ZEBRA = '#fafafa';
const PASS = '#15803d', WARN = '#b45309', FAIL = '#c62828';
const TINT = { pass: '#e9f5ee', warn: '#fdf3e6', fail: '#fcebeb' } as const;
const SERIES = ['#111111', '#6b6b6b', '#a3a3a3', '#3d3d3d', '#8c8c8c', '#c2c2c2'];
const MARK = {
  bars: ['M35 242Q57 231 80 226V310H35Z', 'M108 197Q134 184 160 179V310H108Z', 'M180 151Q206 137 232 131V310H180Z'],
  band: 'M90 28H262C310 28 342 70 342 135C342 205 305 258 258 258V195C278 192 288 170 288 145C288 115 278 95 262 95H160Z',
  fold: 'M262 95C278 95 288 115 288 145C288 170 278 192 258 195V258C287 250 316 220 322 170C300 185 300 120 262 95Z',
};
const TYPE_NAME: Record<string, string> = { TEST_EXECUTION: 'Test execution report', COMPARISON: 'Comparison report', EXECUTIVE: 'Executive summary', SLA: 'SLA compliance report', TREND: 'Trend report' };
const SCORE_LABEL: Record<string, string> = { EXECUTIVE: 'Average score', SLA: 'Compliance', TREND: 'Latest score' };
const SHORT_CONF = 'Confidential — internal use only';

/* ------------------------------------------------------------------ shared helpers */

type Tone = 'pass' | 'warn' | 'fail' | null;
/** pass / warn / fail / null for any status-like value. */
export function tone(v: unknown): Tone {
  const s = String(v ?? '').toUpperCase();
  if (['PASS', 'COMPLETED', 'BETTER', 'IMPROVEMENT', 'IMPROVING', 'OK', 'CONSISTENT', 'HEALTHY', 'READY', 'LOW'].includes(s)) return 'pass';
  if (['PASS_WITH_WARNINGS', 'WARNING', 'MEDIUM', 'MINOR', 'MINOR_DIFFERENCES', 'ABORTED'].includes(s)) return 'warn';
  if (['FAIL', 'FAILED', 'CRITICAL', 'WORSE', 'REGRESSION', 'HIGH', 'MISMATCH', 'INCONSISTENT', 'DEGRADING'].includes(s)) return 'fail';
  return null;
}
const toneColor = (t: Tone) => (t === 'pass' ? PASS : t === 'warn' ? WARN : t === 'fail' ? FAIL : INK2);
const STATUS_COLS = new Set(['status', 'verdict', 'severity', 'direction', 'result', 'sla', 'priority', 'latest', 'kind']);
const label = (v: unknown) => String(v ?? '').replace(/_/g, ' ');
const isStatus = (c?: Column) => !!c && (c.fmt === 'status' || (!c.fmt && STATUS_COLS.has(c.key)));
const isNumCol = (c: Column, rows: Record<string, unknown>[]) => c.fmt === 'int' || c.fmt === 'num' || c.fmt === 'num1' || c.fmt === 'pct' || c.fmt === 'delta' || (!c.fmt && rows.some((r) => typeof r[c.key] === 'number'));
const header = (c: Column) => `${c.approx ? '≈ ' : ''}${c.header}${c.unit ? ` (${c.unit})` : ''}`;
const statusText = (v: unknown) => { const s = label(v); return s === 'better' || s === 'worse' ? s[0].toUpperCase() + s.slice(1) : s; };

export function cellText(v: unknown, col?: Column): string {
  if (v == null || v === '') return '—';
  if (col?.fmt === 'spark') return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number') {
    switch (col?.fmt) {
      case 'int': return fmtNum(v, 0);
      case 'num1': return fmtNum(v, 1);
      case 'pct': return fmtNum(v, 2);
      case 'delta': return fmtSigned(v, Math.abs(v) >= 100 ? 0 : 1);
      case 'num': return fmtNum(v, Math.abs(v) >= 100 ? 0 : 2);
    }
    const signed = col?.unit === '%' && /^(change|c\d+)$/.test(col.key);
    return signed ? fmtSigned(v, Math.abs(v) >= 100 ? 0 : 1) : fmtNum(v, Math.abs(v) >= 100 ? 0 : 2);
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16).replace('T', ' ');
  if (isStatus(col)) return statusText(v);
  return String(v);
}
const kpiValue = (k: Kpi) => (k.value == null ? 'n/a' : typeof k.value === 'number' ? fmtNum(k.value, Math.abs(k.value) >= 100 ? 0 : Math.abs(k.value) >= 10 ? 1 : 2) : String(k.value));
const kpiDelta = (k: Kpi): { text: string; t: Tone } | null => {
  if (k.deltaPct != null) {
    const good = k.better === 'neutral' || Math.abs(k.deltaPct) < 2 ? null : (k.better === 'lower') === k.deltaPct < 0;
    return { text: `${k.deltaPct > 0 ? '▲' : k.deltaPct < 0 ? '▼' : '■'} ${fmtSigned(k.deltaPct, 1)}% vs ${k.baseline == null ? 'baseline' : fmtNum(k.baseline, Math.abs(k.baseline) >= 100 ? 0 : 2)}`, t: good == null ? null : good ? 'pass' : 'fail' };
  }
  return k.hint ? { text: k.hint, t: null } : k.baseline === null ? { text: 'no baseline value', t: null } : null;
};
const subjectLine = (c: ReportContent) => {
  const s = c.subject;
  return [s.runKey, s.runKeys?.join(' vs '), s.testName, s.projectName, s.environment, s.build ? `Build ${s.build}` : null, s.from && s.to ? `${s.from.slice(0, 10)} → ${s.to.slice(0, 10)}` : null].filter(Boolean).join(' · ');
};
const coverFacts = (c: ReportContent): [string, string][] => c.cover?.facts ?? ([['Subject', subjectLine(c)]] as [string, string][]);
const genDate = (c: ReportContent) => `${c.generatedAt.slice(0, 16).replace('T', ' ')} UTC`;
const reportRef = (c: ReportContent) => (c.reportId ? c.reportId.slice(0, 8).toUpperCase() : '—');

/** Section numbering: chapters N, their sub-sections N.M; legacy reports (no chapters) N. */
interface Entry { s: Section; num: string; level: 1 | 2 }
function outline(c: ReportContent): Entry[] {
  const hasCh = c.sections.some((s) => s.kind === 'chapter');
  let ch = 0, sub = 0;
  return c.sections.map((s) => {
    if (!hasCh) return { s, num: String(++ch), level: 2 as const };
    if (s.kind === 'chapter') { ch++; sub = 0; return { s, num: String(ch), level: 1 as const }; }
    sub++;
    return { s, num: ch ? `${ch}.${sub}` : '', level: 2 as const };
  });
}

/* ------------------------------------------------------------------ chart geometry (shared by SVG and PDF) */

type Prim =
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; c: string; w: number; dash?: number[] }
  | { k: 'path'; pts: [number, number][]; c: string; w: number; dash?: number[] }
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { k: 'text'; x: number; y: number; s: string; size: number; c: string; anchor: 'start' | 'middle' | 'end'; bold?: boolean }
  | { k: 'dot'; x: number; y: number; r: number; c: string };

function niceStep(raw: number) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const tickLabel = (v: number, step: number) => fmtNum(v, step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dashOf = (style: string | undefined, i: number) => (style === 'dashed' ? [4, 3] : style === 'dotted' ? [1.2, 2.2] : style === 'solid' || i < 3 ? undefined : [4, 3]);
const approxW = (s: string, size: number) => s.length * size * 0.56;

function chartPrims(ch: ChartData, W: number, fs: number): { h: number; prims: Prim[] } {
  const P: Prim[] = [];
  const lw = fs / 7;
  const series = ch.series.filter((s) => s.data.length);
  // legend (top right) + y label (top left)
  const legend = (y: number, items: { name: string; c: string; dash?: number[]; bar?: boolean }[]) => {
    let x = W;
    for (const it of [...items].reverse()) {
      const tw = approxW(it.name, fs);
      x -= tw;
      P.push({ k: 'text', x, y: y + fs * 0.35, s: it.name, size: fs, c: INK2, anchor: 'start' });
      x -= 5 + 16;
      if (it.bar) P.push({ k: 'rect', x: x + 6, y: y - fs * 0.4, w: 9, h: fs * 0.8, fill: it.c });
      else P.push({ k: 'line', x1: x, y1: y, x2: x + 16, y2: y, c: it.c, w: 1.6 * lw, dash: it.dash });
      x -= 14;
    }
  };

  if (ch.type === 'bar') {
    const cats = [...new Set(series.flatMap((s) => s.data.map((d) => String(d[0]))))];
    const k = Math.max(1, series.length);
    const barH = (k === 1 ? 2 : 1.25) * fs, rowH = k * barH + fs * (k === 1 ? 0.9 : 1.1);
    const top = k > 1 ? fs * 2.6 : fs * 0.6;
    const labelW = Math.min(W * 0.36, Math.max(...cats.map((c) => approxW(c, fs)), 30) + 10);
    const x0 = labelW, x1 = W - fs * 6.5;
    const vals = series.flatMap((s) => s.data.map((d) => d[1]).filter((v): v is number => v != null));
    const step = niceStep(Math.max(...vals, 0) / 5);
    const max = Math.max(step, Math.ceil(Math.max(...vals, 0) / step) * step);
    const plotH = cats.length * rowH;
    const h = top + plotH + fs * 2.4;
    for (let v = 0; v <= max + step / 2; v += step) {
      const x = x0 + (v / max) * (x1 - x0);
      P.push({ k: 'line', x1: x, y1: top, x2: x, y2: top + plotH, c: v === 0 ? INK3 : RULE, w: 0.6 * lw });
      P.push({ k: 'text', x, y: top + plotH + fs * 1.5, s: tickLabel(v, step), size: fs * 0.92, c: INK3, anchor: 'middle' });
    }
    if (ch.unit) P.push({ k: 'text', x: x1 + fs * 6.4, y: top + plotH + fs * 1.5, s: ch.unit, size: fs * 0.92, c: INK3, anchor: 'end' });
    cats.forEach((cat, ci) => {
      const y = top + ci * rowH + fs * 0.45;
      const lab = approxW(cat, fs) > labelW - 10 ? cat.slice(0, Math.max(4, Math.floor((labelW - 10) / (fs * 0.56)) - 1)) + '…' : cat;
      P.push({ k: 'text', x: labelW - 8, y: y + (k * barH) / 2 + fs * 0.35, s: lab, size: fs, c: INK2, anchor: 'end' });
      series.forEach((s, si) => {
        const v = s.data.find((d) => String(d[0]) === cat)?.[1] ?? null;
        const by = y + si * barH;
        const w = v == null ? 0 : Math.max(0.8, (v / max) * (x1 - x0));
        if (v != null) P.push({ k: 'rect', x: x0, y: by + barH * 0.1, w, h: barH * 0.8, fill: SERIES[si % SERIES.length] });
        P.push({ k: 'text', x: x0 + w + 4, y: by + barH / 2 + fs * 0.33, s: v == null ? 'n/a' : fmtNum(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2), size: fs * (k > 1 ? 0.86 : 0.95), c: INK, anchor: 'start' });
      });
    });
    if (k > 1) legend(fs * 0.9, series.map((s, i) => ({ name: s.name, c: SERIES[i % SERIES.length], bar: true })));
    return { h, prims: P };
  }

  // line chart
  const h = Math.round(W * 0.36);
  const pad = { l: fs * 5.6, r: fs * 1.2, t: fs * 3.2, b: fs * 2.8 };
  const xs = series.flatMap((s) => s.data.map((d) => Number(d[0])));
  const ys = series.flatMap((s) => s.data.map((d) => d[1]).filter((v): v is number => v != null));
  const thr = (ch.thresholds ?? []).filter((t) => Number.isFinite(t.value));
  const yTop = Math.max(...ys, ...thr.map((t) => t.value), 0);
  const step = niceStep(yTop / 4 || 1);
  const yMax = Math.max(step, Math.ceil(yTop / step) * step);
  const xa = Math.min(...xs), xb = Math.max(...xs);
  const iw = W - pad.l - pad.r, ih = h - pad.t - pad.b;
  const sx = (x: number) => pad.l + (xb === xa ? iw / 2 : ((x - xa) / (xb - xa)) * iw);
  const sy = (y: number) => pad.t + ih - (y / yMax) * ih;
  if (ch.yLabel || ch.unit) P.push({ k: 'text', x: 0, y: fs * 1.1, s: ch.yLabel ?? ch.unit!, size: fs, c: INK2, anchor: 'start', bold: true });
  for (let v = 0; v <= yMax + step / 2; v += step) {
    P.push({ k: 'line', x1: pad.l, y1: sy(v), x2: W - pad.r, y2: sy(v), c: v === 0 ? INK3 : RULE, w: (v === 0 ? 0.8 : 0.5) * lw });
    P.push({ k: 'text', x: pad.l - fs * 0.6, y: sy(v) + fs * 0.33, s: tickLabel(v, step), size: fs * 0.92, c: INK3, anchor: 'end' });
  }
  // x ticks
  let xt: { v: number; s: string }[] = [];
  if (ch.xType === 'elapsed') {
    const st = niceStep((xb - xa) / 5 || 1);
    for (let v = Math.ceil(xa / st) * st; v <= xb + 1e-9; v += st) xt.push({ v, s: `${fmtNum(v, st >= 1 ? 0 : 1)} min` });
  } else if (ch.xType === 'time' || ch.xType == null) {
    const span = xb - xa;
    const f = (t: number) => { const d = new Date(t); return span <= 36 * 3600e3 ? d.toISOString().slice(11, 16) : `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`; };
    const n = span ? 5 : 1;
    for (let i = 0; i < n; i++) { const v = xa + (span * i) / Math.max(1, n - 1); xt.push({ v, s: f(v) }); }
    xt = xt.filter((t, i) => i === 0 || t.s !== xt[i - 1].s);
  }
  xt.forEach((t, i) => {
    const x = sx(t.v);
    P.push({ k: 'line', x1: x, y1: pad.t + ih, x2: x, y2: pad.t + ih + 3, c: INK3, w: 0.6 * lw });
    P.push({ k: 'text', x, y: h - pad.b + fs * 1.6, s: t.s, size: fs * 0.92, c: INK3, anchor: xt.length > 1 && i === 0 && x - pad.l < 20 ? 'start' : xt.length > 1 && i === xt.length - 1 && W - pad.r - x < 20 ? 'end' : 'middle' });
  });
  if (ch.xType === 'time' && xb - xa > 0) P.push({ k: 'text', x: W - pad.r, y: h - fs * 0.1, s: xb - xa <= 36 * 3600e3 ? 'Time (UTC)' : 'Date (UTC)', size: fs * 0.85, c: INK3, anchor: 'end' });
  for (const t of thr) {
    const y = sy(t.value), c = t.status ? toneColor(tone(t.status)) : INK2;
    P.push({ k: 'line', x1: pad.l, y1: y, x2: W - pad.r, y2: y, c, w: 0.9 * lw, dash: [3, 2.5] });
  }
  series.forEach((s, i) => {
    const c = SERIES[i % SERIES.length], dash = dashOf(s.style, i);
    let seg: [number, number][] = [];
    const flush = () => { if (seg.length > 1) P.push({ k: 'path', pts: seg, c, w: (i === 0 ? 1.6 : 1.3) * lw, dash }); else if (seg.length === 1) P.push({ k: 'dot', x: seg[0][0], y: seg[0][1], r: 1.8 * lw, c }); seg = []; };
    for (const [x, y] of s.data) { if (y == null) flush(); else seg.push([sx(Number(x)), sy(y)]); }
    flush();
    if (s.data.filter((d) => d[1] != null).length <= 12) for (const [x, y] of s.data) if (y != null) P.push({ k: 'dot', x: sx(Number(x)), y: sy(y), r: 1.7 * lw, c });
  });
  legend(fs * 1.1 - fs * 0.35, [...series.map((s, i) => ({ name: s.name, c: SERIES[i % SERIES.length], dash: dashOf(s.style, i) })), ...thr.map((t) => ({ name: t.label, c: t.status ? toneColor(tone(t.status)) : INK2, dash: [3, 2.5] }))]);
  return { h, prims: P };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

function chartSvg(ch: ChartData) {
  const W = 760;
  const { h, prims } = chartPrims(ch, W, 10.5);
  const body = prims.map((p) => {
    switch (p.k) {
      case 'line': return `<line x1="${f1(p.x1)}" y1="${f1(p.y1)}" x2="${f1(p.x2)}" y2="${f1(p.y2)}" stroke="${p.c}" stroke-width="${f1(p.w)}"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}/>`;
      case 'path': return `<polyline fill="none" stroke="${p.c}" stroke-width="${f1(p.w)}" stroke-linejoin="round" stroke-linecap="round"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''} points="${p.pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ')}"/>`;
      case 'rect': return `<rect x="${f1(p.x)}" y="${f1(p.y)}" width="${f1(p.w)}" height="${f1(p.h)}" fill="${p.fill}" rx="1"/>`;
      case 'dot': return `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(p.r)}" fill="${p.c}"/>`;
      case 'text': return `<text x="${f1(p.x)}" y="${f1(p.y)}" font-size="${f1(p.size)}" fill="${p.c}" text-anchor="${p.anchor}"${p.bold ? ' font-weight="600"' : ''}>${esc(p.s)}</text>`;
    }
  }).join('');
  return `<svg viewBox="0 0 ${W} ${Math.ceil(h)}" width="100%" role="img" aria-label="${esc(ch.yLabel ?? ch.unit ?? 'chart')}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">${body}</svg>`;
}
function sparkSvg(vals: unknown) {
  const v = (Array.isArray(vals) ? vals : []).map((x) => (typeof x === 'number' ? x : null));
  const pts = v.map((y, i) => [i, y] as [number, number | null]).filter((p): p is [number, number] => p[1] != null);
  if (pts.length < 2) return '<span class="muted">—</span>';
  const w = 90, h = 20, max = Math.max(...pts.map((p) => p[1])), min = Math.min(...pts.map((p) => p[1]));
  const sx = (i: number) => 2 + (i / (v.length - 1)) * (w - 4), sy = (y: number) => h - 3 - (max === min ? 0.5 : (y - min) / (max - min)) * (h - 6);
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${INK}" stroke-width="1.2" points="${pts.map(([i, y]) => `${f1(sx(i))},${f1(sy(y))}`).join(' ')}"/><circle cx="${f1(sx(last[0]))}" cy="${f1(sy(last[1]))}" r="1.8" fill="${INK}"/></svg>`;
}
function markSvg(size: number, onDark: boolean) {
  const band = onDark ? 'url(#pmb)' : INK, bar = onDark ? 'url(#pmv)' : '#555';
  return `<svg width="${size}" height="${size}" viewBox="28.5 9 320 320" aria-hidden="true">${onDark ? '<defs><linearGradient id="pmb" x1="90" y1="28" x2="330" y2="250" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".65" stop-color="#d4d4d8"/><stop offset="1" stop-color="#e4e4e7"/></linearGradient><linearGradient id="pmv" x1="0" y1="130" x2="0" y2="310" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#a1a1aa"/></linearGradient></defs>' : ''}${MARK.bars.map((d) => `<path d="${d}" fill="${bar}"/>`).join('')}<path d="${MARK.band}" fill="${band}"/>${onDark ? `<path d="${MARK.fold}" fill="#3f3f46" fill-opacity=".35"/>` : ''}</svg>`;
}
function gaugeSvg(score: number) {
  const r = 34, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, score)) / 100;
  return `<svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="${r}" fill="none" stroke="#e6e6e6" stroke-width="7"/><circle cx="42" cy="42" r="${r}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${f1(c * p)} ${f1(c)}" transform="rotate(-90 42 42)"/></svg>`;
}

/* ------------------------------------------------------------------ fonts */

const ASSETS = new URL('./assets/', import.meta.url);
let fontCache: { ttf: Record<'R' | 'S' | 'B', Buffer>; woff: Record<'R' | 'S' | 'B', string> } | null | undefined;
function fonts() {
  if (fontCache !== undefined) return fontCache;
  try {
    const f = (n: string) => readFileSync(new URL(n, ASSETS));
    fontCache = {
      ttf: { R: f('Inter-Regular.ttf'), S: f('Inter-SemiBold.ttf'), B: f('Inter-Bold.ttf') },
      woff: { R: f('Inter-Regular.woff2').toString('base64'), S: f('Inter-SemiBold.woff2').toString('base64'), B: f('Inter-Bold.woff2').toString('base64') },
    };
  } catch { fontCache = null; } // fall back to built-in fonts
  return fontCache;
}

/* ------------------------------------------------------------------ HTML */

const CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:${INK}}
body{font:13px/1.55 'Inter','Google Sans','Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;font-feature-settings:'kern';-webkit-font-smoothing:antialiased}
.page{max-width:1040px;margin:0 auto;padding:0 44px 48px}
.cover{background:${INK};color:#fff;padding:40px 44px 44px;margin:0 -44px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;letter-spacing:-.01em}
.cover .kind{margin-top:44px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#a1a1aa;font-weight:600}
.cover h1{font-size:30px;line-height:1.2;margin:8px 0 8px;letter-spacing:-.02em;font-weight:700;max-width:860px}
.cover .subj{color:#d4d4d8;font-size:14px}
.headline{display:grid;grid-template-columns:auto auto 1fr;gap:28px;align-items:center;padding:26px 0 22px;border-bottom:1px solid ${RULE}}
.res .cap,.gauge .cap{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:${INK3};font-weight:600}
.badge{display:inline-block;margin-top:6px;padding:6px 14px;border-radius:999px;font-weight:700;font-size:15px;letter-spacing:.02em}
.b-pass{background:${TINT.pass};color:${PASS}}.b-warn{background:${TINT.warn};color:${WARN}}.b-fail{background:${TINT.fail};color:${FAIL}}.b-none{background:${SOFT};color:${INK2}}
.gauge{display:flex;align-items:center;gap:12px}.gauge .num{position:relative;width:84px;height:84px}.gauge .num b{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;line-height:1.6}
.t-pass{background:${TINT.pass};color:${PASS}}.t-warn{background:${TINT.warn};color:${WARN}}.t-fail{background:${TINT.fail};color:${FAIL}}.t-none{background:${SOFT};color:${INK2}}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0 32px;padding:14px 0 6px}
.facts div{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid ${RULE}}.facts dt{color:${INK3}}.facts dd{margin:0;font-weight:600;text-align:right}
.meta{color:${INK3};font-size:11.5px;margin-top:12px}
.toc{margin:30px 0 8px;padding:20px 24px;background:${ZEBRA};border:1px solid ${RULE};border-radius:10px}
.toc h2{margin:0 0 10px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:${INK3};border:0;padding:0}
.toc ol{list-style:none;margin:0;padding:0;columns:2;column-gap:36px}.toc li{break-inside:avoid;padding:2px 0}
.toc a{color:${INK};text-decoration:none}.toc a:hover{text-decoration:underline}.toc .n{display:inline-block;min-width:34px;color:${INK3};font-variant-numeric:tabular-nums}
.toc .l1{font-weight:600;margin-top:6px}.toc .l2{font-size:12px;color:${INK2};padding-left:34px}.toc .l2 .n{min-width:30px}
.chapter{margin-top:56px;padding-top:22px;border-top:2px solid ${INK}}
.chapter .cn{font-size:13px;font-weight:700;color:${INK3};letter-spacing:.08em}.chapter h2{font-size:24px;margin:2px 0 6px;letter-spacing:-.015em;line-height:1.25}
.chapter p{color:${INK2};margin:0;max-width:820px;font-size:14px}
section.sub{margin-top:30px}h3{font-size:15px;margin:0 0 12px;letter-spacing:-.005em}h3 .n{color:${INK3};font-weight:600;margin-right:10px;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:7px 9px;text-align:left;vertical-align:top}
thead th{font-weight:600;color:${INK2};background:${SOFT};border-bottom:1px solid #cfcfcf;white-space:nowrap;font-size:11.5px}
tbody tr:nth-child(even) td{background:${ZEBRA}}tbody td{border-bottom:1px solid #ececec}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.mono{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:11.5px}
table.dense{font-size:11.5px}table.dense th,table.dense td{padding:6px 6px}table.dense thead th{font-size:10.5px;white-space:normal}
.tw{overflow-x:auto;border:1px solid ${RULE};border-radius:8px}.tw table thead th:first-child{border-top-left-radius:8px}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:0 32px}.kv div{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid ${RULE};padding:6px 0}
.kv.wide{grid-template-columns:1fr}.kv.wide div{justify-content:flex-start}.kv.wide dt{min-width:200px}.kv.wide dd{text-align:left;font-weight:400}
.kv dt{color:${INK2}}.kv dd{margin:0;font-weight:600;text-align:right;word-break:break-word}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px}
.kpi{border:1px solid ${RULE};border-radius:10px;padding:12px 14px 11px;position:relative;overflow:hidden}
.kpi:before{content:'';position:absolute;left:0;top:0;right:0;height:3px;background:${INK}}.kpi.pass:before{background:${PASS}}.kpi.warn:before{background:${WARN}}.kpi.fail:before{background:${FAIL}}
.kpi .l{color:${INK2};font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-weight:600}.kpi .v{font-size:23px;font-weight:700;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .v small{font-size:12px;font-weight:500;color:${INK3};margin-left:3px}.kpi .d{font-size:11.5px;color:${INK3};margin-top:2px}.kpi .d.pass{color:${PASS}}.kpi .d.fail{color:${FAIL}}
.findings{list-style:none;padding:0;margin:0;border-top:1px solid ${RULE}}.findings li{padding:11px 0;border-bottom:1px solid ${RULE};display:grid;grid-template-columns:110px 1fr;gap:12px}.findings b{display:block}.findings p{margin:3px 0 0;color:${INK2}}
.summary p.lead{font-size:14.5px;line-height:1.65;margin:0 0 10px;max-width:900px}
.risk{display:flex;align-items:center;gap:12px;margin:16px 0 18px;padding:12px 16px;border:1px solid ${RULE};border-radius:10px}.risk .cap{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:${INK3};font-weight:600}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}.box{border:1px solid ${RULE};border-radius:10px;padding:14px 18px}.box h4{margin:0 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${INK3}}
.box ol{margin:0;padding:0;list-style:none;counter-reset:i}.box li{counter-increment:i;position:relative;padding:6px 0 6px 30px;border-top:1px solid #eee}.box li:first-child{border-top:0}
.box li:before{content:counter(i);position:absolute;left:0;top:7px;width:20px;height:20px;border-radius:50%;background:${INK};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.box li.pass:before{background:${PASS}}.box li.warn:before{background:${WARN}}.box li.fail:before{background:${FAIL}}.box .pri{margin-left:6px}
ul.bul{margin:0;padding-left:18px}ul.bul li{margin:4px 0;color:${INK2}}
.note{color:${INK3};font-size:11.5px;margin-top:8px}.muted{color:${INK3}}
.chart{border:1px solid ${RULE};border-radius:10px;padding:14px 16px 10px}.spark{vertical-align:middle}
footer{margin-top:56px;color:${INK3};font-size:11.5px;border-top:1px solid ${RULE};padding-top:12px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media (max-width:720px){.page{padding:0 16px 32px}.cover{margin:0 -16px;padding:28px 16px}.headline{grid-template-columns:1fr}.chips{justify-content:flex-start}.cols{grid-template-columns:1fr}.toc ol{columns:1}.findings li{grid-template-columns:1fr}}
@media print{.page{max-width:none}.chapter{break-before:page;border-top:0}.kpi,.chart,tr,.box,.findings li{break-inside:avoid}h3{break-after:avoid}.toc{break-after:page}.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

const pill = (v: unknown, text?: string) => `<span class="pill t-${tone(v) ?? 'none'}">${esc(text ?? statusText(v))}</span>`;

function tableHtml(columns: Column[], rows: Record<string, unknown>[]) {
  const num = columns.map((c) => isNumCol(c, rows));
  return `<div class="tw"><table${columns.length > 9 ? ' class="dense"' : ''}><thead><tr>${columns.map((c, i) => `<th${num[i] ? ' class="n"' : ''}>${esc(header(c))}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c, i) => {
    const v = r[c.key];
    if (c.fmt === 'spark') return `<td>${sparkSvg(v)}</td>`;
    if (isStatus(c)) return `<td>${v ? pill(v) : '<span class="muted">—</span>'}</td>`;
    return `<td class="${num[i] ? 'n' : c.fmt === 'mono' ? 'mono' : ''}">${esc(cellText(v, c))}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function sectionBody(s: Section): string {
  switch (s.kind) {
    case 'kv': {
      const items = s.data as [string, unknown][];
      if (!items.length) return '';
      const wide = items.some(([, v]) => String(v ?? '').length > 60);
      return `<dl class="kv${wide ? ' wide' : ''}">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(cellText(v))}</dd></div>`).join('')}</dl>`;
    }
    case 'kpis':
      return `<div class="kpis">${(s.data as Kpi[]).map((k) => {
        const t = tone(k.status), d = kpiDelta(k);
        return `<div class="kpi ${t ?? ''}"><div class="l">${esc(k.label)}</div><div class="v">${k.approx && k.value != null ? '≈ ' : ''}${esc(kpiValue(k))}${k.unit && k.value != null ? `<small>${esc(k.unit)}</small>` : ''}</div><div class="d ${d?.t ?? ''}">${esc(d?.text ?? '')}${t ? ` ${pill(k.status)}` : ''}</div></div>`;
      }).join('')}</div>`;
    case 'table': { const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] }; return rows.length ? tableHtml(columns, rows) : ''; }
    case 'text': return `<p>${esc(s.data)}</p>`;
    case 'list': return (s.data as string[]).length ? `<ul class="bul">${(s.data as string[]).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    case 'findings': return (s.data as any[]).length ? `<ul class="findings">${(s.data as any[]).map((f) => `<li><div>${pill(f.severity)}</div><div><b>${esc(f.title)}</b><p>${esc(f.description)}</p></div></li>`).join('')}</ul>` : '';
    case 'chart': return `<div class="chart">${chartSvg(s.data as ChartData)}</div>`;
    case 'summary': {
      const d = s.data as SummaryData;
      return `<div class="summary">${d.paragraphs.map((p) => `<p class="lead">${esc(p)}</p>`).join('')}
<div class="risk"><span class="cap">Risk level</span>${pill(d.risk.level, d.risk.level)}<span>${esc(d.risk.reason)}</span></div>
<div class="cols"><div class="box"><h4>Key findings</h4>${d.findings.length ? `<ol>${d.findings.map((f) => `<li class="${f.tone ?? ''}">${esc(f.text)}</li>`).join('')}</ol>` : '<div class="muted">No notable findings.</div>'}</div>
<div class="box"><h4>Recommendations</h4>${d.recommendations.length ? `<ol>${d.recommendations.map((r) => `<li>${esc(r.text)}${r.priority ? `<span class="pri">${pill(r.priority, r.priority)}</span>` : ''}</li>`).join('')}</ol>` : '<div class="muted">No specific recommendations were generated by the analysis.</div>'}</div></div></div>`;
    }
    default: return '';
  }
}

export function renderHtml(c: ReportContent): string {
  const r = c.result;
  const ol = outline(c);
  const f = fonts();
  const fontCss = f ? (['R', 'S', 'B'] as const).map((k, i) => `@font-face{font-family:'Inter';font-style:normal;font-weight:${[400, 600, 700][i]};font-display:swap;src:url(data:font/woff2;base64,${f.woff[k]}) format('woff2')}`).join('') : '';
  const scoreLabel = SCORE_LABEL[c.type] ?? 'Performance score';
  const head = `<header class="cover"><div class="brand">${markSvg(30, true)}Perfmon</div>
<div class="kind">${esc(c.cover?.label ?? TYPE_NAME[c.type] ?? label(c.type))}</div><h1>${esc(c.title)}</h1><div class="subj">${esc(subjectLine(c))}</div></header>
${r ? `<div class="headline"><div class="res"><div class="cap">Result</div><span class="badge b-${tone(r.status) ?? 'none'}">${esc(label(r.status))}</span></div>
${r.score != null ? `<div class="gauge"><div class="num">${gaugeSvg(r.score)}<b>${r.score}</b></div><div class="cap">${esc(scoreLabel)}<br>${c.type === 'SLA' ? 'percent' : 'out of 100'}</div></div>` : '<div></div>'}
<div class="chips">${Object.entries(r.breakdown ?? {}).map(([k, v]) => `<span class="pill t-${tone(v) ?? 'none'}">${esc(k)}: ${esc(label(v))}</span>`).join('')}</div></div>` : ''}
<dl class="facts">${coverFacts(c).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
<div class="meta">Report ${esc(reportRef(c))} · version ${c.version} · generated ${esc(genDate(c))} · ${esc(c.confidentiality ?? SHORT_CONF)}</div>`;
  const toc = `<nav class="toc" aria-label="Contents"><h2>Contents</h2><ol>${ol.map((e) => `<li class="l${e.level}"><a href="#${esc(e.s.id)}"><span class="n">${esc(e.num)}</span>${esc(e.s.title)}</a></li>`).join('')}</ol></nav>`;
  const body = ol.map((e) => e.s.kind === 'chapter'
    ? `<section class="chapter" id="${esc(e.s.id)}"><div class="cn">${esc(e.num.padStart(2, '0'))}</div><h2>${esc(e.s.title)}</h2>${e.s.data?.intro ? `<p>${esc(e.s.data.intro)}</p>` : ''}</section>`
    : `<section class="sub" id="${esc(e.s.id)}"><h3>${e.num ? `<span class="n">${esc(e.num)}</span>` : ''}${esc(e.s.title)}</h3>${sectionBody(e.s)}${e.s.note ? `<div class="note">${esc(e.s.note)}</div>` : ''}</section>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title><style>${fontCss}${CSS}</style></head>
<body><div class="page">${head}${toc}${body}
<footer><span>Perfmon · ${esc(TYPE_NAME[c.type] ?? label(c.type))} · Report ${esc(reportRef(c))} · v${c.version}</span><span>${esc(c.confidentiality ?? SHORT_CONF)}</span></footer></div></body></html>`;
}

/* ------------------------------------------------------------------ CSV */

export function renderCsv(c: ReportContent): string {
  const out: string[] = [];
  const line = (...v: unknown[]) => out.push(v.map(csvEscape).join(','));
  line('Report', c.title); line('Type', c.type); line('Version', c.version); line('Generated', c.generatedAt); line('Subject', subjectLine(c));
  if (c.reportId) line('Report ID', c.reportId);
  if (c.result) { line('Result', c.result.status); line('Score', c.result.score); for (const [k, v] of Object.entries(c.result.breakdown ?? {})) line(`Result: ${k}`, v); }
  for (const e of outline(c)) {
    const s = e.s;
    out.push('');
    if (s.kind === 'chapter') { line(`## ${e.num} ${s.title}`); if (s.data?.intro) line(s.data.intro); continue; }
    line(`# ${e.num ? e.num + ' ' : ''}${s.title}`);
    switch (s.kind) {
      case 'kv': for (const [k, v] of s.data as [string, unknown][]) line(k, v); break;
      case 'kpis': line('Metric', 'Value', 'Unit', 'Approximate', 'Baseline', 'Change %', 'Status', 'Note'); for (const k of s.data as Kpi[]) line(k.label, k.value, k.unit ?? '', k.approx ? 'yes' : '', k.baseline, k.deltaPct, k.status ?? '', k.hint ?? ''); break;
      case 'table': {
        const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] };
        const cols = columns.filter((x) => x.fmt !== 'spark');
        line(...cols.map((x) => header(x) || x.key)); for (const r of rows) line(...cols.map((x) => r[x.key])); break;
      }
      case 'text': line(s.data); break;
      case 'list': for (const x of s.data as string[]) line(x); break;
      case 'findings': line('Severity', 'Title', 'Description'); for (const f of s.data as any[]) line(f.severity, f.title, f.description); break;
      case 'summary': {
        const d = s.data as SummaryData;
        for (const p of d.paragraphs) line(p);
        line('Risk level', d.risk.level, d.risk.reason);
        d.findings.forEach((f, i) => line(`Finding ${i + 1}`, f.text, f.tone ?? ''));
        d.recommendations.forEach((x, i) => line(`Recommendation ${i + 1}`, x.text, x.priority ?? ''));
        break;
      }
      case 'chart': {
        const ch = s.data as ChartData;
        line(ch.xType === 'time' ? 'Time' : ch.xType === 'elapsed' ? 'Elapsed (min)' : 'Category', ...ch.series.map((x) => (ch.unit ? `${x.name} (${ch.unit})` : x.name)));
        for (const x of chartXs(ch)) line(ch.xType === 'time' ? new Date(Number(x)).toISOString() : x, ...ch.series.map((se) => se.data.find((d) => d[0] === x)?.[1] ?? null));
        break;
      }
    }
    if (s.note) line(`Note: ${s.note}`);
  }
  return '﻿' + out.join('\r\n');
}
/** Union of x values across series, in order (series may have different x points). */
function chartXs(ch: ChartData) {
  const seen = new Set<number | string>(); const xs: (number | string)[] = [];
  for (const s of ch.series) for (const [x] of s.data) if (!seen.has(x)) { seen.add(x); xs.push(x); }
  return ch.xType === 'category' ? xs : xs.sort((a, b) => Number(a) - Number(b));
}

/* ------------------------------------------------------------------ Excel */

export async function renderXlsx(c: ReportContent): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Perfmon';
  wb.created = new Date(c.generatedAt);
  wb.title = c.title;
  const used = new Set<string>();
  const sheetName = (t: string) => {
    const base = t.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').slice(0, 29).trim() || 'Sheet';
    let name = base, i = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${i++}`;
    used.add(name.toLowerCase());
    return name;
  };
  const argb = (hex: string) => 'FF' + hex.slice(1).toUpperCase();
  const FONT = 'Calibri';
  const statusFont = (v: unknown) => { const t = tone(v); return t ? { name: FONT, color: { argb: argb(toneColor(t)) }, bold: true } : undefined; };
  const statusFill = (v: unknown): ExcelJS.Fill | undefined => { const t = tone(v); return t ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(TINT[t]) } } : undefined; };
  const hdr = (row: ExcelJS.Row, n: number) => { for (let i = 1; i <= n; i++) { const cl = row.getCell(i); cl.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } }; cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(INK) } }; cl.alignment = { vertical: 'middle', wrapText: true }; } row.height = 22; };
  const numFmt = (col: Column) => (col.fmt === 'int' ? '#,##0' : col.fmt === 'num1' ? '#,##0.0' : col.fmt === 'pct' ? '0.00' : col.fmt === 'delta' ? '+0.0;-0.0;0.0' : col.fmt === 'num' ? '#,##0.00' : undefined);
  const titleRows = (ws: ExcelJS.Worksheet, title: string, sub?: string) => {
    ws.addRow([title]).font = { name: FONT, bold: true, size: 14 };
    ws.addRow([sub ?? `${c.title} · v${c.version}`]).font = { name: FONT, size: 9, color: { argb: argb(INK3) } };
    ws.addRow([]);
  };
  const ol = outline(c);
  const sheetOf = new Map<string, string>();

  // Summary (cover) sheet
  const sum = wb.addWorksheet(sheetName('Summary'), { views: [{ showGridLines: false }] });
  sum.columns = [{ width: 30 }, { width: 70 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 18 }];
  sum.addRow(['PERFMON']).font = { name: FONT, bold: true, size: 10, color: { argb: argb(INK3) } };
  sum.addRow([c.title]).font = { name: FONT, bold: true, size: 18 };
  sum.addRow([`${TYPE_NAME[c.type] ?? label(c.type)} · version ${c.version} · generated ${genDate(c)}`]).font = { name: FONT, size: 10, color: { argb: argb(INK2) } };
  sum.addRow([]);
  for (const [k, v] of coverFacts(c)) { const row = sum.addRow([k, v]); row.getCell(1).font = { name: FONT, color: { argb: argb(INK2) } }; row.getCell(2).font = { name: FONT, bold: true }; }
  if (c.reportId) sum.addRow(['Report ID', c.reportId]);
  if (c.result) {
    sum.addRow([]);
    const r = sum.addRow(['Result', label(c.result.status)]); r.getCell(2).font = { ...(statusFont(c.result.status) ?? { name: FONT, bold: true }), size: 13 }; const fl = statusFill(c.result.status); if (fl) r.getCell(2).fill = fl;
    sum.addRow([SCORE_LABEL[c.type] ?? 'Performance score', c.result.score]).getCell(2).font = { name: FONT, bold: true, size: 13 };
    for (const [k, v] of Object.entries(c.result.breakdown ?? {})) { const row = sum.addRow([`   ${k}`, label(v)]); row.getCell(2).font = statusFont(v) ?? { name: FONT }; }
  }
  const details = wb.addWorksheet(sheetName('Details'), { views: [{ showGridLines: false }] });
  details.columns = [{ width: 34 }, { width: 100 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  titleRows(details, 'Report details');
  let contentsRow = 0;
  sum.addRow([]);
  contentsRow = sum.addRow(['Contents']).number; sum.getRow(contentsRow).font = { name: FONT, bold: true, size: 12 };
  const contentsLater: [string, string][] = [];

  const writeBlock = (ws: ExcelJS.Worksheet, e: Entry) => {
    const s = e.s;
    ws.addRow([]);
    ws.addRow([`${e.num} ${s.title}`.trim()]).font = { name: FONT, bold: true, size: 12 };
    if (s.kind === 'kv') for (const [k, v] of s.data as [string, unknown][]) { const row = ws.addRow([k, v as any]); row.getCell(1).font = { name: FONT, color: { argb: argb(INK2) } }; row.getCell(2).alignment = { wrapText: true, vertical: 'top' }; }
    if (s.kind === 'kpis') {
      hdr(ws.addRow(['Metric', 'Value', 'Unit', 'Baseline', 'Change %', 'Status', 'Note']), 7);
      for (const k of s.data as Kpi[]) {
        const row = ws.addRow([`${k.approx ? '≈ ' : ''}${k.label}`, k.value, k.unit ?? '', k.baseline ?? null, k.deltaPct ?? null, k.status ? label(k.status) : '', k.hint ?? '']);
        row.getCell(2).numFmt = '#,##0.##'; row.getCell(5).numFmt = '+0.0;-0.0;0.0';
        const sf = statusFont(k.status); if (sf) row.getCell(6).font = sf;
      }
    }
    if (s.kind === 'text') { const row = ws.addRow([s.data]); ws.mergeCells(row.number, 1, row.number, 2); row.alignment = { wrapText: true, vertical: 'top' }; row.height = Math.min(300, 15 * Math.ceil(String(s.data).length / 120)); }
    if (s.kind === 'list') for (const x of s.data as string[]) { const row = ws.addRow([`• ${x}`]); ws.mergeCells(row.number, 1, row.number, 2); row.alignment = { wrapText: true, vertical: 'top' }; row.height = Math.min(300, 15 * Math.ceil(x.length / 120)); }
    if (s.kind === 'findings') {
      hdr(ws.addRow(['Severity', 'Title / description']), 2);
      for (const f of s.data as any[]) { const row = ws.addRow([label(f.severity), `${f.title}\n${f.description}`]); row.getCell(1).font = statusFont(f.severity) ?? { name: FONT }; row.alignment = { wrapText: true, vertical: 'top' }; row.height = Math.min(300, 15 * (1 + Math.ceil(String(f.description).length / 110))); }
    }
    if (s.kind === 'summary') {
      const d = s.data as SummaryData;
      for (const p of d.paragraphs) { const row = ws.addRow([p]); ws.mergeCells(row.number, 1, row.number, 2); row.alignment = { wrapText: true, vertical: 'top' }; row.height = Math.min(300, 16 * Math.ceil(p.length / 110)); }
      const rr = ws.addRow(['Risk level', `${d.risk.level} — ${d.risk.reason}`]); rr.getCell(2).font = statusFont(d.risk.level) ?? { name: FONT };
      d.findings.forEach((f, i) => { const row = ws.addRow([`Finding ${i + 1}`, f.text]); row.getCell(2).alignment = { wrapText: true }; if (f.tone) row.getCell(1).font = statusFont(f.tone === 'pass' ? 'PASS' : f.tone === 'warn' ? 'WARNING' : 'FAIL')!; });
      d.recommendations.forEach((x, i) => { const row = ws.addRow([`Recommendation ${i + 1}${x.priority ? ` (${x.priority})` : ''}`, x.text]); row.getCell(2).alignment = { wrapText: true }; });
    }
    if (s.note) { const row = ws.addRow([s.note]); row.font = { name: FONT, italic: true, size: 9, color: { argb: argb(INK3) } }; ws.mergeCells(row.number, 1, row.number, 2); row.alignment = { wrapText: true }; }
  };

  for (const e of ol) {
    const s = e.s;
    if (s.kind === 'chapter') { details.addRow([]); const row = details.addRow([`${e.num}  ${s.title}`]); row.font = { name: FONT, bold: true, size: 14 }; contentsLater.push([`${e.num}  ${s.title}`, '']); continue; }
    if (s.kind === 'summary' || (s.kind === 'kpis' && !sheetOf.size && e.num.startsWith('1'))) { writeBlock(sum, e); sheetOf.set(s.id, sum.name); contentsLater.push([`      ${e.num}  ${s.title}`, sum.name]); continue; }
    if (s.kind !== 'table' && s.kind !== 'chart') { writeBlock(details, e); sheetOf.set(s.id, details.name); contentsLater.push([`      ${e.num}  ${s.title}`, details.name]); continue; }
    const ws = wb.addWorksheet(sheetName(`${e.num} ${s.title}`), { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
    sheetOf.set(s.id, ws.name); contentsLater.push([`      ${e.num}  ${s.title}`, ws.name]);
    titleRows(ws, `${e.num} ${s.title}`.trim(), s.note);
    if (s.kind === 'table') {
      const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] };
      const cols = columns.filter((x) => x.fmt !== 'spark');
      const hr = ws.addRow(cols.map((x) => header(x) || x.key)); hdr(hr, cols.length);
      rows.forEach((r, ri) => {
        const row = ws.addRow(cols.map((x) => { const v = r[x.key]; if (v == null) return null; if (x.fmt === 'date' && typeof v === 'string') return new Date(v); if (isStatus(x)) return statusText(v); return v as any; }));
        cols.forEach((x, i) => {
          const cell = row.getCell(i + 1);
          const nf = numFmt(x); if (nf) cell.numFmt = nf;
          if (x.fmt === 'date') cell.numFmt = 'yyyy-mm-dd hh:mm';
          if (ri % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(ZEBRA) } };
          if (isStatus(x)) { const f = statusFont(r[x.key]); if (f) cell.font = f; }
        });
      });
      ws.columns.forEach((cl, i) => { const x = cols[i]; if (!x) return; cl.width = Math.min(60, Math.max(10, header(x).length + 3, ...rows.slice(0, 200).map((r) => cellText(r[x.key], x).length + 2))); });
      if (rows.length) ws.autoFilter = { from: { row: hr.number, column: 1 }, to: { row: hr.number, column: cols.length } };
    } else {
      const ch = s.data as ChartData;
      const hr = ws.addRow([ch.xType === 'time' ? 'Time (UTC)' : ch.xType === 'elapsed' ? 'Elapsed (min)' : 'Category', ...ch.series.map((x) => (ch.unit ? `${x.name} (${ch.unit})` : x.name))]); hdr(hr, ch.series.length + 1);
      chartXs(ch).forEach((x, ri) => {
        const row = ws.addRow([ch.xType === 'time' ? new Date(Number(x)) : x, ...ch.series.map((se) => se.data.find((d) => d[0] === x)?.[1] ?? null)]);
        if (ch.xType === 'time') row.getCell(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
        if (ri % 2) row.eachCell((cl) => { cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(ZEBRA) } }; });
      });
      ws.columns.forEach((col, i) => { col.width = i === 0 ? 42 : Math.max(14, (ch.series[i - 1]?.name.length ?? 10) + 6); });
    }
  }
  // contents with hyperlinks
  for (const [t, sheet] of contentsLater) {
    const row = sum.addRow([t]);
    if (sheet) { row.getCell(1).value = { text: t, hyperlink: `#'${sheet}'!A1` }; row.getCell(1).font = { name: FONT, color: { argb: argb(INK2) }, underline: true }; }
    else row.getCell(1).font = { name: FONT, bold: true };
  }
  sum.addRow([]);
  sum.addRow([c.confidentiality ?? SHORT_CONF]).font = { name: FONT, italic: true, size: 9, color: { argb: argb(INK3) } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------ PDF */

/** Built-in PDF fonts are WinAnsi: replace characters they cannot encode (fallback only). */
const winAnsi = (v: unknown) => String(v ?? '').replace(/→/g, '->').replace(/≈/g, '~').replace(/Δ/g, 'Chg').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/−/g, '-').replace(/[▲▼■]/g, '').replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff–—‘’“”•…€]/g, '?');

export function renderPdf(c: ReportContent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const M = { top: 66, bottom: 62, left: 52, right: 52 };
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, autoFirstPage: true, info: { Title: c.title, Author: 'Perfmon', Subject: subjectLine(c), Creator: 'Perfmon reports' } });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const ff = fonts();
    if (ff) { doc.registerFont('R', ff.ttf.R); doc.registerFont('S', ff.ttf.S); doc.registerFont('B', ff.ttf.B); }
    else { doc.registerFont('R', 'Helvetica'); doc.registerFont('S', 'Helvetica-Bold'); doc.registerFont('B', 'Helvetica-Bold'); }
    const T = (v: unknown) => (ff ? String(v ?? '') : winAnsi(v));
    const PW = doc.page.width, PH = doc.page.height;
    const L = M.left, W = PW - M.left - M.right;
    const BOTTOM = PH - M.bottom;
    const font = (w: 'R' | 'S' | 'B' = 'R', size = 9, color = INK) => doc.font(w).fontSize(size).fillColor(color);
    /** cached string width (fonts scale linearly with size, so cache the width at size 1) */
    const wcache = new Map<string, number>();
    const mw = (t: string, tnum = false) => {
      const f = (doc as any)._font;
      const k = `${f.id ?? f.name}|${tnum ? 1 : 0}|${t}`;
      let v = wcache.get(k);
      if (v == null) { v = f.widthOfString(t, 1, tnum && ff ? ['tnum'] : undefined) as number; wcache.set(k, v); }
      return v * (doc as any)._fontSize;
    };
    /** single-line text clipped to width with an ellipsis */
    const clip = (t: string, w: number, tnum = false) => { if (mw(t, tnum) <= w + 0.05) return t; while (t.length > 1 && mw(t + '…', tnum) > w) t = t.slice(0, -1); return t + '…'; };
    const line1 = (t: string, x: number, y: number, w: number, align: 'left' | 'right' | 'center' = 'left', tnum = false) =>
      doc.text(clip(T(t), w, tnum), x, y, { width: w + 0.5, align, lineBreak: false, features: tnum && ff ? ['tnum'] : undefined } as any);
    const ensure = (h: number) => { if (doc.y + h > BOTTOM) { doc.addPage(); doc.y = M.top; } };
    const hair = (x1: number, y: number, x2: number, color = RULE, w = 0.5) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke();
    const statusPill = (v: unknown, x: number, y: number, maxW: number, size = 6.6, text?: string) => {
      const t = tone(v), s = T(text ?? statusText(v));
      font('S', size);
      const w = Math.min(maxW, doc.widthOfString(s) + size * 1.5), h = size * 1.75;
      doc.roundedRect(x, y, w, h, h / 2).fill(t ? TINT[t] : SOFT);
      font('S', size, t ? toneColor(t) : INK2);
      doc.text(clip(s, w - size * 1.2), x + size * 0.6, y + (h - size) / 2 - size * 0.05, { lineBreak: false, width: w - size * 1.2 });
      return w;
    };
    const drawMark = (x: number, y: number, size: number, onDark: boolean) => {
      const k = size / 320;
      doc.save().translate(x - 28.5 * k, y - 9 * k).scale(k);
      for (const d of MARK.bars) doc.path(d).fill(onDark ? '#c9c9cf' : '#555555');
      doc.path(MARK.band).fill(onDark ? '#f4f4f5' : INK);
      if (onDark) doc.path(MARK.fold).fillOpacity(0.35).fill('#3f3f46').fillOpacity(1);
      doc.restore();
    };
    const drawPrims = (prims: Prim[], ox: number, oy: number) => {
      for (const p of prims) {
        if (p.k === 'line') { doc.moveTo(ox + p.x1, oy + p.y1).lineTo(ox + p.x2, oy + p.y2).lineWidth(p.w).strokeColor(p.c); if (p.dash) doc.dash(p.dash[0], { space: p.dash[1] }); doc.stroke(); doc.undash(); }
        else if (p.k === 'path') { doc.moveTo(ox + p.pts[0][0], oy + p.pts[0][1]); for (const [x, y] of p.pts.slice(1)) doc.lineTo(ox + x, oy + y); doc.lineWidth(p.w).lineJoin('round').lineCap('round').strokeColor(p.c); if (p.dash) doc.dash(p.dash[0], { space: p.dash[1] }); doc.stroke(); doc.undash(); doc.lineCap('butt'); }
        else if (p.k === 'rect') doc.rect(ox + p.x, oy + p.y, p.w, p.h).fill(p.fill);
        else if (p.k === 'dot') doc.circle(ox + p.x, oy + p.y, p.r).fill(p.c);
        else {
          font(p.bold ? 'S' : 'R', p.size, p.c);
          const s = T(p.s), w = doc.widthOfString(s);
          const x = p.anchor === 'end' ? ox + p.x - w : p.anchor === 'middle' ? ox + p.x - w / 2 : ox + p.x;
          doc.text(s, x, oy + p.y, { lineBreak: false, baseline: 'alphabetic' } as any);
        }
      }
    };

    /* ---------- cover */
    const BAND = 300;
    doc.rect(0, 0, PW, BAND).fill(INK);
    drawMark(L, 46, 30, true);
    font('B', 15, '#ffffff').text('Perfmon', L + 38, 53, { lineBreak: false });
    font('S', 8.5, '#a1a1aa').text(T((c.cover?.label ?? TYPE_NAME[c.type] ?? label(c.type)).toUpperCase()), L, 150, { characterSpacing: 1.6, lineBreak: false });
    font('B', 23, '#ffffff').text(T(c.title), L, 166, { width: W, lineGap: 1, height: 90, ellipsis: true });
    font('R', 10, '#d4d4d8').text(T(subjectLine(c)), L, Math.min(doc.y + 6, BAND - 34), { width: W, height: 28, ellipsis: true });
    let y = BAND + 30;
    if (c.result) {
      font('S', 7.5, INK3).text('RESULT', L, y, { characterSpacing: 1.2 });
      const rt = tone(c.result.status), rs = T(label(c.result.status));
      font('B', 14); const rw = doc.widthOfString(rs) + 26;
      doc.roundedRect(L, y + 14, rw, 28, 14).fill(rt ? TINT[rt] : SOFT);
      font('B', 14, rt ? toneColor(rt) : INK2).text(rs, L + 13, y + 20.5, { lineBreak: false });
      if (c.result.score != null) {
        const cx = L + Math.max(rw, 120) + 70, cy = y + 28, r = 26;
        doc.circle(cx, cy, r).lineWidth(6).strokeColor('#e6e6e6').stroke();
        const p = Math.max(0, Math.min(100, c.result.score)) / 100;
        if (p >= 0.999) doc.circle(cx, cy, r).lineWidth(6).strokeColor(INK).stroke();
        else if (p > 0) { const a = -Math.PI / 2 + p * 2 * Math.PI; doc.path(`M ${cx} ${cy - r} A ${r} ${r} 0 ${p > 0.5 ? 1 : 0} 1 ${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`).lineWidth(6).lineCap('round').strokeColor(INK).stroke(); doc.lineCap('butt'); }
        font('B', 15, INK); line1(String(c.result.score), cx - r, cy - 8, 2 * r, 'center', true);
        font('S', 7.5, INK3).text(T((SCORE_LABEL[c.type] ?? 'Performance score').toUpperCase()), cx + r + 14, cy - 10, { characterSpacing: 1.1, lineBreak: false });
        font('R', 8, INK2).text(c.type === 'SLA' ? 'percent of evaluations' : 'out of 100', cx + r + 14, cy + 2, { lineBreak: false });
      }
      // breakdown chips (wrap)
      let cx = L, cy = y + 66;
      for (const [k, v] of Object.entries(c.result.breakdown ?? {})) {
        font('S', 7); const w = doc.widthOfString(T(`${k}: ${label(v)}`)) + 12;
        if (cx + w > L + W) { cx = L; cy += 17; }
        statusPill(v, cx, cy, w, 7, `${k}: ${label(v)}`);
        cx += w + 6;
      }
      y = cy + 36;
    }
    // facts grid (2 columns)
    const facts = coverFacts(c);
    const colW = (W - 24) / 2;
    facts.forEach(([k, v], i) => {
      const x = L + (i % 2) * (colW + 24), fy = y + Math.floor(i / 2) * 26;
      font('R', 7.5, INK3).text(T(k.toUpperCase()), x, fy, { characterSpacing: 0.8, lineBreak: false });
      font('S', 10, INK); line1(v, x, fy + 10, colW);
      hair(x, fy + 23, x + colW);
    });
    // at a glance: first KPI row of the report
    const glance = (c.sections.find((s) => s.kind === 'kpis')?.data as Kpi[] | undefined)?.filter((k) => k.value != null).slice(0, 4) ?? [];
    if (glance.length) {
      const gy = y + Math.ceil(facts.length / 2) * 26 + 26, gw = W / glance.length;
      font('S', 7.5, INK3).text('AT A GLANCE', L, gy, { characterSpacing: 1.2, lineBreak: false });
      glance.forEach((k, i) => {
        const x = L + i * gw;
        if (i) doc.moveTo(x, gy + 18).lineTo(x, gy + 58).lineWidth(0.5).strokeColor(RULE).stroke();
        const px = x + (i ? 14 : 0);
        font('R', 7.5, INK2); line1(k.label, px, gy + 20, gw - 20);
        const val = `${k.approx ? '≈ ' : ''}${kpiValue(k)}`;
        font('B', 17, INK); line1(val, px, gy + 32, gw - 20, 'left', true);
        const vw = mw(T(val), true);
        if (k.unit) { font('R', 8.5, INK3); line1(k.unit, px + vw + 3, gy + 39.5, Math.max(10, gw - 24 - vw)); }
      });
    }
    // cover footer
    font('R', 7.5, INK3).text(T(`Report ${reportRef(c)} · version ${c.version} · generated ${genDate(c)}`), L, PH - 92, { width: W, lineBreak: false });
    font('R', 7.5, INK3).text(T(c.confidentiality ?? SHORT_CONF), L, PH - 80, { width: W, height: 22 });
    doc.rect(0, PH - 10, PW, 10).fill(INK);

    /* ---------- table of contents (reserved now, filled at the end) */
    const ol = outline(c);
    const tocLines = ol.map((e) => (e.level === 1 ? 24 : 15.5));
    const tocAvail = BOTTOM - M.top - 56;
    let tocPages = 1, acc = 0;
    for (const h of tocLines) { if (acc + h > tocAvail) { tocPages++; acc = 0; } acc += h; }
    const tocStart = 1;
    for (let i = 0; i < tocPages; i++) doc.addPage();
    const pageOf = new Map<string, number>();

    /* ---------- blocks */
    const heading = (e: Entry, keep: number) => {
      ensure(30 + keep);
      doc.y += 6;
      const yy = doc.y;
      (doc as any).addNamedDestination(e.s.id);
      pageOf.set(e.s.id, doc.bufferedPageRange().start + doc.bufferedPageRange().count);
      let x = L;
      if (e.num) { font('S', 11.5, INK3); doc.text(e.num, L, yy, { lineBreak: false }); x = L + Math.max(28, doc.widthOfString(e.num) + 10); }
      font('S', 11.5, INK).text(T(e.s.title), x, yy, { width: L + W - x });
      doc.y = Math.max(doc.y, yy + 15) + 6;
    };
    const chapterStart = (e: Entry) => {
      doc.addPage(); doc.y = M.top;
      (doc as any).addNamedDestination(e.s.id);
      pageOf.set(e.s.id, doc.bufferedPageRange().count);
      doc.outline.addItem(T(`${e.num}  ${e.s.title}`));
      font('B', 34, '#d0d0d0').text(e.num.padStart(2, '0'), L, M.top + 6, { lineBreak: false });
      font('B', 21, INK).text(T(e.s.title), L, M.top + 50, { width: W });
      if (e.s.data?.intro) font('R', 10, INK2).text(T(e.s.data.intro), L, doc.y + 6, { width: W * 0.86, lineGap: 2.5 });
      const ry = doc.y + 12;
      doc.rect(L, ry, 36, 2.2).fill(INK);
      doc.y = ry + 20;
    };

    const kvBlock = (items: [string, unknown][]) => {
      const colW2 = (W - 24) / 2;
      font('S', 8.2);
      const wide = items.some(([k, v]) => mw(T(cellText(v))) > colW2 * 0.6 - 4 || (font('R', 8.2), mw(T(k))) > colW2 * 0.4 - 4);
      let i = 0;
      while (i < items.length) {
        const [k, v] = items[i];
        const vs = T(cellText(v));
        font('R', 8.2);
        if (wide) { // full-width, wrapping rows
          const lw = Math.min(170, W * 0.32), vw = W - lw - 8;
          const h = Math.max(12, doc.heightOfString(vs, { width: vw, lineGap: 1.5 })) + 7;
          ensure(h);
          const yy = doc.y;
          font('R', 8.2, INK2); line1(k, L, yy, lw - 6);
          font('R', 8.2, INK).text(vs, L + lw, yy, { width: vw, lineGap: 1.5 });
          hair(L, yy + h - 3, L + W);
          doc.y = yy + h; i++;
          continue;
        }
        ensure(16);
        const yy = doc.y;
        for (let j = 0; j < 2 && i < items.length; j++) {
          const [kk, vv] = items[i]; const s2 = T(cellText(vv));
          const x = L + j * (colW2 + 24);
          font('R', 8.2, INK2); line1(kk, x, yy, colW2 * 0.4);
          font('S', 8.2, INK); line1(s2, x + colW2 * 0.4, yy, colW2 * 0.6, 'right');
          hair(x, yy + 12.5, x + colW2);
          i++;
        }
        doc.y = yy + 16;
      }
      doc.x = L;
    };

    const kpiBlock = (ks: Kpi[]) => {
      const per = 4, gap = 8, bw = (W - gap * (per - 1)) / per, bh = 60;
      for (let i = 0; i < ks.length; i += per) {
        ensure(bh + gap);
        const yy = doc.y;
        ks.slice(i, i + per).forEach((k, j) => {
          const x = L + j * (bw + gap), t = tone(k.status);
          doc.roundedRect(x, yy, bw, bh, 5).lineWidth(0.6).strokeColor(RULE).stroke();
          doc.save().roundedRect(x, yy, bw, bh, 5).clip().rect(x, yy, bw, 2.6).fill(t ? toneColor(t) : INK).restore();
          font('S', 6.6, INK2); line1(k.label.toUpperCase(), x + 9, yy + 10, bw - 18 - (t ? 10 : 0));
          if (t) doc.circle(x + bw - 11, yy + 13.3, 3).fill(toneColor(t));
          const val = `${k.approx && k.value != null ? '≈ ' : ''}${kpiValue(k)}`;
          font('B', 15.5, INK); const vw = Math.min(mw(T(val), true), bw - 18);
          line1(val, x + 9, yy + 22, bw - 18, 'left', true);
          if (k.unit && k.value != null && vw + 6 < bw - 26) { font('R', 8, INK3); line1(k.unit, x + 9 + vw + 3, yy + 29.5, bw - 18 - vw - 3); }
          const d = kpiDelta(k);
          if (d) { font('R', 6.9, d.t ? toneColor(d.t) : INK3); line1(d.text, x + 9, yy + 44, bw - 18, 'left', true); }
        });
        doc.y = yy + bh + gap;
      }
      doc.x = L;
    };

    const tableBlock = (columns: Column[], rows: Record<string, unknown>[]) => {
      const num = columns.map((col) => isNumCol(col, rows));
      const sample = rows.slice(0, 80);
      const fixed = columns.map((col, i) => num[i] || isStatus(col) || col.fmt === 'spark' || col.fmt === 'date');
      const bold0 = (i: number) => i === 0 && !num[0];
      const unit = (fn: 'R' | 'S', t: string, tnum = false) => { font(fn, 1); return mw(t, tnum); };
      const words = (t: string) => t.split(/\s+/).filter(Boolean);
      const hdrWord = columns.map((col) => Math.max(0, ...words(T(header(col))).map((w) => unit('S', w))));
      const hdrFull = columns.map((col) => unit('S', T(header(col))));
      const content = columns.map((col, i) => col.fmt === 'spark' ? 0 : Math.max(0, ...sample.map((r) => { const t = T(cellText(r[col.key], col)); return isStatus(col) ? unit('S', t) * 0.9 + 1.6 : unit(bold0(i) ? 'S' : 'R', t, num[i]); })));
      const longWord = columns.map((col, i) => (fixed[i] ? 0 : Math.min(14, Math.max(0, ...sample.map((r) => Math.max(0, ...words(T(cellText(r[col.key], col))).map((w) => unit(bold0(i) ? 'S' : 'R', w))))))));
      let fs = columns.length > 11 ? 7 : columns.length > 8 ? 7.3 : 7.6;
      let widths: number[] = [];
      for (; ; fs = Math.round((fs - 0.3) * 10) / 10) {
        const pad = fs * 1.3;
        const hd = columns.map((_, i) => Math.max(hdrWord[i], hdrFull[i] * (words(T(header(columns[i]))).length > 2 ? 0.62 : 0.5)) * fs + 1.5);
        const fw = columns.map((col, i) => (!fixed[i] ? 0 : col.fmt === 'spark' ? Math.max(64, hd[i] + pad) : Math.max(content[i] * fs, hd[i]) + pad));
        const fmin = columns.map((_, i) => (fixed[i] ? 0 : Math.max(longWord[i] * fs, hd[i], 34) + pad));
        const fwant = columns.map((_, i) => (fixed[i] ? 0 : Math.max(fmin[i], Math.min(content[i] * fs + pad, 260))));
        const fixedSum = fw.reduce((x, y) => x + y, 0);
        const room = W - fixedSum;
        const minSum = fmin.reduce((x, y) => x + y, 0), wantSum = fwant.reduce((x, y) => x + y, 0);
        if (room >= minSum || fs <= 5.6) {
          if (room >= minSum) {
            const extra = room - minSum, span = Math.max(1e-6, wantSum - minSum);
            widths = columns.map((_, i) => (fixed[i] ? fw[i] : fmin[i] + (wantSum <= room ? fwant[i] - fmin[i] + (room - wantSum) * (fwant[i] / Math.max(1e-6, wantSum)) : (extra * (fwant[i] - fmin[i])) / span)));
            if (!fwant.some((x) => x > 0)) { const left = W - widths.reduce((x, y) => x + y, 0); widths = widths.map((w) => w + left / widths.length); }
          } else { const all = fw.map((w, i) => w || fmin[i]); const t = all.reduce((x, y) => x + y, 0); widths = all.map((w) => (w * W) / t); }
          break;
        }
      }
      const pad = fs * 0.65, lineH = fs * 1.25;
      font('S', fs);
      const hLines = Math.min(2, Math.max(...columns.map((col, i) => (mw(T(header(col))) <= widths[i] - 2 * pad ? 1 : 2))));
      const headH = hLines * lineH + fs * 1.1;
      const drawHeader = () => {
        const yy = doc.y;
        doc.rect(L, yy, W, headH).fill(SOFT);
        let x = L;
        columns.forEach((col, i) => {
          font('S', fs, INK2).text(T(header(col)), x + pad, yy + fs * 0.6, { width: widths[i] - 2 * pad, height: hLines * lineH + 1, align: num[i] ? 'right' : 'left', lineGap: lineH - doc.currentLineHeight(), ellipsis: true });
          x += widths[i];
        });
        hair(L, yy + headH, L + W, '#c8c8c8', 0.7);
        doc.y = yy + headH;
      };
      ensure(headH + 3 * (fs + 8));
      drawHeader();
      rows.forEach((r, ri) => {
        const lines = columns.map((col, i) => {
          if (fixed[i]) return 1;
          const t = T(cellText(r[col.key], col));
          font(bold0(i) ? 'S' : 'R', fs);
          if (mw(t) <= widths[i] - 2 * pad) return 1;
          return Math.min(3, Math.max(1, Math.round(doc.heightOfString(t, { width: widths[i] - 2 * pad }) / doc.currentLineHeight())));
        });
        const rowH = Math.max(...lines) * lineH + fs * 0.95 + (columns.some(isStatus) ? 1.5 : 0);
        if (doc.y + rowH > BOTTOM) { doc.addPage(); doc.y = M.top; drawHeader(); }
        const yy = doc.y;
        if (ri % 2) doc.rect(L, yy, W, rowH).fill(ZEBRA);
        let x = L;
        columns.forEach((col, i) => {
          const v = r[col.key];
          const ty = yy + (rowH - Math.max(...lines) * lineH) / 2 + (lineH - fs) / 2 - fs * 0.05;
          if (col.fmt === 'spark') {
            const vals = (Array.isArray(v) ? v : []).map((q) => (typeof q === 'number' ? q : null));
            const pts = vals.map((q, k) => [k, q] as [number, number | null]).filter((p): p is [number, number] => p[1] != null);
            if (pts.length > 1) {
              const sw = widths[i] - 2 * pad, sh = rowH - 5, mx = Math.max(...pts.map((p) => p[1])), mn = Math.min(...pts.map((p) => p[1]));
              const px = (k: number) => x + pad + (k / (vals.length - 1)) * sw, py = (q: number) => yy + 2.5 + sh - (mx === mn ? 0.5 : (q - mn) / (mx - mn)) * sh;
              doc.moveTo(px(pts[0][0]), py(pts[0][1])); for (const [k, q] of pts.slice(1)) doc.lineTo(px(k), py(q));
              doc.lineWidth(0.8).lineJoin('round').strokeColor(INK).stroke();
              const lp = pts[pts.length - 1]; doc.circle(px(lp[0]), py(lp[1]), 1.3).fill(INK);
            } else { font('R', fs, INK3).text('—', x + pad, ty, { lineBreak: false }); }
          } else if (isStatus(col)) {
            if (v) statusPill(v, x + pad, yy + (rowH - fs * 0.9 * 1.75) / 2, widths[i] - 2 * pad, fs * 0.9);
            else font('R', fs, INK3).text('—', x + pad, ty, { lineBreak: false });
          } else {
            const s = T(cellText(v, col));
            font(bold0(i) ? 'S' : 'R', fs, v == null || v === '' ? INK3 : INK);
            if (lines[i] > 1) doc.text(s, x + pad, ty, { width: widths[i] - 2 * pad, height: lines[i] * lineH + 0.5, lineGap: lineH - doc.currentLineHeight(), ellipsis: true });
            else line1(s, x + pad, ty, widths[i] - 2 * pad, num[i] ? 'right' : 'left', num[i]);
          }
          x += widths[i];
        });
        doc.y = yy + rowH;
        hair(L, doc.y, L + W, '#ececec', 0.4);
      });
      doc.x = L;
    };

    const chartBlock = (ch: ChartData) => {
      const { h, prims } = chartPrims(ch, W, 6.8);
      ensure(h + 8);
      const top = doc.y;
      drawPrims(prims, L, top);
      doc.x = L; doc.y = top + h + 6;
    };

    const para = (s: string, size = 9.4, color = INK) => { font('R', size); const h = doc.heightOfString(T(s), { width: W, lineGap: 2.6 }); ensure(Math.min(h, 60)); font('R', size, color).text(T(s), L, doc.y, { width: W, lineGap: 2.6 }); doc.y += 5; };

    const numberedList = (title: string, items: { text: string; tone?: Tone; pri?: string | null }[], x: number, y0: number, w: number, dry: boolean) => {
      let yy = y0;
      if (!dry) font('S', 7.2, INK3).text(title.toUpperCase(), x, yy, { characterSpacing: 1.1, lineBreak: false });
      yy += 16;
      if (!items.length) { if (!dry) font('R', 8.6, INK3).text('None.', x, yy, { width: w }); return yy + 14 - y0; }
      items.forEach((it, i) => {
        font('R', 8.6);
        const priW = it.pri ? 0 : 0;
        const th = doc.heightOfString(T(it.text), { width: w - 22 - priW, lineGap: 1.8 });
        if (!dry) {
          doc.circle(x + 7, yy + 6, 7).fill(it.tone ? toneColor(it.tone) : INK);
          font('B', 7.5, '#ffffff'); line1(String(i + 1), x, yy + 2.6, 14, 'center');
          font('R', 8.6, INK).text(T(it.text), x + 22, yy, { width: w - 22, lineGap: 1.8 });
          if (it.pri) statusPill(it.pri, x + 22, yy + th + 3, 60, 6.2, it.pri);
        }
        yy += th + (it.pri ? 16 : 6) + 4;
      });
      return yy - y0;
    };

    const summaryBlock = (d: SummaryData) => {
      for (const p of d.paragraphs) para(p, 10.2);
      doc.y += 4;
      ensure(36);
      const ry = doc.y;
      doc.roundedRect(L, ry, W, 30, 6).lineWidth(0.6).strokeColor(RULE).stroke();
      font('S', 7, INK3).text('RISK LEVEL', L + 12, ry + 11.5, { characterSpacing: 1.1, lineBreak: false });
      const pw = statusPill(d.risk.level, L + 78, ry + 8.5, 80, 7.4, d.risk.level);
      font('R', 8.6, INK2); line1(d.risk.reason, L + 78 + pw + 10, ry + 10.5, W - (78 + pw + 22));
      doc.y = ry + 44;
      const cw = (W - 16) / 2;
      const f = d.findings.map((x) => ({ text: x.text, tone: x.tone ?? null }));
      const r = d.recommendations.map((x) => ({ text: x.text, tone: null as Tone, pri: x.priority }));
      const h = Math.max(numberedList('Key findings', f, 0, 0, cw - 24, true), numberedList('Recommendations', r, 0, 0, cw - 24, true)) + 22;
      if (h < BOTTOM - M.top - 20) {
        ensure(h);
        const by = doc.y;
        doc.roundedRect(L, by, cw, h, 6).lineWidth(0.6).strokeColor(RULE).stroke();
        doc.roundedRect(L + cw + 16, by, cw, h, 6).lineWidth(0.6).strokeColor(RULE).stroke();
        numberedList('Key findings', f, L + 12, by + 12, cw - 24, false);
        numberedList('Recommendations', r, L + cw + 28, by + 12, cw - 24, false);
        doc.y = by + h + 4;
      } else {
        for (const [t, items] of [['Key findings', f], ['Recommendations', r]] as const) { const hh = numberedList(t, items, 0, 0, W, true); ensure(Math.min(hh, 200)); const by = doc.y; numberedList(t, items, L, by, W, false); doc.y = by + hh + 8; }
      }
      doc.x = L;
    };

    const findingsBlock = (fs: any[]) => {
      for (const f of fs) {
        font('S', 8.8); const th = doc.heightOfString(T(f.title), { width: W - 92 });
        font('R', 8.3); const dh = doc.heightOfString(T(f.description), { width: W - 92, lineGap: 1.6 });
        ensure(th + dh + 14);
        const yy = doc.y;
        statusPill(f.severity, L, yy + 0.5, 82, 6.6);
        font('S', 8.8, INK).text(T(f.title), L + 92, yy, { width: W - 92 });
        font('R', 8.3, INK2).text(T(f.description), L + 92, doc.y + 1.5, { width: W - 92, lineGap: 1.6 });
        doc.y += 6; hair(L, doc.y, L + W); doc.y += 6;
      }
      doc.x = L;
    };

    const listBlock = (items: string[]) => {
      for (const x of items) {
        font('R', 8.8); const h = doc.heightOfString(T(x), { width: W - 14, lineGap: 2 });
        ensure(Math.min(h, 40) + 4);
        const yy = doc.y;
        doc.circle(L + 3, yy + 4.6, 1.6).fill(INK2);
        font('R', 8.8, INK).text(T(x), L + 14, yy, { width: W - 14, lineGap: 2 });
        doc.y += 4;
      }
      doc.x = L;
    };

    const keepWith = (s: Section) => s.kind === 'chart' ? chartPrims(s.data as ChartData, W, 6.8).h + 8 : s.kind === 'kpis' ? 68 : s.kind === 'table' ? 52 : s.kind === 'summary' ? 120 : s.kind === 'findings' ? 40 : 28;

    // First page after the TOC: chapters start their own pages; legacy reports start a page here.
    if (!ol.some((e) => e.level === 1)) { doc.addPage(); doc.y = M.top; }
    for (const e of ol) {
      const s = e.s;
      if (s.kind === 'chapter') { chapterStart(e); continue; }
      heading(e, keepWith(s));
      switch (s.kind) {
        case 'kv': kvBlock(s.data as [string, unknown][]); break;
        case 'kpis': kpiBlock(s.data as Kpi[]); break;
        case 'table': { const { columns, rows } = s.data as { columns: Column[]; rows: Record<string, unknown>[] }; if (rows.length) tableBlock(columns, rows); break; }
        case 'text': para(String(s.data)); break;
        case 'list': listBlock(s.data as string[]); break;
        case 'findings': findingsBlock(s.data as any[]); break;
        case 'chart': chartBlock(s.data as ChartData); break;
        case 'summary': summaryBlock(s.data as SummaryData); break;
      }
      if (s.note) { font('R', 7.4); const h = doc.heightOfString(T(s.note), { width: W, lineGap: 1.4 }); ensure(h + 6); font('R', 7.4, INK3).text(T(s.note), L, doc.y + 4, { width: W, lineGap: 1.4 }); }
      doc.y += 10;
    }

    /* ---------- TOC fill */
    const range = doc.bufferedPageRange();
    let tp = tocStart, ty = M.top;
    doc.switchToPage(tp);
    font('B', 21, INK).text('Contents', L, ty, { lineBreak: false });
    ty += 44;
    ol.forEach((e) => {
      const h = e.level === 1 ? 24 : 15.5;
      if (ty + h > BOTTOM - 4) { tp++; doc.switchToPage(tp); ty = M.top; }
      const pg = String(pageOf.get(e.s.id) ?? '');
      if (e.level === 1) {
        ty += 6;
        font('B', 10.5, INK3); doc.text(e.num.padStart(2, '0'), L, ty, { lineBreak: false });
        font('S', 10.5, INK); const tw = Math.min(doc.widthOfString(T(e.s.title)), W - 90);
        line1(e.s.title, L + 30, ty, W - 90);
        font('S', 10.5, INK); line1(pg, L + W - 40, ty, 40, 'right', true);
        if (pageOf.has(e.s.id)) (doc as any).goTo(L, ty - 2, W, 16, e.s.id);
        hair(L + 30 + tw + 8, ty + 9, L + W - 46, '#cfcfcf', 0.4);
        ty += h - 6;
      } else {
        font('R', 8.8, INK3); doc.text(e.num, L + 30, ty, { lineBreak: false });
        font('R', 8.8, INK2); const tw = Math.min(doc.widthOfString(T(e.s.title)), W - 120);
        line1(e.s.title, L + 62, ty, W - 120);
        font('R', 8.8, INK3); line1(pg, L + W - 40, ty, 40, 'right', true);
        doc.save(); doc.moveTo(L + 62 + tw + 6, ty + 7.5).lineTo(L + W - 46, ty + 7.5).lineWidth(0.6).dash(0.6, { space: 2.4 }).strokeColor('#bdbdbd').stroke(); doc.undash(); doc.restore();
        if (pageOf.has(e.s.id)) (doc as any).goTo(L + 30, ty - 2, W - 30, 13, e.s.id);
        ty += h;
      }
    });

    /* ---------- running header / footer on every page but the cover */
    for (let i = range.start + 1; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      drawMark(L, 28, 11, false);
      font('S', 8, INK).text('Perfmon', L + 15, 29.5, { lineBreak: false });
      font('R', 7.4, INK3); line1(c.title, L + W * 0.3, 30.5, W * 0.7, 'right');
      hair(L, 46, L + W, RULE, 0.6);
      const fy = PH - 40;
      hair(L, fy - 8, L + W, RULE, 0.6);
      font('R', 7, INK3); line1(`Report ${reportRef(c)} · v${c.version} · ${genDate(c)}`, L, fy, W * 0.36);
      line1(SHORT_CONF, L + W * 0.3, fy, W * 0.4, 'center');
      font('S', 7, INK2); line1(`Page ${i - range.start + 1} of ${range.count}`, L + W * 0.7, fy, W * 0.3, 'right', true);
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
  });
}
