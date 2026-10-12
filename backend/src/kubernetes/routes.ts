import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { typed, z, idParams } from '../lib/http.js';
import { KubeError } from './kubeClient.js';
import { podDetailDirect, podLogsDirect } from './directSource.js';
import { podDetailDynatrace, trendsDynatrace } from './dynatraceSource.js';
import { getSnapshot, loadConn, dropSnapshot, type Conn } from './source.js';
import { levelOrder, type PodSummary, type Snapshot } from './model.js';
import { sampledTrends, samplerStatus, sampleOnce, startSampler, stopSampler, touch } from './sampler.js';

/** Converts source errors into API errors (502 for upstream failures, with the actionable message). */
function upstream(e: unknown): never {
  if (e instanceof ApiError) throw e;
  if (e instanceof KubeError) {
    if (e.kind === 'notfound') throw new ApiError(404, 'NOT_FOUND', e.message);
    throw new ApiError(502, e.kind === 'forbidden' ? 'UPSTREAM_FORBIDDEN' : e.kind === 'auth' ? 'UPSTREAM_UNAUTHORIZED' : 'UPSTREAM_ERROR', e.message);
  }
  throw new ApiError(502, 'UPSTREAM_ERROR', (e as Error).message);
}

async function snap(c: Conn, fresh = false): Promise<Snapshot> {
  touch(c.id);
  try { return await getSnapshot(c, fresh ? 0 : 10_000); } catch (e) { upstream(e); }
}

const meta = (c: Conn, s: Snapshot) => ({ connection: { id: c.id, name: c.name, source: c.kind }, cluster: s.cluster, at: new Date(s.at).toISOString(), metricsAvailable: s.metricsAvailable, warnings: s.warnings });

