import { http, joinUrl } from '../integrations/connectors/http.js';
import { KubeError } from './kubeClient.js';
import { maskAnnotations, type EventItem, type Level, type NodeSummary, type PodSummary, type Snapshot, type WorkloadSummary } from './model.js';

/**
 * Kubernetes data read from Dynatrace instead of the API server (for clusters that are not
 * reachable from Perfmon but are monitored by Dynatrace / the Dynatrace Operator).
 *
 * Token scopes: entities.read (Monitored entities API v2), metrics.read (Metrics API v2);
 * events.read is optional (cluster events). Entities used: KUBERNETES_CLUSTER, KUBERNETES_NODE,
 * CLOUD_APPLICATION_NAMESPACE, CLOUD_APPLICATION (workloads), CLOUD_APPLICATION_INSTANCE (pods).
 * Metrics: builtin:kubernetes.workload.*, builtin:kubernetes.node.*, builtin:kubernetes.container.restarts,
 * builtin:kubernetes.pods. Dimension names vary between Dynatrace versions, so they are matched
 * tolerantly; anything missing is reported as a warning rather than an error.
 */

export interface DtConn { id: string; url: string; token: string; cluster: string | null; clusterName: string }

async function dtGet(c: DtConn, path: string): Promise<any> {
  const r = await http(joinUrl(c.url, path), { headers: { authorization: `Api-Token ${c.token}`, accept: 'application/json' }, timeoutMs: 10_000 });
  if (r.ok) return r.json;
  const msg = r.json?.error?.message ?? r.json?.message ?? r.text.slice(0, 200);
  if (r.status === 401) throw new KubeError(`Dynatrace rejected the API token (HTTP 401): ${msg}`, 401, 'auth');
  if (r.status === 403) throw new KubeError(`Dynatrace token lacks permission (HTTP 403): ${msg}. Required scopes: entities.read, metrics.read (events.read optional).`, 403, 'forbidden');
  throw new KubeError(`Dynatrace API HTTP ${r.status}: ${msg}`, r.status);
}

interface Entity { entityId: string; displayName: string; type?: string; properties?: Record<string, any>; fromRelationships?: Record<string, { id: string }[]>; toRelationships?: Record<string, { id: string }[]>; firstSeenTms?: number }

async function entities(c: DtConn, selector: string, maxPages = 6): Promise<Entity[]> {
  const out: Entity[] = [];
  let qs = new URLSearchParams({ entitySelector: selector, fields: '+properties,+fromRelationships,+toRelationships,+firstSeenTms', pageSize: '500', from: 'now-3d' }).toString();
  for (let i = 0; i < maxPages; i++) {
    const r = await dtGet(c, `/api/v2/entities?${qs}`);
    out.push(...(r?.entities ?? []));
    if (!r?.nextPageKey) break;
    qs = new URLSearchParams({ nextPageKey: r.nextPageKey }).toString();
  }
  return out;
}

const relIds = (e: Entity) => {
  const ids = new Set<string>();
  for (const rel of [e.fromRelationships, e.toRelationships]) for (const list of Object.values(rel ?? {})) for (const x of list ?? []) ids.add(x.id);
  return ids;
};

type Row = { dims: Record<string, string>; value: number | null; points: [number, number][] };
async function metric(c: DtConn, selector: string, from = 'now-10m', resolution = 'Inf'): Promise<Row[]> {
  const qs = new URLSearchParams({ metricSelector: selector, from, resolution });
  const r = await dtGet(c, `/api/v2/metrics/query?${qs}`);
  const rows: Row[] = [];
  for (const res of r?.result ?? []) for (const d of res.data ?? []) {
    const points: [number, number][] = [];
    (d.timestamps ?? []).forEach((t: number, i: number) => { const v = d.values?.[i]; if (v != null && Number.isFinite(Number(v))) points.push([t, Number(v)]); });
    rows.push({ dims: d.dimensionMap ?? {}, value: points.length ? points[points.length - 1][1] : null, points });
  }
  return rows;
}

