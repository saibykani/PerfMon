import { one, query, tsPool } from '../db/pool.js';
import { round } from '../lib/stats.js';
import { primarySummary, primaryTransactions, infraAggregates } from '../analytics/summary.js';
import { compareRuns, resolveBaseline } from '../analytics/compare.js';
import { loadTrend } from '../analytics/trends.js';
import { runSeries } from '../metrics/series.js';
import { reconcile } from './reconcile.js';

/**
 * Report model (docs/architecture/api-contracts.md §8). Built only from stored analysis data
 * (run_summary, transactions, sla_results, regressions, insights, recommendations, metrics) —
 * every export format renders from this object, so a report is reproducible from its params.
 */
export type SectionKind = 'kv' | 'kpis' | 'table' | 'text' | 'list' | 'findings' | 'chart';
export interface Column { key: string; header: string; unit?: string }
export interface Kpi { label: string; value: number | string | null; unit?: string; status?: string | null; baseline?: number | null; deltaPct?: number | null; better?: 'lower' | 'higher' | 'neutral' }
export interface Finding { severity: string; title: string; description: string }
export interface ChartData { type: 'line' | 'bar'; unit?: string; xType?: 'time' | 'category'; series: { name: string; data: [number | string, number | null][] }[] }
export interface Section { id: string; title: string; kind: SectionKind; data: any; note?: string }
export interface ReportContent {
  title: string; type: string; generatedAt: string; version: number; audience: 'EXECUTIVE' | 'ENGINEERING';
  subject: { runKey?: string; runKeys?: string[]; testName?: string; projectName?: string; environment?: string; build?: string; from?: string; to?: string };
  result?: { status: string; score: number | null; breakdown: Record<string, string>; reasons?: string[] };
  sections: Section[];
}

const n = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v: unknown, d = 2) => round(n(v), d);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const sevRank = (s: string) => (s === 'CRITICAL' || s === 'HIGH' ? 0 : s === 'WARNING' || s === 'MEDIUM' ? 1 : 2);

const RUN_SELECT = `
  SELECT r.*, t.name AS test_name, t.test_type, p.name AS project_name, a.name AS application_name, e.name AS environment_name,
         rel.version AS release_version, b.run_key AS baseline_key
  FROM test_runs r
  JOIN performance_tests t ON t.id = r.test_id
  JOIN projects p ON p.id = r.project_id
  JOIN applications a ON a.id = r.application_id
  JOIN environments e ON e.id = r.environment_id
  LEFT JOIN releases rel ON rel.id = r.release_id
  LEFT JOIN test_runs b ON b.id = r.baseline_run_id`;

/* ------------------------------------------------------------------ Test execution */

