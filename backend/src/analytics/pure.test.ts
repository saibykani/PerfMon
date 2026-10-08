import { describe, expect, it } from 'vitest';
import { SLA_METRICS, evaluate } from './sla.js';
import { classifyResult, performanceScore } from './score.js';
import { confidenceLabel } from './bottleneck.js';
import { describeFit, fitLatencyModel, projectCapacity, type Observation } from './capacity.js';
import { detectDegradation } from './trends.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { InfraAggregates } from './summary.js';
import type { RegressionFinding } from './regression.js';

const infra = (over: Partial<InfraAggregates> = {}): InfraAggregates => ({
  hasServer: false, cpuAvg: null, cpuMax: null, cpuP90: null, memAvg: null, memMax: null, diskMax: null, netAvgBps: null, loadMax: null,
  hasLoadgen: false, loadgenCpuMax: null, loadgenCpuP90: null,
  hasJvm: false, heapPctMax: null, heapPctAvg: null, gcPauseMax: null, gcTimeAvg: null, threadsMax: null,
  hasDb: false, dbLatencyAvg: null, dbLatencyMax: null, dbActiveMax: null, dbPoolPctMax: null, dbSlowQueries: null, dbLocksMax: null, dbCpuAvg: null,
  ...over,
});

const reg = (severity: RegressionFinding['severity'], direction: RegressionFinding['direction'] = 'REGRESSION'): RegressionFinding => ({
  scope: 'RUN', transaction: null, metric: 'p95', previous: 100, current: 130, changePct: 30, thresholdPct: 10, direction, severity,
});

describe('SLA evaluate', () => {
  it('LOWER-is-better metrics breach at or above the threshold', () => {
    expect(evaluate(100, 'LOWER', 200, 300)).toBe('PASS');
    expect(evaluate(200, 'LOWER', 200, 300)).toBe('WARNING');
    expect(evaluate(299.9, 'LOWER', 200, 300)).toBe('WARNING');
    expect(evaluate(300, 'LOWER', 200, 300)).toBe('FAIL');
  });

  it('HIGHER-is-better metrics breach strictly below the threshold', () => {
    expect(evaluate(100, 'HIGHER', 80, 50)).toBe('PASS');
    expect(evaluate(80, 'HIGHER', 80, 50)).toBe('PASS');
    expect(evaluate(79, 'HIGHER', 80, 50)).toBe('WARNING');
    expect(evaluate(49, 'HIGHER', 80, 50)).toBe('FAIL');
  });

  it('works with only one threshold and reports NO_DATA for missing values', () => {
    expect(evaluate(500, 'LOWER', null, 400)).toBe('FAIL');
    expect(evaluate(500, 'LOWER', 400, null)).toBe('WARNING');
    expect(evaluate(500, 'LOWER', null, null)).toBe('PASS');
    expect(evaluate(null, 'LOWER', 1, 2)).toBe('NO_DATA');
    expect(evaluate(undefined, 'LOWER', 1, 2)).toBe('NO_DATA');
    expect(evaluate(NaN, 'LOWER', 1, 2)).toBe('NO_DATA');
  });

  it('declares a direction for every SLA metric (only TPS is higher-is-better)', () => {
    expect(Object.entries(SLA_METRICS).filter(([, m]) => m.direction === 'HIGHER').map(([k]) => k)).toEqual(['tps']);
  });
});

