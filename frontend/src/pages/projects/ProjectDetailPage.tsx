import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AppWindow, Archive, ArchiveRestore, BarChart3, Bell, Check, ChevronRight, FileText, FlaskConical, Layers, LayoutDashboard, Pencil, Play, Plug, Plus, Rocket,
} from 'lucide-react';
import { api } from '@/services/api';
import { Card, ErrorBox, Kpi, Loading, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/Status';
import { approx, fmtDate, fmtDuration, fmtMs, fmtNum, fmtPct, fmtRelative } from '@/components/format';
import { useFilters } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { EmptyState, EnvBadge, Toaster, friendlyError, toast, useCan } from '@/components/inventory/common';
import { useInvalidateInventory, useProject, useProjects, useRuns, useTests, type Application, type Environment, type Release, type RunDto, type TestRow } from '@/components/inventory/data';
import { ApplicationForm, EnvironmentForm, ProjectForm, ReleaseForm, TestForm } from '@/components/inventory/forms';
import { NewRunDialog } from '@/components/inventory/NewRun';
import { initials, projectColor } from './ProjectsPage';

type TabKey = 'applications' | 'environments' | 'tests' | 'runs' | 'releases' | 'dashboards' | 'reports' | 'alerts' | 'integrations';

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const can = useCan();
  const theme = useUi((s) => s.theme);
  const setFilters = useFilters((s) => s.set);
  const inv = useInvalidateInventory();
  const { data: project, isLoading, error } = useProject(id);
  const counts = useProjects(true).data?.find((p) => p.id === id);
  const tests = useTests({ projectId: id });
  const [tab, setTab] = useState<TabKey>('applications');
  const [runPage, setRunPage] = useState(1);
  const runs = useRuns({ projectId: id, page: runPage, pageSize: 25, sort: 'start', order: 'desc' }, !!id);

  const [editProject, setEditProject] = useState(false);
  const [appForm, setAppForm] = useState<{ open: boolean; app?: Application | null }>({ open: false });
  const [envForm, setEnvForm] = useState<{ open: boolean; env?: Environment | null; applicationId?: string | null }>({ open: false });
  const [testForm, setTestForm] = useState<{ open: boolean; test?: TestRow | null; applicationId?: string | null; environmentId?: string | null }>({ open: false });
  const [relForm, setRelForm] = useState<{ open: boolean; release?: Release | null }>({ open: false });
  const [runFor, setRunFor] = useState<TestRow | null>(null);

  const go = (path: string) => { if (id) setFilters({ projectId: id }); nav(path); };
  const archive = async (archived: boolean) => {
    if (!project) return;
    try { await api.patch(`/projects/${project.id}`, { archived }); inv(); toast.success(archived ? 'Project archived' : 'Project restored'); } catch (e) { toast.error(friendlyError(e)); }
  };

  const apps = project?.applications ?? [];
  const envs = project?.environments ?? [];
  const testRows = tests.data ?? [];
  const runTotal = runs.data?.total ?? counts?.runs ?? 0;
  const lastApp = apps[apps.length - 1];
  const lastEnv = envs[envs.length - 1];
  const firstTest = testRows[0];

  const steps: { title: string; sub: string; done: boolean; cta?: ReactNode }[] = [
    { title: 'Project', sub: project?.key ?? '', done: true },
    { title: 'Application', sub: apps.length ? `${apps.length} registered` : 'System under test', done: apps.length > 0,
      cta: can('MANAGE_PROJECT') && <button className="btn btn-sm" onClick={() => setAppForm({ open: true })}><Plus size={13} />Application</button> },
    { title: 'Environment', sub: envs.length ? `${envs.length} configured` : 'Where tests execute', done: envs.length > 0,
      cta: can('MANAGE_PROJECT') && <button className="btn btn-sm" disabled={!apps.length} onClick={() => setEnvForm({ open: true, applicationId: apps.length === 1 ? apps[0].id : lastApp?.id })}><Plus size={13} />Environment</button> },
    { title: 'Performance test', sub: testRows.length ? `${testRows.length} defined` : 'Type + load profile', done: testRows.length > 0,
      cta: can('CREATE_TEST') && <button className="btn btn-sm" disabled={!envs.length} onClick={() => setTestForm({ open: true, applicationId: lastEnv?.application_id, environmentId: lastEnv?.id })}><Plus size={13} />Test</button> },
    { title: 'Generate Run ID', sub: runTotal ? `${fmtNum(runTotal)} runs` : 'Configure JMeter & execute', done: runTotal > 0,
      cta: can('EXECUTE_TEST') && <button className="btn btn-sm btn-primary" disabled={!firstTest} onClick={() => setRunFor(firstTest)}><Play size={13} />New run</button> },
  ];
  const currentStep = steps.findIndex((s) => !s.done);

  const appCols: Column<Application>[] = [
    { key: 'name', header: 'Application', render: (a) => <b>{a.name}</b> },
    { key: 'code', header: 'ID', render: (a) => <span className="inv-key">{a.code}</span> },
    { key: 'owner', header: 'Owner' }, { key: 'team', header: 'Team' }, { key: 'technology', header: 'Technology' }, { key: 'version', header: 'Version', render: (a) => <span className="mono">{a.version ?? '—'}</span> },
    { key: 'envs', header: 'Environments', align: 'right', value: (a) => envs.filter((e) => e.application_id === a.id).length },
    { key: 'tests', header: 'Tests', align: 'right', value: (a) => testRows.filter((t) => t.application_id === a.id).length },
    { key: 'act', header: '', sortable: false, render: (a) => can('MANAGE_PROJECT') && (
      <span className="inv-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-ghost btn-sm" onClick={() => setEnvForm({ open: true, applicationId: a.id })}><Plus size={13} />Env</button>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${a.name}`} onClick={() => setAppForm({ open: true, app: a })}><Pencil size={13} /></button>
      </span>) },
  ];
  const envCols: Column<Environment>[] = [
    { key: 'name', header: 'Environment', render: (e) => <b>{e.name}</b> },
    { key: 'type', header: 'Type', render: (e) => <EnvBadge type={e.type} /> },
    { key: 'application_name', header: 'Application' },
    { key: 'base_url', header: 'Base URL', render: (e) => (e.base_url ? <span className="mono">{e.base_url}</span> : '—') },
    { key: 'tests', header: 'Tests', align: 'right', value: (e) => testRows.filter((t) => t.environment_id === e.id).length },
    { key: 'act', header: '', sortable: false, render: (e) => (
      <span className="inv-actions" onClick={(ev) => ev.stopPropagation()}>
        {can('CREATE_TEST') && <button className="btn btn-ghost btn-sm" onClick={() => setTestForm({ open: true, applicationId: e.application_id, environmentId: e.id })}><Plus size={13} />Test</button>}
        {can('MANAGE_PROJECT') && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${e.name}`} onClick={() => setEnvForm({ open: true, env: e })}><Pencil size={13} /></button>}
      </span>) },
  ];
  const testCols: Column<TestRow>[] = [
    { key: 'name', header: 'Test', render: (t) => <Link to={`/tests/${t.id}`} onClick={(e) => e.stopPropagation()}><b>{t.name}</b></Link> },
    { key: 'test_type', header: 'Type', render: (t) => <span className="badge">{t.test_type}</span> },
    { key: 'application_name', header: 'Application' },
    { key: 'environment_name', header: 'Environment' },
    { key: 'virtual_users', header: 'VUs', align: 'right' },
    { key: 'run_count', header: 'Runs', align: 'right' },
    { key: 'last_run_result', header: 'Last result', render: (t) => <StatusBadge value={t.last_run_result ?? t.last_run_status} /> },
    { key: 'last_run_at', header: 'Last run', render: (t) => fmtRelative(t.last_run_at) },
    { key: 'act', header: '', sortable: false, render: (t) => can('EXECUTE_TEST') && <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setRunFor(t); }}><Play size={13} />New run</button> },
  ];
  const relCols: Column<Release>[] = [
    { key: 'version', header: 'Version', render: (r) => <b className="mono">{r.version}</b> },
    { key: 'name', header: 'Release' },
    { key: 'build_number', header: 'Build', render: (r) => <span className="mono">{r.build_number ?? '—'}</span> },
    { key: 'branch', header: 'Branch', render: (r) => <span className="mono">{r.branch ?? '—'}</span> },
    { key: 'deployment_date', header: 'Deployed', render: (r) => fmtDate(r.deployment_date) },
  ];

  const tabs = useMemo(() => [
    { key: 'applications' as const, label: 'Applications', badge: apps.length },
    { key: 'environments' as const, label: 'Environments', badge: envs.length },
    { key: 'tests' as const, label: 'Performance Tests', badge: testRows.length },
    { key: 'runs' as const, label: 'Runs', badge: runs.data?.total ?? counts?.runs },
    { key: 'releases' as const, label: 'Releases', badge: project?.releases.length },
    { key: 'dashboards' as const, label: 'Dashboards', badge: counts?.dashboards },
    { key: 'reports' as const, label: 'Reports' },
    { key: 'alerts' as const, label: 'Alerts', badge: counts?.active_alerts || undefined },
    { key: 'integrations' as const, label: 'Integrations' },
  ], [apps.length, envs.length, testRows.length, runs.data?.total, counts, project?.releases.length]);

  if (isLoading) return <div className="stack"><Loading height={70} /><Loading height={90} /><Loading height={300} /></div>;
  if (error || !project) return <div className="stack"><ErrorBox error={error ?? new Error('Project not found')} /><Link to="/projects">← Back to projects</Link></div>;

  return (
    <div>
      <Toaster />
      <div className="inv-crumbs"><Link to="/projects">Projects</Link><ChevronRight size={12} /><span>{project.name}</span></div>
      <div className="inv-hero">
        <div className="inv-avatar" style={{ background: projectColor(project.key, theme), width: 46, height: 46, fontSize: 16, borderRadius: 11 }} aria-hidden>{initials(project.name)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="inv-title-row"><h1>{project.name}</h1><span className="inv-key">{project.key}</span>{project.archived_at && <span className="badge warn">ARCHIVED</span>}</div>
          <div className="text-2" style={{ marginTop: 2 }}>{project.description || <span className="muted">No description</span>}</div>
          <div className="inv-hero-meta"><span>Created {fmtDate(project.created_at)}</span><span>Updated {fmtRelative(project.updated_at)}</span>{counts?.last_run_at && <span>Last run {fmtRelative(counts.last_run_at)}</span>}</div>
        </div>
        {can('MANAGE_PROJECT') && (
          <div className="row wrap">
            <button className="btn" onClick={() => setEditProject(true)}><Pencil size={14} />Edit</button>
            {project.archived_at ? <button className="btn" onClick={() => archive(false)}><ArchiveRestore size={14} />Restore</button> : <button className="btn" onClick={() => archive(true)}><Archive size={14} />Archive</button>}
          </div>
        )}
      </div>

      <Card title={currentStep === -1 ? 'Setup complete' : 'Get started — from project to Run ID'} className="" bodyClass="" noPad>
        <div className="inv-steps">
          {steps.map((s, i) => (
            <div key={s.title} className={`inv-step ${s.done ? 'done' : i === currentStep ? 'current' : ''}`}>
              <div className="inv-step-dot">{s.done ? <Check size={13} /> : i + 1}</div>
              <div style={{ minWidth: 0 }}>
                <div className="inv-step-title">{s.title}</div>
                <div className="inv-step-sub inv-ellipsis">{s.sub}</div>
                {i > 0 && s.cta}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{ height: 12 }} />

      <div className="inv-kpis">
        <Kpi label="Applications" value={fmtNum(apps.length)} onClick={() => setTab('applications')} />
        <Kpi label="Environments" value={fmtNum(envs.length)} onClick={() => setTab('environments')} />
        <Kpi label="Tests" value={fmtNum(testRows.length)} onClick={() => setTab('tests')} />
        <Kpi label="Runs" value={fmtNum(runTotal)} onClick={() => setTab('runs')} />
        <Kpi label="Releases" value={fmtNum(counts?.releases ?? project.releases.length)} onClick={() => setTab('releases')} />
        <Kpi label="Active alerts" value={fmtNum(counts?.active_alerts ?? 0)} status={counts?.active_alerts ? 'fail' : null} onClick={() => setTab('alerts')} />
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'applications' && (
        <div className="card">
          <DataTable rows={apps} columns={appCols} rowKey={(a) => a.id} exportName={`${project.key}-applications`} onRowClick={() => go('/applications')}
            toolbar={can('MANAGE_PROJECT') && <button className="btn btn-sm btn-primary" onClick={() => setAppForm({ open: true })}><Plus size={13} />New application</button>}
            empty={<EmptyState icon={<AppWindow size={20} />} title="No applications yet" action={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setAppForm({ open: true })}><Plus size={14} />New application</button>}>Register the system under test to add environments and tests.</EmptyState>} />
        </div>
      )}
      {tab === 'environments' && (
        <div className="card">
          <DataTable rows={envs} columns={envCols} rowKey={(e) => e.id} exportName={`${project.key}-environments`}
            toolbar={can('MANAGE_PROJECT') && <button className="btn btn-sm btn-primary" disabled={!apps.length} onClick={() => setEnvForm({ open: true })}><Plus size={13} />New environment</button>}
            empty={<EmptyState icon={<Layers size={20} />} title="No environments yet">{apps.length ? 'Add DEV, QA, PERFORMANCE, STAGING… for an application.' : 'Create an application first.'}</EmptyState>} />
        </div>
      )}
      {tab === 'tests' && (
        <div className="card">
          <DataTable rows={testRows} columns={testCols} rowKey={(t) => t.id} loading={tests.isLoading} onRowClick={(t) => nav(`/tests/${t.id}`)} exportName={`${project.key}-tests`}
            toolbar={can('CREATE_TEST') && <button className="btn btn-sm btn-primary" disabled={!envs.length} onClick={() => setTestForm({ open: true })}><Plus size={13} />New test</button>}
            empty={<EmptyState icon={<FlaskConical size={20} />} title="No performance tests yet">{envs.length ? 'Define a LOAD, STRESS, SOAK… test with its load profile.' : 'Create an application and an environment first.'}</EmptyState>} />
        </div>
      )}
      {tab === 'runs' && <RunsTable data={runs.data} loading={runs.isLoading} page={runPage} setPage={setRunPage} onOpen={(r) => nav(`/runs/${r.runId}`)} />}
      {tab === 'releases' && (
        <div className="card">
          <DataTable rows={project.releases} columns={relCols} rowKey={(r) => r.id} onRowClick={() => go('/releases')} exportName={`${project.key}-releases`}
            toolbar={<>{can('MANAGE_PROJECT') && <button className="btn btn-sm btn-primary" onClick={() => setRelForm({ open: true })}><Plus size={13} />New release</button>}<button className="btn btn-sm" onClick={() => go('/releases')}>Open releases</button></>}
            empty={<EmptyState icon={<Rocket size={20} />} title="No releases yet">Releases are created here or automatically when a run is started with a release version.</EmptyState>} />
        </div>
      )}
      {(['dashboards', 'reports', 'alerts', 'integrations'] as const).includes(tab as never) && (
        <div className="inv-tiles">
          {tab === 'dashboards' && <>
            <Tile icon={<LayoutDashboard size={17} />} title="Dashboards" sub={`${fmtNum(counts?.dashboards ?? 0)} in this project`} onClick={() => go('/dashboards')} />
            <Tile icon={<BarChart3 size={17} />} title="Trends" sub="Run-over-run performance" onClick={() => go('/trends')} />
          </>}
          {tab === 'reports' && <>
            <Tile icon={<FileText size={17} />} title="Reports" sub="Generated and uploaded reports" onClick={() => go('/reports')} />
            <Tile icon={<FileText size={17} />} title="Artifacts" sub="JTL, JMX, HTML reports, logs" onClick={() => nav(`/artifacts?projectId=${project.id}`)} />
          </>}
          {tab === 'alerts' && <Tile icon={<Bell size={17} />} title="Alerts" sub={counts?.active_alerts ? `${counts.active_alerts} firing` : 'No active alerts'} onClick={() => go('/alerts')} />}
          {tab === 'integrations' && <Tile icon={<Plug size={17} />} title="Integrations" sub="CI/CD, APM, notifications" onClick={() => go('/integrations')} />}
        </div>
      )}

      <ProjectForm open={editProject} project={project} onClose={() => setEditProject(false)} />
      <ApplicationForm open={appForm.open} app={appForm.app} projectId={project.id} onClose={() => setAppForm({ open: false })}
        onSaved={(a) => { if (!appForm.app) setTimeout(() => setEnvForm({ open: true, applicationId: a.id }), 150); }} />
      <EnvironmentForm open={envForm.open} env={envForm.env} projectId={project.id} applicationId={envForm.applicationId} onClose={() => setEnvForm({ open: false })}
        onSaved={(e) => { if (!envForm.env && !testRows.some((t) => t.environment_id === e.id)) { toast.info('Next: define a performance test for this environment'); setTimeout(() => setTestForm({ open: true, applicationId: e.application_id, environmentId: e.id }), 150); } }} />
      <TestForm open={testForm.open} test={testForm.test} projectId={project.id} applicationId={testForm.applicationId} environmentId={testForm.environmentId} onClose={() => setTestForm({ open: false })}
        onSaved={(t) => { if (!testForm.test) { setTab('tests'); setTimeout(() => setRunFor(t), 150); } }} />
      <ReleaseForm open={relForm.open} release={relForm.release} projectId={project.id} onClose={() => setRelForm({ open: false })} />
      <NewRunDialog open={!!runFor} test={runFor} onClose={() => setRunFor(null)} />
    </div>
  );
}

