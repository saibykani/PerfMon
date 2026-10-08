import { createHash } from 'node:crypto';
import { Agent, fetch as ufetch } from 'undici';

/**
 * Minimal read-only Kubernetes API client.
 *
 * Uses undici's fetch with a per-connection Agent so a custom CA bundle (or "skip TLS
 * verification") applies only to that cluster. Every call has a hard timeout and a response
 * size cap. Errors are translated into actionable messages (401/403 → which permission is
 * missing, TLS failures, unreachable hosts). The bearer token is never logged or echoed.
 */

export interface KubeConn {
  id: string;
  url: string;
  token: string;
  ca?: string;              // PEM bundle (already normalized)
  skipTls: boolean;
  namespaces: string[];     // allow-list ([] = all namespaces)
  clusterName: string;
}

export class KubeError extends Error {
  constructor(message: string, public status?: number, public kind: 'auth' | 'forbidden' | 'notfound' | 'tls' | 'network' | 'timeout' | 'http' | 'size' = 'http') { super(message); }
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

/** Accepts a PEM bundle, a PEM pasted into a single-line input (newlines stripped), or base64 PEM (kubeconfig `certificate-authority-data`). */
export function normalizePem(input: string | undefined | null): string | undefined {
  let s = (input ?? '').trim();
  if (!s) return undefined;
  if (!s.includes('-----BEGIN')) {
    const dec = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (!dec.includes('-----BEGIN')) throw new KubeError('CA certificate must be a PEM certificate (-----BEGIN CERTIFICATE-----) or its base64 form (kubeconfig certificate-authority-data)');
    s = dec.trim();
  }
  const blocks = [...s.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)].map((m) => {
    const body = m[2].replace(/\s+/g, '');
    return `-----BEGIN ${m[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${m[1]}-----`;
  });
  if (!blocks.length) throw new KubeError('CA certificate could not be parsed (expected -----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----)');
  return blocks.join('\n') + '\n';
}

// One Agent per connection (keyed by URL + TLS settings) so connections are reused; replaced when settings change.
const agents = new Map<string, { key: string; agent: Agent }>();
function agentFor(c: KubeConn): Agent {
  const key = createHash('sha256').update(`${c.url}|${c.skipTls}|${c.ca ?? ''}`).digest('hex');
  const cur = agents.get(c.id);
  if (cur?.key === key) return cur.agent;
  if (cur) cur.agent.close().catch(() => undefined);
  const agent = new Agent({
    connect: { ca: c.ca, rejectUnauthorized: !c.skipTls, timeout: 8_000 },
    headersTimeout: DEFAULT_TIMEOUT, bodyTimeout: DEFAULT_TIMEOUT * 2, connections: 6, keepAliveTimeout: 30_000,
  });
  agents.set(c.id, { key, agent });
  if (agents.size > 50) { const [k, v] = agents.entries().next().value!; v.agent.close().catch(() => undefined); agents.delete(k); }
  return agent;
}
export function dropAgent(id: string) { const a = agents.get(id); if (a) { a.agent.close().catch(() => undefined); agents.delete(id); } }

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME/i;

function describeNetworkError(e: unknown, timeoutMs: number): KubeError {
  const err = e as any;
  if (err instanceof KubeError) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new KubeError(`Kubernetes API did not answer within ${Math.round(timeoutMs / 1000)}s`, undefined, 'timeout');
  let c = err;
  let code: string | undefined;
  for (let i = 0; i < 4 && c; i++) { code = c.code ?? code; if (c.code && c.code !== 'UND_ERR_SOCKET') break; c = c.cause; }
  const msg = String(err?.cause?.message ?? err?.message ?? err);
  if ((code && TLS_CODES.test(code)) || /certificate|self.signed|altname/i.test(msg)) {
    return new KubeError(`TLS verification failed (${code ?? msg.slice(0, 120)}). Paste the cluster CA certificate into the connection, or enable "Skip TLS verification" for test clusters.`, undefined, 'tls');
  }
  if (code === 'ECONNREFUSED') return new KubeError('Connection refused: the API server host is reachable but nothing listens on that port', undefined, 'network');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new KubeError('API server host not found (DNS lookup failed)', undefined, 'network');
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return new KubeError('Connection to the API server timed out — is it reachable from the Perfmon backend (firewall / private network)?', undefined, 'network');
  if (code === 'ECONNRESET') return new KubeError('Connection reset by the API server (wrong port or protocol? the URL must be https://<host>:<port>)', undefined, 'network');
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new KubeError('API server host unreachable', undefined, 'network');
  return new KubeError(`Kubernetes API request failed: ${msg.slice(0, 200)}`, undefined, 'network');
}

/** Turns a Kubernetes Status body into a short, actionable message. */
function describeStatus(status: number, body: any, path: string): KubeError {
  const k8sMsg: string = typeof body?.message === 'string' ? body.message : '';
  if (status === 401) return new KubeError('Kubernetes API rejected the token (HTTP 401): the bearer token is invalid, expired or belongs to a deleted ServiceAccount', 401, 'auth');
  if (status === 403) {
    // e.g. pods is forbidden: User "system:serviceaccount:x:y" cannot list resource "pods" in API group "" at the cluster scope
    const m = /cannot (\w+) resource "([^"]+)"(?: in API group "([^"]*)")?(?: in the namespace "([^"]+)"| at the cluster scope)?/.exec(k8sMsg);
    const what = m ? `${m[1]} ${m[3] ? `${m[3]}/` : ''}${m[2]}${m[4] ? ` in namespace ${m[4]}` : ' (cluster-wide)'}` : path;
    return new KubeError(`Token lacks permission: ${what}. Add it to the Perfmon ClusterRole (see the Kubernetes monitoring guide).`, 403, 'forbidden');
  }
  if (status === 404) return new KubeError(`Not found (HTTP 404): ${k8sMsg || path}`, 404, 'notfound');
  return new KubeError(`Kubernetes API HTTP ${status}${k8sMsg ? ` — ${k8sMsg.slice(0, 200)}` : ''}`, status, 'http');
}

export interface GetOpts { timeoutMs?: number; maxBytes?: number; text?: boolean }

export async function kubeGet<T = any>(c: KubeConn, path: string, opts: GetOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const url = c.url.replace(/\/+$/, '') + path;
  let res: Awaited<ReturnType<typeof ufetch>>;
  try {
    res = await ufetch(url, {
      dispatcher: agentFor(c),
      headers: { authorization: `Bearer ${c.token}`, accept: opts.text ? 'text/plain, */*' : 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
  } catch (e) {
    throw describeNetworkError(e, timeoutMs);
  }
  // stream the body with a size cap
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    if (res.body) {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          if (!opts.text) throw new KubeError(`Response from ${path.split('?')[0]} exceeds ${Math.round(maxBytes / 1048576)} MB — narrow the namespace allow-list`, undefined, 'size');
          truncated = true;
          break;
        }
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (e) {
    if (e instanceof KubeError) throw e;
    throw describeNetworkError(e, timeoutMs);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (res.status >= 300) {
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    if (res.status >= 300 && res.status < 400) throw new KubeError(`API server redirected (HTTP ${res.status}) — use the API server URL (https://<host>:6443), not a dashboard or proxy login page`, res.status);
    throw describeStatus(res.status, body, path.split('?')[0]);
  }
  if (opts.text) return (truncated ? text + '\n… (truncated)' : text) as any;
  try { return JSON.parse(text) as T; } catch { throw new KubeError(`Unexpected non-JSON response from ${path.split('?')[0]} — is the URL the Kubernetes API server?`); }
}
