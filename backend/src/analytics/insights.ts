import { query } from '../db/pool.js';
import { round, pctChange } from '../lib/stats.js';
import type { BottleneckCandidate } from './bottleneck.js';
import type { RegressionFinding } from './regression.js';
import type { InfraAggregates } from './summary.js';

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
interface Insight {
  category: string;
  severity: Severity;
  title: string;
  description: string;
  evidence: string[];
  confidence?: number | null;
  confidenceLabel?: string | null;
  component?: string | null;
  recommendations: { title: string; description: string; priority: 'LOW' | 'MEDIUM' | 'HIGH'; category: string }[];
}

const ms = (v: number | null | undefined) => (v == null ? 'n/a' : v >= 1000 ? `${round(v / 1000, 2)} s` : `${round(v, 0)} ms`);
const pct = (v: number | null | undefined, d = 1) => (v == null ? 'n/a' : `${round(v, d)}%`);

export const RECOMMENDATIONS: Record<string, { title: string; description: string }> = {
  CPU: { title: 'Investigate CPU saturation', description: 'CPU sustained above 85%. Investigate CPU-intensive operations, thread contention, or insufficient application capacity (scale out or optimise hot paths).' },
  DATABASE: { title: 'Investigate database latency', description: 'Database latency increased significantly while application CPU remained moderate. Investigate slow queries, missing indexes, locks, and connection pool utilization.' },
  CONNECTION_POOL: { title: 'Review connection pool sizing', description: 'The database connection pool approached exhaustion. Review pool size, connection hold times, and long-running transactions before increasing load.' },
  JVM: { title: 'Investigate GC behaviour', description: 'GC pause time increased during peak load. Investigate heap sizing, allocation rate, and object creation patterns; consider GC tuning or a low-pause collector.' },
  MEMORY: { title: 'Investigate memory pressure', description: 'Memory utilization approached capacity. Check for leaks (heap growth over time), cache sizing and swap activity.' },
  LOAD_GENERATOR: { title: 'Scale the load generator', description: 'The load generator itself was resource-constrained, which can cap throughput and inflate response times. Add load generators or reduce per-node thread count before trusting these results.' },
  SATURATION: { title: 'Throughput limit reached', description: 'TPS stopped increasing while users kept rising and latency grew. Identify the limiting resource before increasing load-generator capacity; this is the practical capacity of the current configuration.' },
  ERRORS: { title: 'Analyse failing requests', description: 'Errors increased together with latency, which is typical of timeouts or exhausted resources. Review the error breakdown by response code and endpoint and check timeout settings.' },
  REGRESSION: { title: 'Review changes since baseline', description: 'Performance regressed against the baseline. Review code, configuration and infrastructure changes between the two builds, starting with the most regressed transactions.' },
  TAIL_LATENCY: { title: 'Investigate tail latency', description: 'P99 is much higher than the median, indicating intermittent slow requests. Look for lock contention, GC pauses, cold caches, or slow downstream dependencies.' },
  DATA_QUALITY: { title: 'Improve measurement accuracy', description: 'Send raw samples (JTL or JSON samples) to Perfmon to get exact histogram-based percentiles instead of interval-reported approximations.' },
};

