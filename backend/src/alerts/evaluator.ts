import { one, query, tsPool } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { windowStats } from '../metrics/series.js';
import { round } from '../lib/stats.js';
import { selfMetrics } from '../selfmon/registry.js';
import type { RegressionFinding } from '../analytics/regression.js';

const cmp = (op: string, v: number, t: number) => (op === '>' ? v > t : op === '>=' ? v >= t : op === '<' ? v < t : v <= t);

const LABEL: Record<string, string> = {
  HIGH_RESPONSE_TIME: 'Average response time', HIGH_P95: 'P95', HIGH_P99: 'P99', LOW_TPS: 'TPS', HIGH_ERROR_RATE: 'Error rate',
  CPU: 'CPU', MEMORY: 'Memory', DISK: 'Disk', JVM_HEAP: 'JVM heap', GC: 'GC pause',
};
const UNIT: Record<string, string> = { HIGH_RESPONSE_TIME: 'ms', HIGH_P95: 'ms', HIGH_P99: 'ms', LOW_TPS: ' TPS', HIGH_ERROR_RATE: '%', CPU: '%', MEMORY: '%', DISK: '%', JVM_HEAP: '%', GC: 'ms' };

async function fire(rule: any, subject: string, ctx: { runId?: string | null; serverId?: string | null; value?: number | null; title: string; message: string }) {
  const open = await one(`SELECT id FROM alerts WHERE rule_id = $1 AND subject = $2 AND status <> 'RESOLVED'`, [rule.id, subject]);
  if (open) {
    await query(`UPDATE alerts SET value = $2, last_evaluated_at = now() WHERE id = $1`, [open.id, ctx.value ?? null]);
    return null;
  }
  const recent = await one(`SELECT 1 FROM alerts WHERE rule_id = $1 AND subject = $2 AND resolved_at > now() - make_interval(secs => $3)`, [rule.id, subject, rule.cooldown_sec]);
  if (recent) return null;
  const a = await one(
    `INSERT INTO alerts (rule_id, project_id, run_id, server_id, type, severity, subject, title, message, value, threshold)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [rule.id, rule.project_id, ctx.runId ?? null, ctx.serverId ?? null, rule.type, rule.severity, subject, ctx.title, ctx.message, ctx.value ?? null, rule.threshold]);
  if (!a) return null;
  await query(`INSERT INTO alert_events (alert_id, kind, details) VALUES ($1,'FIRED',$2)`, [a.id, JSON.stringify({ value: ctx.value, threshold: rule.threshold })]);
  if (ctx.runId) {
    const run = await one(`SELECT project_id, application_id, environment_id FROM test_runs WHERE id = $1`, [ctx.runId]);
    await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, title, description, source, data) VALUES ($1,$2,$3,$4,'ALERT',$5,$6,$7,'alerting',$8)`,
      [run.project_id, run.application_id, run.environment_id, ctx.runId, rule.severity, ctx.title, ctx.message, JSON.stringify({ alertId: a.id })]);
  }
  await enqueue('alert.notify', { alertId: a.id, channelIds: rule.channel_ids, status: 'FIRING' }, { priority: 1 });
  selfMetrics.inc('alerts_fired');
  return a.id;
}

async function resolveIfOpen(rule: any, subject: string) {
  const open = await one(`UPDATE alerts SET status = 'RESOLVED', resolved_at = now() WHERE rule_id = $1 AND subject = $2 AND status <> 'RESOLVED' RETURNING id`, [rule.id, subject]);
  if (open) {
    await query(`INSERT INTO alert_events (alert_id, kind) VALUES ($1,'RESOLVED')`, [open.id]);
    await enqueue('alert.notify', { alertId: open.id, channelIds: rule.channel_ids, status: 'RESOLVED' }, { priority: 1 });
  }
}

