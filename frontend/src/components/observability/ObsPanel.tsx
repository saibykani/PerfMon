import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ECharts } from 'echarts';
import { AlertTriangle, ArrowDown, ArrowUp, Pencil, Search, Trash2 } from 'lucide-react';
import { Chart } from '@/charts/Chart';
import { Modal } from '@/components/ui';
import { useUi } from '@/stores/ui';
import { useObsFilters } from '@/stores/obsFilters';
import { AGGS, CATALOGUE, ENTITY_LABEL, ENTITY_ORDER, useObsSeries, type Agg, type MetricDef, type ObsQuery } from './obsApi';
import { obsSeriesOption, seriesTableData } from './obsChart';
import { formatStep, formatTs, snapToMinutes, type ObsFilterValues } from './obsTime';

export interface PanelCfg {
  id: string; title?: string; metrics: string[]; agg: Agg; groupBy: 'entity' | 'none'; step: 'auto' | number;
  /** panel-level filters, overriding the global ones per key (e.g. role=loadgen) */
  filters?: ObsFilterValues;
}

export const STEP_OPTIONS: ('auto' | number)[] = ['auto', 10, 30, 60, 300, 900, 3600, 21600, 86400];
export const newPanelId = () => Math.random().toString(36).slice(2, 9);
export const mergeFilters = (g: ObsFilterValues, p?: ObsFilterValues): ObsFilterValues => ({ ...g, ...(p ?? {}) });

export function panelTitle(p: PanelCfg, defs: Record<string, MetricDef>) {
  return p.title || p.metrics.map((m) => defs[m]?.label ?? m).join(', ') || 'Empty panel';
}

/* ------------------------------------------------------------------ metric picker */

