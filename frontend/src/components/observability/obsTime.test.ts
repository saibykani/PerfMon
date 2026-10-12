import { describe, expect, it } from 'vitest';
import {
  DAY, HOUR, MINUTE, apiFilterParams, autoStep, axisLabel, formatDateTime, formatSpan, formatStep, formatTs, obsUrlPart, parseDateTime, rangeLabel,
  readUrlState, resolveTime, shiftRange, snapToMinutes, toPickerValue, tzLabel, validateRange, writeUrlState, zoomOut,
} from './obsTime';
import { decodePanels, encodePanels } from './obsViews';
import { buildOptions, narrowChildren } from './ObsFilterBar';
import type { ObsInventory } from './obsApi';

const T = Date.UTC(2026, 9, 12, 9, 15, 0); // 2026-10-12T09:15:00Z

describe('resolveTime', () => {
  it('resolves relative ranges against now (whole seconds)', () => {
    expect(resolveTime({ mode: 'relative', key: '15m' }, T + 400)).toEqual({ from: T - 15 * MINUTE, to: T });
    expect(resolveTime({ mode: 'relative', key: '7d' }, T)).toEqual({ from: T - 7 * DAY, to: T });
    expect(resolveTime({ mode: 'relative', key: '3h' }, T).from).toBe(T - 3 * HOUR);
  });
  it('returns absolute ranges unchanged', () => {
    expect(resolveTime({ mode: 'absolute', from: 1, to: 2 }, T)).toEqual({ from: 1, to: 2 });
  });
});

describe('validateRange', () => {
  it('accepts a valid window', () => expect(validateRange(T - HOUR, T, T)).toBeNull());
  it('rejects missing / invalid dates', () => {
    expect(validateRange(null, T, T)).toMatch(/From/);
    expect(validateRange(T, NaN, T)).toMatch(/To/);
  });
  it('requires from < to', () => {
    expect(validateRange(T, T, T)).toMatch(/earlier/);
    expect(validateRange(T, T - 1, T)).toMatch(/earlier/);
  });
  it('limits the window to 90 days', () => {
    expect(validateRange(T - 90 * DAY, T, T)).toBeNull();
    expect(validateRange(T - 90 * DAY - 1, T, T)).toMatch(/90 days/);
  });
  it('rejects a start in the future', () => expect(validateRange(T + HOUR, T + 2 * HOUR, T)).toMatch(/future/));
});

describe('parseDateTime / formatDateTime', () => {
  it('parses minute and second precision in UTC', () => {
    expect(parseDateTime('2026-10-12 09:15', 'utc')).toBe(T);
    expect(parseDateTime('2026-10-12T09:15', 'utc')).toBe(T);
    expect(parseDateTime('2026-10-12 09:15:42', 'utc')).toBe(T + 42_000);
    expect(parseDateTime('  2026-10-12  ', 'utc')).toBe(Date.UTC(2026, 9, 12));
  });
  it('parses explicit ISO instants regardless of tz', () => {
    expect(parseDateTime('2026-10-12T09:15:00Z', 'local')).toBe(T);
    expect(parseDateTime('2026-10-12T11:15:00+02:00', 'utc')).toBe(T);
  });
  it('rejects invalid input and roll-over dates', () => {
    for (const s of ['', 'yesterday', '2026-13-01 10:00', '2026-02-31 10:00', '2026-10-12 24:00', '2026-10-12 10:60']) expect(parseDateTime(s, 'utc')).toBeNull();
  });
  it('round-trips in local time', () => {
    const s = formatDateTime(T, 'local', true);
    expect(parseDateTime(s, 'local')).toBe(T);
    expect(toPickerValue(T, 'local')).toBe(formatDateTime(T, 'local').replace(' ', 'T'));
  });
  it('formats in UTC with optional seconds', () => {
    expect(formatDateTime(T + 7_000, 'utc')).toBe('2026-10-12 09:15');
    expect(formatDateTime(T + 7_000, 'utc', true)).toBe('2026-10-12 09:15:07');
    expect(formatTs(T, 'utc')).toBe('2026-10-12 09:15:00 UTC');
  });
  it('labels the local offset', () => {
    expect(tzLabel('utc')).toBe('UTC');
    expect(tzLabel('local', T)).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
  });
});