export async function buildTestExecutionContent(runId: string, version: number, title: string): Promise<ReportContent> {
  const run = await one(`${RUN_SELECT} WHERE r.id = $1`, [runId]);
  if (!run) throw new Error(`run ${runId} not found`);
  const s = await primarySummary(runId);
  const baseline = await resolveBaseline(runId);
  const baseSummary = baseline ? await primarySummary(baseline.id) : null;
  const [txns, sla, regs, insights, recs, errors, servers] = await Promise.all([
    primaryTransactions(runId),
    query(`SELECT s.*, r.name AS rule_name FROM sla_results s LEFT JOIN sla_rules r ON r.id = s.rule_id WHERE s.run_id = $1
           ORDER BY CASE s.status WHEN 'FAIL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'PASS' THEN 2 ELSE 3 END, s.scope, s.metric`, [runId]),
    query(`SELECT g.*, b.run_key AS baseline_run_key FROM regressions g LEFT JOIN test_runs b ON b.id = g.baseline_run_id WHERE g.run_id = $1
           ORDER BY g.direction, CASE g.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, abs(g.change_pct) DESC NULLS LAST`, [runId]),
    query(`SELECT * FROM insights WHERE run_id = $1 ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at`, [runId]),
    query(`SELECT * FROM recommendations WHERE run_id = $1 ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at`, [runId]),
    query(`SELECT error_type, COALESCE(response_code, '') AS response_code, transaction, (array_agg(message ORDER BY count DESC))[1] AS message, sum(count)::int AS n
           FROM error_metrics WHERE run_id = $1 GROUP BY 1, 2, 3 ORDER BY 5 DESC LIMIT 20`, [runId]),
    query(`SELECT s.name, s.role, avg(m.cpu_pct) cpu_avg, max(m.cpu_pct) cpu_max, avg(m.memory_pct) mem_avg, max(m.memory_pct) mem_max, max(m.disk_pct) disk_max, max(m.load_avg_1m) load_max
           FROM server_metrics m JOIN servers s ON s.id = m.server_id WHERE m.run_id = $1 GROUP BY s.id ORDER BY s.role, s.name`, [runId], tsPool),
  ]);
  const infra = await infraAggregates(runId);
  const slaEval = sla.filter((x) => x.status !== 'NO_DATA');
  const slaPassed = slaEval.filter((x) => x.status !== 'FAIL').length;
  const slaPct = slaEval.length ? (slaPassed / slaEval.length) * 100 : n(s?.sla_pass_pct);
  const totalErrors = errors.reduce((a, x) => a + x.n, 0);
  const regressionsOnly = regs.filter((g) => g.direction === 'REGRESSION');
  const sections: Section[] = [];

  // Identity
  sections.push({
    id: 'identity', title: 'Run identity', kind: 'kv', data: [
      ['Run ID', run.run_key], ['Test', run.test_name], ['Test type', run.test_type], ['Project', run.project_name], ['Application', run.application_name],
      ['Environment', run.environment_name], ['Build', run.build_number ?? '—'], ['Version / release', run.release_version ?? run.version ?? '—'],
      ['Branch', run.branch ?? '—'], ['Commit', run.commit_sha ? String(run.commit_sha).slice(0, 12) : '—'], ['Status', run.status],
      ['Started', iso(run.started_at) ?? '—'], ['Ended', iso(run.ended_at) ?? '—'], ['Duration', s?.duration_sec != null ? fmtDur(n(s.duration_sec)) : '—'],
      ['Virtual users (peak)', s?.users_peak ?? run.virtual_users ?? '—'], ['Target TPS', run.target_tps ?? '—'], ['Load engine', run.load_engine],
      ['Triggered by', `${run.triggered_by}${run.ci_system ? ` (${run.ci_system})` : ''}`], ['Tester', run.tester ?? '—'],
      ['Baseline', baseline ? `${baseline.runKey} (${baseline.reason})` : 'None'], ['Metric source', s ? `${s.source}${s.percentile_method ? ` · ${String(s.percentile_method).replace(/_/g, ' ')}` : ''}` : '—'],
    ],
  });

  // Narrative summary built from stored figures only
  const lines: string[] = [];
  if (!s) lines.push('No summary metrics are stored for this run yet; the run may still be analyzing or have no samples.');
  else {
    lines.push(`${run.test_name} on ${run.environment_name} finished with result ${(run.result ?? 'PENDING').replace(/_/g, ' ')}${run.performance_score != null ? ` and a performance score of ${Math.round(run.performance_score)}/100` : ''}.`);
    lines.push(`It processed ${fmtInt(n(s.total_samples))} requests at ${fmtNum(n(s.tps_avg), 1)} TPS on average (peak ${fmtNum(n(s.tps_peak), 1)}), with P95 ${fmtMs(n(s.p95))}, P99 ${fmtMs(n(s.p99))} and an error rate of ${fmtNum(n(s.error_pct), 2)}%.`);
    if (slaEval.length) lines.push(`SLA: ${slaPassed} of ${slaEval.length} rules passed (${fmtNum(slaPct, 1)}%).`);
    else lines.push('No SLA profile was evaluated for this run.');
    if (baseline) lines.push(regressionsOnly.length ? `${regressionsOnly.length} regression(s) detected against baseline ${baseline.runKey}.` : `No regressions against baseline ${baseline.runKey}.`);
    const bott = (run.analysis?.bottlenecks ?? []).find((b: any) => b.confidence >= 0.45);
    if (bott) lines.push(`${bott.label}: ${bott.component}.`);
  }
  sections.push({ id: 'summary', title: 'Summary', kind: 'text', data: lines.join(' ') });

  // KPIs vs baseline
  const kpi = (label: string, key: string, unit: string, better: Kpi['better'], status?: string | null): Kpi => {
    const cur = n(s?.[key]);
    const base = n(baseSummary?.[key]);
    return { label, value: cur, unit, better, status: status ?? null, baseline: r2(base), deltaPct: cur != null && base != null && base !== 0 ? r2(((cur - base) / Math.abs(base)) * 100, 1) : null };
  };
  const bd = run.result_breakdown?.breakdown ?? {};
  const st = (k: string) => (bd[k] && bd[k] !== 'N/A' ? bd[k] : null);
  sections.push({
    id: 'kpis', title: baseline ? `Key metrics vs baseline ${baseline.runKey}` : 'Key metrics', kind: 'kpis', data: [
      kpi('Requests', 'total_samples', '', 'neutral'), kpi('Avg TPS', 'tps_avg', '/s', 'higher', st('TPS')), kpi('Peak TPS', 'tps_peak', '/s', 'higher'),
      kpi('Avg RT', 'avg_rt', 'ms', 'lower'), kpi('P90', 'p90', 'ms', 'lower'), kpi('P95', 'p95', 'ms', 'lower', st('P95')), kpi('P99', 'p99', 'ms', 'lower'),
      kpi('Error rate', 'error_pct', '%', 'lower', st('Error Rate')), kpi('Peak users', 'users_peak', '', 'neutral'),
      { label: 'SLA compliance', value: slaPct != null ? r2(slaPct, 1) : null, unit: '%', status: st('SLA'), better: 'higher' },
    ],
  });

  if (baseline) {
    const cmp = await compareRuns([baseline.id, runId]);
    sections.push({
      id: 'baseline', title: `Comparison with baseline ${baseline.runKey}`, kind: 'table', data: {
        columns: [{ key: 'metric', header: 'Metric' }, { key: 'baseline', header: baseline.runKey }, { key: 'current', header: run.run_key }, { key: 'change', header: 'Change', unit: '%' }, { key: 'verdict', header: 'Verdict' }],
        rows: cmp.metrics.map((m) => ({ metric: m.unit ? `${m.label} (${m.unit})` : m.label, baseline: r2(m.values[0]), current: r2(m.values[1]), change: r2(m.changes[1], 1), verdict: m.verdicts[1] })),
      },
    });
  }

  // Result breakdown + score factors
  if (run.result_breakdown || run.score_breakdown) {
    const rows: Record<string, unknown>[] = Object.entries(bd).map(([dim, v]) => ({ dimension: dim, status: v, detail: '' }));
    for (const f of run.score_breakdown?.factors ?? []) rows.push({ dimension: `Score: ${f.label}`, status: f.score != null ? `${Math.round(f.score)}/100` : 'n/a', detail: `${f.detail ?? ''}${f.weight != null ? ` (weight ${f.weight})` : ''}` });
    sections.push({ id: 'result', title: 'Result & score breakdown', kind: 'table', data: { columns: [{ key: 'dimension', header: 'Dimension' }, { key: 'status', header: 'Status' }, { key: 'detail', header: 'Detail' }], rows }, note: (run.result_breakdown?.reasons ?? []).length ? `Reasons: ${run.result_breakdown.reasons.join('; ')}` : undefined });
  }

  // Timeline chart
  try {
    const series = await runSeries(runId, { maxPoints: 120 });
    if (series.points.length > 1) {
      sections.push({ id: 'chart-throughput', title: 'Throughput over time', kind: 'chart', data: { type: 'line', unit: 'TPS', xType: 'time', series: [{ name: 'TPS', data: series.points.map((p) => [p.t, r2(p.tps)]) }] } satisfies ChartData });
      sections.push({ id: 'chart-latency', title: 'Response time over time', kind: 'chart', data: { type: 'line', unit: 'ms', xType: 'time', series: [
        { name: 'Avg', data: series.points.map((p) => [p.t, r2(p.avg, 0)]) }, { name: 'P95', data: series.points.map((p) => [p.t, r2(p.p95, 0)]) },
      ] } satisfies ChartData });
    }
  } catch { /* no time series stored: tables still render */ }

  // SLA
  sections.push({
    id: 'sla', title: 'SLA results', kind: 'table', data: {
      columns: [{ key: 'rule', header: 'Rule' }, { key: 'scope', header: 'Scope' }, { key: 'metric', header: 'Metric' }, { key: 'actual', header: 'Actual' }, { key: 'warning', header: 'Warning' }, { key: 'critical', header: 'Critical' }, { key: 'unit', header: 'Unit' }, { key: 'status', header: 'Status' }],
      rows: sla.map((x) => ({ rule: x.rule_name ?? x.metric, scope: x.transaction ? `${x.scope}: ${x.transaction}` : x.scope, metric: x.metric, actual: r2(x.actual_value), warning: r2(x.warning_value), critical: r2(x.critical_value), unit: x.unit ?? '', status: x.status })),
    },
    note: sla.length ? undefined : 'No SLA profile is attached to this test.',
  });

  // Top transactions
  const tcols: Column[] = [{ key: 'name', header: 'Transaction' }, { key: 'samples', header: 'Samples' }, { key: 'tps', header: 'TPS', unit: '/s' }, { key: 'avg', header: 'Avg', unit: 'ms' },
    { key: 'p90', header: 'P90', unit: 'ms' }, { key: 'p95', header: 'P95', unit: 'ms' }, { key: 'p99', header: 'P99', unit: 'ms' }, { key: 'errorPct', header: 'Errors', unit: '%' }, { key: 'sla', header: 'SLA' }];
  const trow = (t: any) => ({ name: t.name, samples: n(t.samples), tps: r2(t.tps), avg: r2(t.avg_rt, 0), p90: r2(t.p90, 0), p95: r2(t.p95, 0), p99: r2(t.p99, 0), errorPct: r2(t.error_pct), sla: t.sla_status ?? '' });
  sections.push({ id: 'transactions', title: 'Top transactions by volume', kind: 'table', data: { columns: tcols, rows: txns.slice(0, 25).map(trow) }, note: txns.length > 25 ? `Showing 25 of ${txns.length} transactions.` : txns.length ? undefined : 'No transaction statistics stored.' });
  const slow = [...txns].filter((t) => t.p95 != null).sort((a, b) => b.p95 - a.p95).slice(0, 10);
  if (slow.length) sections.push({ id: 'chart-slowest', title: 'Slowest transactions (P95)', kind: 'chart', data: { type: 'bar', unit: 'ms', xType: 'category', series: [{ name: 'P95', data: slow.map((t) => [t.name, r2(t.p95, 0)]) }] } satisfies ChartData });

  // Errors
  sections.push({
    id: 'errors', title: 'Errors', kind: 'table', data: {
      columns: [{ key: 'type', header: 'Type' }, { key: 'code', header: 'Code' }, { key: 'transaction', header: 'Transaction' }, { key: 'message', header: 'Message' }, { key: 'count', header: 'Count' }, { key: 'share', header: 'Share', unit: '%' }],
      rows: errors.map((e) => ({ type: e.error_type, code: e.response_code, transaction: e.transaction, message: String(e.message ?? '').slice(0, 160), count: e.n, share: totalErrors ? r2((e.n / totalErrors) * 100, 1) : null })),
    },
    note: errors.length ? `${fmtInt(n(s?.failure_count) ?? totalErrors)} failed requests in total; top ${errors.length} groups shown.` : 'No errors were recorded.',
  });

  // Regressions
  sections.push({
    id: 'regressions', title: 'Regressions & improvements', kind: 'table', data: {
      columns: [{ key: 'direction', header: 'Direction' }, { key: 'severity', header: 'Severity' }, { key: 'scope', header: 'Scope' }, { key: 'metric', header: 'Metric' }, { key: 'previous', header: 'Baseline' }, { key: 'current', header: 'Current' }, { key: 'change', header: 'Change', unit: '%' }],
      rows: regs.slice(0, 40).map((g) => ({ direction: g.direction, severity: g.severity, scope: g.transaction ?? g.scope, metric: g.metric, previous: r2(g.previous_value), current: r2(g.current_value), change: r2(g.change_pct, 1) })),
    },
    note: !baseline ? 'No baseline available — regression detection needs a baseline or a previous completed run.' : regs.length ? undefined : 'No significant changes versus the baseline.',
  });

  // Bottlenecks + insights
  const bottlenecks = (run.analysis?.bottlenecks ?? []) as any[];
  if (bottlenecks.length) {
    sections.push({
      id: 'bottlenecks', title: 'Bottleneck analysis', kind: 'table', data: {
        columns: [{ key: 'component', header: 'Component' }, { key: 'label', header: 'Assessment' }, { key: 'confidence', header: 'Confidence', unit: '%' }, { key: 'evidence', header: 'Evidence' }],
        rows: bottlenecks.slice(0, 10).map((b) => ({ component: b.component, label: b.label, confidence: r2((b.confidence ?? 0) * 100, 0), evidence: (b.evidence ?? []).map((e: any) => (typeof e === 'string' ? e : e.text ?? e.description ?? JSON.stringify(e))).slice(0, 3).join('; ') })),
      },
    });
  }
  sections.push({
    id: 'insights', title: 'Insights', kind: 'findings',
    data: insights.map((i) => ({ severity: i.severity, title: i.title, description: `${i.description}${i.confidence_label ? ` (${i.confidence_label})` : ''}` })) satisfies Finding[],
    note: insights.length ? undefined : 'No insights were generated for this run.',
  });
  const recLines = [...new Set(recs.map((x) => `[${x.priority}] ${x.title}: ${x.description}`))];
  if (recLines.length) sections.push({ id: 'recommendations', title: 'Recommendations', kind: 'list', data: recLines });

  // Infrastructure
  const infraKv: [string, string][] = [];
  if (infra.hasServer) infraKv.push(['CPU avg / max', `${fmtNum(infra.cpuAvg, 1)}% / ${fmtNum(infra.cpuMax, 1)}%`], ['Memory avg / max', `${fmtNum(infra.memAvg, 1)}% / ${fmtNum(infra.memMax, 1)}%`], ['Disk max', `${fmtNum(infra.diskMax, 1)}%`]);
  if (infra.hasLoadgen) infraKv.push(['Load generator CPU max', `${fmtNum(infra.loadgenCpuMax, 1)}%`]);
  if (infra.hasJvm) infraKv.push(['Heap max', `${fmtNum(infra.heapPctMax, 1)}%`], ['GC pause max', fmtMs(infra.gcPauseMax)], ['Threads max', fmtInt(infra.threadsMax)]);
  if (infra.hasDb) infraKv.push(['DB latency avg / max', `${fmtMs(infra.dbLatencyAvg)} / ${fmtMs(infra.dbLatencyMax)}`], ['DB active connections max', fmtInt(infra.dbActiveMax)], ['DB slow queries', fmtInt(infra.dbSlowQueries)]);
  sections.push({ id: 'infrastructure', title: 'Infrastructure summary', kind: 'kv', data: infraKv, note: infraKv.length ? undefined : 'No infrastructure metrics were collected for this run.' });
  if (servers.length) {
    sections.push({
      id: 'servers', title: 'Servers', kind: 'table', data: {
        columns: [{ key: 'name', header: 'Server' }, { key: 'role', header: 'Role' }, { key: 'cpuAvg', header: 'CPU avg', unit: '%' }, { key: 'cpuMax', header: 'CPU max', unit: '%' }, { key: 'memAvg', header: 'Mem avg', unit: '%' }, { key: 'memMax', header: 'Mem max', unit: '%' }, { key: 'diskMax', header: 'Disk max', unit: '%' }, { key: 'loadMax', header: 'Load max' }],
        rows: servers.map((x) => ({ name: x.name, role: x.role ?? '', cpuAvg: r2(x.cpu_avg, 1), cpuMax: r2(x.cpu_max, 1), memAvg: r2(x.mem_avg, 1), memMax: r2(x.mem_max, 1), diskMax: r2(x.disk_max, 1), loadMax: r2(x.load_max) })),
      },
    });
  }

  // Data consistency
  const rec = await reconcile(runId);
  if (rec.status !== 'NOT_AVAILABLE') sections.push({ id: 'reconciliation', title: 'Data consistency (live vs JMeter HTML report)', kind: 'text', data: `Status: ${rec.status.replace(/_/g, ' ')}.${rec.issues.length ? ' ' + rec.issues.join('; ') + '.' : ''}` });

  return {
    title, type: 'TEST_EXECUTION', generatedAt: new Date().toISOString(), version, audience: 'ENGINEERING',
    subject: { runKey: run.run_key, testName: run.test_name, projectName: run.project_name, environment: run.environment_name, build: run.build_number ?? undefined },
    result: { status: run.result ?? 'PENDING', score: n(run.performance_score) == null ? null : Math.round(Number(run.performance_score)), breakdown: bd, reasons: run.result_breakdown?.reasons ?? [] },
    sections,
  };
}

