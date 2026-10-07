import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EChartsOption } from 'echarts';
import { AlertOctagon, AlertTriangle, ArrowRight, ChevronDown, ChevronRight, GitCompare, TrendingDown, TrendingUp, Activity, Layers } from 'lucide-react';
import { api } from '@/services/api';
import { useFilters, resolveRange } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, Empty, ErrorBox, Kpi, Loading, PageHeader } from '@/components/ui';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { fmtDate, fmtNum } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { STATUS, CHROME } from '@/charts/palette';
import {
  ChangeChip, METRIC_META, Segmented, SeverityBadge, fmtUnit, groupBy, metricLabel, severityRank,
} from '@/components/analysis/shared';

interface Regression {
  id: string; runId: string; runKey: string; testName: string; baselineRunKey: string | null; scope: 'RUN' | 'TRANSACTION' | 'INFRA'; transaction: string | null;
  metric: string; previousValue: number | null; currentValue: number | null; changePct: number | null; thresholdPct: number | null;
  direction: 'REGRESSION' | 'IMPROVEMENT'; severity: 'INFO' | 'WARNING' | 'CRITICAL'; likelyImpacted: string[]; createdAt: string;
}

type Dir = 'ALL' | 'REGRESSION' | 'IMPROVEMENT';
type Sev = 'ALL' | 'CRITICAL' | 'WARNING' | 'INFO';
const SCOPE_LABEL: Record<string, string> = { RUN: 'Overall run', TRANSACTION: 'Transaction', INFRA: 'Infrastructure' };
/** Infra checks use absolute percentage-point thresholds (analytics/regression.ts). */
const PTS_METRICS = new Set(['error_pct', 'cpu_avg', 'mem_max']);

export function RegressionPage() {
  const f = useFilters();
  const theme = useUi((s) => s.theme);
  const [dir, setDir] = useState<Dir>('ALL');
  const [sev, setSev] = useState<Sev>('ALL');
  const [scope, setScope] = useState<string>('');
  const range = resolveRange(f.timeRange);

  const q = useQuery({
    queryKey: ['regressions', f.projectId, f.testId, f.environmentId, range?.from && Math.floor(range.from / 60000), range?.to && Math.floor(range.to / 60000)],
    queryFn: () => api.get<{ items: Regression[]; total: number }>('/regressions', {
      projectId: f.projectId, testId: f.testId, environmentId: f.environmentId, pageSize: 500,
      from: range ? new Date(range.from).toISOString() : undefined, to: range ? new Date(range.to).toISOString() : undefined,
    }),
    refetchInterval: f.refreshSec ? f.refreshSec * 1000 : false,
  });
  const all = q.data?.items ?? [];
  const filtered = useMemo(() => all.filter((r) => (sev === 'ALL' || r.severity === sev) && (!scope || r.scope === scope)), [all, sev, scope]);
  const regs = filtered.filter((r) => r.direction === 'REGRESSION');
  const imps = filtered.filter((r) => r.direction === 'IMPROVEMENT');
  const allRegs = all.filter((r) => r.direction === 'REGRESSION');

  const counts = {
    critical: allRegs.filter((r) => r.severity === 'CRITICAL').length,
    warning: allRegs.filter((r) => r.severity === 'WARNING').length,
    improvements: all.filter((r) => r.direction === 'IMPROVEMENT').length,
    runs: new Set(allRegs.map((r) => r.runKey)).size,
    txns: new Set(allRegs.filter((r) => r.transaction).map((r) => r.transaction)).size,
  };
  const worst = [...allRegs].filter((r) => r.changePct != null && !PTS_METRICS.has(r.metric)).sort((a, b) => b.changePct! - a.changePct!)[0];

  return (
    <div className="an-page">
      <PageHeader title="Performance Regression" subtitle="Regressions and improvements detected when each completed run is compared with its baseline (run baseline → test baseline → previous completed run of the same test and environment)."
        actions={<Link className="btn" to="/compare"><GitCompare size={14} />Compare runs</Link>} />
      <GlobalFilterBar show={['project', 'environment', 'test', 'time', 'refresh']} />

      {q.error && <ErrorBox error={q.error} />}
      <div className="kpis">
        <Kpi label="Critical regressions" value={q.isLoading ? '…' : fmtNum(counts.critical)} status={counts.critical ? 'fail' : null} sub="≥ 2× threshold" onClick={() => { setSev('CRITICAL'); setDir('REGRESSION'); }} />
        <Kpi label="Warnings" value={q.isLoading ? '…' : fmtNum(counts.warning)} status={counts.warning ? 'warn' : null} sub="above threshold" onClick={() => { setSev('WARNING'); setDir('REGRESSION'); }} />
        <Kpi label="Improvements" value={q.isLoading ? '…' : fmtNum(counts.improvements)} status={counts.improvements ? 'pass' : null} sub="beyond threshold" onClick={() => { setSev('ALL'); setDir('IMPROVEMENT'); }} />
        <Kpi label="Runs affected" value={q.isLoading ? '…' : fmtNum(counts.runs)} sub="with ≥1 regression" />
        <Kpi label="Transactions affected" value={q.isLoading ? '…' : fmtNum(counts.txns)} sub="distinct" />
        <Kpi label="Largest increase" value={worst ? `+${Math.round(worst.changePct!)}%` : '—'} sub={worst ? `${worst.transaction ?? 'Run'} ${metricLabel(worst.metric)}` : 'none'} status={worst ? (worst.severity === 'CRITICAL' ? 'fail' : 'warn') : null} />
      </div>

      <Chart title="Regressions over time" subtitle="detections per day by severity" height={210} loading={q.isLoading}
        empty={!q.isLoading && !all.length ? 'No regressions or improvements in this time range' : null}
        option={timeOption(theme, all)} table={timeTable(all)} />

      <div className="an-filters">
        <Segmented label="Direction" value={dir} onChange={setDir} options={[
          { key: 'ALL', label: 'All' }, { key: 'REGRESSION', label: <><TrendingUp size={12} /> Regressions</> }, { key: 'IMPROVEMENT', label: <><TrendingDown size={12} /> Improvements</> },
        ]} />
        <Segmented label="Severity" value={sev} onChange={setSev} options={[
          { key: 'ALL', label: 'Any severity' }, { key: 'CRITICAL', label: 'Critical' }, { key: 'WARNING', label: 'Warning' }, { key: 'INFO', label: 'Info' },
        ]} />
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
          <option value="">All scopes</option><option value="RUN">Overall run</option><option value="TRANSACTION">Transactions</option><option value="INFRA">Infrastructure</option>
        </select>
        <div className="spacer" />
        <span className="muted">{fmtNum(filtered.length)} of {fmtNum(q.data?.total ?? 0)} findings</span>
      </div>

      {q.isLoading && <Loading height={260} />}
      {!q.isLoading && dir !== 'IMPROVEMENT' && (
        <section className="stack" style={{ gap: 8 }} aria-label="Regressions">
          <div className="row"><TrendingUp size={15} style={{ color: 'var(--fail)' }} /><h2>Regressions</h2><span className="muted">{regs.length}</span></div>
          {!regs.length ? <Card><Empty icon={<Activity size={20} />}>No regressions match these filters. Regressions are detected automatically when a run completes and a baseline is available.</Empty></Card>
            : <RunGroups items={regs} />}
        </section>
      )}
      {!q.isLoading && dir !== 'REGRESSION' && (
        <section className="stack" style={{ gap: 8 }} aria-label="Improvements">
          <div className="row"><TrendingDown size={15} style={{ color: 'var(--pass)' }} /><h2>Improvements</h2><span className="muted">{imps.length}</span></div>
          {!imps.length ? <Card><Empty>No improvements beyond the configured thresholds.</Empty></Card> : <RunGroups items={imps} improvement />}
        </section>
      )}
      <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
        Thresholds are configured per organization (Administration → Settings → regression thresholds). Latency changes below the minimum absolute difference and transactions with too few samples are ignored.
        Error rate, CPU and memory are compared in percentage points. Severity is <b>Critical</b> when the change is at least twice the threshold.
      </p>
    </div>
  );
}

