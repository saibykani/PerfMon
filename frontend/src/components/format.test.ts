import { describe, expect, it } from 'vitest';
import { approx, fmtBytes, fmtDate, fmtDuration, fmtMs, fmtNum, fmtPct, fmtRelative } from './format';

describe('fmtMs', () => {
  it('formats ms below 1 s, seconds with 2 decimals below 10 s, then 1 decimal', () => {
    expect(fmtMs(0)).toBe('0 ms');
    expect(fmtMs(12.4)).toBe('12 ms');
    expect(fmtMs(999)).toBe('999 ms');
    expect(fmtMs(1000)).toBe('1.00 s');
    expect(fmtMs(1234)).toBe('1.23 s');
    expect(fmtMs(9999)).toBe('10.00 s');
    expect(fmtMs(10000)).toBe('10.0 s');
    expect(fmtMs(65432)).toBe('65.4 s');
  });

  it('renders a dash for missing values', () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(fmtMs(v as any)).toBe('—');
  });
});

describe('fmtPct', () => {
  it('uses 2 decimals by default', () => {
    expect(fmtPct(1.234)).toBe('1.23%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtPct(99.999, 1)).toBe('100.0%');
    expect(fmtPct(-3, 0)).toBe('-3%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
  });
});

describe('fmtBytes', () => {
  it('scales by 1024 with sensible precision', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(150 * 1024)).toBe('150 KB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(fmtBytes(2048 * 1024 ** 4)).toBe('2048 TB');
    expect(fmtBytes(undefined)).toBe('—');
  });
});

describe('fmtDuration', () => {
  it('formats seconds as s / m s / h m', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(59.4)).toBe('59s');
    expect(fmtDuration(59.6)).toBe('1m 0s');
    expect(fmtDuration(125)).toBe('2m 5s');
    expect(fmtDuration(3600)).toBe('1h 0m');
    expect(fmtDuration(3 * 3600 + 25 * 60 + 59)).toBe('3h 25m');
    expect(fmtDuration(null)).toBe('—');
  });
});

describe('fmtNum', () => {
  it('formats with fixed decimals and handles missing values', () => {
    expect(fmtNum(3.14159, 2)).toBe((3.14).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(fmtNum(1234567)).toBe((1234567).toLocaleString(undefined, { maximumFractionDigits: 0 }));
    expect(fmtNum(null)).toBe('—');
  });
});

describe('fmtRelative', () => {
  const now = Date.parse('2026-01-15T12:00:00Z');
  const ago = (sec: number) => now - sec * 1000;

  it('describes past times', () => {
    expect(fmtRelative(ago(10), now)).toBe('just now');
    expect(fmtRelative(ago(44), now)).toBe('just now');
    expect(fmtRelative(ago(45), now)).toBe('1 min ago');
    expect(fmtRelative(ago(30 * 60), now)).toBe('30 min ago');
    expect(fmtRelative(ago(3 * 3600), now)).toBe('3 h ago');
    expect(fmtRelative(ago(86400), now)).toBe('1 day ago');
    expect(fmtRelative(ago(5 * 86400), now)).toBe('5 days ago');
  });

  it('describes future times', () => {
    expect(fmtRelative(ago(-10), now)).toBe('in a moment');
    expect(fmtRelative(ago(-2 * 3600), now)).toBe('in 2 h');
    expect(fmtRelative(ago(-3 * 86400), now)).toBe('in 3 days');
  });

  it('falls back to the date beyond 30 days and handles invalid input', () => {
    const old = ago(40 * 86400);
    expect(fmtRelative(old, now)).toBe(fmtDate(old));
    expect(fmtRelative(null, now)).toBe('—');
    expect(fmtRelative('not a date', now)).toBe('—');
    expect(fmtRelative(new Date(ago(120)).toISOString(), now)).toBe('2 min ago');
  });
});

describe('fmtDate / approx', () => {
  it('fmtDate renders a dash for empty values', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(0)).toBe('—');
    expect(fmtDate('2026-01-15T12:00:00Z')).not.toBe('—');
  });

  it('approx marks interval-weighted approximations only', () => {
    expect(approx('interval_weighted_approx')).toBe('≈ ');
    expect(approx('histogram')).toBe('');
    expect(approx(null)).toBe('');
  });
});
