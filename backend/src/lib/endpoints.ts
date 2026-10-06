/**
 * Endpoint normalization: collapse dynamic path segments so that
 * GET /api/v1/merchant/12345 and GET /api/v1/merchant/98765 are one endpoint
 * (GET /api/v1/merchant/{id}).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const HEX_LONG = /^[0-9a-f]{12,}$/i;
const MIXED_TOKEN = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/; // long tokens containing digits (ids, hashes)
const EMAIL = /^[^@/\s]+@[^@/\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const PREFIXED_ID = /^[A-Za-z]{2,6}[-_]\d[\dA-Za-z-]{3,}$/; // e.g. TXN-0001234, PF-2026-10-06-000127

export function normalizeSegment(seg: string): string {
  if (!seg) return seg;
  let s: string;
  try { s = decodeURIComponent(seg); } catch { s = seg; }
  if (s.startsWith('{') && s.endsWith('}')) return s;
  if (NUMERIC.test(s) || UUID.test(s) || HEX_LONG.test(s) || MIXED_TOKEN.test(s) || EMAIL.test(s) || DATE.test(s) || PREFIXED_ID.test(s)) return '{id}';
  return seg;
}

export function normalizePath(rawUrl: string): string {
  let path = rawUrl.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch { /* keep raw */ }
  path = path.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = '/' + path;
  const norm = path.split('/').map(normalizeSegment).join('/');
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

const METHOD_LABEL = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;

/**
 * Derive {method, path} from a raw sample. Prefers the URL column; falls back to
 * labels shaped like "POST /api/v1/payment". Returns null when no endpoint can be inferred.
 */
export function inferEndpoint(label: string, url?: string | null, method?: string | null): { method: string; path: string } | null {
  if (url && /^(https?:\/\/|\/)/i.test(url)) {
    const lm = METHOD_LABEL.exec(label);
    return { method: (method || lm?.[1] || 'GET').toUpperCase(), path: normalizePath(url) };
  }
  const m = METHOD_LABEL.exec(label);
  if (m) return { method: m[1].toUpperCase(), path: normalizePath(m[2]) };
  return null;
}
