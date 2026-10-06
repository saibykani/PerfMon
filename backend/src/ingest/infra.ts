import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, bulkInsert } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { principalOf } from '../auth/principal.js';
import { resolveRun } from './runCache.js';
import { selfMetrics } from '../selfmon/registry.js';
import { publishRunEvent } from '../live/hub.js';

const ts = z.union([z.number(), z.string()]);
const n = z.number().nullish();

export const infraPayload = z.object({
  project: z.string().optional(),          // project key or id
  environment: z.string().optional(),      // environment name or id
  runId: z.string().optional(),
  server: z.object({
    name: z.string().min(1).max(200),
    hostname: z.string().max(255).optional(),
    ip: z.string().max(64).optional(),
    os: z.string().max(120).optional(),
    cpuCores: z.number().int().optional(),
    memoryMb: z.number().int().optional(),
    diskGb: z.number().int().optional(),
    role: z.string().max(60).optional(),
  }).optional(),
  service: z.object({ name: z.string().min(1).max(200), kind: z.enum(['loadgen', 'gateway', 'service', 'database', 'cache', 'queue', 'external']).default('service'), technology: z.string().optional() }).optional(),
  metrics: z.array(z.object({
    ts, cpuPct: n, memoryPct: n, memoryUsedMb: n, diskPct: n, diskReadBps: n, diskWriteBps: n, netInBps: n, netOutBps: n,
    loadAvg1m: n, processes: n, tcpConnections: n, fileDescriptors: n,
  })).max(50000).optional(),
  jvm: z.array(z.object({
    ts, heapUsedMb: n, heapCommittedMb: n, heapMaxMb: n, nonHeapUsedMb: n, gcCount: n, gcTimeMs: n, gcMaxPauseMs: n, threadCount: n, peakThreads: n, classesLoaded: n,
  })).max(50000).optional(),
  database: z.array(z.object({
    ts, engine: z.string().optional(), connections: n, activeConnections: n, maxConnections: n, queryLatencyMs: n, slowQueries: n, locks: n, deadlocks: n, cpuPct: n, memoryPct: n, transactionsPerSec: n,
  })).max(50000).optional(),
  serviceMetrics: z.array(z.object({
    ts, requestRate: n, errorRatePct: n, avgLatencyMs: n, p95LatencyMs: n, exceptions: n, cpuPct: n, memoryPct: n,
  })).max(50000).optional(),
});

const toMs = (v: number | string) => (typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : Date.parse(v));

