import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Compass, FileDown, Plus } from 'lucide-react';
import { api } from '@/services/api';
import { Card } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { toast } from '@/components/inventory/common';
import { useObsFilters, useObsRange } from '@/stores/obsFilters';
import { downloadTableCsv, metricIndex, seriesParams, useObsInventory, type MetricDef, type ObsQuery, type ObsTableResp, type ObsTableRow } from './obsApi';
import { formatValue } from './obsChart';
import { ObsFilterBar, ALL_DIMS, ROLE_LABEL } from './ObsFilterBar';
import { MetricPicker, ObsPanel, mergeFilters, newPanelId, type PanelCfg } from './ObsPanel';
import { encodePanels } from './obsViews';
import { writeUrlState, type FilterKey, type ObsFilterValues } from './obsTime';

/* ------------------------------------------------------------------ presets */

const P = (title: string, metrics: string[], extra: Partial<PanelCfg> = {}): PanelCfg => ({ id: newPanelId(), title, metrics, agg: 'avg', groupBy: 'entity', step: 'auto', ...extra });
const LOADGEN = { filters: { role: ['loadgen'] } };

export const PRESETS: Record<string, { label: string; panels: () => PanelCfg[] }> = {
  hosts: { label: 'Hosts', panels: () => [P('CPU', ['host.cpu_pct']), P('Memory', ['host.memory_pct']), P('Disk', ['host.disk_pct']), P('Load (1m)', ['host.load_1m']), P('Network', ['host.net_rx_kbps', 'host.net_tx_kbps'])] },
  loadgen: { label: 'Load generators', panels: () => [P('Load generator CPU', ['host.cpu_pct'], LOADGEN), P('Load generator memory', ['host.memory_pct'], LOADGEN), P('JMeter JVM heap', ['jvm.heap_pct'], LOADGEN), P('JMeter GC pause', ['jvm.gc_pause_ms'], { ...LOADGEN, agg: 'max' })] },
  databases: { label: 'Databases', panels: () => [P('Query latency', ['db.query_latency_ms']), P('Active connections', ['db.connections_active']), P('Pool utilisation', ['db.pool_pct'], { agg: 'max' }), P('Transactions/s', ['db.tps']), P('Slow queries', ['db.slow_queries'], { agg: 'sum' }), P('Locks / deadlocks', ['db.locks', 'db.deadlocks'], { agg: 'max' }), P('DB CPU', ['db.cpu_pct'])] },
  services: { label: 'Services & JVM', panels: () => [P('Request rate', ['svc.request_rate']), P('Error rate', ['svc.error_pct']), P('Latency', ['svc.latency_ms']), P('Service CPU', ['svc.cpu_pct']), P('Heap', ['jvm.heap_pct']), P('GC pause', ['jvm.gc_pause_ms'], { agg: 'max' }), P('Threads', ['jvm.threads'])] },
  k8s: { label: 'Kubernetes', panels: () => [P('Pod CPU', ['k8s.pod.cpu_millicores']), P('Pod memory', ['k8s.pod.memory_mb']), P('Pod restarts', ['k8s.pod.restarts'], { agg: 'max' }), P('Node CPU', ['k8s.node.cpu_millicores']), P('Node memory', ['k8s.node.memory_mb'])] },
  runs: { label: 'Test runs', panels: () => [P('Throughput', ['run.tps']), P('P95 response time', ['run.p95_ms']), P('Errors', ['run.error_pct']), P('Active users', ['run.active_users'])] },
};

/** Keep only panels whose metrics the inventory reports (all panels while it is unknown). */
export function availablePanels(panels: PanelCfg[], metrics: MetricDef[] | undefined): PanelCfg[] {
  if (!metrics?.length) return panels;
  const have = new Set(metrics.map((m) => m.key));
  return panels.map((p) => ({ ...p, metrics: p.metrics.filter((m) => have.has(m)) })).filter((p) => p.metrics.length);
}

/* ------------------------------------------------------------------ stats table */

interface Row extends ObsTableRow { key: string; group: number }