export async function generateInsights(runId: string, ctx: {
  summary: any; baselineSummary: any | null; baselineKey: string | null; infra: InfraAggregates; baselineInfra: InfraAggregates | null;
  bottlenecks: BottleneckCandidate[]; gaps: string[]; regressions: RegressionFinding[]; sla: { results: any[]; passPct: number | null };
  transactions: any[]; errorsByType: { error_type: string; n: number }[]; reconciliation?: { consistent: boolean; issues: string[] } | null;
}) {
  const out: Insight[] = [];
  const { summary: s, baselineSummary: b, infra } = ctx;
  if (!s) {
    out.push({ category: 'DATA_QUALITY', severity: 'WARNING', title: 'No load-test metrics', description: 'This run has no recorded metrics. Check the JMeter Backend Listener configuration, the Run ID and API key, or upload a JTL file.', evidence: [], recommendations: [] });
    return persist(runId, out);
  }

  // Latency vs baseline (with stability context, as the narrative example)
  if (b) {
    const p95c = pctChange(b.p95, s.p95);
    const tpsc = pctChange(b.tps_avg, s.tps_avg);
    if (p95c != null && Math.abs(p95c) >= 5) {
      const ev = [`P95 ${ms(b.p95)} → ${ms(s.p95)} (${p95c > 0 ? '+' : ''}${round(p95c, 1)}%) vs baseline ${ctx.baselineKey}`];
      if (tpsc != null) ev.push(Math.abs(tpsc) < 5 ? `TPS remained stable (${round(s.tps_avg, 1)} vs ${round(b.tps_avg, 1)})` : `TPS changed ${tpsc > 0 ? '+' : ''}${round(tpsc, 1)}%`);
      if (infra.cpuP90 != null) ev.push(`CPU p90 ${pct(infra.cpuP90)}`);
      if (infra.dbLatencyAvg != null && ctx.baselineInfra?.dbLatencyAvg != null) ev.push(`DB latency ${ms(ctx.baselineInfra.dbLatencyAvg)} → ${ms(infra.dbLatencyAvg)}`);
      const top = ctx.bottlenecks.find((x) => x.confidence >= 0.45);
      out.push({
        category: p95c > 0 ? 'LATENCY' : 'IMPROVEMENT', severity: p95c > 20 ? 'CRITICAL' : p95c > 10 ? 'WARNING' : 'INFO',
        title: p95c > 0 ? `P95 increased by ${round(p95c, 0)}%` : `P95 improved by ${round(-p95c, 0)}%`,
        description: p95c > 0 ? `Response-time P95 is higher than the baseline run${top ? `; the strongest signal points to ${top.component.toLowerCase()} (${top.label.toLowerCase()})` : ''}.` : 'Response times improved compared with the baseline run.',
        evidence: ev,
        recommendations: p95c > 10 && top ? [{ ...RECOMMENDATIONS[top.category], priority: 'HIGH', category: top.category }] : [],
      });
    }
  }

  // Bottlenecks
  for (const c of ctx.bottlenecks.filter((x) => x.confidence >= 0.45).slice(0, 3)) {
    const rec = RECOMMENDATIONS[c.category];
    out.push({
      category: 'BOTTLENECK', severity: c.confidence >= 0.65 ? 'WARNING' : 'INFO', component: c.component,
      title: `${c.label}: ${c.component}`, description: `${c.label} detected for ${c.component.toLowerCase()}. Confidence ${round(c.confidence * 100, 0)}%.`,
      evidence: c.evidence, confidence: c.confidence, confidenceLabel: c.label,
      recommendations: rec ? [{ ...rec, priority: c.confidence >= 0.65 ? 'HIGH' : 'MEDIUM', category: c.category }] : [],
    });
  }
  if (!ctx.bottlenecks.some((x) => x.confidence >= 0.45) && ctx.gaps.length) {
    out.push({ category: 'BOTTLENECK', severity: 'INFO', title: 'Insufficient evidence for bottleneck attribution', description: ctx.gaps.join(' '), evidence: ctx.gaps, confidence: null, confidenceLabel: 'Insufficient evidence', recommendations: [] });
  }

  // Infrastructure headroom
  if (infra.cpuMax != null) {
    if ((infra.cpuP90 ?? 0) >= 85) out.push({ category: 'INFRASTRUCTURE', severity: 'CRITICAL', title: 'CPU sustained above 85%', description: `CPU p90 was ${pct(infra.cpuP90)} (max ${pct(infra.cpuMax)}).`, evidence: [], recommendations: [{ ...RECOMMENDATIONS.CPU, priority: 'HIGH', category: 'CPU' }] });
    else if ((infra.cpuMax ?? 0) < 60) out.push({ category: 'INFRASTRUCTURE', severity: 'INFO', title: 'CPU remained below 60%', description: `Application servers have CPU headroom (max ${pct(infra.cpuMax)}).`, evidence: [], recommendations: [] });
  }
  if ((infra.heapPctMax ?? 0) >= 90) out.push({ category: 'JVM', severity: 'WARNING', title: 'JVM heap above 90%', description: `Heap usage peaked at ${pct(infra.heapPctMax)}; GC pauses up to ${ms(infra.gcPauseMax)}.`, evidence: [], recommendations: [{ ...RECOMMENDATIONS.JVM, priority: 'MEDIUM', category: 'JVM' }] });

  // Errors
  if ((s.error_pct ?? 0) >= 1) {
    const top = ctx.errorsByType.slice(0, 3).map((e) => `${e.error_type}: ${e.n}`);
    out.push({ category: 'ERRORS', severity: s.error_pct >= 5 ? 'CRITICAL' : 'WARNING', title: `Error rate ${pct(s.error_pct, 2)}`, description: `${s.failure_count} of ${s.total_samples} requests failed.`, evidence: top, recommendations: [{ ...RECOMMENDATIONS.ERRORS, priority: s.error_pct >= 5 ? 'HIGH' : 'MEDIUM', category: 'ERRORS' }] });
  }

  // Tail latency
  if (s.p99 && s.p50 && s.p99 / s.p50 >= 4 && s.p99 > 500) {
    out.push({ category: 'LATENCY', severity: 'INFO', title: 'Long latency tail', description: `P99 (${ms(s.p99)}) is ${round(s.p99 / s.p50, 1)}× the median (${ms(s.p50)}).`, evidence: [], recommendations: [{ ...RECOMMENDATIONS.TAIL_LATENCY, priority: 'LOW', category: 'TAIL_LATENCY' }] });
  }

  // Slowest transactions
  const slow = [...ctx.transactions].filter((t) => t.p95 != null).sort((a, z) => z.p95 - a.p95).slice(0, 3);
  if (slow.length) out.push({ category: 'LATENCY', severity: 'INFO', title: `Slowest transaction: ${slow[0].name}`, description: `Top slow transactions by P95.`, evidence: slow.map((t) => `${t.name}: P95 ${ms(t.p95)}, ${round(t.tps, 2)} TPS`), recommendations: [] });

  // Regressions
  const regs = ctx.regressions.filter((r) => r.direction === 'REGRESSION');
  if (regs.length) {
    const worst = [...regs].sort((a, z) => (z.changePct ?? 0) - (a.changePct ?? 0))[0];
    out.push({ category: 'REGRESSION', severity: regs.some((r) => r.severity === 'CRITICAL') ? 'CRITICAL' : 'WARNING', title: `${regs.length} performance regression${regs.length > 1 ? 's' : ''} vs baseline`,
      description: `Largest: ${worst.transaction ? worst.transaction + ' ' : ''}${worst.metric} ${worst.changePct != null ? '+' + round(worst.changePct, 1) + '%' : ''}.`,
      evidence: regs.slice(0, 6).map((r) => `${r.transaction ?? 'Run'} ${r.metric}: ${round(r.previous, 1)} → ${round(r.current, 1)}${r.changePct != null ? ` (${r.changePct > 0 ? '+' : ''}${round(r.changePct, 1)}%)` : ''}`),
      recommendations: [{ ...RECOMMENDATIONS.REGRESSION, priority: 'HIGH', category: 'REGRESSION' }] });
  }
  const imps = ctx.regressions.filter((r) => r.direction === 'IMPROVEMENT');
  if (imps.length) out.push({ category: 'IMPROVEMENT', severity: 'INFO', title: `${imps.length} performance improvement${imps.length > 1 ? 's' : ''} vs baseline`, description: 'Metrics that improved beyond the regression threshold.', evidence: imps.slice(0, 6).map((r) => `${r.transaction ?? 'Run'} ${r.metric}: ${round(r.previous, 1)} → ${round(r.current, 1)}`), recommendations: [] });

  // SLA
  const fails = ctx.sla.results.filter((r) => r.status === 'FAIL');
  if (fails.length) out.push({ category: 'SLA', severity: 'CRITICAL', title: `${fails.length} SLA violation${fails.length > 1 ? 's' : ''}`, description: `SLA compliance ${pct(ctx.sla.passPct)}.`, evidence: fails.slice(0, 8).map((r) => `${r.transaction ?? 'Run'} ${r.rule.metric} = ${round(r.value, 2)} (critical ${r.rule.direction === 'LOWER' ? '≥' : '<'} ${r.rule.critical_value ?? r.rule.warning_value})`), recommendations: [] });

  // Data quality
  if (s.percentile_method === 'interval_weighted_approx') out.push({ category: 'DATA_QUALITY', severity: 'INFO', title: 'Percentiles are approximate', description: 'Run percentiles were derived from interval-reported percentiles (JMeter Backend Listener). They are labelled ≈ in the UI.', evidence: [], recommendations: [{ ...RECOMMENDATIONS.DATA_QUALITY, priority: 'LOW', category: 'DATA_QUALITY' }] });
  if (ctx.reconciliation && !ctx.reconciliation.consistent) out.push({ category: 'DATA_QUALITY', severity: 'WARNING', title: 'Live metrics and HTML report disagree', description: 'Data consistency check found differences above tolerance.', evidence: ctx.reconciliation.issues, recommendations: [] });

  return persist(runId, out);
}

async function persist(runId: string, items: Insight[]) {
  await query(`DELETE FROM recommendations WHERE run_id = $1`, [runId]);
  await query(`DELETE FROM insights WHERE run_id = $1`, [runId]);
  for (const i of items) {
    const [row] = await query(
      `INSERT INTO insights (run_id, category, severity, title, description, evidence, confidence, confidence_label, component) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [runId, i.category, i.severity, i.title, i.description, JSON.stringify(i.evidence), i.confidence ?? null, i.confidenceLabel ?? null, i.component ?? null]);
    for (const r of i.recommendations) {
      await query(`INSERT INTO recommendations (run_id, insight_id, category, priority, title, description) VALUES ($1,$2,$3,$4,$5,$6)`, [runId, row.id, r.category, r.priority, r.title, r.description]);
    }
  }
  return items;
}
