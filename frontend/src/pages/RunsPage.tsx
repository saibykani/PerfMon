import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/services/api';
import { StatusBadge } from '@/components/Status';
import { fmtMs, fmtNum, fmtPct, fmtDuration, fmtDate, approx } from '@/components/format';

export interface RunRow {
  id: string; runId: string; status: string; result: string | null; testName: string; environmentName: string; buildNumber: string | null;
  startedAt: string | null; createdAt: string; durationSec: number | null; virtualUsers: number | null;
  kpis?: { tps: number | null; avgRt: number | null; p95: number | null; errorPct: number | null; usersPeak: number | null; percentileMethod: string | null };
}

const STATUSES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'ANALYZING', 'COMPLETED', 'FAILED', 'ABORTED', 'CANCELLED'];

export function RunsPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'start', order: 'desc' });
  const { data, isLoading, error } = useQuery({
    queryKey: ['runs', q, status, page, sort],
    queryFn: () => api.get<{ items: RunRow[]; total: number; totalPages: number }>('/runs', { q, status, page, pageSize: 50, sort: sort.key, order: sort.order }),
    refetchInterval: 10000,
  });
  const th = (key: string, label: string, r = false) => (
    <th className={`sortable ${r ? 'r' : ''}`} onClick={() => setSort((s) => ({ key, order: s.key === key && s.order === 'desc' ? 'asc' : 'desc' }))}>
      {label}{sort.key === key ? (sort.order === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <div>
      <div className="page-head">
        <div><h1>Test Runs</h1><div className="sub">Every execution has a unique Run ID; all metrics, artifacts and analysis reference it.</div></div>
      </div>
      <div className="card">
        <div className="card-head row wrap">
          <input className="input" placeholder="Search Run ID, test, build, commit, tag…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ width: 320 }} />
          <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <div className="spacer" />
          <span className="muted">{data ? `${fmtNum(data.total)} runs` : ''}</span>
        </div>
        {error && <div className="card-body"><div className="error-box">{(error as Error).message}</div></div>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {th('runId', 'Run ID')}{th('test', 'Test')}{th('environment', 'Environment')}{th('build', 'Build')}{th('start', 'Start')}{th('duration', 'Duration', true)}
                {th('users', 'Users', true)}{th('tps', 'TPS', true)}{th('avgRt', 'Avg RT', true)}{th('p95', 'P95', true)}{th('errorPct', 'Error %', true)}{th('status', 'Status')}{th('result', 'Result')}
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={13}><div className="skeleton" style={{ height: 16 }} /></td></tr>}
              {data?.items.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/runs/${r.runId}`)}>
                  <td className="mono"><a href={`/runs/${r.runId}`} onClick={(e) => e.preventDefault()}>{r.runId}</a></td>
                  <td>{r.testName}</td>
                  <td>{r.environmentName}</td>
                  <td className="mono">{r.buildNumber ?? '—'}</td>
                  <td>{fmtDate(r.startedAt ?? r.createdAt)}</td>
                  <td className="r num">{fmtDuration(r.durationSec)}</td>
                  <td className="r num">{fmtNum(r.kpis?.usersPeak ?? r.virtualUsers)}</td>
                  <td className="r num">{fmtNum(r.kpis?.tps, 1)}</td>
                  <td className="r num">{fmtMs(r.kpis?.avgRt)}</td>
                  <td className="r num">{approx(r.kpis?.percentileMethod)}{fmtMs(r.kpis?.p95)}</td>
                  <td className="r num">{fmtPct(r.kpis?.errorPct)}</td>
                  <td><StatusBadge value={r.status} /></td>
                  <td><StatusBadge value={r.result} /></td>
                </tr>
              ))}
              {data && !data.items.length && <tr><td colSpan={13}><div className="empty">No runs yet. Create one via the API (POST /api/v1/runs) or from a Performance Test.</div></td></tr>}
            </tbody>
          </table>
        </div>
        {data && data.totalPages > 1 && (
          <div className="card-body row">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted">Page {page} of {data.totalPages}</span>
            <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