/** First dimension value whose key matches one of the patterns. */
const dim = (d: Record<string, string>, ...re: RegExp[]) => { for (const r of re) for (const [k, v] of Object.entries(d)) if (r.test(k)) return v; return null; };
const NS = [/^k8s\.namespace\.name$/, /namespace.*\.name$/, /namespace/i];
const WL = [/^k8s\.workload\.name$/, /cloud_application\.name$/, /workload.*name/i];
const NODE = [/^k8s\.node\.name$/, /kubernetes_node\.name$/, /node.*name/i];
const CL = [/^k8s\.cluster\.name$/, /kubernetes_cluster\.name$/];

const KIND: Record<string, string> = {
  KUBERNETES_DEPLOYMENT: 'Deployment', KUBERNETES_STATEFUL_SET: 'StatefulSet', KUBERNETES_DAEMON_SET: 'DaemonSet', KUBERNETES_JOB: 'Job', KUBERNETES_CRON_JOB: 'CronJob',
  KUBERNETES_REPLICA_SET: 'ReplicaSet', KUBERNETES_POD: 'Pod', OPENSHIFT_DEPLOYMENT_CONFIG: 'DeploymentConfig', KUBERNETES_REPLICATION_CONTROLLER: 'ReplicationController',
};
const kindOf = (e: Entity) => {
  const t = e.properties?.cloudApplicationDeploymentTypes?.[0] ?? e.properties?.workloadType ?? e.properties?.kubernetesWorkloadType;
  return KIND[String(t)] ?? (t ? String(t).replace(/^KUBERNETES_/, '').toLowerCase().replace(/(^|_)(\w)/g, (_m, _a, b) => b.toUpperCase()) : 'Workload');
};

export async function testDynatraceK8s(c: DtConn) {
  const clusters = await entities(c, 'type("KUBERNETES_CLUSTER")', 1);
  const names = clusters.map((x) => x.displayName);
  if (c.cluster && !names.some((n) => n.toLowerCase() === c.cluster!.toLowerCase())) throw new KubeError(`Kubernetes cluster "${c.cluster}" not found in Dynatrace (found: ${names.join(', ') || 'none'})`);
  return { message: `Dynatrace sees ${clusters.length} Kubernetes cluster(s)${names.length ? `: ${names.slice(0, 5).join(', ')}` : ''}`, details: { clusters: names } };
}

