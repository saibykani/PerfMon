import { AGGS, type Agg } from './obsApi';
import type { PanelCfg } from './ObsPanel';
import { FILTER_KEYS, type ObsFilterValues } from './obsTime';

/** Panels ⇄ compact URL value (`panels=` query param). Pure. */
export function encodePanels(panels: PanelCfg[]): string {
  return JSON.stringify(panels.map((p) => {
    const o: Record<string, unknown> = { m: p.metrics };
    if (p.agg !== 'avg') o.a = p.agg;
    if (p.groupBy !== 'entity') o.g = p.groupBy;
    if (p.step !== 'auto') o.s = p.step;
    if (p.title) o.t = p.title;
    if (p.filters && Object.keys(p.filters).length) o.f = p.filters;
    return o;
  }));
}

export function decodePanels(raw: string | null | undefined, newId: () => string): PanelCfg[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.filter((o) => o && Array.isArray(o.m)).slice(0, 24).map((o) => {
      const filters: ObsFilterValues = {};
      if (o.f && typeof o.f === 'object') for (const k of FILTER_KEYS) if (Array.isArray(o.f[k])) filters[k] = o.f[k].map(String);
      return {
        id: newId(),
        metrics: o.m.map(String).slice(0, 12),
        agg: (AGGS as string[]).includes(o.a) ? (o.a as Agg) : 'avg',
        groupBy: o.g === 'none' ? 'none' : 'entity',
        step: Number.isFinite(Number(o.s)) && Number(o.s) >= 10 ? Number(o.s) : 'auto',
        ...(typeof o.t === 'string' && o.t ? { title: o.t } : {}),
        ...(Object.keys(filters).length ? { filters } : {}),
      } as PanelCfg;
    });
  } catch { return null; }
}

/* ------------------------------------------------------------------ saved views (localStorage) */

export interface SavedView { name: string; savedAt: number; search: string }
const KEY = 'perfmon.obs.views';

export function loadViews(): SavedView[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && typeof x.search === 'string') : [];
  } catch { return []; }
}

export function saveView(name: string, search: string): SavedView[] {
  const list = [{ name: name.trim(), savedAt: Date.now(), search }, ...loadViews().filter((v) => v.name !== name.trim())].slice(0, 50);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full / blocked */ }
  return list;
}

export function deleteView(name: string): SavedView[] {
  const list = loadViews().filter((v) => v.name !== name);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}