export function MetricPicker({ open, onClose, value, metrics, onApply, title = 'Choose metrics' }: {
  open: boolean; onClose: () => void; value: string[]; metrics: MetricDef[]; onApply: (keys: string[]) => void; title?: string;
}) {
  const [sel, setSel] = useState<string[]>(value);
  const [q, setQ] = useState('');
  useEffect(() => { if (open) { setSel(value); setQ(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = metrics.length ? metrics : CATALOGUE;
  const n = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const by: Record<string, MetricDef[]> = {};
    for (const m of list) if (!n || `${m.label} ${m.key} ${m.entity}`.toLowerCase().includes(n)) (by[m.entity] ??= []).push(m);
    return Object.entries(by).sort(([a], [b]) => (ENTITY_ORDER.indexOf(a) + 99) % 99 - (ENTITY_ORDER.indexOf(b) + 99) % 99);
  }, [list, n]);
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  return (
    <Modal open={open} onClose={onClose} title={title} width={620}
      footer={<>
        <span className="muted small" style={{ marginRight: 'auto' }}>{sel.length} selected{sel.length > 1 ? ' · same-unit metrics share an axis best' : ''}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!sel.length} onClick={() => { onApply(sel); onClose(); }}>Apply</button>
      </>}>
      <div className="stack">
        <div className="obs-ms-search"><Search size={13} /><input className="input" autoFocus placeholder="Search metrics…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search metrics" /></div>
        {!metrics.length && <div className="muted small">Showing the full catalogue — the inventory has not reported which metrics have data in this window.</div>}
        <div className="obs-picker-groups">
          {groups.map(([entity, ms]) => (
            <fieldset key={entity} className="obs-picker-group">
              <legend>{ENTITY_LABEL[entity] ?? entity}</legend>
              {ms.map((m) => (
                <label key={m.key} className={`obs-picker-item ${sel.includes(m.key) ? 'on' : ''}`}>
                  <input type="checkbox" checked={sel.includes(m.key)} onChange={() => toggle(m.key)} />
                  <span>{m.label}{m.unit && <span className="muted"> ({m.unit})</span>}</span>
                  <span className="mono muted small obs-picker-key">{m.key}</span>
                </label>
              ))}
            </fieldset>
          ))}
          {!groups.length && <div className="muted small">No metric matches “{q}”.</div>}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ panel */

export function ObsPanel({ panel, q, defs, metrics, group, height = 240, onChange, onRemove, onMove, editable = true, showMarkers = true }: {
  panel: PanelCfg; q: ObsQuery; defs: Record<string, MetricDef>; metrics: MetricDef[]; group: string; height?: number;
  onChange: (p: PanelCfg) => void; onRemove?: () => void; onMove?: (dir: -1 | 1) => void; editable?: boolean; showMarkers?: boolean;
}) {
  const theme = useUi((s) => s.theme);
  const tz = useObsFilters((s) => s.tz);
  const setTime = useObsFilters((s) => s.setTime);
  const nav = useNavigate();
  const [picking, setPicking] = useState(false);
  const pq = useMemo(() => ({ ...q, filters: mergeFilters(q.filters, panel.filters) }), [q, panel.filters]);
  const res = useObsSeries(pq, { metrics: panel.metrics, agg: panel.agg, groupBy: panel.groupBy, step: panel.step });
  const data = res.data;
  const series = useMemo(() => data?.series ?? [], [data]);
  const option = useMemo(() => obsSeriesOption({ theme, series, defs, markers: data?.markers, tz, from: q.from, to: q.to }), [theme, series, defs, data?.markers, tz, q.from, q.to]);
  const table = useMemo(() => seriesTableData(series, defs, tz), [series, defs, tz]);
  const hasPoints = series.some((s) => s.points.some((p) => p[1] != null));

  // drag on the plot (lineX brush) → global From/To snapped to whole minutes
  const chartRef = useRef<ECharts | null>(null);
  const arm = () => chartRef.current?.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
  useEffect(() => { const t = setTimeout(arm, 80); return () => clearTimeout(t); }, [option]);
  const onReady = (c: ECharts) => {
    chartRef.current = c;
    c.on('brushEnd', (e: any) => {
      const r = e?.areas?.[0]?.coordRange;
      c.dispatchAction({ type: 'brush', areas: [] });
      if (!Array.isArray(r) || r.length < 2) return;
      const [a, b] = r.map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) < 1000) return;
      setTime({ mode: 'absolute', ...snapToMinutes(a, b) });
    });
  };
  const onClick = (p: any) => {
    const href = p?.data?.href ?? (Array.isArray(p?.data) ? p.data[0]?.href : undefined);
    if (href && (p.componentType === 'markArea' || p.componentType === 'markLine')) nav(href);
  };

  const sub = [data ? `${panel.agg} · step ${formatStep(data.stepSec)}` : null, data?.truncated ? 'top series only' : null].filter(Boolean).join(' · ');
  const actions = (
    <span className="obs-panel-tools">
      <select className="select obs-mini" aria-label="Aggregation" value={panel.agg} onChange={(e) => onChange({ ...panel, agg: e.target.value as Agg })}>
        {AGGS.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <select className="select obs-mini" aria-label="Group by" value={panel.groupBy} onChange={(e) => onChange({ ...panel, groupBy: e.target.value as 'entity' | 'none' })}>
        <option value="entity">per entity</option><option value="none">combined</option>
      </select>
      <select className="select obs-mini" aria-label="Step" value={String(panel.step)} onChange={(e) => onChange({ ...panel, step: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
        {STEP_OPTIONS.map((s) => <option key={String(s)} value={String(s)}>{s === 'auto' ? 'step auto' : formatStep(s)}</option>)}
      </select>
      {editable && <button className="btn btn-ghost icon-btn btn-sm" title="Edit metrics" aria-label="Edit metrics" onClick={() => setPicking(true)}><Pencil size={13} /></button>}
      {onMove && <><button className="btn btn-ghost icon-btn btn-sm obs-hide-sm" title="Move up" aria-label="Move up" onClick={() => onMove(-1)}><ArrowUp size={13} /></button>
        <button className="btn btn-ghost icon-btn btn-sm obs-hide-sm" title="Move down" aria-label="Move down" onClick={() => onMove(1)}><ArrowDown size={13} /></button></>}
      {onRemove && <button className="btn btn-ghost icon-btn btn-sm" title="Remove panel" aria-label="Remove panel" onClick={onRemove}><Trash2 size={13} /></button>}
    </span>
  );

  return (
    <div className="obs-panel">
      <Chart group={group} height={height} title={panelTitle(panel, defs)} subtitle={sub} option={option} table={table} actions={actions}
        loading={res.isLoading} onReady={onReady} onPointClick={onClick}
        empty={res.error ? null : !panel.metrics.length ? 'Pick metrics for this panel' : !hasPoints && !res.isLoading ? 'No data for these filters in this window' : null} />
      {res.error && <div className="obs-err small"><AlertTriangle size={12} /> {(res.error as Error).message}</div>}
      {showMarkers && (data?.markers?.length ?? 0) > 0 && (
        <div className="obs-markers">
          {data!.markers!.slice(0, 12).map((m, i) => {
            const label = <><span className={`obs-mk obs-mk-${m.kind === 'run' ? 'run' : 'line'}`} />{m.label} <span className="muted">{formatTs(+new Date(m.ts), tz).slice(5, 16)}</span></>;
            return m.href ? <a key={i} href={m.href} onClick={(e) => { e.preventDefault(); nav(m.href!); }} className="obs-marker">{label}</a> : <span key={i} className="obs-marker">{label}</span>;
          })}
          {data!.markers!.length > 12 && <span className="muted small">+{data!.markers!.length - 12} more</span>}
        </div>
      )}
      <MetricPicker open={picking} onClose={() => setPicking(false)} value={panel.metrics} metrics={metrics} onApply={(m) => onChange({ ...panel, metrics: m, title: undefined })} />
    </div>
  );
}