function RunGroups({ items, improvement }: { items: Regression[]; improvement?: boolean }) {
  const groups = groupBy(items, (r) => r.runKey);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(groups.slice(8).map(([k]) => k)));
  return (
    <div className="an-feed">
      {groups.map(([runKey, rows]) => {
        const sorted = [...rows].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
        const open = !collapsed.has(runKey);
        const crit = rows.filter((r) => r.severity === 'CRITICAL').length;
        const first = rows[0];
        return (
          <div key={runKey} className="an-rungroup">
            <div className="an-rungroup-head" role="button" tabIndex={0} aria-expanded={open}
              onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(runKey) ? n.delete(runKey) : n.add(runKey); return n; })}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Link to={`/runs/${runKey}`} className="mono" onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>{runKey}</Link>
              <span>{first.testName}</span>
              {first.baselineRunKey && <span className="muted">vs baseline <Link className="mono" to={`/runs/${first.baselineRunKey}`} onClick={(e) => e.stopPropagation()}>{first.baselineRunKey}</Link></span>}
              <div className="spacer" />
              {!improvement && crit > 0 && <span className="badge fail"><AlertOctagon size={11} />{crit} critical</span>}
              <span className="badge">{rows.length} {improvement ? 'improvement' : 'regression'}{rows.length > 1 ? 's' : ''}</span>
              <span className="muted" style={{ fontSize: 11 }}>{fmtDate(first.createdAt)}</span>
              {first.baselineRunKey && <Link className="btn btn-sm" to={`/compare?runs=${first.baselineRunKey},${runKey}`} onClick={(e) => e.stopPropagation()}><GitCompare size={12} />Compare</Link>}
            </div>
            {open && <div className="an-rungroup-body">{sorted.map((r) => <RegressionCard key={r.id} r={r} />)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function headline(r: Regression) {
  const subject = r.transaction ?? (r.scope === 'INFRA' ? 'Infrastructure' : 'Overall run');
  const m = metricLabel(r.metric);
  const up = (r.currentValue ?? 0) > (r.previousValue ?? 0);
  if (PTS_METRICS.has(r.metric) && r.previousValue != null && r.currentValue != null) {
    const d = r.currentValue - r.previousValue;
    return `${subject} ${m} ${up ? 'increased' : 'decreased'} by ${Math.abs(d).toFixed(2)} pts`;
  }
  return `${subject} ${m} ${up ? 'increased' : 'decreased'} by ${r.changePct == null ? '—' : `${Math.abs(r.changePct).toFixed(Math.abs(r.changePct) >= 10 ? 0 : 1)}%`}`;
}

function RegressionCard({ r }: { r: Regression }) {
  const unit = METRIC_META[r.metric]?.unit;
  const imp = r.direction === 'IMPROVEMENT';
  const pts = PTS_METRICS.has(r.metric) && r.previousValue != null && r.currentValue != null ? r.currentValue - r.previousValue : null;
  const Icon = imp ? TrendingDown : r.severity === 'CRITICAL' ? AlertOctagon : AlertTriangle;
  return (
    <article className={`an-card ${imp ? 'imp' : `sev-${r.severity}`}`}>
      <div className="an-card-head">
        <Icon size={16} style={{ color: imp ? 'var(--pass)' : r.severity === 'CRITICAL' ? 'var(--fail)' : 'var(--warn)', marginTop: 1, flex: 'none' }} aria-hidden />
        <div className="an-card-title">{headline(r)}</div>
        {!imp && <SeverityBadge value={r.severity} />}
        {imp && <span className="badge pass"><TrendingDown size={11} />Improvement</span>}
        <span className="pf-tag"><Layers size={10} />{SCOPE_LABEL[r.scope] ?? r.scope}</span>
      </div>
      <div className="an-card-meta">
        <span>Previous <b>{fmtUnit(r.previousValue, unit)}</b></span><span className="sep">·</span>
        <span>Current <b>{fmtUnit(r.currentValue, unit)}</b></span><span className="sep">·</span>
        <ChangeChip change={pts == null ? r.changePct : null} pts={pts} verdict={imp ? 'better' : 'worse'} showWord />
        {r.thresholdPct != null && <><span className="sep">·</span><span className="muted">threshold {PTS_METRICS.has(r.metric) ? `${r.thresholdPct} pts` : `${r.thresholdPct}%`}</span></>}
      </div>
      {!imp && r.likelyImpacted.length > 0 && (
        <div className="an-card-foot"><span>Likely impacted:</span><span className="an-impacted">{r.likelyImpacted.map((x) => <span key={x} className="pf-tag">{x}</span>)}</span></div>
      )}
      <div className="an-card-foot">
        <Link to={`/runs/${r.runKey}${r.transaction ? `/transactions?name=${encodeURIComponent(r.transaction)}` : ''}`}>Open {r.transaction ? 'transaction' : 'run'} <ArrowRight size={11} style={{ verticalAlign: -1 }} /></Link>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ chart */

function bucketDays(items: Regression[]) {
  const days = new Map<string, { CRITICAL: number; WARNING: number; IMPROVEMENT: number }>();
  for (const r of items) {
    const d = new Date(r.createdAt); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const e = days.get(k) ?? { CRITICAL: 0, WARNING: 0, IMPROVEMENT: 0 };
    if (r.direction === 'IMPROVEMENT') e.IMPROVEMENT++; else if (r.severity === 'CRITICAL') e.CRITICAL++; else e.WARNING++;
    days.set(k, e);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function timeOption(theme: 'light' | 'dark', items: Regression[]): EChartsOption {
  const d = bucketDays(items);
  const ts = (k: string) => new Date(`${k}T12:00:00`).getTime();
  return {
    legend: { show: true },
    grid: { top: 28, bottom: 4, left: 8, right: 12, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'time', minInterval: 86400e3 },
    yAxis: { type: 'value', minInterval: 1, splitNumber: 3 },
    series: [
      { type: 'bar', name: 'Critical', stack: 'r', data: d.map(([k, v]) => [ts(k), v.CRITICAL]), itemStyle: { color: STATUS.critical }, barMaxWidth: 18 },
      { type: 'bar', name: 'Warning', stack: 'r', data: d.map(([k, v]) => [ts(k), v.WARNING]), itemStyle: { color: theme === 'dark' ? '#c98500' : STATUS.warning }, barMaxWidth: 18 },
      { type: 'bar', name: 'Improvement', stack: 'i', data: d.map(([k, v]) => [ts(k), v.IMPROVEMENT]), itemStyle: { color: STATUS.good, borderColor: CHROME[theme].surface }, barMaxWidth: 18 },
    ],
  } as EChartsOption;
}
const timeTable = (items: Regression[]) => ({
  columns: ['Day', 'Critical', 'Warning', 'Improvements'],
  rows: bucketDays(items).map(([k, v]) => [k, v.CRITICAL, v.WARNING, v.IMPROVEMENT]),
});
