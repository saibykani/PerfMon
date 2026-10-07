import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, GitCommitHorizontal, Package, Pencil, Plus, Rocket, Trash2 } from 'lucide-react';
import { api } from '@/services/api';
import { ConfirmDialog, ErrorBox, KeyValue, Kpi, Loading, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/Status';
import { Chart } from '@/charts/Chart';
import { seriesColor } from '@/charts/palette';
import { useUi } from '@/stores/ui';
import { useFilters } from '@/stores/filters';
import { fmtDate, fmtMs, fmtNum, fmtPct, fmtRelative } from '@/components/format';
import { Drawer, EmptyState, Tags, Toaster, friendlyError, num, toast, useCan } from '@/components/inventory/common';
import { useInvalidateInventory, useProjects, useReleases, type Release, type ReleaseDetail } from '@/components/inventory/data';
import { ReleaseForm } from '@/components/inventory/forms';

export function ReleasesPage() {
  const can = useCan();
  const inv = useInvalidateInventory();
  const [projectId, setProjectId] = useState(useFilters.getState().projectId ?? '');
  const projects = useProjects();
  const { data, isLoading, error } = useReleases(projectId || null);
  const [form, setForm] = useState<{ open: boolean; release?: Release | null }>({ open: false });
  const [sel, setSel] = useState<string | null>(null);
  const [del, setDel] = useState<Release | null>(null);
  const rows = data ?? [];

  const remove = async (r: Release) => {
    try { await api.del(`/releases/${r.id}`); inv(); setSel(null); toast.success(`Release ${r.version} deleted (runs kept, unlinked)`); } catch (e) { toast.error(friendlyError(e)); }
  };

  const cols: Column<Release>[] = [
    { key: 'name', header: 'Release', render: (r) => <b>{r.name}</b> },
    { key: 'version', header: 'Version', render: (r) => <span className="inv-key">{r.version}</span> },
    { key: 'build_number', header: 'Build', render: (r) => <span className="mono">{r.build_number ?? '—'}</span> },
    { key: 'branch', header: 'Branch', render: (r) => (r.branch ? <span className="mono"><GitBranch size={11} /> {r.branch}</span> : '—') },
    { key: 'commit_sha', header: 'Commit', render: (r) => (r.commit_sha ? <span className="mono">{r.commit_sha.slice(0, 10)}</span> : '—') },
    { key: 'deployment_date', header: 'Deployed', value: (r) => (r.deployment_date ? +new Date(r.deployment_date) : null), render: (r) => <span title={fmtDate(r.deployment_date)}>{r.deployment_date ? fmtDate(r.deployment_date) : <span className="muted">not deployed</span>}</span> },
    { key: 'environment_name', header: 'Environment', render: (r) => r.environment_name ?? <span className="muted">Any</span> },
    { key: 'application_name', header: 'Application', hidden: true },
    { key: 'tests', header: 'Tests', value: (r) => (r.tests ?? []).join(', '), render: (r) => <Tags tags={r.tests ?? []} max={2} /> },
    { key: 'run_count', header: 'Runs', align: 'right' },
    { key: 'failed_runs', header: 'Failures', align: 'right', render: (r) => (r.failed_runs ? <span className="badge fail">{r.failed_runs} FAIL</span> : <span className="muted">0</span>) },
    { key: 'act', header: '', sortable: false, render: (r) => can('MANAGE_PROJECT') && (
      <span className="inv-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${r.version}`} onClick={() => setForm({ open: true, release: r })}><Pencil size={13} /></button>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${r.version}`} onClick={() => setDel(r)}><Trash2 size={13} /></button>
      </span>) },
  ];

  return (
    <div>
      <Toaster />
      <PageHeader title="Releases" subtitle="Deployable versions and the performance runs executed against them."
        actions={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={15} />New release</button>} />
      <div className="inv-kpis">
        <Kpi label="Releases" value={isLoading ? '…' : fmtNum(rows.length)} />
        <Kpi label="Deployed" value={isLoading ? '…' : fmtNum(rows.filter((r) => r.deployment_date).length)} />
        <Kpi label="Runs linked" value={isLoading ? '…' : fmtNum(rows.reduce((a, r) => a + (r.run_count ?? 0), 0))} />
        <Kpi label="Releases with failures" value={isLoading ? '…' : fmtNum(rows.filter((r) => r.failed_runs).length)} status={rows.some((r) => r.failed_runs) ? 'fail' : null} />
        <Kpi label="Latest" value={<span className="mono" style={{ fontSize: 14 }}>{rows[0]?.version ?? '—'}</span>} sub={rows[0]?.deployment_date ? fmtRelative(rows[0].deployment_date) : undefined} />
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => setSel(r.id)} exportName="releases"
          toolbar={<select className="select" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          empty={<EmptyState icon={<Rocket size={20} />} title="No releases yet" action={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={14} />New release</button>}>
            Create releases here, or pass <span className="mono">releaseVersion</span> when creating a run from CI — the release is created automatically.</EmptyState>} />
      </div>
      <ReleaseForm open={form.open} release={form.release} projectId={projectId || null} onClose={() => setForm({ open: false })} />
      <ReleaseDrawer id={sel} onClose={() => setSel(null)} onEdit={(r) => setForm({ open: true, release: r })} onDelete={(r) => setDel(r)} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete release ${del?.version ?? ''}?`} confirmLabel="Delete release"
        message={<>The release record is removed. Its <b>{fmtNum(del?.run_count ?? 0)}</b> runs are kept but no longer linked to a release.</>} onConfirm={() => del && remove(del)} />
    </div>
  );
}

function ReleaseDrawer({ id, onClose, onEdit, onDelete }: { id: string | null; onClose: () => void; onEdit: (r: Release) => void; onDelete: (r: Release) => void }) {
  const can = useCan();
  const theme = useUi((s) => s.theme);
  const { data: r, isLoading, error } = useQuery({ queryKey: ['inv', 'release', id], enabled: !!id, queryFn: () => api.get<ReleaseDetail>(`/releases/${id}`) });
  const runs = r?.runs ?? [];
  const chartRuns = [...runs].reverse().filter((x) => x.p95 != null);
  return (
    <Drawer open={!!id} onClose={onClose} width={780} icon={<Rocket size={18} />} title={r ? <span className="inv-title-row">{r.name}<span className="inv-key">{r.version}</span></span> : 'Release'}
      subtitle={r ? [r.application_name, r.environment_name].filter(Boolean).join(' · ') || 'All applications' : ''}
      footer={r && can('MANAGE_PROJECT') && <>
        <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => onDelete(r)}><Trash2 size={14} />Delete</button>
        <button className="btn" onClick={() => onEdit(r)}><Pencil size={14} />Edit release</button>
      </>}>
      {isLoading && <Loading height={260} />}
      <ErrorBox error={error} />
      {r && (
        <div className="stack">
          <KeyValue items={[
            ['Build', r.build_number && <span className="mono">{r.build_number}</span>], ['Branch', r.branch && <span className="mono">{r.branch}</span>],
            ['Commit', r.commit_sha && <span className="mono"><GitCommitHorizontal size={11} /> {r.commit_sha}</span>], ['Deployed', fmtDate(r.deployment_date)], ['Created', fmtDate(r.created_at)],
            ['Runs', fmtNum(runs.length)],
          ]} />
          {r.notes && <div className="notice" style={{ whiteSpace: 'pre-wrap' }}>{r.notes}</div>}
          {chartRuns.length > 0 && (
            <Chart title="P95 by run" subtitle="bars colored by result (label in tooltip)" height={170}
              table={{ columns: ['Run', 'Test', 'P95 (ms)', 'TPS', 'Result'], rows: chartRuns.map((x) => [x.run_key, x.test_name, num(x.p95), num(x.tps_avg), x.result ?? x.status]) }}
              option={{
                legend: { show: false }, tooltip: { trigger: 'axis', formatter: (ps: any) => { const x = chartRuns[ps[0].dataIndex]; return `<b>${x.run_key}</b><br/>${x.test_name}<br/>P95 ${fmtMs(num(x.p95))} · ${(x.result ?? x.status).replace(/_/g, ' ')}`; } },
                xAxis: { type: 'category', data: chartRuns.map((x) => x.run_key.slice(-6)) }, yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtMs(v) } },
                series: [{ type: 'bar', name: 'P95', barMaxWidth: 26, data: chartRuns.map((x) => ({ value: num(x.p95), itemStyle: { color: x.result === 'FAIL' ? '#d03b3b' : x.result === 'PASS_WITH_WARNINGS' ? '#c98500' : seriesColor(theme, 'p95'), borderRadius: [3, 3, 0, 0] } })) }],
              }} />
          )}
          <div>
            <div className="inv-section-title">Associated runs</div>
            {runs.length ? (
              <div className="card table-wrap"><table className="table"><thead><tr><th>Run ID</th><th>Test</th><th>Build</th><th>Started</th><th className="r">TPS</th><th className="r">P95</th><th className="r">Error %</th><th>Result</th></tr></thead>
                <tbody>{runs.map((x) => (
                  <tr key={x.id}><td><Link className="mono" to={`/runs/${x.run_key}`}>{x.run_key}</Link></td><td>{x.test_name}</td><td className="mono">{x.build_number ?? '—'}</td><td>{fmtDate(x.started_at)}</td>
                    <td className="r num">{fmtNum(num(x.tps_avg), 1)}</td><td className="r num">{fmtMs(num(x.p95))}</td><td className="r num">{fmtPct(num(x.error_pct))}</td><td><StatusBadge value={x.result ?? x.status} /></td></tr>
                ))}</tbody></table></div>
            ) : <EmptyState title="No runs linked">Start a run with <span className="mono">releaseVersion: "{r.version}"</span> (New run dialog or CI) to link it.</EmptyState>}
          </div>
          <div>
            <div className="inv-section-title">Builds</div>
            {r.builds.length ? (
              <div className="card table-wrap"><table className="table"><thead><tr><th>Build</th><th>Branch</th><th>Commit</th><th>CI</th><th>Created</th></tr></thead>
                <tbody>{r.builds.map((b) => (
                  <tr key={b.id}><td className="mono"><Package size={11} /> {b.build_number}</td><td className="mono">{b.branch ?? '—'}</td><td className="mono">{b.commit_sha?.slice(0, 10) ?? '—'}</td>
                    <td>{b.ci_url ? <a href={b.ci_url} target="_blank" rel="noreferrer">{b.ci_system ?? 'CI'}</a> : b.ci_system ?? '—'}</td><td>{fmtDate(b.created_at)}</td></tr>
                ))}</tbody></table></div>
            ) : <div className="muted" style={{ fontSize: 12 }}>No builds recorded. Builds are registered when runs are created with a build number and this release version.</div>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
