import {
  Activity, AlertOctagon, Bell, FileText, Play, Power, Rocket, Settings2, Square, StickyNote, Database, TrendingUp, CircleDot,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ------------------------------------------------------------------ API shapes (backend/src/events/routes.ts) */

export interface EventRow {
  id: string; projectId: string; applicationId: string | null; environmentId: string | null; environmentName: string | null;
  runId: string | null; runKey: string | null; type: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; ts: string; title: string;
  description: string | null; source: string | null; data: Record<string, unknown>;
}

export interface AnnotationRow {
  id: string; projectId: string; runId: string | null; runKey: string | null; environmentId: string | null; dashboardId: string | null;
  ts: string; tsEnd: string | null; title: string; text: string | null; tags: string[]; createdBy: string | null; createdByName: string | null; createdAt: string;
}

/** One row of the unified activity feed (events + annotations). */
export type FeedRow =
  | { kind: 'event'; key: string; ts: number; tsEnd: null; type: string; severity: string; title: string; text: string | null; runKey: string | null; event: EventRow }
  | { kind: 'annotation'; key: string; ts: number; tsEnd: number | null; type: 'ANNOTATION'; severity: null; title: string; text: string | null; runKey: string | null; annotation: AnnotationRow };

export const toFeed = (events: EventRow[], annotations: AnnotationRow[]): FeedRow[] => [
  ...events.map((e): FeedRow => ({ kind: 'event', key: `e:${e.id}`, ts: new Date(e.ts).getTime(), tsEnd: null, type: e.type, severity: e.severity, title: e.title, text: e.description, runKey: e.runKey, event: e })),
  ...annotations.map((a): FeedRow => ({
    kind: 'annotation', key: `a:${a.id}`, ts: new Date(a.ts).getTime(), tsEnd: a.tsEnd ? new Date(a.tsEnd).getTime() : null, type: 'ANNOTATION', severity: null,
    title: a.title, text: a.text, runKey: a.runKey, annotation: a,
  })),
].sort((x, y) => y.ts - x.ts);

/* ------------------------------------------------------------------ type vocabulary */

export const EVENT_TYPES = ['DEPLOYMENT', 'TEST_START', 'TEST_END', 'ALERT', 'INCIDENT', 'CONFIG_CHANGE', 'APP_RESTART', 'DB_RESTART', 'REGRESSION', 'REPORT', 'OTHER'] as const;

/** Timeline lanes (top → bottom). */
export const LANES = ['Annotations', 'Deployments & changes', 'Test runs', 'Alerts & incidents', 'Regressions', 'Other'] as const;
export type Lane = (typeof LANES)[number];

export const TYPE_META: Record<string, { label: string; lane: Lane; Icon: LucideIcon }> = {
  ANNOTATION: { label: 'Annotation', lane: 'Annotations', Icon: StickyNote },
  DEPLOYMENT: { label: 'Deployment', lane: 'Deployments & changes', Icon: Rocket },
  CONFIG_CHANGE: { label: 'Config change', lane: 'Deployments & changes', Icon: Settings2 },
  APP_RESTART: { label: 'App restart', lane: 'Deployments & changes', Icon: Power },
  DB_RESTART: { label: 'DB restart', lane: 'Deployments & changes', Icon: Database },
  TEST_START: { label: 'Test start', lane: 'Test runs', Icon: Play },
  TEST_END: { label: 'Test end', lane: 'Test runs', Icon: Square },
  ALERT: { label: 'Alert', lane: 'Alerts & incidents', Icon: Bell },
  INCIDENT: { label: 'Incident', lane: 'Alerts & incidents', Icon: AlertOctagon },
  REGRESSION: { label: 'Regression', lane: 'Regressions', Icon: TrendingUp },
  REPORT: { label: 'Report', lane: 'Other', Icon: FileText },
  OTHER: { label: 'Other', lane: 'Other', Icon: CircleDot },
};
export const typeMeta = (t: string) => TYPE_META[t] ?? { label: t.replace(/_/g, ' ').toLowerCase(), lane: 'Other' as Lane, Icon: Activity };

export function TypeTag({ type }: { type: string }) {
  const m = typeMeta(type);
  return <span className={`ev-type ${type === 'ANNOTATION' ? 'ann' : ''}`}><m.Icon size={12} aria-hidden />{m.label}</span>;
}


/* ------------------------------------------------------------------ helpers */

/** Read a theme colour token (CSS custom property) so canvas charts follow the active theme. */
export function cssVar(name: string, fallback = 'gray') {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** ISO/epoch → value for <input type="datetime-local"> in local time. */
export const toLocalInput = (d: string | number | Date | null | undefined) => {
  if (d == null || d === '') return '';
  const x = new Date(d);
  if (!Number.isFinite(x.getTime())) return '';
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (s: string) => new Date(s).toISOString();

export function fmtSpan(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 30);
