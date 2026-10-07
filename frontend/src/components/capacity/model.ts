/**
 * Capacity planning types + small client-side helpers.
 * Shapes mirror backend/src/analytics/capacity.ts (GET /capacity/model, POST /capacity/project).
 * Everything derived here is an ESTIMATE and is labelled as such in the UI.
 */

export interface Observation { runKey: string; users: number | null; tps: number | null; p95: number | null; cpuAvg: number | null }
export interface FitParams { type: 'linear' | 'exponential'; a: number; b: number; r2: number; n: number; minTps: number; maxTps: number }
export interface CapacityModel {
  observations: Observation[];
  model: { type: 'linear' | 'exponential' | 'insufficient'; r2: number | null; description: string };
  estimatedSaturationTps: number | null;
  notes: string[];
  /** present on newer backends (fitted coefficients); otherwise refitted client-side */
  fit?: FitParams | null;
  slaP95?: number | null;
}
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export interface Projection {
  label: 'Estimate'; method: string; confidence: Confidence;
  projected: { p95: number | null; cpuPct: number | null; users: number | null; tpsPerUser: number | null };
  meetsSla: boolean | null; headroomPct: number | null; assumptions: string[]; curve: { tps: number; p95: number }[];
}
export interface ProjectionInput {
  testId?: string; currentTps: number; targetTps: number; currentUsers?: number; targetUsers?: number; currentP95: number; slaP95?: number; currentCpu?: number;
}

/** Least squares, identical to backend lib/stats linearRegression. */
export function linReg(xs: number[], ys: number[]) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  return { slope, intercept, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy), predict: (x: number) => intercept + slope * x };
}

/** Fitted parameters: from the API when available, else refit the model type the API chose (same data → same curve). */
export function resolveFit(m: CapacityModel | undefined): FitParams | null {
  if (!m) return null;
  if (m.fit) return m.fit;
  if (m.model.type === 'insufficient') return null;
  const pts = m.observations.filter((o) => o.tps != null && o.p95 != null && o.tps > 0 && o.p95 > 0) as { tps: number; p95: number }[];
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p.tps);
  const ys = m.model.type === 'exponential' ? pts.map((p) => Math.log(p.p95)) : pts.map((p) => p.p95);
  const r = linReg(xs, ys);
  if (!r) return null;
  return { type: m.model.type, a: r.intercept, b: r.slope, r2: m.model.r2 ?? r.r2, n: pts.length, minTps: Math.min(...xs), maxTps: Math.max(...xs) };
}

export const predictP95 = (f: FitParams, tps: number) => (f.type === 'linear' ? f.a + f.b * tps : Math.exp(f.a + f.b * tps));

/** Sample the fitted curve over [lo, hi]; drops non-positive predictions. */
export function fitCurve(f: FitParams, lo: number, hi: number, steps = 40): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const x = lo + ((hi - lo) * i) / steps;
    const y = predictP95(f, x);
    if (Number.isFinite(y) && y > 0) out.push([+x.toFixed(3), +y.toFixed(1)]);
  }
  return out;
}

/**
 * Error-rate estimate at a target TPS (the backend projection has no error model).
 * Linear trend of run error % vs TPS when the runs support it, else the nearest measured run.
 */
export function estimateErrorPct(pts: { tps: number; errorPct: number }[], targetTps: number): { value: number | null; confidence: Confidence; method: string } {
  if (!pts.length) return { value: null, confidence: 'LOW', method: 'No completed runs with an error rate.' };
  const xs = pts.map((p) => p.tps);
  const spread = Math.max(...xs) / Math.max(1e-9, Math.min(...xs));
  const r = pts.length >= 3 && spread >= 1.2 ? linReg(xs, pts.map((p) => p.errorPct)) : null;
  if (r && r.r2 >= 0.3) {
    const beyond = targetTps > Math.max(...xs) * 1.25;
    const conf: Confidence = r.r2 >= 0.7 && pts.length >= 5 && !beyond ? 'MEDIUM' : 'LOW';
    return { value: Math.min(100, Math.max(0, r.predict(targetTps))), confidence: conf, method: `Linear trend of run error % vs TPS (R² ${r.r2.toFixed(2)}, ${pts.length} runs)${beyond ? ', extrapolated beyond the measured range' : ''}.` };
  }
  const nearest = pts.reduce((a, b) => (Math.abs(b.tps - targetTps) < Math.abs(a.tps - targetTps) ? b : a));
  return { value: nearest.errorPct, confidence: 'LOW', method: `No reliable error-vs-load trend — showing the error rate of the run closest in load (${nearest.tps.toFixed(1)} TPS).` };
}

/** P95 / error SLA from the test's SLA profile (RUN scope; critical value, else warning — same rule as the backend). */
export function slaFromProfile(rules: { metric: string; scope: string; enabled: boolean; position: number; warning_value: number | null; critical_value: number | null }[] | undefined, metric: string): number | null {
  const r = (rules ?? []).filter((x) => x.metric === metric && x.scope === 'RUN' && x.enabled).sort((a, b) => a.position - b.position)[0];
  const v = r ? r.critical_value ?? r.warning_value : null;
  return v == null ? null : Number(v);
}
