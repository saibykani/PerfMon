import { one, query } from '../db/pool.js';
import { round } from '../lib/stats.js';
import { primarySummary } from '../analytics/summary.js';

const ms = (v: number | null | undefined) => (v == null ? 'n/a' : v >= 1000 ? `${round(v / 1000, 2)} sec` : `${round(v, 0)} ms`);
const dur = (s: number | null | undefined) => (s == null ? 'n/a' : s >= 3600 ? `${round(s / 3600, 1)} h` : s >= 60 ? `${round(s / 60, 0)} min` : `${round(s, 0)} s`);

/** Plain-text "Run Summary" generated for every completed run. */
export async function buildRunSummaryText(runId: string) {
  const run = await one(`SELECT r.*, t.name test_name FROM test_runs r JOIN performance_tests t ON t.id = r.test_id WHERE r.id = $1`, [runId]);
  const s = await primarySummary(runId);
  const regs = await query(`SELECT * FROM regressions WHERE run_id = $1 AND direction = 'REGRESSION' ORDER BY change_pct DESC NULLS LAST`, [runId]);
  const top = regs[0];
  const bott = (run.analysis?.bottlenecks ?? []).find((b: any) => b.confidence >= 0.45);
  const rec = await one(`SELECT title, description FROM recommendations WHERE run_id = $1 ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END LIMIT 1`, [runId]);
  const lines = [
    'Run Summary', '',
    `Run ID:\n${run.run_key}`, '',
    `Test:\n${run.test_name}`, '',
    `Result:\n${(run.result ?? 'PENDING').replace(/_/g, ' ')}`, '',
    `Duration:\n${dur(s?.duration_sec)}`, '',
    `Users:\n${s?.users_peak ?? run.virtual_users ?? 'n/a'}`, '',
    `TPS:\n${round(s?.tps_avg, 1) ?? 'n/a'}`, '',
    `Average RT:\n${ms(s?.avg_rt)}`, '',
    `P95:\n${ms(s?.p95)}${s?.percentile_method === 'interval_weighted_approx' ? ' (approx.)' : ''}`, '',
    `P99:\n${ms(s?.p99)}`, '',
    `Error:\n${s?.error_pct != null ? round(s.error_pct, 2) + '%' : 'n/a'}`, '',
    `SLA:\n${s?.sla_pass_pct != null ? round(s.sla_pass_pct, 1) + '%' : 'No SLA profile'}`, '',
    `Performance Regression:\n${regs.length ? 'YES' : 'NO'}`, '',
  ];
  if (top) lines.push(`Major Finding:\n${top.transaction ?? 'Run'} ${top.metric.toUpperCase()} ${top.change_pct > 0 ? 'increased' : 'changed'} ${round(Math.abs(top.change_pct), 0)}%.`, '');
  if (bott) lines.push(`${bott.label}:\n${bott.component}.`, '');
  if (rec) lines.push(`Recommendation:\n${rec.description}`);
  return lines.join('\n');
}
