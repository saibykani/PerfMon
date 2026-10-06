/**
 * In-process self-observability registry. Exposed as Prometheus text at /metrics
 * and as JSON on the System Health page.
 */
type Summary = { count: number; sum: number; max: number; window: number[] };

class Registry {
  counters = new Map<string, number>();
  gauges = new Map<string, number>();
  summaries = new Map<string, Summary>();
  startedAt = Date.now();
  // rolling per-second rate tracking for selected counters
  private rateSnapshots = new Map<string, { t: number; v: number }[]>();

  inc(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  set(name: string, v: number) {
    this.gauges.set(name, v);
  }
  observe(name: string, v: number) {
    let s = this.summaries.get(name);
    if (!s) this.summaries.set(name, (s = { count: 0, sum: 0, max: 0, window: [] }));
    s.count++;
    s.sum += v;
    if (v > s.max) s.max = v;
    s.window.push(v);
    if (s.window.length > 2000) s.window.splice(0, s.window.length - 2000);
  }
  quantile(name: string, q: number) {
    const w = this.summaries.get(name)?.window;
    if (!w?.length) return null;
    const s = [...w].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }
  /** Rate per second of a counter over the last ~60s (sampled by sampleRates). */
  rate(name: string) {
    const snaps = this.rateSnapshots.get(name);
    if (!snaps || snaps.length < 2) return 0;
    const a = snaps[0];
    const b = snaps[snaps.length - 1];
    return b.t === a.t ? 0 : ((b.v - a.v) * 1000) / (b.t - a.t);
  }
  sampleRates() {
    const now = Date.now();
    for (const [k, v] of this.counters) {
      const arr = this.rateSnapshots.get(k) ?? [];
      arr.push({ t: now, v });
      while (arr.length && now - arr[0].t > 60000) arr.shift();
      this.rateSnapshots.set(k, arr);
    }
  }
  prometheus(): string {
    const lines: string[] = [];
    const name = (n: string) => 'perfmon_' + n.replace(/[^a-zA-Z0-9_]/g, '_');
    for (const [k, v] of this.counters) lines.push(`# TYPE ${name(k)}_total counter`, `${name(k)}_total ${v}`);
    for (const [k, v] of this.gauges) lines.push(`# TYPE ${name(k)} gauge`, `${name(k)} ${v}`);
    for (const [k, s] of this.summaries) {
      lines.push(`# TYPE ${name(k)} summary`);
      for (const q of [0.5, 0.95, 0.99]) lines.push(`${name(k)}{quantile="${q}"} ${this.quantile(k, q) ?? 0}`);
      lines.push(`${name(k)}_sum ${s.sum}`, `${name(k)}_count ${s.count}`);
    }
    const mem = process.memoryUsage();
    lines.push(`perfmon_process_heap_used_bytes ${mem.heapUsed}`, `perfmon_process_rss_bytes ${mem.rss}`, `perfmon_process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    return lines.join('\n') + '\n';
  }
}

export const selfMetrics = new Registry();
setInterval(() => selfMetrics.sampleRates(), 5000).unref();