export async function ingestInfrastructure(req: FastifyRequest, body: z.infer<typeof infraPayload>) {
  const p = principalOf(req);
  let projectId: string | null = null;
  let environmentId: string | null = null;
  let runId: string | null = null;

  if (body.runId) {
    const run = await resolveRun(body.runId, p);
    projectId = run.projectId;
    environmentId = run.environmentId;
    runId = run.id;
  } else {
    const projKey = body.project ?? p.projectId;
    if (!projKey) throw badRequest('project (key or id) or runId is required');
    const proj = await one(`SELECT id FROM projects WHERE organization_id = $1 AND (id::text = $2 OR key = $2 OR lower(name) = lower($2))`, [p.orgId, projKey]);
    if (!proj) throw notFound('Project', projKey);
    projectId = proj.id;
    if (body.environment) {
      const env = await one(`SELECT id FROM environments WHERE project_id = $1 AND (id::text = $2 OR lower(name) = lower($2)) ORDER BY created_at LIMIT 1`, [projectId, body.environment]);
      environmentId = env?.id ?? null;
    }
  }

  let serverId: string | null = null;
  if (body.server) {
    const s = body.server;
    const row = await one(
      `INSERT INTO servers (project_id, environment_id, name, hostname, ip_address, os, cpu_cores, memory_mb, disk_gb, role, status, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'HEALTHY',now())
       ON CONFLICT (project_id, name) DO UPDATE SET
         hostname = COALESCE(EXCLUDED.hostname, servers.hostname), ip_address = COALESCE(EXCLUDED.ip_address, servers.ip_address),
         os = COALESCE(EXCLUDED.os, servers.os), cpu_cores = COALESCE(EXCLUDED.cpu_cores, servers.cpu_cores),
         memory_mb = COALESCE(EXCLUDED.memory_mb, servers.memory_mb), disk_gb = COALESCE(EXCLUDED.disk_gb, servers.disk_gb),
         role = COALESCE(EXCLUDED.role, servers.role), environment_id = COALESCE(servers.environment_id, EXCLUDED.environment_id), last_seen_at = now()
       RETURNING id, environment_id`,
      [projectId, environmentId, s.name, s.hostname ?? null, s.ip ?? null, s.os ?? null, s.cpuCores ?? null, s.memoryMb ?? null, s.diskGb ?? null, s.role ?? null]);
    serverId = row.id;
    environmentId ??= row.environment_id;
  }

  let serviceId: string | null = null;
  if (body.service) {
    const row = await one(
      `INSERT INTO services (project_id, environment_id, server_id, name, kind, technology)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, environment_id, name) DO UPDATE SET server_id = COALESCE(EXCLUDED.server_id, services.server_id) RETURNING id`,
      [projectId, environmentId, serverId, body.service.name, body.service.kind, body.service.technology ?? null]);
    serviceId = row.id;
  }

  // Correlate to the active run of the environment when no run was given
  const resolveRunFor = async (t: number) => {
    if (runId) return runId;
    if (!environmentId) return null;
    const r = await one(`SELECT id FROM test_runs WHERE environment_id = $1 AND status = 'RUNNING' AND deleted_at IS NULL AND (started_at IS NULL OR started_at <= $2) ORDER BY started_at DESC NULLS LAST LIMIT 1`, [environmentId, new Date(t)]);
    return r?.id ?? null;
  };
  const firstTs = [...(body.metrics ?? []), ...(body.jvm ?? []), ...(body.database ?? []), ...(body.serviceMetrics ?? [])].map((m) => toMs(m.ts)).filter(Number.isFinite)[0] ?? Date.now();
  const correlatedRun = await resolveRunFor(firstTs);

  let count = 0;
  if (body.metrics?.length) {
    if (!serverId) throw badRequest('server is required for server metrics');
    const rows = body.metrics.map((m) => [new Date(toMs(m.ts)), serverId, correlatedRun, m.cpuPct, m.memoryPct, m.memoryUsedMb, m.diskPct, m.diskReadBps, m.diskWriteBps, m.netInBps, m.netOutBps, m.loadAvg1m, m.processes, m.tcpConnections, m.fileDescriptors]);
    for (let i = 0; i < rows.length; i += 2000) {
      const [sql, params] = bulkInsert('server_metrics', ['ts', 'server_id', 'run_id', 'cpu_pct', 'memory_pct', 'memory_used_mb', 'disk_pct', 'disk_read_bps', 'disk_write_bps', 'net_in_bps', 'net_out_bps', 'load_avg_1m', 'processes', 'tcp_connections', 'file_descriptors'], rows.slice(i, i + 2000));
      await query(sql, params);
    }
    const last = body.metrics[body.metrics.length - 1];
    const status = (last.cpuPct ?? 0) >= 90 || (last.memoryPct ?? 0) >= 95 ? 'CRITICAL' : (last.cpuPct ?? 0) >= 75 || (last.memoryPct ?? 0) >= 85 ? 'WARNING' : 'HEALTHY';
    await query(`UPDATE servers SET status = $2, last_seen_at = now() WHERE id = $1`, [serverId, status]);
    count += rows.length;
  }
  if (body.jvm?.length) {
    const rows = body.jvm.map((m) => [new Date(toMs(m.ts)), serverId, serviceId, correlatedRun, m.heapUsedMb, m.heapCommittedMb, m.heapMaxMb, m.nonHeapUsedMb, m.gcCount, m.gcTimeMs, m.gcMaxPauseMs, m.threadCount, m.peakThreads, m.classesLoaded]);
    for (let i = 0; i < rows.length; i += 2000) {
      const [sql, params] = bulkInsert('jvm_metrics', ['ts', 'server_id', 'service_id', 'run_id', 'heap_used_mb', 'heap_committed_mb', 'heap_max_mb', 'nonheap_used_mb', 'gc_count', 'gc_time_ms', 'gc_max_pause_ms', 'thread_count', 'peak_threads', 'classes_loaded'], rows.slice(i, i + 2000));
      await query(sql, params);
    }
    count += rows.length;
  }
  if (body.database?.length) {
    const rows = body.database.map((m) => [new Date(toMs(m.ts)), serviceId, serverId, correlatedRun, m.engine ?? null, m.connections, m.activeConnections, m.maxConnections, m.queryLatencyMs, m.slowQueries, m.locks, m.deadlocks, m.cpuPct, m.memoryPct, m.transactionsPerSec]);
    for (let i = 0; i < rows.length; i += 2000) {
      const [sql, params] = bulkInsert('database_metrics', ['ts', 'service_id', 'server_id', 'run_id', 'db_engine', 'connections', 'active_connections', 'max_connections', 'query_latency_ms', 'slow_queries', 'locks', 'deadlocks', 'cpu_pct', 'memory_pct', 'transactions_per_sec'], rows.slice(i, i + 2000));
      await query(sql, params);
    }
    count += rows.length;
  }
  if (body.serviceMetrics?.length) {
    if (!serviceId) throw badRequest('service is required for serviceMetrics');
    const rows = body.serviceMetrics.map((m) => [new Date(toMs(m.ts)), serviceId, correlatedRun, m.requestRate, m.errorRatePct, m.avgLatencyMs, m.p95LatencyMs, m.exceptions, m.cpuPct, m.memoryPct]);
    for (let i = 0; i < rows.length; i += 2000) {
      const [sql, params] = bulkInsert('service_metrics', ['ts', 'service_id', 'run_id', 'request_rate', 'error_rate_pct', 'avg_latency_ms', 'p95_latency_ms', 'exceptions', 'cpu_pct', 'memory_pct'], rows.slice(i, i + 2000));
      await query(sql, params);
    }
    const last = body.serviceMetrics[body.serviceMetrics.length - 1];
    const health = (last.errorRatePct ?? 0) >= 5 ? 'CRITICAL' : (last.errorRatePct ?? 0) >= 1 ? 'WARNING' : 'HEALTHY';
    await query(`UPDATE services SET health_status = $2 WHERE id = $1`, [serviceId, health]);
    count += rows.length;
  }
  selfMetrics.inc('ingest_infra_points', count);
  if (correlatedRun) publishRunEvent(correlatedRun, 'infra', { serverId, serviceId });
  return { accepted: count, serverId, serviceId, runId: correlatedRun };
}
