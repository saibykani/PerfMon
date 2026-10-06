import { query, tsPool } from '../db/pool.js';
import { alignSeries, linearRegression, mean, pearson, round } from '../lib/stats.js';
import { runSeries, runSource, runWindow } from '../metrics/series.js';
import { infraAggregates, type InfraAggregates } from './summary.js';

export type ConfidenceLabel = 'Strong correlation' | 'Likely bottleneck' | 'Possible bottleneck' | 'Insufficient evidence';

export interface BottleneckCandidate {
  component: string;          // e.g. "Database (payments-db)", "Application CPU", "JVM GC"
  category: 'DATABASE' | 'CPU' | 'MEMORY' | 'JVM' | 'CONNECTION_POOL' | 'NETWORK' | 'LOAD_GENERATOR' | 'SATURATION' | 'ERRORS';
  confidence: number;         // 0..1 — never 1.0
  label: ConfidenceLabel;
  evidence: string[];
  correlation: number | null;
}

export function confidenceLabel(c: number): ConfidenceLabel {
  if (c >= 0.8) return 'Strong correlation';
  if (c >= 0.65) return 'Likely bottleneck';
  if (c >= 0.45) return 'Possible bottleneck';
  return 'Insufficient evidence';
}

type Pt = { t: number; v: number };
const fmt = (v: number | null | undefined, unit = '', d = 0) => (v == null ? 'n/a' : `${round(v, d)}${unit}`);

async function bucketed(sql: string, params: unknown[]): Promise<Pt[]> {
  const rows = await query(sql, params, tsPool);
  return rows.filter((r) => r.v != null).map((r) => ({ t: Number(r.t), v: Number(r.v) }));
}

