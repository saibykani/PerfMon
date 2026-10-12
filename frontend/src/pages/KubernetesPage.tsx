import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EChartsOption } from 'echarts';
import {
  AlertOctagon, AlertTriangle, Boxes, CheckCircle2, Container, Cpu, Download, ExternalLink, FileCode2, Layers, MemoryStick, Plug, RefreshCw, Server, X,
} from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { PageHeader, Card, Kpi, Tabs, Empty, ErrorBox, Loading } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Chart } from '@/charts/Chart';
import { fmtBytes, fmtNum } from '@/components/format';
import { Chip, relTime } from '@/components/platform/kit';
import { ObsWindowView } from '@/components/observability/ObsWindow';
import '@/styles/kubernetes.css';

/* ------------------------------------------------------------------ types */

type Level = 'ok' | 'warn' | 'fail' | 'done';
interface Ref { kind: string; name: string }
interface Conn { id: string; name: string; type: string; source: 'kubernetes' | 'dynatrace'; url: string | null; status: string; health: string; lastError: string | null; clusterName: string | null; namespaces: string[]; environment: string | null; sampler: Sampler }
interface Sampler { active: boolean; intervalSec: number; lastSampleAt: string | null; lastError: string | null; linkedRun: string | null }
interface Meta { connection: { id: string; name: string; source: string }; cluster: { name: string; version: string | null; platform: string | null; source: string; url: string | null }; at: string; metricsAvailable: boolean; warnings: string[] }
interface Pod {
  uid: string; name: string; namespace: string; node: string | null; phase: string; status: string; level: Level; ready: number; total: number; restarts: number; lastRestartAt: string | null;
  createdAt: string | null; qos: string | null; owner: Ref | null; workload: Ref | null; ip: string | null; cpu: number | null; memory: number | null;
  cpuRequest: number | null; cpuLimit: number | null; memRequest: number | null; memLimit: number | null;
  containers: { name: string; ready: boolean; restarts: number; state: string; reason: string | null; lastTermination: string | null; image: string }[];
}
interface Workload {
  uid: string; kind: string; name: string; namespace: string; desired: number; ready: number; available: number; updated: number | null; images: string[]; createdAt: string | null;
  pods: number; level: Level; message: string | null; cpu: number | null; memory: number | null; cpuRequest: number | null; cpuLimit: number | null; memRequest: number | null; memLimit: number | null; restarts: number;
  job?: { active: number; succeeded: number; failed: number; completions: number | null };
}
interface NodeT {
  name: string; ready: boolean; status: string; level: Level; roles: string[]; unschedulable: boolean; pressure: string[]; kubelet: string | null; os: string | null; arch: string | null; runtime: string | null;
  kernel: string | null; osImage: string | null; internalIP: string | null; cpuCapacity: number | null; cpuAllocatable: number | null; memCapacity: number | null; memAllocatable: number | null; podsCapacity: number | null;
  pods: number; cpuUsage: number | null; memUsage: number | null; cpuRequests: number; memRequests: number; cpuLimits: number; memLimits: number;
  conditions: { type: string; status: string; reason: string | null; message: string | null }[]; taints: string[]; createdAt: string | null;
}
interface EventT { type: string; reason: string; message: string; kind: string; name: string; namespace: string | null; count: number; firstAt: string | null; lastAt: string | null; source: string | null }
interface Problem { level: 'fail' | 'warn'; kind: string; namespace: string | null; name: string; title: string; detail: string | null; at: string | null }
interface Overview extends Meta {
  sampler: Sampler;
  counts: { nodes: number; nodesReady: number; namespaces: number; workloads: number; workloadsHealthy: number; workloadKinds: Record<string, number>; pods: number; podPhases: Record<string, number>; podsFailing: number; podsNotReady: number; restartsTotal: number; restartedLastHour: number; warningEvents: number };
  capacity: { cpuCapacity: number | null; cpuAllocatable: number | null; cpuUsage: number | null; cpuRequests: number | null; cpuLimits: number | null; memCapacity: number | null; memAllocatable: number | null; memUsage: number | null; memRequests: number | null; memLimits: number | null; podsCapacity: number | null };
  nodes: NodeT[]; namespaces: { name: string; pods: number; running: number; failing: number; workloads: number; cpu: number | null; memory: number | null; restarts: number }[];
  problems: Problem[]; recentWarnings: EventT[];
}

type Tab = 'overview' | 'workloads' | 'pods' | 'nodes' | 'events' | 'trends';
const TABS: Tab[] = ['overview', 'workloads', 'pods', 'nodes', 'events', 'trends'];

/* ------------------------------------------------------------------ formatting */

export const fmtCpu = (m: number | null | undefined) => (m == null || !Number.isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} cores` : `${Math.round(m)}m`);
const fmtMem = (b: number | null | undefined) => (b == null ? '—' : fmtBytes(b));
function fmtAge(v: string | null | undefined) {
  if (!v) return '—';
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ''}`;
  return `${Math.floor(s / 86400)}d`;
}
const pct = (a: number | null | undefined, b: number | null | undefined) => (a == null || !b ? null : (a / b) * 100);
const TONE: Record<Level, 'pass' | 'warn' | 'fail' | 'neutral'> = { ok: 'pass', warn: 'warn', fail: 'fail', done: 'neutral' };

function StatusChip({ level, children }: { level: Level; children: ReactNode }) {
  const icon = level === 'fail' ? <AlertOctagon size={11} /> : level === 'warn' ? <AlertTriangle size={11} /> : <CheckCircle2 size={11} />;
  return <Chip tone={TONE[level]} icon={icon}>{children}</Chip>;
}

/** Usage bar against a reference (limit → request → capacity), with a request marker. */
function UsageBar({ value, limit, request, fmt, compact }: { value: number | null; limit: number | null; request?: number | null; fmt: (v: number | null) => string; compact?: boolean }) {
  const ref = limit ?? request ?? null;
  const p = pct(value, ref);
  const lv = p == null ? 'none' : p >= 90 ? 'fail' : p >= 75 ? 'warn' : 'ok';
  const reqPos = request != null && limit ? Math.min(100, (request / limit) * 100) : null;
  return (
    <div className={`k8s-bar ${compact ? 'compact' : ''}`} title={`usage ${fmt(value)} · request ${fmt(request ?? null)} · limit ${fmt(limit)}`}>
      <div className="k8s-bar-track">
        <div className={`k8s-bar-fill lv-${lv}`} style={{ width: `${Math.min(100, p ?? 0)}%` }} />
        {reqPos != null && <div className="k8s-bar-req" style={{ left: `${reqPos}%` }} />}
      </div>
      <div className="k8s-bar-text num">
        <span>{fmt(value)}</span>
        <span className="muted">{ref != null ? ` / ${fmt(ref)}${limit == null ? ' req' : ''}` : value != null ? ' · no limit' : ''}</span>
        {p != null && <b className={`lv-${lv}`}>{Math.round(p)}%</b>}
      </div>
    </div>
  );
}