/** Periodic evaluation of threshold rules against running tests and infrastructure. */
export async function evaluateLiveAlerts() {
  const rules = await query(`SELECT * FROM alert_rules WHERE enabled AND type IN ('HIGH_RESPONSE_TIME','HIGH_P95','HIGH_P99','LOW_TPS','HIGH_ERROR_RATE','CPU','MEMORY','DISK','JVM_HEAP','GC')`);
  for (const rule of rules) {
    try {
      const f = rule.filters ?? {};
      const from = new Date(Date.now() - rule.window_sec * 1000);
      if (['HIGH_RESPONSE_TIME', 'HIGH_P95', 'HIGH_P99', 'LOW_TPS', 'HIGH_ERROR_RATE'].includes(rule.type)) {
        const runs = await query(
          `SELECT id, run_key FROM test_runs WHERE project_id = $1 AND status = 'RUNNING' AND deleted_at IS NULL
             AND ($2::uuid IS NULL OR environment_id = $2) AND ($3::uuid IS NULL OR test_id = $3)`, [rule.project_id, f.environmentId ?? null, f.testId ?? null]);
        for (const run of runs) {
          const s = await windowStats(run.id, { from, transaction: f.transaction ?? null });
          const subject = `${run.run_key}${f.transaction ? ' / ' + f.transaction : ''}`;
          if (!s || s.totalSamples === 0) continue;
          const v = rule.type === 'HIGH_RESPONSE_TIME' ? s.avgRt : rule.type === 'HIGH_P95' ? s.p95 : rule.type === 'HIGH_P99' ? s.p99 : rule.type === 'LOW_TPS' ? s.tpsAvg : s.errorPct;
          if (v == null) continue;
          if (cmp(rule.operator, v, rule.threshold)) {
            await fire(rule, subject, { runId: run.id, value: v, title: `${rule.name}: ${LABEL[rule.type]} ${round(v, 2)}${UNIT[rule.type]} on ${subject}`, message: `${LABEL[rule.type]} over the last ${rule.window_sec}s is ${round(v, 2)}${UNIT[rule.type]} (threshold ${rule.operator} ${rule.threshold}${UNIT[rule.type]}).` });
          } else await resolveIfOpen(rule, subject);
        }
        // Resolve alerts for runs that are no longer running
        await query(`UPDATE alerts SET status = 'RESOLVED', resolved_at = now() WHERE rule_id = $1 AND status <> 'RESOLVED' AND run_id IN (SELECT id FROM test_runs WHERE status <> 'RUNNING')`, [rule.id]);
      } else {
        const col = rule.type === 'CPU' ? 'cpu_pct' : rule.type === 'MEMORY' ? 'memory_pct' : rule.type === 'DISK' ? 'disk_pct' : null;
        let rows: any[];
        if (col) {
          rows = await query(
            `SELECT s.id server_id, s.name, avg(m.${col}) v, max(m.run_id::text)::uuid run_id FROM server_metrics m JOIN servers s ON s.id = m.server_id
             WHERE s.project_id = $1 AND m.ts >= $2 AND ($3::uuid IS NULL OR s.environment_id = $3) AND ($4::uuid IS NULL OR s.id = $4) GROUP BY s.id, s.name`,
            [rule.project_id, from, f.environmentId ?? null, f.serverId ?? null], tsPool);
        } else {
          const expr = rule.type === 'JVM_HEAP' ? 'max(m.heap_used_mb / NULLIF(m.heap_max_mb,0) * 100)' : 'max(m.gc_max_pause_ms)';
          rows = await query(
            `SELECT s.id server_id, s.name, ${expr} v, max(m.run_id::text)::uuid run_id FROM jvm_metrics m JOIN servers s ON s.id = m.server_id
             WHERE s.project_id = $1 AND m.ts >= $2 AND ($3::uuid IS NULL OR s.environment_id = $3) GROUP BY s.id, s.name`,
            [rule.project_id, from, f.environmentId ?? null], tsPool);
        }
        for (const r of rows) {
          if (r.v == null) continue;
          const v = Number(r.v);
          if (cmp(rule.operator, v, rule.threshold)) {
            await fire(rule, r.name, { serverId: r.server_id, runId: r.run_id, value: v, title: `${rule.name}: ${LABEL[rule.type]} ${round(v, 1)}${UNIT[rule.type]} on ${r.name}`, message: `${LABEL[rule.type]} on ${r.name} over the last ${rule.window_sec}s is ${round(v, 1)}${UNIT[rule.type]} (threshold ${rule.operator} ${rule.threshold}${UNIT[rule.type]}).` });
          } else await resolveIfOpen(rule, r.name);
        }
      }
    } catch (e) {
      console.error(`[alerts] rule ${rule.id} evaluation failed:`, (e as Error).message);
    }
  }
}

/** Alerts triggered by run completion: SLA violation, test failure, regression. */
export async function evaluateRunCompletionAlerts(runId: string, ctx: { status: string; result: string; regressions: RegressionFinding[]; slaViolations: number }) {
  const run = await one(`SELECT id, run_key, project_id, environment_id, test_id FROM test_runs WHERE id = $1`, [runId]);
  const rules = await query(`SELECT * FROM alert_rules WHERE enabled AND project_id = $1 AND type IN ('SLA_VIOLATION','TEST_FAILURE','REGRESSION')`, [run.project_id]);
  for (const rule of rules) {
    const f = rule.filters ?? {};
    if (f.environmentId && f.environmentId !== run.environment_id) continue;
    if (f.testId && f.testId !== run.test_id) continue;
    if (rule.type === 'SLA_VIOLATION' && ctx.slaViolations > 0) {
      await fire(rule, run.run_key, { runId, value: ctx.slaViolations, title: `${rule.name}: ${ctx.slaViolations} SLA violation(s) in ${run.run_key}`, message: `Run ${run.run_key} finished with ${ctx.slaViolations} failed SLA assertion(s). Result: ${ctx.result}.` });
    }
    if (rule.type === 'TEST_FAILURE' && (ctx.status === 'FAILED' || ctx.status === 'ABORTED' || ctx.result === 'FAIL')) {
      await fire(rule, run.run_key, { runId, title: `${rule.name}: ${run.run_key} ${ctx.status === 'COMPLETED' ? 'result FAIL' : ctx.status}`, message: `Run ${run.run_key} finished with status ${ctx.status} and result ${ctx.result}.` });
    }
    const regs = ctx.regressions.filter((r) => r.direction === 'REGRESSION');
    if (rule.type === 'REGRESSION' && regs.length) {
      const worst = [...regs].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))[0];
      await fire(rule, run.run_key, { runId, value: worst.changePct, title: `${rule.name}: ${regs.length} regression(s) in ${run.run_key}`, message: `Largest: ${worst.transaction ?? 'run'} ${worst.metric} ${round(worst.previous, 1)} → ${round(worst.current, 1)} (${round(worst.changePct, 1)}%).` });
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startAlertLoop(intervalMs = 15000) {
  timer ??= setInterval(() => evaluateLiveAlerts().catch((e) => console.error('[alerts] loop', e)), intervalMs);
  timer.unref?.();
}
