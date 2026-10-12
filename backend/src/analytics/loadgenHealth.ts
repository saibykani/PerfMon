/**
 * Load generator health evaluation (pure — no database access, unit-tested).
 *
 * A load generator that runs out of CPU, memory or JVM heap caps throughput and inflates
 * response times, so the results describe the generator rather than the system under test.
 * Each metric is compared with a warning and a critical threshold; a level is only reached
 * when at least `minSharePct` % of the samples are at or above it (a single spike is ignored).
 */

export interface LoadgenThresholds {
  cpuWarnPct: number; cpuCritPct: number;
  memWarnPct: number; memCritPct: number;
  heapWarnPct: number; heapCritPct: number;
  /** Minimum share of samples (0–100 %) at/above a threshold before the level is reported. */
  minSharePct: number;
}

export type MetricLevel = 'OK' | 'WARNING' | 'CRITICAL' | 'NO_DATA';
export type HostStatus = 'HEALTHY' | 'WARNING' | 'SATURATED' | 'NO_DATA';

export interface MetricEvaluation {
  metric: 'cpu' | 'memory' | 'heap';
  label: string;
  samples: number;
  peak: number | null;
  avg: number | null;
  warn: number;
  crit: number;
  /** % of samples at or above the warning / critical threshold. */
  shareAboveWarnPct: number;
  shareAboveCritPct: number;
  /** First and last timestamp (ms) at or above the warning threshold. */
  firstAboveTs: number | null;
  lastAboveTs: number | null;
  level: MetricLevel;
}

export interface HostSamples {
  /** Host metrics: total CPU % and memory % of the load-generator machine. */
  host: { ts: number; cpuPct: number | null; memoryPct: number | null }[];
  /** JMeter JVM heap usage in % of the maximum heap (or of committed heap when max is unknown). */
  heap: { ts: number; heapPct: number | null }[];
}

const LABEL = { cpu: 'CPU', memory: 'Memory', heap: 'JMeter heap' } as const;

export function evaluateMetric(metric: MetricEvaluation['metric'], points: { ts: number; v: number | null }[], warn: number, crit: number, minSharePct: number): MetricEvaluation {
  const pts = points.filter((p) => p.v != null && Number.isFinite(p.v)) as { ts: number; v: number }[];
  const base: MetricEvaluation = { metric, label: LABEL[metric], samples: pts.length, peak: null, avg: null, warn, crit, shareAboveWarnPct: 0, shareAboveCritPct: 0, firstAboveTs: null, lastAboveTs: null, level: 'NO_DATA' };
  if (!pts.length) return base;
  let peak = -Infinity, sum = 0, nWarn = 0, nCrit = 0, first: number | null = null, last: number | null = null;
  for (const p of pts) {
    peak = Math.max(peak, p.v); sum += p.v;
    if (p.v >= warn) { nWarn++; if (first == null || p.ts < first) first = p.ts; if (last == null || p.ts > last) last = p.ts; }
    if (p.v >= crit) nCrit++;
  }
  const shareWarn = (nWarn / pts.length) * 100;
  const shareCrit = (nCrit / pts.length) * 100;
  // a share of 0 never triggers, even when minSharePct is 0
  const level: MetricLevel = nCrit > 0 && shareCrit >= minSharePct ? 'CRITICAL' : nWarn > 0 && shareWarn >= minSharePct ? 'WARNING' : 'OK';
  return { ...base, peak, avg: sum / pts.length, shareAboveWarnPct: shareWarn, shareAboveCritPct: shareCrit, firstAboveTs: first, lastAboveTs: last, level };
}

export function hostStatus(metrics: MetricEvaluation[]): HostStatus {
  if (metrics.every((m) => m.level === 'NO_DATA')) return 'NO_DATA';
  if (metrics.some((m) => m.level === 'CRITICAL')) return 'SATURATED';
  if (metrics.some((m) => m.level === 'WARNING')) return 'WARNING';
  return 'HEALTHY';
}

export function evaluateHost(s: HostSamples, t: LoadgenThresholds) {
  const metrics = [
    evaluateMetric('cpu', s.host.map((x) => ({ ts: x.ts, v: x.cpuPct })), t.cpuWarnPct, t.cpuCritPct, t.minSharePct),
    evaluateMetric('memory', s.host.map((x) => ({ ts: x.ts, v: x.memoryPct })), t.memWarnPct, t.memCritPct, t.minSharePct),
    evaluateMetric('heap', s.heap.map((x) => ({ ts: x.ts, v: x.heapPct })), t.heapWarnPct, t.heapCritPct, t.minSharePct),
  ];
  return { status: hostStatus(metrics), metrics };
}

