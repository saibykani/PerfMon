import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, ArrowRight, Bell, CheckCircle2, Cpu, Gauge, Info, LayoutDashboard, Play, ServerCog, Timer, TrendingUp, XCircle,
} from 'lucide-react';
import { api } from '@/services/api';
import { useFilters, resolveRange, rangeLabel } from '@/stores/filters';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Kpi, Loading } from '@/components/ui';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { StatusBadge } from '@/components/Status';
import { DataTable } from '@/components/DataTable';
import { fmtDate, fmtMs, fmtNum, fmtPct, approx } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { barOption, donutOption, rankingOption, runTrendOption, unitFormatter } from '@/charts/builders';
import { STATUS } from '@/charts/palette';
import { InfraHealthGrid, infraStatus, type InfraItem } from '@/components/overview/InfraHealthGrid';
import type { RunRow } from '@/pages/RunsPage';
import '@/styles/overview.css';

interface TrendPoint { runId: string; runKey: string; startedAt: string; testName: string; buildNumber: string | null; tps: number | null; p95: number | null; errorPct: number | null; result: string | null; score: number | null }
interface OverviewData {
  kpis: { activeTests: number; totalRuns: number; runningRuns: number; avgTps: number | null; avgP95: number | null; avgErrorPct: number | null; slaCompliance: number | null; regressions: number; activeAlerts: number; passRate: number | null };
  trend: TrendPoint[];
  topSlowTransactions: { name: string; testName: string; runKey: string; p95: number; tps: number | null; errorPct: number | null }[];
  infraHealth: InfraItem[];
  recentRuns: (RunRow & { performanceScore?: number | null })[];
  recentAlerts: { id: string; title: string; severity: string; status: string; firedAt: string; runKey: string | null }[];
  resultDistribution: { result: string; count: number }[];
}

type Section = 'trends' | 'perf' | 'slow' | 'infra' | 'runs' | 'alerts' | 'capacity';
type View = 'PERFORMANCE_ENGINEER' | 'QA' | 'DEVELOPER' | 'SRE' | 'ARCHITECT' | 'MANAGER';

/** Section rows per stakeholder view (spec §104): same data, different emphasis. */
const LAYOUTS: Record<View, { rows: Section[][]; kpiOrder: string[]; note: string }> = {
  PERFORMANCE_ENGINEER: { rows: [['trends'], ['perf'], ['slow', 'infra'], ['runs', 'alerts']], kpiOrder: ['tps', 'p95', 'err', 'sla', 'pass', 'reg', 'alerts', 'tests', 'runs'], note: 'Load, latency and errors across runs first.' },
  QA: { rows: [['perf'], ['runs', 'alerts'], ['trends'], ['slow', 'infra']], kpiOrder: ['pass', 'sla', 'reg', 'runs', 'tests', 'err', 'p95', 'tps', 'alerts'], note: 'Results, pass rate and SLA first.' },
  MANAGER: { rows: [['perf'], ['trends'], ['runs', 'alerts'], ['slow', 'infra']], kpiOrder: ['pass', 'sla', 'reg', 'alerts', 'runs', 'tests', 'p95', 'err', 'tps'], note: 'Executive summary: pass rate, SLA, regressions.' },
  SRE: { rows: [['infra', 'alerts'], ['trends'], ['slow', 'runs'], ['perf']], kpiOrder: ['alerts', 'err', 'p95', 'tps', 'sla', 'reg', 'pass', 'runs', 'tests'], note: 'Infrastructure health and active alerts first.' },
  ARCHITECT: { rows: [['slow', 'capacity'], ['infra', 'alerts'], ['trends'], ['perf'], ['runs']], kpiOrder: ['tps', 'p95', 'err', 'reg', 'sla', 'pass', 'alerts', 'runs', 'tests'], note: 'Capacity, bottlenecks and slow paths first.' },
  DEVELOPER: { rows: [['slow', 'runs'], ['trends'], ['alerts', 'infra'], ['perf']], kpiOrder: ['p95', 'err', 'reg', 'tps', 'sla', 'pass', 'runs', 'tests', 'alerts'], note: 'Slow transactions and endpoints first.' },
};

