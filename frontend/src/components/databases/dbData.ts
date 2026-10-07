import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useFilters } from '@/stores/filters';

/** GET /runs/:id/database (backend/src/runs/analysisRoutes.ts). Each series column also has a `<col>_max` (bucket max). */
export interface DbTarget { id: string; name: string | null; technology: string | null; db_engine: string | null }
export type DbRow = { t: number; service_id: string | null } & Record<string, number | null>;
export interface DbResp { targets: DbTarget[]; step: number; series: DbRow[] }

export const enc = encodeURIComponent;
/** Same query key as the run-detail Database tab so the cache is shared. */
export const dbQuery = (runId: string) => ({ queryKey: ['run-sub', runId, 'db'], queryFn: () => api.get<DbResp>(`/runs/${enc(runId)}/database`), staleTime: 30000 });

const vals = (rows: DbRow[], col: string) => rows.map((r) => r[col]).filter((v) => v != null).map(Number).filter(Number.isFinite);
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const max = (v: number[]) => (v.length ? Math.max(...v) : null);
const sum = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) : null);

export interface DbStats {
  samples: number; latencyAvg: number | null; latencyMax: number | null; activeMax: number | null; connMax: number | null; maxConns: number | null; poolMaxPct: number | null;
  slowTotal: number | null; slowPeak: number | null; locksMax: number | null; deadlocks: number | null; cpuAvg: number | null; cpuMax: number | null; memMax: number | null; tpsAvg: number | null;
}

/** Run-level figures, same definitions as docs/user-manual/19-database-monitoring.md (slow queries / deadlocks are summed per interval → "≈"). */
export function dbStats(rows: DbRow[]): DbStats {
  const pool = rows.map((r) => (r.active_connections_max != null && r.max_connections ? (Number(r.active_connections_max) / Number(r.max_connections)) * 100 : null)).filter((v): v is number => v != null && Number.isFinite(v));
  return {
    samples: rows.length,
    latencyAvg: avg(vals(rows, 'query_latency_ms')), latencyMax: max(vals(rows, 'query_latency_ms_max')),
    activeMax: max(vals(rows, 'active_connections_max')), connMax: max(vals(rows, 'connections_max')), maxConns: max(vals(rows, 'max_connections')),
    poolMaxPct: max(pool),
    slowTotal: sum(vals(rows, 'slow_queries')), slowPeak: max(vals(rows, 'slow_queries_max')),
    locksMax: max(vals(rows, 'locks_max')), deadlocks: sum(vals(rows, 'deadlocks')),
    cpuAvg: avg(vals(rows, 'cpu_pct')), cpuMax: max(vals(rows, 'cpu_pct_max')), memMax: max(vals(rows, 'memory_pct_max')), tpsAvg: avg(vals(rows, 'transactions_per_sec')),
  };
}

/** Adds a derived pool-utilisation % column (active / max × 100) so it can be charted. */
export const withPool = (rows: DbRow[]): DbRow[] => rows.map((r) => ({ ...r, pool_pct: r.active_connections != null && r.max_connections ? (Number(r.active_connections) / Number(r.max_connections)) * 100 : null }) as DbRow);

export interface RecentRun { id: string; runId: string; testName: string; buildNumber: string | null; startedAt: string | null; result: string | null; environmentName: string }

/** Latest N completed runs matching the global filters (project / application / environment / test). */
export function useRecentRuns(n = 8) {
  const f = useFilters();
  return useQuery({
    queryKey: ['recent-runs', f.projectId, f.applicationId, f.environmentId, f.testId, n],
    queryFn: () => api.get<{ items: RecentRun[] }>('/runs', { projectId: f.projectId, applicationId: f.applicationId, environmentId: f.environmentId, testId: f.testId, status: 'COMPLETED', pageSize: n, sort: 'start', order: 'desc' }),
  });
}

/** Per-run DB summaries for a list of runs (across-runs view). */
export function useDbAcrossRuns(runs: RecentRun[]) {
  return useQueries({ queries: runs.map((r) => dbQuery(r.runId)) });
}
