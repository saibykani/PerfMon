import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/services/api';
import { ConfirmDialog, ErrorBox, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtDate, fmtRelative } from '@/components/format';
import { EmptyState, Toaster, friendlyError, toast, useCan } from '@/components/inventory/common';
import { useProjects } from '@/components/inventory/data';
import { DownloadButtons, NewReportDialog, REPORT_TYPES, ReportStatusBadge, isPending, typeLabel, type ReportList, type ReportRow } from '@/components/reports/shared';

const PAGE_SIZE = 25;

export function ReportsPage() {
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? '';
  const type = params.get('type') ?? '';
  const status = params.get('status') ?? '';
  const runId = params.get('runId') ?? '';
  const q = params.get('q') ?? '';
  const [qInput, setQInput] = useState(q);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [del, setDel] = useState<ReportRow | null>(null);
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); setPage(1); };
  useEffect(() => { const h = setTimeout(() => { if (qInput !== q) setParam('q', qInput); }, 300); return () => clearTimeout(h); }, [qInput]); // eslint-disable-line

  const projects = useProjects();
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['reports', 'list', projectId, type, status, runId, q, page],
    queryFn: () => api.get<ReportList>('/reports', { projectId, type, status, runId, q, page, pageSize: PAGE_SIZE }),
    placeholderData: (p) => p,
    // keep polling while anything on the page is still being generated
    refetchInterval: (query) => (query.state.data?.items.some((r) => isPending(r.status)) ? 2500 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['reports'] });

  const remove = async (r: ReportRow) => {
    try { await api.del(`/reports/${r.id}`, { confirm: true }); toast.success(`“${r.title}” v${r.version} deleted`); refresh(); }
    catch (e) { toast.error(friendlyError(e)); }
  };

  const cols = useMemo<Column<ReportRow>[]>(() => [
    { key: 'title', header: 'Report', sortable: false, render: (r) => (
      <span className="rp-title-cell">
        <Link to={`/reports/${r.id}`} onClick={(e) => e.stopPropagation()}><b>{r.title}</b></Link>
        <span className="muted small">v{r.version}{r.auto ? ' · automatic' : ''}</span>
      </span>) },
    { key: 'type', header: 'Type', sortable: false, render: (r) => <span className="badge">{typeLabel(r.type)}</span> },
    { key: 'status', header: 'Status', sortable: false, render: (r) => <ReportStatusBadge status={r.status} error={r.error} /> },
    { key: 'subject', header: 'Run / project', sortable: false, value: (r) => r.runKeys.join(' ') || r.projectName, render: (r) => (
      <span className="rp-subject">
        {r.runKeys.length ? r.runKeys.map((k) => <Link key={k} className="mono" to={`/runs/${k}`} onClick={(e) => e.stopPropagation()}>{k}</Link>) : null}
        <span className="muted small">{r.projectName}{r.type === 'EXECUTIVE' && r.params.from && r.params.to ? ` · ${r.params.from.slice(0, 10)} → ${r.params.to.slice(0, 10)}` : ''}</span>
      </span>) },
    { key: 'createdBy', header: 'Created by', sortable: false, render: (r) => r.createdBy ?? '—' },
    { key: 'created', header: 'Created', sortable: false, value: (r) => r.createdAt, render: (r) => <span title={fmtDate(r.createdAt)}>{fmtRelative(r.createdAt)}</span> },
    { key: 'download', header: 'Download', sortable: false, render: (r) => (can('EXPORT_REPORT') ? <DownloadButtons report={r} compact /> : <span className="muted small">No export permission</span>) },
    { key: 'act', header: '', sortable: false, render: (r) => can('EXPORT_REPORT') && (
      <button className="btn btn-ghost icon-btn btn-sm" title="Delete" aria-label={`Delete ${r.title}`} onClick={(e) => { e.stopPropagation(); setDel(r); }}><Trash2 size={14} /></button>) },
  ], [can]);

  const filtered = !!(projectId || type || status || runId || q);

  return (
    <div>
      <Toaster />
      <PageHeader title="Reports" subtitle="Test execution, comparison and executive reports generated from stored run analysis — downloadable as PDF, HTML, Excel, CSV or JSON."
        actions={can('EXPORT_REPORT') && <button className="btn btn-primary" onClick={() => setCreating(true)}><FilePlus2 size={15} />New report</button>} />
      <ErrorBox error={error} />
      <div className="card">
        <DataTable rows={data?.items ?? []} columns={cols} rowKey={(r) => r.id} loading={isLoading} exportName="reports" maxHeight={700}
          onRowClick={(r) => nav(`/reports/${r.id}`)}
          server={{ page, pageSize: PAGE_SIZE, total: data?.total ?? 0, onPage: setPage, onSort: () => undefined, search: qInput, onSearch: setQInput }}
          toolbar={<>
            <select className="select" aria-label="Type" value={type} onChange={(e) => setParam('type', e.target.value)} style={{ maxWidth: 170 }}>
              <option value="">All types</option>{REPORT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <select className="select" aria-label="Status" value={status} onChange={(e) => setParam('status', e.target.value)} style={{ maxWidth: 140 }}>
              <option value="">All statuses</option><option value="QUEUED">Pending</option><option value="GENERATING">Generating</option><option value="READY">Ready</option><option value="FAILED">Failed</option>
            </select>
            <select className="select" aria-label="Project" value={projectId} onChange={(e) => setParam('projectId', e.target.value)} style={{ maxWidth: 190 }}>
              <option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input key={runId} className="input mono" aria-label="Run ID" placeholder="Run ID" defaultValue={runId} style={{ width: 190 }}
              onBlur={(e) => setParam('runId', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && setParam('runId', (e.target as HTMLInputElement).value.trim())} />
            <button className="btn btn-ghost icon-btn btn-sm" title="Refresh" aria-label="Refresh" onClick={refresh}><RefreshCw size={14} className={isFetching ? 'spin' : ''} /></button>
          </>}
          empty={<EmptyState icon={<FileText size={20} />} title={filtered ? 'No reports match these filters' : 'No reports yet'}
            action={!filtered && can('EXPORT_REPORT') && <button className="btn btn-primary" onClick={() => setCreating(true)}><FilePlus2 size={14} />New report</button>}>
            {filtered ? 'Clear a filter or search by title or Run ID.' : 'A test execution report is generated automatically when a run finishes. Create comparison or executive reports on demand.'}
          </EmptyState>} />
      </div>
      {creating && <NewReportDialog open onClose={() => { setCreating(false); if (params.get('new')) setParam('new', ''); }} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete “${del?.title ?? ''}” v${del?.version ?? ''}?`} confirmLabel="Delete"
        message="This report version is permanently deleted. The underlying run data is not affected and the report can be generated again." onConfirm={() => del && remove(del)} />
    </div>
  );
}