const RESULT_COLOR: Record<string, string> = { PASS: STATUS.good, PASS_WITH_WARNINGS: STATUS.warning, FAIL: STATUS.critical, INCONCLUSIVE: '#7a8494' };
const RESULT_LABEL: Record<string, string> = { PASS: 'Pass', PASS_WITH_WARNINGS: 'Pass w/ warnings', FAIL: 'Fail', INCONCLUSIVE: 'Inconclusive' };
const shortKey = (k: string) => `#${k.split('-').pop()?.replace(/^0+/, '') ?? k}`;
const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** % change of the newer half of runs vs the older half (honest, computed from returned runs only). */
function halfDelta(trend: TrendPoint[], pick: (t: TrendPoint) => number | null) {
  if (trend.length < 4) return null;
  const mid = Math.floor(trend.length / 2);
  const a = avg(trend.slice(0, mid).map(pick));
  const b = avg(trend.slice(mid).map(pick));
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

function useOverview() {
  const f = useFilters();
  const range = resolveRange(f.timeRange);
  const key = f.timeRange.type === 'relative' ? f.timeRange.value : `${f.timeRange.from}-${f.timeRange.to}`;
  return useQuery({
    queryKey: ['overview', f.projectId, f.applicationId, f.environmentId, key],
    queryFn: () => {
      const r = resolveRange(f.timeRange) ?? range;
      return api.get<OverviewData>('/overview', { projectId: f.projectId, applicationId: f.applicationId, environmentId: f.environmentId, from: r?.from, to: r?.to });
    },
    refetchInterval: f.refreshSec ? f.refreshSec * 1000 : 60000,
  });
}

function Health({ d }: { d: OverviewData }) {
  const k = d.kpis;
  const infraBad = d.infraHealth.filter((s) => infraStatus(s) === 'CRITICAL').length;
  const level: 'pass' | 'warn' | 'fail' | 'none' = !k.totalRuns ? 'none'
    : (k.passRate != null && k.passRate < 70) || infraBad > 0 || k.activeAlerts > 3 ? 'fail'
      : (k.passRate != null && k.passRate < 95) || k.regressions > 0 || k.activeAlerts > 0 ? 'warn' : 'pass';
  const Icon = level === 'fail' ? XCircle : level === 'warn' ? AlertTriangle : level === 'pass' ? CheckCircle2 : Info;
  const label = level === 'fail' ? 'Needs attention' : level === 'warn' ? 'Watch' : level === 'pass' ? 'Healthy' : 'No runs yet';
  const facts: ReactNode[] = [];
  if (k.totalRuns) facts.push(<span key="r"><b>{fmtNum(k.totalRuns)}</b> runs{k.runningRuns ? <> · <b className="live">{k.runningRuns} running</b></> : null}</span>);
  if (k.passRate != null) facts.push(<span key="p"><b>{fmtPct(k.passRate, 0)}</b> passed</span>);
  if (k.regressions) facts.push(<span key="g"><b>{k.regressions}</b> regression{k.regressions === 1 ? '' : 's'}</span>);
  if (k.activeAlerts) facts.push(<span key="a"><b>{k.activeAlerts}</b> firing alert{k.activeAlerts === 1 ? '' : 's'}</span>);
  if (infraBad) facts.push(<span key="i"><b>{infraBad}</b> critical server{infraBad === 1 ? '' : 's'}</span>);
  return (
    <div className={`ov-health ${level}`}>
      <span className="ov-health-ico"><Icon size={18} /></span>
      <div>
        <div className="ov-health-label">{label}</div>
        <div className="ov-health-facts">{facts.length ? facts.reduce<ReactNode[]>((acc, f, i) => (i ? [...acc, <span key={`s${i}`} className="dotsep">•</span>, f] : [f]), []) : 'Start a run to see performance health here.'}</div>
      </div>
    </div>
  );
}

export function OverviewPage() {
  const nav = useNavigate();
  const f = useFilters();
  const user = useAuth((s) => s.user);
  const theme = useUi((s) => s.theme);
  const view = ((user?.preferredView as View) in LAYOUTS ? user!.preferredView : 'PERFORMANCE_ENGINEER') as View;
  const layout = LAYOUTS[view];
  const q = useOverview();
  const d = q.data;

  const trend = d?.trend ?? [];
  const labels = trend.map((t) => t.runKey);
  const openRun = (p: any) => { const t = trend[p.dataIndex]; if (t) nav(`/runs/${t.runKey}`); };
  const shortAxis = (o: any) => ({ ...o, xAxis: { ...o.xAxis, axisLabel: { ...(o.xAxis?.axisLabel ?? {}), formatter: shortKey } } });
  const tooltipRun = (unit?: string) => {
    const fmt = unitFormatter(unit);
    return {
      trigger: 'axis', formatter: (ps: any[]) => {
        const t = trend[ps[0]?.dataIndex];
        if (!t) return '';
        return `<b>${t.runKey}</b><br/><span style="opacity:.7">${t.testName}${t.buildNumber ? ` · build ${t.buildNumber}` : ''}<br/>${fmtDate(t.startedAt)}</span><br/>${ps.map((p) => `${p.marker}${p.seriesName}: <b>${fmt(p.value)}</b>`).join('<br/>')}<br/><span style="opacity:.6">Click to open run</span>`;
      },
    };
  };

  const charts = useMemo(() => {
    if (!trend.length) return null;
    const mk = (name: string, key: string, data: (number | null)[], unit: string, area = true) => ({ ...shortAxis(runTrendOption({ theme, labels, unit, series: [{ name, key, data, area }] })), tooltip: tooltipRun(unit) });
    const results = ['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'INCONCLUSIVE'];
    const other = trend.some((t) => !results.includes(t.result ?? ''));
    const perfSeries = [...results, ...(other ? ['OTHER'] : [])]
      .filter((r) => trend.some((t) => (r === 'OTHER' ? !results.includes(t.result ?? '') : t.result === r)))
      .map((r) => ({ name: RESULT_LABEL[r] ?? 'Not judged', data: trend.map((t) => ((r === 'OTHER' ? !results.includes(t.result ?? '') : t.result === r) ? t.score ?? 0 : null)) }));
    const perf: any = shortAxis(barOption({ theme, categories: labels, series: perfSeries, stacked: true, showLegend: true }));
    perf.series = perf.series.map((s: any, i: number) => {
      const key = [...results, 'OTHER'].find((r) => (RESULT_LABEL[r] ?? 'Not judged') === perfSeries[i].name)!;
      return { ...s, itemStyle: { ...s.itemStyle, color: RESULT_COLOR[key] ?? '#9aa3b0', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22 };
    });
    perf.yAxis = { ...perf.yAxis, max: 100, name: 'Score' };
    perf.tooltip = tooltipRun();
    return {
      tps: mk('TPS', 'tps', trend.map((t) => t.tps), 'tps'),
      p95: mk('P95', 'p95', trend.map((t) => t.p95), 'ms'),
      err: mk('Error %', 'errorPct', trend.map((t) => t.errorPct), '%'),
      perf,
    };
  }, [trend, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const kpiDefs: Record<string, ReactNode> = d ? {
    tests: <Kpi key="tests" label="Active tests" value={fmtNum(d.kpis.activeTests)} sub="performance tests" onClick={() => nav('/tests')} />,
    runs: <Kpi key="runs" label="Total runs" value={fmtNum(d.kpis.totalRuns)} sub={d.kpis.runningRuns ? <span className="live"><span className="dot live-dot" /> {d.kpis.runningRuns} running</span> : rangeLabel(f.timeRange)} onClick={() => nav('/runs')} />,
    tps: <Kpi key="tps" label="Average TPS" value={fmtNum(d.kpis.avgTps, 1)} unit="/s" better="higher" delta={halfDelta(trend, (t) => t.tps)} sub="vs earlier runs" />,
    p95: <Kpi key="p95" label="Average P95" value={fmtMs(d.kpis.avgP95)} better="lower" delta={halfDelta(trend, (t) => t.p95)} sub="vs earlier runs" />,
    err: <Kpi key="err" label="Average error %" value={fmtPct(d.kpis.avgErrorPct)} better="lower" delta={halfDelta(trend, (t) => t.errorPct)} sub="vs earlier runs"
      status={d.kpis.avgErrorPct == null ? null : d.kpis.avgErrorPct >= 5 ? 'fail' : d.kpis.avgErrorPct >= 1 ? 'warn' : 'pass'} />,
    sla: <Kpi key="sla" label="SLA compliance" value={fmtPct(d.kpis.slaCompliance, 1)} sub="of evaluated rules" onClick={() => nav('/sla')}
      status={d.kpis.slaCompliance == null ? null : d.kpis.slaCompliance >= 95 ? 'pass' : d.kpis.slaCompliance >= 80 ? 'warn' : 'fail'} />,
    pass: <Kpi key="pass" label="Pass rate" value={fmtPct(d.kpis.passRate, 0)} sub="of judged runs"
      status={d.kpis.passRate == null ? null : d.kpis.passRate >= 90 ? 'pass' : d.kpis.passRate >= 70 ? 'warn' : 'fail'} />,
    reg: <Kpi key="reg" label="Regressions" value={fmtNum(d.kpis.regressions)} sub={d.kpis.regressions ? 'detected vs baseline' : 'none detected'} onClick={() => nav('/regression')} status={d.kpis.regressions ? 'warn' : 'pass'} />,
    alerts: <Kpi key="alerts" label="Active alerts" value={fmtNum(d.kpis.activeAlerts)} sub={d.kpis.activeAlerts ? 'firing now' : 'all clear'} onClick={() => nav('/alerts')} status={d.kpis.activeAlerts ? 'fail' : 'pass'} />,
  } : {};

  const empty = d && !d.kpis.totalRuns;
  const sec: Record<Section, () => ReactNode> = {
    trends: () => (
      <div className="ov-trends" key="trends">
        {charts ? <>
          <Chart title="Throughput by run" subtitle="avg TPS" option={charts.tps as any} height={200} group="ov-trend" onPointClick={openRun} table={{ columns: ['Run', 'Test', 'TPS'], rows: trend.map((t) => [t.runKey, t.testName, t.tps == null ? null : +t.tps.toFixed(2)]) }} />
          <Chart title="P95 response time by run" subtitle="per run" option={charts.p95 as any} height={200} group="ov-trend" onPointClick={openRun} table={{ columns: ['Run', 'Test', 'P95 (ms)'], rows: trend.map((t) => [t.runKey, t.testName, t.p95 == null ? null : Math.round(t.p95)]) }} />
          <Chart title="Error rate by run" subtitle="%" option={charts.err as any} height={200} group="ov-trend" onPointClick={openRun} table={{ columns: ['Run', 'Test', 'Error %'], rows: trend.map((t) => [t.runKey, t.testName, t.errorPct == null ? null : +t.errorPct.toFixed(2)]) }} />
        </> : [0, 1, 2].map((i) => <Card key={i} title={['Throughput by run', 'P95 by run', 'Error rate by run'][i]}><div className="ov-empty-chart">No completed runs in this window</div></Card>)}
      </div>
    ),
    perf: () => (
      <div className="ov-row ov-row-2-1" key="perf">
        {charts ? <Chart title="Run performance" subtitle="score per run, coloured by result" option={charts.perf} height={230} onPointClick={(p) => openRun(p)}
          table={{ columns: ['Run', 'Test', 'Result', 'Score'], rows: trend.map((t) => [t.runKey, t.testName, t.result ?? '—', t.score]) }} />
          : <Card title="Run performance"><div className="ov-empty-chart">No completed runs in this window</div></Card>}
        <Chart title="Result distribution" subtitle="all runs in window" height={230}
          option={donutOption({ theme, items: (d?.resultDistribution ?? []).map((r) => ({ name: (RESULT_LABEL[r.result] ?? r.result.replace(/_/g, ' ').toLowerCase()), value: r.count, color: RESULT_COLOR[r.result] })) })}
          empty={d?.resultDistribution.length ? null : 'No runs'} table={{ columns: ['Result', 'Runs'], rows: (d?.resultDistribution ?? []).map((r) => [r.result, r.count]) }} />
      </div>
    ),
    slow: () => {
      const tx = d?.topSlowTransactions ?? [];
      return (
        <Chart key="slow" title="Top slow transactions" subtitle="P95 · latest run per test" height={Math.max(180, Math.min(10, tx.length) * 26 + 20)}
          option={rankingOption({ theme, labels: tx.map((t) => t.name), values: tx.map((t) => t.p95), unit: 'ms', slot: 1 })}
          empty={tx.length ? null : 'No transaction data in this window'}
          onPointClick={(p) => { const t = tx[p.dataIndex]; if (t) nav(`/runs/${t.runKey}/transactions?name=${encodeURIComponent(t.name)}`); }}
          table={{ columns: ['Transaction', 'Test', 'Run', 'P95 (ms)', 'TPS', 'Error %'], rows: tx.map((t) => [t.name, t.testName, t.runKey, Math.round(t.p95), t.tps == null ? null : +t.tps.toFixed(2), t.errorPct == null ? null : +t.errorPct.toFixed(2)]) }} />
      );
    },
    infra: () => (
      <Card key="infra" title={<span className="row" style={{ gap: 6 }}><ServerCog size={13} />Infrastructure health</span>} actions={<Link to="/infrastructure" className="ov-link">Open <ArrowRight size={12} /></Link>}>
        {d?.infraHealth.length ? <InfraHealthGrid items={d.infraHealth} compact={view !== 'SRE'} /> : <div className="ov-empty-chart">No monitored servers in scope. Stream server metrics with a run to see health here.</div>}
      </Card>
    ),
    runs: () => (
      <Card key="runs" noPad title={<span className="row" style={{ gap: 6 }}><Play size={13} />Recent runs</span>} actions={<Link to="/runs" className="ov-link">All runs <ArrowRight size={12} /></Link>}>
        <DataTable rows={d?.recentRuns ?? []} rowKey={(r) => r.id} onRowClick={(r) => nav(`/runs/${r.runId}`)} searchable={false} maxHeight={360} exportName="recent-runs"
          empty="No runs in this window"
          columns={[
            { key: 'runId', header: 'Run ID', render: (r) => <span className="mono link-like">{r.runId}</span> },
            { key: 'testName', header: 'Test' },
            { key: 'environmentName', header: 'Env', hidden: view === 'MANAGER' },
            { key: 'start', header: 'Started', value: (r) => r.startedAt ?? r.createdAt, render: (r) => fmtDate(r.startedAt ?? r.createdAt) },
            { key: 'tps', header: 'TPS', align: 'right', value: (r) => r.kpis?.tps ?? null, render: (r) => fmtNum(r.kpis?.tps, 1) },
            { key: 'p95', header: 'P95', align: 'right', value: (r) => r.kpis?.p95 ?? null, render: (r) => <>{approx(r.kpis?.percentileMethod)}{fmtMs(r.kpis?.p95)}</> },
            { key: 'err', header: 'Err %', align: 'right', value: (r) => r.kpis?.errorPct ?? null, render: (r) => fmtPct(r.kpis?.errorPct) },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            { key: 'result', header: 'Result', render: (r) => <StatusBadge value={r.result} /> },
          ]} />
      </Card>
    ),
    alerts: () => (
      <Card key="alerts" title={<span className="row" style={{ gap: 6 }}><Bell size={13} />Recent alerts</span>} actions={<Link to="/alerts" className="ov-link">All alerts <ArrowRight size={12} /></Link>}>
        {d?.recentAlerts.length ? (
          <ul className="ov-alerts">
            {d.recentAlerts.map((a) => {
              const cls = a.status === 'RESOLVED' ? 'pass' : a.severity === 'CRITICAL' ? 'fail' : a.severity === 'WARNING' ? 'warn' : 'info';
              const Icon = cls === 'pass' ? CheckCircle2 : cls === 'fail' ? XCircle : cls === 'warn' ? AlertTriangle : Info;
              return (
                <li key={a.id} onClick={() => nav(a.runKey ? `/runs/${a.runKey}` : `/alerts?id=${a.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(a.runKey ? `/runs/${a.runKey}` : '/alerts')}>
                  <span className={`ov-alert-ico ${cls}`}><Icon size={13} /></span>
                  <div className="ov-alert-body">
                    <div className="ov-alert-title">{a.title}</div>
                    <div className="ov-alert-sub">{fmtDate(a.firedAt)}{a.runKey && <> · <span className="mono">{a.runKey}</span></>}</div>
                  </div>
                  <StatusBadge value={a.status} />
                </li>
              );
            })}
          </ul>
        ) : <div className="ov-allclear"><CheckCircle2 size={20} /><b>All clear</b><span className="muted">No alerts fired in this scope.</span></div>}
      </Card>
    ),
    capacity: () => (
      <Card key="capacity" title={<span className="row" style={{ gap: 6 }}><Gauge size={13} />Capacity & bottlenecks</span>}>
        <div className="ov-cap">
          <p className="muted" style={{ margin: 0 }}>Fit latency-vs-load from completed runs to estimate saturation and headroom at a target load. Projections are labelled estimates.</p>
          <div className="ov-cap-facts">
            <div><Activity size={14} /><span>Peak avg TPS in window</span><b className="num">{fmtNum(Math.max(0, ...trend.map((t) => t.tps ?? 0)), 1)}</b></div>
            <div><Timer size={14} /><span>Worst P95 in window</span><b className="num">{fmtMs(trend.length ? Math.max(...trend.map((t) => t.p95 ?? 0)) : null)}</b></div>
            <div><Cpu size={14} /><span>Hottest server CPU</span><b className="num">{fmtPct(d?.infraHealth.length ? Math.max(...d.infraHealth.map((s) => s.cpuPct ?? 0)) : null, 0)}</b></div>
          </div>
          <div className="row"><Link className="btn btn-primary btn-sm" to="/capacity"><TrendingUp size={13} />Open capacity planner</Link><Link className="btn btn-sm" to="/insights">Bottleneck insights</Link></div>
        </div>
      </Card>
    ),
  };

  return (
    <div className="ov">
      <div className="ov-head">
        <div>
          <h1>Performance Overview</h1>
          <div className="sub muted">{rangeLabel(f.timeRange)} · tailored for <b>{view.replace(/_/g, ' ').toLowerCase()}</b> — {layout.note}</div>
        </div>
        <div className="row">
          <Link className="btn" to="/dashboards"><LayoutDashboard size={14} />Dashboards</Link>
          <Link className="btn btn-primary" to="/runs"><Play size={14} />Runs</Link>
        </div>
      </div>
      <GlobalFilterBar show={['project', 'application', 'environment', 'run', 'time', 'refresh']} />
      {f.runId && (
        <div className="ov-focus">
          <Info size={14} />Run <span className="mono">{f.runId}</span> selected — the overview always spans the time window.
          <Link to={`/runs/${f.runId}`} className="ov-link">Open run analysis <ArrowRight size={12} /></Link>
        </div>
      )}
      <ErrorBox error={q.error} />

      {q.isLoading ? (
        <div className="stack">
          <Loading height={64} />
          <div className="kpis ov-kpis">{Array.from({ length: 9 }).map((_, i) => <Loading key={i} height={70} />)}</div>
          <div className="ov-trends">{[0, 1, 2].map((i) => <Loading key={i} height={236} />)}</div>
          <div className="ov-row ov-row-2-1"><Loading height={260} /><Loading height={260} /></div>
        </div>
      ) : d && (
        <div className="stack ov-stack">
          <Health d={d} />
          <div className="kpis ov-kpis">{layout.kpiOrder.map((k) => kpiDefs[k])}</div>
          {empty ? (
            <div className="card ov-empty">
              <div className="ov-empty-art"><Activity size={28} /></div>
              <h2>No runs in this window</h2>
              <p className="muted">Widen the time range or clear filters — or start a JMeter run with the Perfmon backend listener and results will stream in live.</p>
              <div className="row"><button className="btn" onClick={() => f.set({ timeRange: { type: 'relative', value: '90d' } })}>Show last 90 days</button><Link className="btn btn-primary" to="/tests">Go to tests</Link></div>
            </div>
          ) : layout.rows.map((row, i) => (
            row.length === 1 ? <div key={i}>{sec[row[0]]()}</div> : <div key={i} className="ov-row">{row.map((s) => sec[s]())}</div>
          ))}
        </div>
      )}
    </div>
  );
}
