import { query } from '../db/pool.js';
import { round } from '../lib/stats.js';
import { METRIC_BY_KEY, METRICS, SOURCES, type EntityKind, type MetricDef } from '../observability/catalog.js';
import { inventory, markers, metricSeries, type Scope, type SeriesOut } from '../observability/query.js';
import { STEP_CANDIDATES, bucketCount, parseFilters, type Filters } from '../observability/pure.js';
import { CONFIDENTIALITY, fmtNum, type Column, type ColumnFmt, type Kpi, type ReportContent, type Section, type SummaryData } from './content.js';

/**
 * OBSERVABILITY report: a time window (to the minute, UTC) across hosts, load generators, databases, services/JVMs,
 * Kubernetes and test runs. Every number comes from the same engine as GET /observability/series|table:
 * aligned buckets for charts, stats from raw samples.
 */

export interface ObservabilityParams { from: string; to: string; filters?: Record<string, unknown>; metrics?: string[]; title?: string }

const CHART_POINTS = 300;
const CHART_SERIES = 8;
const TABLE_ROWS = 50;

const utc = (v: string | number | Date | null | undefined, secs = true) => {
  if (v == null) return '—';
  const s = new Date(v).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, secs ? 19 : 16)} UTC`;
};
const r = (v: number | null | undefined, d = 2) => round(v ?? null, d);
const col = (key: string, header: string, fmt?: ColumnFmt, unit?: string): Column => ({ key, header, fmt, unit });
const chapter = (id: string, title: string, intro?: string): Section => ({ id, title, kind: 'chapter', data: { intro } });
const unitText = (m: MetricDef) => (m.unit ? ` ${m.unit}` : '');
const valText = (m: MetricDef, v: number | null | undefined) => (v == null ? 'n/a' : `${fmtNum(v, Math.abs(v) >= 100 ? 0 : 2)}${unitText(m)}`);
const durText = (ms: number) => { const m = Math.round(ms / 60000); const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); return [d && `${d} d`, h && `${h} h`, (m % 60 || (!d && !h)) && `${m % 60} min`].filter(Boolean).join(' '); };

/** Chart step: smallest candidate keeping ≤ 300 buckets (readable in print). */
export function reportStep(fromMs: number, toMs: number) {
  return STEP_CANDIDATES.find((s) => bucketCount(fromMs, toMs, s) <= CHART_POINTS) ?? 86400;
}

const ENTITY_ORDER: { id: string; title: string; entities: EntityKind[]; intro: string }[] = [
  { id: 'hosts', title: 'Hosts', entities: ['host'], intro: 'Operating-system metrics of the servers in scope (server_metrics).' },
  { id: 'databases', title: 'Databases', entities: ['database'], intro: 'Database server metrics (database_metrics), one series per database.' },
  { id: 'services', title: 'Services & JVM', entities: ['service', 'jvm'], intro: 'Application service metrics (service_metrics) and JVM runtime metrics (jvm_metrics).' },
  { id: 'kubernetes', title: 'Kubernetes', entities: ['pod', 'node'], intro: 'Pod and node usage sampled from metrics-server (metric_points, source kubernetes).' },
  { id: 'runs', title: 'Test runs in the window', entities: ['run'], intro: 'Load-test metrics of the runs overlapping the window (run_metrics, primary source per run).' },
];

async function filterFacts(f: Filters): Promise<[string, string][]> {
  const names = async (sql: string, ids?: string[]) => (ids?.length ? (await query(sql, [ids])).map((x) => x.name as string).join(', ') : null);
  const out: [string, string][] = [];
  const add = (k: string, v: string | null | undefined) => { if (v) out.push([k, v]); };
  add('Project', await names(`SELECT name FROM projects WHERE id = ANY($1::uuid[]) ORDER BY name`, f.projectId));
  add('Environment', await names(`SELECT name FROM environments WHERE id = ANY($1::uuid[]) ORDER BY name`, f.environmentId));
  add('Application', await names(`SELECT name FROM applications WHERE id = ANY($1::uuid[]) ORDER BY name`, f.applicationId));
  add('Hosts', await names(`SELECT name FROM servers WHERE id = ANY($1::uuid[]) ORDER BY name`, f.hostId));
  add('Services', await names(`SELECT name FROM services WHERE id = ANY($1::uuid[]) ORDER BY name`, f.serviceId));
  add('Databases', await names(`SELECT name FROM services WHERE id = ANY($1::uuid[]) ORDER BY name`, f.databaseId));
  add('Runs', await names(`SELECT run_key AS name FROM test_runs WHERE id = ANY($1::uuid[]) ORDER BY run_key`, f.runId));
  add('Clusters', await names(`SELECT COALESCE(NULLIF(config->>'clusterName',''), name) AS name FROM integrations WHERE id = ANY($1::uuid[]) ORDER BY 1`, f.cluster));
  for (const k of ['namespace', 'workload', 'pod', 'node', 'role'] as const) add(k[0].toUpperCase() + k.slice(1), f[k]?.join(', '));
  return out;
}

function statsTable(id: string, title: string, m: MetricDef, series: SeriesOut[], total: number): Section {
  const u = m.unit || undefined;
  const fmt: ColumnFmt = 'num';
  return {
    id, title, kind: 'table',
    data: {
      columns: [col('label', m.entity === 'run' ? 'Run' : 'Entity'), ...(series.some((s) => s.host && s.host !== s.label) ? [col('host', 'Host')] : []), col('samples', 'Samples', 'int'),
        col('min', 'Min', fmt, u), col('avg', 'Avg', fmt, u), col('p95', 'P95', fmt, u), col('max', 'Max', fmt, u), col('maxTs', 'Time of max'), col('last', 'Last', fmt, u)],
      rows: series.map((s) => ({ label: s.label, host: s.host ?? '—', samples: s.stats.samples, min: r(s.stats.min), avg: r(s.stats.avg), p95: r(s.stats.p95), max: r(s.stats.max), maxTs: utc(s.stats.maxTs), last: r(s.stats.last) })),
    },
    note: total > series.length ? `Showing the ${series.length} entities with the highest average of ${total}.` : undefined,
  };
}

export async function buildObservabilityContent(opts: { orgId: string; projectId: string; params: ObservabilityParams }, version: number, title: string): Promise<ReportContent> {
  const p = opts.params;
  const from = new Date(p.from);
  const to = new Date(p.to);
  const f = parseFilters(p.filters ?? {});
  if (!f.projectId?.length) f.projectId = [opts.projectId];
  const scope: Scope = { orgId: opts.orgId, keyProjectId: null };
  const w = { from, to };
  const stepSec = reportStep(from.getTime(), to.getTime());
  const wanted = (p.metrics?.length ? p.metrics : METRICS.map((m) => m.key)).filter((k) => METRIC_BY_KEY.has(k));

  const [inv, mk, facts] = await Promise.all([inventory(scope, f, w), markers(scope, f, w), filterFacts(f)]);
  const hasEntity = new Set(inv.metrics.filter((m) => m.hasData).map((m) => m.entity));
  const defs = wanted.map((k) => METRIC_BY_KEY.get(k)!).filter((m) => hasEntity.has(m.entity));

  // one query per metric (sequential: bounded memory on small hosts)
  const results = new Map<string, { series: SeriesOut[]; total: number }>();
  for (const m of defs) results.set(m.key, await metricSeries(m, scope, f, w, { stepSec, agg: 'avg', groupBy: 'entity', limit: TABLE_ROWS, points: true }));

  const sections: Section[] = [];
  const peak = (key: string) => {
    const res = results.get(key);
    if (!res?.series.length) return null;
    const s = res.series.reduce((a, b) => ((b.stats.max ?? -Infinity) > (a.stats.max ?? -Infinity) ? b : a));
    return s.stats.max == null ? null : { def: METRIC_BY_KEY.get(key)!, s };
  };

  /* hot spots */
  const HOT = ['host.cpu_pct', 'host.memory_pct', 'db.query_latency_ms', 'db.pool_pct', 'jvm.heap_pct', 'svc.error_pct', 'svc.latency_ms', 'k8s.pod.cpu_millicores', 'k8s.pod.memory_mb', 'k8s.node.cpu_pct', 'run.p95_ms', 'run.error_pct'];
  const hot = HOT.map(peak).filter((x): x is NonNullable<ReturnType<typeof peak>> => !!x);
  const restarts = (results.get('k8s.pod.restarts')?.series ?? []).map((s) => ({ s, inc: (s.stats.max ?? 0) - (s.stats.min ?? 0) })).sort((a, b) => b.inc - a.inc);
  const cpu = peak('host.cpu_pct');
  const mem = peak('host.memory_pct');
  const dbl = peak('db.query_latency_ms');
  const findings: SummaryData['findings'] = [];
  const tone = (v: number, warn: number, fail: number) => (v >= fail ? 'fail' : v >= warn ? 'warn' : 'pass') as 'pass' | 'warn' | 'fail';
  if (cpu) findings.push({ tone: tone(cpu.s.stats.max!, 75, 90), text: `Highest host CPU: ${valText(cpu.def, cpu.s.stats.max)} on ${cpu.s.label} at ${utc(cpu.s.stats.maxTs)} (window average ${valText(cpu.def, cpu.s.stats.avg)}).` });
  if (mem) findings.push({ tone: tone(mem.s.stats.max!, 80, 90), text: `Highest host memory: ${valText(mem.def, mem.s.stats.max)} on ${mem.s.label} at ${utc(mem.s.stats.maxTs)}.` });
  if (dbl) findings.push({ tone: 'warn', text: `Highest database query latency: ${valText(dbl.def, dbl.s.stats.max)} on ${dbl.s.label} at ${utc(dbl.s.stats.maxTs)} (P95 ${valText(dbl.def, dbl.s.stats.p95)}).` });
  if (restarts[0]?.inc > 0) findings.push({ tone: 'warn', text: `Pod restarts: ${restarts[0].s.label} restarted ${fmtNum(restarts[0].inc, 0)} time(s) in the window (counter ${fmtNum(restarts[0].s.stats.min, 0)} → ${fmtNum(restarts[0].s.stats.max, 0)}).` });
  const recs: SummaryData['recommendations'] = [];
  if (cpu && cpu.s.stats.max! >= 90) recs.push({ priority: 'HIGH', text: `Investigate CPU saturation on ${cpu.s.label} around ${utc(cpu.s.stats.maxTs, false)} — correlate with the markers listed in this report.` });
  if (mem && mem.s.stats.max! >= 90) recs.push({ priority: 'HIGH', text: `Memory on ${mem.s.label} reached ${valText(mem.def, mem.s.stats.max)}; check for leaks or undersized hosts.` });
  if (restarts[0]?.inc > 0) recs.push({ priority: 'MEDIUM', text: `Review events/logs of ${restarts[0].s.label} for the cause of its restarts.` });
  // thresholds shared with the result breakdown: CPU warn 75 / fail 90, memory warn 80 / fail 90
  const cpuMax = cpu?.s.stats.max ?? null;
  const memMax = mem?.s.stats.max ?? null;
  const high = (cpuMax ?? 0) >= 90 || (memMax ?? 0) >= 90;
  const medium = (cpuMax ?? 0) >= 75 || (memMax ?? 0) >= 80;
  const satText = `peak host CPU ${cpuMax == null ? 'n/a' : fmtNum(cpuMax, 1) + '%'}, peak host memory ${memMax == null ? 'n/a' : fmtNum(memMax, 1) + '%'}`;
  if (medium && !high) recs.push({ priority: 'MEDIUM', text: `Headroom is limited (${satText}); check capacity before increasing load.` });
  const risk: SummaryData['risk'] = !defs.length ? { level: 'MEDIUM', reason: 'No monitoring data in the window for the selected filters.' }
    : high ? { level: 'HIGH', reason: `Saturation: ${satText} (≥ 90%).` }
    : medium ? { level: 'MEDIUM', reason: `Elevated usage: ${satText} (CPU ≥ 75% or memory ≥ 80%).` }
    : { level: 'LOW', reason: cpu || mem ? `Host CPU < 75% and memory < 80% (${satText}).` : 'No host saturation data in the window.' };

  const windowText = `${utc(from, false)} → ${utc(to, false)}`;
  const counts = { hosts: inv.hosts.filter((h) => h.lastSeen).length, dbs: inv.databases.filter((d) => d.lastSeen).length, svcs: inv.services.filter((s) => s.lastSeen).length, pods: inv.kubernetes.pods.length, runs: inv.runs.length };
  sections.push(chapter('ch-summary', 'Executive summary', `Observability window ${windowText} (${durText(to.getTime() - from.getTime())}).`));
  sections.push({ id: 'summary', title: 'Overview', kind: 'summary', data: {
    paragraphs: [
      `${counts.hosts} host(s), ${counts.dbs} database(s), ${counts.svcs} service(s)/JVM(s), ${counts.pods} Kubernetes pod(s) and ${counts.runs} test run(s) reported data between ${windowText}.`,
      `Charts aggregate raw samples into ${stepSec}-second buckets (average per bucket, aligned to UTC); statistics (min, average, P95, maximum and its time, last) are computed from every raw sample in the window. Gaps are shown as gaps, never interpolated.`,
      ...(mk.length ? [`${mk.length} marker(s) — runs, events, deployments and annotations — fall into the window (chapter “Markers”).`] : []),
    ],
    findings: findings.slice(0, 4), recommendations: recs.slice(0, 3), risk,
  } satisfies SummaryData });
  sections.push({ id: 'kpis', title: 'Key figures', kind: 'kpis', data: [
    { label: 'Hosts reporting', value: counts.hosts }, { label: 'Databases', value: counts.dbs }, { label: 'Services / JVMs', value: counts.svcs }, { label: 'Pods', value: counts.pods }, { label: 'Runs in window', value: counts.runs },
    { label: 'Peak host CPU', value: r(cpu?.s.stats.max, 1), unit: '%', status: cpu ? (cpu.s.stats.max! >= 90 ? 'FAIL' : cpu.s.stats.max! >= 75 ? 'WARNING' : 'PASS') : null, hint: cpu ? `${cpu.s.label} · ${utc(cpu.s.stats.maxTs, false)}` : undefined },
    { label: 'Peak host memory', value: r(mem?.s.stats.max, 1), unit: '%', status: mem ? (mem.s.stats.max! >= 90 ? 'FAIL' : mem.s.stats.max! >= 80 ? 'WARNING' : 'PASS') : null, hint: mem ? `${mem.s.label} · ${utc(mem.s.stats.maxTs, false)}` : undefined },
    { label: 'Peak DB latency', value: r(dbl?.s.stats.max, 1), unit: 'ms', hint: dbl ? `${dbl.s.label} · ${utc(dbl.s.stats.maxTs, false)}` : undefined },
  ] satisfies Kpi[] });
  sections.push({ id: 'hotspots', title: 'Hot spots (peak per metric)', kind: 'table', data: {
    columns: [col('metric', 'Metric'), col('entity', 'Entity'), col('max', 'Peak', 'num'), col('unit', 'Unit'), col('maxTs', 'Time of peak'), col('avg', 'Window avg', 'num'), col('p95', 'P95', 'num')],
    rows: hot.map((h) => ({ metric: `${h.def.label} (${h.def.entity})`, entity: h.s.label, max: r(h.s.stats.max), unit: h.def.unit || '—', maxTs: utc(h.s.stats.maxTs), avg: r(h.s.stats.avg), p95: r(h.s.stats.p95) })),
  }, note: hot.length ? 'Entity with the highest single raw sample of each metric; the time is the first sample at that value.' : 'No data for the hot-spot metrics in this window.' });

  /* load generators */
  const loadgens = inv.hosts.filter((h) => (h.role ?? '').toLowerCase() === 'loadgen' && h.lastSeen);
  const lgIds = new Set(loadgens.map((h) => h.id));

  /* one chapter per entity type present */
  for (const chap of ENTITY_ORDER) {
    const ms = defs.filter((m) => chap.entities.includes(m.entity) && (results.get(m.key)?.series.length ?? 0) > 0);
    if (!ms.length) continue;
    sections.push(chapter(`ch-${chap.id}`, chap.title, chap.intro));
    for (const m of ms) {
      const res = results.get(m.key)!;
      const shown = res.series.slice(0, CHART_SERIES);
      sections.push({ id: `chart-${m.key}`, title: `${m.label}${m.unit ? ` (${m.unit})` : ''}`, kind: 'chart', data: {
        type: 'line', xType: 'time', unit: m.unit || undefined, yLabel: m.unit ? `${m.label} (${m.unit})` : m.label,
        series: shown.map((s) => ({ name: s.label, data: (s.points ?? []).map(([t, v]) => [t, r(v, 3)] as [number, number | null]) })),
      }, note: res.series.length > CHART_SERIES ? `Chart shows the ${CHART_SERIES} entities with the highest average; the table lists up to ${TABLE_ROWS}.` : undefined });
      sections.push(statsTable(`stats-${m.key}`, `${m.label} — statistics`, m, res.series, res.total));
    }
    if (chap.id === 'hosts' && loadgens.length) {
      const lgRow = (key: string) => (results.get(key)?.series ?? []).filter((s) => lgIds.has(s.entityId) || (s.hostId && lgIds.has(s.hostId)));
      const rows = loadgens.map((h) => {
        const c = lgRow('host.cpu_pct').find((s) => s.entityId === h.id);
        const mm = lgRow('host.memory_pct').find((s) => s.entityId === h.id);
        const heap = lgRow('jvm.heap_pct').filter((s) => s.hostId === h.id || s.entityId === h.id).sort((a, b) => (b.stats.max ?? 0) - (a.stats.max ?? 0))[0];
        const gc = lgRow('jvm.gc_pause_ms').filter((s) => s.hostId === h.id || s.entityId === h.id).sort((a, b) => (b.stats.max ?? 0) - (a.stats.max ?? 0))[0];
        return { host: h.name, cpuAvg: r(c?.stats.avg, 1), cpuMax: r(c?.stats.max, 1), cpuTs: utc(c?.stats.maxTs), memMax: r(mm?.stats.max, 1), memTs: utc(mm?.stats.maxTs), heapMax: r(heap?.stats.max, 1), heapTs: utc(heap?.stats.maxTs), gcMax: r(gc?.stats.max, 0) };
      });
      sections.push({ id: 'loadgens', title: 'Load generators', kind: 'table', data: {
        columns: [col('host', 'Load generator'), col('cpuAvg', 'CPU avg', 'num1', '%'), col('cpuMax', 'CPU peak', 'num1', '%'), col('cpuTs', 'CPU peak at'), col('memMax', 'Mem peak', 'num1', '%'), col('memTs', 'Mem peak at'), col('heapMax', 'Heap peak', 'num1', '%'), col('heapTs', 'Heap peak at'), col('gcMax', 'GC pause max', 'int', 'ms')],
        rows,
      }, note: 'Hosts with role “loadgen” (machines running JMeter). A saturated load generator (CPU ≥ 80–90%, heap near max, long GC pauses) distorts the measured response times — validate it before trusting a run.' });
    }
    if (chap.id === 'runs') {
      sections.push({ id: 'runs-list', title: 'Runs overlapping the window', kind: 'table', data: {
        columns: [col('runKey', 'Run ID', 'mono'), col('test', 'Test'), col('started', 'Started'), col('ended', 'Ended'), col('status', 'Status', 'status')],
        rows: inv.runs.map((x) => ({ runKey: x.runKey, test: x.testName, started: utc(x.startedAt), ended: x.endedAt ? utc(x.endedAt) : 'running', status: x.status })),
      } });
    }
  }
  if (!defs.length) sections.push({ id: 'no-data', title: 'No data', kind: 'text', data: 'No monitoring data was stored for the selected filters in this window.' });

  /* markers */
  sections.push(chapter('ch-markers', 'Markers', 'Runs, events, deployments and annotations in the window — use them to explain the peaks above.'));
  sections.push({ id: 'markers', title: 'Markers', kind: 'table', data: {
    columns: [col('ts', 'Start'), col('end', 'End'), col('kind', 'Kind'), col('label', 'Label'), col('severity', 'Status / severity')],
    rows: mk.slice(0, 200).map((x) => ({ ts: utc(x.ts), end: x.endTs ? utc(x.endTs) : '—', kind: x.kind, label: x.label, severity: x.severity ?? '—' })),
  }, note: mk.length > 200 ? `Showing the first 200 of ${mk.length} markers.` : mk.length ? undefined : 'No markers in this window.' });

  /* appendix */
  sections.push(chapter('ch-appendix', 'Appendix', 'Method, data sources and report metadata.'));
  sections.push({ id: 'method', title: 'Method', kind: 'list', data: [
    `Window: [${from.toISOString()}, ${to.toISOString()}) — start inclusive, end exclusive; all times UTC.`,
    `Bucket size: ${stepSec} s, aligned to floor(epoch / ${stepSec}) × ${stepSec}; bucket value = average of the raw samples in the bucket. Buckets without samples are empty (no interpolation).`,
    'Statistics are computed from all raw samples in the window (not from bucket averages): min, average, P95 (linear interpolation between closest ranks, PostgreSQL percentile_cont), maximum (time = first sample at the maximum) and last value.',
    'Run metrics use one source per run (live listener, else JTL, else import, else HTML report) and are never mixed. Pod restarts are a cumulative counter: “restarted N times” = max − min in the window.',
    `Filters that do not apply to an entity type are ignored for that type (e.g. a Kubernetes namespace filter does not restrict hosts). Charts show up to ${CHART_SERIES} entities, tables up to ${TABLE_ROWS} (highest average first).`,
  ] });
  sections.push({ id: 'sources', title: 'Data sources', kind: 'table', data: {
    columns: [col('metric', 'Metric key', 'mono'), col('label', 'Metric'), col('unit', 'Unit'), col('column', 'Stored as')],
    rows: defs.map((m) => ({ metric: m.key, label: m.label, unit: m.unit || '—', column: m.column })),
  } });
  sections.push({ id: 'metadata', title: 'Report metadata', kind: 'kv', data: [
    ['Report type', 'Observability'], ['Report version', `v${version}`], ['Generated', utc(new Date())], ['Window', windowText], ['Timezone', 'UTC'], ['Bucket size', `${stepSec} s`], ['Aggregation', 'avg per bucket; stats from raw samples'],
    ...facts.map(([k, v]) => [`Filter: ${k}`, v] as [string, string]),
    ['Tables read', [...new Set(defs.map((m) => SOURCES[m.source].table))].join(', ') || '—'],
  ] });

  const status = risk.level === 'HIGH' ? 'FAIL' : risk.level === 'MEDIUM' && defs.length ? 'PASS_WITH_WARNINGS' : defs.length ? 'PASS' : 'INCONCLUSIVE';
  return {
    title, type: 'OBSERVABILITY', generatedAt: new Date().toISOString(), version, audience: 'ENGINEERING', schema: 2, confidentiality: CONFIDENTIALITY,
    subject: { projectName: facts.find((x) => x[0] === 'Project')?.[1], environment: facts.find((x) => x[0] === 'Environment')?.[1], from: from.toISOString(), to: to.toISOString() },
    result: { status, score: null, breakdown: { 'Host CPU': cpu ? (cpu.s.stats.max! >= 90 ? 'FAIL' : cpu.s.stats.max! >= 75 ? 'WARNING' : 'PASS') : 'N/A', 'Host memory': mem ? (mem.s.stats.max! >= 90 ? 'FAIL' : mem.s.stats.max! >= 80 ? 'WARNING' : 'PASS') : 'N/A', 'Pod restarts': restarts.length ? (restarts[0].inc > 0 ? 'WARNING' : 'PASS') : 'N/A' } },
    cover: { label: 'Observability report', facts: [
      ['Window (UTC)', windowText], ['Duration', durText(to.getTime() - from.getTime())], ['Timezone', 'UTC'], ['Bucket', `${stepSec} s (avg)`],
      ...(facts.length ? facts : [['Filters', 'none'] as [string, string]]),
      ['Entities', `${counts.hosts} hosts · ${counts.dbs} DBs · ${counts.svcs} services · ${counts.pods} pods · ${counts.runs} runs`],
    ] },
    sections,
  };
}
