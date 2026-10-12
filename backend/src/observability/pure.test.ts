import { describe, expect, it } from 'vitest';
import {
  InputError, aggregate, bucketCount, bucketStart, bucketize, chooseStep, fillGrid, parseAgg, parseFilters, parseInstant, parseMetricKeys,
  percentileCont, rawStats, resolveWindow, AGG_SQL, AGGS,
} from './pure.js';
import { METRICS, METRIC_BY_KEY, METRIC_KEYS, SOURCES } from './catalog.js';
import { collectionStep, jitterMs, nextWindow } from './collection.js';
import { reportStep } from '../reports/observability.js';

const T = (s: string) => Date.parse(s);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('time window', () => {
  it('requires a timezone and accepts epoch ms', () => {
    expect(parseInstant('2026-10-12T09:15:00Z', 'from')!.toISOString()).toBe('2026-10-12T09:15:00.000Z');
    expect(parseInstant('2026-10-12T11:15+02:00', 'from')!.toISOString()).toBe('2026-10-12T09:15:00.000Z');
    expect(parseInstant('1760260500000', 'from')!.getTime()).toBe(1760260500000);
    expect(() => parseInstant('2026-10-12T09:15:00', 'from')).toThrow(InputError);
    expect(() => parseInstant('yesterday', 'from')).toThrow(InputError);
    expect(parseInstant('', 'from')).toBeUndefined();
  });
  it('defaults to the last hour, rejects inverted and > 90 day windows', () => {
    const now = T('2026-10-12T10:00:00Z');
    const w = resolveWindow(undefined, undefined, now);
    expect(w.to.getTime() - w.from.getTime()).toBe(3600_000);
    expect(() => resolveWindow('2026-10-12T10:00:00Z', '2026-10-12T09:00:00Z')).toThrow(/before/);
    expect(() => resolveWindow('2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')).toThrow(/before/);
    expect(() => resolveWindow('2026-07-01T00:00:00Z', '2026-10-12T00:00:00Z')).toThrow(/90 days/);
    expect(() => resolveWindow('2026-07-14T00:00:00Z', '2026-10-12T00:00:00Z')).not.toThrow(); // exactly 90 days
  });
});

describe('buckets and step selection', () => {
  it('aligns to floor(epoch/step)*step', () => {
    expect(bucketStart(T('2026-10-12T09:15:59.999Z'), 60)).toBe(T('2026-10-12T09:15:00Z'));
    expect(bucketStart(T('2026-10-12T09:16:00Z'), 60)).toBe(T('2026-10-12T09:16:00Z'));
    expect(bucketStart(T('2026-10-12T09:17:00Z'), 300)).toBe(T('2026-10-12T09:15:00Z'));
    expect(bucketStart(T('2026-10-12T13:00:00Z'), 21600)).toBe(T('2026-10-12T12:00:00Z'));
  });
  it('counts buckets of [from, to) — exclusive end', () => {
    expect(bucketCount(T('2026-10-12T09:00:00Z'), T('2026-10-12T10:00:00Z'), 60)).toBe(60);
    expect(bucketCount(T('2026-10-12T09:00:30Z'), T('2026-10-12T10:00:00Z'), 60)).toBe(60);
    expect(bucketCount(T('2026-10-12T09:00:30Z'), T('2026-10-12T10:00:30Z'), 60)).toBe(61);
  });
  it('auto picks the smallest candidate with ≤ 600 points', () => {
    const f = T('2026-10-12T00:00:00Z');
    expect(chooseStep(f, f + 3600_000, 'auto')).toBe(10);          // 360 points
    expect(chooseStep(f, f + 6 * 3600_000)).toBe(60);               // 10 s → 2160, 15 → 1440, 30 → 720, 60 → 360
    expect(chooseStep(f, f + 86400_000)).toBe(300);                 // 288
    expect(chooseStep(f, f + 7 * 86400_000)).toBe(1800);            // 336
    expect(chooseStep(f, f + 90 * 86400_000)).toBe(21600);          // 360
  });
  it('honours an explicit step and raises it beyond 2 000 points', () => {
    const f = T('2026-10-12T00:00:00Z');
    expect(chooseStep(f, f + 3600_000, '45')).toBe(45);
    expect(chooseStep(f, f + 86400_000, '10')).toBe(60);            // 8640 → 1440 at 60 s (30 s = 2880)
    expect(() => chooseStep(f, f + 3600_000, '5')).toThrow(InputError);
    expect(() => chooseStep(f, f + 3600_000, 'abc')).toThrow(InputError);
  });
  it('fills the grid with null for empty buckets, never interpolating', () => {
    const f = T('2026-10-12T09:00:00Z');
    const grid = fillGrid(f, f + 300_000, 60, [[f / 1000, 1], [(f + 180_000) / 1000, 4]]);
    expect(grid).toEqual([[f, 1], [f + 60_000, null], [f + 120_000, null], [f + 180_000, 4], [f + 240_000, null]]);
  });
  it('report step keeps ≤ 300 points', () => {
    const f = T('2026-10-12T00:00:00Z');
    expect(reportStep(f, f + 3600_000)).toBe(15);
    expect(reportStep(f, f + 86400_000)).toBe(300);
  });
});