/* ------------------------------------------------------------------ Comparison */

export async function buildComparisonContent(runIds: string[], version: number, title: string): Promise<ReportContent> {
  const cmp = await compareRuns(runIds);
  const runs = await query(`${RUN_SELECT} WHERE r.id = ANY($1::uuid[])`, [runIds]);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const ordered = runIds.map((id) => byId.get(id)).filter(Boolean) as any[];
  const keys = ordered.map((r) => r.run_key);
  const letter = (i: number) => String.fromCharCode(65 + i);
  const sections: Section[] = [];

  sections.push({
    id: 'runs', title: 'Runs compared', kind: 'table', data: {
      columns: [{ key: 'letter', header: '' }, { key: 'runKey', header: 'Run ID' }, { key: 'test', header: 'Test' }, { key: 'environment', header: 'Environment' }, { key: 'build', header: 'Build' }, { key: 'started', header: 'Started' }, { key: 'result', header: 'Result' }, { key: 'score', header: 'Score' }],
      rows: ordered.map((r, i) => ({ letter: letter(i), runKey: r.run_key, test: r.test_name, environment: r.environment_name, build: r.build_number ?? '', started: iso(r.started_at) ?? '', result: r.result ?? r.status, score: r.performance_score != null ? Math.round(r.performance_score) : null })),
    },
    note: `Run A (${keys[0]}) is the reference; change % is computed against it.`,
  });

  const better = cmp.metrics.flatMap((m) => m.verdicts.map((v, i) => ({ v, i }))).filter((x) => x.i > 0);
  const worse = better.filter((x) => x.v === 'worse').length;
  const improved = better.filter((x) => x.v === 'better').length;
  sections.push({ id: 'summary', title: 'Summary', kind: 'text', data: `${ordered.length} runs compared against ${keys[0]}: ${improved} metric change(s) are improvements and ${worse} are degradations (changes under 2% are treated as neutral).` });

  sections.push({
    id: 'metrics', title: 'Key metrics', kind: 'table', data: {
      columns: [{ key: 'metric', header: 'Metric' }, ...keys.map((k, i) => ({ key: `v${i}`, header: `${letter(i)} · ${k}` })), ...keys.slice(1).map((_, j) => ({ key: `c${j + 1}`, header: `Δ ${letter(j + 1)} vs A`, unit: '%' }))],
      rows: cmp.metrics.map((m) => {
        const row: Record<string, unknown> = { metric: m.unit ? `${m.label} (${m.unit})` : m.label };
        m.values.forEach((v, i) => { row[`v${i}`] = r2(v); });
        m.changes.forEach((c, i) => { if (i > 0) row[`c${i}`] = r2(c, 1); });
        return row;
      }),
    },
  });

  const p95Series = cmp.metrics.find((m) => m.key === 'p95');
  const tpsSeries = cmp.metrics.find((m) => m.key === 'tps');
  if (p95Series) sections.push({ id: 'chart-p95', title: 'P95 by run', kind: 'chart', data: { type: 'bar', unit: 'ms', xType: 'category', series: [{ name: 'P95', data: keys.map((k, i) => [`${letter(i)} ${k}`, r2(p95Series.values[i], 0)]) }] } satisfies ChartData });
  if (tpsSeries) sections.push({ id: 'chart-tps', title: 'Average TPS by run', kind: 'chart', data: { type: 'bar', unit: 'TPS', xType: 'category', series: [{ name: 'TPS', data: keys.map((k, i) => [`${letter(i)} ${k}`, r2(tpsSeries.values[i])]) }] } satisfies ChartData });

  sections.push({
    id: 'sla', title: 'SLA results by run', kind: 'table', data: {
      columns: [{ key: 'runKey', header: 'Run ID' }, { key: 'PASS', header: 'Pass' }, { key: 'WARNING', header: 'Warning' }, { key: 'FAIL', header: 'Fail' }, { key: 'NO_DATA', header: 'No data' }],
      rows: keys.map((k, i) => ({ runKey: `${letter(i)} · ${k}`, PASS: cmp.sla[i].PASS ?? 0, WARNING: cmp.sla[i].WARNING ?? 0, FAIL: cmp.sla[i].FAIL ?? 0, NO_DATA: cmp.sla[i].NO_DATA ?? 0 })),
    },
  });

  const txRows = cmp.transactions.map((t) => {
    const row: Record<string, unknown> = { name: t.name };
    t.p95.forEach((v, i) => { row[`p${i}`] = r2(v, 0); });
    t.p95Change.forEach((c, i) => { if (i > 0) row[`c${i}`] = r2(c, 1); });
    row.maxChange = Math.max(...t.p95Change.filter((c): c is number => c != null).map(Math.abs), 0);
    return row;
  }).sort((a, b) => (b.maxChange as number) - (a.maxChange as number));
  sections.push({
    id: 'transactions', title: 'Transactions — P95 (largest changes first)', kind: 'table', data: {
      columns: [{ key: 'name', header: 'Transaction' }, ...keys.map((k, i) => ({ key: `p${i}`, header: `P95 ${letter(i)}`, unit: 'ms' })), ...keys.slice(1).map((_, j) => ({ key: `c${j + 1}`, header: `Δ ${letter(j + 1)} vs A`, unit: '%' }))],
      rows: txRows.slice(0, 40).map(({ maxChange, ...r }) => r),
    },
    note: txRows.length > 40 ? `Showing 40 of ${txRows.length} transactions.` : undefined,
  });

  if (cmp.endpoints.length) {
    sections.push({
      id: 'endpoints', title: 'API endpoints — average response time', kind: 'table', data: {
        columns: [{ key: 'endpoint', header: 'Endpoint' }, ...keys.map((_, i) => ({ key: `a${i}`, header: `Avg ${letter(i)}`, unit: 'ms' })), ...keys.slice(1).map((_, j) => ({ key: `c${j + 1}`, header: `Δ ${letter(j + 1)} vs A`, unit: '%' }))],
        rows: cmp.endpoints.slice(0, 40).map((e) => {
          const row: Record<string, unknown> = { endpoint: e.endpoint };
          e.avg.forEach((v, i) => { row[`a${i}`] = r2(v, 0); });
          e.avgChange.forEach((c, i) => { if (i > 0) row[`c${i}`] = r2(c, 1); });
          return row;
        }),
      },
    });
  }

  // Regressions recorded for the compared runs (each against its own baseline)
  const regs = await query(`SELECT g.*, r.run_key FROM regressions g JOIN test_runs r ON r.id = g.run_id WHERE g.run_id = ANY($1::uuid[]) AND g.direction = 'REGRESSION'
                            ORDER BY CASE g.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, abs(g.change_pct) DESC NULLS LAST LIMIT 20`, [runIds]);
  if (regs.length) sections.push({ id: 'regressions', title: 'Recorded regressions', kind: 'findings', data: regs.map((g) => ({ severity: g.severity, title: `${g.run_key}: ${g.transaction ?? g.scope} ${String(g.metric).toUpperCase()}`, description: `${fmtNum(n(g.previous_value), 2)} → ${fmtNum(n(g.current_value), 2)} (${g.change_pct > 0 ? '+' : ''}${fmtNum(n(g.change_pct), 1)}%)` })) });

  return {
    title, type: 'COMPARISON', generatedAt: new Date().toISOString(), version, audience: 'ENGINEERING',
    subject: { runKeys: keys, testName: [...new Set(ordered.map((r) => r.test_name))].join(', '), projectName: ordered[0]?.project_name, environment: [...new Set(ordered.map((r) => r.environment_name))].join(', ') },
    sections,
  };
}

