import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Cpu, Database, Server, Info, Boxes } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Chart } from '@/charts/Chart';
import { timeSeriesOption, seriesTable, type TsSeries } from '@/charts/builders';
import { ErrorBox, Kpi } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { fmtMs, fmtNum, fmtPct } from '@/components/format';
import { EmptyState, SkeletonGrid } from '../common';
import type { RunDetail } from '../types';

const enc = encodeURIComponent;

export interface MetricSpec { title: string; unit?: string; cols: { col: string; label?: string; dashed?: boolean }[]; min?: number; max?: number }

/**
 * Small-multiple grid of per-entity metric charts (one unit per chart, synchronized via `group`).
 * Series colours follow the entity (fixed order by name), never the rank.
 */
export function MetricGrid({ rows, entityKey, names, specs, group, height = 180 }: { rows: any[]; entityKey: string; names: Record<string, string>; specs: MetricSpec[]; group: string; height?: number }) {
  const theme = useUi((s) => s.theme);
  const entities = useMemo(() => [...new Set(rows.map((r) => r[entityKey] ?? 'unknown'))].sort((a, b) => (names[a] ?? a).localeCompare(names[b] ?? b)), [rows, entityKey, names]);
  const charts = useMemo(() => specs.map((sp) => {
    const series: TsSeries[] = [];
    entities.forEach((e, ei) => sp.cols.forEach((c, ci) => {
      const data = rows.filter((r) => (r[entityKey] ?? 'unknown') === e).map((r) => [Number(r.t), r[c.col] == null ? null : Number(r[c.col])] as [number, number | null]);
      if (!data.some((d) => d[1] != null)) return;
      const base = entities.length > 1 ? names[e] ?? e : '';
      series.push({ name: [base, c.label].filter(Boolean).join(' · ') || sp.title, slot: entities.length > 1 ? (ei * Math.max(1, sp.cols.length) + ci) % 8 : ci, data, dashed: c.dashed });
    }));
    return { sp, series };
  }).filter((c) => c.series.length), [specs, entities, rows, entityKey, names]);
  if (!charts.length) return null;
  return (
    <div className="grid g2">
      {charts.map(({ sp, series }) => (
        <Chart key={sp.title} title={sp.title} height={height} group={group}
          option={{ ...timeSeriesOption({ theme, series, unit: sp.unit, min: sp.min ?? 0, max: sp.max }), grid: { left: 58, right: 18, containLabel: false, top: series.length > 1 ? 28 : 10, bottom: 22 } } as any}
          table={seriesTable(series)} />
      ))}
    </div>
  );
}

const noData = (what: string, how: string) => <EmptyState icon={<Server size={22} />} title={`No ${what} metrics for this run`}>{how}</EmptyState>;

