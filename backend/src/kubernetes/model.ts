/**
 * Kubernetes model: compact DTOs shared by the direct (API server) and Dynatrace sources,
 * quantity parsing, kubectl-like pod status derivation and credential masking.
 * CPU is expressed in millicores, memory in bytes.
 */

export type Level = 'ok' | 'warn' | 'fail' | 'done';
export interface Ref { kind: string; name: string }

export interface ContainerBrief { name: string; ready: boolean; restarts: number; state: string; reason: string | null; lastTermination: string | null; image: string }
export interface PodSummary {
  uid: string; name: string; namespace: string; node: string | null; phase: string; status: string; level: Level;
  ready: number; total: number; restarts: number; lastRestartAt: string | null; createdAt: string | null; qos: string | null;
  owner: Ref | null; workload: Ref | null; ip: string | null;
  cpu: number | null; memory: number | null; cpuRequest: number | null; cpuLimit: number | null; memRequest: number | null; memLimit: number | null;
  containers: ContainerBrief[];
}
export interface WorkloadSummary {
  uid: string; kind: string; name: string; namespace: string; desired: number; ready: number; available: number; updated: number | null;
  images: string[]; createdAt: string | null; pods: number; level: Level; message: string | null;
  cpu: number | null; memory: number | null; cpuRequest: number | null; cpuLimit: number | null; memRequest: number | null; memLimit: number | null;
  restarts: number; job?: { active: number; succeeded: number; failed: number; completions: number | null };
}
export interface NodeSummary {
  name: string; ready: boolean; status: string; level: Level; roles: string[]; unschedulable: boolean; pressure: string[];
  kubelet: string | null; os: string | null; arch: string | null; runtime: string | null; kernel: string | null; osImage: string | null; internalIP: string | null;
  cpuCapacity: number | null; cpuAllocatable: number | null; memCapacity: number | null; memAllocatable: number | null; podsCapacity: number | null;
  pods: number; cpuUsage: number | null; memUsage: number | null; cpuRequests: number; memRequests: number; cpuLimits: number; memLimits: number;
  conditions: { type: string; status: string; reason: string | null; message: string | null }[]; taints: string[]; createdAt: string | null;
}
export interface NamespaceSummary { name: string; phase: string; createdAt: string | null }
export interface EventItem {
  type: string; reason: string; message: string; kind: string; name: string; namespace: string | null; count: number;
  firstAt: string | null; lastAt: string | null; source: string | null;
}
export interface ClusterInfo { name: string; version: string | null; platform: string | null; source: 'kubernetes' | 'dynatrace'; url: string | null }

export interface Snapshot {
  at: number;
  cluster: ClusterInfo;
  nodes: NodeSummary[];
  namespaces: NamespaceSummary[];
  pods: PodSummary[];
  workloads: WorkloadSummary[];
  events: EventItem[];
  metricsAvailable: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ quantities */

const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Parses a Kubernetes quantity ("250m", "1.5", "128Mi", "1e3", "12345n") into a plain number of base units. */
export function parseQuantity(q: unknown): number | null {
  if (q == null) return null;
  if (typeof q === 'number') return Number.isFinite(q) ? q : null;
  const s = String(q).trim();
  const m = /^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suf = m[2];
  if (suf in BIN) return n * BIN[suf];
  if (suf in DEC) return n * DEC[suf];
  return null;
}
export const cpuMillis = (q: unknown) => { const v = parseQuantity(q); return v == null ? null : v * 1000; };
export const memBytes = (q: unknown) => parseQuantity(q);

const sumOrNull = (vals: (number | null)[]) => (vals.some((v) => v == null) || !vals.length ? null : vals.reduce<number>((a, b) => a + (b as number), 0));

/** Pod-level requests/limits = sum over app containers (limits are null when any container is unbounded). */
export function podResources(spec: any) {
  const cs: any[] = spec?.containers ?? [];
  const req = (k: string, f: (q: unknown) => number | null) => cs.reduce((a, c) => a + (f(c.resources?.requests?.[k]) ?? 0), 0);
  return {
    cpuRequest: cs.length ? req('cpu', cpuMillis) || null : null,
    memRequest: cs.length ? req('memory', memBytes) || null : null,
    cpuLimit: sumOrNull(cs.map((c) => cpuMillis(c.resources?.limits?.cpu))),
    memLimit: sumOrNull(cs.map((c) => memBytes(c.resources?.limits?.memory))),
  };
}

/* ------------------------------------------------------------------ pod status */

const FAIL_REASONS = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|InvalidImageName|CreateContainerConfigError|CreateContainerError|RunContainerError|OOMKilled|Error|Failed|Evicted|Unschedulable|DeadlineExceeded|BackoffLimitExceeded|ContainerStatusUnknown/;

/** kubectl-style display status ("CrashLoopBackOff", "OOMKilled", "Init:0/1", "Pending (Unschedulable)", …). */
export function podStatus(pod: any): { status: string; level: Level } {
  const st = pod.status ?? {};
  let reason: string = st.reason || st.phase || 'Unknown';
  const initStatuses: any[] = st.initContainerStatuses ?? [];
  let initializing = false;
  initStatuses.forEach((c, i) => {
    if (initializing) return;
    const t = c.state?.terminated;
    if (t && t.exitCode === 0) return;
    if (t) { reason = t.reason ? `Init:${t.reason}` : `Init:ExitCode:${t.exitCode}`; initializing = true; return; }
    const w = c.state?.waiting;
    if (w?.reason && w.reason !== 'PodInitializing') { reason = `Init:${w.reason}`; initializing = true; return; }
    reason = `Init:${i}/${initStatuses.length}`;
    initializing = true;
  });
  if (!initializing) {
    let hasRunning = false;
    for (const c of [...(st.containerStatuses ?? [])].reverse()) {
      if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
      else if (c.state?.terminated?.reason) reason = c.state.terminated.reason;
      else if (c.state?.terminated) reason = c.state.terminated.signal ? `Signal:${c.state.terminated.signal}` : `ExitCode:${c.state.terminated.exitCode}`;
      else if (c.ready && c.state?.running) hasRunning = true;
    }
    if (reason === 'Completed' && hasRunning) reason = 'Running';
  }
  if (st.phase === 'Pending' && reason === 'Pending') {
    const sched = (st.conditions ?? []).find((c: any) => c.type === 'PodScheduled');
    if (sched?.status === 'False' && sched.reason) reason = `Pending (${sched.reason})`;
  }
  if (pod.metadata?.deletionTimestamp) reason = st.reason === 'NodeLost' ? 'Unknown' : 'Terminating';

  const total = (st.containerStatuses ?? []).length || (pod.spec?.containers ?? []).length;
  const ready = (st.containerStatuses ?? []).filter((c: any) => c.ready).length;
  let level: Level = 'ok';
  if (st.phase === 'Succeeded' || reason === 'Completed') level = 'done';
  else if (FAIL_REASONS.test(reason) || st.phase === 'Failed') level = 'fail';
  else if (reason === 'Running' && ready < total) level = 'warn';
  else if (reason !== 'Running') level = 'warn';
  return { status: reason, level };
}

/* ------------------------------------------------------------------ masking */

export const MASK = '••••••••';
const SECRET_NAME = /(pass(word|wd|phrase)?|pwd|secret|token|api[-_.]?key|apikey|access[-_.]?key|private[-_.]?key|client[-_.]?key|credential|creds?\b|auth|cookie|session[-_.]?key|signature|signing|salt|\bdsn\b|conn(ection)?[-_.]?str|jdbc[-_.]?url|database[-_.]?url|db[-_.]?url|webhook)/i;
const JWT = /^eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*$/;
const KNOWN_TOKEN = /^(sk|pk|rk)[-_](live|test)?[-_]?[A-Za-z0-9]{12,}|^gh[pousr]_[A-Za-z0-9]{20,}|^glpat-[\w-]{16,}|^xox[abpors]-[\w-]{10,}|^AKIA[0-9A-Z]{16}$|^AIza[\w-]{30,}|^dt0c01\.[\w.]+/;
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s]+)@/gi;