describe('stats (raw samples) and aggregation', () => {
  it('percentile_cont semantics', () => {
    expect(percentileCont([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 10);
    expect(percentileCont([10], 0.95)).toBe(10);
    expect(percentileCont([], 0.95)).toBeNull();
  });
  it('rawStats uses every sample, earliest time of max, latest value as last', () => {
    const s = rawStats([[3000, 5], [1000, 9], [2000, 9], [4000, 1], [5000, null]]);
    expect(s).toEqual({ min: 1, avg: 6, max: 9, p95: 9, last: 1, samples: 4, maxTs: 1000, lastTs: 4000 });
    expect(rawStats([]).samples).toBe(0);
  });
  it('stats differ from averages of bucket averages (why raw samples matter)', () => {
    const f = T('2026-10-12T09:00:00Z');
    const samples: [number, number][] = [[f, 10], [f + 10_000, 20], [f + 20_000, 30], [f + 60_000, 100]];
    const buckets = bucketize(samples, 60, 'avg');
    expect(buckets).toEqual([[f, 20], [f + 60_000, 100]]);
    expect(rawStats(samples).avg).toBe(40);   // bucket-average mean would be 60
  });
  it('aggregates per bucket', () => {
    const v: [number, number][] = [[1, 4], [3, 2], [2, 6]];
    expect(aggregate(v, 'avg')).toBe(4);
    expect(aggregate(v, 'min')).toBe(2);
    expect(aggregate(v, 'max')).toBe(6);
    expect(aggregate(v, 'sum')).toBe(12);
    expect(aggregate(v, 'last')).toBe(2);
    expect(aggregate(v, 'p95')).toBeCloseTo(5.8, 10);
    expect(Object.keys(AGG_SQL).sort()).toEqual([...AGGS].sort());
    expect(parseAgg(undefined)).toBe('avg');
    expect(parseAgg('P95')).toBe('p95');
    expect(() => parseAgg('median')).toThrow(InputError);
  });
});

describe('filters and metric keys', () => {
  it('parses comma lists, dedups, validates UUIDs and lowercases role', () => {
    const f = parseFilters({ projectId: `${U1}, ${U2},${U1}`, namespace: 'shop,payments', role: 'LoadGen', hostId: '', bogus: 'x' });
    expect(f).toEqual({ projectId: [U1, U2], namespace: ['shop', 'payments'], role: ['loadgen'] });
    expect(parseFilters({ cluster: [U1] })).toEqual({ cluster: [U1] });
    expect(() => parseFilters({ hostId: 'not-a-uuid' })).toThrow(InputError);
    expect(() => parseFilters({ pod: Array.from({ length: 101 }, (_, i) => `p${i}`).join(',') })).toThrow(/at most/);
  });
  it('accepts only whitelisted metric keys', () => {
    expect(parseMetricKeys('host.cpu_pct, db.tps,host.cpu_pct', METRIC_KEYS)).toEqual(['host.cpu_pct', 'db.tps']);
    expect(() => parseMetricKeys('host.cpu_pct;DROP TABLE x', METRIC_KEYS)).toThrow(/Unknown/);
    expect(() => parseMetricKeys('', METRIC_KEYS)).toThrow(/required/);
  });
  it('catalogue maps every key to a real column of its source table', () => {
    const contract = ['host.cpu_pct', 'host.memory_pct', 'host.memory_used_mb', 'host.disk_pct', 'host.load_1m', 'host.net_rx_kbps', 'host.net_tx_kbps',
      'db.query_latency_ms', 'db.connections_active', 'db.pool_pct', 'db.slow_queries', 'db.locks', 'db.deadlocks', 'db.tps', 'db.cpu_pct',
      'svc.request_rate', 'svc.error_pct', 'svc.latency_ms', 'svc.cpu_pct', 'jvm.heap_used_mb', 'jvm.heap_pct', 'jvm.gc_pause_ms', 'jvm.threads',
      'k8s.pod.cpu_millicores', 'k8s.pod.memory_mb', 'k8s.pod.restarts', 'k8s.node.cpu_millicores', 'k8s.node.memory_mb', 'run.tps', 'run.p95_ms', 'run.error_pct', 'run.active_users'];
    for (const k of contract) expect(METRIC_BY_KEY.has(k), k).toBe(true);
    expect(METRIC_BY_KEY.get('host.load_1m')!.expr).toBe('m.load_avg_1m');
    expect(METRIC_BY_KEY.get('jvm.gc_pause_ms')!.expr).toBe('m.gc_max_pause_ms');
    expect(METRIC_BY_KEY.get('k8s.pod.memory_mb')!.pointMetric).toBe('k8s.pod.memory_bytes');   // sampler.ts metric name
    expect(METRIC_BY_KEY.get('k8s.pod.cpu_millicores')!.pointMetric).toBe('k8s.pod.cpu_mcores');
    for (const m of METRICS) {
      expect(SOURCES[m.source], m.key).toBeDefined();
      expect(m.expr).not.toMatch(/\$|;|--/);                 // constant SQL only
      if (m.source.startsWith('k8s')) expect(m.pointMetric).toBeTruthy();
    }
    // role filter reaches hosts, databases, JVMs and services (load generators)
    for (const s of ['host', 'database', 'jvm', 'service'] as const) expect(SOURCES[s].filters.role).toBe('lower(h.role)');
  });
});

describe('continuous collection windows', () => {
  it('cuts windows at step boundaries after the lag and continues from the watermark', () => {
    const now = T('2026-10-12T10:00:37Z');
    expect(collectionStep('INFLUXDB')).toEqual({ stepSec: 10, lagSec: 20 });
    const first = nextWindow(now, 'INFLUXDB', 60, null);
    expect(first).toEqual({ from: T('2026-10-12T09:59:10Z'), to: T('2026-10-12T10:00:10Z'), stepSec: 10 });
    const next = nextWindow(now + 60_000, 'INFLUXDB', 60, first.to);
    expect(next.from).toBe(first.to);                       // no overlap, no gap
    expect(next.to).toBe(T('2026-10-12T10:01:10Z'));
    const dt = nextWindow(now, 'DYNATRACE', 300, null);
    expect(dt.to).toBe(T('2026-10-12T09:58:00Z'));
    expect(dt.from).toBe(T('2026-10-12T09:53:00Z'));
  });
  it('caps catch-up after downtime to 6 h and jitters deterministically', () => {
    const now = T('2026-10-12T10:00:00Z');
    const w = nextWindow(now, 'PROMETHEUS', 60, T('2026-10-10T00:00:00Z'));
    expect(w.to - w.from).toBeLessThanOrEqual(6 * 3600_000);
    expect(jitterMs(U1, 60)).toBe(jitterMs(U1, 60));
    expect(jitterMs(U1, 60)).toBeLessThan(6000);
  });
});
