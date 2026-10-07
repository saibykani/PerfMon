import type { EChartsOption } from 'echarts';
import { LANES, cssVar, typeMeta, fmtSpan, type FeedRow } from './meta';

const SEV_SYMBOL: Record<string, string> = { CRITICAL: 'diamond', WARNING: 'triangle', INFO: 'circle' };
const SEV_LABEL: Record<string, string> = { CRITICAL: 'Critical', WARNING: 'Warning', INFO: 'Info' };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtTs = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Run spans built from TEST_START / TEST_END pairs (same run). */
export function runSpans(rows: FeedRow[]) {
  const m = new Map<string, { runKey: string; start?: number; end?: number }>();
  for (const r of rows) {
    if (r.kind !== 'event' || !r.runKey || (r.type !== 'TEST_START' && r.type !== 'TEST_END')) continue;
    const s = m.get(r.runKey) ?? { runKey: r.runKey };
    if (r.type === 'TEST_START') s.start = Math.min(s.start ?? Infinity, r.ts);
    else s.end = Math.max(s.end ?? -Infinity, r.ts);
    m.set(r.runKey, s);
  }
  return [...m.values()].filter((s) => s.start != null && s.end != null && s.end >= s.start) as { runKey: string; start: number; end: number }[];
}

/**
 * Swim-lane timeline: one category row per lane, events as severity-shaped markers,
 * test runs as bars (start → end), annotations as accent markers + vertical guides / shaded windows.
 * All colours come from the theme's CSS tokens.
 */
export function timelineOption(rows: FeedRow[], opts: { from?: number; to?: number; theme: string }): EChartsOption {
  void opts.theme; // re-evaluated when the theme changes (tokens are read at build time)
  const color = {
    fail: cssVar('--fail'), warn: cssVar('--warn'), info: cssVar('--text-2'), accent: cssVar('--accent'), text: cssVar('--text'),
    text2: cssVar('--text-2'), text3: cssVar('--text-3'), border: cssVar('--border'), surface: cssVar('--surface'), run: cssVar('--text-3'),
  };
  const sevColor = (s: string) => (s === 'CRITICAL' ? color.fail : s === 'WARNING' ? color.warn : color.info);
  const lanes = [...LANES];
  const point = (r: FeedRow, i: number) => ({ value: [r.ts, typeMeta(r.type).lane, i] });

  const idx = new Map(rows.map((r, i) => [r.key, i]));
  const events = rows.filter((r) => r.kind === 'event');
  const anns = rows.filter((r) => r.kind === 'annotation');
  const spans = runSpans(rows);

  // Fit the axis to the data (with padding) inside the selected range, so clustered activity stays readable.
  const times = rows.flatMap((r) => (r.tsEnd ? [r.ts, r.tsEnd] : [r.ts]));
  let min = opts.from, max = opts.to;
  if (times.length) {
    const lo = Math.min(...times), hi = Math.max(...times);
    const pad = Math.max((hi - lo) * 0.06, 15 * 60e3);
    min = Math.max(opts.from ?? -Infinity, lo - pad);
    max = Math.min(opts.to ?? Infinity, hi + pad);
    if (!(max > min)) { min = lo - pad; max = hi + pad; }
  }

  const sevSeries = (['CRITICAL', 'WARNING', 'INFO'] as const).map((sev) => ({
    type: 'scatter', name: SEV_LABEL[sev], symbol: SEV_SYMBOL[sev], symbolSize: sev === 'INFO' ? 8 : 11, z: 4, cursor: 'pointer',
    itemStyle: { color: sevColor(sev), borderColor: color.surface, borderWidth: 1 },
    data: events.filter((r) => r.severity === sev).map((r) => point(r, idx.get(r.key)!)),
  }));

  // Annotations: markers on their lane + a guide line (point) or shaded window (range) across all lanes.
  const guides = anns.slice(0, 60);
  const annSeries = {
    type: 'scatter', name: 'Annotation', symbol: 'pin', symbolSize: 18, symbolOffset: [0, -4], z: 5, cursor: 'pointer',
    itemStyle: { color: color.accent },
    data: anns.map((r) => point(r, idx.get(r.key)!)),
    markLine: {
      symbol: 'none', silent: true, animation: false,
      label: { show: false },
      lineStyle: { color: color.accent, type: 'dashed', width: 1, opacity: 0.55 },
      data: guides.filter((r) => !r.tsEnd).map((r) => ({ xAxis: r.ts })),
    },
    markArea: {
      silent: true, animation: false,
      itemStyle: { color: color.accent, opacity: 0.08 },
      data: guides.filter((r) => r.tsEnd).map((r) => [{ xAxis: r.ts }, { xAxis: r.tsEnd! }]),
    },
  };

  // Run bars: one tiny line series per run (break-free segments on the "Test runs" lane).
  const runSeries = spans.map((s) => ({
    type: 'line', name: s.runKey, silent: false, showSymbol: false, z: 3,
    lineStyle: { width: 6, color: color.run, opacity: 0.45, cap: 'round' },
    emphasis: { lineStyle: { width: 8, opacity: 0.8 } },
    tooltip: { show: true },
    data: [[s.start, 'Test runs', -1, s.runKey, s.end - s.start], [s.end, 'Test runs', -1, s.runKey, s.end - s.start]],
  }));

  return {
    animation: false,
    legend: { show: true, data: [{ name: 'Critical', icon: 'diamond' }, { name: 'Warning', icon: 'triangle' }, { name: 'Info', icon: 'circle' }, { name: 'Annotation', icon: 'pin' }], top: 0, left: 0, itemWidth: 10, itemHeight: 10 },
    grid: { left: 8, right: 18, top: 30, bottom: 38, containLabel: true },
    tooltip: {
      trigger: 'item', confine: true, axisPointer: { type: 'none' },
      formatter: (p: any) => {
        const v = p.value ?? p.data?.value ?? p.data;
        if (!Array.isArray(v)) return '';
        if (v[2] === -1) return `<b>${esc(String(v[3]))}</b><br/>Test run · ${fmtSpan(Number(v[4]))}<br/><span style="opacity:.7">click to open</span>`;
        const r = rows[v[2]];
        if (!r) return '';
        const m = typeMeta(r.type);
        const when = r.tsEnd ? `${fmtTs(r.ts)} → ${fmtTs(r.tsEnd)}` : fmtTs(r.ts);
        const sev = r.kind === 'event' ? ` · ${SEV_LABEL[r.severity] ?? r.severity}` : '';
        return `<b>${esc(r.title)}</b><br/>${esc(m.label)}${sev}${r.runKey ? ` · ${esc(r.runKey)}` : ''}<br/><span style="opacity:.7">${when}</span>`;
      },
    },
    xAxis: { type: 'time', min, max, axisLabel: { hideOverlap: true }, splitLine: { show: true, lineStyle: { color: color.border, opacity: 0.6 } } },
    yAxis: {
      type: 'category', data: lanes, inverse: true, axisLabel: { color: color.text2, fontSize: 11 }, axisTick: { show: false }, axisLine: { show: false },
      splitLine: { show: true, lineStyle: { color: color.border, opacity: 0.6 } },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'shift', moveOnMouseMove: true },
      { type: 'slider', xAxisIndex: 0, height: 16, bottom: 6, showDetail: false, borderColor: color.border, fillerColor: 'transparent', handleStyle: { color: color.surface, borderColor: color.text3 }, dataBackground: { lineStyle: { color: color.border }, areaStyle: { color: color.border } } },
    ],
    series: [...runSeries, ...sevSeries, annSeries] as any,
  };
}
