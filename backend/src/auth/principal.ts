import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { API_KEY_SCOPES, type Permission } from './rbac.js';

export interface Principal {
  kind: 'user' | 'api_key';
  id: string;            // user id or api key id
  orgId: string;
  email?: string;
  name: string;
  roles: string[];
  permissions: Set<Permission>;
  projectId?: string | null;   // api keys may be bound to one project
  rateLimitPerSec?: number | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** `remember` ("Keep me signed in") issues a longer-lived session (JWT_REMEMBER_EXPIRES_IN, default 30 days). */
export function signToken(userId: string, orgId: string, remember = false) {
  const jti = randomUUID();
  const expiresIn = remember ? config.jwtRememberExpiresIn : config.jwtExpiresIn;
  const token = jwt.sign({ sub: userId, org: orgId, jti }, config.jwtSecret, { expiresIn: expiresIn as any, issuer: 'perfmon' });
  const decoded = jwt.decode(token) as { exp: number };
  return { token, jti, expiresAt: new Date(decoded.exp * 1000) };
}

// short cache so role changes take effect quickly without hitting the DB on every request
const userCache = new Map<string, { at: number; p: Principal }>();
export const invalidateUserCache = (userId?: string) => (userId ? userCache.delete(userId) : userCache.clear());

async function loadUserPrincipal(userId: string): Promise<Principal | null> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.at < 30000) return cached.p;
  const u = await one(`SELECT id, organization_id, email, name, is_active FROM users WHERE id = $1`, [userId]);
  if (!u || !u.is_active) return null;
  const rows = await query(
    `SELECT r.name AS role, p.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`, [userId]);
  const p: Principal = {
    kind: 'user', id: u.id, orgId: u.organization_id, email: u.email, name: u.name,
    roles: [...new Set(rows.map((r) => r.role as string))],
    permissions: new Set(rows.map((r) => r.code).filter(Boolean)),
  };
  userCache.set(userId, { at: Date.now(), p });
  return p;
}

async function loadApiKeyPrincipal(secret: string): Promise<Principal | null> {
  const k = await one(
    `SELECT id, organization_id, project_id, name, scopes, rate_limit_per_sec FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [sha256(secret)]);
  if (!k) return null;
  query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [k.id]).catch(() => undefined);
  const perms = new Set<Permission>();
  for (const s of k.scopes as string[]) for (const p of API_KEY_SCOPES[s] ?? []) perms.add(p);
  return { kind: 'api_key', id: k.id, orgId: k.organization_id, name: `API key: ${k.name}`, roles: [], permissions: perms, projectId: k.project_id, rateLimitPerSec: k.rate_limit_per_sec };
}

const revokedCache = new Map<string, number>();
async function isRevoked(jti: string) {
  if (revokedCache.has(jti)) return true;
  const r = await one(`SELECT 1 FROM revoked_tokens WHERE jti = $1`, [jti]);
  if (r) revokedCache.set(jti, Date.now());
  return !!r;
}
export const markRevoked = (jti: string) => revokedCache.set(jti, Date.now());

/** Extract credentials from Authorization (Bearer JWT, Bearer/Token API key), X-API-Key, or ?access_token (SSE only). */
export async function resolvePrincipal(req: FastifyRequest): Promise<Principal | null> {
  const auth = req.headers.authorization;
  let bearer: string | undefined;
  if (auth) {
    const m = /^(Bearer|Token)\s+(.+)$/i.exec(auth);
    if (m) bearer = m[2].trim();
  }
  const headerKey = req.headers['x-api-key'];
  const apiKey = typeof headerKey === 'string' ? headerKey : bearer?.startsWith('pmk_') ? bearer : undefined;
  if (apiKey) return loadApiKeyPrincipal(apiKey);

  let token = bearer;
  // EventSource cannot set headers: allow token in query for streaming endpoints only.
  if (!token && req.url.includes('/stream')) token = (req.query as any)?.access_token;
  // InfluxDB compatibility: JMeter influx listener can pass the API key as ?p= or u/p params
  if (!token && req.url.includes('/influx/')) {
    const q = req.query as any;
    const k = q?.apiKey || q?.p || q?.token;
    if (k?.startsWith?.('pmk_')) return loadApiKeyPrincipal(k);
  }
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'perfmon' }) as { sub: string; jti: string };
    if (await isRevoked(payload.jti)) return null;
    return loadUserPrincipal(payload.sub);
  } catch {
    return null;
  }
}

export function requireAuth() {
  return async (req: FastifyRequest) => {
    if (!req.principal) throw unauthorized();
  };
}

export function requirePermission(...perms: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.principal) throw unauthorized();
    const missing = perms.filter((p) => !req.principal!.permissions.has(p));
    if (missing.length) throw forbidden(`Missing permission: ${missing.join(', ')}`);
  };
}

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}