function overview(s: Snapshot) {
  const hourAgo = Date.now() - 3600_000;
  const phases: Record<string, number> = {};
  for (const p of s.pods) phases[p.phase] = (phases[p.phase] ?? 0) + 1;
  const workloadKinds: Record<string, number> = {};
  for (const w of s.workloads) workloadKinds[w.kind] = (workloadKinds[w.kind] ?? 0) + 1;
  const sum = (f: (n: Snapshot['nodes'][number]) => number | null) => { const v = s.nodes.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const nsMap = new Map<string, { name: string; pods: number; running: number; failing: number; workloads: number; cpu: number | null; memory: number | null; restarts: number }>();
  for (const n of s.namespaces) nsMap.set(n.name, { name: n.name, pods: 0, running: 0, failing: 0, workloads: 0, cpu: null, memory: null, restarts: 0 });
  for (const p of s.pods) {
    const e = nsMap.get(p.namespace) ?? nsMap.set(p.namespace, { name: p.namespace, pods: 0, running: 0, failing: 0, workloads: 0, cpu: null, memory: null, restarts: 0 }).get(p.namespace)!;
    e.pods++; if (p.phase === 'Running') e.running++; if (p.level === 'fail') e.failing++;
    e.restarts += p.restarts;
    if (p.cpu != null) e.cpu = (e.cpu ?? 0) + p.cpu;
    if (p.memory != null) e.memory = (e.memory ?? 0) + p.memory;
  }
  for (const w of s.workloads) { const e = nsMap.get(w.namespace); if (e) e.workloads++; }

  // problems, most severe first
  const problems: { level: 'fail' | 'warn'; kind: string; namespace: string | null; name: string; title: string; detail: string | null; at: string | null }[] = [];
  for (const n of s.nodes) {
    if (!n.ready) problems.push({ level: 'fail', kind: 'Node', namespace: null, name: n.name, title: 'Node not ready', detail: n.conditions.find((c) => c.type === 'Ready')?.message ?? null, at: null });
    for (const pr of n.pressure) problems.push({ level: 'warn', kind: 'Node', namespace: null, name: n.name, title: pr, detail: n.conditions.find((c) => c.type === pr)?.message ?? null, at: null });
    if (n.cpuUsage != null && n.cpuAllocatable && n.cpuUsage / n.cpuAllocatable > 0.9) problems.push({ level: 'warn', kind: 'Node', namespace: null, name: n.name, title: `CPU saturation ${Math.round((n.cpuUsage / n.cpuAllocatable) * 100)}%`, detail: null, at: null });
    if (n.memUsage != null && n.memAllocatable && n.memUsage / n.memAllocatable > 0.9) problems.push({ level: 'warn', kind: 'Node', namespace: null, name: n.name, title: `Memory saturation ${Math.round((n.memUsage / n.memAllocatable) * 100)}%`, detail: null, at: null });
  }
  for (const p of s.pods) {
    if (p.level === 'fail' || (p.level === 'warn' && p.status !== 'Running' && p.createdAt && Date.now() - new Date(p.createdAt).getTime() > 5 * 60_000)) {
      const c = p.containers.find((x) => x.reason) ?? p.containers.find((x) => x.lastTermination);
      problems.push({ level: p.level === 'fail' ? 'fail' : 'warn', kind: 'Pod', namespace: p.namespace, name: p.name, title: p.status, detail: c ? `${c.name}: ${c.reason ?? `last terminated ${c.lastTermination}`}${p.restarts ? ` · ${p.restarts} restarts` : ''}` : null, at: p.lastRestartAt });
    } else if (p.memory != null && p.memLimit && p.memory / p.memLimit > 0.9) {
      problems.push({ level: 'warn', kind: 'Pod', namespace: p.namespace, name: p.name, title: `Memory at ${Math.round((p.memory / p.memLimit) * 100)}% of limit`, detail: 'Risk of OOMKill', at: null });
    } else if (p.containers.some((x) => x.lastTermination === 'OOMKilled') && p.lastRestartAt && new Date(p.lastRestartAt).getTime() > hourAgo) {
      problems.push({ level: 'warn', kind: 'Pod', namespace: p.namespace, name: p.name, title: 'OOMKilled recently', detail: `${p.restarts} restarts`, at: p.lastRestartAt });
    }
  }
  for (const w of s.workloads) if (w.level === 'fail' || w.level === 'warn') problems.push({ level: w.level, kind: w.kind, namespace: w.namespace, name: w.name, title: w.message ?? 'Degraded', detail: null, at: null });
  problems.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  return {
    counts: {
      nodes: s.nodes.length, nodesReady: s.nodes.filter((n) => n.ready).length, namespaces: s.namespaces.length,
      workloads: s.workloads.length, workloadsHealthy: s.workloads.filter((w) => w.level === 'ok' || w.level === 'done').length, workloadKinds,
      pods: s.pods.length, podPhases: phases, podsFailing: s.pods.filter((p) => p.level === 'fail').length,
      podsNotReady: s.pods.filter((p) => p.phase === 'Running' && p.ready < p.total).length,
      restartsTotal: s.pods.reduce((a, p) => a + p.restarts, 0),
      restartedLastHour: s.pods.filter((p) => p.lastRestartAt && new Date(p.lastRestartAt).getTime() > hourAgo).length,
      warningEvents: s.events.filter((e) => e.type === 'Warning').length,
    },
    capacity: {
      cpuCapacity: sum((n) => n.cpuCapacity), cpuAllocatable: sum((n) => n.cpuAllocatable), cpuUsage: sum((n) => n.cpuUsage), cpuRequests: sum((n) => n.cpuRequests), cpuLimits: sum((n) => n.cpuLimits),
      memCapacity: sum((n) => n.memCapacity), memAllocatable: sum((n) => n.memAllocatable), memUsage: sum((n) => n.memUsage), memRequests: sum((n) => n.memRequests), memLimits: sum((n) => n.memLimits),
      podsCapacity: sum((n) => n.podsCapacity),
    },
    nodes: s.nodes,
    namespaces: [...nsMap.values()].sort((a, b) => b.pods - a.pods),
    problems: problems.slice(0, 200),
    recentWarnings: s.events.filter((e) => e.type === 'Warning').slice(0, 20),
  };
}

function filterPods(pods: PodSummary[], q: { namespace?: string; workload?: string; status?: string; node?: string; q?: string }) {
  const needle = q.q?.trim().toLowerCase();
  return pods.filter((p) =>
    (!q.namespace || p.namespace === q.namespace)
    && (!q.workload || p.workload?.name === q.workload)
    && (!q.node || p.node === q.node)
    && (!q.status || (['ok', 'warn', 'fail', 'done'].includes(q.status) ? p.level === q.status : p.status.toLowerCase().includes(q.status.toLowerCase())))
    && (!needle || `${p.name} ${p.namespace} ${p.node ?? ''} ${p.workload?.name ?? ''} ${p.status} ${p.containers.map((c) => c.image).join(' ')}`.toLowerCase().includes(needle)));
}

export async function kubernetesRoutes(app: FastifyInstance) {
  const r = typed(app);
  const view = { preHandler: requirePermission('VIEW_PROJECT') };
  const manage = { preHandler: requirePermission('MANAGE_INTEGRATIONS') };
  const tags = ['Kubernetes'];
  startSampler((m) => app.log.warn(m));
  app.addHook('onClose', async () => stopSampler());

  r.get('/kubernetes/connections', { ...view, schema: { tags, summary: 'Kubernetes data sources: KUBERNETES connections and DYNATRACE integrations (secrets never returned)', querystring: z.object({ projectId: z.string().uuid().optional() }) } }, async (req) => {
    const p = principalOf(req);
    const rows = await query(
      `SELECT i.id, i.name, i.type, i.url, i.status, i.health, i.last_error, i.last_connected_at, i.config, i.project_id, pr.name AS project_name
         FROM integrations i LEFT JOIN projects pr ON pr.id = i.project_id
        WHERE i.organization_id = $1 AND i.type IN ('KUBERNETES','DYNATRACE') AND ($2::uuid IS NULL OR i.project_id = $2 OR i.project_id IS NULL)
        ORDER BY (i.type = 'KUBERNETES') DESC, i.name`, [p.orgId, req.query.projectId ?? p.projectId ?? null]);
    return rows.map((x) => ({
      id: x.id, name: x.name, type: x.type, source: x.type === 'KUBERNETES' ? 'kubernetes' : 'dynatrace', url: x.url, status: x.status, health: x.health,
      lastError: x.last_error, lastConnectedAt: x.last_connected_at, projectId: x.project_id, projectName: x.project_name,
      clusterName: x.type === 'KUBERNETES' ? x.config?.clusterName || x.name : x.config?.k8sCluster || null,
      namespaces: x.type === 'KUBERNETES' ? String(x.config?.namespaces ?? '').split(/[\s,;]+/).filter(Boolean) : [],
      environment: x.config?.environment ?? null, sampler: samplerStatus(x.id),
    }));
  });

  r.get('/kubernetes/:id/overview', { ...view, schema: { tags, summary: 'Cluster overview: version, nodes, capacity/usage, namespaces, pod phases, restarts, problems', params: idParams, querystring: z.object({ refresh: z.string().optional().transform((v) => v === 'true' || v === '1') }) } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    const s = await snap(c, req.query.refresh);
    return { ...meta(c, s), sampler: samplerStatus(c.id), ...overview(s) };
  });

  r.get('/kubernetes/:id/namespaces', { ...view, schema: { tags, summary: 'Namespaces', params: idParams } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    const s = await snap(c);
    return { ...meta(c, s), items: s.namespaces };
  });

  r.get('/kubernetes/:id/workloads', { ...view, schema: { tags, summary: 'Deployments / StatefulSets / DaemonSets / Jobs with replicas, images, usage vs requests/limits', params: idParams,
    querystring: z.object({ namespace: z.string().optional(), kind: z.string().optional(), q: z.string().optional() }) } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    const s = await snap(c);
    const needle = req.query.q?.toLowerCase();
    const items = s.workloads.filter((w) => (!req.query.namespace || w.namespace === req.query.namespace) && (!req.query.kind || w.kind === req.query.kind)
      && (!needle || `${w.name} ${w.namespace} ${w.images.join(' ')}`.toLowerCase().includes(needle)))
      .sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    return { ...meta(c, s), items };
  });

  r.get('/kubernetes/:id/pods', { ...view, schema: { tags, summary: 'Pods with status reason, restarts, usage vs requests/limits, QoS (filters: namespace, workload, node, status = ok|warn|fail|done or a reason, q)', params: idParams,
    querystring: z.object({ namespace: z.string().optional(), workload: z.string().optional(), node: z.string().optional(), status: z.string().optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(5000).default(2000) }) } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    const s = await snap(c);
    const all = filterPods(s.pods, req.query).sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || b.restarts - a.restarts || a.name.localeCompare(b.name));
    return { ...meta(c, s), total: all.length, items: all.slice(0, req.query.limit) };
  });

  const podParams = z.object({ id: z.string().uuid(), namespace: z.string().min(1).max(253), name: z.string().min(1).max(253) });

  r.get('/kubernetes/:id/pods/:namespace/:name', { ...view, schema: { tags, summary: 'Pod configuration: containers (image, ports, resources, probes, env with secrets masked), volumes, labels, conditions, owner chain, events', params: podParams } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    touch(c.id);
    try {
      if (c.kind === 'direct') return { connection: { id: c.id, name: c.name, source: c.kind }, ...(await podDetailDirect(c.kube, req.params.namespace, req.params.name)) };
      return { connection: { id: c.id, name: c.name, source: c.kind }, ...(await podDetailDynatrace(c.dt, await getSnapshot(c), req.params.namespace, req.params.name)) };
    } catch (e) { upstream(e); }
  });

  r.get('/kubernetes/:id/pods/:namespace/:name/logs', { ...view, schema: { tags, summary: 'Last N log lines per container (credentials redacted, 256 KB cap per container)', params: podParams,
    querystring: z.object({ container: z.string().optional(), tailLines: z.coerce.number().int().min(1).max(2000).default(200), previous: z.string().optional().transform((v) => v === 'true' || v === '1') }) } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    if (c.kind !== 'direct') throw badRequest('Container logs need a direct Kubernetes connection (Dynatrace does not expose them through this API)');
    try { return await podLogsDirect(c.kube, req.params.namespace, req.params.name, req.query); } catch (e) { upstream(e); }
  });

  r.get('/kubernetes/:id/nodes', { ...view, schema: { tags, summary: 'Nodes: readiness, conditions, capacity/allocatable, usage, requests', params: idParams } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    const s = await snap(c);
    return { ...meta(c, s), items: [...s.nodes].sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || a.name.localeCompare(b.name)) };
  });

  r.get('/kubernetes/:id/events', { ...view, schema: { tags, summary: 'Cluster events, warnings first', params: idParams,
    querystring: z.object({ namespace: z.string().optional(), type: z.enum(['Warning', 'Normal']).optional(), kind: z.string().optional(), name: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(300) }) } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    const s = await snap(c);
    const q = req.query;
    const items = s.events.filter((e) => (!q.namespace || e.namespace === q.namespace) && (!q.type || e.type === q.type) && (!q.kind || e.kind === q.kind) && (!q.name || e.name === q.name)).slice(0, q.limit);
    return { ...meta(c, s), items };
  });

  r.get('/kubernetes/:id/trends', { ...view, schema: { tags, summary: 'CPU (millicores) / memory (bytes) trends for cluster | node | namespace | workload | pod (sampled while the module is viewed or a linked run is RUNNING)', params: idParams,
    querystring: z.object({ scope: z.enum(['cluster', 'node', 'namespace', 'workload', 'pod']).default('cluster'), namespace: z.string().optional(), name: z.string().optional(), minutes: z.coerce.number().int().min(5).max(1440).default(60) }) } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    touch(c.id);
    const q = req.query;
    if (c.kind === 'dynatrace') {
      try {
        const scope = q.scope === 'pod' ? 'workload' : q.scope === 'node' ? 'cluster' : q.scope;
        let name = q.name;
        if (q.scope === 'pod' && q.namespace && q.name) name = (await getSnapshot(c)).pods.find((p) => p.namespace === q.namespace && p.name === q.name)?.workload?.name;
        return { scope, source: 'dynatrace', intervalSec: 60, ...(await trendsDynatrace(c.dt, scope, q.namespace, name, q.minutes)) };
      } catch (e) { upstream(e); }
    }
    return { scope: q.scope, source: 'sampler', sampler: samplerStatus(c.id), ...(await sampledTrends(c.id, q.scope, q)) };
  });

  r.post('/kubernetes/:id/sample', { ...manage, schema: { tags, summary: 'Take one usage sample now (also refreshes the cached snapshot)', params: idParams } }, async (req) => {
    const c = await loadConn(req, req.params.id);
    if (c.kind !== 'direct') throw badRequest('Sampling applies to direct Kubernetes connections; Dynatrace keeps its own history');
    dropSnapshot(c.id);
    touch(c.id);
    const points = await sampleOnce(c.id);
    return { points, sampler: samplerStatus(c.id) };
  });
}
