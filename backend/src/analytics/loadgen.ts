import { one, query, tsPool } from '../db/pool.js';
import { getSetting } from './settings.js';
import { evaluateHost, heapPct, overallStatus, type HostStatus, type LoadgenThresholds, type MetricEvaluation } from './loadgenHealth.js';

const num = (v: any) => (v == null ? null : Number(v));

export interface LoadgenHost {
  serverId: string; name: string; hostname: string | null; os: string | null; cpuCores: number | null; memoryMb: number | null;
  status: HostStatus; metrics: MetricEvaluation[];
  jmeter: { serviceId: string | null; cpuPeak: number | null; cpuAvg: number | null; rssPeakMb: number | null; heapMaxMb: number | null; gcTimeMs: number | null };
}

/**
 * Load generator health for a run: every server with role "loadgen" that reported metrics for the run,
 * evaluated against the organization's `loadgen_thresholds` setting. `series` is bucketed for charts.
 */
export async function loadgenHealth(runId: string, orgId?: string | null) {
  if (!orgId) orgId = (await one(`SELECT organization_id FROM test_runs WHERE id = $1`, [runId]))?.organization_id;
  const thresholds = (await getSetting(orgId!, 'loadgen_thresholds')) as LoadgenThresholds;
  const servers = await query(
    `SELECT DISTINCT s.id, s.name, s.hostname, s.os, s.cpu_cores, s.memory_mb FROM server_metrics m JOIN servers s ON s.id = m.server_id
     WHERE m.run_id = $1 AND s.role = 'loadgen' ORDER BY s.name`, [runId], tsPool);
  if (!servers.length) return { thresholds, status: 'NO_DATA' as HostStatus, hosts: [] as LoadgenHost[], step: 0, series: [] as any[] };
  const ids = servers.map((s) => s.id);
  const host = await query(`SELECT server_id, extract(epoch from ts) * 1000 AS t, cpu_pct, memory_pct FROM server_metrics WHERE run_id = $1 AND server_id = ANY($2::uuid[]) ORDER BY ts`, [runId, ids], tsPool);
  const jvm = await query(`SELECT server_id, extract(epoch from ts) * 1000 AS t, heap_used_mb, heap_committed_mb, heap_max_mb, gc_time_ms FROM jvm_metrics WHERE run_id = $1 AND server_id = ANY($2::uuid[]) ORDER BY ts`, [runId, ids], tsPool);
  const proc = await query(
    `SELECT sv.server_id, sv.id service_id, extract(epoch from m.ts) * 1000 AS t, m.cpu_pct, m.memory_pct FROM service_metrics m JOIN services sv ON sv.id = m.service_id
     WHERE m.run_id = $1 AND sv.kind = 'loadgen' AND sv.server_id = ANY($2::uuid[]) ORDER BY m.ts`, [runId, ids], tsPool);

  const hosts: LoadgenHost[] = servers.map((s) => {
    const h = host.filter((r) => r.server_id === s.id);
    const j = jvm.filter((r) => r.server_id === s.id);
    const p = proc.filter((r) => r.server_id === s.id);
    const ev = evaluateHost({
      host: h.map((r) => ({ ts: Number(r.t), cpuPct: num(r.cpu_pct), memoryPct: num(r.memory_pct) })),
      heap: j.map((r) => ({ ts: Number(r.t), heapPct: heapPct(num(r.heap_used_mb), num(r.heap_max_mb), num(r.heap_committed_mb)) })),
    }, thresholds);
    const pc = p.map((r) => num(r.cpu_pct)).filter((v): v is number => v != null);
    const pm = p.map((r) => num(r.memory_pct)).filter((v): v is number => v != null);
    const hm = j.map((r) => num(r.heap_max_mb)).filter((v): v is number => v != null);
    const gc = j.map((r) => num(r.gc_time_ms)).filter((v): v is number => v != null);
    return {
      serverId: s.id, name: s.name, hostname: s.hostname, os: s.os, cpuCores: s.cpu_cores, memoryMb: s.memory_mb, status: ev.status, metrics: ev.metrics,
      jmeter: {
        serviceId: p[0]?.service_id ?? null,
        cpuPeak: pc.length ? Math.max(...pc) : null, cpuAvg: pc.length ? pc.reduce((a, b) => a + b, 0) / pc.length : null,
        rssPeakMb: pm.length && s.memory_mb ? (Math.max(...pm) / 100) * s.memory_mb : null,
        heapMaxMb: hm.length ? Math.max(...hm) : null, gcTimeMs: gc.length ? gc.reduce((a, b) => a + b, 0) : null,
      },
    };
  });

  // Bucketed chart series (≤ ~600 points per host)
  const all = [...host, ...jvm, ...proc].map((r) => Number(r.t));
  const span = all.length ? Math.max(...all) - Math.min(...all) : 0;
  const step = Math.max(1, Math.ceil(span / 1000 / 600));
  const buckets = new Map<string, any>();
  const acc = (sid: string, t: number, k: string, v: number | null) => {
    if (v == null) return;
    const bt = Math.floor(t / 1000 / step) * step * 1000;
    const key = `${sid}|${bt}`;
    let b = buckets.get(key);
    if (!b) { b = { t: bt, server_id: sid, _n: {} }; buckets.set(key, b); }
    b[k] = Math.max(b[k] ?? -Infinity, v); // max per bucket: saturation is about peaks
  };
  for (const r of host) { acc(r.server_id, Number(r.t), 'cpu_pct', num(r.cpu_pct)); acc(r.server_id, Number(r.t), 'memory_pct', num(r.memory_pct)); }
  for (const r of jvm) {
    acc(r.server_id, Number(r.t), 'heap_used_mb', num(r.heap_used_mb)); acc(r.server_id, Number(r.t), 'heap_committed_mb', num(r.heap_committed_mb));
    acc(r.server_id, Number(r.t), 'heap_max_mb', num(r.heap_max_mb)); acc(r.server_id, Number(r.t), 'heap_pct', heapPct(num(r.heap_used_mb), num(r.heap_max_mb), num(r.heap_committed_mb)));
    acc(r.server_id, Number(r.t), 'gc_time_ms', num(r.gc_time_ms));
  }
  const memOf = Object.fromEntries(servers.map((s) => [s.id, num(s.memory_mb)]));
  for (const r of proc) {
    acc(r.server_id, Number(r.t), 'jmeter_cpu_pct', num(r.cpu_pct));
    const mp = num(r.memory_pct);
    acc(r.server_id, Number(r.t), 'jmeter_rss_mb', mp != null && memOf[r.server_id] ? (mp / 100) * memOf[r.server_id]! : null);
  }
  const series = [...buckets.values()].map(({ _n, ...b }) => b).sort((a, b) => a.t - b.t);
  return { thresholds, status: overallStatus(hosts.map((h) => h.status)), hosts, step, series };
}
export type LoadgenHealthResult = Awaited<ReturnType<typeof loadgenHealth>>;
