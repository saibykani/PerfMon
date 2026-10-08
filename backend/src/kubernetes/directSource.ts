import { kubeGet, KubeError, type KubeConn } from './kubeClient.js';
import {
  cpuMillis, memBytes, maskAnnotations, maskArgs, maskValue, MASK, nodeRoles, podResources, podStatus, redactText,
  type EventItem, type Level, type NamespaceSummary, type NodeSummary, type PodSummary, type Ref, type Snapshot, type WorkloadSummary,
} from './model.js';

/**
 * Source that talks to the Kubernetes API server directly with a read-only ServiceAccount token.
 * Usage comes from metrics.k8s.io (metrics-server); everything else from core/apps/batch APIs.
 */

const enc = encodeURIComponent;

/** Lists a namespaced resource cluster-wide, or per namespace when an allow-list is configured. */
async function listNs(c: KubeConn, group: string, resource: string, query = ''): Promise<any[]> {
  if (!c.namespaces.length) return (await kubeGet(c, `${group}/${resource}${query}`)).items ?? [];
  const lists = await Promise.all(c.namespaces.map((ns) => kubeGet(c, `${group}/namespaces/${enc(ns)}/${resource}${query}`)));
  return lists.flatMap((l: any) => l.items ?? []);
}

const key = (ns: string | undefined, name: string) => `${ns ?? ''}/${name}`;
const ownerOf = (o: any): Ref | null => { const r = (o?.metadata?.ownerReferences ?? []).find((x: any) => x.controller) ?? o?.metadata?.ownerReferences?.[0]; return r ? { kind: r.kind, name: r.name } : null; };

interface Settled<T> { ok: boolean; value: T; error?: KubeError }
async function settle<T>(p: Promise<T>, fallback: T): Promise<Settled<T>> {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, value: fallback, error: e instanceof KubeError ? e : new KubeError((e as Error).message) }; }
}

export async function testDirect(c: KubeConn) {
  const ver = await kubeGet(c, '/version', { timeoutMs: 10_000 });
  let namespaces: number;
  if (c.namespaces.length) {
    await Promise.all(c.namespaces.map((ns) => kubeGet(c, `/api/v1/namespaces/${enc(ns)}/pods?limit=1`, { timeoutMs: 10_000 })));
    namespaces = c.namespaces.length;
  } else namespaces = ((await kubeGet(c, '/api/v1/namespaces', { timeoutMs: 10_000 })).items ?? []).length;
  const nodes = await settle(kubeGet(c, '/api/v1/nodes', { timeoutMs: 10_000 }), null as any);
  const metrics = await settle(kubeGet(c, '/apis/metrics.k8s.io/v1beta1/nodes', { timeoutMs: 10_000 }), null as any);
  const parts = [`Connected to Kubernetes ${ver.gitVersion ?? ''}`.trim(), `${namespaces} namespace${namespaces === 1 ? '' : 's'}`];
  if (nodes.ok) parts.push(`${(nodes.value?.items ?? []).length} node${(nodes.value?.items ?? []).length === 1 ? '' : 's'}`);
  const notes: string[] = [];
  if (!nodes.ok) notes.push(`nodes not readable (${nodes.error?.message})`);
  if (!metrics.ok) notes.push(metrics.error?.status === 404 || metrics.error?.status === 503 ? 'metrics-server not installed — CPU/memory usage unavailable' : `metrics.k8s.io not readable (${metrics.error?.message})`);
  return { message: parts.join('; ') + (notes.length ? `. Note: ${notes.join('; ')}` : ''), details: { version: ver.gitVersion, platform: ver.platform, namespaces, nodes: nodes.ok ? (nodes.value?.items ?? []).length : null, metrics: metrics.ok } };
}

