/**
 * Pure helpers for the Observability hub: time ranges (relative ↔ absolute), validation,
 * timezone-aware formatting/parsing, step selection and URL (de)serialisation of filters.
 * No React / DOM dependencies, so everything here is unit-tested.
 */

export type Tz = 'local' | 'utc';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MAX_WINDOW_MS = 90 * DAY;

export const QUICK_RANGES = [
  { key: '5m', label: 'Last 5 minutes', ms: 5 * MINUTE },
  { key: '15m', label: 'Last 15 minutes', ms: 15 * MINUTE },
  { key: '30m', label: 'Last 30 minutes', ms: 30 * MINUTE },
  { key: '1h', label: 'Last 1 hour', ms: HOUR },
  { key: '3h', label: 'Last 3 hours', ms: 3 * HOUR },
  { key: '6h', label: 'Last 6 hours', ms: 6 * HOUR },
  { key: '12h', label: 'Last 12 hours', ms: 12 * HOUR },
  { key: '24h', label: 'Last 24 hours', ms: DAY },
  { key: '2d', label: 'Last 2 days', ms: 2 * DAY },
  { key: '7d', label: 'Last 7 days', ms: 7 * DAY },
  { key: '30d', label: 'Last 30 days', ms: 30 * DAY },
] as const;
export type QuickKey = (typeof QUICK_RANGES)[number]['key'];
export const DEFAULT_RANGE: QuickKey = '1h';

export const REFRESH_OPTIONS = [
  { sec: 0, label: 'Off' }, { sec: 10, label: '10s' }, { sec: 30, label: '30s' }, { sec: 60, label: '1m' }, { sec: 300, label: '5m' },
] as const;

export type ObsTime = { mode: 'relative'; key: QuickKey } | { mode: 'absolute'; from: number; to: number };

export const quick = (key: string) => QUICK_RANGES.find((r) => r.key === key);

/** Resolve a time selection to epoch ms. Relative ranges end at `now` (whole seconds). */
export function resolveTime(t: ObsTime, now = Date.now()): { from: number; to: number } {
  if (t.mode === 'absolute') return { from: t.from, to: t.to };
  const to = Math.floor(now / 1000) * 1000;
  return { from: to - (quick(t.key)?.ms ?? HOUR), to };
}