export function StatsTable({ q, panels, defs, title = 'Statistics for the window' }: { q: ObsQuery; panels: PanelCfg[]; defs: Record<string, MetricDef>; title?: string }) {
  // one table request per distinct panel-filter set (panels may add e.g. role=loadgen)
  const groups = useMemo(() => {
    const by = new Map<string, { filters: ObsFilterValues; metrics: Set<string> }>();
    for (const p of panels) {
      const f = mergeFilters(q.filters, p.filters);
      const k = JSON.stringify(f);
      if (!by.has(k)) by.set(k, { filters: f, metrics: new Set() });
      p.metrics.forEach((m) => by.get(k)!.metrics.add(m));
    }
    return [...by.values()].map((g) => ({ filters: g.filters, metrics: [...g.metrics] })).filter((g) => g.metrics.length);
  }, [panels, q.filters]);
  const results = useQueries({
    queries: groups.map((g) => {
      const params = seriesParams({ ...q, filters: g.filters }, { metrics: g.metrics });
      return { queryKey: ['obs', 'table', params], queryFn: () => api.get<ObsTableResp>('/observability/table', params), retry: 1 };
    }),
  });
  const rows: Row[] = results.flatMap((r, gi) => (r.data?.rows ?? []).map((x) => ({ ...x, group: gi, key: `${gi}:${x.metric}:${x.entityId ?? x.label}` })));
  const loading = results.some((r) => r.isLoading);
  const error = results.find((r) => r.error)?.error as Error | undefined;
  const fmt = (k: 'min' | 'avg' | 'max' | 'p95' | 'last') => (r: Row) => formatValue(r.stats?.[k], r.unit ?? defs[r.metric]?.unit);
  const roleNote = (r: Row) => groups[r.group]?.filters.role?.map((x) => ROLE_LABEL[x] ?? x).join(', ');
  const cols: Column<Row>[] = [
    { key: 'entity', header: 'Entity', render: (r) => <span><span className="badge">{r.entity}</span>{roleNote(r) && <span className="badge accent" style={{ marginLeft: 4 }}>{roleNote(r)}</span>}</span> },
    { key: 'label', header: 'Name', render: (r) => <b className="mono">{r.label}</b> },
    { key: 'metric', header: 'Metric', value: (r) => defs[r.metric]?.label ?? r.metric, render: (r) => <span title={r.metric}>{defs[r.metric]?.label ?? r.metric}</span> },
    { key: 'unit', header: 'Unit', value: (r) => r.unit ?? defs[r.metric]?.unit ?? '' },
    ...(['min', 'avg', 'max', 'p95', 'last'] as const).map((k): Column<Row> => ({ key: k, header: k === 'p95' ? 'P95' : k[0].toUpperCase() + k.slice(1), align: 'right', value: (r) => r.stats?.[k] ?? null, render: fmt(k) })),
    { key: 'samples', header: 'Samples', align: 'right', value: (r) => r.stats?.samples ?? null, render: (r) => (r.stats?.samples ?? 0).toLocaleString() },
  ];
  const csv = async () => {
    try { for (const g of groups) await downloadTableCsv({ ...q, filters: g.filters }, { metrics: g.metrics }); } catch (e) { toast.error(`CSV export failed: ${(e as Error).message}`); }
  };
  return (
    <Card title={title} noPad actions={<button className="btn btn-sm" onClick={csv} disabled={!groups.length} title="Full statistics table from the server (format=csv)"><FileDown size={13} />Download CSV</button>}>
      {error && <div className="obs-err small" style={{ padding: '8px 12px' }}>{error.message}</div>}
      <DataTable rows={rows} columns={cols} rowKey={(r) => r.key} loading={loading} exportName="observability-stats" maxHeight={420} initialSort={{ key: 'max', order: 'desc' }}
        empty={groups.length ? 'No samples for these filters in this window' : 'Add a panel to see statistics'} />
    </Card>
  );
}

/* ------------------------------------------------------------------ time-window view (retrofits) */

/** Explorer link carrying the current window, filters and panels. */
export function explorerHref(panels: PanelCfg[]) {
  const sp = writeUrlState(useObsFilters.getState());
  if (panels.length) sp.set('panels', encodePanels(panels));
  return `/observability?${sp.toString()}`;
}

