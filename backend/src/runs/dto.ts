/** Shared row → API mappers for runs. */
export function runDto(r: any) {
  const duration = r.duration_sec != null ? Number(r.duration_sec)
    : r.started_at ? ((r.ended_at ? new Date(r.ended_at).getTime() : Date.now()) - new Date(r.started_at).getTime()) / 1000 : null;
  return {
    id: r.id,
    runId: r.run_key,
    executionId: r.execution_id,
    status: r.status,
    result: r.result,
    resultReason: r.result_reason,
    projectId: r.project_id, projectName: r.project_name, projectKey: r.project_key,
    applicationId: r.application_id, applicationName: r.application_name,
    environmentId: r.environment_id, environmentName: r.environment_name, environmentType: r.environment_type,
    testId: r.test_id, testName: r.test_name, testType: r.test_type,
    releaseId: r.release_id, releaseVersion: r.release_version,
    buildId: r.build_id, buildNumber: r.build_number, version: r.version, branch: r.branch, commit: r.commit_sha,
    tester: r.tester, triggeredBy: r.triggered_by, ciSystem: r.ci_system, ciUrl: r.ci_url, loadEngine: r.load_engine,
    tags: r.tags ?? [], description: r.description,
    virtualUsers: r.virtual_users, targetTps: r.target_tps,
    scheduledAt: r.scheduled_at, startedAt: r.started_at, endedAt: r.ended_at, durationSec: duration,
    isBaseline: r.is_baseline, baselineRunId: r.baseline_run_id,
    performanceScore: r.performance_score,
    liveLastIngestAt: r.live_last_ingest_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
    kpis: r.total_samples !== undefined ? {
      samples: r.total_samples, tps: r.tps_avg, avgRt: r.avg_rt, p95: r.p95, p99: r.p99, errorPct: r.error_pct,
      usersPeak: r.users_peak, slaPassPct: r.sla_pass_pct, percentileMethod: r.percentile_method, source: r.summary_source,
    } : undefined,
  };
}

export function summaryDto(s: any) {
  if (!s) return null;
  return {
    source: s.source, computedAt: s.computed_at,
    requests: s.total_samples, successfulRequests: s.success_count, failedRequests: s.failure_count, errorPct: s.error_pct,
    tps: s.tps_avg, peakTps: s.tps_peak,
    avgRt: s.avg_rt, minRt: s.min_rt, maxRt: s.max_rt, medianRt: s.median_rt,
    p50: s.p50, p75: s.p75, p90: s.p90, p95: s.p95, p99: s.p99, p999: s.p999, stddevRt: s.stddev_rt,
    usersAvg: s.users_avg, usersPeak: s.users_peak,
    bytesSent: s.bytes_sent, bytesReceived: s.bytes_received, sentKbSec: s.sent_kb_sec, receivedKbSec: s.received_kb_sec,
    durationSec: s.duration_sec, percentileMethod: s.percentile_method,
    slaPassPct: s.sla_pass_pct, slaViolations: s.sla_violations, apdex: s.apdex, extra: s.extra,
  };
}

export const RUN_SELECT = `
  SELECT r.*, t.name AS test_name, t.test_type, a.name AS application_name, e.name AS environment_name, e.type AS environment_type,
         p.name AS project_name, p.key AS project_key, rel.version AS release_version,
         s.total_samples, s.tps_avg, s.avg_rt, s.p95, s.p99, s.error_pct, s.users_peak, s.sla_pass_pct, s.percentile_method, s.source AS summary_source,
         EXTRACT(EPOCH FROM (COALESCE(r.ended_at, CASE WHEN r.status IN ('RUNNING','ANALYZING') THEN now() END) - r.started_at)) AS duration_sec
  FROM test_runs r
  JOIN performance_tests t ON t.id = r.test_id
  JOIN applications a ON a.id = r.application_id
  JOIN environments e ON e.id = r.environment_id
  JOIN projects p ON p.id = r.project_id
  LEFT JOIN releases rel ON rel.id = r.release_id
  LEFT JOIN LATERAL (SELECT * FROM run_summary rs WHERE rs.run_id = r.id
                     ORDER BY CASE rs.source WHEN 'live' THEN 0 WHEN 'jtl' THEN 1 WHEN 'import' THEN 2 ELSE 3 END LIMIT 1) s ON true`;
