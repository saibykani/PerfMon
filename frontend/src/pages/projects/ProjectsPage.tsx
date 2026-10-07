import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, ArchiveRestore, BellRing, FolderKanban, LayoutGrid, List, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '@/services/api';
import { PageHeader, Kpi, ConfirmDialog, ErrorBox } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtNum, fmtRelative, fmtDate } from '@/components/format';
import { useUi } from '@/stores/ui';
import { CATEGORICAL } from '@/charts/palette';
import { EmptyState, Seg, Toaster, friendlyError, toast, useCan } from '@/components/inventory/common';
import { useInvalidateInventory, useProjects, type Project } from '@/components/inventory/data';
import { ProjectForm } from '@/components/inventory/forms';

export const projectColor = (key: string, theme: 'light' | 'dark') => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CATEGORICAL[theme][h % 5 === 4 ? 6 : h % 5 === 3 ? 2 : h % 5]; // high-contrast subset for white initials
};
export const initials = (name: string) => name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export function ProjectsPage() {
  const nav = useNavigate();
  const can = useCan();
  const theme = useUi((s) => s.theme);
  const inv = useInvalidateInventory();
  const [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<'cards' | 'table'>(() => { try { return (localStorage.getItem('perfmon.projects.view') as 'cards' | 'table') ?? 'cards'; } catch { return 'cards'; } });
  const [q, setQ] = useState('');
  const [form, setForm] = useState<{ open: boolean; project?: Project | null }>({ open: false });
  const [del, setDel] = useState<Project | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const { data, isLoading, error } = useProjects(showArchived);
  const setViewP = (v: 'cards' | 'table') => { setView(v); try { localStorage.setItem('perfmon.projects.view', v); } catch { /* ignore */ } };

  const rows = useMemo(() => (data ?? []).filter((p) => !q.trim() || `${p.name} ${p.key} ${p.description ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);
  const totals = useMemo(() => (data ?? []).filter((p) => !p.archived_at).reduce((a, p) => ({
    projects: a.projects + 1, apps: a.apps + (p.applications ?? 0), tests: a.tests + (p.tests ?? 0), runs: a.runs + (p.runs ?? 0), alerts: a.alerts + (p.active_alerts ?? 0),
  }), { projects: 0, apps: 0, tests: 0, runs: 0, alerts: 0 }), [data]);

  const archive = async (p: Project, archived: boolean) => {
    try {
      await api.patch(`/projects/${p.id}`, { archived });
      inv();
      toast.success(archived ? `“${p.name}” archived` : `“${p.name}” restored`);
    } catch (e) { toast.error(friendlyError(e)); }
  };
  const remove = async (p: Project) => {
    try {
      await api.del(`/projects/${p.id}`, { confirm: p.key });
      inv();
      toast.success(`Project “${p.name}” and all its data deleted`);
    } catch (e) { toast.error(friendlyError(e)); }
  };

  const actions = (p: Project) => can('MANAGE_PROJECT') && (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Actions for ${p.name}`} aria-haspopup="menu" aria-expanded={menu === p.id} onClick={() => setMenu(menu === p.id ? null : p.id)}><MoreHorizontal size={15} /></button>
      {menu === p.id && (
        <div className="inv-menu" role="menu" onMouseLeave={() => setMenu(null)}>
          <button role="menuitem" onClick={() => { setMenu(null); setForm({ open: true, project: p }); }}><Pencil size={14} />Edit</button>
          {p.archived_at
            ? <button role="menuitem" onClick={() => { setMenu(null); archive(p, false); }}><ArchiveRestore size={14} />Restore</button>
            : <button role="menuitem" onClick={() => { setMenu(null); archive(p, true); }}><Archive size={14} />Archive</button>}
          <button role="menuitem" className="danger" onClick={() => { setMenu(null); setDel(p); }}><Trash2 size={14} />Delete…</button>
        </div>
      )}
    </div>
  );

  const columns: Column<Project>[] = [
    { key: 'name', header: 'Project', render: (p) => <span className="row"><b>{p.name}</b>{p.archived_at && <span className="badge">ARCHIVED</span>}</span> },
    { key: 'key', header: 'Key', render: (p) => <span className="inv-key">{p.key}</span> },
    { key: 'applications', header: 'Apps', align: 'right' },
    { key: 'environments', header: 'Envs', align: 'right' },
    { key: 'tests', header: 'Tests', align: 'right' },
    { key: 'runs', header: 'Runs', align: 'right', render: (p) => fmtNum(p.runs) },
    { key: 'dashboards', header: 'Dashboards', align: 'right' },
    { key: 'releases', header: 'Releases', align: 'right' },
    { key: 'active_alerts', header: 'Active alerts', align: 'right', render: (p) => (p.active_alerts ? <span className="badge fail"><BellRing size={11} />{p.active_alerts}</span> : '0') },
    { key: 'last_run_at', header: 'Last run', value: (p) => (p.last_run_at ? new Date(p.last_run_at).getTime() : null), render: (p) => <span title={fmtDate(p.last_run_at)}>{fmtRelative(p.last_run_at)}</span> },
    { key: 'actions', header: '', sortable: false, render: (p) => actions(p) },
  ];

  return (
    <div>
      <Toaster />
      <PageHeader title="Projects" subtitle="Organization → Project → Application → Environment → Performance Test → Test Run"
        actions={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true, project: null })}><Plus size={15} />New project</button>} />

      <div className="inv-kpis">
        <Kpi label="Active projects" value={isLoading ? '…' : fmtNum(totals.projects)} />
        <Kpi label="Applications" value={isLoading ? '…' : fmtNum(totals.apps)} />
        <Kpi label="Performance tests" value={isLoading ? '…' : fmtNum(totals.tests)} />
        <Kpi label="Test runs" value={isLoading ? '…' : fmtNum(totals.runs)} />
        <Kpi label="Active alerts" value={isLoading ? '…' : fmtNum(totals.alerts)} status={totals.alerts ? 'fail' : null} onClick={totals.alerts ? () => nav('/alerts') : undefined} />
      </div>

      <div className="inv-toolbar">
        <div className="inv-search"><Search size={13} /><input className="input" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" /></div>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
        <div className="spacer" />
        <Seg label="View" value={view} onChange={setViewP} options={[{ value: 'cards', label: <LayoutGrid size={14} />, title: 'Cards' }, { value: 'table', label: <List size={14} />, title: 'Table' }]} />
      </div>

      <ErrorBox error={error} />
      {view === 'table' ? (
        <div className="card"><DataTable rows={rows} columns={columns} rowKey={(p) => p.id} onRowClick={(p) => nav(`/projects/${p.id}`)} loading={isLoading} searchable={false} exportName="projects"
          empty={q ? 'No projects match your search.' : 'No projects yet.'} /></div>
      ) : isLoading ? (
        <div className="inv-cards">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 196, borderRadius: 10 }} />)}</div>
      ) : rows.length ? (
        <div className="inv-cards">
          {rows.map((p) => (
            <article key={p.id} className={`inv-pcard ${p.archived_at ? 'archived' : ''}`} tabIndex={0} onClick={() => nav(`/projects/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/projects/${p.id}`)} aria-label={`Open project ${p.name}`}>
              <div className="inv-pcard-head">
                <div className="inv-avatar" style={{ background: projectColor(p.key, theme) }} aria-hidden>{initials(p.name)}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="inv-title-row"><h3 className="inv-ellipsis">{p.name}</h3>{p.archived_at && <span className="badge">ARCHIVED</span>}</div>
                  <span className="inv-key">{p.key}</span>
                </div>
                {actions(p)}
              </div>
              <div className="inv-pcard-desc">{p.description || <i>No description</i>}</div>
              <div className="inv-stats">
                <div className="inv-stat"><b>{fmtNum(p.applications)}</b><span>Apps</span></div>
                <div className="inv-stat"><b>{fmtNum(p.environments)}</b><span>Envs</span></div>
                <div className="inv-stat"><b>{fmtNum(p.tests)}</b><span>Tests</span></div>
                <div className="inv-stat"><b>{fmtNum(p.runs)}</b><span>Runs</span></div>
                <div className="inv-stat"><b>{fmtNum(p.dashboards)}</b><span>Dashboards</span></div>
                <div className="inv-stat"><b>{fmtNum(p.releases)}</b><span>Releases</span></div>
                <div className="inv-stat"><b style={{ color: p.active_alerts ? 'var(--fail)' : undefined }}>{fmtNum(p.active_alerts)}</b><span>Alerts</span></div>
                <div className="inv-stat" title={fmtDate(p.last_run_at)}><b style={{ fontSize: 12, lineHeight: '19px' }}>{p.last_run_at ? fmtRelative(p.last_run_at) : '—'}</b><span>Last run</span></div>
              </div>
              <div className="inv-pcard-foot">Updated {fmtRelative(p.updated_at)}</div>
            </article>
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState icon={<FolderKanban size={22} />} title={q ? 'No projects match your search' : 'Create your first project'}
            action={!q && can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={15} />New project</button>}>
            {q ? 'Try a different name or key.' : 'A project groups applications, environments, performance tests and every Run ID they produce.'}
          </EmptyState>
        </div>
      )}

      <ProjectForm open={form.open} project={form.project} onClose={() => setForm({ open: false })} onSaved={(p) => { if (!form.project) nav(`/projects/${p.id}`); }} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete project “${del?.name ?? ''}”?`} requireText={del?.key} confirmLabel="Delete permanently"
        message={<>This permanently deletes <b>{fmtNum(del?.applications)}</b> applications, <b>{fmtNum(del?.tests)}</b> tests, <b>{fmtNum(del?.runs)}</b> runs and all their metrics, artifacts and reports. Consider <b>archiving</b> instead.</>}
        onConfirm={() => del && remove(del)} />
    </div>
  );
}