describe('performanceScore', () => {
  const W = DEFAULT_SETTINGS.score_weights;
  const base = { summary: { p95: 200, tps_avg: 100, error_pct: 0 }, slaPassPct: 100, p95Target: 300, targetTps: 100, baselineTps: null, infra: infra({ cpuP90: 50, memMax: 60 }), regressions: [], hasBaseline: true };

  it('scores a perfect run 100 and returns every factor', () => {
    const r = performanceScore(W, base);
    expect(r.score).toBe(100);
    expect(r.factors.map((f) => f.key)).toEqual(['sla', 'responseTime', 'throughput', 'errorRate', 'infrastructure', 'regression']);
  });

  it('applies the documented per-factor formulas', () => {
    const r = performanceScore(W, {
      ...base, summary: { p95: 450, tps_avg: 80, error_pct: 2 }, slaPassPct: 50,
      infra: infra({ cpuP90: 85, memMax: 90 }), regressions: [reg('CRITICAL'), reg('WARNING'), reg('INFO', 'IMPROVEMENT')],
    });
    const f = Object.fromEntries(r.factors.map((x) => [x.key, x.score]));
    expect(f.sla).toBe(50);
    expect(f.responseTime).toBeCloseTo(50);          // 50% over target
    expect(f.throughput).toBeCloseTo(80);            // 80 / 100 TPS
    expect(f.errorRate).toBeCloseTo(60);             // 100 - 2*20
    expect(f.infrastructure).toBeCloseTo(50);        // min(cpu 100-15*3.33, mem 100-10*5)
    expect(f.regression).toBe(65);                   // 100 - 25 - 10
    const expected = (50 * 30 + 50 * 20 + 80 * 15 + 60 * 15 + 50 * 10 + 65 * 10) / 100;
    expect(r.score).toBe(Math.round(expected));
  });

  it('excludes factors without data and renormalises the weights', () => {
    const r = performanceScore(W, { summary: { p95: 100, tps_avg: 10, error_pct: 5 }, slaPassPct: null, p95Target: null, targetTps: null, baselineTps: null, infra: infra(), regressions: [], hasBaseline: false });
    expect(r.factors.filter((f) => f.score != null).map((f) => f.key)).toEqual(['errorRate']);
    expect(r.score).toBe(0); // 5% errors → 0
  });

  it('uses the baseline TPS when there is no target and clamps to 0..100', () => {
    const r = performanceScore(W, { ...base, targetTps: null, baselineTps: 50, summary: { p95: 100, tps_avg: 200, error_pct: 0 } });
    const tp = r.factors.find((f) => f.key === 'throughput')!;
    expect(tp.score).toBe(100);
    expect(tp.detail).toContain('baseline');
  });

  it('returns null when no factor has data', () => {
    expect(performanceScore(W, { summary: null, slaPassPct: null, p95Target: null, targetTps: null, baselineTps: null, infra: infra(), regressions: [], hasBaseline: false }).score).toBeNull();
  });
});

describe('classifyResult', () => {
  const defaults = DEFAULT_SETTINGS.default_result_thresholds;
  const sum = (over: any = {}) => ({ total_samples: 10_000, tps_avg: 100, error_pct: 0.1, ...over });
  const rule = (metric: string, status: string) => ({ rule: { metric, scope: 'RUN' }, status });
  const run = (over: any = {}) => classifyResult({ runStatus: 'COMPLETED', summary: sum(), sla: { results: [] }, regressions: [], infra: infra(), defaults, targetTps: null, ...over });

  it('is INCONCLUSIVE without samples', () => {
    expect(run({ summary: sum({ total_samples: 0 }) }).result).toBe('INCONCLUSIVE');
    expect(run({ summary: null }).reasons).toEqual(['No samples recorded for this run']);
  });

  it('PASS when everything is within limits', () => {
    const r = run();
    expect(r.result).toBe('PASS');
    expect(r.breakdown).toMatchObject({ SLA: 'N/A', TPS: 'N/A', P95: 'N/A', 'Error Rate': 'PASS', CPU: 'N/A', Regression: 'PASS' });
  });

  it('uses the default error thresholds when there is no error SLA', () => {
    expect(run({ summary: sum({ error_pct: 1 }) }).result).toBe('PASS_WITH_WARNINGS');
    expect(run({ summary: sum({ error_pct: 5 }) }).result).toBe('FAIL');
  });

  it('SLA failures fail the run; warnings give PASS_WITH_WARNINGS', () => {
    expect(run({ sla: { results: [rule('p95', 'FAIL')] } }).result).toBe('FAIL');
    const w = run({ sla: { results: [rule('p95', 'WARNING'), rule('tps', 'PASS'), rule('p99', 'NO_DATA')] } });
    expect(w.result).toBe('PASS_WITH_WARNINGS');
    expect(w.breakdown).toMatchObject({ SLA: 'WARNING', P95: 'WARNING', TPS: 'PASS' });
    expect(w.reasons).toContain('P95: WARNING');
  });

  it('judges TPS against the target (95% / 80%) when there is no TPS SLA', () => {
    expect(run({ targetTps: 100, summary: sum({ tps_avg: 95 }) }).breakdown.TPS).toBe('PASS');
    expect(run({ targetTps: 100, summary: sum({ tps_avg: 80 }) }).breakdown.TPS).toBe('WARNING');
    expect(run({ targetTps: 100, summary: sum({ tps_avg: 79 }) }).breakdown.TPS).toBe('FAIL');
  });

  it('judges CPU p90 at 80% / 90% without a CPU SLA', () => {
    expect(run({ infra: infra({ cpuP90: 79 }) }).breakdown.CPU).toBe('PASS');
    expect(run({ infra: infra({ cpuP90: 80 }) }).breakdown.CPU).toBe('WARNING');
    expect(run({ infra: infra({ cpuP90: 90 }) }).breakdown.CPU).toBe('FAIL');
  });

  it('regressions produce a warning, improvements do not', () => {
    expect(run({ regressions: [reg('CRITICAL')] }).result).toBe('PASS_WITH_WARNINGS');
    expect(run({ regressions: [reg('INFO', 'IMPROVEMENT')] }).result).toBe('PASS');
  });

  it('FAILED execution always fails; ABORTED or < 100 samples are inconclusive unless failing', () => {
    expect(run({ runStatus: 'FAILED' }).result).toBe('FAIL');
    expect(run({ runStatus: 'FAILED' }).reasons[0]).toBe('Test execution reported FAILED');
    expect(run({ runStatus: 'ABORTED' }).result).toBe('INCONCLUSIVE');
    expect(run({ runStatus: 'ABORTED', summary: sum({ error_pct: 50 }) }).result).toBe('FAIL');
    expect(run({ summary: sum({ total_samples: 99 }) }).result).toBe('INCONCLUSIVE');
  });
});

