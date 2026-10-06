import { round } from '../lib/stats.js';
import type { InfraAggregates } from './summary.js';
import type { RegressionFinding } from './regression.js';

export interface ScoreFactor { key: string; label: string; weight: number; score: number | null; detail: string }

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/**
 * Configurable Performance Score (0-100). Each factor is scored 0-100; factors
 * without data are excluded and the remaining weights renormalized. The full
 * breakdown is always returned so the score never hides the underlying metrics.
 */
export function performanceScore(weights: Record<string, number>, input: {
  summary: any; slaPassPct: number | null; p95Target: number | null; targetTps: number | null; baselineTps: number | null;
  infra: InfraAggregates; regressions: RegressionFinding[]; hasBaseline: boolean;
}) {
  const s = input.summary;
  const factors: ScoreFactor[] = [];
  factors.push({ key: 'sla', label: 'SLA compliance', weight: weights.sla ?? 0, score: input.slaPassPct, detail: input.slaPassPct == null ? 'No SLA profile' : `${round(input.slaPassPct, 1)}% of assertions passed` });

  let rt: number | null = null;
  let rtDetail = 'No P95 target (SLA) defined';
  if (s?.p95 != null && input.p95Target) {
    rt = s.p95 <= input.p95Target ? 100 : clamp(100 - ((s.p95 - input.p95Target) / input.p95Target) * 100);
    rtDetail = `P95 ${round(s.p95, 0)} ms vs target ${input.p95Target} ms`;
  }
  factors.push({ key: 'responseTime', label: 'Response time', weight: weights.responseTime ?? 0, score: rt, detail: rtDetail });

  let tp: number | null = null;
  let tpDetail = 'No target TPS or baseline';
  const ref = input.targetTps || input.baselineTps;
  if (s?.tps_avg != null && ref) {
    tp = clamp((s.tps_avg / ref) * 100);
    tpDetail = `${round(s.tps_avg, 1)} TPS vs ${input.targetTps ? 'target' : 'baseline'} ${round(ref, 1)}`;
  }
  factors.push({ key: 'throughput', label: 'Throughput', weight: weights.throughput ?? 0, score: tp, detail: tpDetail });

  const err = s?.error_pct != null ? clamp(100 - s.error_pct * 20) : null;
  factors.push({ key: 'errorRate', label: 'Error rate', weight: weights.errorRate ?? 0, score: err, detail: s?.error_pct != null ? `${round(s.error_pct, 2)}% errors (0% = 100, ≥5% = 0)` : 'No data' });

  let inf: number | null = null;
  if (input.infra.cpuP90 != null || input.infra.memMax != null) {
    const cpu = input.infra.cpuP90 != null ? clamp(100 - Math.max(0, input.infra.cpuP90 - 70) * (100 / 30)) : 100;
    const mem = input.infra.memMax != null ? clamp(100 - Math.max(0, input.infra.memMax - 80) * 5) : 100;
    inf = Math.min(cpu, mem);
  }
  factors.push({ key: 'infrastructure', label: 'Infrastructure utilization', weight: weights.infrastructure ?? 0, score: inf, detail: inf == null ? 'No infrastructure metrics' : `CPU p90 ${round(input.infra.cpuP90, 0) ?? 'n/a'}%, memory max ${round(input.infra.memMax, 0) ?? 'n/a'}%` });

  let reg: number | null = null;
  if (input.hasBaseline) {
    const regs = input.regressions.filter((r) => r.direction === 'REGRESSION');
    reg = clamp(100 - regs.filter((r) => r.severity === 'CRITICAL').length * 25 - regs.filter((r) => r.severity === 'WARNING').length * 10);
  }
  factors.push({ key: 'regression', label: 'Regression', weight: weights.regression ?? 0, score: reg, detail: input.hasBaseline ? `${input.regressions.filter((r) => r.direction === 'REGRESSION').length} regressions vs baseline` : 'No baseline' });

  const active = factors.filter((f) => f.score != null && f.weight > 0);
  const totalW = active.reduce((a, f) => a + f.weight, 0);
  const score = totalW ? active.reduce((a, f) => a + (f.score! * f.weight) / totalW, 0) : null;
  return { score: score == null ? null : Math.round(score), factors, weights };
}

