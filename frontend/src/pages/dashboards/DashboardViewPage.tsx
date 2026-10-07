import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  Check, ChevronRight, Copy, Download, Globe2, LayoutGrid, Link2, Lock, MoreHorizontal, Pencil, Plus, Save, Settings2, Share2, Trash2, Variable as VarIcon, X,
} from 'lucide-react';
import { api, ApiError, download } from '@/services/api';
import { useAuth } from '@/stores/auth';
import type { TimeRange } from '@/stores/filters';
import { ConfirmDialog, ErrorBox, Field, Loading, Modal } from '@/components/ui';
import { fmtDate } from '@/components/format';
import { PanelFrame } from '@/components/dashboard/PanelFrame';
import { PanelEditor } from '@/components/dashboard/PanelEditor';
import { WidgetCatalog } from '@/components/dashboard/WidgetCatalog';
import { VariablesEditor } from '@/components/dashboard/VariablesEditor';
import { DashTimePicker, RefreshControl, VariableBar } from '@/components/dashboard/Controls';
import { newPanelId, panelFromWidget } from '@/components/dashboard/catalog';
import { useDashboardQuery } from '@/components/dashboard/useDashboardQuery';
import { refreshToSec, type Dashboard, type DashboardBody, type Panel, type VarValues } from '@/components/dashboard/types';
import '@/styles/dashboards.css';

const Grid = WidthProvider(Responsive);
const ROW_H = 40;
const MARGIN: [number, number] = [12, 12];

const toBody = (d: Dashboard): DashboardBody => ({
  name: d.name, description: d.description, projectId: d.projectId, tags: d.tags ?? [], timeRange: d.timeRange, refreshInterval: d.refreshInterval,
  isShared: d.isShared, panels: d.panels, variables: d.variables,
});

/** Normalise server payloads (missing arrays, string grids) so the builder never crashes on partial data. */
function normalise(d: Dashboard): Dashboard {
  return {
    ...d,
    tags: d.tags ?? [],
    variables: d.variables ?? [],
    panels: (d.panels ?? []).map((p, i) => ({
      ...p,
      id: p.id || newPanelId(),
      options: p.options ?? {},
      query: p.query ?? { source: 'kpi' },
      grid: { x: Number(p.grid?.x ?? (i % 2) * 6), y: Number(p.grid?.y ?? Math.floor(i / 2) * 7), w: Number(p.grid?.w ?? 6), h: Number(p.grid?.h ?? 7) },
    })),
  };
}

function readVars(sp: URLSearchParams, d: Dashboard | undefined): VarValues {
  const out: VarValues = {};
  for (const v of d?.variables ?? []) {
    const all = sp.getAll(`var-${v.name}`);
    if (all.length) out[v.name] = v.multi ? all.filter((x) => x !== 'All') : all[0] === 'All' ? null : all[0];
    else out[v.name] = v.defaultValue ? (v.multi ? [v.defaultValue] : v.defaultValue) : null;
  }
  return out;
}

function readTime(sp: URLSearchParams, d: Dashboard | undefined): TimeRange {
  if (sp.get('run')) return { type: 'run', runId: sp.get('run')! };
  if (sp.get('from') && sp.get('to')) return { type: 'absolute', from: Number(sp.get('from')), to: Number(sp.get('to')) };
  if (sp.get('range')) return { type: 'relative', value: sp.get('range')! };
  const t = d?.timeRange as any;
  if (t && typeof t === 'object' && t.type) return t;
  if (typeof t === 'string') return { type: 'relative', value: t };
  return { type: 'relative', value: '24h' };
}

export function DashboardViewPage() {
  const { uid } = useParams<{ uid: string }>();
  if (uid === 'new') return <CreateDashboard />;
  return <DashboardView uid={uid!} />;
}