export async function snapshotDynatrace(c: DtConn): Promise<Snapshot> {
  const warnings: string[] = [];
  const soft = async <T>(what: string, p: Promise<T>, fb: T): Promise<T> => { try { return await p; } catch (e) { if ((e as KubeError).kind === 'auth') throw e; warnings.push(`${what}: ${(e as Error).message}`); return fb; } };

  const allClusters = await entities(c, 'type("KUBERNETES_CLUSTER")');
  const clusters = c.cluster ? allClusters.filter((x) => x.displayName.toLowerCase() === c.cluster!.toLowerCase()) : allClusters;
  if (!clusters.length) throw new KubeError(c.cluster ? `Kubernetes cluster "${c.cluster}" not found in Dynatrace (found: ${allClusters.map((x) => x.displayName).join(', ') || 'none'})` : 'Dynatrace does not monitor any Kubernetes cluster (no KUBERNETES_CLUSTER entities)', 404, 'notfound');
  const clusterIds = new Set(clusters.map((x) => x.entityId));
  const clusterNames = new Set(clusters.map((x) => x.displayName));
  const inCluster = (e: Entity) => { const r = relIds(e); return ![...r].some((id) => id.startsWith('KUBERNETES_CLUSTER-')) || [...r].some((id) => clusterIds.has(id)); };

  const [nsE, wlE, podE, nodeE] = await Promise.all([
    soft('namespaces', entities(c, 'type("CLOUD_APPLICATION_NAMESPACE")'), [] as Entity[]),
    soft('workloads', entities(c, 'type("CLOUD_APPLICATION")'), [] as Entity[]),
    soft('pods', entities(c, 'type("CLOUD_APPLICATION_INSTANCE")'), [] as Entity[]),
    soft('nodes', entities(c, 'type("KUBERNETES_NODE")'), [] as Entity[]),
  ]);
  const nsById = new Map(nsE.filter(inCluster).map((e) => [e.entityId, e]));
  const wlById = new Map(wlE.filter(inCluster).map((e) => [e.entityId, e]));
  const nsName = (e: Entity) => {
    for (const id of relIds(e)) if (nsById.has(id)) return nsById.get(id)!.displayName;
    return e.properties?.namespaceName ?? e.properties?.cloudApplicationNamespaceName ?? null;
  };

  const sel = (m: string) => `${m}:names`;
  const [wCpu, wMem, wReqC, wLimC, wReqM, wLimM, wDes, nCpu, nMem, nAllC, nAllM, nReqC, nReqM, restarts, podRows] = await Promise.all([
    soft('workload CPU usage', metric(c, sel('builtin:kubernetes.workload.cpu_usage')), []),
    soft('workload memory usage', metric(c, sel('builtin:kubernetes.workload.memory_working_set')), []),
    soft('workload CPU requests', metric(c, sel('builtin:kubernetes.workload.requests_cpu')), []),
    soft('workload CPU limits', metric(c, sel('builtin:kubernetes.workload.limits_cpu')), []),
    soft('workload memory requests', metric(c, sel('builtin:kubernetes.workload.requests_memory')), []),
    soft('workload memory limits', metric(c, sel('builtin:kubernetes.workload.limits_memory')), []),
    soft('desired pods', metric(c, sel('builtin:kubernetes.workload.pods_desired')), []),
    soft('node CPU usage', metric(c, sel('builtin:kubernetes.node.cpu_usage')), []),
    soft('node memory usage', metric(c, sel('builtin:kubernetes.node.memory_working_set')), []),
    soft('node CPU allocatable', metric(c, sel('builtin:kubernetes.node.cpu_allocatable')), []),
    soft('node memory allocatable', metric(c, sel('builtin:kubernetes.node.memory_allocatable')), []),
    soft('node CPU requests', metric(c, sel('builtin:kubernetes.node.requests_cpu')), []),
    soft('node memory requests', metric(c, sel('builtin:kubernetes.node.requests_memory')), []),
    soft('container restarts', metric(c, sel('builtin:kubernetes.container.restarts'), 'now-1h'), []),
    soft('pod phases', metric(c, sel('builtin:kubernetes.pods')), []),
  ]);
  const clusterOk = (r: Row) => { const cn = dim(r.dims, ...CL); return !cn || clusterNames.has(cn); };
  const byWl = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) if (clusterOk(r)) { const k = `${dim(r.dims, ...NS)}/${dim(r.dims, ...WL)}`; m.set(k, (m.get(k) ?? 0) + (r.value ?? 0)); } return m; };
  const byNode = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) if (clusterOk(r)) { const k = String(dim(r.dims, ...NODE)); m.set(k, (m.get(k) ?? 0) + (r.value ?? 0)); } return m; };
  const [mCpu, mMem, mReqC, mLimC, mReqM, mLimM, mDes, mRestarts] = [wCpu, wMem, wReqC, wLimC, wReqM, wLimM, wDes, restarts].map(byWl);
  // pod phase counts per workload (dimension "pod_phase" / "k8s.pod.phase")
  const phaseByWl = new Map<string, Record<string, number>>();
  for (const r of podRows) if (clusterOk(r)) {
    const k = `${dim(r.dims, ...NS)}/${dim(r.dims, ...WL)}`;
    const ph = dim(r.dims, /phase/i) ?? dim(r.dims, /status/i) ?? 'Running';
    const rec = phaseByWl.get(k) ?? {};
    rec[ph] = (rec[ph] ?? 0) + (r.value ?? 0);
    phaseByWl.set(k, rec);
  }

  const pods: PodSummary[] = [];
  const podCount = new Map<string, number>();
  for (const e of podE) {
    let wl: Entity | undefined;
    for (const id of relIds(e)) if (wlById.has(id)) { wl = wlById.get(id); break; }
    if (!wl && !inCluster(e)) continue;
    const ns = (wl && nsName(wl)) ?? nsName(e) ?? '—';
    const phase = String(e.properties?.cloudApplicationInstancePhase ?? e.properties?.podPhase ?? 'Running');
    const status = phase.charAt(0) + phase.slice(1).toLowerCase();
    const level: Level = /fail|unknown/i.test(phase) ? 'fail' : /pending/i.test(phase) ? 'warn' : /succeeded/i.test(phase) ? 'done' : 'ok';
    if (wl) podCount.set(wl.entityId, (podCount.get(wl.entityId) ?? 0) + 1);
    pods.push({
      uid: e.entityId, name: e.displayName, namespace: ns, node: e.properties?.nodeName ?? null, phase: status, status, level, ready: level === 'ok' ? 1 : 0, total: 1,
      restarts: 0, lastRestartAt: null, createdAt: e.firstSeenTms ? new Date(e.firstSeenTms).toISOString() : null, qos: null,
      owner: wl ? { kind: kindOf(wl), name: wl.displayName } : null, workload: wl ? { kind: kindOf(wl), name: wl.displayName } : null, ip: null,
      cpu: null, memory: null, cpuRequest: null, cpuLimit: null, memRequest: null, memLimit: null, containers: [],
    });
  }
  if (pods.length > 5000) { warnings.push(`Showing 5,000 of ${pods.length} pods`); pods.length = 5000; }

  const workloads: WorkloadSummary[] = [...wlById.values()].map((e) => {
    const ns = nsName(e) ?? '—';
    const k = `${ns}/${e.displayName}`;
    const ph = phaseByWl.get(k) ?? {};
    const running = Object.entries(ph).filter(([p]) => /running/i.test(p)).reduce((a, [, v]) => a + v, 0);
    const desired = Math.round(mDes.get(k) ?? podCount.get(e.entityId) ?? 0);
    const ready = Math.round(running || podCount.get(e.entityId) || 0);
    const failing = Object.entries(ph).filter(([p]) => /fail|pending|unknown/i.test(p)).reduce((a, [, v]) => a + v, 0);
    const level: Level = desired > 0 && ready === 0 ? 'fail' : ready < desired || failing > 0 ? 'warn' : 'ok';
    return {
      uid: e.entityId, kind: kindOf(e), name: e.displayName, namespace: ns, desired, ready, available: ready, updated: null, images: [],
      createdAt: e.firstSeenTms ? new Date(e.firstSeenTms).toISOString() : null, pods: podCount.get(e.entityId) ?? ready, level,
      message: level === 'ok' ? null : `${ready}/${desired} pods running${failing ? `, ${Math.round(failing)} pending/failed` : ''}`,
      cpu: mCpu.get(k) ?? null, memory: mMem.get(k) ?? null, cpuRequest: mReqC.get(k) ?? null, cpuLimit: mLimC.get(k) ?? null, memRequest: mReqM.get(k) ?? null, memLimit: mLimM.get(k) ?? null,
      restarts: Math.round(mRestarts.get(k) ?? 0),
    };
  });

  const [cpuU, memU, allC, allM, reqC, reqM] = [nCpu, nMem, nAllC, nAllM, nReqC, nReqM].map(byNode);
  const nodes: NodeSummary[] = nodeE.filter(inCluster).map((e) => {
    const n = e.displayName;
    const ready = !/not.?ready|false/i.test(String(e.properties?.nodeReadyCondition ?? e.properties?.kubernetesNodeReady ?? 'true'));
    return {
      name: n, ready, status: ready ? 'Ready' : 'NotReady', level: ready ? 'ok' : 'fail', roles: ['node'], unschedulable: false, pressure: [],
      kubelet: e.properties?.kubeletVersion ?? null, os: null, arch: null, runtime: null, kernel: null, osImage: null, internalIP: null,
      cpuCapacity: allC.get(n) ?? null, cpuAllocatable: allC.get(n) ?? null, memCapacity: allM.get(n) ?? null, memAllocatable: allM.get(n) ?? null, podsCapacity: null,
      pods: pods.filter((p) => p.node === n).length, cpuUsage: cpuU.get(n) ?? null, memUsage: memU.get(n) ?? null,
      cpuRequests: reqC.get(n) ?? 0, memRequests: reqM.get(n) ?? 0, cpuLimits: 0, memLimits: 0, conditions: [], taints: [],
      createdAt: e.firstSeenTms ? new Date(e.firstSeenTms).toISOString() : null,
    };
  });

  // optional: Dynatrace events for the cluster (events.read)
  let events: EventItem[] = [];
  try {
    const ids = [...clusterIds].map((id) => `"${id}"`).join(',');
    const r = await dtGet(c, `/api/v2/events?${new URLSearchParams({ from: 'now-6h', pageSize: '200', entitySelector: `type("KUBERNETES_CLUSTER"),entityId(${ids})` })}`);
    events = (r?.events ?? []).map((ev: any) => ({
      type: /ERROR|AVAILABILITY|RESOURCE|SLOWDOWN|CUSTOM_ALERT/.test(ev.eventType ?? '') ? 'Warning' : 'Normal', reason: ev.eventType ?? '', message: String(ev.title ?? '').slice(0, 1000),
      kind: ev.entityId?.entityId?.type ?? 'Cluster', name: ev.entityId?.name ?? '', namespace: null, count: 1,
      firstAt: ev.startTime ? new Date(ev.startTime).toISOString() : null, lastAt: ev.endTime && ev.endTime > 0 ? new Date(ev.endTime).toISOString() : ev.startTime ? new Date(ev.startTime).toISOString() : null, source: 'dynatrace',
    }));
  } catch (e) { warnings.push(`events (needs events.read): ${(e as Error).message}`); }

  const cl = clusters[0];
  return {
    at: Date.now(),
    cluster: { name: clusters.map((x) => x.displayName).join(', '), version: cl.properties?.kubernetesVersion ?? cl.properties?.softwareVersion ?? null, platform: cl.properties?.kubernetesDistribution ?? 'via Dynatrace', source: 'dynatrace', url: c.url },
    nodes,
    namespaces: [...nsById.values()].map((e) => ({ name: e.displayName, phase: 'Active', createdAt: e.firstSeenTms ? new Date(e.firstSeenTms).toISOString() : null })),
    pods, workloads, events, metricsAvailable: wCpu.length > 0 || nCpu.length > 0, warnings,
  };
}

