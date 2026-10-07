import { query, tsPool } from '../db/pool.js';
import { linearRegression, mean, pctChange, round } from '../lib/stats.js';
import { Conds } from '../lib/scope.js';

/**
 * Cross-run trends. One point per completed run (groupBy=date) or per build / release
 * (latest completed run of that build/release, per test+environment). Degradation is
 * evaluated per metric and per test+environment, in build/release/date order, using an
 * OLS slope over the step index plus the count of consecutive worsening steps.
 */
export type TrendGroupBy = 'build' | 'release' | 'date';
export type TrendMetric = 'p95' | 'p99' | 'avgRt' | 'tps' | 'errorPct' | 'cpuAvg' | 'slaPassPct' | 'score';

export const TREND_METRICS: Record<TrendMetric, { label: string; better: 'lower' | 'higher'; unit: string; absolute: boolean }> = {
  p95: { label: 'P95', better: 'lower', unit: 'ms', absolute: false },
  p99: { label: 'P99', better: 'lower', unit: 'ms', absolute: false },
  avgRt: { label: 'Average response time', better: 'lower', unit: 'ms', absolute: false },
  tps: { label: 'Throughput (TPS)', better: 'higher', unit: 'tps', absolute: false },
  errorPct: { label: 'Error rate', better: 'lower', unit: '%', absolute: true },
  cpuAvg: { label: 'CPU average', better: 'lower', unit: '%', absolute: true },
  slaPassPct: { label: 'SLA compliance', better: 'higher', unit: '%', absolute: true },
  score: { label: 'Performance score', better: 'higher', unit: '', absolute: true },
};

export interface TrendPoint {
  key: string; label: string; runKey: string; runId: string; startedAt: string; buildNumber: string | null; releaseVersion: string | null;
  metrics: Record<TrendMetric, number | null>;
  testId: string; testName: string; environmentId: string; environmentName: string;
}

