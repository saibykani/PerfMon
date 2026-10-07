import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Info, Lock, Pencil, Plus, Server as ServerIcon, Trash2 } from 'lucide-react';
import { api } from '@/services/api';
import { Card, ConfirmDialog, ErrorBox, KeyValue, Kpi, Loading, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Chart } from '@/charts/Chart';
import { seriesTable, timeSeriesOption, type TsSeries } from '@/charts/builders';
import { useUi } from '@/stores/ui';
import { useFilters } from '@/stores/filters';
import { fmtBytes, fmtDate, fmtNum, fmtRelative } from '@/components/format';
import { CodeBlock, EmptyState, HealthChip, Notice, Toaster, UsageBar, friendlyError, num, toast, useCan } from '@/components/inventory/common';
import { useEnvironments, useInvalidateInventory, useProjects, useRuns, useServers, type Server } from '@/components/inventory/data';
import { ServerForm } from '@/components/inventory/forms';
import { perfmonOrigin } from '@/components/inventory/NewRun';

const RANGES = [{ key: '24h', label: 'Last 24 hours', ms: 864e5 }, { key: '7d', label: 'Last 7 days', ms: 7 * 864e5 }, { key: '30d', label: 'Last 30 days', ms: 30 * 864e5 }, { key: '90d', label: 'Last 90 days', ms: 90 * 864e5 }];
interface InfraResp { servers: { id: string; name: string; cpu_avg: number | null; cpu_max: number | null; mem_avg: number | null; mem_max: number | null; disk_max: number | null; net_in_avg: number | null; net_out_avg: number | null; load_max: number | null }[]; step: number; series: ({ t: number; server_id: string } & Record<string, number | null>)[] }

