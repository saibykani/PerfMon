/** Thin API client. All features go through the backend REST API (/api/v1). */
export interface ApiErrorBody { timestamp: string; status: number; error: string; message: string; path: string; details?: unknown }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

/**
 * API origin. Empty = same origin (Docker/nginx or Vite dev proxy).
 * Set VITE_API_BASE_URL (e.g. https://perfmon-api.example.com) when the UI is hosted
 * separately (e.g. Vercel) — and add the UI origin to the backend's CORS_ORIGINS.
 */
export const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/$/, '');

const TOKEN_KEY = 'perfmon.token';
export const tokenStore = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

type Query = Record<string, string | number | boolean | null | undefined | string[]>;
export function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  // Abort hung requests (e.g. backend down behind a proxy) instead of waiting indefinitely.
  const ctrl = new AbortController();
  const timeoutMs = body instanceof FormData ? 10 * 60_000 : opts.raw ? 120_000 : path === '/health' ? 6_000 : 25_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}${qs(opts.query)}`, { method, headers, body: payload, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError(504, 'TIMEOUT', `The Perfmon API did not respond within ${Math.round(timeoutMs / 1000)}s. The backend may be down or overloaded.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && !path.startsWith('/auth/login')) onUnauthorized?.();
  if (!res.ok) {
    let err: ApiErrorBody | null = null;
    try { err = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, err?.error ?? 'HTTP_ERROR', err?.message ?? `${res.status} ${res.statusText}`, err?.details);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>('POST', path, body ?? {}, { query }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', path, undefined, { query }),
  raw: (path: string, query?: Query) => request<Response>('GET', path, undefined, { query, raw: true }),
};

/** Authenticated file download (uses fetch so the JWT header is sent). */
export async function download(path: string, fallbackName = 'download') {
  const res = await api.raw(path);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
