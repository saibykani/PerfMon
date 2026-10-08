import { one, query } from '../db/pool.js';
import { insertGeneric } from '../ingest/routes.js';
import type { RunRef } from '../ingest/runCache.js';
import { usageDirect } from './directSource.js';
import { connFromRow, getSnapshot, type Conn } from './source.js';

/**
 * Lightweight usage sampler. metrics.k8s.io only exposes current values, so while someone views
 * the Kubernetes module (or a Perfmon run is RUNNING in a linked environment) pod and node
 * CPU/memory are sampled every SAMPLE_SEC into metric_points (source 'kubernetes'), tagged with
 * cluster/namespace/pod/workload/node and correlated to the running run. Sampling stops when the
 * module is idle. State is a handful of small maps (bounded); samples older than 24 h that are
 * not attached to a run are pruned.
 */

export const SAMPLE_SEC = 20;
const VIEW_TTL_MS = 3 * 60_000;
const RUN_CHECK_MS = 60_000;
const MAX_PODS = 4000;

interface RunLink { id: string; runKey: string; projectId: string; environmentId: string }
interface State { lastSample: number; inFlight: boolean; lastError: string | null; lastPoints: number; conn?: { at: number; conn: Conn } }

const viewers = new Map<string, number>();
const state = new Map<string, State>();
let runLinks = new Map<string, RunLink>();
let lastRunCheck = 0;
let lastPrune = 0;
let timer: NodeJS.Timeout | null = null;
let log: (m: string) => void = () => undefined;

export function touch(id: string) {
  viewers.set(id, Date.now());
  if (viewers.size > 200) viewers.delete(viewers.keys().next().value!);
}

export function samplerStatus(id: string) {
  const s = state.get(id);
  const viewedAt = viewers.get(id) ?? 0;
  const run = runLinks.get(id) ?? null;
  return {
    active: Date.now() - viewedAt < VIEW_TTL_MS || !!run, intervalSec: SAMPLE_SEC,
    lastSampleAt: s?.lastSample ? new Date(s.lastSample).toISOString() : null, lastError: s?.lastError ?? null, lastPoints: s?.lastPoints ?? 0,
    linkedRun: run ? run.runKey : null,
  };
}

async function refreshRunLinks() {
  lastRunCheck = Date.now();
  const ints = await query(`SELECT id, organization_id, project_id, config FROM integrations WHERE type = 'KUBERNETES' AND status = 'ENABLED'`);
  if (!ints.length) { runLinks = new Map(); return; }
  const runs = await query(
    `SELECT tr.id, tr.run_key, tr.project_id, tr.environment_id, e.name AS env_name, p.organization_id
       FROM test_runs tr JOIN environments e ON e.id = tr.environment_id JOIN projects p ON p.id = tr.project_id
      WHERE tr.status = 'RUNNING' ORDER BY tr.started_at DESC NULLS LAST LIMIT 200`);
  const next = new Map<string, RunLink>();
  for (const i of ints) {
    const env = String(i.config?.environment ?? '').trim().toLowerCase();
    const r = runs.find((x) => x.organization_id === i.organization_id && (!i.project_id || x.project_id === i.project_id)
      && (env ? x.environment_id === env || String(x.env_name).toLowerCase() === env : !!i.project_id));
    if (r) next.set(i.id, { id: r.id, runKey: r.run_key, projectId: r.project_id, environmentId: r.environment_id });
  }
  runLinks = next;
}

async function connFor(id: string, s: State): Promise<Conn | null> {
  if (s.conn && Date.now() - s.conn.at < 60_000) return s.conn.conn;
  const row = await one(`SELECT * FROM integrations WHERE id = $1 AND type = 'KUBERNETES' AND status = 'ENABLED'`, [id]);
  if (!row) return null;
  const conn = await connFromRow(row);
  s.conn = { at: Date.now(), conn };
  return conn;
}

