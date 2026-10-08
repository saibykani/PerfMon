import { describe, expect, it } from 'vitest';
import { fluxCsvToPoints, influxQlToPoints, inferIntervalSec, splitCsv } from './jmeterInflux.js';
import type { LinePoint } from '../ingest/lineProtocol.js';

describe('splitCsv', () => {
  it('splits on commas outside quotes and unescapes doubled quotes', () => {
    expect(splitCsv('a,b,,c')).toEqual(['a', 'b', '', 'c']);
    expect(splitCsv('"x,y","say ""hi""",z')).toEqual(['x,y', 'say "hi"', 'z']);
    expect(splitCsv('')).toEqual(['']);
    expect(splitCsv(',')).toEqual(['', '']);
  });
});

const FLUX = [
  '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,string,string,string,string,double,long,double',
  '#group,false,false,true,true,false,true,true,true,true,false,false,false',
  '#default,_result,,,,,,,,,,,',
  ',result,table,_start,_stop,_time,_measurement,application,statut,transaction,avg,count,pct95.0',
  ',,0,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:05Z,jmeter,shop,all,Login,120.5,10,250',
  ',,0,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:10Z,jmeter,shop,all,Login,,12,',
  '',
  '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,string,string,string,string',
  '#group,false,false,true,true,false,true,true,false,false',
  '#default,_result,,,,,,,,',
  ',result,table,_start,_stop,_time,_measurement,application,title,text',
  ',,1,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:01Z,events,shop,ApacheJMeter,"Test started, 10 users"',
  '',
].join('\r\n');

describe('fluxCsvToPoints', () => {
  it('converts pivoted annotated CSV into line points using #datatype for fields vs tags', () => {
    const pts = fluxCsvToPoints(FLUX);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({
      measurement: 'jmeter',
      tags: { application: 'shop', statut: 'all', transaction: 'Login' },
      fields: { avg: 120.5, count: 10, 'pct95.0': 250 },
      timestamp: Date.parse('2024-01-01T00:00:05Z'),
    });
    // empty cells are omitted
    expect(pts[1].fields).toEqual({ count: 12 });
    // a new table (after a blank line) gets its own header; `text` is a string field, not a tag
    expect(pts[2]).toMatchObject({ measurement: 'events', tags: { application: 'shop', title: 'ApacheJMeter' }, fields: { text: 'Test started, 10 users' } });
  });

  it('uses numericCols when there is no #datatype annotation', () => {
    const csv = ',result,table,_time,_measurement,host,value\n,,0,2024-01-01T00:00:00Z,cpu,web1,42.5\n';
    expect(fluxCsvToPoints(csv)[0]).toMatchObject({ tags: { host: 'web1', value: '42.5' }, fields: {} });
    expect(fluxCsvToPoints(csv, new Set(['value']))[0]).toMatchObject({ tags: { host: 'web1' }, fields: { value: 42.5 } });
  });

  it('skips rows with an invalid _time', () => {
    const csv = ',result,table,_time,_measurement\n,,0,not-a-date,jmeter\n';
    expect(fluxCsvToPoints(csv)).toEqual([]);
  });

  it('throws on an InfluxDB error table', () => {
    const csv = '#datatype,string,string\n#group,true,true\n#default,,\n,error,reference\n,"bucket not found",\n';
    expect(() => fluxCsvToPoints(csv)).toThrow('InfluxDB query error: bucket not found');
  });
});

describe('influxQlToPoints', () => {
  it('converts GROUP BY * series into points (series tags + string columns as tags, numbers as fields)', () => {
    const json = {
      results: [{
        series: [{
          name: 'jmeter',
          tags: { application: 'shop', transaction: 'Login', statut: '' },
          columns: ['time', 'avg', 'count', 'responseCode', 'text'],
          values: [
            [1704067205000, 120.5, 10, '500', null],
            ['2024-01-01T00:00:10Z', null, 12, null, 'note'],
            ['garbage', 1, 1, null, null],
          ],
        }],
      }],
    };
    const pts = influxQlToPoints(json);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ measurement: 'jmeter', tags: { application: 'shop', transaction: 'Login', responseCode: '500' }, fields: { avg: 120.5, count: 10 }, timestamp: 1704067205000 });
    expect(pts[1]).toEqual({ measurement: 'jmeter', tags: { application: 'shop', transaction: 'Login' }, fields: { count: 12, text: 'note' }, timestamp: Date.parse('2024-01-01T00:00:10Z') });
  });

  it('tolerates empty responses and throws on errors', () => {
    expect(influxQlToPoints({})).toEqual([]);
    expect(influxQlToPoints({ results: [{}] })).toEqual([]);
    expect(() => influxQlToPoints({ results: [{ error: 'database not found: jm' }] })).toThrow('InfluxDB query error: database not found: jm');
  });
});

const pt = (timestamp: number | null): LinePoint => ({ measurement: 'jmeter', tags: {}, fields: {}, timestamp });

describe('inferIntervalSec', () => {
  it('returns the median gap between sends in seconds', () => {
    expect(inferIntervalSec([0, 10_000, 20_000, 30_000, 40_000].map((t) => pt(1_700_000_000_000 + t)))).toBe(10);
  });

  it('ignores duplicate timestamps and unordered input', () => {
    const base = 1_700_000_000_000;
    expect(inferIntervalSec([base + 2_000, base, base, base + 1_000, base + 3_000, base + 3_000].map(pt))).toBe(1);
  });

  it('ignores the few-ms jitter between the all/ok/ko lines of one send', () => {
    const base = 1_700_000_000_000;
    const ts: number[] = [];
    for (let s = 0; s < 6; s++) ts.push(base + s * 10_000, base + s * 10_000 + 3, base + s * 10_000 + 7);
    expect(inferIntervalSec(ts.map(pt))).toBe(10);
  });

  it('falls back to 5 s with too few points or out-of-range intervals', () => {
    expect(inferIntervalSec([])).toBe(5);
    expect(inferIntervalSec([pt(1_700_000_000_000)])).toBe(5);
    expect(inferIntervalSec([pt(null), pt(null)])).toBe(5);
    expect(inferIntervalSec([0, 120_000, 240_000].map((t) => pt(1_700_000_000_000 + t)))).toBe(5);
  });
});
