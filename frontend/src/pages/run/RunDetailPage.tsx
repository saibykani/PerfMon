import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, SearchX, XCircle } from 'lucide-react';
import { api, ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { ErrorBox, Tabs } from '@/components/ui';
import { EmptyState } from '@/components/run/common';
import { RunHeader } from '@/components/run/RunHeader';
import { LiveWall } from '@/components/run/LiveWall';
import { SyncedCharts } from '@/components/run/SyncedCharts';
import { TransactionsView, EndpointsView } from '@/components/run/TxnViews';
import { OverviewTab, useTimeline } from '@/components/run/tabs/OverviewTab';
import { ResponseTimeTab, ThroughputTab, ErrorsTab } from '@/components/run/tabs/PerfTabs';
import { InfrastructureTab, JvmTab, DatabaseTab } from '@/components/run/tabs/InfraTabs';
import { LogsTab, EventsTab } from '@/components/run/tabs/LogsEventsTabs';
import { SlaTab, ComparisonTab, InsightsTab } from '@/components/run/tabs/AnalysisTabs';
import { ArtifactsTab, HtmlReportTab } from '@/components/run/tabs/ArtifactTabs';
import { RawTab, AuditTab } from '@/components/run/tabs/DataTabs';
import type { Deltas } from '@/components/run/RunKpis';
import type { RunDetail, TimeWindow } from '@/components/run/types';
import '@/styles/run.css';

const TAB_KEYS = ['overview', 'live', 'transactions', 'apis', 'response-time', 'throughput', 'errors', 'infrastructure', 'jvm', 'database', 'logs', 'events', 'sla', 'comparison', 'insights', 'artifacts', 'html-report', 'raw', 'audit'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** Default tab per stakeholder view (spec: role-adapted emphasis). */
const VIEW_DEFAULT: Record<string, TabKey> = {
  MANAGER: 'overview', PERFORMANCE_ENGINEER: 'overview', QA: 'sla', DEVELOPER: 'apis', SRE: 'infrastructure', ARCHITECT: 'insights',
};
const VIEW_LABEL: Record<string, string> = { MANAGER: 'Manager', PERFORMANCE_ENGINEER: 'Performance engineer', QA: 'QA', DEVELOPER: 'Developer', SRE: 'SRE', ARCHITECT: 'Architect' };

export function RunDetailPage() {
  const { runId = '', tab } = useParams();
  const nav = useNavigate();
  const view = useAuth((s) => s.user?.preferredView) ?? 'PERFORMANCE_ENGINEER';
  const [range, setRange] = useState<TimeWindow>(null);
  const [notice, setNotice] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  useEffect(() => { setRange(null); }, [runId]);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(id); }, [notice]);

  const q = useQuery({
    queryKey: ['run', runId], queryFn: () => api.get<RunDetail>(`/runs/${encodeURIComponent(runId)}`),
    refetchInterval: (query) => { const st = (query.state.data as RunDetail | undefined)?.status; return st === 'RUNNING' || st === 'ANALYZING' || (query.state.data as RunDetail | undefined)?.counts?.pending_jobs ? 5000 : false; },
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 403)) && n < 2,
  });
  const run = q.data;
  const deltas = useQuery({ queryKey: ['run-sub', runId, 'kpi-deltas'], queryFn: () => api.get<{ baseline: any; deltas: Deltas }>(`/runs/${encodeURIComponent(runId)}/kpi-deltas`), enabled: !!run && run.status !== 'RUNNING' });
  const live = run?.status === 'RUNNING';

  const active: TabKey = (TAB_KEYS as readonly string[]).includes(tab ?? '') ? (tab as TabKey) : live ? 'live' : VIEW_DEFAULT[view] ?? 'overview';
  const goTab = useCallback((t: string, search = '') => nav(`/runs/${encodeURIComponent(runId)}${t === 'overview' ? '/overview' : `/${t}`}${search}`), [nav, runId]);
  const onNotice = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => setNotice({ msg, kind }), []);

  const tabs = useMemo(() => {
    const c = run?.counts;
    const t: { key: TabKey; label: string; badge?: React.ReactNode }[] = [
      { key: 'overview', label: 'Overview' },
      { key: 'live', label: 'Live Metrics', badge: live ? <span className="dot live-dot live-ink" /> : undefined },
      { key: 'transactions', label: 'Transactions' }, { key: 'apis', label: 'APIs' }, { key: 'response-time', label: 'Response Time' }, { key: 'throughput', label: 'Throughput' },
      { key: 'errors', label: 'Errors', badge: run?.summary?.failedRequests ? run.summary.failedRequests.toLocaleString() : undefined },
      { key: 'infrastructure', label: 'Infrastructure' }, { key: 'jvm', label: 'JVM' }, { key: 'database', label: 'Database' },
      { key: 'logs', label: 'Logs' }, { key: 'events', label: 'Events', badge: c?.alerts || undefined },
      { key: 'sla', label: 'SLA', badge: c?.sla_failures ? <span className="ink-fail">{c.sla_failures} fail</span> : undefined },
      { key: 'comparison', label: 'Comparison' },
      { key: 'insights', label: 'Insights', badge: c?.insights || undefined },
      { key: 'artifacts', label: 'Artifacts', badge: c?.artifacts || undefined },
      { key: 'html-report', label: 'HTML Report', badge: c?.html_reports ? '✓' : undefined },
      { key: 'raw', label: 'Raw Metrics' }, { key: 'audit', label: 'Audit' },
    ];
    // move the stakeholder's default tab right after Overview so it is one click away
    const pref = VIEW_DEFAULT[view];
    if (pref && pref !== 'overview') { const i = t.findIndex((x) => x.key === pref); const [p] = t.splice(i, 1); t.splice(1, 0, p); }
    return t;
  }, [run, live, view]);

  if (q.error) {
    const nf = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return nf
      ? <EmptyState icon={<SearchX size={28} />} title={`Run ${runId} not found`} action={<Link className="btn btn-primary" to="/runs">Browse test runs</Link>}>It may have been deleted, or you do not have access to its project.</EmptyState>
      : <ErrorBox error={q.error} />;
  }
  if (!run) return <div className="stack"><div className="skeleton" style={{ height: 150 }} /><div className="skeleton" style={{ height: 36 }} /><div className="kpis">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 66 }} />)}</div><div className="skeleton" style={{ height: 420 }} /></div>;

  return (
    <div className="run-page">
      <RunHeader run={run} live={live} onNotice={onNotice} />
      {run.status === 'ANALYZING' && <div className="notice analyzing"><Loader2 size={14} className="spin" /> Analysis in progress — summary, SLA, regression, bottleneck and insight results appear automatically.</div>}
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.kind === 'ok' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{notice.msg}</div>}
      <div className="run-tabs">
        <Tabs tabs={tabs} value={active} onChange={(k) => goTab(k)} />
        {VIEW_DEFAULT[view] && <span className="view-hint muted small" title="Default tab and KPI emphasis follow your stakeholder view (profile menu).">View: {VIEW_LABEL[view] ?? view}</span>}
      </div>
      <div className="tab-panel" key={active}>
        {active === 'overview' && <OverviewTab run={run} live={live} range={range} setRange={setRange} deltas={deltas.data?.deltas} compact={view === 'MANAGER'} goTab={goTab} />}
        {active === 'live' && <LiveTab run={run} onFinished={() => { onNotice('The run finished — showing the final result.'); q.refetch(); goTab('overview'); }} />}
        {active === 'transactions' && <><RangeHint range={range} clear={() => setRange(null)} /><TransactionsView runId={run.runId} range={range} layout="side" /></>}
        {active === 'apis' && <EndpointsView runId={run.runId} range={range} layout="side" />}
        {active === 'response-time' && <ResponseTimeTab run={run} live={live} />}
        {active === 'throughput' && <ThroughputTab run={run} live={live} />}
        {active === 'errors' && <ErrorsTab run={run} />}
        {active === 'infrastructure' && <InfrastructureTab run={run} />}
        {active === 'jvm' && <JvmTab run={run} />}
        {active === 'database' && <DatabaseTab run={run} />}
        {active === 'logs' && <LogsTab run={run} />}
        {active === 'events' && <EventsTab run={run} />}
        {active === 'sla' && <SlaTab run={run} />}
        {active === 'comparison' && <ComparisonTab run={run} />}
        {active === 'insights' && <InsightsTab run={run} />}
        {active === 'artifacts' && <ArtifactsTab run={run} goTab={goTab} />}
        {active === 'html-report' && <HtmlReportTab run={run} />}
        {active === 'raw' && <RawTab run={run} />}
        {active === 'audit' && <AuditTab run={run} />}
      </div>
    </div>
  );
}

function RangeHint({ range, clear }: { range: TimeWindow; clear: () => void }) {
  if (!range) return null;
  return <div className="range-bar" style={{ marginBottom: 12 }}><span>Showing statistics for the selected range <b className="num">{new Date(range.from).toLocaleTimeString()}</b> → <b className="num">{new Date(range.to).toLocaleTimeString()}</b></span><div className="spacer" /><button className="btn btn-sm" onClick={clear}>Whole run</button></div>;
}

function LiveTab({ run, onFinished }: { run: RunDetail; onFinished: () => void }) {
  const tl = useTimeline(run.runId, false);
  if (run.status === 'RUNNING') return <LiveWall runId={run.runId} onFinished={onFinished} />;
  return (
    <div className="stack">
      <div className="notice">This run is <b>{run.status.toLowerCase()}</b> — live streaming is only active while a test is RUNNING. Below is the recorded timeline.</div>
      <SyncedCharts points={tl.data?.points ?? []} infra={tl.data?.infra} panels={['users', 'tps', 'rt', 'errors']} percentileMethod={tl.data?.percentileMethod} group={`replay-${run.runId}`} columns={2} height={180} loading={tl.isLoading} />
    </div>
  );
}
