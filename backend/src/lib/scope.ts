import type { FastifyReply, FastifyRequest } from 'fastify';
import { principalOf } from '../auth/principal.js';
import type { Permission } from '../auth/rbac.js';
import { badRequest, forbidden, unauthorized } from './errors.js';
import { assertProject } from './http.js';

/** Parse an ISO timestamp or epoch milliseconds. Returns undefined for empty input; throws 400 on garbage. */
export function parseTime(v: string | number | null | undefined): Date | undefined {
  if (v == null || v === '') return undefined;
  const d = typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid timestamp '${v}' (use ISO-8601 or epoch milliseconds)`);
  return d;
}

/** Default time window: [now - days, now]. */
export function timeWindow(from?: string, to?: string, defaultDays = 30) {
  const t = parseTime(to) ?? new Date();
  const f = parseTime(from) ?? new Date(t.getTime() - defaultDays * 86400000);
  if (f > t) throw badRequest('`from` must be before `to`');
  return { from: f, to: t };
}

/** Passes when the caller holds ANY of the permissions. */
export function requireAny(...perms: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.principal) throw unauthorized();
    if (!perms.some((p) => req.principal!.permissions.has(p))) throw forbidden(`Missing permission: one of ${perms.join(', ')}`);
  };
}

/**
 * Effective project filter for list endpoints: validates an explicit projectId against the caller's
 * organization, and applies the API-key project binding when no project was given.
 */
export async function projectFilter(req: FastifyRequest, projectId?: string | null): Promise<string | null> {
  const p = principalOf(req);
  if (projectId) {
    await assertProject(req, projectId);
    return projectId;
  }
  return p.projectId ?? null;
}

/** Escape LIKE/ILIKE wildcards in user input. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Small SQL condition builder with positional parameters. */
export class Conds {
  params: unknown[] = [];
  list: string[] = [];
  constructor(initial: unknown[] = []) { this.params.push(...initial); }
  /** `sql` uses `?` as placeholder for `value` (may appear several times). */
  add(sql: string, value: unknown) {
    this.params.push(value);
    this.list.push(sql.replace(/\?/g, `$${this.params.length}`));
    return this;
  }
  raw(sql: string) { this.list.push(sql); return this; }
  param(value: unknown) { this.params.push(value); return `$${this.params.length}`; }
  where() { return this.list.length ? this.list.join(' AND ') : 'true'; }
}

export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