const RANK: Record<HostStatus, number> = { NO_DATA: 0, HEALTHY: 1, WARNING: 2, SATURATED: 3 };
export function overallStatus(statuses: HostStatus[]): HostStatus {
  return statuses.reduce<HostStatus>((a, s) => (RANK[s] > RANK[a] ? s : a), 'NO_DATA');
}

/** Heap usage % from a jvm sample: used / max, falling back to used / committed. */
export function heapPct(used: number | null | undefined, max: number | null | undefined, committed: number | null | undefined): number | null {
  if (used == null) return null;
  const denom = max && max > 0 ? max : committed && committed > 0 ? committed : null;
  return denom ? Math.min(100, (used / denom) * 100) : null;
}

const r1 = (v: number | null) => (v == null ? 'n/a' : `${Math.round(v * 10) / 10}%`);
const hhmmss = (ts: number | null) => (ts == null ? '' : new Date(ts).toISOString().slice(11, 19));

/** Human-readable evidence lines for metrics at WARNING or CRITICAL (timestamps in UTC). */
export function evidenceLines(host: string, metrics: MetricEvaluation[]): string[] {
  return metrics.filter((m) => m.level === 'WARNING' || m.level === 'CRITICAL').map((m) => {
    const crit = m.level === 'CRITICAL';
    const share = crit ? m.shareAboveCritPct : m.shareAboveWarnPct;
    return `${host}: ${m.label} peak ${r1(m.peak)}, at or above ${crit ? m.crit : m.warn}% (${crit ? 'critical' : 'warning'}) for ${r1(share)} of ${m.samples} samples`
      + (m.firstAboveTs != null ? ` (${hhmmss(m.firstAboveTs)} → ${hhmmss(m.lastAboveTs)} UTC)` : '');
  });
}

export interface LoadgenSummary {
  status: HostStatus;
  hosts: { name: string; status: HostStatus; metrics: MetricEvaluation[] }[];
}

/** Insight (title/severity/evidence/recommendations) for a load generator at WARNING or SATURATED, else null. */
export function loadgenInsight(sum: LoadgenSummary) {
  if (sum.status !== 'WARNING' && sum.status !== 'SATURATED') return null;
  const saturated = sum.status === 'SATURATED';
  const bad = sum.hosts.filter((h) => h.status === 'WARNING' || h.status === 'SATURATED');
  const evidence = bad.flatMap((h) => evidenceLines(h.name, h.metrics));
  const hit = new Set(bad.flatMap((h) => h.metrics.filter((m) => m.level === 'WARNING' || m.level === 'CRITICAL').map((m) => m.metric)));
  const recs: { title: string; description: string; priority: 'LOW' | 'MEDIUM' | 'HIGH'; category: string }[] = [];
  if (hit.has('cpu')) recs.push({ category: 'LOAD_GENERATOR', priority: saturated ? 'HIGH' : 'MEDIUM', title: 'Add load generators or reduce threads per generator', description: 'The load generator CPU was the limiting resource. Distribute the load over more JMeter engines (remote/distributed mode) or reduce the number of threads per engine; remove listeners, heavy assertions and post-processors that run during the test.' });
  if (hit.has('memory')) recs.push({ category: 'LOAD_GENERATOR', priority: saturated ? 'HIGH' : 'MEDIUM', title: 'Free memory on the load generator', description: 'The load generator host ran short of memory. Stop other processes on the machine, use a larger instance, or spread the threads over more generators.' });
  if (hit.has('heap')) recs.push({ category: 'LOAD_GENERATOR', priority: saturated ? 'HIGH' : 'MEDIUM', title: 'Raise the JMeter heap', description: 'The JMeter JVM heap was nearly full, which causes long GC pauses inside the load generator. Raise the heap (e.g. HEAP="-Xms2g -Xmx4g" before starting jmeter), run in non-GUI mode and avoid "View Results Tree"/in-memory listeners.' });
  return {
    category: 'LOAD_GENERATOR', severity: (saturated ? 'CRITICAL' : 'WARNING') as 'CRITICAL' | 'WARNING', component: 'Load generator',
    title: saturated ? 'Load generator saturated — results may be unreliable' : 'Load generator under pressure — results may be affected',
    description: saturated
      ? `${bad.filter((h) => h.status === 'SATURATED').map((h) => h.name).join(', ')} exceeded the critical load-generator thresholds. Throughput and response times may reflect the load generator, not the system under test.`
      : `${bad.map((h) => h.name).join(', ')} exceeded the load-generator warning thresholds. Check the Load generators tab before trusting these results.`,
    evidence, recommendations: recs,
  };
}
