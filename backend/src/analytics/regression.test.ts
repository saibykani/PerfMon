import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * detectRegressions / resolveBaseline read from PostgreSQL. The DB layer and the summary
 * loaders are mocked so the threshold decisions and baseline precedence run without a DB.
 */
const db = vi.hoisted(() => ({
  one: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../db/pool.js', () => ({ one: db.one, query: db.query, tsPool: {}, pool: {} }));

const data = vi.hoisted(() => ({
  summaries: {} as Record<string, any>,
  txns: {} as Record<string, any[]>,
  infra: {} as Record<string, any>,
}));
vi.mock('./summary.js', () => ({
  primarySummary: async (id: string) => data.summaries[id] ?? null,
  primaryTransactions: async (id: string) => data.txns[id] ?? [],
  infraAggregates: async (id: string) => data.infra[id] ?? { cpuAvg: null, memMax: null, dbLatencyAvg: null },
}));

const { detectRegressions } = await import('./regression.js');
const { resolveBaseline } = await import('./compare.js');

const inserted = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO regressions/.test(sql)).map(([, p]) => p);

/** Wires `one` for: run org lookup, settings lookup, baseline resolution (explicit run baseline B). */
function setup(thresholdOverrides: Record<string, number> | null = null) {
  db.one.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/SELECT organization_id FROM test_runs/.test(sql)) return { organization_id: 'org' };
    if (/FROM system_settings/.test(sql)) return thresholdOverrides ? { value: thresholdOverrides } : null;
    if (/JOIN performance_tests/.test(sql)) return { id: params[0], baseline_run_id: 'B', test_baseline: null };
    if (/SELECT id, run_key FROM test_runs WHERE id = \$1/.test(sql)) return { id: params[0], run_key: 'PF-B' };
    return null;
  });
}

beforeEach(() => {
  db.one.mockReset();
  db.query.mockReset();
  db.query.mockResolvedValue([]);
  data.summaries = {};
  data.txns = {};
  data.infra = {};
});

