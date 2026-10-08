import { describe, expect, it } from 'vitest';
import { Histogram, bucketOf, bucketValue, histogramFromSparseList } from './histogram.js';
import { percentileOf } from './stats.js';

/** Deterministic PRNG (mulberry32) so the "random" latency data is identical on every run. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Log-normal-ish latencies between ~5 ms and a few seconds. */
function latencies(n: number, seed: number) {
  const r = rng(seed);
  return Array.from({ length: n }, () => Math.round(Math.exp(3 + r() * 2 + r() * 2 + (r() < 0.02 ? 2 : 0)) * 10) / 10);
}

describe('bucketOf / bucketValue', () => {
  it('maps sub-millisecond and invalid values to bucket 0', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(0.4)).toBe(0);
    expect(bucketOf(-5)).toBe(0);
    expect(bucketOf(NaN)).toBe(0);
    expect(bucketValue(0)).toBe(0.5);
  });

  it('has ≈2.5% relative error at the bucket midpoint for any value ≥ 1 ms', () => {
    for (const v of [1, 1.7, 12, 99.9, 250, 1234, 60000, 3.6e6]) {
      const mid = bucketValue(bucketOf(v));
      expect(Math.abs(mid - v) / v).toBeLessThanOrEqual(0.0251);
    }
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let v = 1; v < 100000; v *= 1.01) {
      const b = bucketOf(v);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });
});

describe('Histogram', () => {
  it('returns null for an empty histogram', () => {
    expect(new Histogram().percentile(95)).toBeNull();
  });

  it('clamps percentiles into [min, max]', () => {
    const h = new Histogram();
    h.record(100);
    expect(h.percentile(50, 100, 100)).toBe(100);
    expect(h.percentile(99, 0, 99)).toBe(99);
  });

  it('sparse round trip preserves counts and order', () => {
    const h = new Histogram();
    for (const v of [5, 5, 1000, 0.2, 42]) h.record(v);
    h.record(42, 3);
    const sparse = h.toSparse();
    const keys = sparse.filter((_, i) => i % 2 === 0);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    const back = new Histogram();
    back.mergeSparse(sparse);
    expect(back.total).toBe(8);
    expect(back.toSparse()).toEqual(sparse);
    back.mergeSparse(null);
    expect(back.total).toBe(8);
  });

  it('distribution buckets cover the recorded values', () => {
    const h = new Histogram();
    h.record(0.5);
    h.record(100);
    const d = h.distribution();
    expect(d[0]).toEqual({ from: 0, to: 1, count: 1 });
    expect(d[1].from).toBeLessThanOrEqual(100);
    expect(d[1].to).toBeGreaterThan(100);
  });

  it('percentiles of per-second histograms merged together match exact percentiles within the ~2.5% resolution', () => {
    const all: number[] = [];
    const perSecond: number[][] = [];
    for (let s = 0; s < 60; s++) {
      const xs = latencies(200 + (s % 7) * 50, 1000 + s);
      all.push(...xs);
      const h = new Histogram();
      for (const x of xs) h.record(x);
      perSecond.push(h.toSparse());
    }
    const merged = histogramFromSparseList(perSecond)!;
    expect(merged.total).toBe(all.length);
    const min = Math.min(...all);
    const max = Math.max(...all);
    for (const p of [50, 75, 90, 95, 99, 99.9]) {
      const exact = percentileOf(all, p)!;
      const approx = merged.percentile(p, min, max)!;
      expect(Math.abs(approx - exact) / exact).toBeLessThanOrEqual(0.026);
    }
  });

  it('merge() equals recording everything into one histogram', () => {
    const a = new Histogram();
    const b = new Histogram();
    const all = new Histogram();
    latencies(500, 7).forEach((x, i) => { (i % 2 ? a : b).record(x); all.record(x); });
    a.merge(b);
    expect(a.toSparse()).toEqual(all.toSparse());
    expect(a.total).toBe(all.total);
  });

  it('histogramFromSparseList returns null when any bucket lacks a histogram (aggregated data)', () => {
    expect(histogramFromSparseList([])).toBeNull();
    expect(histogramFromSparseList([[10, 1], null])).toBeNull();
  });
});
