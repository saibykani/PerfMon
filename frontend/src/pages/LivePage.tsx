import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Radio, Timer } from 'lucide-react';
import { api } from '@/services/api';
import { useFilters } from '@/stores/filters';
import { PageHeader, ErrorBox } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { fmtDuration, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { EmptyState, StatusChip } from '@/components/run/common';
import { LiveWall } from '@/components/run/LiveWall';
import type { RunDetail, WindowStats } from '@/components/run/types';
import '@/styles/run.css';

interface LiveRun {
  id: string; run_key: string; status: string; started_at: string | null; live_last_ingest_at: string | null; virtual_users: number | null; target_tps: number | null;
  test_name: string; environment_name: string; last60s: WindowStats | null; totals: WindowStats | null;
}

function FinishedBanner({ runId, status }: { runId: string; status: string }) {
  const nav = useNavigate();
  const [left, setLeft] = useState(8);
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.get<RunDetail>(`/runs/${encodeURIComponent(runId)}`), refetchInterval: (q) => ((q.state.data as RunDetail | undefined)?.status === 'ANALYZING' ? 3000 : false) });
  useEffect(() => {
    if (left <= 0) { nav(`/runs/${runId}`); return; }
    const id = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [left, nav, runId]);
  const r = run.data;
  return (
    <div className="finished-banner" role="status">
      <div>
        <b>Run {status === 'ABORTED' ? 'aborted' : 'finished'}.</b>{' '}
        {r?.result ? <>Final result <StatusChip status={r.result} label={r.result.replace(/_/g, ' ')} size="sm" /> · score {r.performanceScore ?? '—'}</> : <span className="muted">Analysis in progress…</span>}
      </div>
      <div className="spacer" />
      <span className="muted small"><Timer size={12} /> opening the final result in {left}s</span>
      <button className="btn btn-sm" onClick={() => setLeft(9999)}>Stay here</button>
      <Link className="btn btn-sm btn-primary" to={`/runs/${runId}`}>View result <ArrowRight size={13} /></Link>
    </div>
  );
}

export function LivePage() {
  const { runId } = useParams();
  const nav = useNavigate();
  const projectId = useFilters((s) => s.projectId);
  const [finished, setFinished] = useState<string | null>(null);
  useEffect(() => setFinished(null), [runId]);
  const q = useQuery({ queryKey: ['live-runs', projectId], queryFn: () => api.get<LiveRun[]>('/live/runs', { projectId }), refetchInterval: 5000 });
  const runs = q.data ?? [];
  const running = runs.filter((r) => r.status === 'RUNNING');
  const sel = runs.find((r) => r.run_key === runId);

  // open the first running test automatically
  useEffect(() => { if (!runId && running.length) nav(`/live/${running[0].run_key}`, { replace: true }); }, [runId, running, nav]);

  return (
    <div className="live-page">
      <PageHeader title={<span className="row" style={{ gap: 8 }}><Radio size={18} className={running.length ? 'live-ink' : ''} />Live Monitoring</span>}
        subtitle={running.length ? `${running.length} test${running.length > 1 ? 's' : ''} running now · streamed over Server-Sent Events` : 'Running tests and runs finished in the last 15 minutes'}
        actions={runId && <Link className="btn btn-sm" to={`/runs/${runId}`}>Open run details <ArrowRight size={13} /></Link>} />
      {q.error && <ErrorBox error={q.error} />}
      <div className="live-layout">
        <aside className="live-list card" aria-label="Live and recent runs">
          <div className="card-head"><h3>Runs</h3><span className="muted small">{runs.length}</span></div>
          {q.isLoading && <div className="card-body stack">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 70 }} />)}</div>}
          {!q.isLoading && !runs.length && <div className="card-body"><div className="muted small">No running or recently finished tests.</div></div>}
          {runs.map((r) => {
            const s = r.last60s ?? r.totals;
            return (
              <button key={r.id} className={`live-item ${r.run_key === runId ? 'on' : ''}`} onClick={() => nav(`/live/${r.run_key}`)}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                  <b className="ellipsis">{r.test_name}</b>
                  {r.status === 'RUNNING' ? <span className="live-pill"><span className="dot live-dot" />LIVE</span> : <StatusBadge value={r.status} />}
                </div>
                <div className="mono small muted">{r.run_key} · {r.environment_name}</div>
                <div className="live-item-stats small">
                  <span><i>TPS</i>{fmtNum(s?.tpsAvg, 1)}</span><span><i>P95</i>{s?.percentileMethod === 'interval_weighted_approx' && s?.p95 != null ? '≈' : ''}{fmtMs(s?.p95)}</span>
                  <span><i>Err</i>{fmtPct(s?.errorPct, 1)}</span><span><i>{r.status === 'RUNNING' ? 'Elapsed' : 'Dur'}</i>{r.started_at ? fmtDuration(r.status === 'RUNNING' ? (Date.now() - new Date(r.started_at).getTime()) / 1000 : s?.durationSec) : '—'}</span>
                </div>
              </button>
            );
          })}
        </aside>
        <div className="live-main">
          {finished && runId && <FinishedBanner runId={runId} status={finished} />}
          {runId ? (
            <>
              <div className="live-title">
                <h2>{sel?.test_name ?? runId}</h2>
                <span className="mono muted">{runId}</span>
                {sel?.environment_name && <span className="badge">{sel.environment_name}</span>}
                {sel?.virtual_users != null && <span className="muted small">{sel.virtual_users} VUs planned{sel.target_tps ? ` · target ${sel.target_tps} TPS` : ''}</span>}
              </div>
              <LiveWall runId={runId} big onFinished={(st) => setFinished(st)} />
            </>
          ) : !q.isLoading && (
            <EmptyState icon={<Radio size={28} />} title="No test is running right now" action={<Link className="btn btn-primary" to="/runs">Browse recent runs</Link>}>
              Start a JMeter test with the Perfmon Backend Listener (Run ID + ingestion URL) — it appears here automatically with second-level metrics.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
