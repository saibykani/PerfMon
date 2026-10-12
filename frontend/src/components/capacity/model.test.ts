import { describe, expect, it } from 'vitest';
import { estimateErrorPct, fitCurve, linReg, predictP95, resolveFit, slaFromProfile, type CapacityModel, type FitParams } from './model';

const obs = (pairs: [number, number][]) => pairs.map(([tps, p95], i) => ({ runKey: `R${i}`, users: null, tps, p95, cpuAvg: null }));

describe('linReg', () => {
  it('fits a perfect line', () => {
    const r = linReg([1, 2, 3], [5, 7, 9])!;
    expect(r.slope).toBeCloseTo(2);
    expect(r.intercept).toBeCloseTo(3);
    expect(r.r2).toBeCloseTo(1);
    expect(r.predict(4)).toBeCloseTo(11);
  });

  it('returns null for fewer than 2 points or constant x', () => {
    expect(linReg([1], [1])).toBeNull();
    expect(linReg([3, 3, 3], [1, 2, 3])).toBeNull();
  });
});

describe('resolveFit', () => {
  const model = (type: CapacityModel['model']['type'], pairs: [number, number][], extra: Partial<CapacityModel> = {}): CapacityModel => ({
    observations: obs(pairs), model: { type, r2: 0.9, description: '' }, estimatedSaturationTps: null, notes: [], ...extra,
  });

  it('prefers the coefficients sent by the API', () => {
    const fit: FitParams = { type: 'linear', a: 1, b: 2, r2: 0.5, n: 3, minTps: 1, maxTps: 3 };
    expect(resolveFit(model('linear', [], { fit }))).toBe(fit);
  });

  it('returns null for missing or insufficient models', () => {
    expect(resolveFit(undefined)).toBeNull();
    expect(resolveFit(model('insufficient', [[1, 1], [2, 2], [3, 3]]))).toBeNull();
    expect(resolveFit(model('linear', [[1, 1], [2, 2]]))).toBeNull();
  });

  it('refits a linear model client-side, ignoring invalid observations', () => {
    const f = resolveFit(model('linear', [[10, 120], [20, 140], [30, 160], [0, 999]]))!;
    expect(f).toMatchObject({ type: 'linear', n: 3, minTps: 10, maxTps: 30, r2: 0.9 });
    expect(f.a).toBeCloseTo(100);
    expect(f.b).toBeCloseTo(2);
  });

  it('refits an exponential model in log space', () => {
    const f = resolveFit(model('exponential', [10, 20, 30].map((x) => [x, Math.exp(2 + 0.05 * x)] as [number, number])))!;
    expect(f.a).toBeCloseTo(2);
    expect(f.b).toBeCloseTo(0.05);
    expect(predictP95(f, 40)).toBeCloseTo(Math.exp(4));
  });
});

describe('fitCurve', () => {
  it('samples steps+1 points and drops non-positive predictions', () => {
    const f: FitParams = { type: 'linear', a: -10, b: 1, r2: 1, n: 3, minTps: 0, maxTps: 40 };
    const c = fitCurve(f, 0, 40, 4);
    expect(c).toEqual([[20, 10], [30, 20], [40, 30]]);
    expect(fitCurve({ ...f, a: 0 }, 1, 2, 10)).toHaveLength(11);
  });
});

describe('estimateErrorPct', () => {
  it('returns null without data', () => {
    expect(estimateErrorPct([], 100)).toMatchObject({ value: null, confidence: 'LOW' });
  });

  it('uses a linear trend when runs support it, clamped to 0..100', () => {
    const pts = [10, 20, 30, 40, 50].map((tps) => ({ tps, errorPct: tps / 10 }));
    const r = estimateErrorPct(pts, 60);
    expect(r.value).toBeCloseTo(6);
    expect(r.confidence).toBe('MEDIUM');
    expect(estimateErrorPct(pts, 2000).value).toBe(100);
    expect(estimateErrorPct(pts, 2000).confidence).toBe('LOW');
    expect(estimateErrorPct(pts, 2000).method).toMatch(/extrapolated/);
  });

  it('falls back to the nearest run without a usable trend', () => {
    const r = estimateErrorPct([{ tps: 10, errorPct: 1 }, { tps: 50, errorPct: 3 }], 45);
    expect(r).toMatchObject({ value: 3, confidence: 'LOW' });
    expect(r.method).toMatch(/50\.0 TPS/);
  });
});

describe('slaFromProfile', () => {
  const rule = (over: any) => ({ metric: 'p95', scope: 'RUN', enabled: true, position: 0, warning_value: 300, critical_value: 500, ...over });

  it('uses the critical value, else the warning value, of the first enabled RUN rule', () => {
    expect(slaFromProfile([rule({})], 'p95')).toBe(500);
    expect(slaFromProfile([rule({ critical_value: null })], 'p95')).toBe(300);
    expect(slaFromProfile([rule({ position: 2, critical_value: 900 }), rule({ position: 1, critical_value: 700 })], 'p95')).toBe(700);
  });

  it('ignores disabled, transaction-scoped and other-metric rules', () => {
    expect(slaFromProfile([rule({ enabled: false }), rule({ scope: 'TRANSACTION' }), rule({ metric: 'p99' })], 'p95')).toBeNull();
    expect(slaFromProfile(undefined, 'p95')).toBeNull();
    expect(slaFromProfile([rule({ warning_value: null, critical_value: null })], 'p95')).toBeNull();
  });
});