describe('bottleneck confidenceLabel', () => {
  it('maps confidence to labels at 0.45 / 0.65 / 0.8', () => {
    expect(confidenceLabel(0.9)).toBe('Strong correlation');
    expect(confidenceLabel(0.8)).toBe('Strong correlation');
    expect(confidenceLabel(0.79)).toBe('Likely bottleneck');
    expect(confidenceLabel(0.65)).toBe('Likely bottleneck');
    expect(confidenceLabel(0.45)).toBe('Possible bottleneck');
    expect(confidenceLabel(0.44)).toBe('Insufficient evidence');
    expect(confidenceLabel(0)).toBe('Insufficient evidence');
  });
});

describe('capacity fitLatencyModel', () => {
  const obs = (pairs: [number, number][]): Observation[] => pairs.map(([tps, p95], i) => ({ runKey: `R${i}`, users: null, tps, p95, cpuAvg: null }));

  it('needs at least 3 runs with TPS and P95', () => {
    const r = fitLatencyModel([...obs([[10, 100], [20, 120]]), { runKey: 'x', users: null, tps: null, p95: 5, cpuAvg: null }]);
    expect(r.fit).toBeNull();
    expect(r.reason).toMatch(/Only 2 completed run/);
  });

  it('refuses to fit runs at similar load levels', () => {
    expect(fitLatencyModel(obs([[100, 100], [105, 110], [110, 120]])).reason).toMatch(/similar load levels/);
  });

  it('prefers the linear model for linear data', () => {
    const { fit } = fitLatencyModel(obs([[10, 120], [20, 140], [30, 160], [40, 180]]));
    expect(fit!.type).toBe('linear');
    expect(fit!.a).toBeCloseTo(100);
    expect(fit!.b).toBeCloseTo(2);
    expect(fit!.r2).toBeCloseTo(1);
    expect(fit!.predict(50)).toBeCloseTo(200);
    expect(describeFit(fit!)).toMatch(/^P95 ≈ 100 \+ 2 × TPS \(linear, R² 1, good fit; 4 runs, TPS 10–40\)$/);
  });

  it('chooses the exponential model for exponential latency growth', () => {
    const { fit } = fitLatencyModel(obs([10, 20, 30, 40, 50].map((x) => [x, Math.exp(3 + 0.08 * x)] as [number, number])));
    expect(fit!.type).toBe('exponential');
    expect(fit!.b).toBeCloseTo(0.08);
    expect(describeFit(fit!)).toMatch(/^P95 ≈ e\^/);
  });
});

