import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppWindow, Boxes, ExternalLink, GitBranch, Layers, Pencil, Plus, Trash2, Workflow } from 'lucide-react';
import { api } from '@/services/api';
import { ConfirmDialog, ErrorBox, KeyValue, Loading, PageHeader, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtDate, fmtNum } from '@/components/format';
import { useFilters } from '@/stores/filters';
import { Drawer, EmptyState, EnvBadge, HealthChip, Toaster, friendlyError, toast, useCan } from '@/components/inventory/common';
import { useApplications, useInvalidateInventory, useProjects, type Application, type Environment, type Service } from '@/components/inventory/data';
import { ApplicationForm, EnvironmentForm, ServiceForm, TestForm } from '@/components/inventory/forms';

type AppDetail = Application & { environments: Environment[]; services: (Service & { environment_name: string | null })[]; tests: { id: string; name: string; test_type: string; environment_id: string }[] };

export function ApplicationsPage() {
  const can = useCan();
  const inv = useInvalidateInventory();
  const globalProject = useFilters((s) => s.projectId);
  const [projectId, setProjectId] = useState<string>(globalProject ?? '');
  const projects = useProjects();
  const { data, isLoading, error } = useApplications(projectId || null);
  const [form, setForm] = useState<{ open: boolean; app?: Application | null }>({ open: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [archiveApp, setArchiveApp] = useState<Application | null>(null);

  const doArchive = async (a: Application) => {
    try { await api.del(`/applications/${a.id}`); inv(); setSelected(null); toast.success(`Application “${a.name}” archived`); } catch (e) { toast.error(friendlyError(e)); }
  };

  const cols: Column<Application>[] = [
    { key: 'name', header: 'Application', render: (a) => <span><b>{a.name}</b>{!projectId && <div className="muted" style={{ fontSize: 11 }}>{a.project_name}</div>}</span> },
    { key: 'code', header: 'ID / Code', render: (a) => <span className="inv-key">{a.code}</span> },
    { key: 'description', header: 'Description', render: (a) => <span className="inv-ellipsis" style={{ maxWidth: 220, display: 'inline-block', verticalAlign: 'bottom' }} title={a.description ?? ''}>{a.description || '—'}</span> },
    { key: 'owner', header: 'Owner' },
    { key: 'team', header: 'Team' },
    { key: 'technology', header: 'Technology' },
    { key: 'environments', header: 'Environments', value: (a) => a.environments ?? 0, render: (a) => (a.environment_names?.length ? <span title={a.environment_names.join(', ')}>{a.environments} <span className="muted">· {a.environment_names.slice(0, 2).join(', ')}{a.environment_names.length > 2 ? '…' : ''}</span></span> : '0') },
    { key: 'services', header: 'Services', align: 'right' },
    { key: 'repository', header: 'Repository', render: (a) => (a.repository ? <a href={/^https?:/.test(a.repository) ? a.repository : undefined} target="_blank" rel="noreferrer" className="mono" onClick={(e) => e.stopPropagation()}><GitBranch size={11} /> {a.repository.replace(/^https?:\/\//, '').slice(0, 32)}</a> : '—') },
    { key: 'version', header: 'Version', render: (a) => <span className="mono">{a.version ?? '—'}</span> },
    { key: 'tests', header: 'Tests', align: 'right' },
    { key: 'runs', header: 'Runs', align: 'right', render: (a) => fmtNum(a.runs) },
  ];

  return (
    <div>
      <Toaster />
      <PageHeader title="Applications" subtitle="Inventory of systems under test, their environments and services."
        actions={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={15} />New application</button>} />
      <ErrorBox error={error} />
      <div className="card">
        <DataTable rows={data ?? []} columns={cols} rowKey={(a) => a.id} loading={isLoading} onRowClick={(a) => setSelected(a.id)} exportName="applications"
          toolbar={
            <select className="select" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">All projects</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          }
          empty={<EmptyState icon={<AppWindow size={20} />} title="No applications" action={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={14} />New application</button>}>
            Register the system under test; then add its environments (DEV → PRODUCTION) and services.</EmptyState>} />
      </div>
      <ApplicationForm open={form.open} app={form.app} projectId={projectId || null} onClose={() => setForm({ open: false })} onSaved={(a) => !form.app && setSelected(a.id)} />
      <AppDetailDrawer id={selected} onClose={() => setSelected(null)} onEdit={(a) => setForm({ open: true, app: a })} onArchive={(a) => setArchiveApp(a)} />
      <ConfirmDialog open={!!archiveApp} onClose={() => setArchiveApp(null)} title={`Archive “${archiveApp?.name ?? ''}”?`} confirmLabel="Archive"
        message="The application is hidden from inventories and pickers. Its environments, tests and runs are kept." onConfirm={() => archiveApp && doArchive(archiveApp)} />
    </div>
  );
}

function AppDetailDrawer({ id, onClose, onEdit, onArchive }: { id: string | null; onClose: () => void; onEdit: (a: Application) => void; onArchive: (a: Application) => void }) {
  const can = useCan();
  const inv = useInvalidateInventory();
  const [tab, setTab] = useState<'overview' | 'environments' | 'services' | 'tests'>('overview');
  const { data: a, isLoading, error } = useQuery({ queryKey: ['inv', 'application', id], enabled: !!id, queryFn: () => api.get<AppDetail>(`/applications/${id}`) });
  const [envForm, setEnvForm] = useState<{ open: boolean; env?: Environment | null }>({ open: false });
  const [svcForm, setSvcForm] = useState<{ open: boolean; svc?: Service | null }>({ open: false });
  const [testForm, setTestForm] = useState<{ open: boolean; environmentId?: string }>({ open: false });
  const [delEnv, setDelEnv] = useState<Environment | null>(null);
  const [delSvc, setDelSvc] = useState<Service | null>(null);
  const svcName = (sid: string) => a?.services.find((s) => s.id === sid)?.name ?? '…';

  const removeEnv = async (e: Environment) => { try { await api.del(`/environments/${e.id}`, { confirm: true }); inv(); toast.success(`Environment “${e.name}” deleted`); } catch (x) { toast.error(friendlyError(x)); } };
  const removeSvc = async (s: Service) => { try { await api.del(`/services/${s.id}`); inv(); toast.success(`Service “${s.name}” deleted`); } catch (x) { toast.error(friendlyError(x)); } };

  return (
    <>
      <Drawer open={!!id && !envForm.open && !svcForm.open && !testForm.open} onClose={onClose} width={820} icon={<AppWindow size={18} />}
        title={a ? <span className="inv-title-row">{a.name}<span className="inv-key">{a.code}</span></span> : 'Application'} subtitle={a?.project_name ?? a?.description ?? ''}
        footer={a && can('MANAGE_PROJECT') && <>
          <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => onArchive(a)}><Trash2 size={14} />Archive</button>
          <button className="btn" onClick={() => onEdit(a)}><Pencil size={14} />Edit application</button>
        </>}>
        {isLoading && <Loading height={240} />}
        <ErrorBox error={error} />
        {a && (
          <>
            <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'environments', label: 'Environments', badge: a.environments.length }, { key: 'services', label: 'Services', badge: a.services.length }, { key: 'tests', label: 'Tests', badge: a.tests.length }]} />
            {tab === 'overview' && (
              <div className="stack">
                {a.description && <div className="text-2">{a.description}</div>}
                <KeyValue items={[
                  ['Owner', a.owner], ['Team', a.team], ['Technology', a.technology], ['Version', a.version && <span className="mono">{a.version}</span>],
                  ['Repository', a.repository && (/^https?:/.test(a.repository) ? <a href={a.repository} target="_blank" rel="noreferrer">{a.repository.replace(/^https?:\/\//, '')} <ExternalLink size={11} /></a> : a.repository)],
                  ['Created', fmtDate(a.created_at)], ['Updated', fmtDate(a.updated_at)],
                ]} />
              </div>
            )}
            {tab === 'environments' && (
              <div className="stack">
                {can('MANAGE_PROJECT') && <div className="row"><button className="btn btn-primary btn-sm" onClick={() => setEnvForm({ open: true })}><Plus size={13} />New environment</button></div>}
                {a.environments.length ? (
                  <div className="table-wrap card"><table className="table"><thead><tr><th>Environment</th><th>Type</th><th>Base URL</th><th>Config</th><th /></tr></thead><tbody>
                    {a.environments.map((e) => (
                      <tr key={e.id}>
                        <td><b>{e.name}</b>{e.description && <div className="muted" style={{ fontSize: 11 }}>{e.description}</div>}</td>
                        <td><EnvBadge type={e.type} /></td>
                        <td className="mono">{e.base_url ?? '—'}</td>
                        <td className="mono muted" title={JSON.stringify(e.config, null, 2)}>{Object.keys(e.config ?? {}).length ? `${Object.keys(e.config).length} keys` : '—'}</td>
                        <td className="r"><span className="inv-actions">
                          {can('CREATE_TEST') && <button className="btn btn-ghost btn-sm" onClick={() => setTestForm({ open: true, environmentId: e.id })}><Plus size={13} />Test</button>}
                          {can('MANAGE_PROJECT') && <><button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${e.name}`} onClick={() => setEnvForm({ open: true, env: e })}><Pencil size={13} /></button>
                            <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${e.name}`} onClick={() => setDelEnv(e)}><Trash2 size={13} /></button></>}
                        </span></td>
                      </tr>
                    ))}
                  </tbody></table></div>
                ) : <EmptyState icon={<Layers size={20} />} title="No environments">Add DEV, QA, SIT, UAT, PERFORMANCE, STAGING or PRODUCTION.</EmptyState>}
              </div>
            )}
            {tab === 'services' && (
              <div className="stack">
                {can('MANAGE_PROJECT') && <div className="row"><button className="btn btn-primary btn-sm" onClick={() => setSvcForm({ open: true })}><Plus size={13} />Add service</button><span className="muted" style={{ fontSize: 12 }}>Services & dependencies power the <Link to="/app-monitoring">service map</Link>.</span></div>}
                {a.services.length ? (
                  <div className="table-wrap card"><table className="table"><thead><tr><th>Service</th><th>Kind</th><th>Technology</th><th>Environment</th><th>Health</th><th>Calls</th><th /></tr></thead><tbody>
                    {a.services.map((s) => (
                      <tr key={s.id}>
                        <td><b className="mono">{s.name}</b></td><td><span className="badge">{s.kind}</span></td><td>{s.technology ?? '—'}</td><td>{s.environment_name ?? '—'}</td>
                        <td><HealthChip status={s.health_status} /></td>
                        <td className="muted">{(s.depends_on ?? []).map(svcName).join(', ') || '—'}</td>
                        <td className="r">{can('MANAGE_PROJECT') && <span className="inv-actions">
                          <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${s.name}`} onClick={() => setSvcForm({ open: true, svc: s })}><Pencil size={13} /></button>
                          <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${s.name}`} onClick={() => setDelSvc(s)}><Trash2 size={13} /></button>
                        </span>}</td>
                      </tr>
                    ))}
                  </tbody></table></div>
                ) : <EmptyState icon={<Workflow size={20} />} title="No services">Services are created by the collector automatically, or add them here with their dependencies.</EmptyState>}
              </div>
            )}
            {tab === 'tests' && (
              a.tests.length ? (
                <div className="table-wrap card"><table className="table"><thead><tr><th>Test</th><th>Type</th><th>Environment</th></tr></thead><tbody>
                  {a.tests.map((t) => <tr key={t.id}><td><Link to={`/tests/${t.id}`}><b>{t.name}</b></Link></td><td><span className="badge">{t.test_type}</span></td><td>{a.environments.find((e) => e.id === t.environment_id)?.name ?? '—'}</td></tr>)}
                </tbody></table></div>
              ) : <EmptyState icon={<Boxes size={20} />} title="No tests for this application" action={can('CREATE_TEST') && a.environments.length > 0 && <button className="btn btn-primary" onClick={() => setTestForm({ open: true })}><Plus size={14} />New test</button>} />
            )}
          </>
        )}
      </Drawer>
      {a && <>
        <EnvironmentForm open={envForm.open} env={envForm.env} applicationId={a.id} projectId={a.project_id} onClose={() => setEnvForm({ open: false })} />
        <ServiceForm open={svcForm.open} service={svcForm.svc} projectId={a.project_id} applicationId={a.id} environmentId={a.environments[0]?.id ?? null} onClose={() => setSvcForm({ open: false })} />
        <TestForm open={testForm.open} projectId={a.project_id} applicationId={a.id} environmentId={testForm.environmentId} onClose={() => setTestForm({ open: false })} />
      </>}
      <ConfirmDialog open={!!delEnv} onClose={() => setDelEnv(null)} title={`Delete environment “${delEnv?.name ?? ''}”?`} requireText={delEnv?.name} confirmLabel="Delete environment"
        message="Deleting an environment removes its performance tests and all their runs and metrics. This cannot be undone." onConfirm={() => delEnv && removeEnv(delEnv)} />
      <ConfirmDialog open={!!delSvc} onClose={() => setDelSvc(null)} title={`Delete service “${delSvc?.name ?? ''}”?`} confirmLabel="Delete"
        message="The service and its dependency links are removed from the inventory and service map." onConfirm={() => delSvc && removeSvc(delSvc)} />
    </>
  );
}
