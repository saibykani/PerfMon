import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Database, History, Server as ServerIcon } from 'lucide-react';
import { useFilters } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Kpi, Loading, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Chart } from '@/charts/Chart';
import { runTrendOption } from '@/charts/builders';
import { fmtDate, fmtMs, fmtNum, fmtPct, fmtRelative } from '@/components/format';
import { StatusBadge } from '@/components/Status';
import { EmptyState, HealthChip, UsageBar, num } from '@/components/inventory/common';
import { useServers, useServices, type Server, type Service } from '@/components/inventory/data';
import { RunSelectorBar, useRunSelection } from '@/components/run/RunPicker';
import { MetricGrid } from '@/components/run/tabs/InfraTabs';
import { dbQuery, dbStats, useDbAcrossRuns, useRecentRuns, withPool, type DbStats } from '@/components/databases/dbData';
import { IngestGuide } from '@/components/databases/IngestGuide';
import '@/styles/run.css';
import '@/styles/databases.css';

const poolStatus = (v: number | null) => (v == null ? null : v >= 90 ? 'fail' : v >= 75 ? 'warn' : 'pass');

export function DatabasesPage() {
  const sel = useRunSelection();
  const f = useFilters();
  const theme = useUi((s) => s.theme);
  const db = useQuery({ ...dbQuery(sel.runId ?? ''), enabled: !!sel.runId });
  const services = useServices({ projectId: f.projectId, environmentId: f.environmentId, kind: 'database' });
  const servers = useServers({ projectId: f.projectId, environmentId: f.environmentId });
  const recent = useRecentRuns(8);
  const recentRuns = recent.data?.items ?? [];
  const across = useDbAcrossRuns(recentRuns);
  const [dbId, setDbId] = useState('all');
  useEffect(() => setDbId('all'), [sel.runId]);

  const targets = db.data?.targets ?? [];
  const names = useMemo(() => Object.fromEntries(targets.map((t) => [t.id, t.name ?? 'unnamed database'])), [targets]);
  const allRows = useMemo(() => withPool(db.data?.series ?? []), [db.data]);
  const rows = dbId === 'all' ? allRows : allRows.filter((r) => r.service_id === dbId);
  const st = useMemo(() => dbStats(rows), [rows]);
  const perDb = useMemo(() => targets.map((t) => ({ t, s: dbStats(allRows.filter((r) => r.service_id === t.id)) })), [targets, allRows]);
  const dbHosts = (servers.data ?? []).filter((s) => s.role === 'db');
  const missing = (['locks', 'deadlocks', 'transactions_per_sec', 'memory_pct', 'max_connections', 'cpu_pct'] as const).filter((c) => !rows.some((r) => r[c] != null));

  // across runs (latest first in the API → chronological for the chart)
  const acrossRows = recentRuns.map((r, i) => ({ run: r, data: across[i]?.data, loading: across[i]?.isLoading, stats: across[i]?.data ? dbStats(across[i].data!.series) : null }));
  const withDb = acrossRows.filter((x) => x.data?.targets.length);
  const chrono = [...withDb].reverse();

  const acrossCols: Column<(typeof acrossRows)[number]>[] = [
    { key: 'run', header: 'Run', value: (x) => x.run.runId, render: (x) => <span className="row" style={{ gap: 6 }}><span className="mono">{x.run.runId}</span>{x.run.runId === sel.runId && <span className="badge accent">VIEWING</span>}</span> },
    { key: 'test', header: 'Test', value: (x) => x.run.testName, render: (x) => <span>{x.run.testName}<span className="muted small"> · build {x.run.buildNumber ?? '—'}</span></span> },
    { key: 'started', header: 'Started', value: (x) => (x.run.startedAt ? +new Date(x.run.startedAt) : null), render: (x) => fmtDate(x.run.startedAt) },
    { key: 'result', header: 'Result', value: (x) => x.run.result, render: (x) => <StatusBadge value={x.run.result} /> },
    { key: 'dbs', header: 'Databases', value: (x) => x.data?.targets.length ?? null, render: (x) => (x.loading ? '…' : x.data?.targets.length ? x.data.targets.map((t) => t.name).join(', ') : <span className="muted">no DB data</span>) },
    { key: 'lat', header: 'Latency avg', align: 'right', value: (x) => x.stats?.latencyAvg ?? null, render: (x) => fmtMs(x.stats?.latencyAvg) },
    { key: 'latmax', header: 'Latency max', align: 'right', value: (x) => x.stats?.latencyMax ?? null, render: (x) => fmtMs(x.stats?.latencyMax) },
    { key: 'pool', header: 'Pool max', align: 'right', value: (x) => x.stats?.poolMaxPct ?? null, render: (x) => fmtPct(x.stats?.poolMaxPct, 0) },
    { key: 'slow', header: 'Slow queries', align: 'right', value: (x) => x.stats?.slowTotal ?? null, render: (x) => (x.stats?.slowTotal != null ? `≈ ${fmtNum(x.stats.slowTotal)}` : '—') },
    { key: 'locks', header: 'Locks max', align: 'right', value: (x) => x.stats?.locksMax ?? null, render: (x) => fmtNum(x.stats?.locksMax) },
  ];

  const svcCols: Column<Service>[] = [
    { key: 'name', header: 'Database', render: (s) => <span className="row" style={{ gap: 6 }}><Database size={13} /><b>{s.name}</b>{targets.some((t) => t.id === s.id) && <span className="badge accent" title="Reported metrics in the selected run">IN RUN</span>}</span> },
    { key: 'technology', header: 'Technology', render: (s) => s.technology ?? '—' },
    { key: 'environment_name', header: 'Environment', render: (s) => s.environment_name ?? '—' },
    { key: 'application_name', header: 'Application', render: (s) => s.application_name ?? <span className="muted">shared</span> },
    { key: 'health_status', header: 'Health', render: (s) => <HealthChip status={s.health_status} /> },
  ];
  const hostCols: Column<Server>[] = [
    { key: 'name', header: 'Host', render: (s) => <span><b className="mono">{s.name}</b>{s.hostname && <span className="muted small"> · {s.hostname}</span>}</span> },
    { key: 'environment_name', header: 'Environment', render: (s) => s.environment_name ?? '—' },
    { key: 'cpu_pct', header: 'CPU', value: (s) => num(s.cpu_pct), render: (s) => <UsageBar value={num(s.cpu_pct)} /> },
    { key: 'memory_pct', header: 'Memory', value: (s) => num(s.memory_pct), render: (s) => <UsageBar value={num(s.memory_pct)} warn={80} crit={92} /> },
    { key: 'last_seen_at', header: 'Last seen', value: (s) => (s.last_seen_at ? +new Date(s.last_seen_at) : null), render: (s) => (s.last_seen_at ? fmtRelative(s.last_seen_at) : <span className="muted">never</span>) },
  ];

  const noRun = !sel.loading && !sel.runId;
  return (
    <div className="dbm-page">
      <PageHeader title="Databases" subtitle="Database health per test run — query latency, connection pool, slow queries, locks and resource use — and how it moves across runs."
        actions={<Link className="btn" to="/help/database-monitoring"><BookOpen size={14} />Database monitoring guide</Link>} />
      <RunSelectorBar sel={sel} />

      {noRun ? (
        <div className="stack">
          <Card><EmptyState icon={<History size={22} />} title="No completed runs match the filters">Clear or change the filters above, or complete a test run. Database metrics are stored per run.</EmptyState></Card>
          <IngestGuide kind="database" />
        </div>
      ) : (
        <div className="stack">
          <ErrorBox error={db.error} />
          {sel.loading || db.isLoading ? <Loading height={260} /> : !targets.length ? (
            <div className="dbm-split">
              <Card>
                <EmptyState icon={<Database size={22} />} title={<>No database metrics for {sel.run ? <span className="mono">{sel.run.runId}</span> : 'this run'}</>}>
                  Database series (connections, query latency, slow queries, locks) appear here when a DB exporter or integration pushes them while the test runs.
                  Follow the steps on the right, then start a new run — or pick another run above. <Link to="/help/database-monitoring">Read the guide</Link>.
                </EmptyState>
              </Card>
              <IngestGuide kind="database" />
            </div>
          ) : (
            <>
              <Card title={<span className="row" style={{ gap: 6 }}><Database size={13} />Database metrics in this run</span>}
                actions={targets.length > 1 && (
                  <select className="select" aria-label="Database" value={dbId} onChange={(e) => setDbId(e.target.value)}>
                    <option value="all">All databases ({targets.length})</option>
                    {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}>
                <div className="stack">
                  <div className="dbm-kpis">
                    <Kpi label="Query latency avg" value={fmtMs(st.latencyAvg)} sub={`max ${fmtMs(st.latencyMax)}`} />
                    <Kpi label="Active connections" value={fmtNum(st.activeMax)} sub={st.maxConns ? `peak · limit ${fmtNum(st.maxConns)}` : 'peak · no limit reported'} />
                    <Kpi label="Pool utilisation" value={st.poolMaxPct != null ? fmtPct(st.poolMaxPct, 0) : '—'} sub={st.poolMaxPct != null ? 'peak active / max' : 'send maxConnections'} status={poolStatus(st.poolMaxPct)} />
                    <Kpi label="Slow queries" value={st.slowTotal != null ? `≈ ${fmtNum(st.slowTotal)}` : '—'} sub={st.slowPeak != null ? `peak ${fmtNum(st.slowPeak)} / interval` : undefined} status={st.slowTotal == null ? null : st.slowTotal > 0 ? 'warn' : 'pass'} />
                    <Kpi label="Locks (max)" value={fmtNum(st.locksMax)} sub={st.deadlocks != null ? `${fmtNum(st.deadlocks)} deadlocks` : undefined} status={st.deadlocks ? 'fail' : null} />
                    <Kpi label="DB CPU" value={st.cpuAvg != null ? fmtPct(st.cpuAvg, 0) : '—'} sub={st.cpuMax != null ? `max ${fmtPct(st.cpuMax, 0)}` : undefined} status={st.cpuMax == null ? null : st.cpuMax >= 90 ? 'fail' : st.cpuMax >= 75 ? 'warn' : null} />
                    <Kpi label="DB transactions" value={st.tpsAvg != null ? fmtNum(st.tpsAvg, 1) : '—'} unit={st.tpsAvg != null ? '/s' : undefined} sub="average" />
                  </div>
                  {targets.length > 1 && dbId === 'all' && <PerDbTable rows={perDb} onPick={setDbId} />}
                  <MetricGrid rows={rows} entityKey="service_id" names={names} group={`dbm-${sel.runId}`} specs={[
                    { title: 'Query latency', unit: 'ms', cols: [{ col: 'query_latency_ms', label: 'avg' }, { col: 'query_latency_ms_max', label: 'max', dashed: true }] },
                    { title: 'Connections', cols: [{ col: 'connections', label: 'open' }, { col: 'active_connections', label: 'active' }, { col: 'max_connections', label: 'limit', dashed: true }] },
                    { title: 'Pool utilisation', unit: '%', cols: [{ col: 'pool_pct' }], max: 100 },
                    { title: 'Slow queries (per interval)', cols: [{ col: 'slow_queries' }] },
                    { title: 'Locks / deadlocks', cols: [{ col: 'locks', label: 'locks' }, { col: 'deadlocks', label: 'deadlocks', dashed: true }] },
                    { title: 'Transactions/s', unit: 'tps', cols: [{ col: 'transactions_per_sec' }] },
                    { title: 'DB CPU', unit: '%', cols: [{ col: 'cpu_pct' }], max: 100 },
                    { title: 'DB memory', unit: '%', cols: [{ col: 'memory_pct' }], max: 100 },
                  ]} />
                  <div className="muted small">
                    {db.data?.step ? `Bucket ${db.data.step}s. ` : ''}
                    {missing.length > 0 && <>Not reported in this run: {missing.map((m) => m.replace(/_/g, ' ')).join(', ')}. </>}
                    Correlate with response time on the <Link to={`/runs/${sel.runId}`}>run timeline</Link>.
                  </div>
                </div>
              </Card>
            </>
          )}

          <Card title={<span className="row" style={{ gap: 6 }}><History size={13} />Across recent runs</span>} actions={<span className="muted small">latest {recentRuns.length} completed runs in scope</span>}>
            {recent.isLoading ? <Loading height={160} /> : !recentRuns.length ? <EmptyState title="No completed runs in scope" /> : (
              <div className="stack">
                {chrono.length >= 2 ? (
                  <Chart height={200} title="Query latency by run" onPointClick={(p) => { const x = chrono[p.dataIndex]; if (x) f.set({ runId: x.run.runId }); }}
                    option={runTrendOption({ theme, labels: chrono.map((x) => x.run.runId.replace(/^PF-\d{4}-/, '')), unit: 'ms', series: [
                      { name: 'Latency avg', key: 'latency', data: chrono.map((x) => x.stats?.latencyAvg ?? null) },
                      { name: 'Latency max', slot: 3, data: chrono.map((x) => x.stats?.latencyMax ?? null) },
                    ] })}
                    table={{ columns: ['Run', 'Latency avg (ms)', 'Latency max (ms)'], rows: chrono.map((x) => [x.run.runId, x.stats?.latencyAvg == null ? null : +x.stats.latencyAvg.toFixed(1), x.stats?.latencyMax ?? null]) }} />
                ) : !across.some((q) => q.isLoading) && <div className="muted small">{withDb.length ? 'Only one recent run has database data — a trend needs at least two.' : 'None of the recent runs reported database metrics.'}</div>}
                <DataTable rows={acrossRows} columns={acrossCols} rowKey={(x) => x.run.id} onRowClick={(x) => f.set({ runId: x.run.runId })} searchable={false} exportName="database-runs" maxHeight={360} />
              </div>
            )}
          </Card>

          <div className="dbm-grid-2">
            <Card title={<span className="row" style={{ gap: 6 }}><Database size={13} />Database inventory</span>} noPad>
              <DataTable rows={services.data ?? []} columns={svcCols} rowKey={(s) => s.id} loading={services.isLoading} searchable={false} exportName="databases" maxHeight={320}
                empty={<EmptyState icon={<Database size={20} />} title="No databases registered">A database is registered automatically (service kind <span className="mono">database</span>) the first time metrics arrive for it.</EmptyState>} />
            </Card>
            <Card title={<span className="row" style={{ gap: 6 }}><ServerIcon size={13} />Database hosts</span>} noPad>
              <DataTable rows={dbHosts} columns={hostCols} rowKey={(s) => s.id} loading={servers.isLoading} searchable={false} maxHeight={320}
                empty={<EmptyState icon={<ServerIcon size={20} />} title="No database hosts">Run the Perfmon Collector on DB hosts with <span className="mono">PERFMON_ROLE=db</span> to see host CPU and memory. <Link to="/help/server-monitoring">Server monitoring guide</Link></EmptyState>} />
            </Card>
          </div>
          {targets.length > 0 && <IngestGuide kind="database" title="Send more database metrics" />}
        </div>
      )}
    </div>
  );
}

function PerDbTable({ rows, onPick }: { rows: { t: { id: string; name: string | null; technology: string | null; db_engine: string | null }; s: DbStats }[]; onPick: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="table compact-table">
        <thead><tr><th>Database</th><th>Engine</th><th className="r">Latency avg</th><th className="r">Latency max</th><th className="r">Active max</th><th className="r">Pool max</th><th className="r">Slow queries</th><th className="r">Locks max</th><th className="r">CPU avg</th></tr></thead>
        <tbody>{rows.map(({ t, s }) => (
          <tr key={t.id} className="clickable" onClick={() => onPick(t.id)}>
            <td><b>{t.name}</b></td><td>{[t.technology, t.db_engine].filter(Boolean).join(' · ') || '—'}</td>
            <td className="r num">{fmtMs(s.latencyAvg)}</td><td className="r num">{fmtMs(s.latencyMax)}</td><td className="r num">{fmtNum(s.activeMax)}</td>
            <td className="r num">{s.poolMaxPct != null ? <span className={`badge ${poolStatus(s.poolMaxPct)}`}>{fmtPct(s.poolMaxPct, 0)}</span> : '—'}</td>
            <td className="r num">{s.slowTotal != null ? `≈ ${fmtNum(s.slowTotal)}` : '—'}</td><td className="r num">{fmtNum(s.locksMax)}</td><td className="r num">{fmtPct(s.cpuAvg, 0)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