export async function analyzeBottlenecks(runId: string, baselineId: string | null) {
  const source = await runSource(runId);
  const evidenceGaps: string[] = [];
  if (!source) return { candidates: [] as BottleneckCandidate[], saturation: null, gaps: ['No load-test metrics recorded for this run'], infra: null as InfraAggregates | null };
  const win = await runWindow(runId, source);
  const durationSec = win.from && win.to ? (win.to.getTime() - win.from.getTime()) / 1000 : 0;
  const step = Math.max(win.maxInterval, durationSec > 3600 ? 60 : durationSec > 900 ? 15 : 5);
  const series = await runSeries(runId, { source, step });
  const p95: Pt[] = series.points.filter((p) => p.p95 != null).map((p) => ({ t: p.t, v: p.p95! }));
  const tps: Pt[] = series.points.map((p) => ({ t: p.t, v: p.tps }));
  const users: Pt[] = series.points.filter((p) => p.users != null).map((p) => ({ t: p.t, v: p.users! }));
  const errPct: Pt[] = series.points.filter((p) => p.errorPct != null).map((p) => ({ t: p.t, v: p.errorPct! }));
  const stepMs = step * 1000;
  const b = `floor(extract(epoch from ts) / ${step}) * ${step} * 1000`;

  const appCpu = await bucketed(`SELECT ${b} t, avg(cpu_pct) v FROM server_metrics sm JOIN servers s ON s.id = sm.server_id WHERE sm.run_id = $1 AND coalesce(s.role,'') NOT IN ('loadgen','db') GROUP BY 1 ORDER BY 1`, [runId]);
  const lgCpu = await bucketed(`SELECT ${b} t, max(cpu_pct) v FROM server_metrics sm JOIN servers s ON s.id = sm.server_id WHERE sm.run_id = $1 AND s.role = 'loadgen' GROUP BY 1 ORDER BY 1`, [runId]);
  const mem = await bucketed(`SELECT ${b} t, max(memory_pct) v FROM server_metrics sm JOIN servers s ON s.id = sm.server_id WHERE sm.run_id = $1 AND coalesce(s.role,'') <> 'loadgen' GROUP BY 1 ORDER BY 1`, [runId]);
  const gc = await bucketed(`SELECT ${b} t, max(gc_max_pause_ms) v FROM jvm_metrics WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [runId]);
  const heap = await bucketed(`SELECT ${b} t, max(heap_used_mb / NULLIF(heap_max_mb,0) * 100) v FROM jvm_metrics WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [runId]);
  const dbLat = await bucketed(`SELECT ${b} t, avg(query_latency_ms) v FROM database_metrics WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [runId]);
  const dbPool = await bucketed(`SELECT ${b} t, max(active_connections::float / NULLIF(max_connections,0) * 100) v FROM database_metrics WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [runId]);
  const dbName = (await query(`SELECT s.name FROM database_metrics d JOIN services s ON s.id = d.service_id WHERE d.run_id = $1 LIMIT 1`, [runId]))[0]?.name;

  const infra = await infraAggregates(runId);
  const base = baselineId ? await infraAggregates(baselineId) : null;
  const baseP95 = baselineId ? (await query(`SELECT p95 FROM run_summary WHERE run_id = $1 ORDER BY CASE source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 ELSE 2 END LIMIT 1`, [baselineId]))[0]?.p95 : null;
  const curP95 = p95.length ? mean(p95.map((p) => p.v)) : null;

  const corr = (s: Pt[]) => { const [x, y] = alignSeries(p95, s, stepMs); return pearson(x, y); };
  const candidates: BottleneckCandidate[] = [];
  const sufficiency = (n: number) => Math.min(1, n / 30); // ≥30 aligned points = full weight
  const score = (c: number | null, magnitude: number, corroboration: number, n: number) =>
    Math.min(0.95, 0.35 * Math.max(0, c ?? 0) + 0.35 * Math.min(1, Math.max(0, magnitude)) + 0.2 * Math.min(1, corroboration) + 0.1 * sufficiency(n));

  // Database latency
  if (dbLat.length) {
    const c = corr(dbLat);
    const ev: string[] = [];
    let magnitude = 0;
    if (base?.dbLatencyAvg != null && infra.dbLatencyAvg != null) {
      ev.push(`DB latency changed from ${fmt(base.dbLatencyAvg, 'ms')} → ${fmt(infra.dbLatencyAvg, 'ms')} (baseline → current)`);
      magnitude = Math.max(0, (infra.dbLatencyAvg - base.dbLatencyAvg) / Math.max(1, base.dbLatencyAvg));
    } else {
      const first = mean(dbLat.slice(0, Math.max(1, Math.floor(dbLat.length / 4))).map((p) => p.v));
      const last = mean(dbLat.slice(-Math.max(1, Math.floor(dbLat.length / 4))).map((p) => p.v));
      ev.push(`DB latency moved from ${fmt(first, 'ms')} (start) to ${fmt(last, 'ms')} (end of run)`);
      magnitude = Math.max(0, (last - first) / Math.max(1, first));
    }
    if (baseP95 != null && curP95 != null) ev.push(`P95 changed from ${fmt(baseP95, 'ms')} → ${fmt(curP95, 'ms')}`);
    if (c != null) ev.push(`Correlation between P95 and DB latency: r = ${round(c, 2)}`);
    let corroboration = 0;
    if (infra.cpuP90 != null && infra.cpuP90 < 70) { corroboration += 0.6; ev.push(`Application CPU remained moderate (p90 ${fmt(infra.cpuP90, '%')})`); }
    if ((infra.dbSlowQueries ?? 0) > 0) { corroboration += 0.4; ev.push(`${infra.dbSlowQueries} slow queries recorded`); }
    const conf = score(c, magnitude, corroboration, dbLat.length);
    candidates.push({ component: `Database${dbName ? ` (${dbName})` : ''}`, category: 'DATABASE', confidence: conf, label: confidenceLabel(conf), evidence: ev, correlation: c });
  }

  // DB connection pool
  if (dbPool.length && (infra.dbPoolPctMax ?? 0) >= 80) {
    const c = corr(dbPool);
    const conf = score(c, ((infra.dbPoolPctMax ?? 0) - 80) / 20, (infra.dbPoolPctMax ?? 0) >= 95 ? 1 : 0.5, dbPool.length);
    candidates.push({ component: 'Database connection pool', category: 'CONNECTION_POOL', confidence: conf, label: confidenceLabel(conf), correlation: c,
      evidence: [`Active DB connections reached ${fmt(infra.dbPoolPctMax, '%')} of the pool`, c != null ? `Correlation with P95: r = ${round(c, 2)}` : 'Correlation unavailable'] });
  }

  // Application CPU
  if (appCpu.length) {
    const c = corr(appCpu);
    const p90 = infra.cpuP90 ?? 0;
    const ev = [`Application CPU p90 ${fmt(infra.cpuP90, '%')}, max ${fmt(infra.cpuMax, '%')}`];
    if (c != null) ev.push(`Correlation between P95 and CPU: r = ${round(c, 2)}`);
    if (base?.cpuAvg != null) ev.push(`Average CPU baseline ${fmt(base.cpuAvg, '%')} → current ${fmt(infra.cpuAvg, '%')}`);
    const conf = p90 < 60 ? Math.min(0.3, score(c, 0, 0, appCpu.length)) : score(c, (p90 - 60) / 30, p90 >= 85 ? 1 : 0.3, appCpu.length);
    candidates.push({ component: 'Application CPU', category: 'CPU', confidence: conf, label: confidenceLabel(conf), evidence: ev, correlation: c });
  }

  // Memory
  if (mem.length && (infra.memMax ?? 0) >= 85) {
    const c = corr(mem);
    const conf = score(c, ((infra.memMax ?? 0) - 85) / 15, 0.3, mem.length);
    candidates.push({ component: 'Server memory', category: 'MEMORY', confidence: conf, label: confidenceLabel(conf), correlation: c, evidence: [`Memory peaked at ${fmt(infra.memMax, '%')}`] });
  }

  // JVM GC / heap
  if (gc.length) {
    const c = corr(gc);
    const ev = [`Max GC pause ${fmt(infra.gcPauseMax, 'ms')}`, `Heap usage peaked at ${fmt(infra.heapPctMax, '%')}`];
    if (c != null) ev.push(`Correlation between P95 and GC pause: r = ${round(c, 2)}`);
    if (base?.gcPauseMax != null) ev.push(`Baseline max GC pause ${fmt(base.gcPauseMax, 'ms')}`);
    const magnitude = Math.max(((infra.gcPauseMax ?? 0) - 200) / 800, ((infra.heapPctMax ?? 0) - 80) / 20);
    const conf = score(c, magnitude, (infra.heapPctMax ?? 0) > 90 ? 1 : 0.3, gc.length);
    candidates.push({ component: 'JVM garbage collection', category: 'JVM', confidence: conf, label: confidenceLabel(conf), evidence: ev, correlation: c });
  }

  // Load generator saturation (test validity)
  if (lgCpu.length && (infra.loadgenCpuP90 ?? 0) >= 80) {
    const conf = score(corr(lgCpu), ((infra.loadgenCpuP90 ?? 0) - 80) / 20, 0.5, lgCpu.length);
    candidates.push({ component: 'Load generator', category: 'LOAD_GENERATOR', confidence: conf, label: confidenceLabel(conf), correlation: null,
      evidence: [`Load generator CPU p90 ${fmt(infra.loadgenCpuP90, '%')} — results may be limited by the load generator rather than the system under test`] });
  }

  // Errors / timeouts under load
  if (errPct.length) {
    const c = corr(errPct);
    const maxErr = Math.max(...errPct.map((p) => p.v));
    if (maxErr >= 2 && c != null && c > 0.5) {
      const conf = score(c, maxErr / 20, 0.3, errPct.length);
      candidates.push({ component: 'Error spikes under load', category: 'ERRORS', confidence: conf, label: confidenceLabel(conf), correlation: c,
        evidence: [`Error rate peaked at ${fmt(maxErr, '%', 2)}`, `Errors rise together with latency (r = ${round(c, 2)}) — typical of timeouts or exhausted resources`] });
    }
  }

  // Throughput saturation: users keep rising, TPS flattens, latency rises
  let saturation: { detected: boolean; atTps: number | null; atUsers: number | null; evidence: string[] } | null = null;
  if (users.length >= 10 && tps.length >= 10) {
    const half = Math.floor(tps.length / 2);
    const [u2, t2] = alignSeries(users.slice(half), tps.slice(half), stepMs);
    const reg = linearRegression(u2, t2);
    const [uAll, rtAll] = alignSeries(users, p95, stepMs);
    const userRt = pearson(uAll, rtAll);
    const userGrowth = (users[users.length - 1].v - users[half].v) / Math.max(1, users[half].v);
    const tpsPerUserFirst = mean(tps.slice(0, half).map((p) => p.v)) / Math.max(1, mean(users.slice(0, half).map((p) => p.v)));
    if (reg && userGrowth > 0.2 && userRt != null && userRt > 0.6 && reg.slope < tpsPerUserFirst * 0.3) {
      const peak = Math.max(...tps.map((p) => p.v));
      const atUser = users.find((u) => u.t >= (tps.find((t) => t.v >= peak * 0.95)?.t ?? 0))?.v ?? null;
      saturation = { detected: true, atTps: round(peak, 1), atUsers: atUser, evidence: [`Users increased ${round(userGrowth * 100, 0)}% in the second half while TPS stayed near ${round(peak, 1)}`, `Latency correlates with user count (r = ${round(userRt, 2)})`] };
      const conf = Math.min(0.9, 0.5 + 0.4 * userRt);
      candidates.push({ component: 'System throughput limit', category: 'SATURATION', confidence: conf, label: confidenceLabel(conf), correlation: userRt, evidence: saturation.evidence });
    } else saturation = { detected: false, atTps: null, atUsers: null, evidence: [] };
  }

  if (!appCpu.length && !dbLat.length && !gc.length) evidenceGaps.push('No infrastructure, JVM or database metrics were collected for this run — bottleneck attribution is limited to load-test metrics.');
  if (p95.length < 10) evidenceGaps.push('Fewer than 10 data points — correlations are unreliable.');
  if (series.percentileMethod === 'interval_weighted_approx') evidenceGaps.push('P95 series is derived from interval-reported percentiles (approximate).');

  candidates.sort((a, b) => b.confidence - a.confidence);
  return { candidates, saturation, gaps: evidenceGaps, infra };
}
