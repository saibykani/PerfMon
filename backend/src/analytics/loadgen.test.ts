import { describe, expect, it } from 'vitest';
import { evaluateMetric, evaluateHost, heapPct, hostStatus, loadgenInsight, overallStatus, type LoadgenThresholds } from './loadgenHealth.js';
import { classifyResult } from './score.js';
import { DEFAULT_SETTINGS } from './settings.js';
// @ts-ignore — plain ESM collector without type declarations
import * as col from '../../../collector/collector.mjs';

const T: LoadgenThresholds = DEFAULT_SETTINGS.loadgen_thresholds;
const pts = (vals: (number | null)[]) => vals.map((v, i) => ({ ts: 1_700_000_000_000 + i * 5000, v }));

describe('load generator metric evaluation', () => {
  it('requires the minimum share of samples before a level is reached', () => {
    const one = evaluateMetric('cpu', pts([50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 99]), 75, 90, 10); // 1/12 = 8.3%
    expect(one.level).toBe('OK');
    expect(one.peak).toBe(99);
    expect(one.shareAboveCritPct).toBeCloseTo(8.33, 1);
    const two = evaluateMetric('cpu', pts([50, 50, 50, 50, 50, 50, 50, 50, 99, 99]), 75, 90, 10); // 20%
    expect(two.level).toBe('CRITICAL');
    expect(two.firstAboveTs).toBe(1_700_000_000_000 + 8 * 5000);
    expect(two.lastAboveTs).toBe(1_700_000_000_000 + 9 * 5000);
  });
  it('warning when above warn but not crit; thresholds are inclusive', () => {
    expect(evaluateMetric('memory', pts([80, 80, 70]), 80, 90, 10).level).toBe('WARNING');
    expect(evaluateMetric('memory', pts([79.9, 70]), 80, 90, 10).level).toBe('OK');
  });
  it('NO_DATA without usable samples; minShare 0 never triggers when nothing is above', () => {
    expect(evaluateMetric('heap', pts([null, null]), 85, 95, 10).level).toBe('NO_DATA');
    expect(evaluateMetric('heap', pts([10, 20]), 85, 95, 0).level).toBe('OK');
  });
  it('host and overall status', () => {
    const h = evaluateHost({ host: pts([95, 96, 97]).map((p) => ({ ts: p.ts, cpuPct: p.v, memoryPct: 40 })), heap: [] }, T);
    expect(h.status).toBe('SATURATED');
    expect(h.metrics.find((m) => m.metric === 'heap')!.level).toBe('NO_DATA');
    expect(hostStatus(h.metrics.map((m) => ({ ...m, level: 'NO_DATA' as const })))).toBe('NO_DATA');
    expect(overallStatus(['HEALTHY', 'WARNING', 'NO_DATA'])).toBe('WARNING');
    expect(overallStatus([])).toBe('NO_DATA');
  });
  it('heap % uses max, falls back to committed', () => {
    expect(heapPct(512, 1024, 768)).toBe(50);
    expect(heapPct(384, null, 768)).toBe(50);
    expect(heapPct(null, 1024, 768)).toBeNull();
    expect(heapPct(10, 0, 0)).toBeNull();
  });
  it('insight: saturated → CRITICAL with evidence and heap recommendation', () => {
    const host = evaluateHost({ host: pts([60, 60]).map((p) => ({ ts: p.ts, cpuPct: p.v, memoryPct: 50 })), heap: pts([96, 97]).map((p) => ({ ts: p.ts, heapPct: p.v })) }, T);
    const ins = loadgenInsight({ status: host.status, hosts: [{ name: 'lg-01', ...host }] })!;
    expect(ins.title).toBe('Load generator saturated — results may be unreliable');
    expect(ins.severity).toBe('CRITICAL');
    expect(ins.evidence[0]).toMatch(/^lg-01: JMeter heap peak 97%, at or above 95% \(critical\) for 100% of 2 samples/);
    expect(ins.recommendations.map((r) => r.title)).toContain('Raise the JMeter heap');
    expect(loadgenInsight({ status: 'HEALTHY', hosts: [] })).toBeNull();
  });
});

describe('classifyResult with load generator health', () => {
  const base = {
    runStatus: 'COMPLETED', summary: { total_samples: 1000, error_pct: 0, tps_avg: 10 }, sla: { results: [] }, regressions: [],
    defaults: { errorPctFail: 5, errorPctWarn: 1 }, targetTps: null, infra: { cpuP90: null } as any,
  };
  it('saturated load generator turns PASS into PASS_WITH_WARNINGS with an explicit reason, never FAIL', () => {
    const r = classifyResult({ ...base, loadgen: { status: 'SATURATED', hosts: ['lg-01'] } });
    expect(r.result).toBe('PASS_WITH_WARNINGS');
    expect(r.breakdown['Load Generator']).toBe('WARNING');
    expect(r.reasons[0]).toBe('Load generator saturated — results may be unreliable (lg-01)');
  });
  it('healthy / warning load generator keeps PASS; no data adds no dimension', () => {
    expect(classifyResult({ ...base, loadgen: { status: 'WARNING' } }).result).toBe('PASS');
    expect(classifyResult({ ...base, loadgen: { status: 'HEALTHY' } }).breakdown['Load Generator']).toBe('PASS');
    expect(classifyResult({ ...base, loadgen: { status: 'NO_DATA' } }).breakdown['Load Generator']).toBeUndefined();
  });
});

