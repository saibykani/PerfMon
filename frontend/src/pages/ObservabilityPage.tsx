import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Bookmark, Compass, FileText, Link2, Plus, Settings2, Trash2, X } from 'lucide-react';
import { api } from '@/services/api';
import { Card, Field, Modal, PageHeader } from '@/components/ui';
import { Drawer, Toaster, friendlyError, toast } from '@/components/inventory/common';
import { useObsFilters, useObsRange } from '@/stores/obsFilters';
import { ObsFilterBar } from '@/components/observability/ObsFilterBar';
import { MetricPicker, ObsPanel, newPanelId, type PanelCfg } from '@/components/observability/ObsPanel';
import { PRESETS, StatsTable, availablePanels } from '@/components/observability/ObsWindow';
import { CollectionPanel } from '@/components/observability/CollectionPanel';
import { metricIndex, useObsInventory, type ObsQuery } from '@/components/observability/obsApi';
import { decodePanels, deleteView, encodePanels, loadViews, saveView, type SavedView } from '@/components/observability/obsViews';
import { apiFilterParams, formatDateTime, rangeLabel, toIso, tzLabel, writeUrlState } from '@/components/observability/obsTime';
import '@/styles/inventory.css';
import '@/styles/observability.css';

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok; } catch { return false; }
  }
}

export function ObservabilityPage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { time, tz, filters } = useObsFilters();
  const { from, to } = useObsRange();
  const inv = useObsInventory(from, to);
  const defs = useMemo(() => metricIndex(inv.data), [inv.data]);
  const metrics = inv.data?.metrics ?? [];
  const q: ObsQuery = useMemo(() => ({ from, to, filters }), [from, to, filters]);

  // panels ⇄ URL (`panels=`), restored on load and on back/forward
  const panelsParam = sp.get('panels');
  const [panels, setPanels] = useState<PanelCfg[]>(() => decodePanels(panelsParam, newPanelId) ?? []);
  const lastWritten = useRef<string | null>(panelsParam);
  useEffect(() => {
    if (panelsParam === lastWritten.current) return;
    lastWritten.current = panelsParam;
    setPanels(decodePanels(panelsParam, newPanelId) ?? []);
  }, [panelsParam]);
  useEffect(() => {
    const enc = panels.length ? encodePanels(panels) : null;
    if (enc === lastWritten.current) return;
    lastWritten.current = enc;
    const p = new URLSearchParams(window.location.search);
    if (enc) p.set('panels', enc); else p.delete('panels');
    nav({ search: p.toString() }, { replace: true });
  }, [panels, nav]);

  const [picking, setPicking] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const collection = sp.get('collection') === '1';
  const setCollection = (open: boolean) => {
    const p = new URLSearchParams(window.location.search);
    if (open) p.set('collection', '1'); else p.delete('collection');
    nav({ search: p.toString() }, { replace: true });
  };

  const add = (ps: PanelCfg[]) => setPanels((cur) => [...cur, ...ps]);
  const update = (p: PanelCfg) => setPanels((cur) => cur.map((x) => (x.id === p.id ? p : x)));
  const move = (id: string, dir: -1 | 1) => setPanels((cur) => {
    const i = cur.findIndex((x) => x.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return cur;
    const n = [...cur]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const allMetrics = [...new Set(panels.flatMap((p) => p.metrics))];

  const copyLink = async (fixed: boolean) => {
    let href = window.location.href;
    if (fixed) {
      const st = useObsFilters.getState();
      const p = writeUrlState({ ...st, time: { mode: 'absolute', from, to } }, window.location.search);
      p.delete('collection');
      href = `${window.location.origin}${window.location.pathname}?${p}`;
    }
    (await copy(href)) ? toast.success(fixed ? 'Link with fixed times copied' : 'Link copied') : toast.error('Could not access the clipboard');
  };

  return (
    <div className="obs-page">
      <Toaster />
      <PageHeader title={<span className="row" style={{ gap: 8 }}><Compass size={18} />Observability Explorer</span>}
        subtitle="Hosts, load generators, databases, services, JVMs, Kubernetes and test runs on one time axis — any window, to the minute."
        actions={<>
          <button className="btn" onClick={() => setPicking(true)}><Plus size={14} />Add panel</button>
          <ViewsMenu onCopyFixed={() => copyLink(true)} />
          <button className="btn" onClick={() => copyLink(false)} title="Copy a shareable link to this view"><Link2 size={14} />Copy link</button>
          <button className="btn" onClick={() => setCollection(true)} title="Continuous collection"><Settings2 size={14} /><span className="obs-hide-sm">Collection</span></button>
          <button className="btn btn-primary" onClick={() => setReportOpen(true)} disabled={!allMetrics.length} title={allMetrics.length ? 'Generate a report for this window' : 'Add a panel first'}><FileText size={14} />Generate report</button>
        </>} />

      <ObsFilterBar />

      <div className="obs-quickviews" aria-label="Quick views">
        <span className="muted small">Quick views</span>
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} className="btn btn-sm" onClick={() => add(availablePanels(p.panels(), metrics).length ? availablePanels(p.panels(), metrics) : p.panels())}><Plus size={12} />{p.label}</button>
        ))}
        {panels.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setPanels([])}><X size={12} />Clear panels</button>}
      </div>

      {!panels.length ? (
        <Card>
          <div className="empty">
            <div style={{ marginBottom: 8 }}><Compass size={22} /></div>
            <b>Start exploring</b>
            <div className="muted" style={{ margin: '4px 0 10px' }}>Add a panel with any metric, or pick a quick view above. Drag across a chart to zoom the whole page to that range.</div>
            <button className="btn btn-primary" onClick={() => setPicking(true)}><Plus size={14} />Add panel</button>
            {metrics.length > 0 && <div className="muted small" style={{ marginTop: 8 }}>{metrics.length} metrics have data in {rangeLabel(time, tz).toLowerCase()}.</div>}
          </div>
        </Card>
      ) : (
        <div className="obs-grid">
          {panels.map((p, i) => (
            <ObsPanel key={p.id} showMarkers={i === 0} panel={p} q={q} defs={defs} metrics={metrics} group="obs-explorer" onChange={update}
              onRemove={() => setPanels((cur) => cur.filter((x) => x.id !== p.id))} onMove={(d) => move(p.id, d)} />
          ))}
        </div>
      )}
      {panels.length > 0 && <div className="muted small obs-hint">Tip: drag horizontally on any chart to zoom all panels; times are {tzLabel(tz)}. Shaded bands are test runs, dashed lines are events — click to open.</div>}

      {panels.length > 0 && <StatsTable q={q} panels={panels} defs={defs} />}

      <MetricPicker open={picking} onClose={() => setPicking(false)} value={[]} metrics={metrics} title="Add a panel"
        onApply={(m) => add([{ id: newPanelId(), metrics: m, agg: 'avg', groupBy: 'entity', step: 'auto' }])} />
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} from={from} to={to} metrics={allMetrics} />
      <Drawer open={collection} onClose={() => setCollection(false)} title="Continuous collection" icon={<Settings2 size={16} />} subtitle="Import metrics on a timer, independent of test runs" width={560}>
        <CollectionPanel />
      </Drawer>
    </div>
  );
}