export function InfrastructurePage() {
  const can = useCan();
  const inv = useInvalidateInventory();
  const [projectId, setProjectId] = useState(useFilters.getState().projectId ?? '');
  const [environmentId, setEnvironmentId] = useState('');
  const projects = useProjects();
  const envs = useEnvironments({ projectId: projectId || null });
  const { data, isLoading, error } = useServers({ projectId: projectId || null, environmentId: environmentId || null });
  const [form, setForm] = useState<{ open: boolean; server?: Server | null }>({ open: false });
  const [del, setDel] = useState<Server | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const rows = data ?? [];
  const sel = rows.find((s) => s.id === selId) ?? null;
  useEffect(() => { if (!selId && rows.length) setSelId((rows.find((s) => s.metrics_at) ?? rows[0]).id); }, [rows, selId]);

  const remove = async (s: Server) => { try { await api.del(`/servers/${s.id}`, { confirm: true }); inv(); if (selId === s.id) setSelId(null); toast.success(`Server “${s.name}” removed`); } catch (e) { toast.error(friendlyError(e)); } };
  const recent = rows.filter((s) => s.last_seen_at && Date.now() - +new Date(s.last_seen_at) < 15 * 60e3).length;
  const cpuVals = rows.map((s) => num(s.cpu_pct)).filter((v): v is number => v != null);
  const bad = rows.filter((s) => s.status === 'WARNING' || s.status === 'CRITICAL').length;

  const cols: Column<Server>[] = [
    { key: 'name', header: 'Server', render: (s) => <span><b className="mono">{s.name}</b>{s.id === selId && <span className="badge accent" style={{ marginLeft: 6 }}>VIEWING</span>}</span> },
    { key: 'host', header: 'IP / Hostname', value: (s) => s.ip_address ?? s.hostname, render: (s) => <span className="mono">{[s.ip_address, s.hostname].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'os', header: 'OS' },
    { key: 'cpu_cores', header: 'CPU cores', align: 'right' },
    { key: 'memory_mb', header: 'Memory', align: 'right', render: (s) => (s.memory_mb ? fmtBytes(s.memory_mb * 1048576) : '—') },
    { key: 'disk_gb', header: 'Disk', align: 'right', render: (s) => (s.disk_gb ? `${fmtNum(s.disk_gb)} GB` : '—') },
    { key: 'environment_name', header: 'Environment' },
    { key: 'application_name', header: 'Application', render: (s) => s.application_name ?? <span className="muted">shared</span> },
    { key: 'role', header: 'Role', render: (s) => (s.role ? <span className="badge">{s.role}</span> : '—') },
    { key: 'status', header: 'Status', render: (s) => <HealthChip status={s.status} /> },
    { key: 'cpu_pct', header: 'CPU', value: (s) => num(s.cpu_pct), render: (s) => <UsageBar value={num(s.cpu_pct)} /> },
    { key: 'memory_pct', header: 'Memory %', value: (s) => num(s.memory_pct), render: (s) => <UsageBar value={num(s.memory_pct)} warn={80} crit={92} /> },
    { key: 'disk_pct', header: 'Disk %', value: (s) => num(s.disk_pct), render: (s) => <UsageBar value={num(s.disk_pct)} warn={80} crit={90} /> },
    { key: 'last_seen_at', header: 'Last seen', value: (s) => (s.last_seen_at ? +new Date(s.last_seen_at) : null), render: (s) => <span title={fmtDate(s.last_seen_at)}>{s.last_seen_at ? fmtRelative(s.last_seen_at) : <span className="muted">never</span>}</span> },
    { key: 'act', header: '', sortable: false, render: (s) => can('MANAGE_PROJECT') && (
      <span className="inv-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${s.name}`} onClick={() => setForm({ open: true, server: s })}><Pencil size={13} /></button>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Remove ${s.name}`} onClick={() => setDel(s)}><Trash2 size={13} /></button>
      </span>) },
  ];

  return (
    <div>
      <Toaster />
      <PageHeader title="Infrastructure" subtitle="Servers under test, their latest utilisation and per-run resource metrics."
        actions={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={15} />Register server</button>} />
      <div className="inv-kpis">
        <Kpi label="Servers" value={isLoading ? '…' : fmtNum(rows.length)} />
        <Kpi label="Reporting (15 min)" value={isLoading ? '…' : fmtNum(recent)} sub={rows.length ? `of ${rows.length}` : undefined} />
        <Kpi label="Healthy" value={isLoading ? '…' : fmtNum(rows.filter((s) => s.status === 'HEALTHY').length)} status={rows.length && !bad ? 'pass' : null} />
        <Kpi label="Warning / critical" value={isLoading ? '…' : fmtNum(bad)} status={bad ? 'fail' : null} />
        <Kpi label="Avg CPU (latest)" value={cpuVals.length ? (cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length).toFixed(1) : '—'} unit={cpuVals.length ? '%' : undefined} />
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ marginBottom: 12 }}>
        <DataTable rows={rows} columns={cols} rowKey={(s) => s.id} loading={isLoading} onRowClick={(s) => setSelId(s.id)} exportName="servers" maxHeight={420}
          toolbar={<>
            <select className="select" aria-label="Project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnvironmentId(''); setSelId(null); }}><option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select className="select" aria-label="Environment" value={environmentId} onChange={(e) => { setEnvironmentId(e.target.value); setSelId(null); }}><option value="">All environments</option>{envs.data?.map((en) => <option key={en.id} value={en.id}>{en.name} · {en.application_name}</option>)}</select>
          </>}
          empty={<EmptyState icon={<ServerIcon size={20} />} title="No servers" action={can('MANAGE_PROJECT') && <button className="btn btn-primary" onClick={() => setForm({ open: true })}><Plus size={14} />Register server</button>}>
            Servers appear automatically when the Perfmon Collector reports, or register them manually.</EmptyState>} />
      </div>

      <div className="inv-split">
        <ServerMetrics server={sel} servers={rows} onSelect={setSelId} />
        <CollectorCard server={sel} projectKey={projects.data?.find((p) => p.id === (sel?.project_id ?? projectId))?.key} />
      </div>

      <ServerForm open={form.open} server={form.server} projectId={projectId || null} onClose={() => setForm({ open: false })} onSaved={(s) => setSelId(s.id)} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Remove server “${del?.name ?? ''}”?`} requireText={del?.name} confirmLabel="Remove server"
        message="The server and its entire metric history are deleted. If the collector keeps reporting, the server is re-registered automatically." onConfirm={() => del && remove(del)} />
    </div>
  );
}

function ServerMetrics({ server, servers, onSelect }: { server: Server | null; servers: Server[]; onSelect: (id: string) => void }) {
  const theme = useUi((s) => s.theme);
  const [range, setRange] = useState('30d');
  const [runKey, setRunKey] = useState<string | null>(null);
  const from = useMemo(() => new Date(Date.now() - (RANGES.find((r) => r.key === range)?.ms ?? 30 * 864e5)).toISOString(), [range]);
  const runs = useRuns(server ? { ...(server.environment_id ? { environmentId: server.environment_id } : { projectId: server.project_id }), from, pageSize: 20, sort: 'start', order: 'desc' } : {}, !!server);
  useEffect(() => setRunKey(null), [server?.id, range]);

  // find the most recent run in the window that actually recorded metrics for this server
  const found = useQuery({
    queryKey: ['inv', 'server-run', server?.id, runs.data?.items.map((r) => r.id).join(',')],
    enabled: !!server && !!runs.data,
    queryFn: async () => {
      for (const r of (runs.data?.items ?? []).filter((x) => x.startedAt).slice(0, 8)) {
        const res = await api.get<InfraResp>(`/runs/${r.runId}/infrastructure`);
        if (res.servers.some((s) => s.id === server!.id)) return { runKey: r.runId, data: res };
      }
      return null;
    },
  });
  const activeKey = runKey ?? found.data?.runKey ?? null;
  const picked = useQuery({ queryKey: ['inv', 'run-infra', activeKey], enabled: !!activeKey && activeKey !== found.data?.runKey, queryFn: () => api.get<InfraResp>(`/runs/${activeKey}/infrastructure`) });
  const infra = activeKey === found.data?.runKey ? found.data?.data : picked.data;
  const pts = (infra?.series ?? []).filter((p) => p.server_id === server?.id);
  const agg = infra?.servers.find((s) => s.id === server?.id);
  const ser = (name: string, col: string, key: string): TsSeries => ({ name, key, data: pts.map((p) => [p.t, num(p[col])]) });
  const cpu = [ser('CPU %', 'cpu_pct', 'cpu')];
  const mem = [ser('Memory %', 'memory_pct', 'memory')];
  const disk = [ser('Disk used %', 'disk_pct', 'disk')];
  const net = [ser('Network in', 'net_in_bps', 'tps'), ser('Network out', 'net_out_bps', 'p95')];
  const loading = runs.isLoading || found.isLoading || picked.isLoading;
  const noData = !loading && !pts.length;

  return (
    <Card title={<span className="row" style={{ gap: 6 }}><Cpu size={13} />Server metrics</span>} actions={<>
      <select className="select" aria-label="Server" value={server?.id ?? ''} onChange={(e) => onSelect(e.target.value)} style={{ maxWidth: 200 }}>
        {!server && <option value="">Select a server</option>}{servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select className="select" aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
    </>}>
      {!server ? <EmptyState icon={<ServerIcon size={20} />} title="Select a server">Pick a server above to see CPU, memory, disk and network.</EmptyState> : (
        <div className="stack">
          <Notice icon={<Info size={15} />}>
            Server metrics are stored per test run. This view shows the run window of the most recent run in <b>{RANGES.find((r) => r.key === range)?.label.toLowerCase()}</b> that recorded data for <b className="mono">{server.name}</b>
            {server.metrics_at && <> (latest sample {fmtRelative(server.metrics_at)}: CPU {num(server.cpu_pct)?.toFixed(0) ?? '—'}%, memory {num(server.memory_pct)?.toFixed(0) ?? '—'}%, disk {num(server.disk_pct)?.toFixed(0) ?? '—'}%)</>}.
          </Notice>
          <div className="row wrap">
            <label className="muted" htmlFor="infra-run">Run</label>
            <select id="infra-run" className="select mono" value={activeKey ?? ''} onChange={(e) => setRunKey(e.target.value || null)} style={{ maxWidth: 360 }}>
              {!activeKey && <option value="">{loading ? 'Searching runs…' : 'No run with data in range'}</option>}
              {runs.data?.items.filter((r) => r.startedAt).map((r) => <option key={r.id} value={r.runId}>{r.runId} · {r.testName} · {fmtDate(r.startedAt)}</option>)}
            </select>
            {activeKey && <Link to={`/runs/${activeKey}/infrastructure`} className="btn btn-sm">Open run</Link>}
          </div>
          {agg && <KeyValue items={[['CPU avg / max', `${num(agg.cpu_avg)?.toFixed(1) ?? '—'}% / ${num(agg.cpu_max)?.toFixed(1) ?? '—'}%`], ['Memory avg / max', `${num(agg.mem_avg)?.toFixed(1) ?? '—'}% / ${num(agg.mem_max)?.toFixed(1) ?? '—'}%`], ['Disk max', `${num(agg.disk_max)?.toFixed(1) ?? '—'}%`], ['Load (1m) max', num(agg.load_max)?.toFixed(2) ?? '—']]} />}
          {loading ? <Loading height={200} /> : noData ? (
            <EmptyState icon={<Cpu size={20} />} title="No metrics for this server in the selected range">Run the Perfmon Collector on the host during a test (see setup), or widen the time range.</EmptyState>
          ) : (
            <div className="inv-grid-2">
              <Chart group="srv" title="CPU" height={180} option={timeSeriesOption({ theme, series: cpu, unit: '%', min: 0, max: 100 })} table={seriesTable(cpu)} />
              <Chart group="srv" title="Memory" height={180} option={timeSeriesOption({ theme, series: mem, unit: '%', min: 0, max: 100 })} table={seriesTable(mem)} />
              <Chart group="srv" title="Disk usage" height={180} option={timeSeriesOption({ theme, series: disk, unit: '%', min: 0, max: 100 })} table={seriesTable(disk)} />
              <Chart group="srv" title="Network" height={180} option={timeSeriesOption({ theme, series: net, unit: 'B/s' })} table={seriesTable(net)} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function CollectorCard({ server, projectKey }: { server: Server | null; projectKey?: string }) {
  const snippet = `# Perfmon Collector — Node.js 18+, no dependencies (collector/collector.mjs)
export PERFMON_URL=${perfmonOrigin()}
export PERFMON_API_KEY=<api key with the "ingest" scope>
export PERFMON_PROJECT=${projectKey ?? '<project key>'}
export PERFMON_ENV=${server?.environment_name ?? '<environment name>'}
export PERFMON_SERVER=${server?.name ?? '$(hostname)'}
export PERFMON_ROLE=${server?.role ?? 'app'}       # app | db | loadgen | gateway
export INTERVAL_SEC=5                 # sampling interval
# export PERFMON_RUN_ID=PF-…         # optional: otherwise the environment's RUNNING run
node collector.mjs`;
  return (
    <Card title="Perfmon Collector setup">
      <div className="stack">
        <div className="muted" style={{ fontSize: 12 }}>Lightweight host agent: samples CPU, memory, load and process data every few seconds and pushes batches to <span className="mono">/api/v1/ingest/infrastructure</span>, correlated to the running test.</div>
        <CodeBlock label={server ? `Collector for ${server.name}` : 'Collector environment'} code={snippet} />
        <Notice kind="warn" icon={<Lock size={15} />}>No credentials are stored for servers. The collector authenticates with a scoped, revocable API key (Admin → API keys); Perfmon never connects to your hosts.</Notice>
        <div className="muted" style={{ fontSize: 12 }}>Databases (PostgreSQL, MySQL, Oracle, MongoDB) and APM/JVM metrics arrive via the same ingestion API or <Link to="/integrations">integrations</Link>.</div>
      </div>
    </Card>
  );
}
