import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, FileJson, Globe2, LayoutDashboard, LayoutGrid, List, Lock, MoreHorizontal, Plus, Search, Tag, Trash2, Upload, X } from 'lucide-react';
import { api, download } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { useFilters } from '@/stores/filters';
import { ConfirmDialog, ErrorBox, Field, Modal, PageHeader } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { fmtDate } from '@/components/format';
import type { Dashboard, DashboardSummary } from '@/components/dashboard/types';
import '@/styles/dashboards.css';

const rel = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return fmtDate(iso);
};

/** Tiny deterministic grid thumbnail so cards are recognisable at a glance. */
function Thumb({ seed, count }: { seed: string; count: number }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const cells = Math.min(Math.max(count, 3), 7);
  const widths = Array.from({ length: cells }, (_, i) => [3, 4, 6, 12, 6, 4, 8][(h >> (i * 3)) % 7]);
  return (
    <div className="dash-thumb" aria-hidden>
      {widths.map((w, i) => <span key={i} style={{ gridColumn: `span ${w}`, opacity: 0.35 + ((h >> i) % 5) * 0.12 }} className={i < 2 ? 'kpi-cell' : ''} />)}
    </div>
  );
}

export function DashboardsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const projectId = useFilters((s) => s.projectId);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'system' | 'mine'>('all');
  const [mode, setMode] = useState<'grid' | 'list'>(() => { try { return (localStorage.getItem('perfmon.dash.mode') as any) || 'grid'; } catch { return 'grid'; } });
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toDelete, setToDelete] = useState<DashboardSummary | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['dashboards', projectId], queryFn: () => api.get<DashboardSummary[]>('/dashboards', { projectId }) });
  const all = list.data ?? [];
  const tags = useMemo(() => [...new Set(all.flatMap((d) => d.tags ?? []))].sort(), [all]);
  const shown = useMemo(() => all.filter((d) => {
    if (scope === 'system' && !d.isSystem) return false;
    if (scope === 'mine' && d.isSystem) return false;
    if (tag && !(d.tags ?? []).includes(tag)) return false;
    if (q && !`${d.name} ${d.description ?? ''} ${(d.tags ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [all, q, tag, scope]);

  const clone = useMutation({
    mutationFn: (d: DashboardSummary) => api.post<Dashboard>(`/dashboards/${d.uid}/clone`, { name: `${d.name} (copy)` }),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ['dashboards'] }); nav(`/dashboards/${d.uid}?edit=1`); },
  });
  const del = useMutation({
    mutationFn: (d: DashboardSummary) => api.del(`/dashboards/${d.uid}`, { confirm: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboards'] }),
  });
  const setModeP = (m: 'grid' | 'list') => { setMode(m); try { localStorage.setItem('perfmon.dash.mode', m); } catch { /* ignore */ } };
  const exportOne = (d: DashboardSummary) => download(`/dashboards/${d.uid}/export`, `${d.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`);

  const actions = (d: DashboardSummary) => (
    <div className="dt-menu" role="menu" style={{ minWidth: 170, top: 30 }} onClick={(e) => e.stopPropagation()}>
      {can('CREATE_DASHBOARD') && <button className="dt-menu-item menu-btn" onClick={() => { setMenu(null); clone.mutate(d); }}><Copy size={13} />Clone</button>}
      <button className="dt-menu-item menu-btn" onClick={() => { setMenu(null); exportOne(d); }}><Download size={13} />Export JSON</button>
      {can('DELETE_DASHBOARD') && <><div className="menu-sep" /><button className="dt-menu-item menu-btn danger" onClick={() => { setMenu(null); setToDelete(d); }}><Trash2 size={13} />Delete</button></>}
    </div>
  );

  return (
    <div className="dash-list-page">
      <PageHeader title="Dashboards" subtitle="Curated system dashboards and your own boards — built on Perfmon's metric model, filtered by variables, synchronised in time."
        actions={<>
          {can('CREATE_DASHBOARD') && <button className="btn" onClick={() => setImporting(true)}><Upload size={14} />Import</button>}
          {can('CREATE_DASHBOARD') && <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="new-dashboard"><Plus size={14} />New dashboard</button>}
        </>} />

      <div className="dash-filters">
        <div className="dt-search">
          <Search size={13} />
          <input className="input" style={{ width: 280 }} placeholder="Search dashboards, descriptions, tags…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search dashboards" />
        </div>
        <div className="seg">
          {(['all', 'system', 'mine'] as const).map((s) => <button key={s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>{s === 'all' ? `All (${all.length})` : s === 'system' ? 'System' : 'Custom'}</button>)}
        </div>
        <div className="tag-row">
          {tags.slice(0, 14).map((t) => <button key={t} className={`chip ${tag === t ? 'on' : ''}`} onClick={() => setTag(tag === t ? null : t)}><Tag size={10} />{t}</button>)}
          {tag && <button className="chip" onClick={() => setTag(null)}><X size={10} />Clear</button>}
        </div>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="View mode">
          <button className={mode === 'grid' ? 'on' : ''} onClick={() => setModeP('grid')} aria-label="Grid view"><LayoutGrid size={13} /></button>
          <button className={mode === 'list' ? 'on' : ''} onClick={() => setModeP('list')} aria-label="List view"><List size={13} /></button>
        </div>
      </div>

      <ErrorBox error={list.error ?? clone.error ?? del.error} />

      {list.isLoading ? (
        <div className="dash-cards">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 178, borderRadius: 10 }} />)}</div>
      ) : !all.length && !list.error ? (
        <div className="dash-empty card">
          <div className="dash-empty-art"><LayoutDashboard size={30} /></div>
          <h2>No dashboards yet</h2>
          <p className="muted">System dashboards are created per project. Build your own board from KPIs, percentile charts, rankings and heatmaps — or import one.</p>
          <div className="row">
            {can('CREATE_DASHBOARD') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} />Create dashboard</button>}
            {can('CREATE_DASHBOARD') && <button className="btn" onClick={() => setImporting(true)}><Upload size={14} />Import JSON</button>}
          </div>
        </div>
      ) : !shown.length ? (
        <div className="dash-empty card"><Search size={24} /><h2>No matches</h2><p className="muted">Nothing matches the current search and filters.</p><button className="btn" onClick={() => { setQ(''); setTag(null); setScope('all'); }}>Clear filters</button></div>
      ) : mode === 'grid' ? (
        <div className="dash-cards">
          {shown.map((d) => (
            <div key={d.uid} className="dash-card" role="link" tabIndex={0} onClick={() => nav(`/dashboards/${d.uid}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/dashboards/${d.uid}`)} data-testid="dash-card">
              <Thumb seed={d.uid} count={d.panelCount} />
              <div className="dash-card-body">
                <div className="row" style={{ gap: 6, minWidth: 0 }}>
                  <h3 className="dash-card-title" title={d.name}>{d.name}</h3>
                  <div className="spacer" />
                  <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Actions for ${d.name}`} onClick={() => setMenu(menu === d.uid ? null : d.uid)}><MoreHorizontal size={14} /></button>
                    {menu === d.uid && <><div className="menu-scrim" onClick={() => setMenu(null)} />{actions(d)}</>}
                  </div>
                </div>
                <p className="dash-card-desc">{d.description || <span className="muted">No description</span>}</p>
                <div className="dash-card-tags">
                  {d.isSystem && <span className="badge accent"><Lock size={9} />System</span>}
                  {d.isShared && !d.isSystem && <span className="badge info"><Globe2 size={9} />Shared</span>}
                  {(d.tags ?? []).slice(0, 3).map((t) => <span key={t} className="tag">{t}</span>)}
                </div>
                <div className="dash-card-foot">
                  <span>{d.panelCount} panel{d.panelCount === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span title={fmtDate(d.updatedAt)}>Updated {rel(d.updatedAt)}</span>
                  {d.ownerName && <><span>·</span><span className="owner">{d.ownerName}</span></>}
                </div>
              </div>
            </div>
          ))}
          {can('CREATE_DASHBOARD') && (
            <button className="dash-card dash-card-new" onClick={() => setCreating(true)}><Plus size={20} /><b>New dashboard</b><span className="muted">Start from a blank grid</span></button>
          )}
        </div>
      ) : (
        <div className="card">
          <DataTable rows={shown} rowKey={(d) => d.uid} onRowClick={(d) => nav(`/dashboards/${d.uid}`)} exportName="dashboards" searchable={false}
            columns={[
              { key: 'name', header: 'Name', render: (d) => <span className="row" style={{ gap: 6 }}><Link to={`/dashboards/${d.uid}`} onClick={(e) => e.stopPropagation()}><b>{d.name}</b></Link>{d.isSystem && <span className="badge accent">System</span>}{d.isShared && !d.isSystem && <span className="badge info">Shared</span>}</span> },
              { key: 'tags', header: 'Tags', value: (d) => (d.tags ?? []).join(', '), render: (d) => <span className="row" style={{ gap: 4 }}>{(d.tags ?? []).map((t) => <span key={t} className="tag">{t}</span>)}</span> },
              { key: 'panelCount', header: 'Panels', align: 'right' },
              { key: 'ownerName', header: 'Owner' },
              { key: 'updatedAt', header: 'Updated', render: (d) => fmtDate(d.updatedAt) },
              { key: 'actions', header: '', sortable: false, render: (d) => (
                <span className="row" style={{ gap: 0, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                  {can('CREATE_DASHBOARD') && <button className="btn btn-ghost icon-btn btn-sm" title="Clone" aria-label="Clone" onClick={() => clone.mutate(d)}><Copy size={13} /></button>}
                  <button className="btn btn-ghost icon-btn btn-sm" title="Export JSON" aria-label="Export" onClick={() => exportOne(d)}><Download size={13} /></button>
                  {can('DELETE_DASHBOARD') && <button className="btn btn-ghost icon-btn btn-sm" title="Delete" aria-label="Delete" onClick={() => setToDelete(d)}><Trash2 size={13} /></button>}
                </span>
              ) },
            ]} />
        </div>
      )}

      {creating && <CreateModal projectId={projectId} onClose={() => setCreating(false)} onCreated={(d) => { qc.invalidateQueries({ queryKey: ['dashboards'] }); nav(`/dashboards/${d.uid}?edit=1`); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={(d) => { qc.invalidateQueries({ queryKey: ['dashboards'] }); nav(`/dashboards/${d.uid}`); }} />}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} title="Delete dashboard"
        message={<>Permanently delete <b>{toDelete?.name}</b> ({toDelete?.panelCount} panels)? This cannot be undone — export it first if you may need it.</>}
        requireText={toDelete?.isSystem ? toDelete.name : undefined} onConfirm={() => toDelete && del.mutate(toDelete)} />
    </div>
  );
}

function CreateModal({ projectId, onClose, onCreated }: { projectId: string | null; onClose: () => void; onCreated: (d: Dashboard) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [pid, setPid] = useState(projectId ?? '');
  const projects = useQuery({ queryKey: ['projects', {}], queryFn: () => api.get<any[]>('/projects'), staleTime: 60000 });
  const m = useMutation({
    mutationFn: () => api.post<Dashboard>('/dashboards', {
      name: name.trim(), description: description || undefined, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), projectId: pid || undefined,
      timeRange: { type: 'relative', value: '24h' }, panels: [],
      variables: [{ name: 'environment', type: 'environment', includeAll: true }, { name: 'test', type: 'test', includeAll: true }, { name: 'run', type: 'run', includeAll: false }],
    }),
    onSuccess: onCreated,
  });
  return (
    <Modal open onClose={onClose} title="New dashboard" width={520}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()} data-testid="create-dashboard"><Plus size={14} />Create & edit</button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Checkout — release readiness" aria-label="Dashboard name" /></Field>
        <Field label="Description"><textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="form-grid">
          <Field label="Project">
            <select className="select" value={pid} onChange={(e) => setPid(e.target.value)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Tags" hint="Comma-separated"><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>Starts with <span className="mono">$environment</span>, <span className="mono">$test</span> and <span className="mono">$run</span> variables — change them any time.</div>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (d: Dashboard) => void }) {
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const { parsed, parseErr } = useMemo((): { parsed: any; parseErr: string | null } => {
    if (!text.trim()) return { parsed: null, parseErr: null };
    try { const j = JSON.parse(text); return { parsed: j.dashboard ?? j, parseErr: null }; } catch (e) { return { parsed: null, parseErr: (e as Error).message }; }
  }, [text]);
  const m = useMutation({ mutationFn: () => api.post<Dashboard>('/dashboards/import', { dashboard: parsed }), onSuccess: onDone });
  const valid = parsed && typeof parsed === 'object' && typeof parsed.name === 'string';
  return (
    <Modal open onClose={onClose} title="Import dashboard" width={640}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid || m.isPending} onClick={() => m.mutate()}><Upload size={14} />Import</button></>}>
      <div className="stack">
        <div className="drop" onClick={() => file.current?.click()} onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) f.text().then(setText); }}>
          <FileJson size={22} />
          <div><b>Drop an exported dashboard JSON</b> or click to choose a file</div>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setText); }} />
        </div>
        <Field label="…or paste JSON"><textarea className="textarea mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "name": "…", "panels": [ … ], "variables": [ … ] }' /></Field>
        {parseErr && <div className="error-box">Invalid JSON: {parseErr}</div>}
        {valid && <div className="notice">Ready to import <b>{parsed.name}</b> — {(parsed.panels ?? []).length} panels, {(parsed.variables ?? []).length} variables.</div>}
        {parsed && !valid && !parseErr && <div className="error-box">This JSON doesn’t look like a Perfmon dashboard (missing “name”).</div>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