export async function snapshotDirect(c: KubeConn): Promise<Snapshot> {
  const warnings: string[] = [];
  const [ver, nodesR, nsR, podsR, depR, stsR, dsR, rsR, jobR, evR, pmR, nmR] = await Promise.all([
    settle(kubeGet(c, '/version'), null as any),
    settle(kubeGet(c, '/api/v1/nodes').then((r) => r.items ?? []), [] as any[]),
    c.namespaces.length ? settle(Promise.resolve(c.namespaces.map((n) => ({ metadata: { name: n }, status: { phase: 'Active' } }))), [] as any[]) : settle(kubeGet(c, '/api/v1/namespaces').then((r) => r.items ?? []), [] as any[]),
    settle(listNs(c, '/api/v1', 'pods'), [] as any[]),
    settle(listNs(c, '/apis/apps/v1', 'deployments'), [] as any[]),
    settle(listNs(c, '/apis/apps/v1', 'statefulsets'), [] as any[]),
    settle(listNs(c, '/apis/apps/v1', 'daemonsets'), [] as any[]),
    settle(listNs(c, '/apis/apps/v1', 'replicasets'), [] as any[]),
    settle(listNs(c, '/apis/batch/v1', 'jobs'), [] as any[]),
    settle(listNs(c, '/api/v1', 'events', '?limit=1000'), [] as any[]),
    settle(listNs(c, '/apis/metrics.k8s.io/v1beta1', 'pods'), [] as any[]),
    settle(kubeGet(c, '/apis/metrics.k8s.io/v1beta1/nodes').then((r) => r.items ?? []), [] as any[]),
  ]);
  // fatal: cannot reach the cluster or read pods at all
  if (!podsR.ok && (!ver.ok || podsR.error?.kind === 'auth')) throw podsR.error ?? ver.error!;
  if (!ver.ok && !podsR.ok) throw ver.error!;
  for (const [what, r] of [['pods', podsR], ['nodes', nodesR], ['namespaces', nsR], ['deployments', depR], ['statefulsets', stsR], ['daemonsets', dsR], ['replicasets', rsR], ['jobs', jobR], ['events', evR]] as const) {
    if (!r.ok) warnings.push(`${what}: ${r.error?.message}`);
  }
  const metricsAvailable = pmR.ok || nmR.ok;
  if (!pmR.ok) warnings.push(pmR.error?.status === 404 || pmR.error?.status === 503 ? 'metrics-server (metrics.k8s.io) is not installed — CPU/memory usage is unavailable' : `pod metrics: ${pmR.error?.message}`);

  // ReplicaSet → Deployment, Job → CronJob
  const rsOwner = new Map<string, Ref | null>();
  for (const rs of rsR.value) rsOwner.set(key(rs.metadata.namespace, rs.metadata.name), ownerOf(rs));
  const jobOwner = new Map<string, Ref | null>();
  for (const j of jobR.value) jobOwner.set(key(j.metadata.namespace, j.metadata.name), ownerOf(j));

  const podUsage = new Map<string, { cpu: number; memory: number; containers: Record<string, { cpu: number | null; memory: number | null }> }>();
  for (const m of pmR.value) {
    const cs: Record<string, { cpu: number | null; memory: number | null }> = {};
    let cpu = 0, mem = 0;
    for (const ct of m.containers ?? []) {
      const cc = cpuMillis(ct.usage?.cpu), mm = memBytes(ct.usage?.memory);
      cs[ct.name] = { cpu: cc, memory: mm };
      cpu += cc ?? 0; mem += mm ?? 0;
    }
    podUsage.set(key(m.metadata.namespace, m.metadata.name), { cpu, memory: mem, containers: cs });
  }

  const pods: PodSummary[] = podsR.value.map((p: any) => mapPod(p, rsOwner, podUsage.get(key(p.metadata.namespace, p.metadata.name)) ?? null));

  // workloads
  const byWorkload = new Map<string, PodSummary[]>();
  for (const p of pods) if (p.workload) { const k = `${p.workload.kind}/${key(p.namespace, p.workload.name)}`; (byWorkload.get(k) ?? byWorkload.set(k, []).get(k)!).push(p); }
  const workloads: WorkloadSummary[] = [
    ...depR.value.map((d: any) => mapWorkload('Deployment', d, byWorkload)),
    ...stsR.value.map((d: any) => mapWorkload('StatefulSet', d, byWorkload)),
    ...dsR.value.map((d: any) => mapWorkload('DaemonSet', d, byWorkload)),
    ...jobR.value.map((d: any) => mapWorkload('Job', d, byWorkload)),
  ];

  // nodes
  const nodeUsage = new Map<string, { cpu: number | null; memory: number | null }>();
  for (const m of nmR.value) nodeUsage.set(m.metadata.name, { cpu: cpuMillis(m.usage?.cpu), memory: memBytes(m.usage?.memory) });
  const podsByNode = new Map<string, PodSummary[]>();
  for (const p of pods) if (p.node && p.phase !== 'Succeeded' && p.phase !== 'Failed') (podsByNode.get(p.node) ?? podsByNode.set(p.node, []).get(p.node)!).push(p);
  const nodes: NodeSummary[] = nodesR.value.map((n: any) => mapNode(n, podsByNode.get(n.metadata.name) ?? [], nodeUsage.get(n.metadata.name) ?? null));

  const namespaces: NamespaceSummary[] = nsR.value.map((n: any) => ({ name: n.metadata.name, phase: n.status?.phase ?? 'Active', createdAt: n.metadata.creationTimestamp ?? null }));
  const events = evR.value.map(mapEvent).sort((a: EventItem, b: EventItem) => (b.type === 'Warning' ? 1 : 0) - (a.type === 'Warning' ? 1 : 0) || String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 500);

  return {
    at: Date.now(),
    cluster: { name: c.clusterName, version: ver.value?.gitVersion ?? null, platform: ver.value?.platform ?? null, source: 'kubernetes', url: c.url },
    nodes, namespaces, pods, workloads, events, metricsAvailable, warnings,
  };
}

