import { query, one } from '../db/pool.js';
import { primarySummary, primaryTransactions, infraAggregates } from './summary.js';

export type SlaStatus = 'PASS' | 'WARNING' | 'FAIL' | 'NO_DATA';

export const SLA_METRICS: Record<string, { label: string; unit: string; direction: 'LOWER' | 'HIGHER' }> = {
  avg_rt: { label: 'Average response time', unit: 'ms', direction: 'LOWER' },
  p50: { label: 'P50', unit: 'ms', direction: 'LOWER' },
  p90: { label: 'P90', unit: 'ms', direction: 'LOWER' },
  p95: { label: 'P95', unit: 'ms', direction: 'LOWER' },
  p99: { label: 'P99', unit: 'ms', direction: 'LOWER' },
  max_rt: { label: 'Max response time', unit: 'ms', direction: 'LOWER' },
  error_pct: { label: 'Error rate', unit: '%', direction: 'LOWER' },
  tps: { label: 'Throughput (TPS)', unit: 'tps', direction: 'HIGHER' },
  cpu_pct: { label: 'CPU (p90)', unit: '%', direction: 'LOWER' },
  memory_pct: { label: 'Memory (max)', unit: '%', direction: 'LOWER' },
  heap_pct: { label: 'JVM heap (max)', unit: '%', direction: 'LOWER' },
  gc_pause_ms: { label: 'GC pause (max)', unit: 'ms', direction: 'LOWER' },
  db_latency_ms: { label: 'DB query latency (avg)', unit: 'ms', direction: 'LOWER' },
};

/** Evaluate a value against warning/critical thresholds. */
export function evaluate(value: number | null | undefined, direction: 'LOWER' | 'HIGHER', warning: number | null, critical: number | null): SlaStatus {
  if (value == null || !Number.isFinite(value)) return 'NO_DATA';
  const breach = (t: number | null) => t != null && (direction === 'LOWER' ? value >= t : value < t);
  if (breach(critical)) return 'FAIL';
  if (breach(warning)) return 'WARNING';
  return 'PASS';
}

const globToRegex = (g: string) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

function txnValue(t: any, metric: string): number | null {
  switch (metric) {
    case 'avg_rt': return t.avg_rt;
    case 'p50': return t.median_rt;
    case 'p90': return t.p90;
    case 'p95': return t.p95;
    case 'p99': return t.p99;
    case 'max_rt': return t.max_rt;
    case 'error_pct': return t.error_pct;
    case 'tps': return t.tps;
    default: return null;
  }
}

export async function evaluateSla(runId: string) {
  const run = await one(`SELECT r.id, t.sla_profile_id FROM test_runs r JOIN performance_tests t ON t.id = r.test_id WHERE r.id = $1`, [runId]);
  await query(`DELETE FROM sla_results WHERE run_id = $1`, [runId]);
  if (!run?.sla_profile_id) {
    await query(`UPDATE run_summary SET sla_pass_pct = NULL, sla_violations = NULL WHERE run_id = $1`, [runId]);
    return { profileId: null, results: [], passPct: null, violations: 0, warnings: 0 };
  }
  const rules = await query(`SELECT * FROM sla_rules WHERE profile_id = $1 AND enabled ORDER BY position, metric`, [run.sla_profile_id]);
  const summary = await primarySummary(runId);
  const txns = await primaryTransactions(runId);
  const infra = await infraAggregates(runId);
  const results: any[] = [];

  const runValue = (metric: string): number | null => {
    switch (metric) {
      case 'avg_rt': return summary?.avg_rt ?? null;
      case 'p50': return summary?.p50 ?? null;
      case 'p90': return summary?.p90 ?? null;
      case 'p95': return summary?.p95 ?? null;
      case 'p99': return summary?.p99 ?? null;
      case 'max_rt': return summary?.max_rt ?? null;
      case 'error_pct': return summary?.error_pct ?? null;
      case 'tps': return summary?.tps_avg ?? null;
      case 'cpu_pct': return infra.cpuP90;
      case 'memory_pct': return infra.memMax;
      case 'heap_pct': return infra.heapPctMax;
      case 'gc_pause_ms': return infra.gcPauseMax;
      case 'db_latency_ms': return infra.dbLatencyAvg;
      default: return null;
    }
  };

  for (const rule of rules) {
    if (rule.scope === 'RUN') {
      const v = runValue(rule.metric);
      results.push({ rule, transaction: null, value: v, status: evaluate(v, rule.direction, rule.warning_value, rule.critical_value) });
    } else {
      const re = rule.transaction_pattern ? globToRegex(rule.transaction_pattern) : null;
      for (const t of txns.filter((t) => !re || re.test(t.name))) {
        const v = txnValue(t, rule.metric);
        results.push({ rule, transaction: t.name, value: v, status: evaluate(v, rule.direction, rule.warning_value, rule.critical_value) });
      }
    }
  }
  for (const r of results) {
    await query(
      `INSERT INTO sla_results (run_id, rule_id, profile_id, scope, transaction, metric, direction, actual_value, warning_value, critical_value, unit, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [runId, r.rule.id, run.sla_profile_id, r.rule.scope, r.transaction, r.rule.metric, r.rule.direction, r.value, r.rule.warning_value, r.rule.critical_value, r.rule.unit ?? SLA_METRICS[r.rule.metric]?.unit ?? null, r.status]);
  }
  // Transaction SLA status (worst status per transaction)
  const rank: Record<string, number> = { NO_DATA: 0, PASS: 1, WARNING: 2, FAIL: 3 };
  const worst = new Map<string, string>();
  for (const r of results.filter((r) => r.transaction)) {
    const prev = worst.get(r.transaction);
    if (!prev || rank[r.status] > rank[prev]) worst.set(r.transaction, r.status);
  }
  await query(`UPDATE transactions SET sla_status = 'NO_SLA' WHERE run_id = $1`, [runId]);
  for (const [name, st] of worst) await query(`UPDATE transactions SET sla_status = $3 WHERE run_id = $1 AND name = $2`, [runId, name, st]);

  // SLA Compliance = Passed assertions / Total evaluated assertions × 100 (WARNING passes the hard threshold)
  const evaluated = results.filter((r) => r.status !== 'NO_DATA');
  const passed = evaluated.filter((r) => r.status !== 'FAIL').length;
  const passPct = evaluated.length ? (passed / evaluated.length) * 100 : null;
  const violations = evaluated.filter((r) => r.status === 'FAIL').length;
  const warnings = evaluated.filter((r) => r.status === 'WARNING').length;
  await query(`UPDATE run_summary SET sla_pass_pct = $2, sla_violations = $3 WHERE run_id = $1`, [runId, passPct, violations]);
  return { profileId: run.sla_profile_id, results, passPct, violations, warnings };
}
