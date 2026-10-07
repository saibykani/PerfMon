import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ScrollText } from 'lucide-react';
import { api, download } from '@/services/api';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorBox } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { fmtDate, fmtNum } from '@/components/format';
import { EmptyState, Seg } from '../common';
import type { RunDetail } from '../types';

const enc = encodeURIComponent;
const TABLES = ['run_metrics', 'transaction_metrics', 'response_code_metrics', 'error_metrics', 'server_metrics', 'jvm_metrics', 'database_metrics', 'metric_points'];

export function RawTab({ run }: { run: RunDetail }) {
  const [table, setTable] = useState('run_metrics');
  const [view, setView] = useState<'table' | 'json'>('table');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(200);
  const [metric, setMetric] = useState('');
  const q = useQuery({
    queryKey: ['run-sub', run.runId, 'raw', table, page, pageSize, metric],
    queryFn: () => api.get<{ table: string; columns: string[]; total: number; page: number; pageSize: number; items: any[]; metrics: string[] }>(`/runs/${enc(run.runId)}/raw`, { table, page, pageSize, metric: metric || undefined }),
    placeholderData: (p) => p,
  });
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const fmt = (v: unknown, c: string) => (v == null ? '—' : c === 'ts' ? new Date(String(v)).toISOString().replace('T', ' ').slice(0, 23) : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : +v.toFixed(3)) : String(v));
  return (
    <section className="card">
      <div className="card-head row wrap">
        <select className="select" value={table} onChange={(e) => { setTable(e.target.value); setPage(1); setMetric(''); }} aria-label="Raw table">
          {TABLES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {table === 'metric_points' && (d?.metrics.length ?? 0) > 0 && (
          <select className="select" value={metric} onChange={(e) => { setMetric(e.target.value); setPage(1); }} aria-label="Metric"><option value="">All metrics</option>{d!.metrics.map((m) => <option key={m}>{m}</option>)}</select>
        )}
        {table === 'transaction_metrics' && <input className="input" placeholder="Transaction (exact)" value={metric} onChange={(e) => { setMetric(e.target.value); setPage(1); }} aria-label="Transaction filter" />}
        <Seg label="View" value={view} onChange={setView} options={[{ value: 'table', label: 'Table' }, { value: 'json', label: 'JSON' }]} />
        <div className="spacer" />
        <span className="muted small">{d ? `${fmtNum(d.total)} rows` : ''}</span>
        <button className="btn btn-sm" onClick={() => download(`/runs/${enc(run.runId)}/raw?table=${table}&format=csv${metric ? `&metric=${enc(metric)}` : ''}`, `${run.runId}-${table}.csv`)}><Download size={14} />CSV</button>
      </div>
      {q.error && <div className="card-body"><ErrorBox error={q.error} /></div>}
      {d && !d.total ? <EmptyState icon={<ScrollText size={22} />} title={`No rows in ${table}`}>This run has no data stored in this table.</EmptyState> : view === 'json' ? (
        <pre className="preview-text raw-json">{JSON.stringify(d?.items ?? [], null, 2)}</pre>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 600 }}>
          <table className="table compact-table mono-table">
            <thead><tr>{d?.columns.map((c) => <th key={c} className={c === 'ts' || c === 'source' || c === 'transaction' ? '' : 'r'}>{c}</th>)}</tr></thead>
            <tbody>
              {q.isLoading && <tr><td><div className="skeleton" style={{ height: 14, width: 400 }} /></td></tr>}
              {d?.items.map((r, i) => <tr key={i}>{d.columns.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'r num' : ''}>{fmt(r[c], c)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
      {d && d.total > 0 && (
        <div className="dt-pager">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          <div className="spacer" />
          <label className="muted small row">Rows per page
            <select className="select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>{[50, 200, 500, 1000].map((n) => <option key={n}>{n}</option>)}</select>
          </label>
        </div>
      )}
    </section>
  );
}

interface AuditRow { id: number; ts: string; user_email: string | null; action: string; resource_type: string; resource_id: string | null; ip: string | null; result: string; details: any }

export function AuditTab({ run }: { run: RunDetail }) {
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'audit'], queryFn: () => api.get<AuditRow[]>(`/runs/${enc(run.runId)}/audit`) });
  const cols: Column<AuditRow>[] = [
    { key: 'ts', header: 'Time', render: (r) => fmtDate(r.ts), value: (r) => r.ts },
    { key: 'user_email', header: 'User', render: (r) => r.user_email ?? <span className="muted">system / API key</span> },
    { key: 'action', header: 'Action', render: (r) => <span className="mono">{r.action}</span> },
    { key: 'resource_type', header: 'Resource' },
    { key: 'result', header: 'Result', render: (r) => <StatusBadge value={r.result === 'SUCCESS' ? 'PASS' : 'FAIL'} title={r.result} /> },
    { key: 'ip', header: 'IP', render: (r) => <span className="mono">{r.ip ?? '—'}</span> },
    { key: 'details', header: 'Details', value: (r) => JSON.stringify(r.details ?? {}), render: (r) => <span className="mono small muted wrap-cell">{Object.entries(r.details ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')}</span> },
  ];
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <section className="card">
      <DataTable rows={q.data ?? []} columns={cols} rowKey={(r) => String(r.id)} loading={q.isLoading} exportName={`${run.runId}-audit`} initialSort={{ key: 'ts', order: 'desc' }} empty="No audit entries for this run" />
    </section>
  );
}