function containerBriefs(p: any): PodSummary['containers'] {
  const statuses = new Map<string, any>((p.status?.containerStatuses ?? []).map((s: any) => [s.name, s]));
  return (p.spec?.containers ?? []).map((ct: any) => {
    const s = statuses.get(ct.name);
    const state = s?.state ? Object.keys(s.state)[0] ?? 'unknown' : 'waiting';
    return {
      name: ct.name, image: ct.image, ready: !!s?.ready, restarts: s?.restartCount ?? 0, state,
      reason: s?.state?.[state]?.reason ?? null, lastTermination: s?.lastState?.terminated?.reason ?? null,
    };
  });
}

function mapPod(p: any, rsOwner: Map<string, Ref | null>, usage: { cpu: number; memory: number } | null): PodSummary {
  const owner = ownerOf(p);
  let workload: Ref | null = owner;
  if (owner?.kind === 'ReplicaSet') workload = rsOwner.get(key(p.metadata.namespace, owner.name)) ?? owner;
  const { status, level } = podStatus(p);
  const cs: any[] = p.status?.containerStatuses ?? [];
  const lastRestart = cs.map((s) => s.lastState?.terminated?.finishedAt).filter(Boolean).sort().pop() ?? null;
  return {
    uid: p.metadata.uid, name: p.metadata.name, namespace: p.metadata.namespace, node: p.spec?.nodeName ?? null, phase: p.status?.phase ?? 'Unknown',
    status, level, ready: cs.filter((s) => s.ready).length, total: (p.spec?.containers ?? []).length,
    restarts: cs.reduce((a, s) => a + (s.restartCount ?? 0), 0), lastRestartAt: lastRestart, createdAt: p.metadata.creationTimestamp ?? null,
    qos: p.status?.qosClass ?? null, owner, workload, ip: p.status?.podIP ?? null,
    cpu: usage?.cpu ?? null, memory: usage?.memory ?? null, ...podResources(p.spec), containers: containerBriefs(p),
  };
}