const REFRESH = [{ v: 0, l: 'Off' }, { v: 15000, l: '15 s' }, { v: 30000, l: '30 s' }, { v: 60000, l: '1 min' }];
const storage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------------ page */

export function KubernetesPage() {
  const params = useParams();
  const nav = useNavigate();
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'overview';
  const can = useAuth((s) => s.can);
  const conns = useQuery({ queryKey: ['k8s-connections'], queryFn: () => api.get<Conn[]>('/kubernetes/connections'), refetchInterval: 60_000 });
  const list = conns.data ?? [];
  const [connId, setConnId] = useState<string | null>(() => storage.get('perfmon.k8s.conn'));
  const [refresh, setRefresh] = useState<number>(() => Number(storage.get('perfmon.k8s.refresh') ?? 30000));
  const [podFilter, setPodFilter] = useState<{ namespace?: string; workload?: string; status?: string; node?: string }>({});
  const conn = list.find((c) => c.id === connId) ?? list.find((c) => c.status === 'ENABLED') ?? list[0] ?? null;
  useEffect(() => { if (conn) storage.set('perfmon.k8s.conn', conn.id); }, [conn]);
  useEffect(() => { storage.set('perfmon.k8s.refresh', String(refresh)); }, [refresh]);

  const ov = useQuery({
    queryKey: ['k8s', conn?.id, 'overview'], enabled: !!conn && conn.status === 'ENABLED', queryFn: () => api.get<Overview>(`/kubernetes/${conn!.id}/overview`),
    refetchInterval: refresh || false, retry: 0,
  });
  const setTab = (t: Tab) => nav(`/kubernetes${t === 'overview' ? '' : `/${t}`}`);
  const openPods = (f: typeof podFilter) => { setPodFilter(f); setTab('pods'); };
  const meta = ov.data;

  const subtitle = meta ? (
    <span className="k8s-sub">
      <span className="mono">{meta.cluster.name}</span>
      {meta.cluster.version && <span>Kubernetes {meta.cluster.version}</span>}
      <span>{meta.cluster.source === 'dynatrace' ? 'via Dynatrace' : 'API server'}</span>
      <span>updated {relTime(meta.at)}</span>
      {meta.sampler?.active && <span title="Usage is sampled into Perfmon while this module is open">sampling every {meta.sampler.intervalSec}s{meta.sampler.linkedRun ? ` · run ${meta.sampler.linkedRun}` : ''}</span>}
    </span>
  ) : 'Pods, workloads, nodes and events of your clusters — configuration, health and resource usage';

  return (
    <div className="k8s">
      <PageHeader title={<span className="row" style={{ gap: 8 }}><Container size={18} />Kubernetes</span>} subtitle={subtitle}
        actions={list.length ? <>
          <select className="select" aria-label="Cluster" value={conn?.id ?? ''} onChange={(e) => { setConnId(e.target.value); setPodFilter({}); }}>
            {list.map((c) => <option key={c.id} value={c.id}>{c.clusterName || c.name}{c.source === 'dynatrace' ? ' (Dynatrace)' : ''}{c.status !== 'ENABLED' ? ' — disabled' : ''}</option>)}
          </select>
          <select className="select" aria-label="Auto refresh" value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} title="Auto refresh">
            {REFRESH.map((r) => <option key={r.v} value={r.v}>{r.v ? `Refresh ${r.l}` : 'Auto refresh off'}</option>)}
          </select>
          <button className="btn" onClick={() => api.get(`/kubernetes/${conn!.id}/overview`, { refresh: true }).then(() => ov.refetch())} disabled={!conn || ov.isFetching} aria-label="Refresh now">
            <RefreshCw size={14} className={ov.isFetching ? 'spin' : ''} />Refresh
          </button>
          {can('MANAGE_INTEGRATIONS') && <Link className="btn" to="/integrations"><Plug size={14} />Connections</Link>}
        </> : undefined} />

      {conns.isLoading ? <Loading height={200} /> : conns.error ? <ErrorBox error={conns.error} /> : !list.length ? <ConnectCta canManage={can('MANAGE_INTEGRATIONS')} /> : !conn ? null : conn.status !== 'ENABLED' ? (
        <Empty icon={<Plug size={22} />}>Connection <b>{conn.name}</b> is disabled. Enable it in <Link to="/integrations">Platform → Integrations</Link>.</Empty>
      ) : (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { key: 'overview', label: 'Overview', badge: meta?.problems.length || undefined },
            { key: 'workloads', label: 'Workloads', badge: meta?.counts.workloads },
            { key: 'pods', label: 'Pods', badge: meta?.counts.pods },
            { key: 'nodes', label: 'Nodes', badge: meta?.counts.nodes },
            { key: 'events', label: 'Events', badge: meta?.counts.warningEvents || undefined },
            { key: 'trends', label: 'Trends' },
          ]} />
          {ov.error && <ConnError error={ov.error} conn={conn} />}
          {meta && meta.warnings.length > 0 && (
            <details className="k8s-warnings"><summary><AlertTriangle size={13} />{meta.warnings.length} data source warning{meta.warnings.length > 1 ? 's' : ''}</summary><ul>{meta.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
          )}
          {tab === 'overview' && (ov.isLoading ? <Loading height={320} /> : meta && <OverviewTab o={meta} conn={conn} openPods={openPods} />)}
          {tab === 'workloads' && <WorkloadsTab conn={conn} refresh={refresh} openPods={openPods} />}
          {tab === 'pods' && <PodsTab conn={conn} refresh={refresh} filter={podFilter} setFilter={setPodFilter} namespaces={meta?.namespaces.map((n) => n.name) ?? []} />}
          {tab === 'nodes' && <NodesTab conn={conn} refresh={refresh} openPods={openPods} />}
          {tab === 'trends' && <ObsWindowView preset="k8s" group={`k8s-window-${conn.id}`} dims={['namespace', 'workload', 'pod', 'node']} fixedFilters={{ cluster: [conn.id] }} />}
          {tab === 'events' && <EventsTab conn={conn} refresh={refresh} namespaces={meta?.namespaces.map((n) => n.name) ?? []} />}
        </>
      )}
    </div>
  );
}

