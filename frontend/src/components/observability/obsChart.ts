import type { EChartsOption } from 'echarts';
import { CHROME, seriesColor } from '@/charts/palette';
import { unitFormatter } from '@/charts/builders';
import type { MetricDef, ObsMarker, ObsSeries } from './obsApi';
import { axisLabel, formatTs, type Tz } from './obsTime';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Units understood by the shared formatter; others are appended verbatim. */
export function formatValue(v: number | null | undefined, unit?: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (unit === 'ms' || unit === '%' || unit === 'MB') return unitFormatter(unit)(v);
  const n = Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : `${+v.toFixed(2)}`;
  return unit ? `${n} ${unit}` : n;
}

export function seriesName(s: ObsSeries, defs: Record<string, MetricDef>, multiMetric: boolean): string {
  const m = defs[s.metric]?.label ?? s.metric;
  if (!s.label || s.label === 'all' || s.entityId == null) return multiMetric ? m : s.label || m;
  return multiMetric ? `${s.label} · ${m}` : s.label;
}

/**
 * Time-series option for an Observability panel: exact window on the x axis, timezone-aware
 * labels and tooltips, null buckets rendered as gaps, run bands + event lines, lineX brush
 * for drag-to-zoom (wired by the panel).
 */
export function obsSeriesOption(o: {
  theme: 'light' | 'dark'; series: ObsSeries[]; defs: Record<string, MetricDef>; markers?: ObsMarker[]; tz: Tz; from: number; to: number;
}): EChartsOption {
  const c = CHROME[o.theme];
  const units = [...new Set(o.series.map((s) => s.unit ?? o.defs[s.metric]?.unit ?? ''))];
  const unit = units.length === 1 ? units[0] : undefined;
  const multiMetric = new Set(o.series.map((s) => s.metric)).size > 1;
  const span = o.to - o.from;
  const runs = (o.markers ?? []).filter((m) => m.kind === 'run');
  const lines = (o.markers ?? []).filter((m) => m.kind !== 'run');
  const markArea = runs.length ? {
    silent: false, itemStyle: { color: c.muted, opacity: 0.1 }, label: { show: true, position: 'insideTopLeft', color: c.ink2, fontSize: 10 },
    emphasis: { itemStyle: { opacity: 0.18 } },
    data: runs.map((m) => {
      const start = +new Date(m.ts);
      const end = Math.min(m.endTs ? +new Date(m.endTs) : o.to, o.to);
      // label only bands that start inside the window and are wide enough (avoids stacked labels)
      const showLabel = start >= o.from && (end - start) / span > 0.12;
      return [{ xAxis: Math.max(start, o.from), name: m.label, href: m.href, label: { show: showLabel } }, { xAxis: end }];
    }),
  } : undefined;
  const markLine = lines.length ? {
    symbol: 'none', silent: false, label: { show: false, fontSize: 10, color: c.ink2, formatter: '{b}', position: 'insideEndTop' },
    emphasis: { label: { show: true } },
    lineStyle: { color: c.ink2, type: 'dashed', width: 1 },
    data: lines.map((m) => ({ xAxis: +new Date(m.ts), name: m.label, href: m.href })),
  } : undefined;

  const series: any[] = o.series.map((s, i) => {
    const color = seriesColor(o.theme, i);
    const nonNull = s.points.reduce((n, p) => n + (p[1] == null ? 0 : 1), 0);
    return {
      type: 'line', name: seriesName(s, o.defs, multiMetric), data: s.points, connectNulls: false,
      showSymbol: nonNull <= 40, symbol: 'circle', symbolSize: 4, lineStyle: { width: 1.6, color }, itemStyle: { color },
      emphasis: { focus: 'series' }, unitOf: s.unit ?? o.defs[s.metric]?.unit ?? '',
      ...(i === 0 ? { markArea, markLine } : {}),
    };
  });
  // markers still render when there is no data
  if (!series.length && (markArea || markLine)) series.push({ type: 'line', name: 'markers', data: [], markArea, markLine });

  return {
    useUTC: o.tz === 'utc',
    legend: { show: o.series.length > 1, type: 'scroll' },
    grid: { top: o.series.length > 1 ? 30 : 12, bottom: 6, left: 8, right: 14 },
    tooltip: {
      trigger: 'axis',
      formatter: (ps: any) => {
        const arr = (Array.isArray(ps) ? ps : [ps]).filter((p: any) => p.seriesName !== 'markers');
        if (!arr.length) return '';
        const ts = Number(arr[0].axisValue ?? arr[0].value?.[0]);
        const rows = arr
          .map((p: any) => ({ p, v: Array.isArray(p.value) ? p.value[1] : p.value }))
          .sort((a: any, b: any) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
          .slice(0, 16)
          .map(({ p, v }: any) => `<div style="display:flex;gap:10px;justify-content:space-between"><span>${p.marker}${esc(p.seriesName)}</span><b>${v == null ? 'no data' : esc(formatValue(v, series[p.seriesIndex]?.unitOf))}</b></div>`);
        return `<div style="font-weight:600;margin-bottom:4px">${esc(formatTs(ts, o.tz))}</div>${rows.join('')}${arr.length > 16 ? `<div>+${arr.length - 16} more</div>` : ''}`;
      },
    },
    xAxis: { type: 'time', min: o.from, max: o.to, axisLabel: { formatter: (v: number) => axisLabel(v, span, o.tz), hideOverlap: true } },
    yAxis: { type: 'value', scale: false, splitNumber: 4, axisLabel: { formatter: (v: number) => (unit !== undefined ? formatValue(v, unit) : formatValue(v)) } },
    brush: { xAxisIndex: 0, brushType: 'lineX', brushMode: 'single', transformable: false, throttleType: 'debounce', throttleDelay: 200, brushStyle: { borderWidth: 1, color: c.muted + '33', borderColor: c.muted }, outOfBrush: { colorAlpha: 1 } },
    toolbox: { show: false },
    series,
  } as EChartsOption;
}

/** Table view of the panel (accessibility / copy-out). */
export function seriesTableData(series: ObsSeries[], defs: Record<string, MetricDef>, tz: Tz) {
  const multi = new Set(series.map((s) => s.metric)).size > 1;
  const ts = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const maps = series.map((s) => new Map(s.points.map((p) => [p[0], p[1]])));
  return {
    columns: ['Time', ...series.map((s) => seriesName(s, defs, multi))],
    rows: ts.map((t) => [formatTs(t, tz), ...maps.map((m) => { const v = m.get(t); return v == null ? null : +v.toFixed(3); })]),
  };
}
