import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { one } from '../db/pool.js';
import { forbidden, notFound } from './errors.js';
import { principalOf } from '../auth/principal.js';

export type App = ReturnType<FastifyInstance['withTypeProvider']> & FastifyInstance;
export const typed = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();

export const uuid = z.string().uuid();
export const idParams = z.object({ id: z.string().uuid() });

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().optional(),
};

export function paged<T>(rows: (T & { __total?: number })[], page: number, pageSize: number) {
  const total = rows.length ? Number((rows[0] as any).__total ?? rows.length) : 0;
  return { items: rows.map(({ __total, ...r }: any) => r as T), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

/** Safe ORDER BY: whitelist mapping from public sort key to SQL expression. */
export function orderBy(sort: string | undefined, order: 'asc' | 'desc', allowed: Record<string, string>, fallback: string) {
  const col = (sort && allowed[sort]) || fallback;
  return `${col} ${order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
}

/** Ensures a project belongs to the caller's organization (and API-key project binding). */
export async function assertProject(req: FastifyRequest, projectId: string) {
  const p = principalOf(req);
  const row = await one(`SELECT id, organization_id FROM projects WHERE id = $1`, [projectId]);
  if (!row || row.organization_id !== p.orgId) throw notFound('Project', projectId);
  if (p.projectId && p.projectId !== projectId) throw forbidden('API key is not authorized for this project');
  return row;
}

export const csvEscape = (v: unknown) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (rows: Record<string, unknown>[], columns?: string[]) => {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n');
};

export { z };
