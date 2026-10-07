import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { resolveRange, type TimeRange } from '@/stores/filters';
import type { Panel, PanelResult, VarValues } from './types';

export type QueryTimeRange = { from: number; to: number } | { runId: string };

/** Contract time range for POST /dashboards/query. Run window → { runId }. */
export function toQueryRange(tr: TimeRange | null | undefined, vars: VarValues): QueryTimeRange {
  const r = tr ?? { type: 'relative', value: '30d' };
  if (r.type === 'run') {
    const runId = r.runId || (typeof vars.run === 'string' ? vars.run : null);
    if (runId) return { runId };
  }
  return resolveRange(r.type === 'run' ? { type: 'relative', value: '30d' } : r) ?? resolveRange({ type: 'relative', value: '30d' })!;
}

/** Strip null/'All'/empty values: the server treats missing as unfiltered. */
export function cleanVars(vars: VarValues): VarValues {
  const out: VarValues = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v == null || v === '' || v === 'All') { out[k] = null; continue; }
    if (Array.isArray(v)) out[k] = v.length && !v.includes('All') ? v : null;
    else out[k] = v;
  }
  return out;
}

export async function queryPanels(panels: Pick<Panel, 'id' | 'type' | 'query'>[], vars: VarValues, timeRange: TimeRange | null | undefined) {
  const queryable = panels.filter((p) => p.type !== 'text');
  if (!queryable.length) return {} as Record<string, PanelResult>;
  const res = await api.post<{ results: Record<string, PanelResult> }>('/dashboards/query', {
    panels: queryable.map((p) => ({ id: p.id, type: p.type, query: p.query })),
    vars: cleanVars(vars),
    timeRange: toQueryRange(timeRange, vars),
  });
  return res.results ?? {};
}

/**
 * One batched request for every panel on the dashboard. Re-queries whenever panel queries,
 * variables or the time range change; auto-refreshes on the dashboard interval.
 */
export function useDashboardQuery(uid: string | undefined, panels: Panel[], vars: VarValues, timeRange: TimeRange | null | undefined, refreshSec: number | null, enabled = true) {
  const sig = panels.filter((p) => p.type !== 'text').map((p) => [p.id, p.type, p.query]);
  return useQuery({
    queryKey: ['dashboard-query', uid, sig, vars, timeRange],
    queryFn: () => queryPanels(panels, vars, timeRange),
    enabled: enabled && !!uid,
    placeholderData: keepPreviousData,
    refetchInterval: refreshSec ? refreshSec * 1000 : false,
    staleTime: 5000,
  });
}