/** True when a value looks like a credential regardless of its name (JWT, PEM, vendor tokens, long random strings). */
export function looksLikeCredential(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (s.includes('-----BEGIN')) return true;
  if (JWT.test(s) || KNOWN_TOKEN.test(s)) return true;
  if (s.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s) && !/^[0-9a-f]{40}$/i.test(s) /* git sha */) return true;
  return false;
}
export const redactUrlCredentials = (s: string) => s.replace(URL_CREDS, `$1${MASK}@`);

/** Masks a literal value given its key name; returns the shown value and whether it was masked. */
export function maskValue(name: string, value: string): { value: string; masked: boolean } {
  if (SECRET_NAME.test(name) || looksLikeCredential(value)) return { value: MASK, masked: true };
  const red = redactUrlCredentials(value);
  return { value: red, masked: red !== value };
}

/** Redacts credentials embedded in command lines / log lines (key=value, --flag=value, URL user:pass@). */
export function redactText(s: string): string {
  return redactUrlCredentials(s)
    .replace(/((?:--?|\b)[\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|credential)[\w.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1${MASK}`)
    .replace(/\b(authorization\s*:\s*(?:bearer|basic|api-token)\s+)[^\s"']+/gi, `$1${MASK}`)
    .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]+/g, MASK);
}

export function maskArgs(list: string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  const out: string[] = [];
  let maskNext = false;
  for (const a of list) {
    if (maskNext) { out.push(MASK); maskNext = false; continue; }
    if (/^--?[\w.-]*(pass(word)?|pwd|secret|token|api[-_]?key|credential)[\w.-]*$/i.test(a)) { out.push(a); maskNext = true; continue; }
    out.push(looksLikeCredential(a) ? MASK : redactText(a));
  }
  return out;
}

/** Annotations: drop last-applied-configuration (it embeds literal env values) and mask credential-like entries. */
export function maskAnnotations(a: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a ?? {})) {
    if (k === 'kubectl.kubernetes.io/last-applied-configuration') { out[k] = '(hidden — may embed configuration values)'; continue; }
    const m = maskValue(k.split('/').pop() ?? k, String(v));
    out[k] = m.value.length > 2000 ? m.value.slice(0, 2000) + '…' : m.value;
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

export const nodeRoles = (labels: Record<string, string> = {}) => {
  const roles = Object.keys(labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1] || labels[k]).filter(Boolean);
  if (!roles.length && labels['kubernetes.io/role']) roles.push(labels['kubernetes.io/role']);
  return roles.length ? roles : ['worker'];
};

export const levelOrder: Record<Level, number> = { fail: 0, warn: 1, ok: 2, done: 3 };
