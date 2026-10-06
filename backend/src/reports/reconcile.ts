import { one, query } from '../db/pool.js';
import { round } from '../lib/stats.js';

/**
 * Data consistency: live (or JTL) metrics vs the uploaded JMeter HTML report for the same Run ID.
 * Tolerances: counts 0.1%, averages 2%, percentiles 5% (or 25 ms), throughput 2%.
 */
const FIELDS = [
  { key: 'total_samples', label: 'Requests', tolPct: 0.1, tolAbs: 0, unit: '' },
  { key: 'failure_count', label: 'Errors', tolPct: 0.1, tolAbs: 0, unit: '' },
  { key: 'error_pct', label: 'Error %', tolPct: 0, tolAbs: 0.05, unit: '%' },
  { key: 'avg_rt', label: 'Average RT', tolPct: 2, tolAbs: 5, unit: 'ms' },
  { key: 'median_rt', label: 'Median', tolPct: 5, tolAbs: 25, unit: 'ms' },
  { key: 'p90', label: 'P90', tolPct: 5, tolAbs: 25, unit: 'ms' },
  { key: 'p95', label: 'P95', tolPct: 5, tolAbs: 25, unit: 'ms' },
  { key: 'p99', label: 'P99', tolPct: 5, tolAbs: 25, unit: 'ms' },
  { key: 'min_rt', label: 'Min', tolPct: 0, tolAbs: 5, unit: 'ms' },
  { key: 'max_rt', label: 'Max', tolPct: 0, tolAbs: 5, unit: 'ms' },
  { key: 'tps_avg', label: 'TPS', tolPct: 2, tolAbs: 0.05, unit: '/s' },
  { key: 'received_kb_sec', label: 'Received KB/s', tolPct: 3, tolAbs: 0.5, unit: 'KB/s' },
  { key: 'sent_kb_sec', label: 'Sent KB/s', tolPct: 3, tolAbs: 0.5, unit: 'KB/s' },
];

export async function reconcile(runId: string) {
  const report = await one(`SELECT * FROM run_summary WHERE run_id = $1 AND source = 'html_report'`, [runId]);
  const rows = await query(`SELECT * FROM run_summary WHERE run_id = $1 AND source IN ('live','jtl')`, [runId]);
  const live = rows.find((r) => r.source === 'live') ?? rows.find((r) => r.source === 'jtl');
  if (!report || !live) {
    return { status: 'NOT_AVAILABLE' as const, consistent: true, liveSource: live?.source ?? null, rows: [], issues: [], message: !report ? 'No parsed HTML report for this run' : 'No live/JTL metrics for this run' };
  }
  const issues: string[] = [];
  let minor = 0;
  const out = FIELDS.map((f) => {
    const a = live[f.key];
    const b = report[f.key];
    if (a == null || b == null) return { metric: f.label, key: f.key, live: a, report: b, difference: null, differencePct: null, status: 'N/A', unit: f.unit };
    const diff = b - a;
    const diffPct = a === 0 ? (b === 0 ? 0 : 100) : (diff / Math.abs(a)) * 100;
    const within = Math.abs(diff) <= f.tolAbs || Math.abs(diffPct) <= f.tolPct;
    const status = within ? 'OK' : Math.abs(diffPct) <= f.tolPct * 3 || Math.abs(diff) <= f.tolAbs * 3 ? 'MINOR' : 'MISMATCH';
    if (status === 'MISMATCH') issues.push(`${f.label}: live ${round(a, 2)} vs report ${round(b, 2)} (${diffPct > 0 ? '+' : ''}${round(diffPct, 1)}%)`);
    if (status === 'MINOR') minor++;
    return { metric: f.label, key: f.key, live: a, report: b, difference: diff, differencePct: diffPct, status, unit: f.unit };
  });
  const status = issues.length ? 'INCONSISTENT' : minor ? 'MINOR_DIFFERENCES' : 'CONSISTENT';
  const notes: string[] = [];
  if (live.percentile_method !== 'exact_histogram') notes.push('Live percentiles are approximations (interval-reported); small percentile differences are expected.');
  notes.push('JMeter HTML reports compute percentiles from all raw samples; Perfmon histogram percentiles have ~2.5% bucket resolution.');
  return { status, consistent: issues.length === 0, liveSource: live.source, rows: out, issues, notes };
}