/** Pod "configuration" from Dynatrace: entity properties only (container specs are not exposed by Dynatrace). */
export async function podDetailDynatrace(c: DtConn, snap: Snapshot, ns: string, name: string) {
  const pod = snap.pods.find((p) => p.namespace === ns && p.name === name);
  if (!pod) throw new KubeError(`Pod ${ns}/${name} not found in Dynatrace`, 404, 'notfound');
  const e = (await entities(c, `entityId("${pod.uid}")`, 1))[0];
  const props = maskAnnotations(Object.fromEntries(Object.entries(e?.properties ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
  const wl = pod.workload ? snap.workloads.find((w) => w.namespace === ns && w.name === pod.workload!.name) : null;
  return {
    name, namespace: ns, uid: pod.uid, status: pod.status, level: pod.level, phase: pod.phase, qos: null, node: pod.node, podIP: null, hostIP: null, startTime: pod.createdAt, createdAt: pod.createdAt,
    serviceAccount: null, priorityClass: null, restartPolicy: null, dnsPolicy: null, terminationGracePeriodSeconds: null, nodeSelector: {}, tolerations: [],
    labels: (e?.properties?.kubernetesLabels as Record<string, string>) ?? {}, annotations: props,
    ownerChain: pod.workload ? [pod.workload] : [], workload: pod.workload,
    conditions: [], usage: { cpu: wl?.cpu ?? null, memory: wl?.memory ?? null }, cpuRequest: wl?.cpuRequest ?? null, cpuLimit: wl?.cpuLimit ?? null, memRequest: wl?.memRequest ?? null, memLimit: wl?.memLimit ?? null,
    containers: [], volumes: [], events: snap.events.filter((ev) => ev.name === name), metricsAvailable: !!wl?.cpu,
    warnings: ['Read through Dynatrace: container specs, probes, environment and logs are only available with a direct Kubernetes connection. Usage and requests shown are for the whole workload.'],
  };
}

/** Workload / cluster trends straight from the Dynatrace Metrics API (1-minute resolution). */
export async function trendsDynatrace(c: DtConn, scope: string, ns: string | undefined, name: string | undefined, minutes: number) {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const filter = scope === 'workload' && ns && name ? `:filter(and(eq("k8s.namespace.name","${esc(ns)}"),eq("k8s.workload.name","${esc(name)}")))`
    : scope === 'namespace' && ns ? `:filter(eq("k8s.namespace.name","${esc(ns)}"))` : '';
  const q = async (m: string) => {
    const rows = await metric(c, `${m}${filter}:splitBy():sum`, `now-${minutes}m`, '1m');
    return rows[0]?.points ?? [];
  };
  const [cpu, memory] = await Promise.all([q('builtin:kubernetes.workload.cpu_usage'), q('builtin:kubernetes.workload.memory_working_set')]);
  return { cpu, memory };
}
