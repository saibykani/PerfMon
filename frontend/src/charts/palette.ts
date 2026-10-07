/**
 * Chart palette — validated with the dataviz validator against Perfmon surfaces
 * (light #ffffff, dark #151a21): CVD adjacent ΔE ≥ 8.4, normal-vision ≥ 19.3.
 * Light-mode aqua/yellow/magenta are < 3:1 on white → every chart ships a legend,
 * tooltip and a table view (relief rule).
 *
 * Rules: categorical hues are assigned in FIXED order and follow the entity (never rank);
 * status colors are reserved for state and always paired with an icon/label.
 */
export const CATEGORICAL = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

/** Sequential (blue, light → dark) for heatmaps. */
export const SEQUENTIAL = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export const CHROME = {
  light: { surface: '#ffffff', ink: '#17202b', ink2: '#4a5565', muted: '#7a8494', grid: '#e9ecf0', axis: '#c6ccd5', tooltipBg: '#ffffff', tooltipBorder: '#dde1e7' },
  dark: { surface: '#121214', ink: '#ededef', ink2: '#a9a9b1', muted: '#7a7a84', grid: '#232327', axis: '#37373d', tooltipBg: '#18181b', tooltipBorder: '#37373d' },
};

/**
 * Semantic series → fixed slot, so a metric keeps its color everywhere in the app
 * (TPS is always slot 1, P95 always slot 2, ...).
 */
export const METRIC_SLOT: Record<string, number> = {
  tps: 0, throughput: 0, requests: 0, cpu: 0,
  p95: 1, responseTime: 1, latency: 1, memory: 1,
  users: 2, threads: 2, avg: 2, disk: 2,
  p99: 3, network: 3,
  errors: 7, errorPct: 7,
  p50: 6, p90: 4, max: 5,
};

export function seriesColor(theme: 'light' | 'dark', slotOrKey: number | string) {
  const idx = typeof slotOrKey === 'number' ? slotOrKey : METRIC_SLOT[slotOrKey] ?? 0;
  return CATEGORICAL[theme][idx % 8];
}