describe('window navigation', () => {
  it('zooms out ×2 around the centre, capped at now', () => {
    expect(zoomOut(T - 2 * HOUR, T - HOUR, T + DAY)).toEqual({ from: T - 2.5 * HOUR, to: T - 0.5 * HOUR });
    const z = zoomOut(T - HOUR, T, T);
    expect(z.to).toBe(T);
    expect(z.to - z.from).toBe(2 * HOUR);
  });
  it('never zooms beyond 90 days', () => {
    const z = zoomOut(T - 60 * DAY, T, T);
    expect(z.to - z.from).toBe(90 * DAY);
  });
  it('shifts by half the window and stops at now', () => {
    expect(shiftRange(T - HOUR, T, -1, T)).toEqual({ from: T - 1.5 * HOUR, to: T - 0.5 * HOUR });
    expect(shiftRange(T - 2 * HOUR, T - HOUR, 1, T)).toEqual({ from: T - 1.5 * HOUR, to: T - 0.5 * HOUR });
    expect(shiftRange(T - HOUR, T, 1, T)).toEqual({ from: T - HOUR, to: T });
  });
  it('snaps a drag selection outward to whole minutes', () => {
    expect(snapToMinutes(T + 10_000, T + 3 * MINUTE + 1)).toEqual({ from: T, to: T + 4 * MINUTE });
    expect(snapToMinutes(T + 3 * MINUTE, T)).toEqual({ from: T, to: T + 3 * MINUTE });
    expect(snapToMinutes(T + 1000, T + 2000)).toEqual({ from: T, to: T + MINUTE });
  });
});

describe('step & label formatting', () => {
  it('auto step mirrors the backend (≤ 600 points)', () => {
    expect(autoStep(T - 5 * MINUTE, T)).toBe(10);
    expect(autoStep(T - HOUR, T)).toBe(10);
    expect(autoStep(T - 3 * HOUR, T)).toBe(30);
    expect(autoStep(T - DAY, T)).toBe(300);
    expect(autoStep(T - 7 * DAY, T)).toBe(1800);
    expect(autoStep(T - 30 * DAY, T)).toBe(21600);
  });
  it('formats steps and spans', () => {
    expect([10, 60, 300, 3600, 21600, 86400, 90].map(formatStep)).toEqual(['10s', '1m', '5m', '1h', '6h', '1d', '90s']);
    expect(formatSpan(15 * MINUTE)).toBe('15m');
    expect(formatSpan(90 * MINUTE)).toBe('1h 30m');
    expect(formatSpan(6 * HOUR)).toBe('6h');
    expect(formatSpan(7 * DAY)).toBe('7d');
  });
  it('adapts axis labels to the window', () => {
    expect(axisLabel(T + 5_000, 5 * MINUTE, 'utc')).toBe('09:15:05');
    expect(axisLabel(T, 6 * HOUR, 'utc')).toBe('09:15');
    expect(axisLabel(T, 7 * DAY, 'utc')).toBe('10-12 09:15');
  });
  it('labels ranges', () => {
    expect(rangeLabel({ mode: 'relative', key: '30m' }, 'utc')).toBe('Last 30 minutes');
    expect(rangeLabel({ mode: 'absolute', from: T, to: T + HOUR }, 'utc')).toBe('2026-10-12 09:15 → 10:15');
    expect(rangeLabel({ mode: 'absolute', from: T, to: T + DAY + 30_000 }, 'utc')).toBe('2026-10-12 09:15:00 → 2026-10-13 09:15:30');
  });
});

