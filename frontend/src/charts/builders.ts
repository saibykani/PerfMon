import type { EChartsOption } from 'echarts';
import { seriesColor, CHROME } from './palette';

export interface TsSeries {
  name: string;
  /** semantic key for a fixed color (tps, p95, users, errors, cpu...) or explicit slot */
  key?: string;
  slot?: number;
  data: [number, number | null][];
  area?: boolean;
  dashed?: boolean;
  step?: boolean;
}

export interface Marker { ts: number; label: string; severity?: 'INFO' | 'WARNING' | 'CRITICAL' }

export const unitFormatter = (unit?: string) => (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
    case '%': return `${v.toFixed(v < 10 ? 2 : 1)}%`;
    case 'tps': return `${v.toFixed(v < 10 ? 2 : 1)}/s`;
    case 'B/s': {
      const u = ['B/s', 'KB/s', 'MB/s', 'GB/s']; let i = 0; let x = v;
      while (x >= 1024 && i < 3) { x /= 1024; i++; }
      return `${x.toFixed(1)} ${u[i]}`;
    }
    case 'MB': return v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${Math.round(v)} MB`;
    default: return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : `${+v.toFixed(2)}`;
  }
};

/**
 * One-axis time-series chart (never dual-axis: different units go to separate,
 * synchronized charts). Inside zoom/pan (wheel + drag), crosshair tooltip, optional event markers.
 */
export function timeSeriesOption(opts: {
  theme: 'light' | 'dark'; series: TsSeries[]; unit?: string; yName?: string; markers?: Marker[]; zoom?: boolean; slider?: boolean;
  min?: number; max?: number; showLegend?: boolean; thresholds?: { value: number; label: string; level: 'warning' | 'critical' }[];
}): EChartsOption {
  const fmt = unitFormatter(opts.unit);
  const c = CHROME[opts.theme];
  const showLegend = opts.showLegend ?? opts.series.length > 1;
  const sevColor = (s?: string) => (s === 'CRITICAL' ? '#d03b3b' : s === 'WARNING' ? '#c98500' : c.muted);
  return {
    legend: showLegend ? { show: true } : { show: false },
    grid: { top: showLegend ? 28 : 10, bottom: opts.slider ? 36 : 6 },
    tooltip: { valueFormatter: (v: any) => fmt(v as number) },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: opts.yName, min: opts.min, max: opts.max, axisLabel: { formatter: (v: number) => fmt(v) }, splitNumber: 4 },
    dataZoom: opts.zoom === false ? [] : [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'shift', moveOnMouseMove: true },
      ...(opts.slider ? [{ type: 'slider' as const, xAxisIndex: 0, height: 18, bottom: 6, borderColor: c.grid, fillerColor: 'rgba(57,135,229,0.12)', handleSize: 14, showDetail: false }] : []),
    ],
    series: opts.series.map((s, i) => {
      const color = s.slot != null ? seriesColor(opts.theme, s.slot) : seriesColor(opts.theme, s.key ?? i);
      return {
        type: 'line', name: s.name, data: s.data, showSymbol: false, symbolSize: 8, connectNulls: false, step: s.step ? 'end' : undefined,
        lineStyle: { width: 2, color, type: s.dashed ? 'dashed' : 'solid' }, itemStyle: { color },
        emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
        areaStyle: s.area ? { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color + '33' }, { offset: 1, color: color + '00' }] } } : undefined,
        markLine: i === 0 && (opts.markers?.length || opts.thresholds?.length) ? {
          symbol: 'none', silent: false,
          label: { fontSize: 10, color: c.ink2, formatter: '{b}', position: 'insideEndTop' },
          data: [
            ...(opts.markers ?? []).map((m) => ({ xAxis: m.ts, name: m.label, lineStyle: { color: sevColor(m.severity), type: 'dashed' as const, width: 1 } })),
            ...(opts.thresholds ?? []).map((t) => ({ yAxis: t.value, name: t.label, lineStyle: { color: t.level === 'critical' ? '#d03b3b' : '#c98500', type: 'dotted' as const, width: 1 } })),
          ],
        } : undefined,
      } as any;
    }),
  };
}

/** Horizontal ranking bar chart (top-N transactions/endpoints). */
export function rankingOption(opts: { theme: 'light' | 'dark'; labels: string[]; values: (number | null)[]; unit?: string; slot?: number }): EChartsOption {
  const fmt = unitFormatter(opts.unit);
  const color = seriesColor(opts.theme, opts.slot ?? 1);
  return {
    grid: { left: 8, right: 56, top: 6, bottom: 6 },
    tooltip: { trigger: 'item', valueFormatter: (v: any) => fmt(v as number) },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmt(v) }, splitNumber: 3 },
    yAxis: { type: 'category', data: opts.labels, inverse: true, axisLabel: { width: 180, overflow: 'truncate' } },
    series: [{ type: 'bar', data: opts.values, barMaxWidth: 14, itemStyle: { color, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', formatter: (p: any) => fmt(p.value), fontSize: 10 } }],
  };
}

/** Donut for part-to-whole with ≤ 6 parts (status codes, error types). */
export function donutOption(opts: { theme: 'light' | 'dark'; items: { name: string; value: number; color?: string }[] }): EChartsOption {
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', right: 0, top: 'middle', left: undefined },
    series: [{
      type: 'pie', radius: ['52%', '78%'], center: ['35%', '50%'], avoidLabelOverlap: true, label: { show: false },
      itemStyle: { borderColor: CHROME[opts.theme].surface, borderWidth: 2 },
      data: opts.items.map((it, i) => ({ ...it, itemStyle: { color: it.color ?? seriesColor(opts.theme, i) } })),
    }],
  };
}

/** Gauge for a single bounded KPI (SLA %, score). */
export function gaugeOption(opts: { theme: 'light' | 'dark'; value: number | null; max?: number; unit?: string; bands?: [number, string][] }): EChartsOption {
  const c = CHROME[opts.theme];
  const max = opts.max ?? 100;
  return {
    series: [{
      type: 'gauge', min: 0, max, startAngle: 210, endAngle: -30, radius: '92%', center: ['50%', '58%'],
      progress: { show: true, width: 10, roundCap: true, itemStyle: { color: (opts.value ?? 0) >= max * 0.95 ? '#0ca30c' : (opts.value ?? 0) >= max * 0.8 ? '#c98500' : '#d03b3b' } },
      axisLine: { roundCap: true, lineStyle: { width: 10, color: [[1, c.grid]] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false }, anchor: { show: false },
      title: { show: false },
      detail: { valueAnimation: true, offsetCenter: [0, '0%'], fontSize: 22, fontWeight: 600, color: c.ink, formatter: (v: number) => (opts.value == null ? '—' : `${v.toFixed(1)}${opts.unit ?? ''}`) },
      data: [{ value: opts.value ?? 0 }],
    }],
  };
}

/** Heatmap (time × latency bucket), sequential single-hue ramp. */
export function heatmapOption(opts: { theme: 'light' | 'dark'; times: number[]; buckets: string[]; cells: [number, number, number][] }): EChartsOption {
  const max = Math.max(1, ...opts.cells.map((c) => c[2]));
  return {
    tooltip: { trigger: 'item', formatter: (p: any) => `${new Date(opts.times[p.value[0]]).toLocaleTimeString()}<br/>${opts.buckets[p.value[1]]}: <b>${p.value[2]}</b>` },
    grid: { top: 8, bottom: 40, left: 8, right: 16 },
    xAxis: { type: 'category', data: opts.times.map((t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), splitArea: { show: false } },
    yAxis: { type: 'category', data: opts.buckets, splitArea: { show: false } },
    visualMap: { min: 0, max, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120, itemWidth: 10, inRange: { color: opts.theme === 'dark' ? ['#1b2a3d', '#184f95', '#3987e5', '#86b6ef'] : ['#e8f0fb', '#86b6ef', '#2a78d6', '#0d366b'] }, textStyle: { color: CHROME[opts.theme].muted } },
    series: [{ type: 'heatmap', data: opts.cells, itemStyle: { borderColor: CHROME[opts.theme].surface, borderWidth: 1 } }],
  };
}

/** Build table-view rows from time series (relief rule / accessibility). */
export function seriesTable(series: TsSeries[], fmt = (v: number | null) => (v == null ? null : +v.toFixed(2))) {
  const ts = [...new Set(series.flatMap((s) => s.data.map((d) => d[0])))].sort((a, b) => a - b);
  const maps = series.map((s) => new Map(s.data));
  return { columns: ['Time', ...series.map((s) => s.name)], rows: ts.map((t) => [new Date(t).toLocaleTimeString(), ...maps.map((m) => fmt(m.get(t) ?? null))]) };
}