/* ------------------------------------------------------------------ Executive */

export async function buildExecutiveContent(opts: { orgId: string; projectId: string; from: Date; to: Date; testId?: string | null; environmentId?: string | null }, version: number, title: string): Promise<ReportContent> {
  const project = await one(`SELECT name FROM projects WHERE id = $1`, [opts.projectId]);
  const trend = await loadTrend({ orgId: opts.orgId, projectId: opts.projectId, testId: opts.testId, environmentId: opts.environmentId, groupBy: 'date', from: opts.from, to: opts.to, limit: 500 });
  const runs = await query(
    `SELECT r.id, r.run_key, r.status, r.result, r.performance_score, r.build_number, COALESCE(r.started_at, r.created_at) AS started_at, t.name AS test_name, e.name AS environment_name,
            s.p95, s.tps_avg, s.error_pct, s.sla_pass_pct
     FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN environments e ON e.id = r.environment_id
     LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END LIMIT 1) s ON true
     WHERE r.project_id = $1 AND r.deleted_at IS NULL AND COALESCE(r.started_at, r.created_at) BETWEEN $2 AND $3
       AND ($4::uuid IS NULL OR r.test_id = $4) AND ($5::uuid IS NULL OR r.environment_id = $5)
     ORDER BY COALESCE(r.started_at, r.created_at) DESC`, [opts.projectId, opts.from, opts.to, opts.testId ?? null, opts.environmentId ?? null]);
  const ids = runs.map((r) => r.id);
  const [regs, slaAgg, slow] = ids.length ? await Promise.all([
    query(`SELECT g.*, r.run_key FROM regressions g JOIN test_runs r ON r.id = g.run_id WHERE g.run_id = ANY($1::uuid[]) AND g.direction = 'REGRESSION'
           ORDER BY CASE g.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, abs(g.change_pct) DESC NULLS LAST`, [ids]),
    one(`SELECT count(*) FILTER (WHERE status <> 'NO_DATA')::int evaluated, count(*) FILTER (WHERE status IN ('PASS','WARNING'))::int passed, count(*) FILTER (WHERE status = 'FAIL')::int failed FROM sla_results WHERE run_id = ANY($1::uuid[])`, [ids]),
    query(`SELECT DISTINCT ON (t.name, r.test_id) t.name, pt.name AS test_name, r.run_key, t.p95, t.tps, t.error_pct
           FROM transactions t JOIN test_runs r ON r.id = t.run_id JOIN performance_tests pt ON pt.id = r.test_id
           WHERE t.run_id = ANY($1::uuid[]) AND t.p95 IS NOT NULL AND r.status = 'COMPLETED'
           ORDER BY t.name, r.test_id, COALESCE(r.started_at, r.created_at) DESC`, [ids]),
  ]) : [[], null, []];
  const completed = runs.filter((r) => r.status === 'COMPLETED');
  const withResult = completed.filter((r) => r.result);
  const passed = withResult.filter((r) => r.result === 'PASS' || r.result === 'PASS_WITH_WARNINGS').length;
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const slaPct = slaAgg?.evaluated ? (slaAgg.passed / slaAgg.evaluated) * 100 : null;
  const passRate = withResult.length ? (passed / withResult.length) * 100 : null;
  const sections: Section[] = [];

  const dist: Record<string, number> = {};
  for (const r of runs) { const k = r.result ?? r.status; dist[k] = (dist[k] ?? 0) + 1; }
  const critical = regs.filter((g: any) => g.severity === 'CRITICAL').length;
  sections.push({
    id: 'summary', title: 'Executive summary', kind: 'text',
    data: runs.length
      ? `${project?.name ?? 'This project'} executed ${runs.length} test run(s) between ${opts.from.toISOString().slice(0, 10)} and ${opts.to.toISOString().slice(0, 10)}; ${completed.length} completed. `
        + (passRate != null ? `${fmtNum(passRate, 0)}% of analysed runs passed (${passed}/${withResult.length}). ` : '')
        + (slaPct != null ? `SLA compliance across all evaluated rules was ${fmtNum(slaPct, 1)}%. ` : 'No SLA rules were evaluated. ')
        + (regs.length ? `${regs.length} regression finding(s) were recorded${critical ? `, ${critical} of them critical` : ''}.` : 'No regressions were recorded.')
      : 'No test runs were executed in this period.',
  });
  sections.push({
    id: 'kpis', title: 'Key figures', kind: 'kpis', data: [
      { label: 'Runs', value: runs.length }, { label: 'Completed', value: completed.length },
      { label: 'Pass rate', value: r2(passRate, 1), unit: '%', status: passRate == null ? null : passRate >= 90 ? 'PASS' : passRate >= 70 ? 'WARNING' : 'FAIL', better: 'higher' },
      { label: 'SLA compliance', value: r2(slaPct, 1), unit: '%', status: slaPct == null ? null : slaPct >= 95 ? 'PASS' : slaPct >= 80 ? 'WARNING' : 'FAIL', better: 'higher' },
      { label: 'Avg P95', value: r2(avg(completed.map((r) => n(r.p95))), 0), unit: 'ms', better: 'lower' },
      { label: 'Avg TPS', value: r2(avg(completed.map((r) => n(r.tps_avg))), 1), unit: '/s', better: 'higher' },
      { label: 'Avg error rate', value: r2(avg(completed.map((r) => n(r.error_pct))), 2), unit: '%', better: 'lower' },
      { label: 'Avg score', value: r2(avg(completed.map((r) => n(r.performance_score))), 0), better: 'higher' },
      { label: 'Regressions', value: regs.length, status: regs.length ? (critical ? 'FAIL' : 'WARNING') : 'PASS', better: 'lower' },
    ] satisfies Kpi[],
  });
  sections.push({ id: 'results', title: 'Result distribution', kind: 'table', data: { columns: [{ key: 'result', header: 'Result' }, { key: 'count', header: 'Runs' }, { key: 'share', header: 'Share', unit: '%' }], rows: Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ result: k, count: v, share: r2((v / runs.length) * 100, 1) })) } });

  const pts = trend.points;
  if (pts.length > 1) {
    sections.push({ id: 'chart-p95', title: 'P95 trend', kind: 'chart', data: { type: 'line', unit: 'ms', xType: 'time', series: [{ name: 'P95', data: pts.map((p) => [new Date(p.startedAt).getTime(), r2(p.metrics.p95, 0)]) }] } satisfies ChartData });
    sections.push({ id: 'chart-tps', title: 'Throughput trend', kind: 'chart', data: { type: 'line', unit: 'TPS', xType: 'time', series: [{ name: 'TPS', data: pts.map((p) => [new Date(p.startedAt).getTime(), r2(p.metrics.tps)]) }] } satisfies ChartData });
  }
  const degr = trend.degradation.filter((d) => d.direction !== 'STABLE');
  sections.push({ id: 'trends', title: 'Trend signals', kind: 'findings', data: degr.slice(0, 15).map((d) => ({ severity: d.direction === 'IMPROVING' ? 'INFO' : d.severity, title: `${d.direction === 'IMPROVING' ? 'Improving' : 'Degrading'}: ${d.metric}`, description: d.message })) satisfies Finding[], note: degr.length ? undefined : 'No sustained degradation or improvement detected in this window.' });

  sections.push({
    id: 'regressions', title: 'Top regressions', kind: 'table', data: {
      columns: [{ key: 'runKey', header: 'Run ID' }, { key: 'severity', header: 'Severity' }, { key: 'scope', header: 'Scope' }, { key: 'metric', header: 'Metric' }, { key: 'previous', header: 'Baseline' }, { key: 'current', header: 'Current' }, { key: 'change', header: 'Change', unit: '%' }],
      rows: regs.slice(0, 15).map((g: any) => ({ runKey: g.run_key, severity: g.severity, scope: g.transaction ?? g.scope, metric: g.metric, previous: r2(g.previous_value), current: r2(g.current_value), change: r2(g.change_pct, 1) })),
    },
    note: regs.length > 15 ? `Showing 15 of ${regs.length}.` : regs.length ? undefined : 'No regressions recorded in this period.',
  });
  const slowest = [...(slow as any[])].sort((a, b) => b.p95 - a.p95).slice(0, 10);
  if (slowest.length) sections.push({ id: 'slowest', title: 'Slowest transactions (latest run of each test)', kind: 'table', data: { columns: [{ key: 'name', header: 'Transaction' }, { key: 'test', header: 'Test' }, { key: 'runKey', header: 'Run ID' }, { key: 'p95', header: 'P95', unit: 'ms' }, { key: 'tps', header: 'TPS', unit: '/s' }, { key: 'errorPct', header: 'Errors', unit: '%' }], rows: slowest.map((t) => ({ name: t.name, test: t.test_name, runKey: t.run_key, p95: r2(t.p95, 0), tps: r2(t.tps), errorPct: r2(t.error_pct) })) } });

  sections.push({
    id: 'runs', title: 'Runs in period', kind: 'table', data: {
      columns: [{ key: 'runKey', header: 'Run ID' }, { key: 'test', header: 'Test' }, { key: 'environment', header: 'Environment' }, { key: 'build', header: 'Build' }, { key: 'started', header: 'Started' }, { key: 'result', header: 'Result' }, { key: 'score', header: 'Score' }, { key: 'p95', header: 'P95', unit: 'ms' }, { key: 'tps', header: 'TPS', unit: '/s' }, { key: 'errorPct', header: 'Errors', unit: '%' }],
      rows: runs.slice(0, 100).map((r) => ({ runKey: r.run_key, test: r.test_name, environment: r.environment_name, build: r.build_number ?? '', started: iso(r.started_at), result: r.result ?? r.status, score: r.performance_score != null ? Math.round(r.performance_score) : null, p95: r2(r.p95, 0), tps: r2(r.tps_avg), errorPct: r2(r.error_pct) })),
    },
    note: runs.length > 100 ? `Showing the latest 100 of ${runs.length} runs.` : undefined,
  });

  const overall = passRate == null ? 'INCONCLUSIVE' : critical || passRate < 70 ? 'FAIL' : passRate < 90 || regs.length ? 'PASS_WITH_WARNINGS' : 'PASS';
  return {
    title, type: 'EXECUTIVE', generatedAt: new Date().toISOString(), version, audience: 'EXECUTIVE',
    subject: { projectName: project?.name, from: opts.from.toISOString(), to: opts.to.toISOString() },
    result: { status: overall, score: r2(avg(completed.map((r) => n(r.performance_score))), 0), breakdown: { 'Pass rate': passRate == null ? 'N/A' : passRate >= 90 ? 'PASS' : passRate >= 70 ? 'WARNING' : 'FAIL', SLA: slaPct == null ? 'N/A' : slaPct >= 95 ? 'PASS' : slaPct >= 80 ? 'WARNING' : 'FAIL', Regressions: critical ? 'FAIL' : regs.length ? 'WARNING' : 'PASS' } },
    sections,
  };
}

/* ------------------------------------------------------------------ formatting (shared with renderers) */

export function fmtNum(v: number | null | undefined, d = 2) { return v == null || !Number.isFinite(v) ? 'n/a' : v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }); }
export function fmtInt(v: number | null | undefined) { return fmtNum(v, 0); }
export function fmtMs(v: number | null | undefined) { return v == null || !Number.isFinite(v) ? 'n/a' : v >= 1000 ? `${fmtNum(v / 1000, 2)} s` : `${fmtNum(v, 0)} ms`; }
export function fmtDur(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return 'n/a';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
export { sevRank };
