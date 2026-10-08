import { describe, expect, it } from 'vitest';
import { alignSeries, linearRegression, mean, pctChange, pearson, percentileOf, round, stddev } from './stats.js';

describe('stats helpers', () => {
  it('mean / stddev', () => {
    expect(mean([])).toBeNaN();
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(stddev([5])).toBe(0);
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3); // sample stddev
  });

  it('percentileOf uses nearest rank and does not mutate the input', () => {
    const xs = [5, 1, 4, 2, 3];
    expect(percentileOf(xs, 50)).toBe(3);
    expect(percentileOf(xs, 0)).toBe(1);
    expect(percentileOf(xs, 100)).toBe(5);
    expect(percentileOf(xs, 81)).toBe(5);
    expect(xs).toEqual([5, 1, 4, 2, 3]);
    expect(percentileOf([], 50)).toBeNull();
  });

  it('pearson needs ≥5 points and non-constant series', () => {
    expect(pearson([1, 2, 3, 4], [1, 2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1);
    expect(pearson([1, 2, 3, 4, 5], [3, 3, 3, 3, 3])).toBeNull();
  });

  it('linearRegression fits y = a + bx with r²', () => {
    const r = linearRegression([1, 2, 3, 4], [3, 5, 7, 9])!;
    expect(r.slope).toBeCloseTo(2);
    expect(r.intercept).toBeCloseTo(1);
    expect(r.r2).toBeCloseTo(1);
    expect(r.predict(10)).toBeCloseTo(21);
    expect(linearRegression([1], [1])).toBeNull();
    expect(linearRegression([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(linearRegression([1, 2, 3], [4, 4, 4])!.r2).toBe(1);
  });

  it('pctChange / round', () => {
    expect(pctChange(100, 110)).toBeCloseTo(10);
    expect(pctChange(-50, -25)).toBeCloseTo(50);
    expect(pctChange(0, 5)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(NaN)).toBeNull();
    expect(round(undefined)).toBeNull();
  });

  it('alignSeries pairs values sharing a time step', () => {
    const [xs, ys] = alignSeries(
      [{ t: 1000, v: 1 }, { t: 2000, v: 2 }, { t: 3500, v: 3 }],
      [{ t: 1400, v: 10 }, { t: 3999, v: 30 }, { t: 9000, v: 90 }],
      1000,
    );
    expect(xs).toEqual([1, 3]);
    expect(ys).toEqual([10, 30]);
  });
});