describe('collector helpers', () => {
  it('parses CLI flags and config precedence', () => {
    const a = col.parseArgs(['--role', 'loadgen', '--interval=2', '--once', '--run-id', 'R-1']);
    expect(a).toEqual({ role: 'loadgen', interval: '2', once: true, 'run-id': 'R-1' });
    const c = col.buildConfig({ PERFMON_ROLE: 'app', PERFMON_URL: 'http://x:8080/', INTERVAL_SEC: '9' }, a, 'host1');
    expect(c).toMatchObject({ role: 'loadgen', interval: 2, url: 'http://x:8080', runId: 'R-1', server: 'host1', jmeter: true, once: true });
    expect(col.buildConfig({ PERFMON_JMETER: 'false', PERFMON_ROLE: 'loadgen' }, {}).jmeter).toBe(false);
    expect(col.buildConfig({}, {}).jmeter).toBe(false);
  });
  it('parses /proc/net/dev excluding loopback', () => {
    const t = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0',
      '  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0',
      '  eth1: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0',
    ].join('\n');
    expect(col.parseProcNetDev(t)).toEqual({ rx: 5100, tx: 7200 });
  });
  it('parses Windows netstat -e', () => {
    const t = 'Interface Statistics\r\n\r\n                           Received            Sent\r\n\r\nBytes                    1234567890      987654321\r\nUnicast packets             100              200\r\n';
    expect(col.parseNetstatE(t)).toEqual({ rx: 1234567890, tx: 987654321 });
  });
  it('parses jstat -gc / -gccapacity and computes heap', () => {
    const gc = col.parseJstat([
      ' S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC     YGCT    FGC    FGCT     CGC    CGCT     GCT',
      '  0.0   4096.0  0.0   4096.0 61440.0  20480.0   196608.0   51200.0  30000.0 29000.0 3000.0 2800.0     12    0.120     0    0.000     4    0.010    0.130',
    ].join('\n'));
    expect(gc.EU).toBe(20480);
    expect(col.heapFromJstat(gc, null, 1024)).toMatchObject({ heapUsedMb: 74, heapCommittedMb: 256, heapMaxMb: 1024, gcCount: 16, gcTimeSec: 0.13 });
    expect(col.heapFromJstat(gc, { NGCMX: 1048576, OGCMX: 1048576 }, null).heapMaxMb).toBe(1024);
    expect(col.heapFromJstat(gc, { NGCMX: 349504, OGCMX: 699072 }, null).heapMaxMb).toBe(1024);
  });
  it('parses -Xmx, /proc stat/status and ps time', () => {
    expect(col.parseXmx('java -Xms1g -Xmx1g -jar ApacheJMeter.jar')).toBe(1024);
    expect(col.parseXmx('java -Xmx512m')).toBe(512);
    expect(col.parseXmx('java -jar x.jar')).toBeNull();
    expect(col.parseProcStat('1234 (java (x)) S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0')).toBe(300);
    expect(col.parseVmRss('Name: java\nVmRSS:\t  204800 kB\n')).toBe(200);
    expect(col.parsePsTime('1:02.50')).toBeCloseTo(62.5);
    expect(col.parsePsTime('1-00:00:01')).toBe(86401);
  });
  it('process CPU, backoff and bounded buffer', () => {
    expect(col.processCpuPct(2000, 1000, 4)).toBe(50);
    expect(col.processCpuPct(1, 0, 4)).toBeNull();
    expect([1, 2, 3, 10].map((f) => col.backoffMs(f, 5000))).toEqual([5000, 10000, 20000, 300000]);
    const b = new col.BoundedBuffer(3);
    b.push(1, 2, 3, 4);
    expect(b.items).toEqual([2, 3, 4]); expect(b.dropped).toBe(1);
    b.unshift([0]);
    expect(b.items).toEqual([2, 3, 4]); expect(b.dropped).toBe(2); // re-queued batch is the oldest → dropped first
  });
  it('builds the ingest payload with the JMeter service only when JMeter was found', () => {
    const cfg = col.buildConfig({}, { role: 'loadgen', 'run-id': 'R', server: 'lg' });
    const info = { hostname: 'lg', os: 'Linux', cores: 4, memoryMb: 8192 };
    const s = { host: { ts: 1, cpuPct: 10 }, jvm: { ts: 1, heapUsedMb: 5 }, proc: { ts: 1, cpuPct: 3, memoryPct: 2 } };
    const p = col.buildPayload(cfg, [s], info, true);
    expect(p.service).toEqual({ name: 'JMeter @ lg', kind: 'loadgen', technology: 'Apache JMeter' });
    expect(p.jvm).toHaveLength(1); expect(p.serviceMetrics).toHaveLength(1); expect(p.server.role).toBe('loadgen');
    const q = col.buildPayload(cfg, [{ host: { ts: 1 } }], info, false);
    expect(q.service).toBeUndefined(); expect(q.jvm).toBeUndefined();
  });
});