export function InfrastructureTab({ run }: { run: RunDetail }) {
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'infra'], queryFn: () => api.get<{ servers: any[]; step: number; series: any[] }>(`/runs/${enc(run.runId)}/infrastructure`) });
  const names = useMemo(() => Object.fromEntries((q.data?.servers ?? []).map((s) => [s.id, s.name])), [q.data]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={6} height={180} />;
  const servers = q.data?.servers ?? [];
  return (
    <div className="stack">
      {servers.length ? (
        <section className="card">
          <div className="card-head"><h3><Server size={13} /> Servers in this run</h3><span className="muted small">{servers.length} servers · step {q.data?.step}s</span></div>
          <div className="table-wrap">
            <table className="table compact-table">
              <thead><tr><th>Server</th><th>Role</th><th>Status</th><th className="r">Cores / RAM</th><th className="r">CPU avg</th><th className="r">CPU max</th><th className="r">Mem avg</th><th className="r">Mem max</th><th className="r">Disk max</th><th className="r">Load max</th><th className="r">TCP max</th><th className="r">FDs max</th></tr></thead>
              <tbody>{servers.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b>{s.hostname && <span className="muted small"> · {s.hostname}</span>}</td><td>{s.role ?? '—'}</td><td><StatusBadge value={s.status} /></td>
                  <td className="r num">{s.cpu_cores ?? '—'} / {s.memory_mb ? `${Math.round(s.memory_mb / 1024)} GB` : '—'}</td>
                  <td className="r num"><UtilCell v={s.cpu_avg} /></td><td className="r num"><UtilCell v={s.cpu_max} /></td><td className="r num"><UtilCell v={s.mem_avg} /></td><td className="r num"><UtilCell v={s.mem_max} /></td>
                  <td className="r num"><UtilCell v={s.disk_max} /></td><td className="r num">{fmtNum(s.load_max, 2)}</td><td className="r num">{fmtNum(s.tcp_max)}</td><td className="r num">{fmtNum(s.fd_max)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </section>
      ) : noData('infrastructure', 'Send server metrics (CPU, memory, disk, network) tagged with the Run ID via the collector or the /ingest/infra API, or use the Telegraf/Prometheus integration.')}
      <MetricGrid rows={q.data?.series ?? []} entityKey="server_id" names={names} group={`infra-${run.runId}`} specs={[
        { title: 'CPU', unit: '%', cols: [{ col: 'cpu_pct' }], max: 100 },
        { title: 'Memory', unit: '%', cols: [{ col: 'memory_pct' }], max: 100 },
        { title: 'Disk usage', unit: '%', cols: [{ col: 'disk_pct' }], max: 100 },
        { title: 'Disk I/O', unit: 'B/s', cols: [{ col: 'disk_read_bps', label: 'read' }, { col: 'disk_write_bps', label: 'write', dashed: true }] },
        { title: 'Network', unit: 'B/s', cols: [{ col: 'net_in_bps', label: 'in' }, { col: 'net_out_bps', label: 'out', dashed: true }] },
        { title: 'Load average (1m)', cols: [{ col: 'load_avg_1m' }] },
        { title: 'TCP connections', cols: [{ col: 'tcp_connections' }] },
        { title: 'File descriptors', cols: [{ col: 'file_descriptors' }] },
        { title: 'Processes', cols: [{ col: 'processes' }] },
      ]} />
      <ServicesCard run={run} />
    </div>
  );
}

function UtilCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="muted">—</span>;
  const lvl = v >= 90 ? 'fail' : v >= 80 ? 'warn' : 'ok';
  return <span className={`util util-${lvl}`}>{fmtPct(Number(v), 1)}</span>;
}

export function ServicesCard({ run }: { run: RunDetail }) {
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'services'], queryFn: () => api.get<{ services: any[]; dependencies: { source: string; target: string }[] }>(`/runs/${enc(run.runId)}/services`) });
  const svcs = q.data?.services ?? [];
  const byId = Object.fromEntries(svcs.map((s) => [s.id, s]));
  if (!svcs.length) return null;
  return (
    <section className="card">
      <div className="card-head"><h3><Boxes size={13} /> Services & service map</h3><span className="muted small">{svcs.length} services in {run.environmentName}</span></div>
      <div className="card-body stack">
        <div className="svc-grid">
          {svcs.map((s) => (
            <div key={s.id} className="svc-card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="row" style={{ gap: 6 }}>{s.kind === 'database' ? <Database size={14} /> : <Cpu size={14} />}<b>{s.name}</b></span>
                <StatusBadge value={s.health_status} />
              </div>
              <div className="muted small">{s.kind}{s.technology ? ` · ${s.technology}` : ''}</div>
              <div className="svc-stats">
                <span><i>req/s</i>{fmtNum(s.request_rate, 1)}</span><span><i>err</i>{fmtPct(s.error_rate_pct)}</span>
                <span><i>p95</i>{fmtMs(s.p95_latency_ms)}</span><span><i>cpu</i>{fmtPct(s.cpu_pct, 0)}</span>
              </div>
            </div>
          ))}
        </div>
        {q.data!.dependencies.length > 0 && (
          <div className="deps">
            <div className="muted small" style={{ marginBottom: 4 }}>Dependencies</div>
            {q.data!.dependencies.map((d, i) => <div key={i} className="dep"><span>{byId[d.source]?.name ?? d.source}</span><ArrowRight size={13} /><span>{byId[d.target]?.name ?? d.target}</span></div>)}
          </div>
        )}
      </div>
    </section>
  );
}

