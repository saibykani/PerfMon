import { describe, expect, it } from 'vitest';
import { parseLineProtocol, toEpochMs } from './lineProtocol.js';

describe('parseLineProtocol', () => {
  it('parses measurement, tags, fields and timestamp', () => {
    const { points, errors } = parseLineProtocol('jmeter,application=shop,transaction=Login count=10i,avg=12.5,ok=true 1700000000000');
    expect(errors).toEqual([]);
    expect(points).toEqual([{
      measurement: 'jmeter',
      tags: { application: 'shop', transaction: 'Login' },
      fields: { count: 10, avg: 12.5, ok: true },
      timestamp: 1700000000000,
    }]);
  });

  it('handles escaped spaces, commas and equals signs in measurement, tags and field keys', () => {
    const line = 'my\\ measurement,tag\\ key=a\\,b\\=c,host=web\\ 1 field\\ key=1,f\\=x=2';
    const { points, errors } = parseLineProtocol(line);
    expect(errors).toEqual([]);
    expect(points[0].measurement).toBe('my measurement');
    expect(points[0].tags).toEqual({ 'tag key': 'a,b=c', host: 'web 1' });
    expect(points[0].fields).toEqual({ 'field key': 1, 'f=x': 2 });
    expect(points[0].timestamp).toBeNull();
  });

  it('parses quoted string fields containing spaces, commas, equals and escaped quotes', () => {
    const { points, errors } = parseLineProtocol('events,title=x text="Test started, users=10 \\"ramp\\" done",n=1i 1700000000');
    expect(errors).toEqual([]);
    expect(points[0].fields.text).toBe('Test started, users=10 "ramp" done');
    expect(points[0].fields.n).toBe(1);
    // seconds precision auto-detected
    expect(points[0].timestamp).toBe(1700000000000);
  });

  it('decodes escaped backslashes in string fields', () => {
    const { points } = parseLineProtocol('m path="C:\\\\temp"');
    expect(points[0].fields.path).toBe('C:\\temp');
  });

  it('parses integer, unsigned, float, scientific and boolean field types', () => {
    const { points } = parseLineProtocol('m i=-42i,u=7u,f=-1.5,e=1e3,t1=t,t2=TRUE,t3=True,f1=f,f2=false,f3=FALSE');
    expect(points[0].fields).toEqual({ i: -42, u: 7, f: -1.5, e: 1000, t1: true, t2: true, t3: true, f1: false, f2: false, f3: false });
  });

  it('keeps unparseable bare values as strings', () => {
    const { points } = parseLineProtocol('m v=abc');
    expect(points[0].fields.v).toBe('abc');
  });

  it('skips blank lines and comments and handles CRLF', () => {
    const { points, errors } = parseLineProtocol('# header\r\n\r\nm a=1\r\n   \r\nm b=2\n');
    expect(errors).toEqual([]);
    expect(points.map((p) => p.fields)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports malformed lines as errors with line numbers and keeps the good lines', () => {
    const body = ['m a=1', 'onlymeasurement', 'm novalue', 'm b=2'].join('\n');
    const { points, errors } = parseLineProtocol(body);
    expect(points).toHaveLength(2);
    expect(errors).toEqual(['line 2: missing fields', "line 3: bad field 'novalue'"]);
  });

  it('caps the number of reported errors at 20', () => {
    const body = Array.from({ length: 50 }, () => 'broken').join('\n');
    const { points, errors } = parseLineProtocol(body);
    expect(points).toEqual([]);
    expect(errors).toHaveLength(20);
  });

  it('applies an explicit precision to timestamps', () => {
    expect(parseLineProtocol('m a=1 1700000000', 's').points[0].timestamp).toBe(1700000000000);
    expect(parseLineProtocol('m a=1 1700000000000000000', 'ns').points[0].timestamp).toBe(1700000000000);
    expect(parseLineProtocol('m a=1 1700000000000000', 'u').points[0].timestamp).toBe(1700000000000);
    expect(parseLineProtocol('m a=1 1700000000000', 'ms').points[0].timestamp).toBe(1700000000000);
  });
});

describe('toEpochMs', () => {
  it('auto-detects s / ms / us / ns by magnitude', () => {
    expect(toEpochMs('1700000000')).toBe(1700000000000);
    expect(toEpochMs('1700000000123')).toBe(1700000000123);
    expect(toEpochMs('1700000000123000')).toBe(1700000000123);
    expect(toEpochMs('1700000000123000000')).toBeCloseTo(1700000000123, -1);
  });

  it('honours every precision unit', () => {
    expect(toEpochMs('2', 'h')).toBe(2 * 3600000);
    expect(toEpochMs('3', 'm')).toBe(180000);
    expect(toEpochMs('5', 's')).toBe(5000);
    expect(toEpochMs('5', 'ms')).toBe(5);
    expect(toEpochMs('5000', 'us')).toBe(5);
    expect(toEpochMs('5000000', 'n')).toBe(5);
  });

  it('falls back to auto-detection for unknown precision and returns NaN for garbage', () => {
    expect(toEpochMs('1700000000', 'weird')).toBe(1700000000000);
    expect(toEpochMs('abc')).toBeNaN();
  });
});

describe('parseLineProtocol malformed timestamps', () => {
  it('reports a non-numeric timestamp as an error instead of storing NaN', () => {
    const { points, errors } = parseLineProtocol('m a=1 notatime\nm a=2 1700000000');
    expect(points).toHaveLength(1);
    expect(points[0].fields.a).toBe(2);
    expect(errors).toEqual(["line 1: bad timestamp 'notatime'"]);
  });
});
