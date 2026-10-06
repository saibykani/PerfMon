import { create } from 'zustand';

/** Relative ranges (spec §25) + custom + "run window" (exact execution window of a run). */
export const TIME_RANGES = [
  { key: '5m', label: 'Last 5 minutes', ms: 5 * 60e3 },
  { key: '15m', label: 'Last 15 minutes', ms: 15 * 60e3 },
  { key: '30m', label: 'Last 30 minutes', ms: 30 * 60e3 },
  { key: '1h', label: 'Last 1 hour', ms: 3600e3 },
  { key: '6h', label: 'Last 6 hours', ms: 6 * 3600e3 },
  { key: '12h', label: 'Last 12 hours', ms: 12 * 3600e3 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86400e3 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 86400e3 },
  { key: '90d', label: 'Last 90 days', ms: 90 * 86400e3 },
] as const;

export interface TimeRange { type: 'relative' | 'absolute' | 'run'; value?: string; from?: number; to?: number; runId?: string }

export function resolveRange(r: TimeRange, now = Date.now()): { from: number; to: number } | null {
  if (r.type === 'relative') {
    const def = TIME_RANGES.find((t) => t.key === r.value) ?? TIME_RANGES[8];
    return { from: now - def.ms, to: now };
  }
  if (r.type === 'absolute' && r.from && r.to) return { from: r.from, to: r.to };
  return null; // run window: resolved by the backend from the Run ID
}

export function rangeLabel(r: TimeRange) {
  if (r.type === 'relative') return TIME_RANGES.find((t) => t.key === r.value)?.label ?? r.value;
  if (r.type === 'run') return `Run window ${r.runId ?? ''}`;
  return `${new Date(r.from!).toLocaleString()} → ${new Date(r.to!).toLocaleString()}`;
}

export interface GlobalFilters {
  projectId: string | null;
  applicationId: string | null;
  environmentId: string | null;
  testId: string | null;
  runId: string | null;
  timeRange: TimeRange;
  refreshSec: number | null;
}

interface FilterState extends GlobalFilters {
  set: (patch: Partial<GlobalFilters>) => void;
  reset: () => void;
}

const KEY = 'perfmon.filters';
const load = (): Partial<GlobalFilters> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };
const defaults: GlobalFilters = { projectId: null, applicationId: null, environmentId: null, testId: null, runId: null, timeRange: { type: 'relative', value: '30d' }, refreshSec: null };

export const useFilters = create<FilterState>((set, get) => ({
  ...defaults,
  ...load(),
  set(patch) {
    // changing a parent clears its children (hierarchy: project → application → environment → test → run)
    const next: Partial<GlobalFilters> = { ...patch };
    if ('projectId' in patch && patch.projectId !== get().projectId) Object.assign(next, { applicationId: null, environmentId: null, testId: null, runId: null });
    if ('applicationId' in patch && patch.applicationId !== get().applicationId) Object.assign(next, { environmentId: null, testId: null, runId: null });
    if ('environmentId' in patch && patch.environmentId !== get().environmentId) Object.assign(next, { testId: null, runId: null });
    if ('testId' in patch && patch.testId !== get().testId) Object.assign(next, { runId: null });
    set(next);
    const { set: _s, reset: _r, ...state } = { ...get() };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  },
  reset() { set(defaults); try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
}));
