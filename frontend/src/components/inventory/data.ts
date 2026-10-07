import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

/* Inventory endpoints return DB rows (snake_case); runs/artifacts/alerts return camelCase DTOs. */

export const ENV_TYPES = ['DEV', 'QA', 'SIT', 'UAT', 'PERFORMANCE', 'STAGING', 'PRODUCTION'] as const;
export const TEST_TYPES = ['LOAD', 'STRESS', 'SPIKE', 'SOAK', 'ENDURANCE', 'VOLUME', 'CAPACITY', 'SCALABILITY', 'BASELINE'] as const;
export const SERVER_ROLES = ['app', 'db', 'loadgen', 'gateway', 'cache', 'queue', 'other'] as const;
export const SERVICE_KINDS = ['loadgen', 'gateway', 'service', 'database', 'cache', 'queue', 'external'] as const;
export const ARTIFACT_KINDS = ['HTML_REPORT', 'JTL', 'CSV', 'JMX', 'LOG', 'SCREENSHOT', 'SERVER_LOG', 'APP_LOG', 'CONFIG', 'TEST_DATA', 'JSON', 'XML', 'PDF', 'EXCEL', 'ZIP', 'OTHER'] as const;

export interface Project {
  id: string; key: string; name: string; description: string | null; created_at: string; updated_at: string; archived_at: string | null;
  applications?: number; environments?: number; tests?: number; runs?: number; dashboards?: number; releases?: number; active_alerts?: number; last_run_at?: string | null;
}
export interface Application {
  id: string; project_id: string; code: string; name: string; description: string | null; owner: string | null; team: string | null; technology: string | null;
  repository: string | null; version: string | null; created_at: string; updated_at: string;
  project_name?: string; project_key?: string; environments?: number; environment_names?: string[] | null; services?: number; tests?: number; runs?: number;
}
export interface Environment {
  id: string; project_id: string; application_id: string; name: string; type: string; description: string | null; base_url: string | null; config: Record<string, unknown>;
  created_at: string; updated_at: string; application_name?: string; project_name?: string; servers?: number; services?: number; databases?: number; running_runs?: number;
}
export interface TestRow {
  id: string; project_id: string; application_id: string; environment_id: string; name: string; description: string | null; test_type: string; sla_profile_id: string | null;
  owner: string | null; tags: string[]; baseline_run_id: string | null; created_at: string; updated_at: string;
  application_name: string; environment_name: string; environment_type: string; project_name: string; sla_profile_name: string | null;
  config_version: number | null; virtual_users: number | null; ramp_up_sec: number | null; ramp_down_sec: number | null; duration_sec: number | null; target_tps: number | string | null;
  thread_group: string | null; think_time_ms: number | null; jmx_artifact_id: string | null;
  run_count: number; last_run_key: string | null; last_run_status: string | null; last_run_result: string | null; last_run_at: string | null; baseline_run_key: string | null;
}
export interface TestConfiguration {
  id: string; version: number; is_current: boolean; virtual_users: number | null; ramp_up_sec: number | null; ramp_down_sec: number | null; duration_sec: number | null;
  target_tps: number | string | null; thread_group: string | null; think_time_ms: number | null; jmx_artifact_id: string | null; properties: Record<string, unknown>; created_at: string;
}
export interface TestRunLite {
  id: string; run_key: string; status: string; result: string | null; build_number: string | null; started_at: string | null; ended_at: string | null;
  performance_score: number | null; is_baseline: boolean; tps_avg: number | null; p95: number | null; error_pct: number | null;
}
export interface TestData { id: string; key: string; value: string | null; is_sensitive: boolean; created_at?: string }
export interface TestDetail extends TestRow { configurations: TestConfiguration[]; runs: TestRunLite[]; testData: TestData[] }
export interface SlaProfile { id: string; project_id: string; name: string; description: string | null; test_count: number; rules: unknown[] }
export interface Server {
  id: string; project_id: string; environment_id: string | null; application_id: string | null; name: string; hostname: string | null; ip_address: string | null; os: string | null;
  cpu_cores: number | null; memory_mb: number | null; disk_gb: number | null; role: string | null; status: string; tags: Record<string, string>; last_seen_at: string | null;
  environment_name: string | null; application_name: string | null; cpu_pct: number | null; memory_pct: number | null; disk_pct: number | null; metrics_at: string | null;
}
export interface Service {
  id: string; project_id: string; application_id: string | null; environment_id: string | null; server_id: string | null; name: string; kind: string; technology: string | null;
  health_status: string; created_at: string; environment_name: string | null; application_name: string | null; depends_on: string[];
}
export interface Release {
  id: string; project_id: string; application_id: string | null; environment_id: string | null; name: string; version: string; build_number: string | null; branch: string | null;
  commit_sha: string | null; deployment_date: string | null; notes: string | null; created_at: string;
  application_name?: string | null; environment_name?: string | null; run_count?: number; failed_runs?: number; tests?: string[] | null;
}
export interface Build { id: string; build_number: string; branch: string | null; commit_sha: string | null; ci_system: string | null; ci_url: string | null; created_at: string; release_version?: string | null; run_count?: number }
export interface ReleaseRun { id: string; run_key: string; status: string; result: string | null; build_number: string | null; started_at: string | null; test_name: string; p95: number | null; tps_avg: number | null; error_pct: number | null }
export interface ReleaseDetail extends Release { runs: ReleaseRun[]; builds: Build[] }

