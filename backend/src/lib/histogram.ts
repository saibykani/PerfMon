/**
 * Log-bucketed latency histogram (≈2.5% relative precision).
 *
 * Percentiles cannot be averaged across time buckets. When raw samples are
 * available Perfmon records a histogram per bucket so that percentiles over
 * any window (whole run, zoomed range, downsampled series) are computed by
 * merging histograms — never by averaging percentiles.
 *
 * Storage format is sparse: [bucketIndex, count, bucketIndex, count, ...]
 */
const GROWTH = 1.05;
const LOG_G = Math.log(GROWTH);

export function bucketOf(ms: number): number {
  if (!(ms >= 1)) return 0;
  return Math.floor(Math.log(ms) / LOG_G) + 1;
}

export function bucketValue(idx: number): number {
  if (idx <= 0) return 0.5;
  // geometric midpoint of [G^(i-1), G^i)
  return Math.pow(GROWTH, idx - 1 + 0.5);
}

export class Histogram {
  counts = new Map<number, number>();
  total = 0;

  record(ms: number, n = 1) {
    const b = bucketOf(ms);
    this.counts.set(b, (this.counts.get(b) ?? 0) + n);
    this.total += n;
  }

  mergeSparse(sparse: number[] | null | undefined) {
    if (!sparse) return;
    for (let i = 0; i + 1 < sparse.length; i += 2) {
      this.counts.set(sparse[i], (this.counts.get(sparse[i]) ?? 0) + sparse[i + 1]);
      this.total += sparse[i + 1];
    }
  }

  merge(other: Histogram) {
    for (const [b, c] of other.counts) this.counts.set(b, (this.counts.get(b) ?? 0) + c);
    this.total += other.total;
  }

  toSparse(): number[] {
    const out: number[] = [];
    for (const b of [...this.counts.keys()].sort((a, z) => a - z)) out.push(b, this.counts.get(b)!);
    return out;
  }

  /** p in [0,100]. Clamped into [min,max] when provided. */
  percentile(p: number, min?: number | null, max?: number | null): number | null {
    if (this.total === 0) return null;
    const rank = Math.max(1, Math.ceil((p / 100) * this.total));
    let cum = 0;
    for (const b of [...this.counts.keys()].sort((a, z) => a - z)) {
      cum += this.counts.get(b)!;
      if (cum >= rank) {
        let v = bucketValue(b);
        if (min != null && v < min) v = min;
        if (max != null && v > max) v = max;
        return v;
      }
    }
    return max ?? null;
  }

  /** Distribution for latency-distribution charts: [{ from, to, count }] */
  distribution(): { from: number; to: number; count: number }[] {
    return [...this.counts.keys()].sort((a, z) => a - z).map((b) => ({
      from: b <= 0 ? 0 : Math.pow(GROWTH, b - 1),
      to: Math.pow(GROWTH, b),
      count: this.counts.get(b)!,
    }));
  }
}

export function histogramFromSparseList(list: (number[] | null)[]): Histogram | null {
  if (!list.length || list.some((h) => !h)) return null;
  const h = new Histogram();
  for (const s of list) h.mergeSparse(s);
  return h;
}