export async function sampleOnce(id: string): Promise<number> {
  const s = state.get(id) ?? { lastSample: 0, inFlight: false, lastError: null, lastPoints: 0 };
  state.set(id, s);
  if (s.inFlight) return 0;
  s.inFlight = true;
  try {
    const conn = await connFor(id, s);
    if (!conn || conn.kind !== 'direct') { state.delete(id); return 0; }
    const [usage, snap] = await Promise.all([usageDirect(conn.kube), getSnapshot(conn, 120_000).catch(() => null)]);
    const podInfo = new Map((snap?.pods ?? []).map((p) => [`${p.namespace}/${p.name}`, p]));
    const nodeInfo = new Map((snap?.nodes ?? []).map((n) => [n.name, n]));
    const ts = Date.now();
    const base = { cluster: conn.id, clusterName: conn.kube.clusterName };
    const pts: { ts: number; metric: string; value: number; tags: Record<string, string>; projectId?: string | null }[] = [];
    for (const p of usage.pods.slice(0, MAX_PODS)) {
      const info = podInfo.get(`${p.namespace}/${p.name}`);
      const tags: Record<string, string> = { ...base, namespace: p.namespace, pod: p.name };
      if (info?.workload) { tags.workload = info.workload.name; tags.workloadKind = info.workload.kind; }
      if (info?.node) tags.node = info.node;
      pts.push({ ts, metric: 'k8s.pod.cpu_mcores', value: p.cpu, tags, projectId: conn.projectId }, { ts, metric: 'k8s.pod.memory_bytes', value: p.memory, tags, projectId: conn.projectId });
      if (info) pts.push({ ts, metric: 'k8s.pod.restarts', value: info.restarts, tags, projectId: conn.projectId });
    }
    for (const n of usage.nodes) {
      const tags = { ...base, node: n.name };
      const info = nodeInfo.get(n.name);
      if (n.cpu != null) pts.push({ ts, metric: 'k8s.node.cpu_mcores', value: n.cpu, tags, projectId: conn.projectId });
      if (n.memory != null) pts.push({ ts, metric: 'k8s.node.memory_bytes', value: n.memory, tags, projectId: conn.projectId });
      if (n.cpu != null && info?.cpuAllocatable) pts.push({ ts, metric: 'k8s.node.cpu_pct', value: (n.cpu / info.cpuAllocatable) * 100, tags, projectId: conn.projectId });
      if (n.memory != null && info?.memAllocatable) pts.push({ ts, metric: 'k8s.node.memory_pct', value: (n.memory / info.memAllocatable) * 100, tags, projectId: conn.projectId });
    }
    const link = runLinks.get(id);
    const run = link ? ({ id: link.id, runKey: link.runKey, projectId: link.projectId, environmentId: link.environmentId } as RunRef) : null;
    if (run) for (const p of pts) p.tags.runId = run.runKey;
    if (pts.length) await insertGeneric(run, pts, 'kubernetes');
    s.lastSample = ts;
    s.lastError = null;
    s.lastPoints = pts.length;
    return pts.length;
  } catch (e) {
    s.lastError = (e as Error).message;
    s.lastSample = Date.now();      // back off one interval
    return 0;
  } finally {
    s.inFlight = false;
  }
}

async function tick() {
  try {
    const now = Date.now();
    for (const [id, at] of viewers) if (now - at > VIEW_TTL_MS) viewers.delete(id);
    if (now - lastRunCheck > RUN_CHECK_MS) await refreshRunLinks().catch((e) => log(`[k8s-sampler] run check failed: ${(e as Error).message}`));
    const active = new Set([...viewers.keys(), ...runLinks.keys()]);
    for (const id of [...state.keys()]) if (!active.has(id)) state.delete(id);   // idle: drop state
    for (const id of active) {
      const s = state.get(id);
      if (!s || now - s.lastSample >= SAMPLE_SEC * 1000) void sampleOnce(id);
    }
    if (now - lastPrune > 30 * 60_000) {
      lastPrune = now;
      await query(`DELETE FROM metric_points WHERE source = 'kubernetes' AND run_id IS NULL AND ts < now() - interval '24 hours'`).catch(() => undefined);
    }
  } catch (e) {
    log(`[k8s-sampler] ${(e as Error).message}`);
  }
}

export function startSampler(logger?: (m: string) => void) {
  if (timer) return;
  if (logger) log = logger;
  timer = setInterval(() => void tick(), 5_000);
  timer.unref();
}
export function stopSampler() { if (timer) clearInterval(timer); timer = null; }

/* ------------------------------------------------------------------ trends from sampled points */

const SCOPES: Record<string, { metrics: [string, string]; tags: string[] }> = {
  cluster: { metrics: ['k8s.node.cpu_mcores', 'k8s.node.memory_bytes'], tags: [] },
  node: { metrics: ['k8s.node.cpu_mcores', 'k8s.node.memory_bytes'], tags: ['node'] },
  namespace: { metrics: ['k8s.pod.cpu_mcores', 'k8s.pod.memory_bytes'], tags: ['namespace'] },
  workload: { metrics: ['k8s.pod.cpu_mcores', 'k8s.pod.memory_bytes'], tags: ['namespace', 'workload'] },
  pod: { metrics: ['k8s.pod.cpu_mcores', 'k8s.pod.memory_bytes'], tags: ['namespace', 'pod'] },
};

export async function sampledTrends(id: string, scope: string, args: { namespace?: string; name?: string; minutes: number }) {
  const spec = SCOPES[scope] ?? SCOPES.cluster;
  const tags: Record<string, string> = { cluster: id };
  if (spec.tags.includes('namespace') && args.namespace) tags.namespace = args.namespace;
  if (scope === 'node' && args.name) tags.node = args.name;
  if (scope === 'workload' && args.name) tags.workload = args.name;
  if (scope === 'pod' && args.name) tags.pod = args.name;
  const rows = await query(
    `SELECT (extract(epoch FROM ts) * 1000)::bigint AS t, metric, sum(value) AS v FROM metric_points
      WHERE source = 'kubernetes' AND ts > now() - make_interval(mins => $1::int) AND metric = ANY($2::text[]) AND tags @> $3::jsonb
      GROUP BY ts, metric ORDER BY ts LIMIT 20000`,
    [args.minutes, spec.metrics, JSON.stringify(tags)]);
  const cpu: [number, number][] = [];
  const memory: [number, number][] = [];
  for (const r of rows) (r.metric === spec.metrics[0] ? cpu : memory).push([Number(r.t), Number(r.v)]);
  return { cpu, memory };
}
