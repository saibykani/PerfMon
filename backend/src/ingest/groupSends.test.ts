import { describe, expect, it } from 'vitest';
import { groupSends } from './routes.js';

const row = (txn: string, ts: number, kind: string, count = 1) => ({ txn, ts, kind, data: { count, __txn: txn } });

describe('groupSends (JMeter InfluxDB Backend Listener lines → sends)', () => {
  it('groups all/ok/ko lines of one send stamped a few ms apart into one group', () => {
    const groups = groupSends([
      row('Login', 1_000, 'all', 10),
      row('Login', 1_003, 'ok', 9),
      row('Login', 1_007, 'ko', 1),
    ]);
    expect(groups).toHaveLength(1);
    expect(Object.keys(groups[0]).sort()).toEqual(['all', 'ko', 'ok']);
    // every line is stamped with the group's first timestamp
    expect(Object.values(groups[0]).map((g) => g.__ts)).toEqual([1_000, 1_000, 1_000]);
    expect(groups[0].ok.count).toBe(9);
  });

  it('keeps sends ≥ 1 s apart separate', () => {
    const groups = groupSends([
      row('Login', 1_000, 'all'), row('Login', 1_002, 'ok'),
      row('Login', 2_000, 'all'), row('Login', 2_001, 'ok'),
      row('Login', 7_000, 'all'),
    ]);
    expect(groups.map((g) => g.all.__ts)).toEqual([1_000, 2_000, 7_000]);
  });

  it('sorts lines by time before grouping', () => {
    const groups = groupSends([row('A', 2_004, 'ok'), row('A', 1_001, 'ok'), row('A', 2_000, 'all'), row('A', 1_000, 'all')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].all.__ts).toBe(1_000);
    expect(groups[0].ok.__ts).toBe(1_000);
    expect(groups[1].ok.__ts).toBe(2_000);
  });

  it('starts a new group when a kind repeats, even within 500 ms', () => {
    const groups = groupSends([row('A', 1_000, 'all'), row('A', 1_100, 'all')]);
    expect(groups).toHaveLength(2);
  });

  it('starts a new group when a line is more than 500 ms after the group start', () => {
    const groups = groupSends([row('A', 1_000, 'all'), row('A', 1_501, 'ok')]);
    expect(groups).toHaveLength(2);
    expect(groupSends([row('A', 1_000, 'all'), row('A', 1_500, 'ok')])).toHaveLength(1);
  });

  it('groups transactions independently and keeps response-code lines in the send', () => {
    const groups = groupSends([
      row('A', 1_000, 'all'), row('B', 1_001, 'all'), row('A', 1_002, 'err:500:Server Error'), row('B', 1_004, 'ok'),
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.all.__txn === 'A')!;
    const b = groups.find((g) => g.all.__txn === 'B')!;
    expect(Object.keys(a).sort()).toEqual(['all', 'err:500:Server Error']);
    expect(Object.keys(b).sort()).toEqual(['all', 'ok']);
  });

  it('returns no groups for no rows', () => {
    expect(groupSends([])).toEqual([]);
  });
});