export interface Degradation {
  metric: string; direction: 'DEGRADING' | 'IMPROVING' | 'STABLE'; slopePerStep: number; r2: number; consecutiveWorse: number;
  changePct: number | null; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string;
  testId?: string; testName?: string; environmentName?: string;
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function loadTrend(opts: {
  orgId: string; projectId?: string | null; testId?: string | null; environmentId?: string | null; applicationId?: string | null;
  groupBy: TrendGroupBy; from?: Date; to?: Date; limit?: number;
}) {
  const c = new Conds([opts.orgId]);
  c.raw('r.organization_id = $1').raw('r.deleted_at IS NULL').raw(`r.status = 'COMPLETED'`);
  if (opts.projectId) c.add('r.project_id = ?', opts.projectId);
  if (opts.testId) c.add('r.test_id = ?', opts.testId);
  if (opts.environmentId) c.add('r.environment_id = ?', opts.environmentId);
  if (opts.applicationId) c.add('r.application_id = ?', opts.applicationId);
  if (opts.from) c.add('COALESCE(r.started_at, r.created_at) >= ?', opts.from);
  if (opts.to) c.add('COALESCE(r.started_at, r.created_at) <= ?', opts.to);
  const limit = c.param(Math.min(opts.limit ?? 500, 2000));
  const rows = await query(
    `SELECT * FROM (
       SELECT r.id, r.run_key, COALESCE(r.started_at, r.created_at) AS started_at, r.build_number, r.version, r.test_id, r.environment_id, r.performance_score,
              t.name AS test_name, e.name AS environment_name, rel.version AS release_version, COALESCE(rel.deployment_date, rel.created_at) AS release_at,
              s.p95, s.p99, s.avg_rt, s.tps_avg, s.error_pct, s.sla_pass_pct
       FROM test_runs r
       JOIN performance_tests t ON t.id = r.test_id
       JOIN environments e ON e.id = r.environment_id
       LEFT JOIN releases rel ON rel.id = r.release_id
       LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id
                          ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END LIMIT 1) s ON true
       WHERE ${c.where()}
       ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT ${limit}) x
     ORDER BY started_at ASC`, c.params);

  const cpu = rows.length
    ? await query(
      `SELECT sm.run_id, avg(sm.cpu_pct) AS cpu FROM server_metrics sm JOIN servers s ON s.id = sm.server_id
       WHERE sm.run_id = ANY($1::uuid[]) AND coalesce(s.role,'') <> 'loadgen' GROUP BY sm.run_id`, [rows.map((r) => r.id)], tsPool)
    : [];
  const cpuBy = new Map(cpu.map((x) => [x.run_id, x.cpu == null ? null : Number(x.cpu)]));
  const combos = new Set(rows.map((r) => `${r.test_id}|${r.environment_id}`));
  const multi = combos.size > 1;

  type Row = (typeof rows)[number];
  const toPoint = (r: Row, key: string, label: string): TrendPoint => ({
    key, label: multi ? `${label} · ${r.test_name}` : label, runKey: r.run_key, runId: r.id, startedAt: new Date(r.started_at).toISOString(),
    buildNumber: r.build_number ?? null, releaseVersion: r.release_version ?? r.version ?? null,
    metrics: {
      p95: r.p95 ?? null, p99: r.p99 ?? null, avgRt: r.avg_rt ?? null, tps: r.tps_avg ?? null, errorPct: r.error_pct ?? null,
      cpuAvg: cpuBy.get(r.id) ?? null, slaPassPct: r.sla_pass_pct ?? null, score: r.performance_score ?? null,
    },
    testId: r.test_id, testName: r.test_name, environmentId: r.environment_id, environmentName: r.environment_name,
  });

  let points: TrendPoint[];
  if (opts.groupBy === 'date') {
    points = rows.map((r) => toPoint(r, r.run_key, new Date(r.started_at).toISOString().slice(0, 16).replace('T', ' ')));
  } else {
    // latest completed run per (test, environment, build|release); runs without a build/release are excluded
    const groups = new Map<string, { key: string; first: Row; latest: Row; order: number }>();
    for (const r of rows) {
      const key = opts.groupBy === 'build' ? r.build_number : r.release_version ?? r.version;
      if (!key) continue;
      const gk = `${r.test_id}|${r.environment_id}|${key}`;
      const g = groups.get(gk);
      const relOrder = opts.groupBy === 'release' && r.release_at ? new Date(r.release_at).getTime() : new Date(r.started_at).getTime();
      if (!g) groups.set(gk, { key, first: r, latest: r, order: relOrder });
      else g.latest = r; // rows are chronological
    }
    const list = [...groups.values()];
    const allNumeric = list.every((g) => /^\d+(\.\d+)*$/.test(g.key));
    list.sort((a, b) => (opts.groupBy === 'build' && allNumeric ? natural.compare(a.key, b.key) : a.order - b.order) || a.order - b.order);
    points = list.map((g) => toPoint(g.latest, g.key, opts.groupBy === 'build' ? `Build ${g.key}` : g.key));
  }

  // Degradation per test+environment
  const degradation: Degradation[] = [];
  const byCombo = new Map<string, TrendPoint[]>();
  for (const p of points) {
    const k = `${p.testId}|${p.environmentId}`;
    const arr = byCombo.get(k) ?? [];
    arr.push(p);
    byCombo.set(k, arr);
  }
  const stepNoun = opts.groupBy === 'build' ? 'build' : opts.groupBy === 'release' ? 'release' : 'run';
  for (const pts of byCombo.values()) {
    for (const d of detectDegradation(pts, stepNoun)) {
      degradation.push(multi ? { ...d, testId: pts[0].testId, testName: pts[0].testName, environmentName: pts[0].environmentName, message: `${pts[0].testName} (${pts[0].environmentName}): ${d.message}` } : d);
    }
  }
  const sevRank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  const dirRank = { DEGRADING: 0, IMPROVING: 1, STABLE: 2 } as const;
  degradation.sort((a, b) => dirRank[a.direction] - dirRank[b.direction] || sevRank[a.severity] - sevRank[b.severity]);
  return { groupBy: opts.groupBy, points, degradation };
}

/** Per-metric degradation over an ordered series of points (same test+environment). */
export function detectDegradation(points: { runKey: string; label: string; metrics: Record<string, number | null> }[], stepNoun = 'run'): Degradation[] {
  const out: Degradation[] = [];
  for (const [metric, def] of Object.entries(TREND_METRICS) as [TrendMetric, (typeof TREND_METRICS)[TrendMetric]][]) {
    const pts = points.map((p, i) => ({ i, v: p.metrics[metric], p })).filter((x): x is { i: number; v: number; p: (typeof points)[number] } => x.v != null && Number.isFinite(x.v));
    if (pts.length < 3) continue;
    const reg = linearRegression(pts.map((x) => x.i), pts.map((x) => x.v));
    if (!reg) continue;
    const worseSign = def.better === 'lower' ? 1 : -1; // positive delta * worseSign => worse
    const tol = (prev: number) => (def.absolute ? (metric === 'errorPct' ? 0.05 : 0.5) : Math.max(Math.abs(prev) * 0.01, 1e-9));
    let consecutiveWorse = 0;
    for (let k = pts.length - 1; k > 0; k--) {
      const delta = (pts[k].v - pts[k - 1].v) * worseSign;
      if (delta > tol(pts[k - 1].v)) consecutiveWorse++;
      else break;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const changePct = pctChange(first.v, last.v);
    const totalDelta = last.v - first.v;
    const significant = def.absolute
      ? Math.abs(totalDelta) >= (metric === 'errorPct' ? 0.5 : metric === 'score' ? 5 : 2)
      : changePct != null && Math.abs(changePct) >= 5;
    const trendWorse = reg.slope * worseSign > 0;
    const strongFit = reg.r2 >= 0.5;
    let direction: Degradation['direction'] = 'STABLE';
    if ((trendWorse && strongFit && significant && totalDelta * worseSign > 0) || consecutiveWorse >= 3) direction = 'DEGRADING';
    else if (!trendWorse && reg.slope !== 0 && strongFit && significant && totalDelta * worseSign < 0) direction = 'IMPROVING';

    let severity: Degradation['severity'] = 'INFO';
    if (direction === 'DEGRADING') {
      const big = def.absolute ? Math.abs(totalDelta) >= (metric === 'errorPct' ? 2 : metric === 'score' ? 15 : 10) : changePct != null && Math.abs(changePct) >= 25;
      severity = consecutiveWorse >= 4 || big ? 'CRITICAL' : 'WARNING';
    }
    const m = mean(pts.map((x) => x.v));
    const fmt = (v: number) => `${round(v, def.unit === 'ms' ? 0 : 2)}${def.unit === 'ms' ? ' ms' : def.unit === '%' ? '%' : def.unit === 'tps' ? ' TPS' : ''}`;
    const changeText = def.absolute
      ? `${totalDelta >= 0 ? '+' : ''}${round(totalDelta, 2)}${def.unit === '%' ? ' pts' : ''}`
      : changePct != null ? `${changePct >= 0 ? '+' : ''}${round(changePct, 1)}%` : 'n/a';
    const perStep = m ? `${reg.slope >= 0 ? '+' : ''}${round((reg.slope / Math.abs(m)) * 100, 1)}% per ${stepNoun}` : `${round(reg.slope, 2)} per ${stepNoun}`;
    let message: string;
    if (direction === 'DEGRADING') {
      message = `${def.label} is degrading: ${fmt(first.v)} (${first.p.label}) → ${fmt(last.v)} (${last.p.label}), ${changeText}; trend ${perStep} (R² ${round(reg.r2, 2)})`
        + (consecutiveWorse ? `, worse in ${consecutiveWorse} consecutive ${stepNoun}${consecutiveWorse > 1 ? 's' : ''}.` : '.');
    } else if (direction === 'IMPROVING') {
      message = `${def.label} is improving: ${fmt(first.v)} → ${fmt(last.v)} (${changeText}); trend ${perStep} (R² ${round(reg.r2, 2)}).`;
    } else {
      message = `${def.label} is stable across ${pts.length} ${stepNoun}s (${changeText} overall, R² ${round(reg.r2, 2)}).`;
    }
    out.push({ metric, direction, slopePerStep: round(reg.slope, 4) ?? 0, r2: round(reg.r2, 3) ?? 0, consecutiveWorse, changePct: round(changePct, 2), severity, message });
  }
  return out;
}
