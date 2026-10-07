import type { Credentials, IntegrationRecord, TestResult } from './types.js';

export const TIMEOUT_MS = 10_000;

export class ConnectorError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

/** Joins a base URL and a path without double slashes. */
export function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

export function requireUrl(i: IntegrationRecord, fallback?: string): string {
  const url = (i.url || fallback || '').trim();
  if (!url) throw new ConnectorError('Integration URL is not configured');
  if (!/^https?:\/\//i.test(url)) throw new ConnectorError('Integration URL must start with http:// or https://');
  return url.replace(/\/+$/, '');
}

export const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/** Generic auth header from the integration's auth type (connectors may override). */
export function authHeaders(i: IntegrationRecord, c: Credentials, tokenScheme = 'Bearer'): Record<string, string> {
  if (i.authType === 'TOKEN' && c.token) return { authorization: `${tokenScheme} ${c.token}` };
  if (i.authType === 'API_KEY' && (c.apiKey || c.token)) return { authorization: `${tokenScheme} ${c.apiKey || c.token}` };
  if (i.authType === 'BASIC' && c.username) return { authorization: basic(c.username, c.password ?? c.apiToken ?? '') };
  return {};
}

/** Human-readable reason for a network failure (unreachable host, DNS, TLS, timeout). Never includes credentials. */
export function describeFetchError(e: unknown): string {
  const err = e as any;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `Connection timed out after ${TIMEOUT_MS / 1000}s`;
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED') return 'Connection refused (host reachable but nothing is listening on that port)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found (DNS lookup failed)';
  if (code === 'ECONNRESET') return 'Connection reset by peer';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Connection timed out';
  if (typeof code === 'string' && /CERT|SSL|TLS/i.test(code)) return `TLS error (${code})`;
  if (err instanceof ConnectorError) return err.message;
  return String(err?.message ?? err).slice(0, 300);
}

export interface HttpResult { status: number; ok: boolean; text: string; json: any; headers: Headers }

/** fetch with a hard timeout (≤10s); throws ConnectorError on network failure, returns the response otherwise. */
export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(Math.min(init.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS)) });
  } catch (e) {
    throw new ConnectorError(describeFetchError(e));
  }
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, text, json, headers: res.headers };
}

export function statusMessage(r: HttpResult, what: string) {
  if (r.status === 401 || r.status === 403) return `${what}: authentication failed (HTTP ${r.status}) — check the credentials`;
  if (r.status === 404) return `${what}: endpoint not found (HTTP 404) — check the URL`;
  const detail = (r.json?.message ?? r.json?.error ?? r.text ?? '').toString().replace(/\s+/g, ' ').slice(0, 200);
  return `${what}: HTTP ${r.status}${detail ? ` — ${detail}` : ''}`;
}

/** Runs a connectivity probe and converts it into a TestResult (never throws). */
export async function probe(fn: () => Promise<{ message: string; details?: unknown }>): Promise<TestResult> {
  const t0 = performance.now();
  try {
    const { message, details } = await fn();
    return { ok: true, latencyMs: Math.round(performance.now() - t0), message, details };
  } catch (e) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), message: describeFetchError(e) };
  }
}

/** Expect a 2xx; otherwise throw a descriptive ConnectorError. */
export function expectOk(r: HttpResult, what: string) {
  if (!r.ok) throw new ConnectorError(statusMessage(r, what), r.status);
  return r;
}

/** Derive a server name from common host/instance labels (strips ports). */
export function hostFromLabels(labels: Record<string, string>): string | null {
  const v = labels.host ?? labels.hostname ?? labels['host.name'] ?? labels['dt.entity.host.name'] ?? labels.instance ?? labels.node ?? labels.server ?? null;
  if (!v) return null;
  return v.replace(/:\d+$/, '');
}