function ConnectCta({ canManage }: { canManage: boolean }) {
  return (
    <Card>
      <div className="k8s-cta">
        <div className="k8s-cta-icon"><Container size={26} /></div>
        <h2>Connect a Kubernetes cluster</h2>
        <p className="muted">Perfmon reads pods, workloads, nodes, events and logs through a <b>read-only ServiceAccount</b> token — or through your Dynatrace environment (entities.read + metrics.read). Secrets are never read; credential-like values are masked.</p>
        <ol className="k8s-cta-steps">
          <li>Apply the read-only RBAC: <a href="/samples/perfmon-k8s-readonly.yaml" download><Download size={12} /> perfmon-k8s-readonly.yaml</a> (<code>kubectl apply -f</code>)</li>
          <li>Copy the token and CA: <code>kubectl -n perfmon-monitoring get secret perfmon-reader-token -o jsonpath='{'{.data.token}'}' | base64 -d</code></li>
          <li>Add a <b>Kubernetes</b> connection (API server URL, token, CA) in Platform → Integrations and press <b>Test</b>.</li>
        </ol>
        <div className="row" style={{ justifyContent: 'center' }}>
          {canManage ? <Link className="btn btn-primary" to="/integrations"><Plug size={14} />Connect a cluster</Link> : <span className="muted">Ask an administrator with “Manage integrations” to add a connection.</span>}
          <Link className="btn" to="/help/kubernetes-monitoring"><ExternalLink size={14} />Setup guide</Link>
        </div>
      </div>
    </Card>
  );
}

