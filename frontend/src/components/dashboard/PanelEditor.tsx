import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { Modal, Field, Tabs } from '@/components/ui';
import { useUi } from '@/stores/ui';
import { CATEGORICAL } from '@/charts/palette';
import type { TimeRange } from '@/stores/filters';
import { PanelFrame } from './PanelFrame';
import { AGGREGATIONS, GROUP_BY, METRICS, PANEL_TYPES, SOURCES, UNITS, metricDef, sourceDef } from './catalog';
import { queryPanels } from './useDashboardQuery';
import type { Panel, PanelQuery, PanelType, Threshold, VarValues } from './types';

function useDebounced<T>(v: T, ms = 400) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const MULTI_DEFAULT: Partial<Record<PanelType, boolean>> = { percentiles: true };
const CHARTY: PanelType[] = ['line', 'area', 'bar', 'stacked_bar', 'histogram', 'scatter', 'percentiles', 'tps', 'users', 'endpoint_ranking', 'transaction_ranking', 'error_distribution', 'donut'];

export function PanelEditor({ panel, onClose, onApply, vars, timeRange, group }: {
  panel: Panel | null; onClose: () => void; onApply: (p: Panel) => void; vars: VarValues; timeRange: TimeRange | null; group?: string;
}) {
  const [draft, setDraft] = useState<Panel | null>(panel);
  const [tab, setTab] = useState<'query' | 'display'>('query');
  const theme = useUi((s) => s.theme);
  useEffect(() => { setDraft(panel ? structuredClone(panel) : null); setTab('query'); }, [panel]);

  const debounced = useDebounced(draft);
  const preview = useQuery({
    queryKey: ['panel-preview', debounced?.id, debounced?.type, debounced?.query, vars, timeRange],
    queryFn: () => queryPanels([debounced!], vars, timeRange),
    enabled: !!debounced && debounced.type !== 'text',
    placeholderData: keepPreviousData,
    retry: false,
  });

  const src = sourceDef(draft?.query.source);
  const metricChoices = useMemo(() => (src?.metrics ? METRICS.filter((m) => src.metrics!.includes(m.key)) : METRICS), [src]);
  if (!draft) return null;

  const setQ = (patch: Partial<PanelQuery>) => setDraft((d) => d && ({ ...d, query: { ...d.query, ...patch } }));
  const setO = (patch: Record<string, any>) => setDraft((d) => d && ({ ...d, options: { ...d.options, ...patch } }));
  const multi = Array.isArray(draft.query.metrics) && draft.query.metrics.length > 0;
  const th = (level: Threshold['level']) => draft.options.thresholds?.find((t) => t.level === level)?.value;
  const setTh = (level: Threshold['level'], val: string) => {
    const rest = (draft.options.thresholds ?? []).filter((t) => t.level !== level);
    setO({ thresholds: val === '' ? rest : [...rest, { level, value: Number(val) }] });
  };
  const isText = draft.type === 'text';
  const result = isText ? undefined : preview.data?.[draft.id] ?? (preview.error ? { kind: 'error' as const, message: (preview.error as Error).message } : undefined);

  return (
    <Modal open={!!panel} onClose={onClose} width={1240} title={<span className="row">Edit panel <span className="badge">{draft.title || 'Untitled'}</span></span>}
      footer={<>
        <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>Changes apply to the dashboard draft — remember to save the dashboard.</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onApply(draft)} data-testid="apply-panel">Apply</button>
      </>}>
      <div className="editor">
        <div className="editor-preview">
          <div className="editor-preview-head"><Eye size={13} />Live preview{preview.isFetching && <span className="panel-refreshing" />}</div>
          <div className="editor-preview-frame">
            <PanelFrame panel={draft} result={result} loading={preview.isFetching} editing={false} canEdit={false} group={group ? `${group}-preview` : undefined} />
          </div>
        </div>
        <div className="editor-form">
          <Field label="Title"><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Panel title" /></Field>
          <Field label="Visualisation">
            <select className="select" value={draft.type} aria-label="Panel type" onChange={(e) => {
              const type = e.target.value as PanelType;
              const next: Panel = { ...draft, type };
              if (type === 'text' && draft.query.source !== 'text') next.query = { source: 'text', markdown: draft.query.markdown ?? '### Notes\n' };
              if (type !== 'text' && draft.query.source === 'text') next.query = { source: 'run_series', metric: 'p95' };
              if (MULTI_DEFAULT[type] && !next.query.metrics?.length) next.query = { ...next.query, metrics: ['p50', 'p90', 'p95', 'p99'], metric: undefined };
              setDraft(next);
            }}>
              {PANEL_TYPES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </Field>
          {!isText && <Tabs tabs={[{ key: 'query', label: 'Query' }, { key: 'display', label: 'Display' }]} value={tab} onChange={setTab} />}

          {isText && (
            <Field label="Markdown" hint="Supports headings, lists, links, tables and code. HTML is sanitised.">
              <textarea className="textarea mono" rows={14} value={draft.query.markdown ?? ''} onChange={(e) => setQ({ markdown: e.target.value })} aria-label="Markdown" />
            </Field>
          )}

          {!isText && tab === 'query' && (
            <div className="stack" style={{ gap: 10 }}>
              <Field label="Data source" hint={src?.hint}>
                <select className="select" value={draft.query.source} aria-label="Data source" onChange={(e) => {
                  const s = sourceDef(e.target.value)!;
                  setQ({ source: s.key, metric: s.metrics?.includes(draft.query.metric ?? '') ? draft.query.metric : s.metrics?.[0], groupBy: s.groupBy?.includes(draft.query.groupBy as any) ? draft.query.groupBy : undefined, metrics: undefined });
                }}>
                  {SOURCES.filter((s) => s.key !== 'text').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </Field>
              {!!src?.metrics?.length && (
                <div className="field">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <label>{multi ? 'Metrics (one series each)' : 'Metric'}</label>
                    <label className="row muted" style={{ fontSize: 11, gap: 4 }}>
                      <input type="checkbox" checked={multi} onChange={(e) => setQ(e.target.checked ? { metrics: [draft.query.metric ?? metricChoices[0].key], metric: undefined } : { metric: draft.query.metrics?.[0] ?? metricChoices[0].key, metrics: undefined })} />
                      Multiple series
                    </label>
                  </div>
                  {multi ? (
                    <div className="chips">
                      {metricChoices.map((m) => {
                        const on = draft.query.metrics!.includes(m.key);
                        return <button key={m.key} className={`chip ${on ? 'on' : ''}`} aria-pressed={on}
                          onClick={() => { const cur = draft.query.metrics!; const next = on ? cur.filter((x) => x !== m.key) : [...cur, m.key]; if (next.length) setQ({ metrics: next }); }}>{m.label}</button>;
                      })}
                    </div>
                  ) : (
                    <select className="select" value={draft.query.metric ?? ''} aria-label="Metric" onChange={(e) => { setQ({ metric: e.target.value }); const m = metricDef(e.target.value); if (m && !draft.options.unit) setO({ better: m.better }); }}>
                      {metricChoices.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  )}
                </div>
              )}
              <div className="form-grid">
                <Field label="Aggregation">
                  <select className="select" value={draft.query.aggregation ?? ''} onChange={(e) => setQ({ aggregation: (e.target.value || undefined) as any })} aria-label="Aggregation">
                    <option value="">Default</option>{AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </Field>
                <Field label="Group by">
                  <select className="select" value={draft.query.groupBy ?? ''} onChange={(e) => setQ({ groupBy: (e.target.value || undefined) as any })} aria-label="Group by">
                    <option value="">None</option>
                    {GROUP_BY.filter((g) => !src?.groupBy || src.groupBy.includes(g.key)).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                  </select>
                </Field>
                <Field label="Limit">
                  <input className="input" type="number" min={1} max={500} value={draft.query.limit ?? ''} placeholder="Auto" onChange={(e) => setQ({ limit: e.target.value ? Number(e.target.value) : undefined })} aria-label="Limit" />
                </Field>
                <Field label="Sort">
                  <select className="select" value={draft.query.sort ?? ''} onChange={(e) => setQ({ sort: (e.target.value || undefined) as any })} aria-label="Sort">
                    <option value="">Default</option><option value="desc">Descending</option><option value="asc">Ascending</option>
                  </select>
                </Field>
              </div>
              <div className="query-summary mono" title="Query model sent to the server">
                {JSON.stringify(draft.query)}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>Variables (<span className="mono">$environment</span>, <span className="mono">$run</span>, …) and the dashboard time range are applied automatically.</div>
            </div>
          )}

          {!isText && tab === 'display' && (
            <div className="stack" style={{ gap: 10 }}>
              <Field label="Description" hint="Shown as an info tooltip in the panel header.">
                <input className="input" value={draft.options.description ?? ''} onChange={(e) => setO({ description: e.target.value || undefined })} aria-label="Description" />
              </Field>
              <div className="form-grid">
                <Field label="Unit">
                  <select className="select" value={draft.options.unit ?? ''} onChange={(e) => setO({ unit: e.target.value || undefined })} aria-label="Unit">
                    {UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                  </select>
                </Field>
                <Field label="Decimals">
                  <input className="input" type="number" min={0} max={6} placeholder="Auto" value={draft.options.decimals ?? ''} onChange={(e) => setO({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })} aria-label="Decimals" />
                </Field>
                <Field label="Better when">
                  <select className="select" value={draft.options.better ?? ''} onChange={(e) => setO({ better: e.target.value || undefined })} aria-label="Better when">
                    <option value="">Auto (from metric)</option><option value="lower">Lower</option><option value="higher">Higher</option>
                  </select>
                </Field>
                <Field label="Legend">
                  <select className="select" value={draft.options.showLegend == null ? '' : String(draft.options.showLegend)} onChange={(e) => setO({ showLegend: e.target.value === '' ? undefined : e.target.value === 'true' })} aria-label="Legend">
                    <option value="">Auto (≥ 2 series)</option><option value="true">Show</option><option value="false">Hide</option>
                  </select>
                </Field>
              </div>
              <div className="field">
                <label>Thresholds</label>
                <div className="form-grid">
                  <div className="thr warn"><span>Warning</span><input className="input" type="number" value={th('warning') ?? ''} onChange={(e) => setTh('warning', e.target.value)} aria-label="Warning threshold" /></div>
                  <div className="thr crit"><span>Critical</span><input className="input" type="number" value={th('critical') ?? ''} onChange={(e) => setTh('critical', e.target.value)} aria-label="Critical threshold" /></div>
                </div>
                <span className="muted" style={{ fontSize: 11 }}>Stat panels show a status label; charts draw reference lines.</span>
              </div>
              {CHARTY.includes(draft.type) && (
                <div className="field">
                  <label>Series colour (single series)</label>
                  <div className="swatches">
                    <button className={`swatch auto ${draft.options.colorSlot == null ? 'on' : ''}`} onClick={() => setO({ colorSlot: undefined })} title="Automatic (follows the metric)">A</button>
                    {CATEGORICAL[theme].map((c, i) => <button key={c} className={`swatch ${draft.options.colorSlot === i ? 'on' : ''}`} style={{ background: c }} onClick={() => setO({ colorSlot: i })} aria-label={`Colour ${i + 1}`} />)}
                  </div>
                </div>
              )}
              {['bar', 'stacked_bar', 'histogram', 'endpoint_ranking', 'transaction_ranking'].includes(draft.type) && (
                <div className="row">
                  <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={draft.options.horizontal ?? ['endpoint_ranking', 'transaction_ranking'].includes(draft.type)} onChange={(e) => setO({ horizontal: e.target.checked })} />Horizontal</label>
                  <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={draft.options.stacked ?? draft.type === 'stacked_bar'} onChange={(e) => setO({ stacked: e.target.checked })} />Stacked</label>
                </div>
              )}
              {['gauge', 'sla_gauge'].includes(draft.type) && (
                <Field label="Gauge maximum"><input className="input" type="number" value={draft.options.max ?? 100} onChange={(e) => setO({ max: Number(e.target.value) || 100 })} aria-label="Gauge maximum" /></Field>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
