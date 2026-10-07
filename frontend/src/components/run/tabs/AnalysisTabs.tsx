import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Crosshair, GitCompare, Lightbulb, ListChecks, Minus, ShieldCheck, TrendingDown, TrendingUp, Wrench } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Chart } from '@/charts/Chart';
import { gaugeOption } from '@/charts/builders';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorBox, Kpi } from '@/components/ui';
import { fmtBytes, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { ApproxNote, ConfidenceMeter, EmptyState, SeverityIcon, SkeletonGrid, StatusChip } from '../common';
import { useInsights } from './OverviewTab';
import type { RunDetail } from '../types';

const enc = encodeURIComponent;

interface SlaRow { id: string; rule_name: string | null; scope: string; transaction: string | null; metric: string; direction: string; actual_value: number | null; warning_value: number | null; critical_value: number | null; unit: string | null; status: string }

const fmtUnit = (v: number | null | undefined, unit?: string | null) => {
  if (v == null) return '—';
  if (unit === 'ms') return fmtMs(v);
  if (unit === '%') return fmtPct(v, 2);
  if (unit === 'tps' || unit === '/s') return `${fmtNum(v, 2)}/s`;
  if (unit === 'B/s') return `${fmtBytes(v)}/s`;
  if (unit === 'KB/s') return `${fmtNum(v, 1)} KB/s`;
  return fmtNum(v, Math.abs(v) < 10 ? 2 : 0) + (unit ? ` ${unit}` : '');
};

export function SlaTab({ run }: { run: RunDetail }) {
  const theme = useUi((s) => s.theme);
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'sla'], queryFn: () => api.get<{ profile: { id: string; name: string } | null; results: SlaRow[]; total: number; passed: number; failed: number; warnings: number; compliancePct: number | null }>(`/runs/${enc(run.runId)}/sla`) });
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={4} height={120} />;
  const d = q.data!;
  if (!d.results.length) {
    return <EmptyState icon={<ShieldCheck size={24} />} title={d.profile ? 'SLA not evaluated yet' : 'No SLA profile attached to this test'} action={<Link className="btn btn-sm" to={`/tests/${run.testId}`}>Open test settings</Link>}>
      {d.profile ? 'SLA rules are evaluated when the run completes; use Re-analyze to evaluate again.' : 'Attach an SLA profile (e.g. P95 < 1 s, errors < 1 %, TPS ≥ target) to the test to get PASS / WARNING / FAIL per rule.'}
    </EmptyState>;
  }
  const cols: Column<SlaRow>[] = [
    { key: 'rule', header: 'Rule', value: (r) => r.rule_name ?? `${r.metric} ${r.direction === 'HIGHER' ? '≥' : '≤'}`, render: (r) => r.rule_name ?? <span>{r.metric.toUpperCase()} {r.direction === 'HIGHER' ? '≥' : '≤'} {fmtUnit(r.warning_value, r.unit)}</span> },
    { key: 'scope', header: 'Scope', render: (r) => <span className="badge">{r.scope}</span> },
    { key: 'transaction', header: 'Transaction', render: (r) => (r.transaction ? <span className="mono txn-name">{r.transaction}</span> : <span className="muted">whole run</span>) },
    { key: 'metric', header: 'Metric', render: (r) => r.metric.toUpperCase() },
    { key: 'actual_value', header: 'Actual', align: 'right', render: (r) => <b>{fmtUnit(r.actual_value, r.unit)}</b> },
    { key: 'warning_value', header: 'Warning', align: 'right', render: (r) => fmtUnit(r.warning_value, r.unit) },
    { key: 'critical_value', header: 'Critical', align: 'right', render: (r) => fmtUnit(r.critical_value, r.unit) },
    { key: 'status', header: 'Status', render: (r) => <StatusChip status={r.status} size="sm" />, value: (r) => ({ FAIL: 0, WARNING: 1, PASS: 2 } as any)[r.status] ?? 3 },
  ];
  return (
    <div className="stack">
      <div className="sla-top">
        <section className="card sla-gauge">
          <div className="card-head"><h3>SLA compliance</h3><span className="muted small">{d.profile?.name}</span></div>
          <Chart option={gaugeOption({ theme, value: d.compliancePct, unit: '%' })} height={170} table={{ columns: ['Passed', 'Total', 'Compliance %'], rows: [[d.passed, d.total, d.compliancePct == null ? null : +d.compliancePct.toFixed(1)]] }} />
          <div className="muted small center">Compliance = passed ÷ evaluated × 100 ({d.passed}/{d.total}). Warnings count as passed.</div>
        </section>
        <div className="kpis" style={{ alignContent: 'start' }}>
          <Kpi label="Rules evaluated" value={fmtNum(d.total)} />
          <Kpi label="Passed" value={fmtNum(d.passed - d.warnings)} status="pass" />
          <Kpi label="Warnings" value={fmtNum(d.warnings)} status={d.warnings ? 'warn' : null} />
          <Kpi label="Failed" value={fmtNum(d.failed)} status={d.failed ? 'fail' : 'pass'} />
          <Kpi label="No data" value={fmtNum(d.results.filter((r) => r.status === 'NO_DATA').length)} />
        </div>
      </div>
      <section className="card">
        <DataTable rows={d.results} columns={cols} rowKey={(r) => r.id} exportName={`${run.runId}-sla`} initialSort={{ key: 'status', order: 'asc' }} />
      </section>
    </div>
  );
}