export interface RunDto {
  id: string; runId: string; status: string; result: string | null; projectId: string; projectName: string; applicationId: string; applicationName: string;
  environmentId: string; environmentName: string; environmentType: string; testId: string; testName: string; testType: string; releaseVersion: string | null;
  buildNumber: string | null; version: string | null; branch: string | null; commit: string | null; tags: string[]; description: string | null;
  virtualUsers: number | null; startedAt: string | null; endedAt: string | null; createdAt: string; durationSec: number | null; isBaseline: boolean; performanceScore: number | null;
  kpis?: { samples: number | null; tps: number | null; avgRt: number | null; p95: number | null; p99: number | null; errorPct: number | null; usersPeak: number | null; percentileMethod: string | null };
}
export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number }

export interface ArtifactVersion {
  id: string; version: number; originalFilename: string; mimeType: string | null; sizeBytes: number; sha256: string; uploadedBy: string | null; uploadedAt: string;
  processingStatus: string | null; processingError: string | null; scanStatus: string | null; metadata: unknown; hasViewer: boolean;
}
export interface ArtifactRow {
  id: string; runId: string; runKey: string; kind: string; name: string; description: string | null; source: string | null; currentVersion: number; createdAt: string; updatedAt: string;
  latest?: ArtifactVersion; testName?: string; deletedAt?: string | null;
}

const STALE = 30_000;
export const useProjects = (includeArchived = false) =>
  useQuery({ queryKey: ['inv', 'projects', includeArchived], queryFn: () => api.get<Project[]>('/projects', { includeArchived }), staleTime: STALE });
export const useProject = (id?: string) =>
  useQuery({ queryKey: ['inv', 'project', id], enabled: !!id, queryFn: () => api.get<Project & { applications: Application[]; environments: Environment[]; tests: Pick<TestRow, 'id' | 'name' | 'test_type' | 'environment_id' | 'application_id'>[]; releases: Release[] }>(`/projects/${id}`) });
export const useApplications = (projectId?: string | null) =>
  useQuery({ queryKey: ['inv', 'applications', projectId ?? null], queryFn: () => api.get<Application[]>('/applications', { projectId }), staleTime: STALE });
export const useEnvironments = (q: { projectId?: string | null; applicationId?: string | null }, enabled = true) =>
  useQuery({ queryKey: ['inv', 'environments', q.projectId ?? null, q.applicationId ?? null], enabled, queryFn: () => api.get<Environment[]>('/environments', q), staleTime: STALE });
export const useTests = (q: { projectId?: string | null; applicationId?: string | null; environmentId?: string | null; q?: string }) =>
  useQuery({ queryKey: ['inv', 'tests', q], queryFn: () => api.get<TestRow[]>('/tests', q), staleTime: STALE });
export const useSlaProfiles = (projectId?: string | null) =>
  useQuery({ queryKey: ['inv', 'sla', projectId ?? null], queryFn: () => api.get<SlaProfile[]>('/sla/profiles', { projectId }), staleTime: STALE });
export const useServers = (q: { projectId?: string | null; environmentId?: string | null }) =>
  useQuery({ queryKey: ['inv', 'servers', q], queryFn: () => api.get<Server[]>('/servers', q), staleTime: 15_000, refetchInterval: 30_000 });
export const useServices = (q: { projectId?: string | null; environmentId?: string | null; kind?: string }) =>
  useQuery({ queryKey: ['inv', 'services', q], queryFn: () => api.get<Service[]>('/services', q), staleTime: STALE });
export const useReleases = (projectId?: string | null) =>
  useQuery({ queryKey: ['inv', 'releases', projectId ?? null], queryFn: () => api.get<Release[]>('/releases', { projectId }), staleTime: STALE });
export const useRuns = (q: Record<string, string | number | boolean | null | undefined>, enabled = true) =>
  useQuery({ queryKey: ['inv', 'runs', q], enabled, queryFn: () => api.get<Paged<RunDto>>('/runs', q), staleTime: 10_000 });

/** Invalidate every inventory query (cheap; lists are small). */
export function useInvalidateInventory() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['inv'] });
    // shared filter selectors elsewhere in the app
    for (const k of ['projects', 'applications', 'environments', 'tests']) qc.invalidateQueries({ queryKey: [k] });
  };
}

/** Drop empty strings / undefined so PATCH bodies only send intended changes; '' → null for nullable fields. */
export function clean<T extends Record<string, unknown>>(o: T, nullable: (keyof T)[] = []): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (v === '' || (typeof v === 'number' && Number.isNaN(v))) { if (nullable.includes(k as keyof T)) out[k] = null; continue; }
    out[k] = v;
  }
  return out as Partial<T>;
}

export const intOrNull = (s: string) => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Math.round(Number(s)) : NaN);
export const numOrNull = (s: string) => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : NaN);
