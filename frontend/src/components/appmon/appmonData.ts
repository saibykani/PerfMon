import { useQueries } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { RecentRun } from '@/components/databases/dbData';

const enc = encodeURIComponent;

/** GET /runs/:id/jvm — series grouped by server_id; every column also has `<col>_max`. */
export interface JvmTarget { name: string | null; server_id: string | null; service_id: string | null }
export type JvmRow = { t: number; server_id: string | null } & Record<string, number | null>;
export interface JvmResp { targets: JvmTarget[]; step: number; series: JvmRow[] }

/** GET /runs/:id/services — averages over the run (service_metrics), null when nothing was reported. */
export interface RunService {
  id: string; name: string; kind: string; technology: string | null; health_status: string | null;
  request_rate: number | null; error_rate_pct: number | null; avg_latency_ms: number | null; p95_latency_ms: number | null; exceptions: number | null; cpu_pct: number | null; memory_pct: number | null;
}
export interface ServicesResp { services: RunService[]; dependencies: { source: string; target: string }[] }

/** Same query keys as the run-detail tabs so the cache is shared. */
export const jvmQuery = (runId: string) => ({ queryKey: ['run-sub', runId, 'jvm'], queryFn: () => api.get<JvmResp>(`/runs/${enc(runId)}/jvm`), staleTime: 30000 });
export const servicesQuery = (runId: string) => ({ queryKey: ['run-sub', runId, 'services'], queryFn: () => api.get<ServicesResp>(`/runs/${enc(runId)}/services`), staleTime: 30000 });

const vals = (rows: JvmRow[], col: string) => rows.map((r) => r[col]).filter((v) => v != null).map(Number).filter(Number.isFinite);
const max = (v: number[]) => (v.length ? Math.max(...v) : null);
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const sum = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) : null);

export interface JvmStats { heapUsedMax: number | null; heapUsedAvg: number | null; heapMax: number | null; heapPctMax: number | null; gcPauseMax: number | null; gcTime: number | null; gcCount: number | null; threadsMax: number | null; classesMax: number | null; nonHeapMax: number | null }

export function jvmStats(rows: JvmRow[]): JvmStats {
  const pct = rows.map((r) => (r.heap_used_mb_max != null && r.heap_max_mb ? (Number(r.heap_used_mb_max) / Number(r.heap_max_mb)) * 100 : null)).filter((v): v is number => v != null && Number.isFinite(v));
  return {
    heapUsedMax: max(vals(rows, 'heap_used_mb_max')), heapUsedAvg: avg(vals(rows, 'heap_used_mb')), heapMax: max(vals(rows, 'heap_max_mb')), heapPctMax: max(pct),
    gcPauseMax: max(vals(rows, 'gc_max_pause_ms_max')), gcTime: sum(vals(rows, 'gc_time_ms')), gcCount: sum(vals(rows, 'gc_count')),
    threadsMax: max([...vals(rows, 'thread_count_max'), ...vals(rows, 'peak_threads_max')]), classesMax: max(vals(rows, 'classes_loaded_max')), nonHeapMax: max(vals(rows, 'nonheap_used_mb_max')),
  };
}

/** Adds heap utilisation % (used / max × 100) for charting. */
export const withHeapPct = (rows: JvmRow[]): JvmRow[] => rows.map((r) => ({ ...r, heap_pct: r.heap_used_mb != null && r.heap_max_mb ? (Number(r.heap_used_mb) / Number(r.heap_max_mb)) * 100 : null }) as JvmRow);

export const hasServiceMetrics = (s: RunService) => [s.request_rate, s.error_rate_pct, s.avg_latency_ms, s.p95_latency_ms, s.cpu_pct, s.memory_pct, s.exceptions].some((v) => v != null);

export function useAcrossRuns(runs: RecentRun[]) {
  const jvm = useQueries({ queries: runs.map((r) => jvmQuery(r.runId)) });
  const svc = useQueries({ queries: runs.map((r) => servicesQuery(r.runId)) });
  return runs.map((run, i) => {
    const j = jvm[i]?.data;
    const s = svc[i]?.data;
    const withM = (s?.services ?? []).filter(hasServiceMetrics);
    return {
      run, loading: !!(jvm[i]?.isLoading || svc[i]?.isLoading), jvm: j, jvmTargets: j?.targets.length ?? 0, stats: j?.series.length ? jvmStats(j.series) : null,
      svcWithMetrics: withM.length,
      errMax: withM.length ? max(withM.map((x) => Number(x.error_rate_pct)).filter(Number.isFinite)) : null,
      cpuMax: withM.length ? max(withM.map((x) => Number(x.cpu_pct)).filter(Number.isFinite)) : null,
    };
  });
}
