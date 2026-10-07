import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/services/api';
import { ConfirmDialog, ErrorBox, KeyValue, Loading, PageHeader } from '@/components/ui';
import { fmtDate } from '@/components/format';
import { Toaster, friendlyError, toast, useCan } from '@/components/inventory/common';
import { DownloadButtons, ReportStatusBadge, isPending, typeLabel, type ReportDetail } from '@/components/reports/shared';

/**
 * Report preview. The backend renders the report HTML (no scripts; strict CSP) and the page shows it
 * in a fully sandboxed iframe (no script execution, unique origin) — so report content can never run code in the app.
 */
export function ReportViewPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const [confirmDel, setConfirmDel] = useState(false);

  const { data: rep, error, isLoading } = useQuery({
    queryKey: ['reports', 'detail', id],
    queryFn: () => api.get<ReportDetail>(`/reports/${id}`),
    refetchInterval: (q) => (isPending(q.state.data?.status) ? 2000 : false),
  });
  const ready = rep?.status === 'READY';
  const preview = useQuery({
    queryKey: ['reports', 'preview', id, rep?.updatedAt],
    queryFn: async () => (await api.raw(`/reports/${id}/preview`)).text(),
    enabled: ready,
    staleTime: Infinity,
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<{ id: string; version: number }>(`/reports/${id}/regenerate`),
    onSuccess: (r) => { toast.success(`Generating version ${r.version}`); qc.invalidateQueries({ queryKey: ['reports'] }); nav(`/reports/${r.id}`); },
    onError: (e) => toast.error(friendlyError(e)),
  });
  const remove = async () => {
    try { await api.del(`/reports/${id}`, { confirm: true }); toast.success('Report deleted'); qc.invalidateQueries({ queryKey: ['reports'] }); nav('/reports'); }
    catch (e) { toast.error(friendlyError(e)); }
  };

  // keep the tab title meaningful
  useEffect(() => { if (rep?.title) document.title = `${rep.title} · Perfmon`; }, [rep?.title]);

  if (isLoading) return <div><PageHeader title="Report" /><Loading height={420} /></div>;
  if (error || !rep) return <div><PageHeader title="Report" /><ErrorBox error={error ?? new Error('Report not found')} /><Link to="/reports" className="btn btn-sm"><ArrowLeft size={14} />All reports</Link></div>;

  const c = rep.content;
  return (
    <div className="rp-view">
      <Toaster />
      <PageHeader
        title={rep.title}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <Link to="/reports" className="rp-back"><ArrowLeft size={13} />Reports</Link>
          <span className="badge">{typeLabel(rep.type)}</span>
          <span className="muted">v{rep.version}</span>
          <ReportStatusBadge status={rep.status} error={rep.error} />
        </span>}
        actions={<>
          {can('EXPORT_REPORT') && <DownloadButtons report={rep} />}
          {can('EXPORT_REPORT') && !isPending(rep.status) && <button className="btn btn-sm" disabled={regenerate.isPending} onClick={() => regenerate.mutate()} title="Generate a new version from current data">
            <RefreshCw size={14} className={regenerate.isPending ? 'spin' : ''} />Regenerate</button>}
          {can('EXPORT_REPORT') && <button className="btn btn-sm btn-ghost icon-btn" title="Delete" aria-label="Delete report" onClick={() => setConfirmDel(true)}><Trash2 size={14} /></button>}
        </>} />

      <div className="rp-layout">
        <aside className="card rp-meta">
          <div className="card-body">
            <KeyValue items={[
              ['Runs', rep.runKeys.length ? <span className="rp-subject">{rep.runKeys.map((k) => <Link key={k} className="mono" to={`/runs/${k}`}>{k}</Link>)}</span> : '—'],
              ['Project', rep.projectName],
              ...(rep.params.from && rep.params.to ? [['Period', `${rep.params.from.slice(0, 10)} → ${rep.params.to.slice(0, 10)}`] as [string, string]] : []),
              ['Created by', rep.createdBy ?? '—'],
              ['Created', fmtDate(rep.createdAt)],
              ['Generated', c ? fmtDate(c.generatedAt) : '—'],
              ...(c?.result ? [['Result', <span className={`rp-result rp-t-${resultTone(c.result.status)}`}>{c.result.status.replace(/_/g, ' ')}{c.result.score != null ? ` · ${c.result.score}/100` : ''}</span>] as [string, JSX.Element]] : []),
            ]} />
            {c && <nav className="rp-toc" aria-label="Report sections">
              <div className="muted small">Sections</div>
              {c.sections.map((s) => <span key={s.id}>{s.title}</span>)}
            </nav>}
          </div>
        </aside>

        <section className="card rp-preview-card">
          {isPending(rep.status) && (
            <div className="rp-pending" role="status" aria-live="polite">
              <RefreshCw size={20} className="spin" aria-hidden />
              <div><b>{rep.status === 'QUEUED' ? 'Waiting for a worker…' : 'Generating report…'}</b><div className="muted small">This page refreshes automatically. Reports are built from stored run analysis and usually take a few seconds.</div></div>
            </div>
          )}
          {rep.status === 'FAILED' && (
            <div className="rp-failed" role="alert">
              <b>Report generation failed</b>
              <div className="mono small">{rep.error ?? 'Unknown error'}</div>
              {can('EXPORT_REPORT') && <div><button className="btn btn-sm btn-primary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}><RefreshCw size={14} />Try again</button></div>}
            </div>
          )}
          {ready && (preview.isLoading ? <Loading height={600} />
            : preview.error ? <div className="card-body"><ErrorBox error={preview.error} /></div>
            : <iframe className="rp-frame" title={`Preview: ${rep.title}`} sandbox="" referrerPolicy="no-referrer" srcDoc={preview.data ?? ''} />)}
        </section>
      </div>

      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} title={`Delete “${rep.title}” v${rep.version}?`} confirmLabel="Delete"
        message="This report version is permanently deleted. The underlying run data is not affected and the report can be generated again." onConfirm={remove} />
    </div>
  );
}

const resultTone = (s: string) => (s === 'PASS' ? 'pass' : s === 'PASS_WITH_WARNINGS' ? 'warn' : s === 'FAIL' ? 'fail' : 'none');
