import type { FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';

export interface AuditEntry {
  action: string;           // e.g. "artifact.upload", "run.delete", "sla.update"
  resourceType: string;
  resourceId?: string | null;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  details?: Record<string, unknown>;
}

/** Writes an audit record. Never throws (audit failure must not break the request), but logs. */
export async function audit(req: FastifyRequest | null, e: AuditEntry) {
  const p = req?.principal;
  try {
    await query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, api_key_id, action, resource_type, resource_id, ip, user_agent, result, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p?.orgId ?? null,
        p?.kind === 'user' ? p.id : null,
        p?.email ?? p?.name ?? null,
        p?.kind === 'api_key' ? p.id : null,
        e.action,
        e.resourceType,
        e.resourceId ?? null,
        req?.ip ?? null,
        (req?.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null,
        e.result ?? 'SUCCESS',
        JSON.stringify(e.details ?? {}),
      ],
    );
  } catch (err) {
    req?.log.error({ err }, 'audit write failed');
  }
}