describe('capacity projectCapacity', () => {
  it('uses the Utilization Law without a fit and flags saturation', () => {
    const r = projectCapacity({ currentTps: 100, targetTps: 150, currentP95: 200, currentCpu: 40, slaP95: 400 }, null, null);
    expect(r.label).toBe('Estimate');
    expect(r.method).toMatch(/Utilization Law/);
    // U0 = 0.4, U1 = 0.6 → R = 200 * 0.6 / 0.4 = 300
    expect(r.projected.p95).toBe(300);
    expect(r.projected.cpuPct).toBe(60);
    expect(r.meetsSla).toBe(true);
    expect(r.headroomPct).toBe(25);
    expect(r.confidence).toBe('MEDIUM');

    const sat = projectCapacity({ currentTps: 100, targetTps: 300, currentP95: 200, currentCpu: 40, slaP95: 400 }, null, null);
    expect(sat.projected.p95).toBeNull();
    expect(sat.meetsSla).toBe(false);
    expect(sat.projected.cpuPct).toBe(100);
    expect(sat.assumptions.join(' ')).toMatch(/saturate the CPU/);
  });

  it('cannot project latency without CPU data or a fit', () => {
    const r = projectCapacity({ currentTps: 100, targetTps: 120, currentP95: 200 }, null, 250);
    expect(r.confidence).toBe('LOW');
    expect(r.projected.p95).toBeNull();
    expect(r.meetsSla).toBeNull();
    expect(r.assumptions[0]).toMatch(/P95 SLA of 250 ms taken from the test's SLA profile/);
  });

  it('anchors a fitted model to the current P95 and computes users via per-user throughput', () => {
    const { fit } = fitLatencyModel([10, 20, 30, 40, 50].map((x, i) => ({ runKey: `R${i}`, users: null, tps: x, p95: 100 + 2 * x, cpuAvg: null })));
    const r = projectCapacity({ currentTps: 40, targetTps: 50, currentP95: 360, currentUsers: 20 }, fit, null);
    // fit predicts 180 at 40 and 200 at 50; anchored to 360 → 400
    expect(r.projected.p95).toBe(400);
    expect(r.confidence).toBe('HIGH');
    expect(r.projected.users).toBe(25);
    expect(r.projected.tpsPerUser).toBe(2);
    expect(r.curve.length).toBeGreaterThan(0);
  });

  it('lowers confidence for extrapolation beyond 2x', () => {
    const r = projectCapacity({ currentTps: 10, targetTps: 30, currentP95: 100, currentCpu: 10 }, null, null);
    expect(r.confidence).toBe('LOW');
    expect(r.assumptions.join(' ')).toMatch(/3× the current load/);
  });
});

describe('trends detectDegradation', () => {
  const pts = (metric: string, values: (number | null)[]) => values.map((v, i) => ({ runKey: `R${i}`, label: `#${i + 1}`, metrics: { [metric]: v } }));

  it('detects a steadily degrading P95', () => {
    const d = detectDegradation(pts('p95', [100, 110, 120, 135, 150])).find((x) => x.metric === 'p95')!;
    expect(d.direction).toBe('DEGRADING');
    expect(d.consecutiveWorse).toBe(4);
    expect(d.severity).toBe('CRITICAL');
    expect(d.changePct).toBe(50);
    expect(d.message).toMatch(/^P95 is degrading: 100 ms \(#1\) → 150 ms \(#5\), \+50%/);
  });

  it('treats falling throughput as degrading and rising throughput as improving', () => {
    expect(detectDegradation(pts('tps', [100, 90, 80, 70]))[0].direction).toBe('DEGRADING');
    expect(detectDegradation(pts('tps', [70, 80, 90, 100]))[0].direction).toBe('IMPROVING');
  });

  it('reports a flat series as STABLE and ignores metrics with < 3 points', () => {
    const all = detectDegradation([
      { runKey: 'a', label: 'a', metrics: { p95: 100, errorPct: 1 } },
      { runKey: 'b', label: 'b', metrics: { p95: 101, errorPct: null } },
      { runKey: 'c', label: 'c', metrics: { p95: 100, errorPct: 1 } },
    ]);
    expect(all.map((x) => x.metric)).toEqual(['p95']);
    expect(all[0].direction).toBe('STABLE');
    expect(all[0].severity).toBe('INFO');
  });

  it('uses absolute thresholds for error rate', () => {
    const d = detectDegradation(pts('errorPct', [0.1, 0.2, 0.3, 0.4]))[0];
    // +0.3 pts: below the 0.5 pt significance bar, but 3 consecutive worse steps (> 0.05 pts) still flag it
    expect(d.direction).toBe('DEGRADING');
    expect(d.severity).toBe('WARNING');
  });
});
