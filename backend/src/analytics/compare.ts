import { one, query } from '../db/pool.js';
import { pctChange } from '../lib/stats.js';
import { primarySummary, primaryTransactions, infraAggregates } from './summary.js';

/** Baseline resolution: explicit run baseline > test baseline > previous completed run of the same test+environment. */
export async function resolveBaseline(runId: string): Promise<{ id: string; runKey: string; reason: string } | null> {
  const run = await one(`SELECT r.id, r.baseline_run_id, r.test_id, r.environment_id, r.started_at, r.created_at, t.baseline_run_id AS test_baseline
                         FROM test_runs r JOIN performance_tests t ON t.id = r.test_id WHERE r.id = $1`, [runId]);
  if (!run) return null;
  for (const [id, reason] of [[run.baseline_run_id, 'run baseline'], [run.test_baseline, 'test baseline']] as const) {
    if (id && id !== runId) {
      const b = await one(`SELECT id, run_key FROM test_runs WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (b) return { id: b.id, runKey: b.run_key, reason };
    }
  }
  const prev = await one(
    `SELECT id, run_key FROM test_runs WHERE test_id = $1 AND environment_id = $2 AND id <> $3 AND status = 'COMPLETED' AND deleted_at IS NULL
       AND COALESCE(started_at, created_at) < COALESCE($4::timestamptz, $5::timestamptz) ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1`,
    [run.test_id, run.environment_id, runId, run.started_at, run.created_at]);
  return prev ? { id: prev.id, runKey: prev.run_key, reason: 'previous completed run' } : null;
}

/** Metric catalogue for comparisons. better: which direction is an improvement. */
export const COMPARE_METRICS = [
  { key: 'tps', label: 'TPS', unit: 'tps', better: 'higher' },
  { key: 'tps_peak', label: 'Peak TPS', unit: 'tps', better: 'higher' },
  { key: 'avg_rt', label: 'Avg RT', unit: 'ms', better: 'lower' },
  { key: 'p50', label: 'P50', unit: 'ms', better: 'lower' },
  { key: 'p90', label: 'P90', unit: 'ms', better: 'lower' },
  { key: 'p95', label: 'P95', unit: 'ms', better: 'lower' },
  { key: 'p99', label: 'P99', unit: 'ms', better: 'lower' },
  { key: 'max_rt', label: 'Max RT', unit: 'ms', better: 'lower' },
  { key: 'error_pct', label: 'Errors', unit: '%', better: 'lower' },
  { key: 'total_samples', label: 'Requests', unit: '', better: 'neutral' },
  { key: 'users_peak', label: 'Peak users', unit: '', better: 'neutral' },
  { key: 'received_kb_sec', label: 'Received KB/s', unit: 'KB/s', better: 'neutral' },
  { key: 'sla_pass_pct', label: 'SLA pass', unit: '%', better: 'higher' },
  { key: 'performance_score', label: 'Performance score', unit: '', better: 'higher' },
  { key: 'cpu_avg', label: 'CPU avg', unit: '%', better: 'lower' },
  { key: 'cpu_max', label: 'CPU max', unit: '%', better: 'lower' },
  { key: 'mem_max', label: 'Memory max', unit: '%', better: 'lower' },
  { key: 'net_avg_bps', label: 'Network avg', unit: 'B/s', better: 'neutral' },
  { key: 'heap_pct_max', label: 'Heap max', unit: '%', better: 'lower' },
  { key: 'gc_pause_max', label: 'GC pause max', unit: 'ms', better: 'lower' },
  { key: 'db_latency_avg', label: 'DB latency avg', unit: 'ms', better: 'lower' },
  { key: 'db_active_max', label: 'DB active conns max', unit: '', better: 'lower' },
] as const;

export async function runMetricVector(runId: string) {
  const run = await one(`SELECT r.id, r.run_key, r.status, r.result, r.performance_score, r.build_number, r.version, r.started_at, r.ended_at, r.virtual_users,
                                t.name AS test_name, e.name AS environment_name
                         FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN environments e ON e.id = r.environment_id WHERE r.id = $1`, [runId]);
  const s = await primarySummary(runId);
  const i = await infraAggregates(runId);
  return {
    run,
    summarySource: s?.source ?? null,
    percentileMethod: s?.percentile_method ?? null,
    values: {
      tps: s?.tps_avg ?? null, tps_peak: s?.tps_peak ?? null, avg_rt: s?.avg_rt ?? null, p50: s?.p50 ?? null, p90: s?.p90 ?? null, p95: s?.p95 ?? null,
      p99: s?.p99 ?? null, max_rt: s?.max_rt ?? null, error_pct: s?.error_pct ?? null, total_samples: s?.total_samples ?? null, users_peak: s?.users_peak ?? null,
      received_kb_sec: s?.received_kb_sec ?? null, sla_pass_pct: s?.sla_pass_pct ?? null, performance_score: run?.performance_score ?? null,
      cpu_avg: i.cpuAvg, cpu_max: i.cpuMax, mem_max: i.memMax, net_avg_bps: i.netAvgBps, heap_pct_max: i.heapPctMax, gc_pause_max: i.gcPauseMax,
      db_latency_avg: i.dbLatencyAvg, db_active_max: i.dbActiveMax,
    } as Record<string, number | null>,
  };
}

/** Compare 2..N runs. Run A (first) is the reference for change %. */
export async function compareRuns(runIds: string[]) {
  const vectors = await Promise.all(runIds.map(runMetricVector));
  const ref = vectors[0];
  const metrics = COMPARE_METRICS.map((m) => {
    const values = vectors.map((v) => v.values[m.key] ?? null);
    const changes = values.map((v, i) => (i === 0 ? null : pctChange(ref.values[m.key], v)));
    const verdicts = changes.map((c) => {
      if (c == null || m.better === 'neutral' || Math.abs(c) < 2) return 'neutral';
      return (m.better === 'lower') === c < 0 ? 'better' : 'worse';
    });
    return { ...m, values, changes, verdicts };
  }).filter((m) => m.values.some((v) => v != null));

  // Transaction-level comparison
  const txnSets = await Promise.all(runIds.map(primaryTransactions));
  const names = [...new Set(txnSets.flatMap((s) => s.map((t) => t.name)))].sort();
  const transactions = names.map((name) => {
    const rows = txnSets.map((s) => s.find((t) => t.name === name) ?? null);
    const pick = (k: string) => rows.map((r) => (r ? r[k] : null));
    const p95 = pick('p95');
    return {
      name,
      samples: pick('samples'), tps: pick('tps'), avg: pick('avg_rt'), p95, p99: pick('p99'), errorPct: pick('error_pct'),
      p95Change: p95.map((v, i) => (i === 0 ? null : pctChange(p95[0], v))),
    };
  });

  // Endpoint-level comparison
  const endpointRows = await query(
    `SELECT m.run_id, e.method || ' ' || e.path_template AS endpoint, sum(m.sample_count) n, sum(m.error_count) err, sum(m.sum_rt) / NULLIF(sum(m.sample_count),0) avg
     FROM api_metrics m JOIN api_endpoints e ON e.id = m.endpoint_id WHERE m.run_id = ANY($1::uuid[]) GROUP BY 1, 2`, [runIds]);
  const epNames = [...new Set(endpointRows.map((r) => r.endpoint))].sort();
  const endpoints = epNames.map((ep) => {
    const rows = runIds.map((id) => endpointRows.find((r) => r.run_id === id && r.endpoint === ep) ?? null);
    const avg = rows.map((r) => (r ? Number(r.avg) : null));
    return { endpoint: ep, samples: rows.map((r) => (r ? Number(r.n) : null)), avg, errorPct: rows.map((r) => (r && Number(r.n) ? (Number(r.err) / Number(r.n)) * 100 : null)), avgChange: avg.map((v, i) => (i === 0 ? null : pctChange(avg[0], v))) };
  });

  // SLA comparison
  const sla = await query(`SELECT run_id, status, count(*)::int n FROM sla_results WHERE run_id = ANY($1::uuid[]) GROUP BY 1, 2`, [runIds]);
  const slaByRun = runIds.map((id) => Object.fromEntries(sla.filter((s) => s.run_id === id).map((s) => [s.status, s.n])));

  return { runs: vectors.map((v) => ({ ...v.run, summarySource: v.summarySource, percentileMethod: v.percentileMethod })), metrics, transactions, endpoints, sla: slaByRun };
}