export function JvmTab({ run }: { run: RunDetail }) {
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'jvm'], queryFn: () => api.get<{ targets: { name: string; server_id: string; service_id: string }[]; step: number; series: any[] }>(`/runs/${enc(run.runId)}/jvm`) });
  const names = useMemo(() => Object.fromEntries((q.data?.targets ?? []).map((t) => [t.server_id, t.name])), [q.data]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={6} height={180} />;
  const rows = q.data?.series ?? [];
  if (!rows.length) return noData('JVM', 'Expose JVM metrics (heap, GC, threads) via JMX/Jolokia, Micrometer or the collector agent and tag them with the Run ID.');
  const last = (col: string) => { const v = rows.map((r) => r[col]).filter((x) => x != null); return v.length ? Math.max(...v.map(Number)) : null; };
  const heapMax = last('heap_max_mb');
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="JVM targets" value={fmtNum(q.data?.targets.length)} sub={q.data?.targets.map((t) => t.name).join(', ')} />
        <Kpi label="Heap used (max)" value={fmtNum(last('heap_used_mb'))} unit="MB" sub={heapMax ? `${fmtPct(((last('heap_used_mb') ?? 0) / heapMax) * 100, 0)} of ${fmtNum(heapMax)} MB` : undefined} />
        <Kpi label="GC max pause" value={fmtMs(last('gc_max_pause_ms'))} />
        <Kpi label="Threads (max)" value={fmtNum(last('thread_count'))} />
      </div>
      <MetricGrid rows={rows} entityKey="server_id" names={names} group={`jvm-${run.runId}`} specs={[
        { title: 'Heap', unit: 'MB', cols: [{ col: 'heap_used_mb', label: 'used' }, { col: 'heap_committed_mb', label: 'committed' }, { col: 'heap_max_mb', label: 'max', dashed: true }] },
        { title: 'Non-heap used', unit: 'MB', cols: [{ col: 'nonheap_used_mb' }] },
        { title: 'GC count', cols: [{ col: 'gc_count' }] },
        { title: 'GC time', unit: 'ms', cols: [{ col: 'gc_time_ms' }] },
        { title: 'GC max pause', unit: 'ms', cols: [{ col: 'gc_max_pause_ms' }] },
        { title: 'Threads', cols: [{ col: 'thread_count', label: 'live' }, { col: 'peak_threads', label: 'peak', dashed: true }] },
        { title: 'Classes loaded', cols: [{ col: 'classes_loaded' }] },
      ]} />
    </div>
  );
}

export function DatabaseTab({ run }: { run: RunDetail }) {
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'db'], queryFn: () => api.get<{ targets: { id: string; name: string; technology: string | null; db_engine: string | null }[]; step: number; series: any[] }>(`/runs/${enc(run.runId)}/database`) });
  const names = useMemo(() => Object.fromEntries((q.data?.targets ?? []).map((t) => [t.id, t.name])), [q.data]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={6} height={180} />;
  const rows = q.data?.series ?? [];
  if (!rows.length) return <EmptyState icon={<Database size={22} />} title="No database metrics for this run">Send database metrics (connections, query latency, slow queries, locks) tagged with the Run ID — e.g. postgres_exporter / mysqld_exporter via the collector.</EmptyState>;
  const mx = (col: string) => { const v = rows.map((r) => r[col]).filter((x) => x != null).map(Number); return v.length ? Math.max(...v) : null; };
  const avg = (col: string) => { const v = rows.map((r) => r[col]).filter((x) => x != null).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Databases" value={fmtNum(q.data?.targets.length)} sub={q.data?.targets.map((t) => `${t.name}${t.technology ? ` (${t.technology})` : ''}`).join(', ')} />
        <Kpi label="Query latency avg" value={fmtMs(avg('query_latency_ms'))} sub={`max ${fmtMs(mx('query_latency_ms'))}`} />
        <Kpi label="Active conns (max)" value={fmtNum(mx('active_connections'))} sub={mx('max_connections') ? `of ${fmtNum(mx('max_connections'))} allowed` : undefined}
          status={mx('max_connections') ? ((mx('active_connections') ?? 0) / mx('max_connections')! >= 0.9 ? 'fail' : (mx('active_connections') ?? 0) / mx('max_connections')! >= 0.75 ? 'warn' : 'pass') : null} />
        <Kpi label="Slow queries (max)" value={fmtNum(mx('slow_queries'))} />
        <Kpi label="Locks (max)" value={fmtNum(mx('locks'))} sub={mx('deadlocks') ? `${fmtNum(mx('deadlocks'))} deadlocks` : undefined} />
      </div>
      <MetricGrid rows={rows} entityKey="service_id" names={names} group={`db-${run.runId}`} specs={[
        { title: 'Connections', cols: [{ col: 'connections', label: 'open' }, { col: 'active_connections', label: 'active' }, { col: 'max_connections', label: 'max', dashed: true }] },
        { title: 'Query latency', unit: 'ms', cols: [{ col: 'query_latency_ms' }] },
        { title: 'Slow queries', cols: [{ col: 'slow_queries' }] },
        { title: 'Locks / deadlocks', cols: [{ col: 'locks', label: 'locks' }, { col: 'deadlocks', label: 'deadlocks', dashed: true }] },
        { title: 'Transactions/s', unit: 'tps', cols: [{ col: 'transactions_per_sec' }] },
        { title: 'DB CPU', unit: '%', cols: [{ col: 'cpu_pct' }], max: 100 },
        { title: 'DB memory', unit: '%', cols: [{ col: 'memory_pct' }], max: 100 },
      ]} />
      <div className="muted small"><Info size={11} /> Correlate DB latency with response time on the Overview timeline — bottleneck analysis uses these series.</div>
    </div>
  );
}