export function ObsWindowView({ preset, extraPresets = [], dims = ALL_DIMS, fixedFilters, group, height = 210 }: {
  preset: keyof typeof PRESETS; extraPresets?: (keyof typeof PRESETS)[]; dims?: FilterKey[]; fixedFilters?: ObsFilterValues; group: string; height?: number;
}) {
  const filters = useObsFilters((s) => s.filters);
  const { from, to } = useObsRange();
  const inv = useObsInventory(from, to);
  const defs = useMemo(() => metricIndex(inv.data), [inv.data]);
  const [panels, setPanels] = useState<PanelCfg[]>(() => [preset, ...extraPresets].flatMap((k) => PRESETS[k].panels()));
  const [adding, setAdding] = useState(false);
  const shown = availablePanels(panels, inv.data?.metrics);
  const q: ObsQuery = useMemo(() => ({ from, to, filters: { ...filters, ...(fixedFilters ?? {}) } }), [from, to, filters, JSON.stringify(fixedFilters ?? {})]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (p: PanelCfg) => setPanels((ps) => ps.map((x) => (x.id === p.id ? p : x)));
  const hidden = panels.length - shown.length;
  return (
    <div className="stack">
      <ObsFilterBar dims={dims} fixed={fixedFilters} extra={<Link className="btn btn-sm" to={explorerHref(shown)} title="Open these panels in the Explorer"><Compass size={13} />Explorer</Link>} />
      {inv.isSuccess && !shown.length ? (
        <Card><div className="empty">No {PRESETS[preset].label.toLowerCase()} metrics were reported in this window. Widen the time range or enable <Link to="/observability?collection=1">continuous collection</Link>.</div></Card>
      ) : (
        <div className="obs-grid">
          {shown.map((p, i) => <ObsPanel key={p.id} showMarkers={i === 0} panel={p} q={q} defs={defs} metrics={inv.data?.metrics ?? []} group={group} height={height} onChange={update} onRemove={() => setPanels((ps) => ps.filter((x) => x.id !== p.id))} />)}
        </div>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn btn-sm" onClick={() => setAdding(true)}><Plus size={13} />Add panel</button>
        {hidden > 0 && <span className="muted small">{hidden} preset panel{hidden > 1 ? 's' : ''} hidden — no data in this window.</span>}
      </div>
      <StatsTable q={q} panels={shown} defs={defs} />
      <MetricPicker open={adding} onClose={() => setAdding(false)} value={[]} metrics={inv.data?.metrics ?? []} title="Add a panel"
        onApply={(m) => setPanels((ps) => [...ps, { id: newPanelId(), metrics: m, agg: 'avg', groupBy: 'entity', step: 'auto' }])} />
    </div>
  );
}

/* ------------------------------------------------------------------ "By run / By time window" toggle */

export type ViewMode = 'run' | 'time';
export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [sp, setSp] = useSearchParams();
  const mode: ViewMode = sp.get('view') === 'time' ? 'time' : 'run';
  const set = (m: ViewMode) => {
    const p = new URLSearchParams(window.location.search);
    if (m === 'time') p.set('view', 'time'); else p.delete('view');
    setSp(p);
  };
  return [mode, set];
}

export function ViewModeToggle({ mode, onChange, hint }: { mode: ViewMode; onChange: (m: ViewMode) => void; hint?: string }) {
  return (
    <div className="obs-mode">
      <div className="seg obs-tz" role="radiogroup" aria-label="View mode">
        <button type="button" role="radio" aria-checked={mode === 'run'} className={mode === 'run' ? 'on' : ''} onClick={() => onChange('run')}>By run</button>
        <button type="button" role="radio" aria-checked={mode === 'time'} className={mode === 'time' ? 'on' : ''} onClick={() => onChange('time')}>By time window</button>
      </div>
      <span className="muted small">{hint ?? (mode === 'run' ? 'Metrics recorded during one test run.' : 'Any time window, to the minute — continuous and run data together.')}</span>
    </div>
  );
}
