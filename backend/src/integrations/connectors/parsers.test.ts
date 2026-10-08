import { describe, expect, it } from 'vitest';
import { buildFlux, buildInfluxQL, parseAnnotatedCsv, parseInfluxQlJson, parseSelector } from './influxdb.js';
import { parsePromMatrix } from './prometheus.js';
import { dynatraceResolution, parseDynatraceResult } from './dynatrace.js';
import { ConnectorError, authHeaders, describeFetchError, expectOk, hostFromLabels, joinUrl, requireUrl, statusMessage } from './http.js';
import type { IntegrationRecord } from './types.js';

const W = { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-01T01:00:00Z'), stepSec: 15 };

describe('InfluxDB parseSelector', () => {
  it('parses measurement:field with and without tag filters', () => {
    expect(parseSelector('mem:used_percent')).toEqual({ measurement: 'mem', field: 'used_percent', tags: {} });
    expect(parseSelector(' cpu:usage_idle{cpu=cpu-total, host="web 1"} ')).toEqual({ measurement: 'cpu', field: 'usage_idle', tags: { cpu: 'cpu-total', host: 'web 1' } });
    expect(parseSelector('disk:used_percent{}')).toEqual({ measurement: 'disk', field: 'used_percent', tags: {} });
  });

  it('returns null for raw Flux / InfluxQL', () => {
    expect(parseSelector('from(bucket: "x") |> range(start: -1h)')).toBeNull();
    expect(parseSelector('SELECT mean("v") FROM "cpu"')).toBeNull();
  });

  it('rejects malformed tag filters', () => {
    expect(() => parseSelector('cpu:usage{=x}')).toThrow(ConnectorError);
    expect(() => parseSelector('cpu:usage{novalue}')).toThrow("Invalid tag filter 'novalue'");
  });
});

describe('InfluxDB query builders', () => {
  it('builds Flux with escaped strings and aggregateWindow', () => {
    const flux = buildFlux('tele"graf', { measurement: 'cpu', field: 'usage_idle', tags: { host: 'a\\b' } }, W);
    expect(flux).toContain('from(bucket: "tele\\"graf")');
    expect(flux).toContain('range(start: 2024-01-01T00:00:00.000Z, stop: 2024-01-01T01:00:00.000Z)');
    expect(flux).toContain('r._measurement == "cpu" and r._field == "usage_idle" and r["host"] == "a\\\\b"');
    expect(flux).toContain('aggregateWindow(every: 15s, fn: mean, createEmpty: false)');
  });

  it('builds InfluxQL with quoting and GROUP BY time + tags', () => {
    const q = buildInfluxQL({ measurement: 'mem', field: 'used_percent', tags: { host: "o'brien" } }, W, ['host', 'region']);
    expect(q).toBe(`SELECT mean("used_percent") AS "value" FROM "mem" WHERE time >= '2024-01-01T00:00:00.000Z' AND time <= '2024-01-01T01:00:00.000Z' AND "host" = 'o\\'brien' GROUP BY time(15s), "host", "region" fill(none)`);
  });
});

describe('InfluxDB parseAnnotatedCsv', () => {
  const csv = [
    '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string,string',
    '#group,false,false,true,true,false,false,true,true,true',
    '#default,_result,,,,,,,,',
    ',result,table,_start,_stop,_time,_value,_field,_measurement,host',
    ',,0,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:15Z,12.5,usage_idle,cpu,web1',
    ',,0,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:30Z,,usage_idle,cpu,web1',
    ',,0,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:45Z,13,usage_idle,cpu,web1',
    ',,1,2024-01-01T00:00:00Z,2024-01-01T01:00:00Z,2024-01-01T00:00:15Z,50,usage_idle,cpu,web2',
    '',
  ].join('\n');

  it('groups rows by result/table into labelled series and skips empty values', () => {
    const series = parseAnnotatedCsv(csv);
    expect(series).toHaveLength(2);
    expect(series[0].labels).toEqual({ host: 'web1', _measurement: 'cpu', _field: 'usage_idle' });
    expect(series[0].points).toEqual([[Date.parse('2024-01-01T00:00:15Z'), 12.5], [Date.parse('2024-01-01T00:00:45Z'), 13]]);
    expect(series[1].labels.host).toBe('web2');
  });

  it('throws on error tables', () => {
    expect(() => parseAnnotatedCsv(',error,reference\n,unauthorized access,\n')).toThrow('InfluxDB query error: unauthorized access');
  });
});

describe('InfluxDB parseInfluxQlJson', () => {
  it('reads the first non-time column as value and keeps series tags', () => {
    const out = parseInfluxQlJson({ results: [{ series: [{ name: 'cpu', tags: { host: 'db1' }, columns: ['time', 'value'], values: [[1000, 1.5], [2000, null], ['1970-01-01T00:00:03Z', '2']] }] }] });
    expect(out).toEqual([{ labels: { host: 'db1', _measurement: 'cpu' }, points: [[1000, 1.5], [3000, 2]] }]);
  });

  it('throws on statement errors', () => {
    expect(() => parseInfluxQlJson({ results: [{ error: 'boom' }] })).toThrow('InfluxDB query error: boom');
  });
});

describe('Prometheus parsePromMatrix', () => {
  it('parses a matrix result (seconds → ms) and drops NaN samples', () => {
    const json = { status: 'success', data: { resultType: 'matrix', result: [{ metric: { instance: 'app:9100', job: 'node' }, values: [[1700000000, '0.5'], [1700000015.5, 'NaN'], [1700000030, '1']] }] } };
    expect(parsePromMatrix(json)).toEqual([{ labels: { instance: 'app:9100', job: 'node' }, points: [[1700000000000, 0.5], [1700000030000, 1]] }]);
  });

  it('parses an instant vector', () => {
    const json = { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1700000000.123, '42'] }] } };
    expect(parsePromMatrix(json)).toEqual([{ labels: {}, points: [[1700000000123, 42]] }]);
  });

  it('returns no series for scalar/string results and throws on errors', () => {
    expect(parsePromMatrix({ status: 'success', data: { resultType: 'scalar', result: [1, '1'] } })).toEqual([]);
    expect(() => parsePromMatrix({ status: 'error', error: 'parse error at char 5' })).toThrow('Prometheus error: parse error at char 5');
    expect(() => parsePromMatrix(null)).toThrow('Prometheus error: unexpected response');
  });
});