const sumN = (ps: PodSummary[], f: (p: PodSummary) => number | null) => { const v = ps.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

function mapWorkload(kind: string, o: any, byWorkload: Map<string, PodSummary[]>): WorkloadSummary {
  const ns = o.metadata.namespace;
  const pods = (byWorkload.get(`${kind}/${key(ns, o.metadata.name)}`) ?? []).filter((p) => p.phase !== 'Succeeded' || kind === 'Job');
  const st = o.status ?? {};
  let desired = 0, ready = 0, available = 0, updated: number | null = null;
  let level: Level = 'ok';
  let message: string | null = null;
  let job: WorkloadSummary['job'];
  if (kind === 'Deployment' || kind === 'StatefulSet') {
    desired = o.spec?.replicas ?? 1; ready = st.readyReplicas ?? 0; available = st.availableReplicas ?? 0; updated = st.updatedReplicas ?? null;
  } else if (kind === 'DaemonSet') {
    desired = st.desiredNumberScheduled ?? 0; ready = st.numberReady ?? 0; available = st.numberAvailable ?? 0; updated = st.updatedNumberScheduled ?? null;
  } else {
    const completions = o.spec?.completions ?? null;
    job = { active: st.active ?? 0, succeeded: st.succeeded ?? 0, failed: st.failed ?? 0, completions };
    desired = completions ?? 1; ready = st.succeeded ?? 0; available = st.active ?? 0;
    const cond = (st.conditions ?? []).find((c: any) => c.status === 'True' && (c.type === 'Complete' || c.type === 'Failed'));
    if (cond?.type === 'Failed') { level = 'fail'; message = cond.message ?? cond.reason ?? 'Job failed'; }
    else if (cond?.type === 'Complete') level = 'done';
    else if ((st.failed ?? 0) > 0) { level = 'warn'; message = `${st.failed} failed attempt(s)`; }
  }
  if (kind !== 'Job') {
    const prog = (st.conditions ?? []).find((c: any) => c.type === 'Progressing' && c.status === 'False');
    if (desired > 0 && ready === 0) { level = 'fail'; message = `0/${desired} replicas ready`; }
    else if (ready < desired) { level = 'warn'; message = `${ready}/${desired} replicas ready`; }
    if (prog) { level = 'fail'; message = prog.message ?? prog.reason; }
  }
  const failingPods = pods.filter((p) => p.level === 'fail');
  if (failingPods.length && level === 'ok') { level = 'warn'; message = `${failingPods.length} pod(s) failing`; }
  return {
    uid: o.metadata.uid, kind, name: o.metadata.name, namespace: ns, desired, ready, available, updated,
    images: [...new Set<string>((o.spec?.template?.spec?.containers ?? []).map((c: any) => c.image))], createdAt: o.metadata.creationTimestamp ?? null,
    pods: pods.length, level, message,
    cpu: sumN(pods, (p) => p.cpu), memory: sumN(pods, (p) => p.memory),
    cpuRequest: sumN(pods, (p) => p.cpuRequest), cpuLimit: pods.some((p) => p.cpuLimit == null) ? null : sumN(pods, (p) => p.cpuLimit),
    memRequest: sumN(pods, (p) => p.memRequest), memLimit: pods.some((p) => p.memLimit == null) ? null : sumN(pods, (p) => p.memLimit),
    restarts: pods.reduce((a, p) => a + p.restarts, 0), job,
  };
}

function mapNode(n: any, pods: PodSummary[], usage: { cpu: number | null; memory: number | null } | null): NodeSummary {
  const conds: any[] = n.status?.conditions ?? [];
  const ready = conds.find((c) => c.type === 'Ready')?.status === 'True';
  const pressure = conds.filter((c) => c.type !== 'Ready' && c.status === 'True').map((c) => c.type);
  const unschedulable = !!n.spec?.unschedulable;
  const status = (ready ? 'Ready' : 'NotReady') + (unschedulable ? ',SchedulingDisabled' : '');
  const info = n.status?.nodeInfo ?? {};
  return {
    name: n.metadata.name, ready, status, level: !ready ? 'fail' : pressure.length ? 'warn' : 'ok', roles: nodeRoles(n.metadata.labels), unschedulable, pressure,
    kubelet: info.kubeletVersion ?? null, os: info.operatingSystem ?? null, arch: info.architecture ?? null, runtime: info.containerRuntimeVersion ?? null,
    kernel: info.kernelVersion ?? null, osImage: info.osImage ?? null, internalIP: (n.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address ?? null,
    cpuCapacity: cpuMillis(n.status?.capacity?.cpu), cpuAllocatable: cpuMillis(n.status?.allocatable?.cpu),
    memCapacity: memBytes(n.status?.capacity?.memory), memAllocatable: memBytes(n.status?.allocatable?.memory), podsCapacity: Number(n.status?.allocatable?.pods ?? n.status?.capacity?.pods) || null,
    pods: pods.length, cpuUsage: usage?.cpu ?? null, memUsage: usage?.memory ?? null,
    cpuRequests: pods.reduce((a, p) => a + (p.cpuRequest ?? 0), 0), memRequests: pods.reduce((a, p) => a + (p.memRequest ?? 0), 0),
    cpuLimits: pods.reduce((a, p) => a + (p.cpuLimit ?? 0), 0), memLimits: pods.reduce((a, p) => a + (p.memLimit ?? 0), 0),
    conditions: conds.map((c) => ({ type: c.type, status: c.status, reason: c.reason ?? null, message: c.message ?? null })),
    taints: (n.spec?.taints ?? []).map((t: any) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`), createdAt: n.metadata.creationTimestamp ?? null,
  };
}

function mapEvent(e: any): EventItem {
  return {
    type: e.type ?? 'Normal', reason: e.reason ?? '', message: redactText(String(e.message ?? e.note ?? '')).slice(0, 1000),
    kind: e.involvedObject?.kind ?? e.regarding?.kind ?? '', name: e.involvedObject?.name ?? e.regarding?.name ?? '', namespace: e.involvedObject?.namespace ?? e.metadata?.namespace ?? null,
    count: e.count ?? e.series?.count ?? 1, firstAt: e.firstTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? null,
    lastAt: e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.metadata?.creationTimestamp ?? null,
    source: e.source?.component ?? e.reportingComponent ?? null,
  };
}

/* ------------------------------------------------------------------ pod detail ("configuration") */

function probe(p: any) {
  if (!p) return null;
  const h = p.httpGet ? { type: 'httpGet', target: `${p.httpGet.scheme ?? 'HTTP'} :${p.httpGet.port}${p.httpGet.path ?? '/'}` }
    : p.tcpSocket ? { type: 'tcpSocket', target: `:${p.tcpSocket.port}` }
      : p.grpc ? { type: 'grpc', target: `:${p.grpc.port}${p.grpc.service ? ` ${p.grpc.service}` : ''}` }
        : p.exec ? { type: 'exec', target: (maskArgs(p.exec.command) ?? []).join(' ') } : { type: 'unknown', target: '' };
  return { ...h, initialDelaySeconds: p.initialDelaySeconds ?? 0, periodSeconds: p.periodSeconds ?? 10, timeoutSeconds: p.timeoutSeconds ?? 1, failureThreshold: p.failureThreshold ?? 3, successThreshold: p.successThreshold ?? 1 };
}

function envOf(ct: any) {
  const env = (ct.env ?? []).map((e: any) => {
    const vf = e.valueFrom;
    if (vf?.secretKeyRef) return { name: e.name, value: MASK, masked: true, source: 'secret', ref: `${vf.secretKeyRef.name}/${vf.secretKeyRef.key}` };
    if (vf?.configMapKeyRef) return { name: e.name, value: null, masked: false, source: 'configMap', ref: `${vf.configMapKeyRef.name}/${vf.configMapKeyRef.key}` };
    if (vf?.fieldRef) return { name: e.name, value: null, masked: false, source: 'field', ref: vf.fieldRef.fieldPath };
    if (vf?.resourceFieldRef) return { name: e.name, value: null, masked: false, source: 'resource', ref: `${vf.resourceFieldRef.containerName ?? ''} ${vf.resourceFieldRef.resource}`.trim() };
    const m = maskValue(e.name, String(e.value ?? ''));
    return { name: e.name, value: m.value, masked: m.masked, source: 'literal', ref: null };
  });
  const envFrom = (ct.envFrom ?? []).map((f: any) => f.secretRef
    ? { source: 'secret', name: f.secretRef.name, prefix: f.prefix ?? null, note: 'all keys of the Secret (values hidden)' }
    : { source: 'configMap', name: f.configMapRef?.name, prefix: f.prefix ?? null, note: 'all keys of the ConfigMap' });
  return { env, envFrom };
}

function volumeOf(v: any) {
  const type = Object.keys(v).find((k) => k !== 'name') ?? 'unknown';
  const s = v[type] ?? {};
  const detail = type === 'secret' ? `Secret ${s.secretName} (contents hidden)`
    : type === 'configMap' ? `ConfigMap ${s.name}`
      : type === 'persistentVolumeClaim' ? `PVC ${s.claimName}${s.readOnly ? ' (ro)' : ''}`
        : type === 'emptyDir' ? `emptyDir${s.medium ? ` (${s.medium})` : ''}${s.sizeLimit ? ` limit ${s.sizeLimit}` : ''}`
          : type === 'hostPath' ? `hostPath ${s.path}`
            : type === 'projected' ? `projected: ${(s.sources ?? []).map((x: any) => Object.keys(x)[0]).join(', ')}`
              : type === 'downwardAPI' ? 'downwardAPI' : type;
  return { name: v.name, type, detail };
}

function containerDetail(ct: any, status: any, usage: { cpu: number | null; memory: number | null } | undefined, init = false) {
  const { env, envFrom } = envOf(ct);
  const sc = ct.securityContext ?? {};
  return {
    name: ct.name, init, image: ct.image, imagePullPolicy: ct.imagePullPolicy ?? null,
    command: maskArgs(ct.command) ?? null, args: maskArgs(ct.args) ?? null, workingDir: ct.workingDir ?? null,
    ports: (ct.ports ?? []).map((p: any) => ({ name: p.name ?? null, containerPort: p.containerPort, protocol: p.protocol ?? 'TCP' })),
    resources: {
      requests: { cpu: ct.resources?.requests?.cpu ?? null, memory: ct.resources?.requests?.memory ?? null },
      limits: { cpu: ct.resources?.limits?.cpu ?? null, memory: ct.resources?.limits?.memory ?? null },
      cpuRequest: cpuMillis(ct.resources?.requests?.cpu), cpuLimit: cpuMillis(ct.resources?.limits?.cpu),
      memRequest: memBytes(ct.resources?.requests?.memory), memLimit: memBytes(ct.resources?.limits?.memory),
    },
    usage: usage ?? null,
    probes: { liveness: probe(ct.livenessProbe), readiness: probe(ct.readinessProbe), startup: probe(ct.startupProbe) },
    env, envFrom,
    volumeMounts: (ct.volumeMounts ?? []).map((m: any) => ({ name: m.name, mountPath: m.mountPath, readOnly: !!m.readOnly, subPath: m.subPath ?? null })),
    securityContext: Object.keys(sc).length ? { runAsUser: sc.runAsUser ?? null, runAsNonRoot: sc.runAsNonRoot ?? null, readOnlyRootFilesystem: sc.readOnlyRootFilesystem ?? null, privileged: sc.privileged ?? null, allowPrivilegeEscalation: sc.allowPrivilegeEscalation ?? null } : null,
    status: status ? {
      ready: !!status.ready, started: status.started ?? null, restarts: status.restartCount ?? 0, imageID: status.imageID ?? null,
      state: Object.keys(status.state ?? {})[0] ?? 'unknown', stateDetail: Object.values(status.state ?? {})[0] ?? null,
      lastState: status.lastState?.terminated ? { reason: status.lastState.terminated.reason ?? null, exitCode: status.lastState.terminated.exitCode, finishedAt: status.lastState.terminated.finishedAt ?? null } : null,
    } : null,
  };
}

export async function podDetailDirect(c: KubeConn, ns: string, name: string) {
  if (c.namespaces.length && !c.namespaces.includes(ns)) throw new KubeError(`Namespace ${ns} is not in this connection's allow-list`, 404, 'notfound');
  const p = await kubeGet(c, `/api/v1/namespaces/${enc(ns)}/pods/${enc(name)}`);
  const [ev, met] = await Promise.all([
    settle(kubeGet(c, `/api/v1/namespaces/${enc(ns)}/events?fieldSelector=${enc(`involvedObject.kind=Pod,involvedObject.name=${name}`)}`).then((r) => r.items ?? []), [] as any[]),
    settle(kubeGet(c, `/apis/metrics.k8s.io/v1beta1/namespaces/${enc(ns)}/pods/${enc(name)}`), null as any),
  ]);
  // owner chain (Pod → ReplicaSet → Deployment, Pod → Job → CronJob)
  const chain: Ref[] = [];
  let cur = ownerOf(p);
  for (let i = 0; cur && i < 4; i++) {
    chain.push(cur);
    const path = cur.kind === 'ReplicaSet' ? `/apis/apps/v1/namespaces/${enc(ns)}/replicasets/${enc(cur.name)}` : cur.kind === 'Job' ? `/apis/batch/v1/namespaces/${enc(ns)}/jobs/${enc(cur.name)}` : null;
    if (!path) break;
    const parent = await settle(kubeGet(c, path), null as any);
    cur = parent.ok ? ownerOf(parent.value) : null;
  }
  const usage = new Map<string, { cpu: number | null; memory: number | null }>();
  for (const ct of met.value?.containers ?? []) usage.set(ct.name, { cpu: cpuMillis(ct.usage?.cpu), memory: memBytes(ct.usage?.memory) });
  const statuses = new Map<string, any>([...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])].map((s: any) => [s.name, s]));
  const { status, level } = podStatus(p);
  const res = podResources(p.spec);
  const cpu = met.ok ? [...usage.values()].reduce((a, u) => a + (u.cpu ?? 0), 0) : null;
  const memory = met.ok ? [...usage.values()].reduce((a, u) => a + (u.memory ?? 0), 0) : null;
  return {
    name: p.metadata.name, namespace: ns, uid: p.metadata.uid, status, level, phase: p.status?.phase ?? 'Unknown', qos: p.status?.qosClass ?? null,
    node: p.spec?.nodeName ?? null, podIP: p.status?.podIP ?? null, hostIP: p.status?.hostIP ?? null, startTime: p.status?.startTime ?? null, createdAt: p.metadata.creationTimestamp ?? null,
    serviceAccount: p.spec?.serviceAccountName ?? null, priorityClass: p.spec?.priorityClassName ?? null, restartPolicy: p.spec?.restartPolicy ?? null,
    dnsPolicy: p.spec?.dnsPolicy ?? null, terminationGracePeriodSeconds: p.spec?.terminationGracePeriodSeconds ?? null,
    nodeSelector: p.spec?.nodeSelector ?? {}, tolerations: (p.spec?.tolerations ?? []).map((t: any) => `${t.key ?? '*'}${t.operator === 'Exists' ? '' : `=${t.value ?? ''}`}:${t.effect ?? '*'}${t.tolerationSeconds != null ? ` (${t.tolerationSeconds}s)` : ''}`),
    labels: p.metadata.labels ?? {}, annotations: maskAnnotations(p.metadata.annotations),
    ownerChain: chain, workload: chain.length ? chain[chain.length - 1] : null,
    conditions: (p.status?.conditions ?? []).map((x: any) => ({ type: x.type, status: x.status, reason: x.reason ?? null, message: x.message ?? null, lastTransitionTime: x.lastTransitionTime ?? null })),
    usage: { cpu, memory }, ...res,
    containers: [
      ...(p.spec?.initContainers ?? []).map((ct: any) => containerDetail(ct, statuses.get(ct.name), usage.get(ct.name), true)),
      ...(p.spec?.containers ?? []).map((ct: any) => containerDetail(ct, statuses.get(ct.name), usage.get(ct.name))),
    ],
    volumes: (p.spec?.volumes ?? []).map(volumeOf),
    events: ev.value.map(mapEvent).sort((a: EventItem, b: EventItem) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 100),
    metricsAvailable: met.ok,
    warnings: [...(ev.ok ? [] : [`events: ${ev.error?.message}`]), ...(met.ok ? [] : [`usage: ${met.error?.message}`])],
  };
}

export async function podLogsDirect(c: KubeConn, ns: string, name: string, opts: { container?: string; tailLines: number; previous: boolean }) {
  if (c.namespaces.length && !c.namespaces.includes(ns)) throw new KubeError(`Namespace ${ns} is not in this connection's allow-list`, 404, 'notfound');
  const p = await kubeGet(c, `/api/v1/namespaces/${enc(ns)}/pods/${enc(name)}`);
  const all: string[] = [...(p.spec?.initContainers ?? []), ...(p.spec?.containers ?? [])].map((x: any) => x.name);
  const names = opts.container ? all.filter((n) => n === opts.container) : (p.spec?.containers ?? []).map((x: any) => x.name);
  if (!names.length) throw new KubeError(`Container ${opts.container} not found in pod ${name}`, 404, 'notfound');
  const LIMIT = 256 * 1024;
  const out = await Promise.all(names.slice(0, 10).map(async (cn: string) => {
    const qs = new URLSearchParams({ container: cn, tailLines: String(opts.tailLines), limitBytes: String(LIMIT), timestamps: 'true' });
    if (opts.previous) qs.set('previous', 'true');
    try {
      const text = await kubeGet<string>(c, `/api/v1/namespaces/${enc(ns)}/pods/${enc(name)}/log?${qs}`, { text: true, maxBytes: LIMIT + 1024, timeoutMs: 12_000 });
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return { container: cn, lines: lines.map(redactText), truncated: text.length >= LIMIT, error: null as string | null };
    } catch (e) {
      return { container: cn, lines: [] as string[], truncated: false, error: (e as Error).message };
    }
  }));
  return { pod: name, namespace: ns, containers: all, logs: out };
}

/** Cheap usage sample for the trend sampler (metrics.k8s.io only). */
export async function usageDirect(c: KubeConn) {
  const [pods, nodes] = await Promise.all([
    settle(listNs(c, '/apis/metrics.k8s.io/v1beta1', 'pods'), [] as any[]),
    settle(kubeGet(c, '/apis/metrics.k8s.io/v1beta1/nodes').then((r) => r.items ?? []), [] as any[]),
  ]);
  if (!pods.ok && !nodes.ok) throw pods.error!;
  return {
    pods: pods.value.map((m: any) => ({
      namespace: m.metadata.namespace as string, name: m.metadata.name as string,
      cpu: (m.containers ?? []).reduce((a: number, ct: any) => a + (cpuMillis(ct.usage?.cpu) ?? 0), 0),
      memory: (m.containers ?? []).reduce((a: number, ct: any) => a + (memBytes(ct.usage?.memory) ?? 0), 0),
    })),
    nodes: nodes.value.map((m: any) => ({ name: m.metadata.name as string, cpu: cpuMillis(m.usage?.cpu), memory: memBytes(m.usage?.memory) })),
  };
}
