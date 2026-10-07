import { one, query, tsPool } from '../db/pool.js';
import { linearRegression, round } from '../lib/stats.js';
import { Conds } from '../lib/scope.js';

/**
 * Capacity planning. Everything here is an ESTIMATE derived from measured runs and stated
 * assumptions (Utilization Law, M/M/1-style queueing growth, fitted latency-vs-load curves).
 * Results are always labelled as estimates with a confidence level — never as certainties.
 */

export interface Observation { runKey: string; users: number | null; tps: number | null; p95: number | null; cpuAvg: number | null }
export interface LatencyFit { type: 'linear' | 'exponential'; a: number; b: number; r2: number; n: number; minTps: number; maxTps: number; predict: (tps: number) => number }

/** r² in the original (not log) space so linear and exponential fits are comparable. */
function r2Of(xs: number[], ys: number[], f: (x: number) => number) {
  const m = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssRes = 0, ssTot = 0;
  xs.forEach((x, i) => { ssRes += (ys[i] - f(x)) ** 2; ssTot += (ys[i] - m) ** 2; });
  return ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

/** Fit P95 = a + b·TPS (linear) or P95 = e^(a + b·TPS) (exponential); returns null when the data cannot support a fit. */
export function fitLatencyModel(obs: Observation[]): { fit: LatencyFit | null; reason: string | null } {
  const pts = obs.filter((o) => o.tps != null && o.p95 != null && o.tps > 0 && o.p95 > 0) as { tps: number; p95: number }[];
  if (pts.length < 3) return { fit: null, reason: `Only ${pts.length} completed run(s) with both TPS and P95 — at least 3 runs at different load levels are needed.` };
  const xs = pts.map((p) => p.tps);
  const ys = pts.map((p) => p.p95);
  const minTps = Math.min(...xs);
  const maxTps = Math.max(...xs);
  const distinct = new Set(xs.map((x) => Math.round(x * 10))).size;
  if (distinct < 3 || maxTps / minTps < 1.2) return { fit: null, reason: 'Runs were executed at similar load levels (TPS range < 20%) — a latency-vs-load curve cannot be fitted. Run a step/stress test at several load levels.' };
  const lin = linearRegression(xs, ys);
  const log = linearRegression(xs, ys.map((y) => Math.log(y)));
  const candidates: LatencyFit[] = [];
  if (lin) candidates.push({ type: 'linear', a: lin.intercept, b: lin.slope, r2: r2Of(xs, ys, lin.predict), n: pts.length, minTps, maxTps, predict: lin.predict });
  if (log && log.slope > 0) {
    const f = (x: number) => Math.exp(log.intercept + log.slope * x);
    candidates.push({ type: 'exponential', a: log.intercept, b: log.slope, r2: r2Of(xs, ys, f), n: pts.length, minTps, maxTps, predict: f });
  }
  if (!candidates.length) return { fit: null, reason: 'Latency does not vary with load in the recorded runs.' };
  // Prefer the simpler linear model unless the exponential one is clearly better.
  const linFit = candidates.find((c) => c.type === 'linear');
  const expFit = candidates.find((c) => c.type === 'exponential');
  const best = linFit && expFit ? (expFit.r2 >= linFit.r2 + 0.02 ? expFit : linFit) : (linFit ?? expFit)!;
  return { fit: best, reason: null };
}

export function describeFit(f: LatencyFit) {
  const eq = f.type === 'linear'
    ? `P95 ≈ ${round(f.a, 1)} ${f.b >= 0 ? '+' : '−'} ${round(Math.abs(f.b), 3)} × TPS`
    : `P95 ≈ e^(${round(f.a, 3)} + ${round(f.b, 5)} × TPS)`;
  const quality = f.r2 >= 0.8 ? 'good fit' : f.r2 >= 0.5 ? 'moderate fit' : 'weak fit — treat projections with caution';
  return `${eq} (${f.type}, R² ${round(f.r2, 2)}, ${quality}; ${f.n} runs, TPS ${round(f.minTps, 1)}–${round(f.maxTps, 1)})`;
}

/** P95 SLA threshold of a test (RUN-scope p95 rule: critical, else warning). */
export async function testSlaP95(testId: string): Promise<number | null> {
  const r = await one(
    `SELECT COALESCE(sr.critical_value, sr.warning_value) AS v FROM performance_tests t JOIN sla_rules sr ON sr.profile_id = t.sla_profile_id
     WHERE t.id = $1 AND sr.metric = 'p95' AND sr.scope = 'RUN' AND sr.enabled ORDER BY sr.position LIMIT 1`, [testId]);
  return r?.v == null ? null : Number(r.v);
}

export async function capacityModel(opts: { orgId: string; projectId?: string | null; testId?: string | null; environmentId?: string | null }) {
  const c = new Conds([opts.orgId]);
  c.raw('r.organization_id = $1').raw('r.deleted_at IS NULL').raw(`r.status = 'COMPLETED'`);
  if (opts.projectId) c.add('r.project_id = ?', opts.projectId);
  if (opts.testId) c.add('r.test_id = ?', opts.testId);
  if (opts.environmentId) c.add('r.environment_id = ?', opts.environmentId);
  const rows = await query(
    `SELECT r.id, r.run_key, r.virtual_users, r.analysis, COALESCE(r.started_at, r.created_at) AS started_at, s.users_peak, s.tps_avg, s.p95, s.percentile_method
     FROM test_runs r
     LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id
                        ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END LIMIT 1) s ON true
     WHERE ${c.where()} ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 100`, c.params);
  rows.reverse();
  const cpu = rows.length
    ? await query(`SELECT sm.run_id, avg(sm.cpu_pct) cpu FROM server_metrics sm JOIN servers s ON s.id = sm.server_id WHERE sm.run_id = ANY($1::uuid[]) AND coalesce(s.role,'') <> 'loadgen' GROUP BY 1`, [rows.map((r) => r.id)], tsPool)
    : [];
  const cpuBy = new Map(cpu.map((x) => [x.run_id, x.cpu == null ? null : Number(x.cpu)]));
  const observations: Observation[] = rows.map((r) => ({
    runKey: r.run_key, users: r.users_peak ?? r.virtual_users ?? null, tps: r.tps_avg ?? null, p95: r.p95 ?? null, cpuAvg: cpuBy.get(r.id) ?? null,
  }));
  const notes: string[] = ['All capacity figures are estimates based on measured runs and the stated model; validate them with a load test at the target level.'];
  if (!rows.length) notes.push('No completed runs match the selection.');
  if (rows.some((r) => r.percentile_method === 'interval_weighted_approx')) notes.push('Some runs report approximate P95 values (interval-reported percentiles); the fit inherits that uncertainty.');

  const { fit, reason } = fitLatencyModel(observations);
  if (reason) notes.push(reason);
  const model = fit
    ? { type: fit.type, r2: round(fit.r2, 3), description: describeFit(fit) }
    : { type: 'insufficient' as const, r2: null, description: reason ?? 'Insufficient data' };

  // Saturation candidates (each one an estimate)
  const candidates: { tps: number; why: string }[] = [];
  for (const r of rows) {
    const sat = r.analysis?.saturation;
    if (sat?.detected && sat.atTps != null) candidates.push({ tps: Number(sat.atTps), why: `throughput plateau observed in run ${r.run_key} at ≈${round(sat.atTps, 1)} TPS` });
  }
  const slaP95 = opts.testId ? await testSlaP95(opts.testId) : null;
  if (fit && fit.r2 >= 0.5 && fit.b > 0 && slaP95) {
    const at = fit.type === 'linear' ? (slaP95 - fit.a) / fit.b : (Math.log(slaP95) - fit.a) / fit.b;
    if (Number.isFinite(at) && at > 0) {
      candidates.push({ tps: at, why: `fitted model reaches the P95 SLA (${slaP95} ms) at ≈${round(at, 1)} TPS${at > fit.maxTps * 1.25 ? ' (extrapolated beyond the measured range)' : ''}` });
    }
  }
  const cpuPts = observations.filter((o) => o.tps != null && o.cpuAvg != null) as { tps: number; cpuAvg: number }[];
  if (cpuPts.length >= 3) {
    const cf = linearRegression(cpuPts.map((p) => p.tps), cpuPts.map((p) => p.cpuAvg));
    if (cf && cf.slope > 0 && cf.r2 >= 0.5) {
      const at = (85 - cf.intercept) / cf.slope;
      if (Number.isFinite(at) && at > 0) candidates.push({ tps: at, why: `CPU trend (R² ${round(cf.r2, 2)}) reaches 85% at ≈${round(at, 1)} TPS (Utilization Law, linear CPU growth assumed)` });
    }
  } else if (cpuPts.length) notes.push('Too few runs with infrastructure metrics to estimate CPU-bound capacity.');
  let estimatedSaturationTps: number | null = null;
  if (candidates.length) {
    const best = candidates.reduce((a, b) => (b.tps < a.tps ? b : a));
    estimatedSaturationTps = round(best.tps, 1);
    notes.push(`Estimated saturation ≈${estimatedSaturationTps} TPS — the lowest of: ${candidates.map((x) => x.why).join('; ')}.`);
  } else notes.push('No saturation point could be estimated from the available runs.');
  return { observations, model, estimatedSaturationTps, notes, fit, slaP95 };
}

export interface ProjectionInput {
  testId?: string; currentTps: number; targetTps: number; currentUsers?: number; targetUsers?: number; currentP95: number; slaP95?: number; currentCpu?: number;
}

const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
type Level = (typeof LEVELS)[number];
const down = (l: Level): Level => LEVELS[Math.max(0, LEVELS.indexOf(l) - 1)];

/** Project latency / CPU / users at a target load. Always returns a labelled estimate with assumptions and confidence. */
export function projectCapacity(input: ProjectionInput, fit: LatencyFit | null, slaFromTest: number | null) {
  const assumptions: string[] = [];
  const { currentTps: x0, targetTps: x1, currentP95: r0 } = input;
  const sla = input.slaP95 ?? slaFromTest ?? null;
  if (input.slaP95 == null && slaFromTest != null) assumptions.push(`P95 SLA of ${slaFromTest} ms taken from the test's SLA profile.`);
  const scale = x1 / x0;

  // Latency model
  const useFit = !!fit && fit.r2 >= 0.5 && fit.b > 0 && fit.predict(x0) > 0;
  const u0 = input.currentCpu != null && input.currentCpu > 0 && input.currentCpu < 100 ? input.currentCpu / 100 : null;
  const demand = u0 != null ? u0 / x0 : null; // CPU-seconds per transaction (normalised), Utilization Law U = X·D
  let method: string;
  let p95At: (x: number) => number | null;
  let confidence: Level;
  if (useFit) {
    const base = fit!.predict(x0);
    p95At = (x) => { const v = fit!.predict(x); return v > 0 ? (r0 * v) / base : null; };
    method = `Fitted ${fit!.type} latency-vs-throughput model from ${fit!.n} completed runs, anchored to the current P95`;
    confidence = fit!.r2 >= 0.8 && fit!.n >= 5 ? 'HIGH' : 'MEDIUM';
    assumptions.push(`Latency follows the fitted ${fit!.type} curve (R² ${round(fit!.r2, 2)}) measured between ${round(fit!.minTps, 1)} and ${round(fit!.maxTps, 1)} TPS.`);
    if (x1 > fit!.maxTps * 1.25) { confidence = down(confidence); assumptions.push(`Target TPS is beyond the measured range (max ${round(fit!.maxTps, 1)} TPS) — extrapolation lowers confidence.`); }
    if (demand != null) {
      const sat = 1 / demand;
      const base2 = p95At;
      p95At = (x) => (x * demand >= 0.98 ? null : base2(x));
      assumptions.push(`CPU saturation (100%) expected near ${round(sat, 1)} TPS; projections beyond that are not meaningful.`);
    }
  } else if (demand != null) {
    p95At = (x) => { const u = x * demand; return u >= 0.98 ? null : (r0 * (1 - u0!)) / (1 - u); };
    method = 'Utilization Law (U = X·D) with M/M/1-style queueing growth R ∝ 1/(1−U)';
    const u1 = x1 * demand;
    confidence = scale <= 1.5 && u1 <= 0.7 ? 'MEDIUM' : 'LOW';
    assumptions.push('CPU is the dominant bottleneck and CPU demand per transaction stays constant as load grows.');
    assumptions.push('Response time grows with utilisation like a single-queue system; real systems with other bottlenecks (DB, pools, locks) may degrade earlier.');
    if (fit === null) assumptions.push('No fitted latency model is available (fewer than 3 runs at different load levels).');
  } else {
    p95At = () => null;
    method = 'Linear throughput scaling only (no CPU data or fitted latency model)';
    confidence = 'LOW';
    assumptions.push('Latency cannot be projected without CPU utilisation or at least 3 runs at different load levels.');
  }
  if (scale > 2) { confidence = down(confidence); assumptions.push(`Target is ${round(scale, 1)}× the current load — large extrapolations are uncertain.`); }

  const p95 = p95At(x1);
  let cpuPct: number | null = null;
  if (input.currentCpu != null) {
    const raw = input.currentCpu * scale;
    cpuPct = Math.min(100, raw);
    assumptions.push(`CPU scales linearly with throughput (Utilization Law): ${round(input.currentCpu, 1)}% × ${round(scale, 2)}${raw > 100 ? ` = ${round(raw, 0)}% — exceeds capacity, more CPU or instances are required` : ''}.`);
  }
  let users: number | null = null;
  let tpsPerUser: number | null = null;
  if (input.currentUsers && input.currentUsers > 0) {
    tpsPerUser = x0 / input.currentUsers;
    users = input.targetUsers ?? Math.ceil(x1 / tpsPerUser);
    assumptions.push(`Per-user throughput stays at ${round(tpsPerUser, 3)} TPS/user (same think time; if response time grows, more users are needed — Little's Law).`);
    if (input.targetUsers) {
      const implied = input.targetUsers * tpsPerUser;
      if (Math.abs(implied - x1) / x1 > 0.1) assumptions.push(`${input.targetUsers} users at the current per-user rate would generate ≈${round(implied, 1)} TPS, not ${x1} TPS.`);
    }
  } else if (input.targetUsers) users = input.targetUsers;

  if (p95 == null && demand != null && x1 * demand >= 0.98) assumptions.push('The target load would saturate the CPU — latency is unbounded at this level.');
  const saturated = demand != null && x1 * demand >= 0.98;
  if (saturated && confidence === 'HIGH') confidence = 'MEDIUM';
  const meetsSla = sla == null ? null : saturated ? false : p95 == null ? null : p95 <= sla;
  let headroomPct: number | null = null;
  if (sla != null && p95 != null) { headroomPct = ((sla - p95) / sla) * 100; assumptions.push('Headroom is the margin between the projected P95 and the P95 SLA.'); }
  else if (cpuPct != null) { headroomPct = 100 - cpuPct; assumptions.push('Headroom is the remaining CPU capacity (no P95 SLA available).'); }

  const curve: { tps: number; p95: number }[] = [];
  const lo = Math.min(x0, x1) * 0.5;
  const hi = Math.max(x0, x1) * 1.2;
  for (let i = 0; i <= 24; i++) {
    const x = lo + ((hi - lo) * i) / 24;
    const v = p95At(x);
    if (v == null) break;
    curve.push({ tps: round(x, 2)!, p95: round(v, 1)! });
  }
  return {
    label: 'Estimate' as const, method, confidence,
    projected: { p95: round(p95, 1), cpuPct: round(cpuPct, 1), users, tpsPerUser: round(tpsPerUser, 4) },
    meetsSla, headroomPct: round(headroomPct, 1), assumptions, curve,
  };
}
