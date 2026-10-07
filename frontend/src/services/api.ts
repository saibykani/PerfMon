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

/* ---------- waking up a sleeping / restarting backend ----------
 * Free hosting tiers stop the API after a quiet period and take up to a minute to start again.
 * Instead of failing, requests wait for /health to answer and are then retried once, while the
 * UI shows a "waking up" notice (subscribe with onApiWaking).
 */
const wakeListeners = new Set<(waking: boolean) => void>();
export const onApiWaking = (fn: (waking: boolean) => void) => { wakeListeners.add(fn); return () => { wakeListeners.delete(fn); }; };
let waking: Promise<boolean> | null = null;
const WAKE_MAX_MS = 150_000;

/** Resolves true once the API answers /health (polling for up to ~2.5 minutes). */
export function waitForApi(): Promise<boolean> {
  if (!waking) {
    wakeListeners.forEach((f) => f(true));
    waking = (async () => {
      const start = Date.now();
      while (Date.now() - start < WAKE_MAX_MS) {
        try {
          const r = await fetch(`${API_BASE}/api/v1/health`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
          if (r.ok) return true;
        } catch { /* still starting */ }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      return false;
    })().finally(() => { waking = null; wakeListeners.forEach((f) => f(false)); });
  }
  return waking;
}

const UNAVAILABLE = 'The Perfmon server is not responding right now. It was given 2½ minutes to start — please try again shortly.';

async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; raw?: boolean; retried?: boolean } = {}): Promise<T> {
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
  // Safe to repeat after the server comes back: reads, sign-in, and anything the server never received.
  const idempotent = method === 'GET' || path === '/auth/login';
  const retry = async (reachedServer: boolean): Promise<T> => {
    if (opts.retried || body instanceof FormData || (reachedServer && !idempotent)) throw new ApiError(503, 'UNAVAILABLE', UNAVAILABLE);
    if (!(await waitForApi())) throw new ApiError(503, 'UNAVAILABLE', UNAVAILABLE);
    return request<T>(method, path, body, { ...opts, retried: true });
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}${qs(opts.query)}`, { method, headers, body: payload, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    // network error = request never reached the API; timeout = it may have
    return retry((e as Error).name === 'AbortError');
  } finally {
    clearTimeout(timer);
  }
  // 502/503/504 come from the proxy or the host while the API is starting — the API did not process the request
  if ((res.status === 502 || res.status === 503 || res.status === 504) && !res.headers.get('content-type')?.includes('application/json')) return retry(false);
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
