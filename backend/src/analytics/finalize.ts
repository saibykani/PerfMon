import { one, query } from '../db/pool.js';
import { registerJob, enqueue } from '../jobs/queue.js';
import { aggregator } from '../ingest/aggregator.js';
import { invalidateRun } from '../ingest/runCache.js';
import { publishRunEvent } from '../live/hub.js';
import { computeSummaries, primarySummary, primaryTransactions, infraAggregates } from './summary.js';
import { evaluateSla } from './sla.js';
import { analyzeBottlenecks } from './bottleneck.js';
import { detectRegressions } from './regression.js';
import { generateInsights } from './insights.js';
import { performanceScore, classifyResult } from './score.js';
import { getSetting } from './settings.js';
import { reconcile } from '../reports/reconcile.js';
import { evaluateRunCompletionAlerts } from '../alerts/evaluator.js';

/**
 * Full analysis pipeline for a run. Idempotent: can be re-run any time
 * (e.g. after uploading a JTL or HTML report, or changing the SLA profile).
 */
export async function analyzeRun(runId: string) {
  await aggregator.flush(true, runId);
  const run = await one(`SELECT r.*, t.sla_profile_id FROM test_runs r JOIN performance_tests t ON t.id = r.test_id WHERE r.id = $1`, [runId]);
  if (!run) throw new Error(`run ${runId} not found`);

  await computeSummaries(runId);
  const sla = await evaluateSla(runId);
  const summary = await primarySummary(runId);

  const { resolveBaseline } = await import('./compare.js');
  const baseline = await resolveBaseline(runId);
  const bott = await analyzeBottlenecks(runId, baseline?.id ?? null);
  const impacted = bott.candidates.filter((c) => c.confidence >= 0.45).map((c) => c.component);
  const reg = await detectRegressions(runId, impacted);
  const baselineSummary = baseline ? await primarySummary(baseline.id) : null;
  const baselineInfra = baseline ? await infraAggregates(baseline.id) : null;
  const infra = bott.infra ?? (await infraAggregates(runId));
  const transactions = await primaryTransactions(runId);
  const errorsByType = await query(`SELECT error_type, sum(count)::int n FROM error_metrics WHERE run_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [runId]);
  const rec = await reconcile(runId);

  await generateInsights(runId, {
    summary, baselineSummary, baselineKey: baseline?.runKey ?? null, infra, baselineInfra,
    bottlenecks: bott.candidates, gaps: bott.gaps, regressions: reg.findings, sla: { results: sla.results, passPct: sla.passPct },
    transactions, errorsByType, reconciliation: rec.status === 'NOT_AVAILABLE' ? null : rec,
  });

  const weights = await getSetting(run.organization_id, 'score_weights');
  const p95Rule = sla.results.find((r) => r.rule.metric === 'p95' && r.rule.scope === 'RUN');
  const score = performanceScore(weights, {
    summary, slaPassPct: sla.passPct, p95Target: p95Rule ? p95Rule.rule.warning_value ?? p95Rule.rule.critical_value : null,
    targetTps: run.target_tps, baselineTps: baselineSummary?.tps_avg ?? null, infra, regressions: reg.findings, hasBaseline: !!baseline,
  });
  const defaults = await getSetting(run.organization_id, 'default_result_thresholds');
  const result = classifyResult({ runStatus: run.status === 'ANALYZING' ? 'COMPLETED' : run.status, summary, sla, regressions: reg.findings, infra, defaults, targetTps: run.target_tps });

  await query(
    `UPDATE test_runs SET performance_score = $2, score_breakdown = $3, result = $4, result_breakdown = $5, analysis = $6, analyzed_at = now(),
       baseline_run_id = COALESCE(baseline_run_id, $7), updated_at = now() WHERE id = $1`,
    [runId, score.score, JSON.stringify(score), result.result, JSON.stringify(result), JSON.stringify({ bottlenecks: bott.candidates, saturation: bott.saturation, gaps: bott.gaps, baseline, reconciliation: rec.status }), baseline?.id ?? null]);
  return { summary, sla, baseline, bottlenecks: bott, regressions: reg.findings, score, result };
}

registerJob('run.finalize', async ({ runId, finalStatus }) => {
  const res = await analyzeRun(runId);
  const run = await one(`SELECT * FROM test_runs WHERE id = $1`, [runId]);
  const status = run.status === 'ANALYZING' ? finalStatus ?? 'COMPLETED' : run.status;
  await query(`UPDATE test_runs SET status = $2, updated_at = now() WHERE id = $1`, [runId, status]);
  invalidateRun({ id: runId, runKey: run.run_key });
  // Final report (Test Execution) — reproducible from the Run ID
  await enqueue('report.generate', { type: 'TEST_EXECUTION', runId, projectId: run.project_id, auto: true }, { runId, priority: 4 });
  await evaluateRunCompletionAlerts(runId, { status, result: res.result.result, regressions: res.regressions, slaViolations: res.sla.violations });
  if (res.regressions.some((r) => r.direction === 'REGRESSION')) {
    await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, ts, title, source) VALUES ($1,$2,$3,$4,'REGRESSION',$5,now(),$6,'analytics')`,
      [run.project_id, run.application_id, run.environment_id, runId, res.regressions.some((r) => r.severity === 'CRITICAL') ? 'CRITICAL' : 'WARNING', `Performance regression detected (${run.run_key})`]);
  }
  publishRunEvent(runId, 'status', { status, result: res.result.result, score: res.score.score });
  return { status, result: res.result.result, score: res.score.score, regressions: res.regressions.length };
});

registerJob('run.reanalyze', async ({ runId }) => {
  const res = await analyzeRun(runId);
  publishRunEvent(runId, 'analysis', { result: res.result.result });
  return { result: res.result.result, score: res.score.score };
});