export type ResultStatus = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' | 'INCONCLUSIVE';

/** PASS / PASS WITH WARNINGS / FAIL / INCONCLUSIVE with per-dimension breakdown. */
export function classifyResult(input: {
  runStatus: string; summary: any; sla: { results: any[] }; regressions: RegressionFinding[]; infra: InfraAggregates;
  defaults: { errorPctFail: number; errorPctWarn: number }; targetTps: number | null;
}) {
  const s = input.summary;
  const breakdown: Record<string, 'PASS' | 'WARNING' | 'FAIL' | 'N/A'> = {};
  const reasons: string[] = [];
  if (!s || !s.total_samples) {
    return { result: 'INCONCLUSIVE' as ResultStatus, breakdown: { Data: 'FAIL' as const }, reasons: ['No samples recorded for this run'] };
  }
  const slaEval = input.sla.results.filter((r) => r.status !== 'NO_DATA');
  breakdown.SLA = !slaEval.length ? 'N/A' : slaEval.some((r) => r.status === 'FAIL') ? 'FAIL' : slaEval.some((r) => r.status === 'WARNING') ? 'WARNING' : 'PASS';
  const byMetric = (m: string) => {
    const rs = slaEval.filter((r) => r.rule.metric === m && r.rule.scope === 'RUN');
    if (!rs.length) return 'N/A' as const;
    return rs.some((r) => r.status === 'FAIL') ? 'FAIL' : rs.some((r) => r.status === 'WARNING') ? 'WARNING' : 'PASS';
  };
  breakdown.TPS = byMetric('tps');
  if (breakdown.TPS === 'N/A' && input.targetTps) breakdown.TPS = s.tps_avg >= input.targetTps * 0.95 ? 'PASS' : s.tps_avg >= input.targetTps * 0.8 ? 'WARNING' : 'FAIL';
  breakdown.P95 = byMetric('p95');
  const errSla = byMetric('error_pct');
  breakdown['Error Rate'] = errSla !== 'N/A' ? errSla : s.error_pct >= input.defaults.errorPctFail ? 'FAIL' : s.error_pct >= input.defaults.errorPctWarn ? 'WARNING' : 'PASS';
  const cpuSla = byMetric('cpu_pct');
  breakdown.CPU = cpuSla !== 'N/A' ? cpuSla : input.infra.cpuP90 == null ? 'N/A' : input.infra.cpuP90 >= 90 ? 'FAIL' : input.infra.cpuP90 >= 80 ? 'WARNING' : 'PASS';
  const regs = input.regressions.filter((r) => r.direction === 'REGRESSION');
  breakdown.Regression = regs.some((r) => r.severity === 'CRITICAL') ? 'WARNING' : regs.length ? 'WARNING' : 'PASS';

  for (const [k, v] of Object.entries(breakdown)) if (v === 'FAIL' || v === 'WARNING') reasons.push(`${k}: ${v}`);
  let result: ResultStatus;
  if (input.runStatus === 'FAILED') { result = 'FAIL'; reasons.unshift('Test execution reported FAILED'); }
  else if (Object.values(breakdown).includes('FAIL')) result = 'FAIL';
  else if (Object.values(breakdown).includes('WARNING')) result = 'PASS_WITH_WARNINGS';
  else result = 'PASS';
  if (input.runStatus === 'ABORTED' && result !== 'FAIL') { result = 'INCONCLUSIVE'; reasons.unshift('Run was aborted before completion'); }
  if (s.total_samples < 100 && result !== 'FAIL') { result = 'INCONCLUSIVE'; reasons.unshift(`Only ${s.total_samples} samples — not enough data for a reliable verdict`); }
  return { result, breakdown, reasons };
}
