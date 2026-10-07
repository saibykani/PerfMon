import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Crosshair, FileText, Lightbulb, MousePointerClick, RotateCcw, Sparkles, Target, Wrench } from 'lucide-react';
import { api } from '@/services/api';
import { ErrorBox } from '@/components/ui';
import { fmtMs, fmtNum, fmtPct } from '@/components/format';
import { ApproxNote, ConfidenceMeter, CopyButton, SeverityIcon, SkeletonGrid, StatusChip, confidenceWord, fmtTime } from '../common';
import { RunKpis, fromStats, fromSummary, type Deltas } from '../RunKpis';
import { SyncedCharts, toMarkers } from '../SyncedCharts';
import type { RunDetail, TimelineResponse, TimeWindow, TxnRow, WindowStats } from '../types';

export interface InsightsResponse {
  insights: { id: string; category: string; severity: string; title: string; description: string; evidence: string[]; confidence: number | null; confidence_label: string | null; component: string | null }[];
  recommendations: { id: string; category: string; priority: string; title: string; description: string }[];
  regressions: { id: string; scope: string; transaction: string | null; metric: string; previous_value: number | null; current_value: number | null; change_pct: number | null; threshold_pct: number | null; direction: string; severity: string; likely_impacted: string[]; baseline_run_key: string | null }[];
  analysis: RunDetail['analysis']; analyzedAt: string | null; result: string | null;
}

export const useInsights = (runId: string, enabled = true) => useQuery({ queryKey: ['run-sub', runId, 'insights'], queryFn: () => api.get<InsightsResponse>(`/runs/${encodeURIComponent(runId)}/insights`), enabled });
export const useTimeline = (runId: string, live: boolean) => useQuery({
  queryKey: ['run-sub', runId, 'timeline'], queryFn: () => api.get<TimelineResponse>(`/runs/${encodeURIComponent(runId)}/timeline`), refetchInterval: live ? 10000 : false,
});

/** Final run summary: major finding, likely bottleneck (with honest confidence wording) and recommendation. */
export function RunSummaryCard({ run, insights }: { run: RunDetail; insights?: InsightsResponse }) {
  const text = useQuery({ queryKey: ['run-sub', run.runId, 'summary-text'], queryFn: () => api.get<string>(`/runs/${encodeURIComponent(run.runId)}/summary-text`), enabled: !['RUNNING', 'SCHEDULED', 'QUEUED'].includes(run.status) });
  const regs = (insights?.regressions ?? []).filter((r) => r.direction === 'REGRESSION');
  const topReg = [...regs].sort((a, b) => Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0))[0];
  const critical = insights?.insights.find((i) => i.severity === 'CRITICAL' && i.category !== 'REGRESSION') ?? insights?.insights.find((i) => i.severity !== 'INFO');
  const bott = [...(run.analysis?.bottlenecks ?? insights?.analysis?.bottlenecks ?? [])].sort((a, b) => b.confidence - a.confidence)[0];
  const rec = insights?.recommendations[0];
  const s = run.summary;
  const pending = !run.analyzedAt;
  const finding = topReg
    ? `${topReg.transaction ?? 'Run'} ${topReg.metric.toUpperCase()} ${(topReg.change_pct ?? 0) > 0 ? 'increased' : 'changed'} ${Math.abs(topReg.change_pct ?? 0).toFixed(0)}% vs baseline ${topReg.baseline_run_key ?? ''} (${fmtNum(topReg.previous_value, 1)} → ${fmtNum(topReg.current_value, 1)}).`
    : critical ? `${critical.title}. ${critical.description}` : pending ? null : 'No regressions or significant issues detected.';
  return (
    <section className="card summary-card">
      <div className="card-head">
        <h3><Sparkles size={13} /> Run summary</h3>
        <div className="row">
          {text.data && <CopyButton text={text.data} label="Copy run summary text" />}
          {pending && <span className="badge accent">analysis pending</span>}
        </div>
      </div>
      <div className="card-body summary-body">
        <p className="summary-lede">
          <b>{run.testName}</b> ran for <b>{s?.durationSec ? `${Math.round(s.durationSec / 60)} min` : '—'}</b> with <b>{fmtNum(s?.usersPeak ?? run.virtualUsers)}</b> users at <b>{fmtNum(s?.tps, 1)} TPS</b>;
          P95 <b>{s?.percentileMethod === 'interval_weighted_approx' ? '≈ ' : ''}{fmtMs(s?.p95)}</b>, errors <b>{fmtPct(s?.errorPct)}</b>{s?.slaPassPct != null ? <>, SLA <b>{fmtPct(s.slaPassPct, 1)}</b></> : null}.
          {' '}{regs.length ? <span className="ink-fail">{regs.length} regression{regs.length > 1 ? 's' : ''} vs baseline.</span> : run.baseline ? <span className="ink-pass">No regression vs baseline.</span> : null}
        </p>
        <div className="summary-grid">
          <div className="sum-item"><div className="sum-k"><Target size={12} />Major finding</div><div className="sum-v">{finding ?? <span className="muted">Available after analysis completes.</span>}</div></div>
          <div className="sum-item">
            <div className="sum-k"><Crosshair size={12} />Likely bottleneck</div>
            <div className="sum-v">
              {bott ? <>
                <div className="row wrap" style={{ gap: 8 }}><b>{bott.confidence >= 0.45 ? bott.component : 'No clear bottleneck'}</b><ConfidenceMeter value={bott.confidence} label={bott.label ?? confidenceWord(bott.confidence)} /></div>
                {bott.evidence?.[0] && <div className="muted small">{bott.evidence[0]}</div>}
              </> : <span className="muted">{pending ? 'Available after analysis completes.' : 'Insufficient evidence — send server, JVM and DB metrics with the Run ID to enable correlation.'}</span>}
            </div>
          </div>
          <div className="sum-item"><div className="sum-k"><Wrench size={12} />Recommendation</div><div className="sum-v">{rec ? <><b>{rec.title}.</b> {rec.description}</> : <span className="muted">No recommendation.</span>}</div></div>
        </div>
      </div>
    </section>
  );
}

