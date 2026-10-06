import { query, tsPool } from '../db/pool.js';
import { windowStats, transactionStats } from '../metrics/series.js';

/** Recompute and persist run_summary + transactions for every metric source of a run. */
export async function computeSummaries(runId: string) {
  const sources = (await query(`SELECT DISTINCT source FROM run_metrics WHERE run_id = $1`, [runId], tsPool)).map((r) => r.source as string);
  const out: Record<string, any> = {};
  for (const source of sources) {
    const s = await windowStats(runId, { source });
    if (!s) continue;
    out[source] = s;
    await query(
      `INSERT INTO run_summary (run_id, source, computed_at, total_samples, success_count, failure_count, error_pct, tps_avg, tps_peak, avg_rt, min_rt, max_rt,
         median_rt, p50, p75, p90, p95, p99, p999, stddev_rt, users_avg, users_peak, bytes_sent, bytes_received, sent_kb_sec, received_kb_sec, duration_sec, percentile_method)
       VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (run_id, source) DO UPDATE SET computed_at = now(), total_samples = EXCLUDED.total_samples, success_count = EXCLUDED.success_count,
         failure_count = EXCLUDED.failure_count, error_pct = EXCLUDED.error_pct, tps_avg = EXCLUDED.tps_avg, tps_peak = EXCLUDED.tps_peak, avg_rt = EXCLUDED.avg_rt,
         min_rt = EXCLUDED.min_rt, max_rt = EXCLUDED.max_rt, median_rt = EXCLUDED.median_rt, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
         p95 = EXCLUDED.p95, p99 = EXCLUDED.p99, p999 = EXCLUDED.p999, stddev_rt = EXCLUDED.stddev_rt, users_avg = EXCLUDED.users_avg, users_peak = EXCLUDED.users_peak,
         bytes_sent = EXCLUDED.bytes_sent, bytes_received = EXCLUDED.bytes_received, sent_kb_sec = EXCLUDED.sent_kb_sec, received_kb_sec = EXCLUDED.received_kb_sec,
         duration_sec = EXCLUDED.duration_sec, percentile_method = EXCLUDED.percentile_method`,
      [runId, source, s.totalSamples, s.successCount, s.failureCount, s.errorPct, s.tpsAvg, s.tpsPeak, s.avgRt, s.minRt, s.maxRt, s.medianRt,
        s.p50, s.p75, s.p90, s.p95, s.p99, s.p999, s.stddevRt, s.usersAvg, s.usersPeak, s.bytesSent, s.bytesReceived, s.sentKbSec, s.receivedKbSec, s.durationSec, s.percentileMethod]);

    const txns = await transactionStats(runId, { source });
    await query(`DELETE FROM transactions WHERE run_id = $1 AND source = $2`, [runId, source]);
    for (const t of txns) {
      await query(
        `INSERT INTO transactions (run_id, name, source, samples, errors, error_pct, tps, avg_rt, min_rt, max_rt, median_rt, p75, p90, p95, p99, stddev_rt, received_kb_sec, sent_kb_sec, percentile_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [runId, t.name, source, t.totalSamples, t.failureCount, t.errorPct, t.tpsAvg, t.avgRt, t.minRt, t.maxRt, t.p50, t.p75, t.p90, t.p95, t.p99, t.stddevRt, t.receivedKbSec, t.sentKbSec, t.percentileMethod]);
    }
  }
  return out;
}

/** Primary summary row for analysis: live > jtl > import > html_report. */
export async function primarySummary(runId: string) {
  const rows = await query(`SELECT * FROM run_summary WHERE run_id = $1`, [runId]);
  for (const s of ['live', 'jtl', 'import', 'html_report']) {
    const r = rows.find((x) => x.source === s);
    if (r) return r;
  }
  return null;
}

export async function primaryTransactions(runId: string) {
  const rows = await query(`SELECT source, count(*) n FROM transactions WHERE run_id = $1 GROUP BY source`, [runId]);
  const have = rows.map((r) => r.source);
  const src = ['live', 'jtl', 'import', 'html_report'].find((s) => have.includes(s));
  if (!src) return [];
  return query(`SELECT * FROM transactions WHERE run_id = $1 AND source = $2 ORDER BY samples DESC`, [runId, src]);
}

/** Aggregated infrastructure figures for a run (used by SLA, comparison, score, bottleneck). */
export async function infraAggregates(runId: string) {
  const [srv] = await query(
    `SELECT avg(cpu_pct) cpu_avg, max(cpu_pct) cpu_max, percentile_cont(0.9) WITHIN GROUP (ORDER BY cpu_pct) cpu_p90,
            avg(memory_pct) mem_avg, max(memory_pct) mem_max, avg(disk_pct) disk_avg, max(disk_pct) disk_max,
            avg(net_in_bps + net_out_bps) net_avg_bps, max(load_avg_1m) load_max, count(*) n
     FROM server_metrics sm JOIN servers s ON s.id = sm.server_id WHERE sm.run_id = $1 AND coalesce(s.role,'') <> 'loadgen'`, [runId], tsPool);
  const [lg] = await query(
    `SELECT max(cpu_pct) cpu_max, percentile_cont(0.9) WITHIN GROUP (ORDER BY cpu_pct) cpu_p90, count(*) n
     FROM server_metrics sm JOIN servers s ON s.id = sm.server_id WHERE sm.run_id = $1 AND s.role = 'loadgen'`, [runId], tsPool);
  const [jvm] = await query(
    `SELECT max(heap_used_mb / NULLIF(heap_max_mb,0) * 100) heap_pct_max, avg(heap_used_mb / NULLIF(heap_max_mb,0) * 100) heap_pct_avg,
            max(gc_max_pause_ms) gc_pause_max, avg(gc_time_ms) gc_time_avg, max(thread_count) threads_max, count(*) n
     FROM jvm_metrics WHERE run_id = $1`, [runId], tsPool);
  const [db] = await query(
    `SELECT avg(query_latency_ms) latency_avg, max(query_latency_ms) latency_max, max(active_connections) active_max,
            max(active_connections::float / NULLIF(max_connections,0) * 100) pool_pct_max, sum(slow_queries) slow_queries, max(locks) locks_max, avg(cpu_pct) cpu_avg, count(*) n
     FROM database_metrics WHERE run_id = $1`, [runId], tsPool);
  const num = (v: any) => (v == null ? null : Number(v));
  return {
    hasServer: Number(srv?.n ?? 0) > 0,
    cpuAvg: num(srv?.cpu_avg), cpuMax: num(srv?.cpu_max), cpuP90: num(srv?.cpu_p90),
    memAvg: num(srv?.mem_avg), memMax: num(srv?.mem_max), diskMax: num(srv?.disk_max), netAvgBps: num(srv?.net_avg_bps), loadMax: num(srv?.load_max),
    hasLoadgen: Number(lg?.n ?? 0) > 0, loadgenCpuMax: num(lg?.cpu_max), loadgenCpuP90: num(lg?.cpu_p90),
    hasJvm: Number(jvm?.n ?? 0) > 0, heapPctMax: num(jvm?.heap_pct_max), heapPctAvg: num(jvm?.heap_pct_avg), gcPauseMax: num(jvm?.gc_pause_max), gcTimeAvg: num(jvm?.gc_time_avg), threadsMax: num(jvm?.threads_max),
    hasDb: Number(db?.n ?? 0) > 0, dbLatencyAvg: num(db?.latency_avg), dbLatencyMax: num(db?.latency_max), dbActiveMax: num(db?.active_max), dbPoolPctMax: num(db?.pool_pct_max), dbSlowQueries: num(db?.slow_queries), dbLocksMax: num(db?.locks_max), dbCpuAvg: num(db?.cpu_avg),
  };
}
export type InfraAggregates = Awaited<ReturnType<typeof infraAggregates>>;