describe('URL (de)serialisation', () => {
  it('round-trips an absolute window with filters and tz', () => {
    const s = { time: { mode: 'absolute' as const, from: T, to: T + HOUR }, tz: 'utc' as const, refreshSec: 0, filters: { hostId: ['a', 'b'], namespace: ['shop'], role: ['loadgen'] } };
    const p = writeUrlState(s, 'view=time&panels=x');
    expect(p.get('from')).toBe('2026-10-12T09:15:00Z');
    expect(p.get('host')).toBe('a,b');
    expect(p.get('role')).toBe('loadgen');
    expect(p.get('view')).toBe('time'); // unrelated params kept
    expect(p.get('refresh')).toBeNull();
    expect(readUrlState(p)).toEqual(s);
  });
  it('round-trips a relative range with auto refresh', () => {
    const s = { time: { mode: 'relative' as const, key: '6h' as const }, tz: 'local' as const, refreshSec: 30, filters: {} };
    const p = writeUrlState(s);
    expect(p.toString()).toBe('range=6h&refresh=30');
    expect(readUrlState(p)).toEqual(s);
  });
  it('returns null without observability params and sanitises bad input', () => {
    expect(readUrlState('view=time')).toBeNull();
    const r = readUrlState('from=2026-10-12T10:00:00Z&to=2026-10-12T09:00:00Z&range=bogus&refresh=7&host=a,,a,b')!;
    expect(r.time).toEqual({ mode: 'relative', key: '1h' });
    expect(r.refreshSec).toBe(0);
    expect(r.filters.hostId).toEqual(['a', 'b']);
  });
  it('drops refresh for absolute windows and compares canonically', () => {
    const p = writeUrlState({ time: { mode: 'absolute', from: T, to: T + HOUR }, tz: 'local', refreshSec: 30, filters: {} });
    expect(p.has('refresh')).toBe(false);
    expect(obsUrlPart('panels=1&range=1h')).toBe('range=1h');
  });
  it('builds API filter params with contract names', () => {
    expect(apiFilterParams({ hostId: ['a', 'b'], cluster: ['c1'], pod: [] })).toEqual({ hostId: 'a,b', cluster: 'c1' });
  });
  it('encodes and decodes panels compactly', () => {
    let n = 0;
    const id = () => `p${n++}`;
    const panels = [
      { id: 'x', metrics: ['host.cpu_pct'], agg: 'avg' as const, groupBy: 'entity' as const, step: 'auto' as const },
      { id: 'y', title: 'Heap', metrics: ['jvm.heap_pct'], agg: 'p95' as const, groupBy: 'none' as const, step: 60, filters: { role: ['loadgen'] } },
    ];
    const enc = encodePanels(panels);
    expect(enc).toBe('[{"m":["host.cpu_pct"]},{"m":["jvm.heap_pct"],"a":"p95","g":"none","s":60,"t":"Heap","f":{"role":["loadgen"]}}]');
    expect(decodePanels(enc, id)).toEqual([{ ...panels[0], id: 'p0' }, { ...panels[1], id: 'p1' }]);
    expect(decodePanels('not json', id)).toBeNull();
    expect(decodePanels('[{"m":["a"],"a":"bogus","s":5}]', id)![0]).toMatchObject({ agg: 'avg', step: 'auto' });
  });
});

describe('filter options & dependent narrowing', () => {
  const inv = {
    from: '', to: '', services: [], runs: [], metrics: [],
    hosts: [{ id: 'h1', name: 'app-01', role: 'app' }, { id: 'h2', name: 'jmeter-01', role: 'loadgen' }],
    databases: [{ id: 'd1', name: 'orders', hostId: 'h1' }, { id: 'd2', name: 'users', hostId: null }],
    kubernetes: {
      clusters: [{ id: 'c1', name: 'prod' }, { id: 'c2', name: 'stage' }],
      namespaces: [{ cluster: 'c1', name: 'shop' }, { cluster: 'c2', name: 'qa' }],
      workloads: [{ cluster: 'c1', namespace: 'shop', name: 'web', kind: 'Deployment' }, { cluster: 'c2', namespace: 'qa', name: 'api', kind: 'Deployment' }],
      pods: [{ cluster: 'c1', namespace: 'shop', name: 'web-1', workload: 'web', node: 'n1' }, { cluster: 'c2', namespace: 'qa', name: 'api-1', workload: 'api', node: 'n2' }],
    },
  } as unknown as ObsInventory;
  const opts = (f: any) => buildOptions(inv, f);

  it('narrows namespaces, workloads, pods and nodes by cluster', () => {
    const o = opts({ cluster: ['c1'] });
    expect(o.namespace.map((x) => x.value)).toEqual(['shop']);
    expect(o.workload.map((x) => x.value)).toEqual(['web']);
    expect(o.pod.map((x) => x.value)).toEqual(['web-1']);
    expect(o.node.map((x) => x.value)).toEqual(['n1']);
    expect(opts({}).pod).toHaveLength(2);
  });
  it('narrows hosts by role and databases by host', () => {
    expect(opts({ role: ['loadgen'] }).hostId.map((x) => x.label)).toEqual(['jmeter-01']);
    expect(opts({ hostId: ['h1'] }).databaseId.map((x) => x.label)).toEqual(['orders']);
    expect(opts({}).role.map((x) => x.value)).toEqual(['app', 'db', 'loadgen', 'gateway']);
  });
  it('drops unreachable child selections when a parent changes', () => {
    const f = narrowChildren({ cluster: ['c2'], namespace: ['shop', 'qa'], workload: ['web'], pod: ['web-1'] }, 'cluster', opts);
    expect(f).toEqual({ cluster: ['c2'], namespace: ['qa'] });
    expect(narrowChildren({ role: ['app'], hostId: ['h2'] }, 'role', opts)).toEqual({ role: ['app'] });
  });
});
