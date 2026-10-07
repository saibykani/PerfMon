import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, Boxes, Coffee, Cpu, Database, History, LayoutGrid } from 'lucide-react';
import { useFilters } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Kpi, Loading, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Chart } from '@/charts/Chart';
import { barOption, runTrendOption } from '@/charts/builders';
import { fmtDate, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { StatusBadge } from '@/components/Status';
import { EmptyState, HealthChip } from '@/components/inventory/common';
import { useApplications, type Application } from '@/components/inventory/data';
import { RunSelectorBar, useRunSelection } from '@/components/run/RunPicker';
import { MetricGrid } from '@/components/run/tabs/InfraTabs';
import { useRecentRuns } from '@/components/databases/dbData';
import { IngestGuide } from '@/components/databases/IngestGuide';
import { hasServiceMetrics, jvmQuery, jvmStats, servicesQuery, useAcrossRuns, withHeapPct, type RunService } from '@/components/appmon/appmonData';
import '@/styles/run.css';
import '@/styles/appmon.css';

const lvl = (v: number | null | undefined, warn: number, crit: number) => (v == null ? null : v >= crit ? 'fail' : v >= warn ? 'warn' : 'pass');

export function AppMonitoringPage() {
  const sel = useRunSelection();
  const f = useFilters();
  const theme = useUi((s) => s.theme);
  const jvm = useQuery({ ...jvmQuery(sel.runId ?? ''), enabled: !!sel.runId });
  const svc = useQuery({ ...servicesQuery(sel.runId ?? ''), enabled: !!sel.runId });
  const apps = useApplications(f.projectId);
  const recent = useRecentRuns(8);
  const recentRuns = recent.data?.items ?? [];
  const across = useAcrossRuns(recentRuns);
  const [jvmKey, setJvmKey] = useState('all');
  useEffect(() => setJvmKey('all'), [sel.runId]);

  // JVM series are grouped by server_id; name each server by the JVM(s) reporting on it.
  const targets = jvm.data?.targets ?? [];
  const names = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const t of targets) { const k = t.server_id ?? 'unknown'; (m[k] ??= []).push(t.name ?? 'unnamed JVM'); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...new Set(v)].join(', ')]));
  }, [targets]);
  const jvmKeys = Object.keys(names);
  const allRows = useMemo(() => withHeapPct(jvm.data?.series ?? []), [jvm.data]);
  const rows = jvmKey === 'all' ? allRows : allRows.filter((r) => (r.server_id ?? 'unknown') === jvmKey);
  const st = useMemo(() => jvmStats(rows), [rows]);

  const services = svc.data?.services ?? [];
  const appServices = services.filter((s) => s.kind !== 'database');
  const measured = services.filter(hasServiceMetrics);
  const byId = Object.fromEntries(services.map((s) => [s.id, s]));
  const errMax = measured.length ? Math.max(...measured.map((s) => Number(s.error_rate_pct ?? 0))) : null;
  const unhealthy = services.filter((s) => s.health_status === 'WARNING' || s.health_status === 'CRITICAL').length;

  const svcCols: Column<RunService>[] = [
    { key: 'name', header: 'Service', render: (s) => <span className="row" style={{ gap: 6 }}>{s.kind === 'database' ? <Database size={13} /> : <Boxes size={13} />}<b>{s.name}</b></span> },
    { key: 'kind', header: 'Kind', render: (s) => <span className="badge">{s.kind}</span> },
    { key: 'technology', header: 'Technology', render: (s) => s.technology ?? '—' },
    { key: 'health_status', header: 'Health', render: (s) => <HealthChip status={s.health_status} /> },
    { key: 'request_rate', header: 'Req/s', align: 'right', render: (s) => fmtNum(s.request_rate, 1) },
    { key: 'error_rate_pct', header: 'Errors', align: 'right', render: (s) => (s.error_rate_pct == null ? '—' : <span className={`badge ${lvl(Number(s.error_rate_pct), 1, 5)}`}>{fmtPct(Number(s.error_rate_pct), 2)}</span>) },
    { key: 'avg_latency_ms', header: 'Avg latency', align: 'right', render: (s) => fmtMs(s.avg_latency_ms) },
    { key: 'p95_latency_ms', header: 'P95 latency', align: 'right', render: (s) => fmtMs(s.p95_latency_ms) },
    { key: 'exceptions', header: 'Exceptions', align: 'right', render: (s) => fmtNum(s.exceptions) },
    { key: 'cpu_pct', header: 'CPU', align: 'right', render: (s) => fmtPct(s.cpu_pct == null ? null : Number(s.cpu_pct), 0) },
    { key: 'memory_pct', header: 'Memory', align: 'right', render: (s) => fmtPct(s.memory_pct == null ? null : Number(s.memory_pct), 0) },
  ];

  const acrossCols: Column<(typeof across)[number]>[] = [
    { key: 'run', header: 'Run', value: (x) => x.run.runId, render: (x) => <span className="row" style={{ gap: 6 }}><span className="mono">{x.run.runId}</span>{x.run.runId === sel.runId && <span className="badge accent">VIEWING</span>}</span> },
    { key: 'test', header: 'Test', value: (x) => x.run.testName, render: (x) => <span>{x.run.testName}<span className="muted small"> · build {x.run.buildNumber ?? '—'}</span></span> },
    { key: 'started', header: 'Started', value: (x) => (x.run.startedAt ? +new Date(x.run.startedAt) : null), render: (x) => fmtDate(x.run.startedAt) },
    { key: 'result', header: 'Result', value: (x) => x.run.result, render: (x) => <StatusBadge value={x.run.result} /> },
    { key: 'jvms', header: 'JVMs', align: 'right', value: (x) => x.jvmTargets, render: (x) => (x.loading ? '…' : x.jvmTargets || <span className="muted">—</span>) },
    { key: 'heap', header: 'Heap max', align: 'right', value: (x) => x.stats?.heapPctMax ?? null, render: (x) => fmtPct(x.stats?.heapPctMax, 0) },
    { key: 'gc', header: 'GC pause max', align: 'right', value: (x) => x.stats?.gcPauseMax ?? null, render: (x) => fmtMs(x.stats?.gcPauseMax) },
    { key: 'threads', header: 'Threads max', align: 'right', value: (x) => x.stats?.threadsMax ?? null, render: (x) => fmtNum(x.stats?.threadsMax) },
    { key: 'err', header: 'Service errors max', align: 'right', value: (x) => x.errMax, render: (x) => fmtPct(x.errMax, 2) },
  ];
  const chrono = [...across].reverse().filter((x) => x.stats);

  const appCols: Column<Application>[] = [
    { key: 'name', header: 'Application', render: (a) => <span><b>{a.name}</b> <span className="muted mono small">{a.code}</span></span> },
    { key: 'project_name', header: 'Project', render: (a) => a.project_name ?? '—' },
    { key: 'technology', header: 'Technology', render: (a) => a.technology ?? '—' },
    { key: 'team', header: 'Team / owner', value: (a) => a.team ?? a.owner, render: (a) => [a.team, a.owner].filter(Boolean).join(' · ') || '—' },
    { key: 'environment_names', header: 'Environments', value: (a) => (a.environment_names ?? []).join(', '), render: (a) => (a.environment_names?.length ? a.environment_names.join(', ') : <span className="muted">none</span>) },
    { key: 'services', header: 'Services', align: 'right' },
    { key: 'tests', header: 'Tests', align: 'right' },
    { key: 'runs', header: 'Runs', align: 'right' },
    { key: 'act', header: '', sortable: false, render: (a) => (
      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); f.set({ projectId: a.project_id, applicationId: a.id, environmentId: null, testId: null, runId: null }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        disabled={!a.runs} title={a.runs ? 'Show the latest run of this application' : 'No runs yet'}>Monitor<ArrowRight size={12} /></button>) },
  ];

  const noRun = !sel.loading && !sel.runId;
  const loadingRun = sel.loading || jvm.isLoading || svc.isLoading;
  return (
    <div className="apm-page">
      <PageHeader title="Applications Monitoring" subtitle="Runtime health of application services per test run — JVM heap, GC and threads, service error rates, latency and CPU — plus the application inventory."
        actions={<Link className="btn" to="/help/jvm-monitoring"><BookOpen size={14} />JVM monitoring guide</Link>} />
      <RunSelectorBar sel={sel} />

      <div className="stack">
        {noRun ? (
          <Card><EmptyState icon={<History size={22} />} title="No completed runs match the filters">Clear or change the filters above, or complete a test run. JVM and service metrics are stored per run.</EmptyState></Card>
        ) : (
          <>
            <ErrorBox error={jvm.error ?? svc.error} />
            {loadingRun ? <Loading height={120} /> : (
              <div className="apm-kpis">
                <Kpi label="Services" value={fmtNum(services.length)} sub={services.length ? `${appServices.length} app · ${services.length - appServices.length} data` : 'none registered'} status={services.length ? (unhealthy ? 'fail' : null) : null} />
                <Kpi label="With metrics" value={fmtNum(measured.length)} sub="services reporting in this run" />
                <Kpi label="Max service errors" value={errMax != null ? fmtPct(errMax, 2) : '—'} status={lvl(errMax, 1, 5)} />
                <Kpi label="JVMs reporting" value={fmtNum(targets.length)} sub={targets.map((t) => t.name).filter(Boolean).join(', ') || 'none'} />
                <Kpi label="Heap peak" value={st.heapPctMax != null ? fmtPct(st.heapPctMax, 0) : st.heapUsedMax != null ? fmtNum(st.heapUsedMax) : '—'} unit={st.heapPctMax == null && st.heapUsedMax != null ? 'MB' : undefined}
                  sub={st.heapMax ? `${fmtNum(st.heapUsedMax)} of ${fmtNum(st.heapMax)} MB` : targets.length ? 'send heapMaxMb for %' : undefined} status={lvl(st.heapPctMax, 75, 90)} />
                <Kpi label="GC pause max" value={fmtMs(st.gcPauseMax)} sub={st.gcCount != null ? `≈ ${fmtNum(st.gcCount)} collections` : undefined} status={lvl(st.gcPauseMax, 200, 500)} />
                <Kpi label="Threads peak" value={fmtNum(st.threadsMax)} />
              </div>
            )}

            {/* ---------------------------------------------------------------- services */}
            <Card title={<span className="row" style={{ gap: 6 }}><Boxes size={13} />Service health in this run</span>} actions={sel.run && <span className="muted small">{sel.run.environmentName}</span>}>
              {loadingRun ? <Loading height={160} /> : !services.length ? (
                <EmptyState icon={<Boxes size={22} />} title="No services registered for this environment">
                  Services are registered automatically when JVM, service or database metrics arrive with a <span className="mono">service</span> object. See the guide below.
                </EmptyState>
              ) : (
                <div className="stack">
                  {!measured.length && (
                    <div className="notice small">No service-level metrics (request rate, errors, latency, CPU) were reported for this run. Push them in <span className="mono">serviceMetrics</span> or via an APM integration (OpenTelemetry, Dynatrace) — <Link to="/help/jvm-monitoring">how</Link>.</div>
                  )}
                  <DataTable rows={services} columns={svcCols} rowKey={(s) => s.id} searchable={services.length > 8} exportName="services" maxHeight={360} />
                  {measured.length > 0 && (
                    <div className="apm-grid-2">
                      <Chart title="Error rate by service" height={Math.max(140, measured.length * 28 + 30)} option={barOption({ theme, categories: measured.map((s) => s.name), series: [{ name: 'Error rate', key: 'errorPct', data: measured.map((s) => (s.error_rate_pct == null ? null : Number(s.error_rate_pct))) }], unit: '%', horizontal: true })} />
                      <Chart title="CPU by service" height={Math.max(140, measured.length * 28 + 30)} option={barOption({ theme, categories: measured.map((s) => s.name), series: [{ name: 'CPU', key: 'cpu', data: measured.map((s) => (s.cpu_pct == null ? null : Number(s.cpu_pct))) }], unit: '%', horizontal: true })} />
                    </div>
                  )}
                  {(svc.data?.dependencies.length ?? 0) > 0 && (
                    <div className="apm-deps">
                      <span className="muted small">Dependencies</span>
                      {svc.data!.dependencies.map((d, i) => <span key={i} className="apm-dep">{byId[d.source]?.name ?? d.source}<ArrowRight size={12} />{byId[d.target]?.name ?? d.target}</span>)}
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* ---------------------------------------------------------------- JVM */}
            {loadingRun ? null : !targets.length ? (
              <div className="apm-split">
                <Card title={<span className="row" style={{ gap: 6 }}><Coffee size={13} />JVM runtime</span>}>
                  <EmptyState icon={<Coffee size={22} />} title={<>No JVM metrics for {sel.run ? <span className="mono">{sel.run.runId}</span> : 'this run'}</>}>
                    Heap, GC and thread metrics appear when a JMX / Micrometer exporter or an integration pushes them during the test. The Perfmon Collector sends host metrics only.
                    Pick another run above or follow the steps on the right. <Link to="/help/jvm-monitoring">Read the guide</Link>.
                  </EmptyState>
                </Card>
                <IngestGuide kind="jvm" />
              </div>
            ) : (
              <Card title={<span className="row" style={{ gap: 6 }}><Coffee size={13} />JVM runtime</span>}
                actions={jvmKeys.length > 1 && (
                  <select className="select" aria-label="JVM" value={jvmKey} onChange={(e) => setJvmKey(e.target.value)}>
                    <option value="all">All JVMs ({jvmKeys.length})</option>
                    {jvmKeys.map((k) => <option key={k} value={k}>{names[k]}</option>)}
                  </select>
                )}>
                <div className="stack">
                  <MetricGrid rows={rows} entityKey="server_id" names={names} group={`apm-${sel.runId}`} specs={[
                    { title: 'Heap', unit: 'MB', cols: [{ col: 'heap_used_mb', label: 'used' }, { col: 'heap_committed_mb', label: 'committed' }, { col: 'heap_max_mb', label: 'max', dashed: true }] },
                    { title: 'Heap utilisation', unit: '%', cols: [{ col: 'heap_pct' }], max: 100 },
                    { title: 'GC max pause', unit: 'ms', cols: [{ col: 'gc_max_pause_ms' }] },
                    { title: 'GC time', unit: 'ms', cols: [{ col: 'gc_time_ms' }] },
                    { title: 'GC count', cols: [{ col: 'gc_count' }] },
                    { title: 'Threads', cols: [{ col: 'thread_count', label: 'live' }, { col: 'peak_threads', label: 'peak', dashed: true }] },
                    { title: 'Non-heap used', unit: 'MB', cols: [{ col: 'nonheap_used_mb' }] },
                    { title: 'Classes loaded', cols: [{ col: 'classes_loaded' }] },
                  ]} />
                  <div className="muted small">
                    {jvm.data?.step ? `Bucket ${jvm.data.step}s. ` : ''}
                    {st.heapMax == null && 'heapMaxMb was not reported, so heap % cannot be computed. '}
                    Correlate GC pauses with response time on the <Link to={`/runs/${sel.runId}`}>run timeline</Link>.
                  </div>
                </div>
              </Card>
            )}
          </>
        )}

        {/* ---------------------------------------------------------------- across runs */}
        <Card title={<span className="row" style={{ gap: 6 }}><History size={13} />Across recent runs</span>} actions={<span className="muted small">latest {recentRuns.length} completed runs in scope</span>}>
          {recent.isLoading ? <Loading height={160} /> : !recentRuns.length ? <EmptyState title="No completed runs in scope" /> : (
            <div className="stack">
              {chrono.length >= 2 ? (
                <div className="apm-grid-2">
                  <Chart height={190} title="Heap peak by run" onPointClick={(p) => { const x = chrono[p.dataIndex]; if (x) f.set({ runId: x.run.runId }); }}
                    option={runTrendOption({ theme, labels: chrono.map((x) => x.run.runId.replace(/^PF-\d{4}-/, '')), unit: '%', min: 0, max: 100, series: [{ name: 'Heap peak %', key: 'memory', data: chrono.map((x) => x.stats?.heapPctMax ?? null) }] })}
                    table={{ columns: ['Run', 'Heap peak %'], rows: chrono.map((x) => [x.run.runId, x.stats?.heapPctMax == null ? null : +x.stats.heapPctMax.toFixed(1)]) }} />
                  <Chart height={190} title="GC pause max by run" onPointClick={(p) => { const x = chrono[p.dataIndex]; if (x) f.set({ runId: x.run.runId }); }}
                    option={runTrendOption({ theme, labels: chrono.map((x) => x.run.runId.replace(/^PF-\d{4}-/, '')), unit: 'ms', series: [{ name: 'GC pause max', key: 'latency', data: chrono.map((x) => x.stats?.gcPauseMax ?? null) }] })}
                    table={{ columns: ['Run', 'GC pause max (ms)'], rows: chrono.map((x) => [x.run.runId, x.stats?.gcPauseMax ?? null]) }} />
                </div>
              ) : !across.some((x) => x.loading) && <div className="muted small">{chrono.length ? 'Only one recent run has JVM data — a trend needs at least two.' : 'None of the recent runs reported JVM metrics.'}</div>}
              <DataTable rows={across} columns={acrossCols} rowKey={(x) => x.run.id} onRowClick={(x) => f.set({ runId: x.run.runId })} searchable={false} exportName="app-monitoring-runs" maxHeight={360} />
            </div>
          )}
        </Card>

        {/* ---------------------------------------------------------------- applications */}
        <Card title={<span className="row" style={{ gap: 6 }}><LayoutGrid size={13} />Applications</span>} actions={<Link className="btn btn-sm" to="/applications"><Cpu size={13} />Manage applications</Link>} noPad>
          <DataTable rows={apps.data ?? []} columns={appCols} rowKey={(a) => a.id} loading={apps.isLoading} exportName="applications" maxHeight={420}
            onRowClick={(a) => a.runs && f.set({ projectId: a.project_id, applicationId: a.id, environmentId: null, testId: null, runId: null })}
            empty={<EmptyState icon={<LayoutGrid size={20} />} title="No applications">Create applications under <Link to="/applications">Applications</Link> to group environments, tests and services.</EmptyState>} />
        </Card>

        {!noRun && targets.length > 0 && <IngestGuide kind="jvm" title="Send more JVM & service metrics" />}
      </div>
    </div>
  );
}