function Tile({ icon, title, sub, onClick }: { icon: ReactNode; title: string; sub: string; onClick: () => void }) {
  return (
    <a className="inv-tile" href="#" onClick={(e) => { e.preventDefault(); onClick(); }}>
      <span className="inv-tile-icon">{icon}</span><span style={{ flex: 1 }}><b>{title}</b><span>{sub}</span></span><ChevronRight size={15} className="muted" />
    </a>
  );
}

export function RunsTable({ data, loading, page, setPage, onOpen }: { data?: { items: RunDto[]; total: number; totalPages: number }; loading: boolean; page: number; setPage: (p: number) => void; onOpen: (r: RunDto) => void }) {
  const cols: Column<RunDto>[] = [
    { key: 'runId', header: 'Run ID', render: (r) => <span className="row"><Link className="mono" to={`/runs/${r.runId}`} onClick={(e) => e.stopPropagation()}>{r.runId}</Link>{r.isBaseline && <span className="badge accent" title="Baseline run">BASELINE</span>}</span> },
    { key: 'testName', header: 'Test' },
    { key: 'environmentName', header: 'Environment' },
    { key: 'buildNumber', header: 'Build', render: (r) => <span className="mono">{r.buildNumber ?? '—'}</span> },
    { key: 'startedAt', header: 'Start', render: (r) => fmtDate(r.startedAt ?? r.createdAt) },
    { key: 'durationSec', header: 'Duration', align: 'right', render: (r) => fmtDuration(r.durationSec) },
    { key: 'tps', header: 'TPS', align: 'right', value: (r) => r.kpis?.tps ?? null, render: (r) => fmtNum(r.kpis?.tps, 1) },
    { key: 'p95', header: 'P95', align: 'right', value: (r) => r.kpis?.p95 ?? null, render: (r) => `${approx(r.kpis?.percentileMethod)}${fmtMs(r.kpis?.p95)}` },
    { key: 'err', header: 'Error %', align: 'right', value: (r) => r.kpis?.errorPct ?? null, render: (r) => fmtPct(r.kpis?.errorPct) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
    { key: 'result', header: 'Result', render: (r) => <StatusBadge value={r.result} /> },
  ];
  return (
    <div className="card">
      <DataTable rows={data?.items ?? []} columns={cols} rowKey={(r) => r.id} loading={loading} onRowClick={onOpen} searchable={false} exportName="runs"
        server={{ page, pageSize: 25, total: data?.total ?? 0, onPage: setPage, onSort: () => undefined }}
        empty={<EmptyState icon={<Play size={20} />} title="No runs yet">Open a performance test and click <b>New run</b> to generate a Run ID.</EmptyState>} />
    </div>
  );
}
