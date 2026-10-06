import { one, query } from '../db/pool.js';

export const DEFAULT_SETTINGS = {
  /** Performance Score weights (renormalized over factors that have data). */
  score_weights: { sla: 30, responseTime: 20, throughput: 15, errorRate: 15, infrastructure: 10, regression: 10 },
  /** Regression thresholds (percent change unless noted). */
  regression_thresholds: {
    p95Pct: 10, p99Pct: 15, avgPct: 10, tpsDropPct: 10, errorRateIncreasePts: 1,
    cpuIncreasePts: 15, memoryIncreasePts: 15, minTransactionSamples: 30, minAbsoluteMs: 25,
  },
  /** Default thresholds used when a test has no SLA profile (for result classification only). */
  default_result_thresholds: { errorPctFail: 5, errorPctWarn: 1 },
  retention: { rawMetricsDays: 90, aggregatedMetricsDays: 730, artifactsDays: 365, reportsDays: 730, logsDays: 30, auditDays: 365 },
  live: { defaultRefreshSec: 5 },
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export async function getSetting<K extends SettingKey>(orgId: string, key: K): Promise<(typeof DEFAULT_SETTINGS)[K]> {
  const r = await one(`SELECT value FROM system_settings WHERE organization_id = $1 AND key = $2`, [orgId, key]);
  return { ...(DEFAULT_SETTINGS[key] as object), ...(r?.value ?? {}) } as any;
}

export async function setSetting(orgId: string, key: SettingKey, value: unknown, userId?: string | null) {
  await query(
    `INSERT INTO system_settings (organization_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [orgId, key, JSON.stringify(value), userId ?? null]);
}

export async function allSettings(orgId: string) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) out[k] = await getSetting(orgId, k);
  return out;
}