describe('Dynatrace', () => {
  it('chooses a resolution that keeps ≤ ~600 points, minimum 1m', () => {
    expect(dynatraceResolution(0, 60 * 60_000)).toBe('1m');
    expect(dynatraceResolution(0, 600 * 60_000)).toBe('1m');
    expect(dynatraceResolution(0, 601 * 60_000)).toBe('2m');
    expect(dynatraceResolution(0, 24 * 3600_000)).toBe('3m');
  });

  it('parses Metrics API v2 results with friendly host / service names', () => {
    const json = {
      result: [{
        metricId: 'builtin:host.cpu.usage:names',
        data: [
          { dimensionMap: { 'dt.entity.host': 'HOST-1', 'dt.entity.host.name': 'web-1' }, timestamps: [1000, 2000, 3000], values: [10, null, '30'] },
          { dimensionMap: { 'dt.entity.service.name': 'checkout' }, timestamps: [1000], values: [5] },
        ],
      }],
    };
    expect(parseDynatraceResult(json)).toEqual([
      { labels: { metricId: 'builtin:host.cpu.usage:names', 'dt.entity.host': 'HOST-1', 'dt.entity.host.name': 'web-1', host: 'web-1' }, points: [[1000, 10], [3000, 30]] },
      { labels: { metricId: 'builtin:host.cpu.usage:names', 'dt.entity.service.name': 'checkout', service: 'checkout' }, points: [[1000, 5]] },
    ]);
    expect(parseDynatraceResult({})).toEqual([]);
  });
});

describe('connector http helpers', () => {
  const rec = (over: Partial<IntegrationRecord>) => ({ id: 'i', type: 'X', name: 'n', url: null, authType: 'NONE', config: {}, ...over }) as unknown as IntegrationRecord;

  it('joinUrl avoids double slashes', () => {
    expect(joinUrl('http://h:8086/', '/api/v2/query')).toBe('http://h:8086/api/v2/query');
    expect(joinUrl('http://h', 'query')).toBe('http://h/query');
  });

  it('requireUrl validates scheme and strips trailing slashes', () => {
    expect(requireUrl(rec({ url: ' https://prom.example.com/// ' }))).toBe('https://prom.example.com');
    expect(requireUrl(rec({ url: null }), 'http://fallback')).toBe('http://fallback');
    expect(() => requireUrl(rec({ url: '' }))).toThrow('Integration URL is not configured');
    expect(() => requireUrl(rec({ url: 'ftp://x' }))).toThrow('must start with http:// or https://');
  });

  it('authHeaders builds Bearer/Token/Basic headers by auth type', () => {
    expect(authHeaders(rec({ authType: 'TOKEN' }), { token: 't1' })).toEqual({ authorization: 'Bearer t1' });
    expect(authHeaders(rec({ authType: 'TOKEN' }), { token: 't1' }, 'Token')).toEqual({ authorization: 'Token t1' });
    expect(authHeaders(rec({ authType: 'API_KEY' }), { apiKey: 'k' })).toEqual({ authorization: 'Bearer k' });
    expect(authHeaders(rec({ authType: 'BASIC' }), { username: 'u', password: 'p' })).toEqual({ authorization: 'Basic ' + Buffer.from('u:p').toString('base64') });
    expect(authHeaders(rec({ authType: 'NONE' }), { token: 't' })).toEqual({});
  });

  it('describes network failures without leaking details', () => {
    expect(describeFetchError({ name: 'TimeoutError' })).toMatch(/timed out after 10s/);
    expect(describeFetchError({ cause: { code: 'ECONNREFUSED' } })).toMatch(/Connection refused/);
    expect(describeFetchError({ code: 'ENOTFOUND' })).toMatch(/DNS lookup failed/);
  });

  it('statusMessage / expectOk explain HTTP failures', () => {
    const r = (status: number, json: any = null, text = '') => ({ status, ok: status < 300, json, text, headers: new Headers() });
    expect(statusMessage(r(401), 'Prometheus')).toBe('Prometheus: authentication failed (HTTP 401) — check the credentials');
    expect(statusMessage(r(404), 'Prometheus')).toBe('Prometheus: endpoint not found (HTTP 404) — check the URL');
    expect(statusMessage(r(500, { error: 'bad\n  query' }), 'X')).toBe('X: HTTP 500 — bad query');
    expect(() => expectOk(r(503), 'X')).toThrow(ConnectorError);
    const ok = r(200);
    expect(expectOk(ok, 'X')).toBe(ok);
  });

  it('hostFromLabels picks a host-like label and strips the port', () => {
    expect(hostFromLabels({ instance: 'web-1:9100' })).toBe('web-1');
    expect(hostFromLabels({ host: 'db', instance: 'x:1' })).toBe('db');
    expect(hostFromLabels({ job: 'node' })).toBeNull();
  });
});
