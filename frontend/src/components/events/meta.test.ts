import { describe, expect, it } from 'vitest';
import { fmtSpan, fromLocalInput, parseTags, toFeed, toLocalInput, typeMeta, type AnnotationRow, type EventRow } from './meta';
import { runSpans } from './timeline';

const ev = (over: Partial<EventRow>): EventRow => ({
  id: 'e', projectId: 'p', applicationId: null, environmentId: null, environmentName: null, runId: null, runKey: null,
  type: 'OTHER', severity: 'INFO', ts: '2026-01-01T00:00:00Z', title: 't', description: null, source: null, data: {}, ...over,
});
const ann = (over: Partial<AnnotationRow>): AnnotationRow => ({
  id: 'a', projectId: 'p', runId: null, runKey: null, environmentId: null, dashboardId: null, ts: '2026-01-01T00:00:00Z', tsEnd: null,
  title: 'note', text: null, tags: [], createdBy: null, createdByName: null, createdAt: '2026-01-01T00:00:00Z', ...over,
});

describe('toFeed', () => {
  it('merges events and annotations newest first with unique keys', () => {
    const feed = toFeed(
      [ev({ id: '1', ts: '2026-01-01T10:00:00Z', type: 'DEPLOYMENT', description: 'v2' }), ev({ id: '2', ts: '2026-01-01T08:00:00Z' })],
      [ann({ id: '1', ts: '2026-01-01T09:00:00Z', tsEnd: '2026-01-01T09:30:00Z', text: 'window' })],
    );
    expect(feed.map((f) => f.key)).toEqual(['e:1', 'a:1', 'e:2']);
    expect(feed[0]).toMatchObject({ kind: 'event', type: 'DEPLOYMENT', text: 'v2', tsEnd: null });
    expect(feed[1]).toMatchObject({ kind: 'annotation', type: 'ANNOTATION', severity: null, text: 'window', tsEnd: Date.parse('2026-01-01T09:30:00Z') });
  });

  it('handles empty inputs', () => {
    expect(toFeed([], [])).toEqual([]);
  });
});

describe('runSpans', () => {
  it('pairs TEST_START / TEST_END per run and drops incomplete or inverted spans', () => {
    const feed = toFeed([
      ev({ id: '1', runKey: 'R1', type: 'TEST_START', ts: '2026-01-01T00:00:00Z' }),
      ev({ id: '2', runKey: 'R1', type: 'TEST_END', ts: '2026-01-01T01:00:00Z' }),
      ev({ id: '3', runKey: 'R2', type: 'TEST_START', ts: '2026-01-01T02:00:00Z' }),
      ev({ id: '4', runKey: 'R3', type: 'TEST_START', ts: '2026-01-01T05:00:00Z' }),
      ev({ id: '5', runKey: 'R3', type: 'TEST_END', ts: '2026-01-01T04:00:00Z' }),
      ev({ id: '6', runKey: null, type: 'TEST_START' }),
    ], []);
    expect(runSpans(feed)).toEqual([{ runKey: 'R1', start: Date.parse('2026-01-01T00:00:00Z'), end: Date.parse('2026-01-01T01:00:00Z') }]);
  });
});

describe('meta helpers', () => {
  it('typeMeta knows the built-in types and humanises unknown ones', () => {
    expect(typeMeta('DEPLOYMENT').lane).toBe('Deployments & changes');
    expect(typeMeta('CUSTOM_THING')).toMatchObject({ label: 'custom thing', lane: 'Other' });
  });

  it('fmtSpan picks s / m / h / d', () => {
    expect(fmtSpan(30_000)).toBe('30s');
    expect(fmtSpan(90_000)).toBe('2m');
    expect(fmtSpan(2 * 3600_000)).toBe('2.0h');
    expect(fmtSpan(12 * 3600_000)).toBe('12h');
    expect(fmtSpan(36 * 3600_000)).toBe('1.5d');
  });

  it('parseTags trims, de-duplicates and caps at 30', () => {
    expect(parseTags(' a, b ,,a , c ')).toEqual(['a', 'b', 'c']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(Array.from({ length: 40 }, (_, i) => `t${i}`).join(','))).toHaveLength(30);
  });

  it('toLocalInput / fromLocalInput round-trip to the minute', () => {
    const iso = '2026-03-04T05:06:00.000Z';
    const local = toLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe(iso);
    expect(toLocalInput(null)).toBe('');
    expect(toLocalInput('garbage')).toBe('');
  });
});