describe('detectRegressions thresholds', () => {
  it('flags P95 +15% as WARNING and +25% (≥ 2× threshold) as CRITICAL', async () => {
    setup();
    data.summaries = { A: { p95: 125, p99: 300, avg_rt: 100, tps_avg: 100, error_pct: 0 }, B: { p95: 100, p99: 300, avg_rt: 100, tps_avg: 100, error_pct: 0 } };
    let r = await detectRegressions('A');
    expect(r.baseline).toEqual({ id: 'B', runKey: 'PF-B', reason: 'run baseline' });
    expect(r.findings).toEqual([expect.objectContaining({ metric: 'p95', direction: 'REGRESSION', severity: 'CRITICAL', changePct: 25, thresholdPct: 10 })]);

    data.summaries.A.p95 = 115;
    // 15 ms change < minAbsoluteMs (25 ms) → ignored
    r = await detectRegressions('A');
    expect(r.findings).toEqual([]);

    data.summaries = { A: { p95: 1150, tps_avg: 100 }, B: { p95: 1000, tps_avg: 100 } };
    r = await detectRegressions('A');
    expect(r.findings).toEqual([expect.objectContaining({ metric: 'p95', severity: 'WARNING' })]);
  });

  it('does not flag changes within the threshold', async () => {
    setup();
    data.summaries = { A: { p95: 1100, p99: 1150, avg_rt: 509, tps_avg: 91, error_pct: 1.5 }, B: { p95: 1000, p99: 1000, avg_rt: 500, tps_avg: 100, error_pct: 0.6 } };
    expect((await detectRegressions('A')).findings).toEqual([]);
  });

  it('treats a TPS drop as a regression and a TPS gain as an improvement', async () => {
    setup();
    data.summaries = { A: { tps_avg: 80 }, B: { tps_avg: 100 } };
    expect((await detectRegressions('A')).findings).toEqual([expect.objectContaining({ metric: 'tps', direction: 'REGRESSION', severity: 'CRITICAL' })]);
    data.summaries = { A: { tps_avg: 120 }, B: { tps_avg: 100 } };
    expect((await detectRegressions('A')).findings).toEqual([expect.objectContaining({ metric: 'tps', direction: 'IMPROVEMENT', severity: 'INFO' })]);
  });

  it('judges error rate by absolute percentage points', async () => {
    setup();
    data.summaries = { A: { error_pct: 2.5 }, B: { error_pct: 1 } };
    expect((await detectRegressions('A')).findings).toEqual([expect.objectContaining({ metric: 'error_pct', direction: 'REGRESSION', severity: 'WARNING' })]);
    data.summaries = { A: { error_pct: 5 }, B: { error_pct: 1 } };
    expect((await detectRegressions('A')).findings[0].severity).toBe('CRITICAL');
    data.summaries = { A: { error_pct: 0 }, B: { error_pct: 2 } };
    expect((await detectRegressions('A')).findings[0].direction).toBe('IMPROVEMENT');
  });

  it('respects organisation threshold overrides', async () => {
    setup({ p95Pct: 50 });
    data.summaries = { A: { p95: 1300 }, B: { p95: 1000 } };
    expect((await detectRegressions('A')).findings).toEqual([]);
  });

  it('checks transactions only with enough samples on both sides', async () => {
    setup();
    data.txns = {
      A: [{ name: 'Login', samples: 100, p95: 200, p99: 210, error_pct: 0 }, { name: 'Rare', samples: 5, p95: 900, p99: 900, error_pct: 0 }],
      B: [{ name: 'Login', samples: 100, p95: 100, p99: 200, error_pct: 0 }, { name: 'Rare', samples: 5, p95: 100, p99: 100, error_pct: 0 }],
    };
    const r = await detectRegressions('A');
    expect(r.findings).toEqual([expect.objectContaining({ scope: 'TRANSACTION', transaction: 'Login', metric: 'p95', severity: 'CRITICAL' })]);
  });

  it('flags infrastructure increases in absolute points', async () => {
    setup();
    data.infra = { A: { cpuAvg: 80, memMax: 75, dbLatencyAvg: null }, B: { cpuAvg: 60, memMax: 40, dbLatencyAvg: null } };
    const r = await detectRegressions('A');
    expect(r.findings).toEqual([
      expect.objectContaining({ scope: 'INFRA', metric: 'cpu_avg', severity: 'WARNING' }),
      expect.objectContaining({ scope: 'INFRA', metric: 'mem_max', severity: 'CRITICAL' }),
    ]);
  });

  it('persists findings with likely-impacted transactions only for regressions', async () => {
    setup();
    data.summaries = { A: { p95: 200, tps_avg: 200 }, B: { p95: 100, tps_avg: 100 } };
    await detectRegressions('A', ['Login']);
    const rows = inserted();
    expect(rows).toHaveLength(2);
    const byMetric = Object.fromEntries(rows.map((p: any[]) => [p[4], p]));
    expect(byMetric.p95[11]).toEqual(['Login']);
    expect(byMetric.tps[11]).toEqual([]);
  });

  it('returns no findings without a baseline', async () => {
    db.one.mockImplementation(async (sql: string) => {
      if (/organization_id/.test(sql)) return { organization_id: 'org' };
      if (/JOIN performance_tests/.test(sql)) return { id: 'A', baseline_run_id: null, test_baseline: null };
      return null;
    });
    expect(await detectRegressions('A')).toEqual({ baseline: null, findings: [] });
  });
});

describe('resolveBaseline precedence', () => {
  const wire = (run: any, existing: Record<string, string>, previous: any = null) => {
    db.one.mockImplementation(async (sql: string, params: any[]) => {
      if (/JOIN performance_tests/.test(sql)) return run;
      if (/WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) return existing[params[0]] ? { id: params[0], run_key: existing[params[0]] } : null;
      if (/status = 'COMPLETED'/.test(sql)) return previous;
      return null;
    });
  };

  it('prefers the run baseline over the test baseline', async () => {
    wire({ id: 'A', baseline_run_id: 'R', test_baseline: 'T' }, { R: 'PF-R', T: 'PF-T' });
    expect(await resolveBaseline('A')).toEqual({ id: 'R', runKey: 'PF-R', reason: 'run baseline' });
  });

  it('falls back to the test baseline when the run baseline was deleted', async () => {
    wire({ id: 'A', baseline_run_id: 'R', test_baseline: 'T' }, { T: 'PF-T' });
    expect(await resolveBaseline('A')).toEqual({ id: 'T', runKey: 'PF-T', reason: 'test baseline' });
  });

  it('never uses the run itself as its baseline', async () => {
    wire({ id: 'A', baseline_run_id: null, test_baseline: 'A' }, { A: 'PF-A' }, { id: 'P', run_key: 'PF-P' });
    expect(await resolveBaseline('A')).toEqual({ id: 'P', runKey: 'PF-P', reason: 'previous completed run' });
  });

  it('returns null when nothing qualifies or the run does not exist', async () => {
    wire({ id: 'A', baseline_run_id: null, test_baseline: null }, {});
    expect(await resolveBaseline('A')).toBeNull();
    wire(null, {});
    expect(await resolveBaseline('missing')).toBeNull();
  });
});