/** Human-readable validation error for an absolute window, or null if valid. */
export function validateRange(from: number | null | undefined, to: number | null | undefined, now = Date.now()): string | null {
  if (from == null || !Number.isFinite(from)) return 'Enter a valid "From" date and time (YYYY-MM-DD HH:mm).';
  if (to == null || !Number.isFinite(to)) return 'Enter a valid "To" date and time (YYYY-MM-DD HH:mm).';
  if (from >= to) return '"From" must be earlier than "To".';
  if (to - from > MAX_WINDOW_MS) return 'The window cannot be longer than 90 days.';
  if (from > now) return '"From" is in the future.';
  return null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function parts(ms: number, tz: Tz) {
  const d = new Date(ms);
  return tz === 'utc'
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
    : { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}

/** "UTC" or the local offset at that instant, e.g. "UTC+05:30". */
export function tzLabel(tz: Tz, ms = Date.now()): string {
  if (tz === 'utc') return 'UTC';
  const off = -new Date(ms).getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** `yyyy-mm-dd HH:mm[:ss]` in the chosen timezone (used in inputs and labels). */
export function formatDateTime(ms: number, tz: Tz, seconds = false): string {
  const p = parts(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}${seconds ? `:${pad(p.s)}` : ''}`;
}

/** Exact timestamp for tooltips: `yyyy-mm-dd HH:mm:ss <tz>`. */
export const formatTs = (ms: number, tz: Tz) => `${formatDateTime(ms, tz, true)} ${tzLabel(tz, ms)}`;

/** Value for <input type="datetime-local"> in the chosen timezone. */
export const toPickerValue = (ms: number, tz: Tz, seconds = false) => formatDateTime(ms, tz, seconds).replace(' ', 'T');

/**
 * Parse a typed date-time in the chosen timezone. Accepts `YYYY-MM-DD HH:mm`, `YYYY-MM-DDTHH:mm`,
 * optional `:ss`, and a full ISO instant with Z / offset (then `tz` is ignored). Returns null if invalid.
 */
export function parseDateTime(input: string, tz: Tz): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /\d{2}:\d{2}/.test(s)) {
    const v = Date.parse(s);
    return Number.isFinite(v) ? v : null;
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', sec = '0'] = m.slice(1).map((x) => x ?? undefined) as string[];
  const n = [y, mo, d, h, mi, sec].map(Number);
  if (n[1] < 1 || n[1] > 12 || n[2] < 1 || n[2] > 31 || n[3] > 23 || n[4] > 59 || n[5] > 59) return null;
  const ms = tz === 'utc' ? Date.UTC(n[0], n[1] - 1, n[2], n[3], n[4], n[5]) : new Date(n[0], n[1] - 1, n[2], n[3], n[4], n[5]).getTime();
  // reject roll-over dates such as 2026-02-31
  const back = parts(ms, tz);
  if (back.y !== n[0] || back.mo !== n[1] || back.d !== n[2]) return null;
  return ms;
}

/** Zoom out ×2 around the centre; never past now, never beyond 90 days. */
export function zoomOut(from: number, to: number, now = Date.now()): { from: number; to: number } {
  const span = Math.min((to - from) * 2, MAX_WINDOW_MS);
  const centre = (from + to) / 2;
  let t = Math.round(centre + span / 2);
  if (t > now) t = Math.floor(now / 1000) * 1000;
  return { from: t - span, to: t };
}

/** Shift the window by half its length (dir -1 = earlier, +1 = later); never past now. */
export function shiftRange(from: number, to: number, dir: -1 | 1, now = Date.now()): { from: number; to: number } {
  const span = to - from;
  let t = to + dir * Math.round(span / 2);
  if (t > now) t = Math.floor(now / 1000) * 1000;
  return { from: t - span, to: t };
}

/** Snap a drag-selected range outward to whole minutes (at least one minute). */
export function snapToMinutes(from: number, to: number): { from: number; to: number } {
  const f = Math.floor(Math.min(from, to) / MINUTE) * MINUTE;
  let t = Math.ceil(Math.max(from, to) / MINUTE) * MINUTE;
  if (t <= f) t = f + MINUTE;
  return { from: f, to: t };
}

/** Mirrors the backend `step=auto`: smallest standard step keeping ≤ 600 points. */
export const STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 21600, 86400];
export function autoStep(from: number, to: number, maxPoints = 600): number {
  const sec = Math.max(1, (to - from) / 1000);
  return STEPS.find((s) => sec / s <= maxPoints) ?? 86400;
}

export function formatStep(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function formatSpan(ms: number): string {
  const m = Math.round(ms / MINUTE);
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  const d = ms / DAY;
  return `${+d.toFixed(1)}d`;
}

/** Short axis label that adapts to the window length. */
export function axisLabel(ms: number, spanMs: number, tz: Tz): string {
  const p = parts(ms, tz);
  const hm = `${pad(p.h)}:${pad(p.mi)}`;
  if (spanMs <= 10 * MINUTE) return `${hm}:${pad(p.s)}`;
  if (spanMs <= 36 * HOUR) return hm;
  return `${pad(p.mo)}-${pad(p.d)} ${hm}`;
}

/** Label for the time button. */
export function rangeLabel(t: ObsTime, tz: Tz): string {
  if (t.mode === 'relative') return quick(t.key)?.label ?? t.key;
  const sameDay = formatDateTime(t.from, tz).slice(0, 10) === formatDateTime(t.to, tz).slice(0, 10);
  const secs = t.from % MINUTE !== 0 || t.to % MINUTE !== 0;
  const a = formatDateTime(t.from, tz, secs);
  const b = formatDateTime(t.to, tz, secs);
  return `${a} → ${sameDay ? b.slice(11) : b}`;
}

/* ------------------------------------------------------------------ filters + URL */

export const FILTER_KEYS = ['projectId', 'environmentId', 'applicationId', 'runId', 'role', 'hostId', 'databaseId', 'serviceId', 'cluster', 'namespace', 'workload', 'pod', 'node'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type ObsFilterValues = Partial<Record<FilterKey, string[]>>;

/** Short URL parameter names (kept distinct from the run-centric pages' own params). */
export const URL_KEYS: Record<FilterKey, string> = {
  projectId: 'project', environmentId: 'env', applicationId: 'app', runId: 'run', role: 'role', hostId: 'host', databaseId: 'db', serviceId: 'svc',
  cluster: 'cluster', namespace: 'ns', workload: 'workload', pod: 'pod', node: 'node',
};
const TIME_KEYS = ['range', 'from', 'to', 'tz', 'refresh'];
export const OBS_URL_PARAMS = [...TIME_KEYS, ...Object.values(URL_KEYS)];

export interface ObsUrlState { time: ObsTime; tz: Tz; refreshSec: number; filters: ObsFilterValues }

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Write the observability state into a copy of `base`, keeping unrelated params. */
export function writeUrlState(s: ObsUrlState, base?: URLSearchParams | string): URLSearchParams {
  const p = new URLSearchParams(base ?? '');
  for (const k of OBS_URL_PARAMS) p.delete(k);
  if (s.time.mode === 'relative') p.set('range', s.time.key);
  else { p.set('from', iso(s.time.from)); p.set('to', iso(s.time.to)); }
  if (s.tz === 'utc') p.set('tz', 'utc');
  if (s.time.mode === 'relative' && s.refreshSec > 0) p.set('refresh', String(s.refreshSec));
  for (const k of FILTER_KEYS) {
    const v = s.filters[k];
    if (v?.length) p.set(URL_KEYS[k], v.join(','));
  }
  return p;
}

/** Only the observability part of a query string, canonicalised (for change detection). */
export function obsUrlPart(search: URLSearchParams | string): string {
  const p = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const k of OBS_URL_PARAMS) { const v = p.get(k); if (v != null && v !== '') out.set(k, v); }
  return out.toString();
}

/** Parse observability state from a query string; returns null when it has no observability params. */
export function readUrlState(search: URLSearchParams | string): ObsUrlState | null {
  const p = new URLSearchParams(search);
  if (!OBS_URL_PARAMS.some((k) => p.has(k))) return null;
  let time: ObsTime = { mode: 'relative', key: DEFAULT_RANGE };
  const range = p.get('range');
  const from = p.get('from') ? Date.parse(p.get('from')!) : NaN;
  const to = p.get('to') ? Date.parse(p.get('to')!) : NaN;
  if (Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= MAX_WINDOW_MS) time = { mode: 'absolute', from, to };
  else if (range && quick(range)) time = { mode: 'relative', key: range as QuickKey };
  const refresh = Number(p.get('refresh') ?? 0);
  const filters: ObsFilterValues = {};
  for (const k of FILTER_KEYS) {
    const v = p.get(URL_KEYS[k]);
    if (v) filters[k] = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
  }
  return {
    time,
    tz: p.get('tz') === 'utc' ? 'utc' : 'local',
    refreshSec: time.mode === 'relative' && REFRESH_OPTIONS.some((r) => r.sec === refresh) ? refresh : 0,
    filters,
  };
}

/** API query parameters (contract names, comma-separated lists). */
export function apiFilterParams(filters: ObsFilterValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILTER_KEYS) { const v = filters[k]; if (v?.length) out[k] = v.join(','); }
  return out;
}

export const toIso = iso;
