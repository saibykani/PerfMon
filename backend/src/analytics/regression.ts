import { one, query } from '../db/pool.js';
import { pctChange } from '../lib/stats.js';
import { getSetting } from './settings.js';
import { resolveBaseline } from './compare.js';
import { primarySummary, primaryTransactions, infraAggregates } from './summary.js';

export interface RegressionFinding {
  scope: 'RUN' | 'TRANSACTION' | 'INFRA';
  transaction: string | null;
  metric: string;
  previous: number;
  current: number;
  changePct: number | null;
  thresholdPct: number;
  direction: 'REGRESSION' | 'IMPROVEMENT';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

/** Detect regressions/improvements of a run against its baseline. Persists rows in `regressions`. */
export async function detectRegressions(runId: string, likelyImpacted: string[] = []) {
  const run = await one(`SELECT organization_id FROM test_runs WHERE id = $1`, [runId]);
  const th = await getSetting(run.organization_id, 'regression_thresholds');
  const baseline = await resolveBaseline(runId);
  await query(`DELETE FROM regressions WHERE run_id = $1`, [runId]);
  if (!baseline) return { baseline: null, findings: [] as RegressionFinding[] };

  const [cur, prev] = await Promise.all([primarySummary(runId), primarySummary(baseline.id)]);
  const findings: RegressionFinding[] = [];
  const check = (scope: RegressionFinding['scope'], transaction: string | null, metric: string, p: number | null, c: number | null, thresholdPct: number, higherIsWorse: boolean, minAbs = 0) => {
    if (p == null || c == null || !Number.isFinite(p) || !Number.isFinite(c)) return;
    const change = pctChange(p, c);
    if (change == null) return;
    if (Math.abs(c - p) < minAbs) return;
    const worse = higherIsWorse ? change > thresholdPct : change < -thresholdPct;
    const better = higherIsWorse ? change < -thresholdPct : change > thresholdPct;
    if (!worse && !better) return;
    const severity = worse ? (Math.abs(change) >= thresholdPct * 2 ? 'CRITICAL' : 'WARNING') : 'INFO';
    findings.push({ scope, transaction, metric, previous: p, current: c, changePct: change, thresholdPct, direction: worse ? 'REGRESSION' : 'IMPROVEMENT', severity });
  };

  if (cur && prev) {
    check('RUN', null, 'p95', prev.p95, cur.p95, th.p95Pct, true, th.minAbsoluteMs);
    check('RUN', null, 'p99', prev.p99, cur.p99, th.p99Pct, true, th.minAbsoluteMs);
    check('RUN', null, 'avg_rt', prev.avg_rt, cur.avg_rt, th.avgPct, true, th.minAbsoluteMs);
    check('RUN', null, 'tps', prev.tps_avg, cur.tps_avg, th.tpsDropPct, false);
    // Error rate: absolute percentage-point increase
    if (prev.error_pct != null && cur.error_pct != null) {
      const diff = cur.error_pct - prev.error_pct;
      if (diff > th.errorRateIncreasePts) findings.push({ scope: 'RUN', transaction: null, metric: 'error_pct', previous: prev.error_pct, current: cur.error_pct, changePct: pctChange(prev.error_pct, cur.error_pct), thresholdPct: th.errorRateIncreasePts, direction: 'REGRESSION', severity: diff > th.errorRateIncreasePts * 3 ? 'CRITICAL' : 'WARNING' });
      else if (diff < -th.errorRateIncreasePts) findings.push({ scope: 'RUN', transaction: null, metric: 'error_pct', previous: prev.error_pct, current: cur.error_pct, changePct: pctChange(prev.error_pct, cur.error_pct), thresholdPct: th.errorRateIncreasePts, direction: 'IMPROVEMENT', severity: 'INFO' });
    }
  }

  // Transaction-level
  const [ct, pt] = await Promise.all([primaryTransactions(runId), primaryTransactions(baseline.id)]);
  const prevMap = new Map(pt.map((t) => [t.name, t]));
  for (const t of ct) {
    const p = prevMap.get(t.name);
    if (!p || t.samples < th.minTransactionSamples || p.samples < th.minTransactionSamples) continue;
    check('TRANSACTION', t.name, 'p95', p.p95, t.p95, th.p95Pct, true, th.minAbsoluteMs);
    check('TRANSACTION', t.name, 'p99', p.p99, t.p99, th.p99Pct, true, th.minAbsoluteMs);
    if (p.error_pct != null && t.error_pct != null && t.error_pct - p.error_pct > th.errorRateIncreasePts) {
      findings.push({ scope: 'TRANSACTION', transaction: t.name, metric: 'error_pct', previous: p.error_pct, current: t.error_pct, changePct: pctChange(p.error_pct, t.error_pct), thresholdPct: th.errorRateIncreasePts, direction: 'REGRESSION', severity: 'WARNING' });
    }
  }

  // Infrastructure: absolute point increases
  const [ci, pi] = await Promise.all([infraAggregates(runId), infraAggregates(baseline.id)]);
  const infraCheck = (metric: string, p: number | null, c: number | null, pts: number) => {
    if (p == null || c == null) return;
    if (c - p > pts) findings.push({ scope: 'INFRA', transaction: null, metric, previous: p, current: c, changePct: pctChange(p, c), thresholdPct: pts, direction: 'REGRESSION', severity: c - p > pts * 2 ? 'CRITICAL' : 'WARNING' });
  };
  infraCheck('cpu_avg', pi.cpuAvg, ci.cpuAvg, th.cpuIncreasePts);
  infraCheck('mem_max', pi.memMax, ci.memMax, th.memoryIncreasePts);
  if (pi.dbLatencyAvg != null && ci.dbLatencyAvg != null) check('INFRA', null, 'db_latency_avg', pi.dbLatencyAvg, ci.dbLatencyAvg, 25, true, 5);

  for (const f of findings) {
    await query(
      `INSERT INTO regressions (run_id, baseline_run_id, scope, transaction, metric, previous_value, current_value, change_pct, threshold_pct, direction, severity, likely_impacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [runId, baseline.id, f.scope, f.transaction, f.metric, f.previous, f.current, f.changePct, f.thresholdPct, f.direction, f.severity, f.direction === 'REGRESSION' ? likelyImpacted : []]);
  }
  return { baseline, findings };
}
