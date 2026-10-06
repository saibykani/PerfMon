export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function stddev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Exact percentile (nearest-rank) of an unsorted array. */
export function percentileOf(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

/** Pearson correlation coefficient of two equal-length series; null when undefined. */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/** Ordinary least squares y = a + b x. */
export function linearRegression(xs: number[], ys: number[]) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, predict: (x: number) => intercept + slope * x };
}

export const pctChange = (prev: number | null | undefined, curr: number | null | undefined) =>
  prev == null || curr == null || prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100;

export const round = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Align two (ts,value) series on common timestamps (bucketed to `stepMs`). */
export function alignSeries(a: { t: number; v: number }[], b: { t: number; v: number }[], stepMs: number) {
  const bm = new Map<number, number>();
  for (const p of b) bm.set(Math.floor(p.t / stepMs), p.v);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of a) {
    const k = Math.floor(p.t / stepMs);
    const v = bm.get(k);
    if (v != null && Number.isFinite(v) && Number.isFinite(p.v)) { xs.push(p.v); ys.push(v); }
  }
  return [xs, ys] as const;
}
