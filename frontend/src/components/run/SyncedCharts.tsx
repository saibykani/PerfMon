import { useEffect, useMemo, useRef } from 'react';
import { Chart } from '@/charts/Chart';
import { timeSeriesOption, seriesTable, type TsSeries, type Marker } from '@/charts/builders';
import { useUi } from '@/stores/ui';
import { enableBrushZoom, toolboxZoom } from './common';
import type { PercentileMethod, SeriesPoint } from './types';

export type PanelKey = 'users' | 'tps' | 'rt' | 'errors' | 'cpu' | 'memory' | 'throughput';

export interface SyncedChartsProps {
  points: SeriesPoint[];
  infra?: { t: number; cpu_pct?: number | null; memory_pct?: number | null; cpu?: number | null; mem?: number | null }[];
  panels?: PanelKey[];
  markers?: Marker[];
  percentileMethod?: PercentileMethod;
  group: string;
  height?: number;
  /** enable drag-to-select range + callbacks */
  onRange?: (from: number, to: number) => void;
  onPointClick?: (ts: number) => void;
  loading?: boolean;
  columns?: 1 | 2;
  animate?: boolean;
}

/** Fixed y-axis gutter so the synchronized small multiples share one aligned time axis. */
const ALIGN = { grid: { left: 58, right: 18, containLabel: false } };

/**
 * Synchronized small multiples: one chart per unit (never dual-axis), sharing a `group`
 * so crosshair, tooltip and zoom stay in lock-step. Drag on any chart selects a time range.
 */
export function SyncedCharts({ points, infra = [], panels = ['users', 'tps', 'rt', 'errors', 'cpu', 'memory'], markers = [], percentileMethod, group, height = 150, onRange, onPointClick, loading, columns = 1, animate = true }: SyncedChartsProps) {
  const theme = useUi((s) => s.theme);
  const ref = useRef<HTMLDivElement>(null);
  const approx = percentileMethod === 'interval_weighted_approx';
  const timer = useRef<number>();

  const defs = useMemo(() => {
    const ser = (name: string, key: string, pick: (p: SeriesPoint) => number | null, extra: Partial<TsSeries> = {}): TsSeries => ({ name, key, data: points.map((p) => [p.t, pick(p)]), ...extra });
    const infraSer = (name: string, key: string, pick: (p: any) => number | null): TsSeries => ({ name, key, data: infra.map((p) => [Number(p.t), pick(p)]) });
    const hasAny = (s: TsSeries[]) => s.some((x) => x.data.some((d) => d[1] != null));
    const all: Record<PanelKey, { title: string; unit?: string; series: TsSeries[]; subtitle?: string; min?: number; max?: number }> = {
      users: { title: 'Active users', series: [ser('Users', 'users', (p) => p.users, { step: true, area: true })], min: 0 },
      tps: { title: 'Throughput', unit: 'tps', series: [ser('TPS', 'tps', (p) => p.tps, { area: true })], min: 0 },
      rt: {
        title: `Response time${approx ? ' (≈)' : ''}`, unit: 'ms', subtitle: approx ? 'approximate percentiles' : undefined, min: 0,
        series: [ser('P50', 'p50', (p) => p.p50), ser('P90', 'p90', (p) => p.p90), ser('P95', 'p95', (p) => p.p95), ser('P99', 'p99', (p) => p.p99), ser('Avg', 'avg', (p) => p.avg, { dashed: true })]
          .filter((s) => s.data.some((d) => d[1] != null)),
      },
      errors: { title: 'Error rate', unit: '%', series: [ser('Error %', 'errorPct', (p) => p.errorPct, { area: true })], min: 0 },
      cpu: { title: 'CPU', unit: '%', series: [infraSer('CPU %', 'cpu', (p) => p.cpu_pct ?? p.cpu ?? null)], min: 0, max: 100 },
      memory: { title: 'Memory', unit: '%', series: [infraSer('Memory %', 'memory', (p) => p.memory_pct ?? p.mem ?? null)], min: 0, max: 100 },
      throughput: { title: 'Network throughput', unit: 'B/s', series: [ser('Received', 'tps', (p) => p.receivedBps), ser('Sent', 'p95', (p) => p.sentBps)], min: 0 },
    };
    return panels.map((k) => ({ key: k, ...all[k], has: hasAny(all[k].series) }));
  }, [points, infra, panels, approx]);

  const firstWithData = defs.find((d) => d.has)?.key;
  const options = useMemo(() => defs.map((d) => {
    const o = timeSeriesOption({
      theme, series: d.series, unit: d.unit, min: d.min, max: d.max, zoom: true,
      markers: markers.map((m) => ({ ...m, label: d.key === firstWithData ? m.label : '' })),
    }) as any;
    return { ...o, ...ALIGN, ...(onRange ? toolboxZoom : {}), animation: animate, grid: { ...ALIGN.grid, top: d.series.length > 1 ? 26 : 10, bottom: 22 } };
  }), [defs, theme, markers, firstWithData, onRange, animate]);

  // brush (drag-to-select) must be re-armed after every option rebuild
  useEffect(() => {
    if (!onRange) return;
    const id = window.setTimeout(() => enableBrushZoom(ref.current), 120);
    return () => window.clearTimeout(id);
  }, [options, onRange]);

  const handleRange = (from: number, to: number) => {
    if (!onRange) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      onRange(from, to);
      enableBrushZoom(ref.current);
    }, 250);
  };

  return (
    <div ref={ref} className={`synced ${columns === 2 ? 'synced-2' : ''}`}>
      {defs.map((d, i) => (
        <Chart key={d.key} option={options[i]} group={group} title={d.title} subtitle={d.subtitle} height={height} loading={loading && !points.length}
          empty={!loading && !d.has ? (d.key === 'cpu' || d.key === 'memory' ? 'No infrastructure metrics for this window — send server metrics with the Run ID.' : 'No data') : null}
          table={seriesTable(d.series)} onRangeSelect={onRange ? handleRange : undefined}
          onPointClick={onPointClick ? (p) => { const ts = Array.isArray(p?.value) ? Number(p.value[0]) : NaN; if (Number.isFinite(ts)) onPointClick(ts); } : undefined} />
      ))}
    </div>
  );
}

/** Convert timeline events + annotations into chart markers. */
export function toMarkers(events: { ts: string; title: string; severity?: string; type?: string }[] = [], annotations: { ts: string; title: string }[] = []): Marker[] {
  return [
    ...events.filter((e) => e.type !== 'TEST_START' && e.type !== 'TEST_END').map((e) => ({ ts: new Date(e.ts).getTime(), label: e.title.length > 28 ? `${e.title.slice(0, 27)}…` : e.title, severity: (e.severity as Marker['severity']) ?? 'INFO' })),
    ...annotations.map((a) => ({ ts: new Date(a.ts).getTime(), label: `✎ ${a.title}`, severity: 'INFO' as const })),
  ];
}