/** /dashboards/new → create an empty dashboard and open it in edit mode. */
function CreateDashboard() {
  const nav = useNavigate();
  const started = useRef(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.post<Dashboard>('/dashboards', { name: 'Untitled dashboard', tags: [], panels: [], variables: [], timeRange: { type: 'relative', value: '24h' }, refreshInterval: null, isShared: false })
      .then((d) => nav(`/dashboards/${d.uid}?edit=1`, { replace: true }))
      .catch(setErr);
  }, [nav]);
  return <div className="dash-page">{err ? <ErrorBox error={err} /> : <div className="stack"><Loading height={48} /><Loading height={320} /></div>}</div>;
}

function DashboardView({ uid }: { uid: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const can = useAuth((s) => s.can);
  const canEdit = can('EDIT_DASHBOARD');
  const canCreate = can('CREATE_DASHBOARD');
  const canDelete = can('DELETE_DASHBOARD');

  const dq = useQuery({ queryKey: ['dashboard', uid], queryFn: async () => normalise(await api.get<Dashboard>(`/dashboards/${uid}`)) });
  const saved = dq.data;
  const editing = sp.get('edit') === '1' && canEdit;
  const [draft, setDraft] = useState<Dashboard | null>(null);
  useEffect(() => { if (editing && saved && !draft) setDraft(structuredClone(saved)); if (!editing) setDraft(null); }, [editing, saved, draft]);
  const dash = (editing ? draft : saved) ?? saved;
  const dirty = editing && !!draft && !!saved && JSON.stringify(toBody(draft)) !== JSON.stringify(toBody(saved));

  const vars = useMemo(() => readVars(sp, dash), [sp, dash?.variables]); // eslint-disable-line react-hooks/exhaustive-deps
  const timeRange = useMemo(() => readTime(sp, saved), [sp, saved]);
  const refreshSec = sp.has('refresh') ? (Number(sp.get('refresh')) || null) : refreshToSec(saved?.refreshInterval);
  const runKey = (typeof vars.run === 'string' && vars.run) || (timeRange.type === 'run' ? timeRange.runId ?? null : null);

  const patchParams = useCallback((fn: (p: URLSearchParams) => void) => {
    setSp((prev) => { const p = new URLSearchParams(prev); fn(p); return p; }, { replace: true });
  }, [setSp]);
  const setVar = (name: string, val: string | string[] | null) => patchParams((p) => {
    p.delete(`var-${name}`);
    if (val == null) p.set(`var-${name}`, 'All');
    else (Array.isArray(val) ? val : [val]).forEach((x) => p.append(`var-${name}`, x));
  });
  const setTime = (t: TimeRange) => patchParams((p) => {
    ['run', 'from', 'to', 'range'].forEach((k) => p.delete(k));
    if (t.type === 'run') p.set('run', t.runId || (typeof vars.run === 'string' ? vars.run : '') || '');
    else if (t.type === 'absolute') { p.set('from', String(t.from)); p.set('to', String(t.to)); }
    else p.set('range', t.value ?? '24h');
    if (t.type === 'run' && !p.get('run')) { p.delete('run'); p.set('range', '24h'); }
  });
  const setRefresh = (s: number | null) => patchParams((p) => p.set('refresh', String(s ?? 0)));

  const panels = dash?.panels ?? [];
  const results = useDashboardQuery(uid, panels, vars, timeRange, refreshSec, !!dash);

  // ---------- editing actions
  const [catalog, setCatalog] = useState(false);
  const [editPanel, setEditPanel] = useState<Panel | null>(null);
  const [varsOpen, setVarsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [moreOpen]);

  const upd = (fn: (d: Dashboard) => Dashboard) => setDraft((d) => (d ? fn(d) : d));
  const enterEdit = () => patchParams((p) => p.set('edit', '1'));
  const exitEdit = () => { setDraft(null); patchParams((p) => p.delete('edit')); };

  const save = useMutation({
    mutationFn: (d: Dashboard) => api.put<Dashboard>(`/dashboards/${uid}`, toBody(d)),
    onSuccess: (d) => {
      const n = normalise(d);
      qc.setQueryData(['dashboard', uid], n);
      qc.invalidateQueries({ queryKey: ['dashboards'] });
      setDraft(structuredClone(n));
      setToast(`Saved · version ${n.version}`);
    },
  });
  const doSave = () => { if (draft) save.mutate(draft); };

  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) doSave(); } };
    const unload = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', key);
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('beforeunload', unload); };
  }); // re-bind each render so the closure sees the current draft

  const del = useMutation({
    mutationFn: () => api.del(`/dashboards/${uid}`, { confirm: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dashboards'] }); nav('/dashboards'); },
  });
  const toggleShare = useMutation({
    mutationFn: () => api.put<Dashboard>(`/dashboards/${uid}`, { ...toBody(saved!), isShared: !saved!.isShared }),
    onSuccess: (d) => { const n = normalise(d); qc.setQueryData(['dashboard', uid], n); if (draft) setDraft((x) => x && { ...x, isShared: n.isShared, version: n.version }); },
  });

  const onLayout = (layout: Layout[]) => {
    if (!editing || !draft) return;
    const byId = new Map(layout.map((l) => [l.i, l]));
    let changed = false;
    const next = draft.panels.map((p) => {
      const l = byId.get(p.id);
      if (!l) return p;
      if (l.x !== p.grid.x || l.y !== p.grid.y || l.w !== p.grid.w || l.h !== p.grid.h) { changed = true; return { ...p, grid: { x: l.x, y: l.y, w: l.w, h: l.h } }; }
      return p;
    });
    if (changed) setDraft({ ...draft, panels: next });
  };
  const [bp, setBp] = useState('lg');

  if (dq.isLoading) return <div className="dash-page"><div className="stack"><Loading height={56} /><div className="dash-skel">{Array.from({ length: 6 }).map((_, i) => <Loading key={i} height={i < 2 ? 120 : 260} />)}</div></div></div>;
  if (dq.error || !dash) {
    const nf = dq.error instanceof ApiError && dq.error.status === 404;
    return (
      <div className="dash-page">
        <div className="dash-empty card">
          <LayoutGrid size={28} />
          <h2>{nf ? 'Dashboard not found' : 'Could not load dashboard'}</h2>
          <p className="muted">{nf ? `No dashboard with id “${uid}” exists, or you don’t have access to it.` : (dq.error as Error)?.message}</p>
          <Link className="btn btn-primary" to="/dashboards">Back to dashboards</Link>
        </div>
      </div>
    );
  }

  const layouts = { lg: panels.map((p) => ({ i: p.id, ...p.grid, minW: 2, minH: 2 })) };
  const group = `dash-${uid}`;
  const panelProps = (p: Panel) => ({
    onEdit: () => { if (!editing) enterEdit(); setEditPanel(p); },
    onDuplicate: () => {
      if (!editing) return;
      upd((d) => ({ ...d, panels: [...d.panels, { ...structuredClone(p), id: newPanelId(), title: `${p.title} (copy)`, grid: { ...p.grid, y: p.grid.y + p.grid.h } }] }));
    },
    onRemove: () => upd((d) => ({ ...d, panels: d.panels.filter((x) => x.id !== p.id) })),
  });

  return (
    <div className={`dash-page ${editing ? 'is-editing' : ''}`}>
      <div className="dash-head">
        <div className="dash-title-block">
          <div className="crumbs"><Link to="/dashboards">Dashboards</Link><ChevronRight size={12} />{dash.isSystem ? 'System' : dash.isShared ? 'Shared' : 'Private'}</div>
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            {editing ? (
              <input className="dash-name-input" value={dash.name} onChange={(e) => upd((d) => ({ ...d, name: e.target.value }))} aria-label="Dashboard name" />
            ) : <h1 className="dash-name">{dash.name}</h1>}
            {dash.isSystem && <span className="badge accent" title="System dashboard (seeded by Perfmon)"><Lock size={10} />System</span>}
            {dash.isShared && <span className="badge info"><Globe2 size={10} />Shared</span>}
            <span className="badge" title={`Last updated ${fmtDate(saved?.updatedAt)}`}>v{saved?.version ?? 1}</span>
            {dirty && <span className="badge warn" title="Unsaved changes">● Unsaved</span>}
          </div>
          {dash.description && !editing && <div className="dash-desc">{dash.description}</div>}
        </div>
        <div className="dash-actions">
          {editing ? (
            <>
              <button className="btn" onClick={() => setCatalog(true)} data-testid="add-panel"><Plus size={14} />Add panel</button>
              <button className="btn" onClick={() => setVarsOpen(true)}><VarIcon size={14} />Variables{dash.variables.length ? <span className="tab-badge">{dash.variables.length}</span> : null}</button>
              <button className="btn" onClick={() => setSettingsOpen(true)}><Settings2 size={14} />Settings</button>
              <span className="divider-v" />
              <button className="btn" onClick={() => (dirty ? setConfirmDiscard(true) : exitEdit())}><X size={14} />{dirty ? 'Discard' : 'Done'}</button>
              <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={doSave} data-testid="save-dashboard" title="Save (Ctrl+S)">
                {save.isPending ? <span className="spinner" /> : <Save size={14} />}Save
              </button>
            </>
          ) : (
            <>
              {canEdit && <button className="btn" onClick={enterEdit} data-testid="edit-dashboard"><Pencil size={14} />Edit</button>}
              <button className="btn" onClick={() => setShareOpen(true)}><Share2 size={14} />Share</button>
              <div style={{ position: 'relative' }} ref={moreRef}>
                <button className="btn icon-btn" aria-label="More actions" aria-haspopup="menu" onClick={() => setMoreOpen((v) => !v)}><MoreHorizontal size={15} /></button>
                {moreOpen && (
                  <div className="dt-menu" role="menu" style={{ minWidth: 200 }}>
                    {canCreate && <button className="dt-menu-item menu-btn" onClick={() => { setMoreOpen(false); setSaveAsOpen(true); }}><Copy size={13} />Save as copy…</button>}
                    <button className="dt-menu-item menu-btn" onClick={() => { setMoreOpen(false); download(`/dashboards/${uid}/export`, `${dash.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`); }}><Download size={13} />Export JSON</button>
                    {canEdit && <button className="dt-menu-item menu-btn" onClick={() => { setMoreOpen(false); enterEdit(); setSettingsOpen(true); }}><Settings2 size={13} />Settings</button>}
                    {canDelete && <><div className="menu-sep" /><button className="dt-menu-item menu-btn danger" onClick={() => { setMoreOpen(false); setConfirmDelete(true); }}><Trash2 size={13} />Delete</button></>}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="dash-toolbar">
        <VariableBar variables={dash.variables} values={vars} onChange={setVar} projectId={dash.projectId} />
        {!dash.variables.length && editing && <button className="btn btn-sm btn-ghost muted" onClick={() => setVarsOpen(true)}><VarIcon size={13} />Add variables to filter every panel</button>}
        <div className="spacer" />
        <DashTimePicker value={timeRange} onChange={setTime} runId={typeof vars.run === 'string' ? vars.run : null} />
        <RefreshControl value={refreshSec} onChange={setRefresh} onRefresh={() => results.refetch()} fetching={results.isFetching} />
      </div>

      {save.error && <div style={{ marginBottom: 10 }}><ErrorBox error={save.error} /></div>}
      {results.error && <div style={{ marginBottom: 10 }}><ErrorBox error={results.error} /></div>}

      {!panels.length ? (
        <div className="dash-empty card">
          <div className="dash-empty-art"><LayoutGrid size={30} /></div>
          <h2>{editing ? 'Start building your dashboard' : 'This dashboard has no panels yet'}</h2>
          <p className="muted">Add KPIs, time series, rankings, heatmaps and notes. Panels share variables and the time range, and update together.</p>
          {canEdit && <button className="btn btn-primary" onClick={() => { if (!editing) enterEdit(); setCatalog(true); }} data-testid="add-first-panel"><Plus size={14} />Add your first panel</button>}
        </div>
      ) : (
        <Grid
          className={`dash-grid ${editing ? 'editing' : ''}`}
          layouts={layouts}
          breakpoints={{ lg: 860, sm: 0 }}
          cols={{ lg: 12, sm: 1 }}
          rowHeight={ROW_H}
          margin={MARGIN}
          containerPadding={[0, 0]}
          isDraggable={editing && bp === 'lg'}
          isResizable={editing && bp === 'lg'}
          draggableHandle=".panel-drag"
          draggableCancel=".no-drag"
          resizeHandles={['se']}
          onBreakpointChange={(b) => setBp(b)}
          onLayoutChange={(l) => bp === 'lg' && onLayout(l)}
          useCSSTransforms
          measureBeforeMount={false}
        >
          {panels.map((p) => (
            <div key={p.id}>
              <PanelFrame panel={p} result={results.data?.[p.id]} loading={results.isFetching} editing={editing} canEdit={canEdit} group={group} runKey={runKey} {...panelProps(p)} />
            </div>
          ))}
        </Grid>
      )}

      {editing && panels.length > 0 && (
        <button className="dash-add-tile" onClick={() => setCatalog(true)}><Plus size={16} />Add panel</button>
      )}

      {toast && <div className="toast" role="status"><Check size={14} />{toast}</div>}

      <WidgetCatalog open={catalog} onClose={() => setCatalog(false)} onPick={(w) => {
        if (!draft) return;
        const p = panelFromWidget(w, draft.panels);
        setDraft({ ...draft, panels: [...draft.panels, p] });
        setCatalog(false);
        setEditPanel(p);
        setTimeout(() => document.querySelector(`[data-panel-id="${p.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
      }} />
      <PanelEditor panel={editPanel} vars={vars} timeRange={timeRange} group={group} onClose={() => setEditPanel(null)}
        onApply={(p) => { upd((d) => ({ ...d, panels: d.panels.some((x) => x.id === p.id) ? d.panels.map((x) => (x.id === p.id ? p : x)) : [...d.panels, p] })); setEditPanel(null); }} />
      <VariablesEditor open={varsOpen} variables={dash.variables} onClose={() => setVarsOpen(false)} onApply={(v) => { upd((d) => ({ ...d, variables: v })); setVarsOpen(false); }} />
      {settingsOpen && draft && <SettingsModal dash={draft} onClose={() => setSettingsOpen(false)} onApply={(patch) => { upd((d) => ({ ...d, ...patch })); setSettingsOpen(false); }} />}
      {shareOpen && saved && <ShareModal dash={saved} canEdit={canEdit} onToggle={() => toggleShare.mutate()} pending={toggleShare.isPending} error={toggleShare.error} onClose={() => setShareOpen(false)} />}
      {saveAsOpen && dash && <SaveAsModal dash={dash} onClose={() => setSaveAsOpen(false)} onDone={(d) => { setSaveAsOpen(false); qc.invalidateQueries({ queryKey: ['dashboards'] }); nav(`/dashboards/${d.uid}`); }} />}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete dashboard"
        message={<>Permanently delete <b>{dash.name}</b>? Panels and variables are removed for everyone. Export it first if you may need it again.</>}
        requireText={dash.isSystem ? dash.name : undefined} onConfirm={() => del.mutate()} />
      <ConfirmDialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="Discard changes" confirmLabel="Discard"
        message="You have unsaved changes to this dashboard. Discard them and leave edit mode?" onConfirm={exitEdit} />
    </div>
  );
}

function SettingsModal({ dash, onClose, onApply }: { dash: Dashboard; onClose: () => void; onApply: (p: Partial<Dashboard>) => void }) {
  const [name, setName] = useState(dash.name);
  const [description, setDescription] = useState(dash.description ?? '');
  const [tags, setTags] = useState((dash.tags ?? []).join(', '));
  const [projectId, setProjectId] = useState(dash.projectId ?? '');
  const [range, setRange] = useState((dash.timeRange as any)?.value ?? '24h');
  const [refresh, setRefresh] = useState(String(refreshToSec(dash.refreshInterval) ?? 0));
  const projects = useQuery({ queryKey: ['projects', {}], queryFn: () => api.get<any[]>('/projects'), staleTime: 60000 });
  return (
    <Modal open onClose={onClose} title="Dashboard settings" width={560}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onApply({
          name: name.trim(), description: description || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), projectId: projectId || null,
          timeRange: { type: 'relative', value: range }, refreshInterval: Number(refresh) || null,
        })}>Apply</button></>}>
      <div className="stack">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Description"><textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Tags" hint="Comma-separated, e.g. payments, sre, release"><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <div className="form-grid">
          <Field label="Project">
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Default time range">
            <select className="select" value={range} onChange={(e) => setRange(e.target.value)}>
              {['15m', '1h', '6h', '24h', '7d', '30d', '90d'].map((r) => <option key={r} value={r}>Last {r}</option>)}
            </select>
          </Field>
          <Field label="Default auto refresh">
            <select className="select" value={refresh} onChange={(e) => setRefresh(e.target.value)}>
              {[0, 10, 30, 60, 300].map((s) => <option key={s} value={s}>{s ? `${s < 60 ? `${s}s` : `${s / 60}m`}` : 'Off'}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ShareModal({ dash, canEdit, onToggle, pending, error, onClose }: { dash: Dashboard; canEdit: boolean; onToggle: () => void; pending: boolean; error: unknown; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const url = new URL(window.location.href);
  url.searchParams.delete('edit');
  const withState = url.toString();
  const plain = `${window.location.origin}/dashboards/${dash.uid}`;
  const copy = async (s: string) => { try { await navigator.clipboard.writeText(s); } catch { /* clipboard blocked */ } setCopied(s); setTimeout(() => setCopied(null), 1600); };
  return (
    <Modal open onClose={onClose} title="Share dashboard" width={560}>
      <div className="stack">
        <div className="share-row">
          <div className={`share-ico ${dash.isShared ? 'on' : ''}`}>{dash.isShared ? <Globe2 size={16} /> : <Lock size={16} />}</div>
          <div style={{ flex: 1 }}>
            <b>{dash.isShared ? 'Shared with your organisation' : 'Private to you'}</b>
            <div className="muted" style={{ fontSize: 12 }}>{dash.isShared ? 'Everyone in the organisation with view access can open it.' : 'Only you (and admins) can open this dashboard.'}</div>
          </div>
          {canEdit && <button className="btn btn-sm" disabled={pending} onClick={onToggle}>{dash.isShared ? 'Make private' : 'Share with org'}</button>}
        </div>
        <ErrorBox error={error} />
        <Field label="Link with current variables & time range">
          <div className="row"><input className="input mono" readOnly value={withState} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => copy(withState)}>{copied === withState ? <Check size={14} /> : <Link2 size={14} />}{copied === withState ? 'Copied' : 'Copy'}</button></div>
        </Field>
        <Field label="Plain link">
          <div className="row"><input className="input mono" readOnly value={plain} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => copy(plain)}>{copied === plain ? <Check size={14} /> : <Link2 size={14} />}{copied === plain ? 'Copied' : 'Copy'}</button></div>
        </Field>
      </div>
    </Modal>
  );
}

function SaveAsModal({ dash, onClose, onDone }: { dash: Dashboard; onClose: () => void; onDone: (d: Dashboard) => void }) {
  const [name, setName] = useState(`${dash.name} (copy)`);
  const m = useMutation({ mutationFn: () => api.post<Dashboard>('/dashboards', { ...toBody(dash), name: name.trim(), isShared: false }), onSuccess: onDone });
  return (
    <Modal open onClose={onClose} title="Save as copy" width={460}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}><Copy size={14} />Create copy</button></>}>
      <div className="stack">
        <Field label="New dashboard name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="muted" style={{ fontSize: 12 }}>The copy includes all panels and variables{dash.isSystem ? ' (system dashboards stay untouched)' : ''} and starts private.</div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