interface CompareResp {
  available: boolean; reason?: string; baseline?: { id: string; runKey: string; reason: string };
  runs: { id: string; run_key: string; status: string; result: string | null; performance_score: number | null; build_number: string | null; started_at: string; percentileMethod: string | null }[];
  metrics: { key: string; label: string; unit: string; better: string; values: (number | null)[]; changes: (number | null)[]; verdicts: string[] }[];
  transactions: { name: string; samples: (number | null)[]; avg: (number | null)[]; p95: (number | null)[]; errorPct: (number | null)[]; p95Change: (number | null)[] }[];
  endpoints: { endpoint: string; samples: (number | null)[]; avg: (number | null)[]; errorPct: (number | null)[]; avgChange: (number | null)[] }[];
  sla: Record<string, number>[];
}

function Change({ v, verdict }: { v: number | null | undefined; verdict?: string }) {
  if (v == null || !Number.isFinite(v)) return <span className="muted">—</span>;
  const Icon = Math.abs(v) < 0.5 ? Minus : v > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`change ${verdict === 'better' ? 'good' : verdict === 'worse' ? 'bad' : ''}`}><Icon size={12} />{v > 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

export function ComparisonTab({ run }: { run: RunDetail }) {
  const [withRun, setWithRun] = useState<string>('');
  const runs = useQuery({ queryKey: ['runs-of-test', run.testId], queryFn: () => api.get<{ items: { runId: string; buildNumber: string | null; startedAt: string | null; result: string | null; isBaseline: boolean }[] }>('/runs', { testId: run.testId, pageSize: 50, status: 'COMPLETED' }) });
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'comparison', withRun], queryFn: () => api.get<CompareResp>(`/runs/${enc(run.runId)}/comparison`, { with: withRun || undefined }), placeholderData: (p) => p });
  const d = q.data;
  const others = (runs.data?.items ?? []).filter((r) => r.runId !== run.runId);
  const picker = (
    <select className="select" value={withRun} onChange={(e) => setWithRun(e.target.value)} aria-label="Compare with run">
      <option value="">Baseline{run.baseline ? ` (${run.baseline.runKey})` : ''}</option>
      {others.map((r) => <option key={r.runId} value={r.runId}>{r.runId}{r.buildNumber ? ` · build ${r.buildNumber}` : ''}{r.isBaseline ? ' ★' : ''}</option>)}
    </select>
  );
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={6} />;
  if (!d?.available) {
    return <EmptyState icon={<GitCompare size={24} />} title="Nothing to compare yet" action={others.length ? picker : undefined}>{d?.reason ?? 'No baseline or previous completed run of this test.'} Mark a good run as baseline, or pick any run of this test.</EmptyState>;
  }
  const [base, cur] = d.runs;
  const better = d.metrics.filter((m) => m.verdicts[1] === 'better').length;
  const worse = d.metrics.filter((m) => m.verdicts[1] === 'worse').length;
  const txCols: Column<CompareResp['transactions'][number]>[] = [
    { key: 'name', header: 'Transaction', render: (r) => <span className="mono txn-name">{r.name}</span> },
    { key: 'p95a', header: 'P95 baseline', align: 'right', value: (r) => r.p95[0], render: (r) => fmtMs(r.p95[0]) },
    { key: 'p95b', header: 'P95 this run', align: 'right', value: (r) => r.p95[1], render: (r) => fmtMs(r.p95[1]) },
    { key: 'p95c', header: 'P95 change', align: 'right', value: (r) => r.p95Change[1], render: (r) => <Change v={r.p95Change[1]} verdict={r.p95Change[1] == null || Math.abs(r.p95Change[1]) < 2 ? 'neutral' : r.p95Change[1] < 0 ? 'better' : 'worse'} /> },
    { key: 'avga', header: 'Avg base', align: 'right', value: (r) => r.avg[0], render: (r) => fmtMs(r.avg[0]) },
    { key: 'avgb', header: 'Avg this', align: 'right', value: (r) => r.avg[1], render: (r) => fmtMs(r.avg[1]) },
    { key: 'erra', header: 'Err % base', align: 'right', value: (r) => r.errorPct[0], render: (r) => fmtPct(r.errorPct[0]) },
    { key: 'errb', header: 'Err % this', align: 'right', value: (r) => r.errorPct[1], render: (r) => fmtPct(r.errorPct[1]) },
  ];
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3><GitCompare size={13} /> This run vs {withRun ? 'selected run' : 'baseline'}</h3>
          <div className="row">{picker}<Link className="btn btn-sm" to={`/compare?runs=${base.run_key},${cur.run_key}`}>Open in Compare →</Link></div>
        </div>
        <div className="card-body cmp-head">
          <div className="cmp-run"><span className="muted small">Reference ({d.baseline?.reason})</span><Link className="mono" to={`/runs/${base.run_key}`}>{base.run_key}</Link><span className="muted small">build {base.build_number ?? '—'} · score {base.performance_score ?? '—'}</span>{base.result && <StatusChip status={base.result} size="sm" />}</div>
          <div className="cmp-vs">vs</div>
          <div className="cmp-run"><span className="muted small">This run</span><span className="mono">{cur.run_key}</span><span className="muted small">build {cur.build_number ?? '—'} · score {cur.performance_score ?? '—'}</span>{cur.result && <StatusChip status={cur.result} size="sm" />}</div>
          <div className="cmp-verdict">
            <span className="change good"><TrendingUp size={14} />{better} better</span>
            <span className="change bad"><TrendingDown size={14} />{worse} worse</span>
            <span className="muted small">{d.metrics.length - better - worse} unchanged (±2%)</span>
          </div>
        </div>
        {(base.percentileMethod === 'interval_weighted_approx' || cur.percentileMethod === 'interval_weighted_approx') && <div className="card-body" style={{ paddingTop: 0 }}><ApproxNote method="interval_weighted_approx" /></div>}
        <div className="table-wrap">
          <table className="table compact-table">
            <thead><tr><th>Metric</th><th className="r">Reference</th><th className="r">This run</th><th className="r">Change</th><th>Verdict</th><th className="muted">Better when</th></tr></thead>
            <tbody>{d.metrics.map((m) => (
              <tr key={m.key}>
                <td>{m.label}</td><td className="r num">{fmtUnit(m.values[0], m.unit)}</td><td className="r num"><b>{fmtUnit(m.values[1], m.unit)}</b></td>
                <td className="r"><Change v={m.changes[1]} verdict={m.verdicts[1]} /></td>
                <td>{m.verdicts[1] === 'better' ? <StatusChip status="BETTER" size="sm" label="Better" /> : m.verdicts[1] === 'worse' ? <StatusChip status="WORSE" size="sm" label="Worse" /> : <span className="muted small">{m.better === 'neutral' ? 'informational' : 'no significant change'}</span>}</td>
                <td className="muted small">{m.better === 'neutral' ? '—' : m.better}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </section>
      {d.transactions.length > 0 && <section className="card"><div className="card-head"><h3>Transactions</h3></div><DataTable rows={d.transactions} columns={txCols} rowKey={(r) => r.name} exportName={`${run.runId}-comparison-transactions`} searchable={d.transactions.length > 8} /></section>}
      {d.endpoints.length > 0 && (
        <section className="card"><div className="card-head"><h3>API endpoints</h3></div>
          <div className="table-wrap"><table className="table compact-table"><thead><tr><th>Endpoint</th><th className="r">Avg reference</th><th className="r">Avg this run</th><th className="r">Change</th><th className="r">Err % ref</th><th className="r">Err % this</th></tr></thead>
            <tbody>{d.endpoints.map((e) => <tr key={e.endpoint}><td className="mono">{e.endpoint}</td><td className="r num">{fmtMs(e.avg[0])}</td><td className="r num">{fmtMs(e.avg[1])}</td><td className="r"><Change v={e.avgChange[1]} verdict={e.avgChange[1] == null || Math.abs(e.avgChange[1]) < 2 ? 'neutral' : e.avgChange[1] < 0 ? 'better' : 'worse'} /></td><td className="r num">{fmtPct(e.errorPct[0])}</td><td className="r num">{fmtPct(e.errorPct[1])}</td></tr>)}</tbody></table></div>
        </section>
      )}
    </div>
  );
}

export function InsightsTab({ run }: { run: RunDetail }) {
  const q = useInsights(run.runId);
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={4} height={110} />;
  const d = q.data!;
  const botts = [...(d.analysis?.bottlenecks ?? [])].sort((a, b) => b.confidence - a.confidence);
  const regs = d.regressions;
  if (!d.insights.length && !botts.length && !regs.length) {
    return <EmptyState icon={<Lightbulb size={24} />} title={run.analyzedAt ? 'No insights for this run' : 'Insights not generated yet'}>{run.analyzedAt ? 'Analysis found nothing noteworthy. Add infrastructure, JVM and DB metrics to enable bottleneck correlation.' : 'Insights, regressions and bottleneck candidates are produced when the run completes (or via Re-analyze).'}</EmptyState>;
  }
  return (
    <div className="stack">
      <div className="grid g-2-1">
        <section className="card">
          <div className="card-head"><h3><Lightbulb size={13} /> Insights</h3><span className="muted small">{d.insights.length}</span></div>
          <div className="card-body insight-list">
            {d.insights.map((i) => (
              <article key={i.id} className={`insight sev-${i.severity.toLowerCase()}`}>
                <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <SeverityIcon severity={i.severity} size={16} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 8 }}><b>{i.title}</b><span className="badge">{i.category}</span>{i.component && <span className="badge accent">{i.component}</span>}</div>
                    <div className="text-2">{i.description}</div>
                    {i.evidence?.length > 0 && <ul className="evidence">{i.evidence.map((e, k) => <li key={k}>{e}</li>)}</ul>}
                  </div>
                  {i.confidence != null && <ConfidenceMeter value={i.confidence} label={i.confidence_label} />}
                </div>
              </article>
            ))}
          </div>
        </section>
        <div className="stack">
          <section className="card">
            <div className="card-head"><h3><Crosshair size={13} /> Bottleneck candidates</h3></div>
            <div className="card-body stack">
              {botts.length ? botts.map((b, i) => (
                <div key={i} className="bott">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}><b>{b.component}</b><span className="badge">{b.category}</span></div>
                  <ConfidenceMeter value={b.confidence} label={b.label} />
                  {b.correlation != null && <div className="muted small">Correlation with response time: r = {b.correlation.toFixed(2)}</div>}
                  {b.evidence?.length > 0 && <ul className="evidence">{b.evidence.map((e, k) => <li key={k}>{e}</li>)}</ul>}
                </div>
              )) : <div className="muted">Insufficient evidence — no candidate reached the correlation threshold.</div>}
              {(d.analysis?.gaps?.length ?? 0) > 0 && (
                <div className="notice small"><b>Data gaps limiting the analysis:</b><ul className="evidence">{d.analysis!.gaps!.map((g, i) => <li key={i}>{g}</li>)}</ul></div>
              )}
              <div className="muted small">Confidence is never 100% — correlation is evidence, not proof.</div>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3><Wrench size={13} /> Recommendations</h3></div>
            <div className="card-body stack">
              {d.recommendations.length ? d.recommendations.map((r) => (
                <div key={r.id} className="rec"><div className="row" style={{ gap: 6 }}><span className={`prio prio-${r.priority.toLowerCase()}`}>{r.priority}</span><b>{r.title}</b></div><div className="text-2 small">{r.description}</div></div>
              )) : <div className="muted">No recommendations.</div>}
            </div>
          </section>
        </div>
      </div>
      <section className="card">
        <div className="card-head"><h3><ListChecks size={13} /> Regressions & improvements vs baseline</h3><span className="muted small">{regs.filter((r) => r.direction === 'REGRESSION').length} regressions · {regs.filter((r) => r.direction !== 'REGRESSION').length} improvements</span></div>
        {regs.length ? (
          <div className="table-wrap"><table className="table compact-table">
            <thead><tr><th>Direction</th><th>Scope</th><th>Transaction</th><th>Metric</th><th className="r">Baseline</th><th className="r">This run</th><th className="r">Change</th><th className="r">Threshold</th><th>Severity</th><th>Baseline run</th></tr></thead>
            <tbody>{regs.map((r) => (
              <tr key={r.id}>
                <td>{r.direction === 'REGRESSION' ? <StatusChip status="WORSE" size="sm" label="Regression" /> : <StatusChip status="BETTER" size="sm" label="Improvement" />}</td>
                <td>{r.scope}</td><td className="mono txn-name">{r.transaction ?? '—'}</td><td>{r.metric.toUpperCase()}</td>
                <td className="r num">{fmtNum(r.previous_value, 1)}</td><td className="r num">{fmtNum(r.current_value, 1)}</td>
                <td className="r"><Change v={r.change_pct} verdict={r.direction === 'REGRESSION' ? 'worse' : 'better'} /></td>
                <td className="r num muted">{r.threshold_pct != null ? `±${fmtNum(r.threshold_pct, 0)}%` : '—'}</td>
                <td><span className="row" style={{ gap: 4 }}><SeverityIcon severity={r.severity} size={12} />{r.severity}</span></td>
                <td>{r.baseline_run_key ? <Link className="mono" to={`/runs/${r.baseline_run_key}`}>{r.baseline_run_key}</Link> : '—'}</td>
              </tr>))}</tbody>
          </table></div>
        ) : <div className="empty small">{run.baseline ? 'No regressions beyond thresholds.' : 'No baseline to compare against.'}</div>}
      </section>
    </div>
  );
}