function ConnError({ error, conn }: { error: unknown; conn: Conn }) {
  return (
    <div className="k8s-conn-error" role="alert">
      <AlertOctagon size={16} />
      <div><b>Cannot read cluster “{conn.clusterName || conn.name}”.</b> {(error as Error).message}
        <div className="muted" style={{ marginTop: 4 }}>Check the connection in <Link to="/integrations">Platform → Integrations</Link> (Test), the token permissions and that the API server is reachable from the Perfmon backend.</div></div>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function OverviewTab({ o, conn, openPods }: { o: Overview; conn: Conn; openPods: (f: any) => void }) {
  const c = o.counts, cap = o.capacity;
  const cpuP = pct(cap.cpuUsage, cap.cpuAllocatable), memP = pct(cap.memUsage, cap.memAllocatable);
  const st = (p: number | null): 'pass' | 'warn' | 'fail' | null => (p == null ? null : p >= 90 ? 'fail' : p >= 75 ? 'warn' : 'pass');
  const nodeCols: Column<NodeT>[] = [
    { key: 'name', header: 'Node', render: (n) => <div><b>{n.name}</b><div className="muted k8s-small">{n.roles.join(', ')} · {n.kubelet ?? ''}</div></div> },
    { key: 'status', header: 'Status', render: (n) => <StatusChip level={n.level}>{n.status}{n.pressure.length ? ` · ${n.pressure.join(', ')}` : ''}</StatusChip>, value: (n) => n.status },
    { key: 'cpu', header: 'CPU usage / allocatable', render: (n) => <UsageBar value={n.cpuUsage} limit={n.cpuAllocatable} fmt={fmtCpu} />, value: (n) => pct(n.cpuUsage, n.cpuAllocatable) },
    { key: 'mem', header: 'Memory usage / allocatable', render: (n) => <UsageBar value={n.memUsage} limit={n.memAllocatable} fmt={fmtMem} />, value: (n) => pct(n.memUsage, n.memAllocatable) },
    { key: 'pods', header: 'Pods', align: 'right', render: (n) => <button className="link-btn" onClick={() => openPods({ node: n.name })}>{n.pods}{n.podsCapacity ? <span className="muted"> / {n.podsCapacity}</span> : null}</button> },
  ];
  const nsCols: Column<Overview['namespaces'][number]>[] = [
    { key: 'name', header: 'Namespace', render: (n) => <button className="link-btn" onClick={() => openPods({ namespace: n.name })}><b>{n.name}</b></button> },
    { key: 'workloads', header: 'Workloads', align: 'right' },
    { key: 'pods', header: 'Pods', align: 'right', render: (n) => <span>{n.running}<span className="muted"> / {n.pods}</span></span> },
    { key: 'failing', header: 'Failing', align: 'right', render: (n) => (n.failing ? <b className="lv-fail">{n.failing}</b> : <span className="muted">0</span>) },
    { key: 'restarts', header: 'Restarts', align: 'right' },
    { key: 'cpu', header: 'CPU', align: 'right', render: (n) => fmtCpu(n.cpu) },
    { key: 'memory', header: 'Memory', align: 'right', render: (n) => fmtMem(n.memory) },
  ];
  return (
    <div className="stack">
      <div className="k8s-kpis">
        <Kpi label="Nodes ready" value={`${c.nodesReady}/${c.nodes}`} status={c.nodes && c.nodesReady < c.nodes ? 'fail' : 'pass'} sub={<span className="muted">{c.namespaces} namespaces</span>} />
        <Kpi label="Pods" value={fmtNum(c.pods)} status={c.podsFailing ? 'fail' : c.podsNotReady ? 'warn' : 'pass'}
          sub={<span className="muted">{c.podPhases.Running ?? 0} running · {c.podsFailing} failing{c.podPhases.Pending ? ` · ${c.podPhases.Pending} pending` : ''}</span>} onClick={() => openPods({ status: c.podsFailing ? 'fail' : undefined })} />
        <Kpi label="Workloads healthy" value={`${c.workloadsHealthy}/${c.workloads}`} status={c.workloadsHealthy < c.workloads ? 'warn' : 'pass'} sub={<span className="muted">{Object.entries(c.workloadKinds).map(([k, v]) => `${v} ${k}`).join(' · ')}</span>} />
        <Kpi label="Restarts (last hour)" value={c.restartedLastHour} status={c.restartedLastHour ? 'warn' : 'pass'} sub={<span className="muted">{fmtNum(c.restartsTotal)} restarts total</span>} title="Pods whose containers restarted in the last hour" />
        <Kpi label="CPU usage" value={cpuP == null ? '—' : Math.round(cpuP)} unit={cpuP == null ? undefined : '%'} status={st(cpuP)} sub={<span className="muted">{fmtCpu(cap.cpuUsage)} of {fmtCpu(cap.cpuAllocatable)} · req {fmtCpu(cap.cpuRequests)}</span>} />
        <Kpi label="Memory usage" value={memP == null ? '—' : Math.round(memP)} unit={memP == null ? undefined : '%'} status={st(memP)} sub={<span className="muted">{fmtMem(cap.memUsage)} of {fmtMem(cap.memAllocatable)} · req {fmtMem(cap.memRequests)}</span>} />
        <Kpi label="Warning events" value={c.warningEvents} status={c.warningEvents ? 'warn' : 'pass'} />
      </div>

      <div className="k8s-grid-2">
        <Card title={`Problems (${o.problems.length})`} noPad>
          {o.problems.length ? (
            <ul className="k8s-problems">
              {o.problems.slice(0, 40).map((p, i) => (
                <li key={i} className={`lv-${p.level}`} onClick={p.kind === 'Pod' ? () => openPods({ namespace: p.namespace ?? undefined, q: p.name }) : undefined}>
                  {p.level === 'fail' ? <AlertOctagon size={14} /> : <AlertTriangle size={14} />}
                  <div className="k8s-problem-main"><b>{p.title}</b><span className="muted"> · {p.kind} {p.namespace ? `${p.namespace}/` : ''}{p.name}</span>{p.detail && <div className="muted k8s-small">{p.detail}</div>}</div>
                  {p.at && <span className="muted k8s-small">{relTime(p.at)}</span>}
                </li>
              ))}
            </ul>
          ) : <div className="k8s-allgood"><CheckCircle2 size={18} />No problems detected</div>}
        </Card>
        <TrendCard conn={conn} scope="cluster" title="Cluster usage (nodes)" />
      </div>

      <Card title="Nodes" noPad><DataTable rows={o.nodes} columns={nodeCols} rowKey={(n) => n.name} searchable={false} exportName="k8s-nodes" maxHeight={420} /></Card>
      <Card title="Namespaces" noPad><DataTable rows={o.namespaces} columns={nsCols} rowKey={(n) => n.name} exportName="k8s-namespaces" maxHeight={420} /></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ trends */

function TrendCard({ conn, scope, namespace, name, title, height = 220 }: { conn: Conn; scope: string; namespace?: string; name?: string; title: string; height?: number }) {
  const [minutes, setMinutes] = useState(60);
  const q = useQuery({
    queryKey: ['k8s', conn.id, 'trends', scope, namespace, name, minutes],
    queryFn: () => api.get<{ cpu: [number, number][]; memory: [number, number][]; source: string; sampler?: Sampler }>(`/kubernetes/${conn.id}/trends`, { scope, namespace, name, minutes }),
    refetchInterval: 20_000,
  });
  const option = useMemo<EChartsOption>(() => ({
    animation: false,
    legend: { top: 0, left: 0 },
    grid: { left: 8, right: 8, top: 28, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'time' },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (v: number) => fmtCpu(v) } },
      { type: 'value', axisLabel: { formatter: (v: number) => fmtBytes(v) }, splitLine: { show: false } },
    ],
    series: [
      { name: 'CPU', type: 'line', showSymbol: false, data: q.data?.cpu ?? [], areaStyle: { opacity: 0.08 }, tooltip: { valueFormatter: (v: any) => fmtCpu(Number(v)) } },
      { name: 'Memory', type: 'line', yAxisIndex: 1, showSymbol: false, data: q.data?.memory ?? [], tooltip: { valueFormatter: (v: any) => fmtBytes(Number(v)) } },
    ],
  } as EChartsOption), [q.data]);
  const empty = q.error ? (q.error as Error).message : !q.data?.cpu.length && !q.data?.memory.length
    ? (q.data?.source === 'sampler' ? `Collecting… usage is sampled every ${q.data?.sampler?.intervalSec ?? 20}s while this page is open` : 'No data in this window') : null;
  return (
    <Chart title={title} subtitle={q.data?.source === 'dynatrace' ? 'Dynatrace · 1 min' : 'sampled by Perfmon'} option={option} height={height} loading={q.isLoading} empty={empty}
      actions={<select className="select k8s-mini-select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Window">{[15, 60, 360, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</select>} />
  );
}

/* ------------------------------------------------------------------ workloads */

function WorkloadsTab({ conn, refresh, openPods }: { conn: Conn; refresh: number; openPods: (f: any) => void }) {
  const [ns, setNs] = useState('');
  const [kind, setKind] = useState('');
  const q = useQuery({ queryKey: ['k8s', conn.id, 'workloads'], queryFn: () => api.get<Meta & { items: Workload[] }>(`/kubernetes/${conn.id}/workloads`), refetchInterval: refresh || false });
  const rows = (q.data?.items ?? []).filter((w) => (!ns || w.namespace === ns) && (!kind || w.kind === kind));
  const nss = [...new Set((q.data?.items ?? []).map((w) => w.namespace))].sort();
  const kinds = [...new Set((q.data?.items ?? []).map((w) => w.kind))].sort();
  const cols: Column<Workload>[] = [
    { key: 'level', header: 'Status', width: 110, render: (w) => <StatusChip level={w.level}>{w.level === 'ok' ? 'Healthy' : w.level === 'done' ? 'Complete' : w.level === 'warn' ? 'Degraded' : 'Failing'}</StatusChip>, value: (w) => ({ fail: 0, warn: 1, ok: 2, done: 3 })[w.level] },
    { key: 'name', header: 'Workload', render: (w) => <div><b>{w.name}</b><div className="muted k8s-small">{w.kind} · {w.namespace}</div>{w.message && w.level !== 'ok' && <div className={`k8s-small lv-${w.level}`}>{w.message}</div>}</div> },
    { key: 'replicas', header: 'Ready / desired', align: 'right', render: (w) => w.job ? <span>{w.job.succeeded}/{w.job.completions ?? 1} done{w.job.active ? ` · ${w.job.active} active` : ''}{w.job.failed ? <span className="lv-fail"> · {w.job.failed} failed</span> : ''}</span> : <span className={w.ready < w.desired ? 'lv-warn' : ''}><b>{w.ready}</b>/{w.desired}{w.updated != null && w.updated !== w.desired ? <span className="muted"> · {w.updated} updated</span> : null}</span>, value: (w) => w.desired - w.ready },
    { key: 'cpu', header: 'CPU usage / limit', render: (w) => <UsageBar value={w.cpu} limit={w.cpuLimit} request={w.cpuRequest} fmt={fmtCpu} compact />, value: (w) => w.cpu },
    { key: 'memory', header: 'Memory usage / limit', render: (w) => <UsageBar value={w.memory} limit={w.memLimit} request={w.memRequest} fmt={fmtMem} compact />, value: (w) => w.memory },
    { key: 'restarts', header: 'Restarts', align: 'right', render: (w) => (w.restarts ? <b className="lv-warn">{w.restarts}</b> : <span className="muted">0</span>) },
    { key: 'images', header: 'Images', render: (w) => <span className="mono k8s-small k8s-ellipsis" title={w.images.join('\n')}>{w.images.join(', ') || '—'}</span>, value: (w) => w.images.join(' ') },
    { key: 'age', header: 'Age', align: 'right', render: (w) => fmtAge(w.createdAt), value: (w) => (w.createdAt ? -new Date(w.createdAt).getTime() : null) },
    { key: 'pods', header: '', sortable: false, render: (w) => <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); openPods({ namespace: w.namespace, workload: w.name }); }}>{w.pods} pods</button> },
  ];
  return (
    <Card noPad>
      {q.error ? <div className="card-body"><ErrorBox error={q.error} /></div> : (
        <DataTable rows={rows} columns={cols} rowKey={(w) => w.uid} loading={q.isLoading} exportName="k8s-workloads" pageSize={100}
          onRowClick={(w) => openPods({ namespace: w.namespace, workload: w.name })}
          toolbar={<>
            <select className="select" value={ns} onChange={(e) => setNs(e.target.value)} aria-label="Namespace"><option value="">All namespaces</option>{nss.map((n) => <option key={n}>{n}</option>)}</select>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"><option value="">All kinds</option>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
          </>} empty="No workloads" />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ pods */

function PodsTab({ conn, refresh, filter, setFilter, namespaces }: { conn: Conn; refresh: number; filter: { namespace?: string; workload?: string; status?: string; node?: string; q?: string }; setFilter: (f: any) => void; namespaces: string[] }) {
  const q = useQuery({
    queryKey: ['k8s', conn.id, 'pods', filter.namespace, filter.workload, filter.status, filter.node],
    queryFn: () => api.get<Meta & { total: number; items: Pod[] }>(`/kubernetes/${conn.id}/pods`, { namespace: filter.namespace, workload: filter.workload, status: filter.status, node: filter.node }),
    refetchInterval: refresh || false, placeholderData: (prev) => prev,
  });
  const [open, setOpen] = useState<Pod | null>(null);
  const rows = (q.data?.items ?? []).filter((p) => !filter.q || p.name.includes(filter.q));
  const cols: Column<Pod>[] = [
    { key: 'status', header: 'Status', width: 150, render: (p) => <StatusChip level={p.level}>{p.status}</StatusChip>, value: (p) => `${({ fail: 0, warn: 1, ok: 2, done: 3 })[p.level]}${p.status}` },
    { key: 'name', header: 'Pod', render: (p) => <div><b className="mono k8s-podname">{p.name}</b><div className="muted k8s-small">{p.namespace}{p.workload ? ` · ${p.workload.kind} ${p.workload.name}` : ' · standalone'}</div></div> },
    { key: 'ready', header: 'Ready', align: 'right', render: (p) => <span className={p.ready < p.total && p.level !== 'done' ? 'lv-warn' : ''}>{p.ready}/{p.total}</span>, value: (p) => p.ready - p.total },
    { key: 'restarts', header: 'Restarts', align: 'right', render: (p) => (p.restarts ? <span title={p.lastRestartAt ? `last ${relTime(p.lastRestartAt)}` : undefined}><b className={p.restarts > 5 ? 'lv-fail' : 'lv-warn'}>{p.restarts}</b>{p.lastRestartAt && <span className="muted k8s-small"> {fmtAge(p.lastRestartAt)}</span>}</span> : <span className="muted">0</span>), value: (p) => p.restarts },
    { key: 'cpu', header: 'CPU usage / limit', render: (p) => <UsageBar value={p.cpu} limit={p.cpuLimit} request={p.cpuRequest} fmt={fmtCpu} compact />, value: (p) => p.cpu },
    { key: 'memory', header: 'Memory usage / limit', render: (p) => <UsageBar value={p.memory} limit={p.memLimit} request={p.memRequest} fmt={fmtMem} compact />, value: (p) => p.memory },
    { key: 'node', header: 'Node', render: (p) => <span className="k8s-small">{p.node ?? '—'}</span> },
    { key: 'qos', header: 'QoS', render: (p) => <span className="k8s-small">{p.qos ?? '—'}</span> },
    { key: 'age', header: 'Age', align: 'right', render: (p) => fmtAge(p.createdAt), value: (p) => (p.createdAt ? -new Date(p.createdAt).getTime() : null) },
    { key: 'ip', header: 'Pod IP', hidden: true, render: (p) => <span className="mono k8s-small">{p.ip ?? '—'}</span> },
  ];
  const active = Object.entries(filter).filter(([, v]) => v);
  return (
    <>
      <Card noPad>
        {q.error ? <div className="card-body"><ErrorBox error={q.error} /></div> : (
          <DataTable rows={rows} columns={cols} rowKey={(p) => p.uid} loading={q.isLoading} exportName="k8s-pods" pageSize={100} onRowClick={setOpen}
            toolbar={<>
              <select className="select" value={filter.namespace ?? ''} onChange={(e) => setFilter({ ...filter, namespace: e.target.value || undefined, workload: undefined })} aria-label="Namespace">
                <option value="">All namespaces</option>{namespaces.map((n) => <option key={n}>{n}</option>)}
              </select>
              <select className="select" value={filter.status ?? ''} onChange={(e) => setFilter({ ...filter, status: e.target.value || undefined })} aria-label="Status">
                <option value="">Any status</option><option value="fail">Failing</option><option value="warn">Warning / pending</option><option value="ok">Healthy</option><option value="done">Completed</option>
                <option value="CrashLoopBackOff">CrashLoopBackOff</option><option value="OOMKilled">OOMKilled</option><option value="Pending">Pending</option><option value="ImagePull">Image pull errors</option>
              </select>
              {active.filter(([k]) => k === 'workload' || k === 'node' || k === 'q').map(([k, v]) => (
                <span key={k} className="k8s-filter-chip">{k}: <b>{v}</b><button aria-label={`Clear ${k}`} onClick={() => setFilter({ ...filter, [k]: undefined })}><X size={11} /></button></span>
              ))}
            </>} empty="No pods match the filters" />
        )}
      </Card>
      {open && <PodDrawer conn={conn} pod={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ------------------------------------------------------------------ pod drawer */

type DTab = 'summary' | 'config' | 'events' | 'logs' | 'metrics';

function PodDrawer({ conn, pod, onClose }: { conn: Conn; pod: Pod; onClose: () => void }) {
  const [tab, setTab] = useState<DTab>('summary');
  const d = useQuery({ queryKey: ['k8s', conn.id, 'pod', pod.namespace, pod.name], queryFn: () => api.get<any>(`/kubernetes/${conn.id}/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`), refetchInterval: 30_000 });
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  const p = d.data;
  return (
    <div className="k8s-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="k8s-drawer" role="dialog" aria-modal="true" aria-label={`Pod ${pod.name}`}>
        <div className="k8s-drawer-head">
          <div className="k8s-drawer-icon"><Boxes size={18} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="mono k8s-ellipsis" title={pod.name}>{pod.name}</h2>
            <div className="row wrap" style={{ gap: 6, marginTop: 3 }}><StatusChip level={p?.level ?? pod.level}>{p?.status ?? pod.status}</StatusChip><span className="muted k8s-small">{pod.namespace}{pod.workload ? ` · ${pod.workload.kind} ${pod.workload.name}` : ''}</span></div>
          </div>
          <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <Tabs<DTab> value={tab} onChange={setTab} tabs={[
          { key: 'summary', label: 'Summary' }, { key: 'config', label: 'Configuration' }, { key: 'events', label: 'Events', badge: p?.events?.length || undefined },
          { key: 'logs', label: 'Logs' }, { key: 'metrics', label: 'Metrics' },
        ]} />
        <div className="k8s-drawer-body">
          {d.error ? <ErrorBox error={d.error} /> : d.isLoading ? <Loading height={260} /> : (
            <>
              {p.warnings?.length > 0 && <div className="k8s-note"><AlertTriangle size={13} />{p.warnings.join(' · ')}</div>}
              {tab === 'summary' && <PodSummaryView p={p} />}
              {tab === 'config' && <PodConfigView p={p} />}
              {tab === 'events' && <EventList items={p.events ?? []} />}
              {tab === 'logs' && <PodLogs conn={conn} pod={pod} containers={(p.containers ?? []).map((c: any) => c.name)} />}
              {tab === 'metrics' && <div className="stack">
                <TrendCard conn={conn} scope="pod" namespace={pod.namespace} name={pod.name} title="Pod CPU & memory" height={240} />
                {pod.workload && <TrendCard conn={conn} scope="workload" namespace={pod.namespace} name={pod.workload.name} title={`${pod.workload.kind} ${pod.workload.name} (all pods)`} height={200} />}
              </div>}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function KV({ items }: { items: [string, ReactNode][] }) {
  return <dl className="k8s-kv">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v == null || v === '' ? '—' : v}</dd></div>)}</dl>;
}

function PodSummaryView({ p }: { p: any }) {
  return (
    <div className="stack">
      <div className="k8s-grid-2">
        <div className="k8s-section"><h4><Cpu size={13} />CPU</h4><UsageBar value={p.usage?.cpu} limit={p.cpuLimit} request={p.cpuRequest} fmt={fmtCpu} /><div className="muted k8s-small">request {fmtCpu(p.cpuRequest)} · limit {fmtCpu(p.cpuLimit)}</div></div>
        <div className="k8s-section"><h4><MemoryStick size={13} />Memory</h4><UsageBar value={p.usage?.memory} limit={p.memLimit} request={p.memRequest} fmt={fmtMem} /><div className="muted k8s-small">request {fmtMem(p.memRequest)} · limit {fmtMem(p.memLimit)}</div></div>
      </div>
      <KV items={[
        ['Phase', p.phase], ['QoS class', p.qos], ['Node', p.node], ['Pod IP', p.podIP && <span className="mono">{p.podIP}</span>], ['Host IP', p.hostIP], ['Started', p.startTime ? `${relTime(p.startTime)} (${new Date(p.startTime).toLocaleString()})` : null],
        ['Service account', p.serviceAccount], ['Restart policy', p.restartPolicy], ['Priority class', p.priorityClass],
        ['Controlled by', p.ownerChain?.length ? p.ownerChain.map((o: Ref) => `${o.kind}/${o.name}`).join(' → ') : 'standalone pod'],
      ]} />
      {(p.containers ?? []).length > 0 && (
        <div className="k8s-section"><h4><Layers size={13} />Containers</h4>
          <table className="table k8s-mini-table"><thead><tr><th>Name</th><th>State</th><th className="r">Restarts</th><th>Last termination</th><th>CPU</th><th>Memory</th></tr></thead>
            <tbody>{p.containers.map((c: any) => (
              <tr key={c.name}><td><b>{c.name}</b>{c.init && <span className="muted"> (init)</span>}<div className="mono muted k8s-small">{c.image}</div></td>
                <td>{c.status ? <StatusChip level={c.status.ready ? 'ok' : c.status.state === 'terminated' && c.init ? 'done' : (c.status.stateDetail?.reason ?? '').match(/BackOff|Err|OOM/) ? 'fail' : 'warn'}>{c.status.stateDetail?.reason ?? c.status.state}</StatusChip> : '—'}</td>
                <td className="r num">{c.status?.restarts ?? 0}</td>
                <td className="k8s-small">{c.status?.lastState ? `${c.status.lastState.reason ?? ''} (exit ${c.status.lastState.exitCode}) ${relTime(c.status.lastState.finishedAt)}` : '—'}</td>
                <td className="num k8s-small">{fmtCpu(c.usage?.cpu)}</td><td className="num k8s-small">{fmtMem(c.usage?.memory)}</td></tr>
            ))}</tbody></table>
        </div>
      )}
      {p.conditions?.length > 0 && (
        <div className="k8s-section"><h4>Conditions</h4>
          <div className="row wrap" style={{ gap: 6 }}>{p.conditions.map((c: any) => <Chip key={c.type} tone={c.status === 'True' ? 'pass' : 'warn'} title={c.message ?? c.reason ?? ''}>{c.type}</Chip>)}</div>
        </div>
      )}
      <div className="k8s-section"><h4>Labels</h4><div className="k8s-labels">{Object.entries(p.labels ?? {}).map(([k, v]) => <span key={k} className="k8s-label mono">{k}={String(v)}</span>)}{!Object.keys(p.labels ?? {}).length && <span className="muted">none</span>}</div></div>
    </div>
  );
}

/** Readable YAML-like rendering; masked values are highlighted. */
function toYaml(v: any, indent = 0): string[] {
  const pad = '  '.repeat(indent);
  const scalar = (x: any) => (x === null || x === undefined ? '~' : typeof x === 'string' ? (/^[\w./:@=•+-]+$/.test(x) && x !== '' ? x : JSON.stringify(x)) : String(x));
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}[]`];
    return v.flatMap((item) => {
      if (item && typeof item === 'object') { const lines = toYaml(item, indent + 1); return [`${pad}- ${lines[0].trimStart()}`, ...lines.slice(1)]; }
      return [`${pad}- ${scalar(item)}`];
    });
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && !x.length) && !(typeof x === 'object' && !Array.isArray(x) && !Object.keys(x as object).length));
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([k, x]) => (x && typeof x === 'object' ? [`${pad}${k}:`, ...toYaml(x, indent + 1)] : [`${pad}${k}: ${scalar(x)}`]));
  }
  return [`${pad}${scalar(v)}`];
}

function YamlBlock({ obj }: { obj: any }) {
  const lines = toYaml(obj);
  return (
    <pre className="k8s-yaml">{lines.map((l, i) => {
      const m = /^(\s*(?:- )?)([\w.\-/]+)(:)(.*)$/.exec(l);
      const masked = l.includes('••••');
      return <div key={i} className={masked ? 'masked' : ''}>{m ? <><span>{m[1]}</span><span className="k">{m[2]}</span>{m[3]}<span className="v">{m[4]}</span></> : l}</div>;
    })}</pre>
  );
}

function PodConfigView({ p }: { p: any }) {
  const [download, setDownload] = useState(false);
  const containers = (p.containers ?? []).map((c: any) => ({
    name: c.name, ...(c.init ? { init: true } : {}), image: c.image, imagePullPolicy: c.imagePullPolicy, command: c.command, args: c.args, workingDir: c.workingDir,
    ports: c.ports?.map((x: any) => `${x.containerPort}/${x.protocol}${x.name ? ` (${x.name})` : ''}`),
    resources: { requests: c.resources?.requests, limits: c.resources?.limits },
    livenessProbe: c.probes?.liveness ? probeStr(c.probes.liveness) : null, readinessProbe: c.probes?.readiness ? probeStr(c.probes.readiness) : null, startupProbe: c.probes?.startup ? probeStr(c.probes.startup) : null,
    env: c.env?.map((e: any) => ({ [e.name]: e.source === 'literal' ? e.value : e.source === 'secret' ? `${e.value}  # from Secret ${e.ref}` : `<${e.source}: ${e.ref}>` })),
    envFrom: c.envFrom?.map((f: any) => `${f.source} ${f.name}${f.prefix ? ` (prefix ${f.prefix})` : ''} — ${f.note}`),
    volumeMounts: c.volumeMounts?.map((m: any) => `${m.name} → ${m.mountPath}${m.readOnly ? ' (ro)' : ''}${m.subPath ? ` [${m.subPath}]` : ''}`),
    securityContext: c.securityContext,
  }));
  const doc = {
    pod: p.name, namespace: p.namespace, node: p.node, serviceAccount: p.serviceAccount, qosClass: p.qos, restartPolicy: p.restartPolicy, priorityClass: p.priorityClass,
    terminationGracePeriodSeconds: p.terminationGracePeriodSeconds, nodeSelector: p.nodeSelector, tolerations: p.tolerations,
    containers, volumes: (p.volumes ?? []).map((v: any) => `${v.name}: ${v.detail}`), annotations: p.annotations,
  };
  const maskedCount = (p.containers ?? []).reduce((a: number, c: any) => a + (c.env ?? []).filter((e: any) => e.masked).length, 0);
  useEffect(() => {
    if (!download) return;
    const url = URL.createObjectURL(new Blob([toYaml(doc).join('\n')], { type: 'text/yaml' }));
    const a = document.createElement('a'); a.href = url; a.download = `${p.namespace}-${p.name}.yaml`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000); setDownload(false);
  }, [download]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="row">
        <div className="k8s-note" style={{ flex: 1, margin: 0 }}><FileCode2 size={13} />Values from Secrets and anything that looks like a credential are masked ({maskedCount} masked env value{maskedCount === 1 ? '' : 's'}). Secret contents are never read.</div>
        <button className="btn btn-sm" onClick={() => setDownload(true)}><Download size={12} />YAML</button>
      </div>
      {!containers.length && <Empty>Container specs are not available from this data source.</Empty>}
      <YamlBlock obj={doc} />
    </div>
  );
}
const probeStr = (pr: any) => `${pr.type} ${pr.target} · delay ${pr.initialDelaySeconds}s, every ${pr.periodSeconds}s, timeout ${pr.timeoutSeconds}s, failure ×${pr.failureThreshold}`;

function PodLogs({ conn, pod, containers }: { conn: Conn; pod: Pod; containers: string[] }) {
  const [container, setContainer] = useState(containers.find((c) => pod.containers.some((x) => x.name === c)) ?? containers[0] ?? '');
  const [tail, setTail] = useState(200);
  const [previous, setPrevious] = useState(false);
  const q = useQuery({
    queryKey: ['k8s', conn.id, 'logs', pod.namespace, pod.name, container, tail, previous], enabled: conn.source === 'kubernetes',
    queryFn: () => api.get<{ logs: { container: string; lines: string[]; truncated: boolean; error: string | null }[] }>(`/kubernetes/${conn.id}/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}/logs`, { container, tailLines: tail, previous }),
  });
  if (conn.source !== 'kubernetes') return <Empty>Logs need a direct Kubernetes connection.</Empty>;
  const log = q.data?.logs?.[0];
  return (
    <div className="stack">
      <div className="row wrap">
        <select className="select" value={container} onChange={(e) => setContainer(e.target.value)} aria-label="Container">{containers.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="select" value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="Lines">{[100, 200, 500, 1000, 2000].map((n) => <option key={n} value={n}>last {n} lines</option>)}</select>
        <label className="row k8s-small" style={{ gap: 4 }}><input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />previous container (before restart)</label>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => q.refetch()} disabled={q.isFetching}><RefreshCw size={12} className={q.isFetching ? 'spin' : ''} />Reload</button>
      </div>
      {q.error ? <ErrorBox error={q.error} /> : q.isLoading ? <Loading height={200} /> : log?.error ? <div className="error-box">{log.error}</div> : (
        <pre className="k8s-logs">{log?.lines.length ? log.lines.map((l, i) => { const m = /^(\S+Z) (.*)$/.exec(l); return <div key={i}>{m ? <><span className="ts">{m[1].slice(11, 23)}</span> {m[2]}</> : l}</div>; }) : <span className="muted">No log lines.</span>}{log?.truncated && <div className="muted">… truncated at 256 KB</div>}</pre>
      )}
      <div className="muted k8s-small">Credential-looking values (password=…, tokens, user:pass@ in URLs) are redacted.</div>
    </div>
  );
}

/* ------------------------------------------------------------------ nodes */

function NodesTab({ conn, refresh, openPods }: { conn: Conn; refresh: number; openPods: (f: any) => void }) {
  const q = useQuery({ queryKey: ['k8s', conn.id, 'nodes'], queryFn: () => api.get<Meta & { items: NodeT[] }>(`/kubernetes/${conn.id}/nodes`), refetchInterval: refresh || false });
  const [sel, setSel] = useState<string | null>(null);
  const node = q.data?.items.find((n) => n.name === sel) ?? null;
  const cols: Column<NodeT>[] = [
    { key: 'status', header: 'Status', render: (n) => <StatusChip level={n.level}>{n.status}</StatusChip>, value: (n) => n.status },
    { key: 'name', header: 'Node', render: (n) => <div><b>{n.name}</b><div className="muted k8s-small">{n.roles.join(', ')} · {n.internalIP ?? ''}</div></div> },
    { key: 'cpu', header: 'CPU usage', render: (n) => <UsageBar value={n.cpuUsage} limit={n.cpuAllocatable} fmt={fmtCpu} compact />, value: (n) => pct(n.cpuUsage, n.cpuAllocatable) },
    { key: 'cpuReq', header: 'CPU requests', render: (n) => <UsageBar value={n.cpuRequests} limit={n.cpuAllocatable} fmt={fmtCpu} compact />, value: (n) => pct(n.cpuRequests, n.cpuAllocatable) },
    { key: 'mem', header: 'Memory usage', render: (n) => <UsageBar value={n.memUsage} limit={n.memAllocatable} fmt={fmtMem} compact />, value: (n) => pct(n.memUsage, n.memAllocatable) },
    { key: 'memReq', header: 'Memory requests', render: (n) => <UsageBar value={n.memRequests} limit={n.memAllocatable} fmt={fmtMem} compact />, value: (n) => pct(n.memRequests, n.memAllocatable) },
    { key: 'pods', header: 'Pods', align: 'right', render: (n) => <button className="link-btn" onClick={(e) => { e.stopPropagation(); openPods({ node: n.name }); }}>{n.pods}{n.podsCapacity ? <span className="muted"> / {n.podsCapacity}</span> : null}</button> },
    { key: 'kubelet', header: 'Kubelet', render: (n) => <span className="k8s-small">{n.kubelet ?? '—'}</span> },
    { key: 'age', header: 'Age', align: 'right', render: (n) => fmtAge(n.createdAt) },
  ];
  return (
    <div className="stack">
      <Card noPad>{q.error ? <div className="card-body"><ErrorBox error={q.error} /></div> : <DataTable rows={q.data?.items ?? []} columns={cols} rowKey={(n) => n.name} loading={q.isLoading} exportName="k8s-nodes" onRowClick={(n) => setSel(n.name === sel ? null : n.name)} empty="No nodes visible (the token may lack 'list nodes')" />}</Card>
      {node && (
        <div className="k8s-grid-2">
          <Card title={<span className="row" style={{ gap: 6 }}><Server size={13} />{node.name}</span>} actions={<button className="btn btn-ghost icon-btn btn-sm" onClick={() => setSel(null)} aria-label="Close"><X size={13} /></button>}>
            <KV items={[
              ['OS image', node.osImage], ['Kernel', node.kernel], ['Runtime', node.runtime], ['Architecture', node.arch], ['Kubelet', node.kubelet],
              ['CPU capacity / allocatable', `${fmtCpu(node.cpuCapacity)} / ${fmtCpu(node.cpuAllocatable)}`], ['Memory capacity / allocatable', `${fmtMem(node.memCapacity)} / ${fmtMem(node.memAllocatable)}`],
              ['Limits committed', `${fmtCpu(node.cpuLimits)} CPU · ${fmtMem(node.memLimits)}`], ['Taints', node.taints.join(', ') || 'none'], ['Schedulable', node.unschedulable ? 'No (cordoned)' : 'Yes'],
            ]} />
            <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>{node.conditions.map((c) => <Chip key={c.type} tone={(c.type === 'Ready') === (c.status === 'True') ? 'pass' : 'fail'} title={c.message ?? ''}>{c.type}: {c.status}</Chip>)}</div>
          </Card>
          <TrendCard conn={conn} scope="node" name={node.name} title={`${node.name} usage`} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ events */

function EventList({ items }: { items: EventT[] }) {
  if (!items.length) return <Empty>No events</Empty>;
  return (
    <ul className="k8s-events">
      {items.map((e, i) => (
        <li key={i} className={e.type === 'Warning' ? 'lv-warn' : ''}>
          <span className="k8s-ev-type">{e.type === 'Warning' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}</span>
          <div style={{ minWidth: 0 }}><b>{e.reason}</b>{e.count > 1 && <span className="muted"> ×{e.count}</span>}<span className="muted k8s-small"> · {e.kind} {e.namespace ? `${e.namespace}/` : ''}{e.name}</span><div className="k8s-ev-msg">{e.message}</div></div>
          <span className="muted k8s-small" title={e.lastAt ?? ''}>{relTime(e.lastAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function EventsTab({ conn, refresh, namespaces }: { conn: Conn; refresh: number; namespaces: string[] }) {
  const [type, setType] = useState<'' | 'Warning' | 'Normal'>('');
  const [ns, setNs] = useState('');
  const q = useQuery({ queryKey: ['k8s', conn.id, 'events', type, ns], queryFn: () => api.get<Meta & { items: EventT[] }>(`/kubernetes/${conn.id}/events`, { type: type || undefined, namespace: ns || undefined }), refetchInterval: refresh || false });
  const cols: Column<EventT>[] = [
    { key: 'type', header: 'Type', width: 100, render: (e) => <Chip tone={e.type === 'Warning' ? 'warn' : 'neutral'} icon={false}>{e.type}</Chip> },
    { key: 'reason', header: 'Reason', render: (e) => <b>{e.reason}</b> },
    { key: 'object', header: 'Object', render: (e) => <span className="k8s-small">{e.kind} <span className="mono">{e.namespace ? `${e.namespace}/` : ''}{e.name}</span></span>, value: (e) => `${e.kind} ${e.namespace}/${e.name}` },
    { key: 'message', header: 'Message', render: (e) => <span className="k8s-ev-msg">{e.message}</span> },
    { key: 'count', header: 'Count', align: 'right' },
    { key: 'lastAt', header: 'Last seen', align: 'right', render: (e) => <span title={e.lastAt ?? ''}>{relTime(e.lastAt)}</span>, value: (e) => (e.lastAt ? new Date(e.lastAt).getTime() : 0) },
  ];
  return (
    <Card noPad>
      {q.error ? <div className="card-body"><ErrorBox error={q.error} /></div> : (
        <DataTable rows={q.data?.items ?? []} columns={cols} rowKey={(e) => `${e.kind}/${e.namespace}/${e.name}/${e.reason}/${e.lastAt}/${e.message.slice(0, 40)}`} loading={q.isLoading} exportName="k8s-events" pageSize={100}
          toolbar={<>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as any)} aria-label="Type"><option value="">All types</option><option>Warning</option><option>Normal</option></select>
            <select className="select" value={ns} onChange={(e) => setNs(e.target.value)} aria-label="Namespace"><option value="">All namespaces</option>{namespaces.map((n) => <option key={n}>{n}</option>)}</select>
          </>} empty="No events" />
      )}
    </Card>
  );
}
