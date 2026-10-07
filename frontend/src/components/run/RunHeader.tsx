import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Flag, FileText, GitCompare, RefreshCw, Square, CheckSquare, ChevronDown, GitBranch, GitCommit, Package, Server, Clock, Star, Gauge, Radio } from 'lucide-react';
import { api, ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { StatusBadge } from '@/components/Status';
import { ConfirmDialog } from '@/components/ui';
import { fmtDate, fmtDuration } from '@/components/format';
import { CopyButton, Popover, StatusChip } from './common';
import type { RunDetail } from './types';

function ScoreRing({ score }: { score: number | null }) {
  const v = score ?? 0;
  const lvl = score == null ? 'none' : v >= 85 ? 'good' : v >= 70 ? 'warn' : 'bad';
  const r = 17; const c = 2 * Math.PI * r;
  return (
    <span className={`score-ring score-${lvl}`} aria-label={`Performance score ${score ?? 'not available'}`}>
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
        <circle cx="22" cy="22" r={r} className="track" />
        <circle cx="22" cy="22" r={r} className="val" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 22 22)" />
      </svg>
      <b className="num">{score ?? '—'}</b>
    </span>
  );
}

export function RunHeader({ run, live, onNotice }: { run: RunDetail; live?: boolean; onNotice: (msg: string, kind?: 'ok' | 'err') => void }) {
  const can = useAuth((s) => s.can);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [confirm, setConfirm] = useState<null | 'complete' | 'abort'>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['run', run.runId] }); qc.invalidateQueries({ queryKey: ['run-sub', run.runId] }); };
  const err = (e: unknown) => onNotice((e as Error).message, 'err');

  const baseline = useMutation({ mutationFn: (on: boolean) => api.post(`/runs/${run.runId}/baseline`, { baseline: on }), onSuccess: (_d, on) => { onNotice(on ? 'Marked as the baseline of this test' : 'Baseline flag removed'); refresh(); }, onError: err });
  const complete = useMutation({ mutationFn: () => api.post(`/runs/${run.runId}/complete`, {}), onSuccess: () => { onNotice('Run completed — analysis queued'); refresh(); }, onError: err });
  const abort = useMutation({ mutationFn: () => api.post(`/runs/${run.runId}/abort`, {}), onSuccess: () => { onNotice('Run aborted'); refresh(); }, onError: err });
  const reanalyze = useMutation({ mutationFn: () => api.post(`/runs/${run.runId}/reanalyze`), onSuccess: () => { onNotice('Re-analysis queued (SLA, regression, bottlenecks, insights, score)'); setTimeout(refresh, 2500); }, onError: err });
  const report = useMutation({
    mutationFn: () => api.post<{ id: string }>('/reports', { type: 'TEST_EXECUTION', runId: run.runId, projectId: run.projectId }),
    onSuccess: (r) => { onNotice('Report generation queued'); if (r?.id) nav(`/reports/${r.id}`); },
    onError: (e) => onNotice(e instanceof ApiError && e.status === 404 ? 'Report generation is not available on this server yet.' : (e as Error).message, 'err'),
  });

  const rb = run.resultBreakdown;
  const sb = run.scoreBreakdown;
  const running = run.status === 'RUNNING';
  const result = run.result ?? (run.status === 'ANALYZING' ? null : rb?.result ?? null);

  return (
    <div className="run-head card">
      <div className="run-head-main">
        <div className="run-head-title">
          <div className="crumbs muted">
            <Link to={`/projects/${run.projectId}`}>{run.projectName}</Link><span>/</span>
            <span>{run.applicationName}</span><span>/</span>
            <Link to={`/tests/${run.testId}`}>{run.testName}</Link>
          </div>
          <div className="row wrap" style={{ gap: 10 }}>
            <h1 className="run-title">{run.testName}</h1>
            <span className="run-id mono">{run.runId}<CopyButton text={run.runId} label="Copy Run ID" /></span>
            {live && <span className="live-pill"><span className="dot live-dot" />LIVE</span>}
            <StatusBadge value={run.status} />
            {run.isBaseline && <span className="badge accent"><Star size={11} />Baseline</span>}
            <span className="badge">{run.testType}</span>
          </div>
        </div>
        <div className="run-actions row wrap">
          {running && can('EXECUTE_TEST') && <>
            <button className="btn btn-sm" onClick={() => setConfirm('complete')}><CheckSquare size={14} />Complete</button>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirm('abort')}><Square size={14} />Abort</button>
          </>}
          {run.baseline && <Link className="btn btn-sm" to={`/runs/${run.runId}/comparison`}><GitCompare size={14} />Compare with baseline</Link>}
          {can('EDIT_TEST') && !running && (
            <button className="btn btn-sm" disabled={baseline.isPending} onClick={() => baseline.mutate(!run.isBaseline)}><Flag size={14} />{run.isBaseline ? 'Unmark baseline' : 'Mark as baseline'}</button>
          )}
          {can('EXECUTE_TEST') && !running && <button className="btn btn-sm" disabled={reanalyze.isPending} onClick={() => reanalyze.mutate()}><RefreshCw size={14} className={reanalyze.isPending ? 'spin' : ''} />Re-analyze</button>}
          {can('EXPORT_REPORT') && <button className="btn btn-sm btn-primary" disabled={report.isPending} onClick={() => report.mutate()}><FileText size={14} />Generate report</button>}
        </div>
      </div>

      <div className="run-head-verdict">
        <div className="verdict-block">
          <div className="vlabel">Result</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {result ? <StatusChip status={result} label={result.replace(/_/g, ' ')} /> : <span className="chip chip-neutral">{run.status === 'ANALYZING' ? 'Analyzing…' : running ? 'In progress' : 'Pending'}</span>}
            {rb && Object.entries(rb.breakdown).map(([dim, st]) => <StatusChip key={dim} size="sm" status={st} label={<><span className="dim">{dim}</span>{st === 'N/A' ? ' n/a' : ''}</>} title={`${dim}: ${st}`} />)}
          </div>
          {run.resultReason && <div className="muted small">{run.resultReason}</div>}
        </div>
        <div className="verdict-block">
          <div className="vlabel">Performance score</div>
          <Popover align="right" width={360} trigger={(open, toggle) => (
            <button className={`score-btn ${open ? 'open' : ''}`} onClick={toggle} aria-expanded={open} aria-label="Show score breakdown">
              <ScoreRing score={run.performanceScore} />
              <span className="muted small">{sb?.factors?.length ? `${sb.factors.length} factors` : 'not scored'}<ChevronDown size={12} /></span>
            </button>
          )}>
            <div className="score-pop">
              <div className="row" style={{ justifyContent: 'space-between' }}><b><Gauge size={13} /> Score breakdown</b><span className="muted small">weighted 0–100</span></div>
              {!sb?.factors?.length && <div className="muted">The score is computed when analysis completes.</div>}
              {sb?.factors?.map((f) => (
                <div key={f.key} className="factor">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span>{f.label} <span className="muted small">×{f.weight}</span></span>
                    <b className="num">{f.score == null ? 'n/a' : Math.round(f.score)}</b>
                  </div>
                  <div className="factor-bar"><span style={{ width: `${f.score ?? 0}%` }} className={f.score == null ? '' : f.score >= 85 ? 'good' : f.score >= 60 ? 'warn' : 'bad'} /></div>
                  <div className="muted small">{f.detail}</div>
                </div>
              ))}
              <div className="muted small" style={{ marginTop: 6 }}>The score never replaces the metrics — see the KPI cards and SLA tab for raw values.</div>
            </div>
          </Popover>
        </div>
        <dl className="run-meta">
          <div><dt><Server size={11} />Environment</dt><dd>{run.environmentName}<span className="muted"> · {run.environmentType}</span></dd></div>
          <div><dt><Package size={11} />Build / version</dt><dd>{run.buildNumber ?? '—'}{run.version ? ` · v${run.version}` : ''}{run.releaseVersion ? ` · rel ${run.releaseVersion}` : ''}</dd></div>
          <div><dt><GitBranch size={11} />Branch</dt><dd className="mono">{run.branch ?? '—'}</dd></div>
          <div><dt><GitCommit size={11} />Commit</dt><dd className="mono">{run.commit ? run.commit.slice(0, 10) : '—'}</dd></div>
          <div><dt><Clock size={11} />Started</dt><dd>{fmtDate(run.startedAt)}</dd></div>
          <div><dt><Clock size={11} />Completed</dt><dd>{running ? <span className="row" style={{ gap: 4 }}><Radio size={12} className="live-ink" />running</span> : fmtDate(run.endedAt)}</dd></div>
          <div><dt><Clock size={11} />Duration</dt><dd>{fmtDuration(run.durationSec)}</dd></div>
          <div><dt><Star size={11} />Baseline</dt><dd>{run.baseline ? <Link to={`/runs/${run.baseline.runKey}`} className="mono" title={run.baseline.reason}>{run.baseline.runKey}</Link> : run.isBaseline ? 'this run' : '—'}</dd></div>
        </dl>
      </div>

      <ConfirmDialog open={confirm === 'complete'} title="Complete this run?" danger={false} confirmLabel="Complete run"
        message={<>Buffered metrics are flushed, the end time is set and the analysis workflow (summary → SLA → regression → bottleneck → insights → score) starts for <b className="mono">{run.runId}</b>.</>}
        onConfirm={() => complete.mutate()} onClose={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'abort'} title="Abort this run?" confirmLabel="Abort run"
        message={<>The run <b className="mono">{run.runId}</b> is marked ABORTED. Metrics received so far are kept and analysed.</>}
        onConfirm={() => abort.mutate()} onClose={() => setConfirm(null)} />
    </div>
  );
}
