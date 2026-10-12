import { create } from 'zustand';
import {
  DEFAULT_RANGE, FILTER_KEYS, resolveTime, type FilterKey, type ObsFilterValues, type ObsTime, type ObsUrlState, type Tz,
} from '@/components/observability/obsTime';

/**
 * Shared time window + entity filters of the Observability hub. Mirrored in the URL by
 * ObsFilterBar (useObsUrlSync); the timezone preference is also remembered per browser.
 */
interface ObsFilterState extends ObsUrlState {
  /** "now" used to resolve relative ranges; bumped by refresh / auto-refresh */
  anchor: number;
  setTime: (t: ObsTime) => void;
  setTz: (tz: Tz) => void;
  setRefresh: (sec: number) => void;
  setFilter: (k: FilterKey, values: string[]) => void;
  setFilters: (f: ObsFilterValues) => void;
  clearFilters: () => void;
  refreshNow: () => void;
  hydrate: (s: ObsUrlState) => void;
}

const TZ_KEY = 'perfmon.obs.tz';
const readTz = (): Tz => { try { return localStorage.getItem(TZ_KEY) === 'utc' ? 'utc' : 'local'; } catch { return 'local'; } };

export const useObsFilters = create<ObsFilterState>((set) => ({
  time: { mode: 'relative', key: DEFAULT_RANGE },
  tz: readTz(),
  refreshSec: 0,
  filters: {},
  anchor: Date.now(),
  setTime: (time) => set((s) => ({ time, anchor: Date.now(), refreshSec: time.mode === 'absolute' ? 0 : s.refreshSec })),
  setTz: (tz) => { try { localStorage.setItem(TZ_KEY, tz); } catch { /* ignore */ } set({ tz }); },
  setRefresh: (refreshSec) => set({ refreshSec, anchor: Date.now() }),
  setFilter: (k, values) => set((s) => {
    const filters = { ...s.filters, [k]: [...new Set(values)] };
    if (!values.length) delete filters[k];
    return { filters };
  }),
  setFilters: (filters) => set({ filters }),
  clearFilters: () => set({ filters: {} }),
  refreshNow: () => set({ anchor: Date.now() }),
  hydrate: (s) => set({ time: s.time, tz: s.tz, refreshSec: s.refreshSec, filters: s.filters, anchor: Date.now() }),
}));

/** Resolved window (epoch ms) of the current selection. */
export const useObsRange = () => {
  const time = useObsFilters((s) => s.time);
  const anchor = useObsFilters((s) => s.anchor);
  return resolveTime(time, anchor);
};

export const activeFilterCount = (f: ObsFilterValues) => FILTER_KEYS.filter((k) => f[k]?.length).length;
