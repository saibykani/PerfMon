/** API response shapes for run analysis (mirrors backend/src/runs/*.ts). */

export type PercentileMethod = 'exact_histogram' | 'source_reported' | 'interval_weighted_approx' | string | null;

export interface SeriesPoint {
  t: number; count: number; errors: number; tps: number; errorPct: number | null;
  avg: number | null; min: number | null; max: number | null; p50: number | null; p90: number | null; p95: number | null; p99: number | null;
  users: number | null; sentBps: number; receivedBps: number;
}

export interface WindowStats {
  source: string; totalSamples: number; successCount: number; failureCount: number; errorPct: number; tpsAvg: number; tpsPeak: number | null;
  avgRt: number | null; minRt: number | null; maxRt: number | null; medianRt: number | null;
  p50: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null; p999: number | null; stddevRt: number | null;
  usersAvg: number | null; usersPeak: number | null; bytesSent: number; bytesReceived: number; sentKbSec: number; receivedKbSec: number;
  durationSec: number; startTs: number; endTs: number; percentileMethod: PercentileMethod;
}

export interface SummaryDto {
  source: string; computedAt: string; requests: number | null; successfulRequests: number | null; failedRequests: number | null; errorPct: number | null;
  tps: number | null; peakTps: number | null; avgRt: number | null; minRt: number | null; maxRt: number | null; medianRt: number | null;
  p50: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null; p999: number | null; stddevRt: number | null;
  usersAvg: number | null; usersPeak: number | null; bytesSent: number | null; bytesReceived: number | null; sentKbSec: number | null; receivedKbSec: number | null;
  durationSec: number | null; percentileMethod: PercentileMethod; slaPassPct: number | null; slaViolations: number | null; apdex: number | null;
}

export interface ScoreFactor { key: string; label: string; weight: number; score: number | null; detail: string }
export type DimStatus = 'PASS' | 'WARNING' | 'FAIL' | 'N/A';

export interface RunDetail {
  id: string; runId: string; executionId: string | null; status: string; result: string | null; resultReason: string | null;
  projectId: string; projectName: string; projectKey: string; applicationId: string; applicationName: string;
  environmentId: string; environmentName: string; environmentType: string; testId: string; testName: string; testType: string;
  releaseId: string | null; releaseVersion: string | null; buildNumber: string | null; version: string | null; branch: string | null; commit: string | null;
  tester: string | null; triggeredBy: string | null; ciSystem: string | null; ciUrl: string | null; loadEngine: string | null; tags: string[]; description: string | null;
  virtualUsers: number | null; targetTps: number | null; scheduledAt: string | null; startedAt: string | null; endedAt: string | null; durationSec: number | null;
  isBaseline: boolean; baselineRunId: string | null; performanceScore: number | null; liveLastIngestAt: string | null; createdAt: string;
  summary: SummaryDto | null; summaries: Record<string, SummaryDto | null>;
  configuration: { version: number; virtualUsers: number | null; rampUpSec: number | null; durationSec: number | null; targetTps: number | null; threadGroup: string | null } | null;
  baseline: { id: string; runKey: string; reason: string } | null;
  resultBreakdown: { result: string; breakdown: Record<string, DimStatus>; reasons: string[] } | null;
  scoreBreakdown: { score: number | null; factors: ScoreFactor[]; weights: Record<string, number> } | null;
  analysis: { bottlenecks?: Bottleneck[]; gaps?: string[]; saturation?: any; reconciliation?: string } | null;
  analyzedAt: string | null;
  counts: { artifacts: number; insights: number; regressions: number; alerts: number; sla_failures: number; html_reports: number; pending_jobs: number };
}

export interface Bottleneck { component: string; category: string; confidence: number; label: string; evidence: string[]; correlation: number | null }

export interface TxnRow {
  name: string; samples: number; errors: number; errorPct: number | null; tps: number | null; avg: number | null; min: number | null; max: number | null;
  median: number | null; p90: number | null; p95: number | null; p99: number | null; stddev: number | null; receivedKbSec: number | null; sentKbSec: number | null;
  slaStatus: string | null; percentileMethod: PercentileMethod;
}

export interface EndpointRow {
  id: string; method: string; endpoint: string; requests: number; errors: number; errorPct: number; tps: number | null; avg: number | null;
  min: number | null; max: number | null; p95: number | null; p99: number | null; statusCodes: Record<string, number>;
}

export interface Bucket { from: number; to: number; count: number }

export interface TimelineResponse {
  step: number; percentileMethod: PercentileMethod; points: SeriesPoint[]; source: string; window: { from: string | null; to: string | null };
  infra: { t: number; cpu_pct: number | null; memory_pct: number | null }[];
  events: { id: string; type: string; severity: string; ts: string; title: string; description: string | null; source: string }[];
  annotations: { id: string; ts: string; ts_end: string | null; title: string; text: string | null; tags: string[]; created_by_name: string | null }[];
}

export type TimeWindow = { from: number; to: number } | null;