export function OverviewTab({ run, live, range, setRange, deltas, compact, goTab }: {
  run: RunDetail; live: boolean; range: TimeWindow; setRange: (r: TimeWindow) => void; deltas?: Deltas; compact?: boolean;
  goTab: (tab: string, search?: string) => void;
}) {
  const tl = useTimeline(run.runId, live);
  const [nonce, setNonce] = useState(0);
  const ins = useInsights(run.runId);
  const stats = useQuery({
    queryKey: ['run-sub', run.runId, 'stats', range?.from, range?.to],
    queryFn: () => api.get<WindowStats | null>(`/runs/${encodeURIComponent(run.runId)}/stats`, { from: range!.from, to: range!.to }),
    enabled: !!range, placeholderData: (p) => p,
  });
  const liveStats = useQuery({
    queryKey: ['run-sub', run.runId, 'stats-all'], queryFn: () => api.get<WindowStats | null>(`/runs/${encodeURIComponent(run.runId)}/stats`),
    enabled: !run.summary, refetchInterval: live ? 10000 : false,
  });
  const txns = useQuery({
    queryKey: ['run-sub', run.runId, 'transactions', range?.from, range?.to],
    queryFn: () => api.get<{ source: string; items: TxnRow[] }>(`/runs/${encodeURIComponent(run.runId)}/transactions`, { from: range?.from, to: range?.to }),
    placeholderData: (p) => p,
  });
  const kpis = range ? fromStats(stats.data) : fromSummary(run.summary) ?? fromStats(liveStats.data);
  const markers = useMemo(() => toMarkers(tl.data?.events, tl.data?.annotations), [tl.data]);
  const pts = tl.data?.points ?? [];

  const onRange = (from: number, to: number) => {
    if (!pts.length) return;
    const first = pts[0].t, last = pts[pts.length - 1].t;
    if (from <= first + 1 && to >= last - 1) { setRange(null); return; }
    setRange({ from: Math.round(from), to: Math.round(to) });
  };
  const reset = () => { setRange(null); setNonce((n) => n + 1); };
  const slow = [...(txns.data?.items ?? [])].sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0)).slice(0, 6);
  const topInsights = (ins.data?.insights ?? []).slice(0, 4);

  return (
    <div className="stack">
      {range && (
        <div className="range-bar" role="status">
          <Crosshair size={14} />
          <span>Selected range <b className="num">{fmtTime(range.from)}</b> → <b className="num">{fmtTime(range.to)}</b> <span className="muted">({Math.round((range.to - range.from) / 1000)} s)</span></span>
          <span className="muted">KPI cards and transactions are recomputed for this window{stats.isFetching ? '…' : '.'}</span>
          <div className="spacer" />
          <button className="btn btn-sm" onClick={() => goTab('logs', `?from=${range.from}&to=${range.to}`)}>Logs in range</button>
          <button className="btn btn-sm btn-primary" onClick={reset}><RotateCcw size={13} />Reset</button>
        </div>
      )}
      {kpis ? <RunKpis k={kpis} deltas={deltas} ranged={!!range} compact={compact} onKpiClick={(t) => goTab(t)} /> : <SkeletonGrid count={8} />}
      {!range && deltas && run.baseline && <div className="muted small delta-note">Deltas vs baseline <span className="mono">{run.baseline.runKey}</span> ({run.baseline.reason}). Arrows show direction; green = better, red = worse.</div>}

      <RunSummaryCard run={run} insights={ins.data} />

      <section className="card">
        <div className="card-head">
          <h3>Timeline</h3>
          <div className="row wrap small muted" style={{ gap: 12 }}>
            <ApproxNote method={tl.data?.percentileMethod ?? run.summary?.percentileMethod} compact />
            <span className="row" style={{ gap: 4 }}><Crosshair size={12} />Drag on any chart to select a range</span>
            <span className="row" style={{ gap: 4 }}><MousePointerClick size={12} />Click a point for correlated logs</span>
            {tl.data && <span>step {tl.data.step}s · source {tl.data.source}</span>}
          </div>
        </div>
        <div className="card-body">
          {tl.error && <ErrorBox error={tl.error} />}
          <SyncedCharts key={nonce} points={pts} infra={tl.data?.infra} markers={markers} percentileMethod={tl.data?.percentileMethod} group={`run-${run.runId}`}
            loading={tl.isLoading} onRange={onRange} onPointClick={(ts) => goTab('logs', `?around=${Math.round(ts)}`)} height={compact ? 130 : 145} />
          {!tl.isLoading && !pts.length && <div className="notice" style={{ marginTop: 8 }}>No time-series metrics yet for this run. Configure the JMeter Backend Listener with Run ID <span className="mono">{run.runId}</span>, or upload a JTL / HTML report in Artifacts.</div>}
        </div>
      </section>

      <div className="grid g2">
        <section className="card">
          <div className="card-head"><h3>Slowest transactions{range ? ' (range)' : ''}</h3><button className="btn btn-ghost btn-sm" onClick={() => goTab('transactions')}>All transactions →</button></div>
          {slow.length ? (
            <table className="table compact-table"><thead><tr><th>Transaction</th><th className="r">Requests</th><th className="r">P95</th><th className="r">Error %</th><th>SLA</th></tr></thead>
              <tbody>{slow.map((t) => (
                <tr key={t.name} className="clickable" onClick={() => goTab('transactions')}>
                  <td className="mono txn-name" title={t.name}>{t.name}</td><td className="r num">{fmtNum(t.samples)}</td>
                  <td className="r num">{t.percentileMethod === 'interval_weighted_approx' ? '≈ ' : ''}{fmtMs(t.p95)}</td><td className="r num">{fmtPct(t.errorPct)}</td>
                  <td>{t.slaStatus ? <StatusChip status={t.slaStatus} size="sm" /> : <span className="muted">—</span>}</td>
                </tr>))}</tbody></table>
          ) : <div className="empty small">{txns.isLoading ? 'Loading…' : 'No transactions'}</div>}
        </section>
        <section className="card">
          <div className="card-head"><h3><Lightbulb size={13} /> Key insights</h3><button className="btn btn-ghost btn-sm" onClick={() => goTab('insights')}>All insights →</button></div>
          <div className="card-body insight-mini">
            {topInsights.length ? topInsights.map((i) => (
              <button key={i.id} className="insight-row" onClick={() => goTab('insights')}>
                <SeverityIcon severity={i.severity} />
                <span><b>{i.title}</b><span className="muted small"> · {i.description}</span></span>
              </button>
            )) : <div className="empty small">{ins.isLoading ? 'Loading…' : run.analyzedAt ? 'No insights for this run.' : 'Insights are generated when the run completes.'}</div>}
          </div>
        </section>
      </div>
      {run.description && <section className="card"><div className="card-head"><h3><FileText size={13} /> Description</h3></div><div className="card-body">{run.description}</div></section>}
    </div>
  );
}
