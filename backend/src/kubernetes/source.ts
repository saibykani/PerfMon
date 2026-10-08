import type { FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { principalOf } from '../auth/principal.js';
import { decryptSecret } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { Credentials, IntegrationRecord } from '../integrations/connectors/types.js';
import { normalizePem, type KubeConn } from './kubeClient.js';
import { snapshotDirect } from './directSource.js';
import { snapshotDynatrace, type DtConn } from './dynatraceSource.js';
import type { Snapshot } from './model.js';

/** A Kubernetes data source resolved from an integration: the API server directly, or Dynatrace. */
export type Conn =
  | { kind: 'direct'; id: string; name: string; projectId: string | null; config: Record<string, any>; version: string; kube: KubeConn }
  | { kind: 'dynatrace'; id: string; name: string; projectId: string | null; config: Record<string, any>; version: string; dt: DtConn };

export const K8S_TYPES = ['KUBERNETES', 'DYNATRACE'] as const;

export const truthy = (v: unknown) => v === true || /^(true|1|yes|on)$/i.test(String(v ?? ''));
export const splitList = (v: unknown) => String(v ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 25);

export function kubeConnFrom(i: IntegrationRecord, c: Credentials): KubeConn {
  const url = (i.url ?? '').trim().replace(/\/+$/, '');
  if (!url) throw badRequest('API server URL is not configured');
  if (!/^https?:\/\//i.test(url)) throw badRequest('API server URL must start with https:// (or http:// for a local proxy)');
  const token = (c.token ?? c.bearerToken ?? '').trim();
  if (!token) throw badRequest('Bearer token is not configured (credential "token")');
  return {
    id: i.id, url, token, ca: normalizePem(c.caCert ?? c.ca), skipTls: truthy(i.config?.skipTlsVerify),
    namespaces: splitList(i.config?.namespaces), clusterName: String(i.config?.clusterName ?? '').trim() || i.name,
  };
}

export function dtConnFrom(i: IntegrationRecord, c: Credentials): DtConn {
  const url = (i.url ?? '').trim().replace(/\/+$/, '');
  if (!url) throw badRequest('Dynatrace environment URL is not configured');
  const token = c.apiToken || c.token || c.apiKey || '';
  if (!token) throw badRequest('Dynatrace API token is not configured (credential "apiToken")');
  const cluster = String(i.config?.k8sCluster ?? '').trim() || null;
  return { id: i.id, url, token, cluster, clusterName: cluster ?? i.name };
}

async function loadCredentials(id: string): Promise<Credentials> {
  const rows = await query(`SELECT name, ciphertext FROM integration_credentials WHERE integration_id = $1`, [id]);
  const out: Credentials = {};
  for (const r of rows) { try { out[r.name] = decryptSecret(r.ciphertext); } catch { /* rotated key: treat as missing */ } }
  return out;
}

export const toRecord = (r: any): IntegrationRecord => ({ id: r.id, organizationId: r.organization_id, projectId: r.project_id, name: r.name, type: r.type, url: r.url, authType: r.auth_type, config: r.config ?? {} });

export async function connFromRow(row: any): Promise<Conn> {
  const rec = toRecord(row);
  const creds = await loadCredentials(row.id);
  const base = { id: row.id as string, name: row.name as string, projectId: row.project_id as string | null, config: rec.config, version: String(new Date(row.updated_at).getTime()) };
  return row.type === 'KUBERNETES' ? { ...base, kind: 'direct', kube: kubeConnFrom(rec, creds) } : { ...base, kind: 'dynatrace', dt: dtConnFrom(rec, creds) };
}

/** Loads a Kubernetes-capable integration the caller may see (org + API-key project binding). */
export async function loadConn(req: FastifyRequest, id: string): Promise<Conn> {
  const p = principalOf(req);
  const row = await one(`SELECT * FROM integrations WHERE id = $1 AND organization_id = $2`, [id, p.orgId]);
  if (!row || (p.projectId && row.project_id && row.project_id !== p.projectId)) throw notFound('Kubernetes connection', id);
  if (!K8S_TYPES.includes(row.type)) throw badRequest(`Integration ${row.name} is a ${row.type} integration — choose a Kubernetes or Dynatrace connection`);
  if (row.status === 'DISABLED') throw badRequest(`Connection ${row.name} is disabled — enable it in Platform → Integrations`);
  return connFromRow(row);
}

/* ------------------------------------------------------------------ snapshot cache (bounded, in-flight de-duplicated) */

const cache = new Map<string, { version: string; at: number; snap?: Snapshot; pending?: Promise<Snapshot> }>();
const MAX_ENTRIES = 20;

export async function getSnapshot(c: Conn, maxAgeMs = 10_000): Promise<Snapshot> {
  const e = cache.get(c.id);
  if (e && e.version === c.version) {
    if (e.snap && Date.now() - e.at <= maxAgeMs) return e.snap;
    if (e.pending) return e.pending;
  }
  const pending = (c.kind === 'direct' ? snapshotDirect(c.kube) : snapshotDynatrace(c.dt)).then((snap) => {
    cache.set(c.id, { version: c.version, at: Date.now(), snap });
    return snap;
  }).catch((err) => {
    const cur = cache.get(c.id);
    if (cur?.pending === pending) { if (cur.snap) delete cur.pending; else cache.delete(c.id); }
    throw err;
  });
  cache.set(c.id, { version: c.version, at: e?.at ?? 0, snap: e?.version === c.version ? e.snap : undefined, pending });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return pending;
}

export const dropSnapshot = (id: string) => cache.delete(id);
