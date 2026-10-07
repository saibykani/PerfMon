import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FlaskConical, Flag, Pencil, Play, Plus } from 'lucide-react';
import { ErrorBox, Kpi, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/Status';
import { fmtDate, fmtDuration, fmtNum, fmtRelative } from '@/components/format';
import { useFilters } from '@/stores/filters';
import { EmptyState, EnvBadge, Tags, Toaster, useCan } from '@/components/inventory/common';
import { TEST_TYPES, useApplications, useEnvironments, useProjects, useTests, type TestRow } from '@/components/inventory/data';
import { TestForm } from '@/components/inventory/forms';
import { NewRunDialog } from '@/components/inventory/NewRun';

export function TestsPage() {
  const nav = useNavigate();
  const can = useCan();
  const gf = useFilters();
  const [projectId, setProjectId] = useState(gf.projectId ?? '');
  const [applicationId, setApplicationId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [type, setType] = useState('');
  const projects = useProjects();
  const apps = useApplications(projectId || null);
  const envs = useEnvironments({ projectId: projectId || null, applicationId: applicationId || null });
  const { data, isLoading, error } = useTests({ projectId: projectId || null, applicationId: applicationId || null, environmentId: environmentId || null });
  const [form, setForm] = useState<{ open: boolean; test?: TestRow | null }>({ open: false });
  const [runFor, setRunFor] = useState<TestRow | null>(null);

  const rows = (data ?? []).filter((t) => !type || t.test_type === type);
  const ran = rows.filter((t) => t.last_run_result);
  const failing = ran.filter((t) => t.last_run_result === 'FAIL').length;

  const cols: Column<TestRow>[] = [
    { key: 'name', header: 'Test', render: (t) => <span><Link to={`/tests/${t.id}`} onClick={(e) => e.stopPropagation()}><b>{t.name}</b></Link>{!projectId && <div className="muted" style={{ fontSize: 11 }}>{t.project_name}</div>}</span> },
    { key: 'test_type', header: 'Type', render: (t) => <span className="badge">{t.test_type}</span> },
    { key: 'application_name', header: 'Application' },
    { key: 'environment_name', header: 'Environment', render: (t) => <span className="row" style={{ gap: 6 }}>{t.environment_name}<EnvBadge type={t.environment_type} /></span> },
    { key: 'sla_profile_name', header: 'SLA profile', render: (t) => t.sla_profile_name ?? <span className="muted">None</span> },
    { key: 'owner', header: 'Owner' },
    { key: 'tags', header: 'Tags', value: (t) => t.tags.join(' '), render: (t) => <Tags tags={t.tags} max={3} /> },
    { key: 'virtual_users', header: 'VUs', align: 'right', hidden: true },
    { key: 'duration_sec', header: 'Duration', align: 'right', hidden: true, render: (t) => fmtDuration(t.duration_sec) },
    { key: 'last_run_status', header: 'Last run', value: (t) => (t.last_run_at ? new Date(t.last_run_at).getTime() : null),
      render: (t) => (t.last_run_key ? <span className="row" style={{ gap: 6 }}><StatusBadge value={t.last_run_result ?? t.last_run_status} /><span className="muted" title={fmtDate(t.last_run_at)}>{fmtRelative(t.last_run_at)}</span></span> : <span className="muted">Never run</span>) },
    { key: 'run_count', header: 'Runs', align: 'right' },
    { key: 'baseline_run_key', header: 'Baseline', render: (t) => (t.baseline_run_key ? <Link className="mono" to={`/runs/${t.baseline_run_key}`} onClick={(e) => e.stopPropagation()}><Flag size={11} /> {t.baseline_run_key}</Link> : <span className="muted">—</span>) },
    { key: 'act', header: '', sortable: false, render: (t) => (
      <span className="inv-actions" onClick={(e) => e.stopPropagation()}>
        {can('EXECUTE_TEST') && <button className="btn btn-sm" onClick={() => setRunFor(t)}><Play size={13} />Run</button>}
        {can('EDIT_TEST') && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${t.name}`} onClick={() => setForm({ open: true, test: t })}><Pencil size={13} /></button>}
      </span>) },
  ];

  return (
    <div>
      <Toaster />
      <PageHeader title="Performance Tests" subtitle="Test definitions with versioned load profiles. Each execution generates a Run ID."
        actions={can('CREATE_TEST') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={15} />New test</button>} />
      <div className="inv-kpis">
        <Kpi label="Tests" value={isLoading ? '…' : fmtNum(rows.length)} />
        <Kpi label="Total runs" value={isLoading ? '…' : fmtNum(rows.reduce((a, t) => a + t.run_count, 0))} />
        <Kpi label="With baseline" value={isLoading ? '…' : fmtNum(rows.filter((t) => t.baseline_run_id).length)} sub={rows.length ? `of ${rows.length}` : undefined} />
        <Kpi label="Last result: fail" value={isLoading ? '…' : fmtNum(failing)} status={failing ? 'fail' : ran.length ? 'pass' : null} sub={ran.length ? `${ran.length} tests evaluated` : undefined} />
        <Kpi label="Never run" value={isLoading ? '…' : fmtNum(rows.filter((t) => !t.run_count).length)} />
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <DataTable rows={rows} columns={cols} rowKey={(t) => t.id} loading={isLoading} onRowClick={(t) => nav(`/tests/${t.id}`)} exportName="performance-tests"
          toolbar={<>
            <select className="select" aria-label="Project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setApplicationId(''); setEnvironmentId(''); }}>
              <option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="select" aria-label="Application" value={applicationId} onChange={(e) => { setApplicationId(e.target.value); setEnvironmentId(''); }}>
              <option value="">All applications</option>{apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="select" aria-label="Environment" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              <option value="">All environments</option>{envs.data?.map((en) => <option key={en.id} value={en.id}>{en.name} · {en.application_name}</option>)}
            </select>
            <select className="select" aria-label="Test type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>{TEST_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </>}
          empty={<EmptyState icon={<FlaskConical size={20} />} title="No performance tests" action={can('CREATE_TEST') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={14} />New test</button>}>
            A test ties an application environment to a load profile (VUs, ramp-up, duration, target TPS) and an SLA profile.</EmptyState>} />
      </div>
      <TestForm open={form.open} test={form.test} projectId={projectId || null} onClose={() => setForm({ open: false })} onSaved={(t) => { if (!form.test) nav(`/tests/${t.id}`); }} />
      <NewRunDialog open={!!runFor} test={runFor} onClose={() => setRunFor(null)} />
    </div>
  );
}