/* ------------------------------------------------------------------ saved views */

function ViewsMenu({ onCopyFixed }: { onCopyFixed: () => void }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setViews(loadViews()); }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const save = () => {
    if (!name.trim()) return;
    const p = new URLSearchParams(window.location.search); p.delete('collection');
    setViews(saveView(name, p.toString()));
    toast.success(`View “${name.trim()}” saved in this browser`);
    setName('');
  };
  return (
    <div className="obs-pop-wrap" ref={ref}>
      <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}><Bookmark size={14} />Views</button>
      {open && (
        <div className="obs-pop obs-views" role="dialog">
          <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <input className="input" placeholder="Name this view…" value={name} onChange={(e) => setName(e.target.value)} aria-label="View name" />
            <button className="btn btn-primary btn-sm" disabled={!name.trim()}>Save</button>
          </form>
          <div className="obs-pop-title">Saved views</div>
          {!views.length && <div className="muted small">No saved views yet. Views keep the window, filters and panels.</div>}
          {views.map((v) => (
            <div key={v.name} className="obs-view-item">
              <button className="obs-view-load" onClick={() => { nav(`/observability?${v.search}`); setOpen(false); }}>
                <b>{v.name}</b><span className="muted small">{new Date(v.savedAt).toLocaleString()}</span>
              </button>
              <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete view ${v.name}`} onClick={() => setViews(deleteView(v.name))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => { onCopyFixed(); setOpen(false); }}><Link2 size={13} />Copy link with fixed times</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ report */

function ReportDialog({ open, onClose, from, to, metrics }: { open: boolean; onClose: () => void; from: number; to: number; metrics: string[] }) {
  const nav = useNavigate();
  const { tz, filters } = useObsFilters();
  const def = `Observability — ${formatDateTime(from, tz)} → ${formatDateTime(to, tz)} ${tzLabel(tz, to)}`;
  const [title, setTitle] = useState(def);
  useEffect(() => { if (open) setTitle(def); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = useMutation({
    mutationFn: () => {
      const t = title.trim() || def;
      const projectId = filters.projectId?.length === 1 ? filters.projectId[0] : undefined;
      return api.post<{ id: string }>('/reports', {
        type: 'OBSERVABILITY', title: t, ...(projectId ? { projectId } : {}),
        params: { from: toIso(from), to: toIso(to), filters: apiFilterParams(filters), metrics, title: t },
      });
    },
    onSuccess: (r) => { toast.success('Report queued — it will be ready in a few seconds'); onClose(); nav(`/reports/${r.id}`); },
    onError: (e) => toast.error(friendlyError(e)),
  });
  return (
    <Modal open={open} onClose={onClose} title="Generate observability report" width={520}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}><FileText size={14} />{create.isPending ? 'Generating…' : 'Generate'}</button></>}>
      <div className="stack">
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <div className="small">
          <div><span className="muted">Window</span> <span className="mono">{formatDateTime(from, tz, true)} → {formatDateTime(to, tz, true)}</span> {tzLabel(tz, to)}</div>
          <div><span className="muted">Metrics</span> {metrics.length} ({metrics.slice(0, 6).join(', ')}{metrics.length > 6 ? '…' : ''})</div>
          <div><span className="muted">Filters</span> {Object.keys(apiFilterParams(filters)).length ? Object.entries(apiFilterParams(filters)).map(([k, v]) => `${k}=${v.split(',').length}`).join(', ') : 'none'}</div>
        </div>
        <div className="muted small">The report captures the exact window (relative ranges are frozen at generation time) and is available as PDF, HTML, XLSX, CSV and JSON.</div>
      </div>
    </Modal>
  );
}
