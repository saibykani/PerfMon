/**
 * Widget catalog + metric abstraction vocabulary used by the panel editor.
 * Everything here maps onto the PanelQuery model (never raw PromQL/Flux).
 */
import type { Aggregation, GroupBy, Panel, PanelOptions, PanelQuery, PanelType, QuerySource, VariableType } from './types';

export const METRICS: { key: string; label: string; unit: string; better: 'lower' | 'higher'; slot: string | number }[] = [
  { key: 'tps', label: 'Throughput (TPS)', unit: 'tps', better: 'higher', slot: 'tps' },
  { key: 'requests', label: 'Requests', unit: '', better: 'higher', slot: 'requests' },
  { key: 'avg_rt', label: 'Avg response time', unit: 'ms', better: 'lower', slot: 'avg' },
  { key: 'p50', label: 'P50', unit: 'ms', better: 'lower', slot: 'p50' },
  { key: 'p90', label: 'P90', unit: 'ms', better: 'lower', slot: 'p90' },
  { key: 'p95', label: 'P95', unit: 'ms', better: 'lower', slot: 'p95' },
  { key: 'p99', label: 'P99', unit: 'ms', better: 'lower', slot: 'p99' },
  { key: 'max_rt', label: 'Max response time', unit: 'ms', better: 'lower', slot: 'max' },
  { key: 'error_pct', label: 'Error %', unit: '%', better: 'lower', slot: 'errorPct' },
  { key: 'errors', label: 'Errors', unit: '', better: 'lower', slot: 'errors' },
  { key: 'users', label: 'Active users', unit: '', better: 'higher', slot: 'users' },
  { key: 'cpu_pct', label: 'CPU %', unit: '%', better: 'lower', slot: 'cpu' },
  { key: 'memory_pct', label: 'Memory %', unit: '%', better: 'lower', slot: 'memory' },
  { key: 'disk_pct', label: 'Disk %', unit: '%', better: 'lower', slot: 'disk' },
  { key: 'net_bps', label: 'Network', unit: 'B/s', better: 'lower', slot: 'network' },
  { key: 'heap_pct', label: 'JVM heap %', unit: '%', better: 'lower', slot: 1 },
  { key: 'gc_pause_ms', label: 'GC pause', unit: 'ms', better: 'lower', slot: 3 },
  { key: 'threads', label: 'Threads', unit: '', better: 'lower', slot: 'threads' },
  { key: 'db_latency_ms', label: 'DB latency', unit: 'ms', better: 'lower', slot: 4 },
  { key: 'db_connections', label: 'DB connections', unit: '', better: 'lower', slot: 6 },
  { key: 'sla_pass_pct', label: 'SLA pass %', unit: '%', better: 'higher', slot: 2 },
  { key: 'score', label: 'Performance score', unit: '', better: 'higher', slot: 6 },
];
export const metricDef = (k?: string) => METRICS.find((m) => m.key === k);

export const SOURCES: { key: QuerySource; label: string; hint: string; metrics?: string[]; groupBy?: GroupBy[] }[] = [
  { key: 'run_series', label: 'Run time series', hint: 'Metric over the run timeline', metrics: ['tps', 'requests', 'avg_rt', 'p50', 'p90', 'p95', 'p99', 'max_rt', 'error_pct', 'errors', 'users'], groupBy: ['transaction'] },
  { key: 'kpi', label: 'Run KPI', hint: 'Single value for the selected/latest run', metrics: ['tps', 'avg_rt', 'p50', 'p90', 'p95', 'p99', 'error_pct', 'users', 'cpu_pct', 'memory_pct', 'sla_pass_pct', 'score', 'requests'] },
  { key: 'runs', label: 'Runs (cross-run)', hint: 'One point per run across the time range', metrics: ['tps', 'avg_rt', 'p95', 'p99', 'error_pct', 'users', 'sla_pass_pct', 'score', 'cpu_pct'], groupBy: ['run', 'build', 'release', 'environment', 'test', 'day'] },
  { key: 'transactions', label: 'Transactions', hint: 'Per-transaction aggregates', metrics: ['p95', 'p99', 'p90', 'avg_rt', 'tps', 'error_pct', 'errors', 'requests'], groupBy: ['transaction'] },
  { key: 'endpoints', label: 'Endpoints', hint: 'Per-endpoint (normalised URL) aggregates', metrics: ['p95', 'p99', 'avg_rt', 'tps', 'error_pct', 'requests'], groupBy: ['endpoint'] },
  { key: 'errors', label: 'Errors', hint: 'Errors by response code / type', metrics: ['errors', 'error_pct'], groupBy: ['response_code', 'error_type', 'transaction'] },
  { key: 'infra', label: 'Infrastructure', hint: 'Server metrics', metrics: ['cpu_pct', 'memory_pct', 'disk_pct', 'net_bps'], groupBy: ['server'] },
  { key: 'jvm', label: 'JVM', hint: 'Heap, GC, threads', metrics: ['heap_pct', 'gc_pause_ms', 'threads'], groupBy: ['server'] },
  { key: 'database', label: 'Database', hint: 'DB latency and connections', metrics: ['db_latency_ms', 'db_connections'], groupBy: ['server'] },
  { key: 'sla', label: 'SLA', hint: 'SLA compliance', metrics: ['sla_pass_pct'], groupBy: ['run', 'transaction'] },
  { key: 'regressions', label: 'Regressions', hint: 'Detected regressions', groupBy: ['transaction', 'run'] },
  { key: 'latency_heatmap', label: 'Latency heatmap', hint: 'Time × latency bucket distribution' },
  { key: 'bottleneck', label: 'Bottlenecks', hint: 'Bottleneck analysis findings' },
  { key: 'alerts', label: 'Alerts', hint: 'Fired alerts' },
  { key: 'text', label: 'Text', hint: 'Markdown content' },
];
export const sourceDef = (k?: string) => SOURCES.find((s) => s.key === k);

export const GROUP_BY: { key: GroupBy; label: string }[] = [
  { key: 'run', label: 'Run' }, { key: 'build', label: 'Build' }, { key: 'release', label: 'Release' }, { key: 'transaction', label: 'Transaction' },
  { key: 'endpoint', label: 'Endpoint' }, { key: 'server', label: 'Server' }, { key: 'environment', label: 'Environment' }, { key: 'test', label: 'Test' },
  { key: 'day', label: 'Day' }, { key: 'response_code', label: 'Response code' }, { key: 'error_type', label: 'Error type' },
];
export const AGGREGATIONS: Aggregation[] = ['avg', 'max', 'min', 'sum', 'last'];

export const UNITS: { key: string; label: string }[] = [
  { key: '', label: 'Auto' }, { key: 'ms', label: 'Milliseconds' }, { key: '%', label: 'Percent' }, { key: 'tps', label: 'Per second' },
  { key: 'B/s', label: 'Bytes/s' }, { key: 'MB', label: 'Megabytes' }, { key: 'none', label: 'Plain number' },
];

export const PANEL_TYPES: { key: PanelType; label: string }[] = [
  { key: 'stat', label: 'Stat' }, { key: 'kpi', label: 'KPI' }, { key: 'line', label: 'Line' }, { key: 'area', label: 'Area' }, { key: 'bar', label: 'Bar' },
  { key: 'stacked_bar', label: 'Stacked bar' }, { key: 'histogram', label: 'Histogram' }, { key: 'heatmap', label: 'Heatmap' }, { key: 'scatter', label: 'Scatter' },
  { key: 'gauge', label: 'Gauge' }, { key: 'donut', label: 'Donut' }, { key: 'table', label: 'Table' }, { key: 'timeline', label: 'Timeline' },
  { key: 'percentiles', label: 'Percentile chart' }, { key: 'tps', label: 'TPS chart' }, { key: 'error_distribution', label: 'Error distribution' },
  { key: 'sla_gauge', label: 'SLA gauge' }, { key: 'users', label: 'Concurrent users' }, { key: 'latency_heatmap', label: 'Latency heatmap' },
  { key: 'endpoint_ranking', label: 'Endpoint ranking' }, { key: 'transaction_ranking', label: 'Transaction ranking' }, { key: 'bottleneck', label: 'Bottleneck panel' },
  { key: 'text', label: 'Text / Markdown' },
];
export const panelTypeLabel = (t: PanelType) => PANEL_TYPES.find((p) => p.key === t)?.label ?? t;

export type WidgetGroup = 'KPI' | 'Charts' | 'Performance' | 'Content';
export interface Widget {
  id: string; group: WidgetGroup; label: string; description: string; type: PanelType; icon: string;
  query: PanelQuery; options?: PanelOptions; size: { w: number; h: number }; title?: string;
}

const kpi = (metric: string, label: string, extra: Partial<Widget> = {}): Widget => {
  const m = metricDef(metric)!;
  return {
    id: `kpi_${metric}`, group: 'KPI', label, description: `${m.label} for the selected run`, type: 'stat', icon: 'Gauge',
    query: { source: 'kpi', metric, aggregation: 'avg' }, options: { unit: m.unit, better: m.better }, size: { w: 2, h: 3 }, ...extra,
  };
};

export const WIDGETS: Widget[] = [
  kpi('tps', 'TPS'),
  { ...kpi('requests', 'RPS'), id: 'kpi_rps', description: 'Requests per second for the selected run', query: { source: 'kpi', metric: 'tps', aggregation: 'avg' }, title: 'RPS', options: { unit: 'tps', better: 'higher' } },
  kpi('avg_rt', 'Avg response time'),
  kpi('p95', 'P95'),
  kpi('p99', 'P99'),
  kpi('error_pct', 'Error %', { options: { unit: '%', better: 'lower', thresholds: [{ value: 1, level: 'warning' }, { value: 5, level: 'critical' }] } }),
  kpi('users', 'Active users'),
  kpi('cpu_pct', 'CPU', { options: { unit: '%', better: 'lower', thresholds: [{ value: 70, level: 'warning' }, { value: 85, level: 'critical' }] } }),
  kpi('memory_pct', 'Memory', { options: { unit: '%', better: 'lower', thresholds: [{ value: 75, level: 'warning' }, { value: 90, level: 'critical' }] } }),

  { id: 'line', group: 'Charts', label: 'Line chart', description: 'Metric over time', type: 'line', icon: 'LineChart', query: { source: 'run_series', metric: 'p95' }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'area', group: 'Charts', label: 'Area chart', description: 'Filled metric over time', type: 'area', icon: 'AreaChart', query: { source: 'run_series', metric: 'tps' }, options: { unit: 'tps' }, size: { w: 6, h: 7 } },
  { id: 'bar', group: 'Charts', label: 'Bar chart', description: 'Compare categories', type: 'bar', icon: 'BarChart3', query: { source: 'runs', metric: 'p95', groupBy: 'build', limit: 15 }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'stacked_bar', group: 'Charts', label: 'Stacked bar', description: 'Part-to-whole per category', type: 'stacked_bar', icon: 'BarChartBig', query: { source: 'errors', metric: 'errors', groupBy: 'transaction' }, options: {}, size: { w: 6, h: 7 } },
  { id: 'histogram', group: 'Charts', label: 'Histogram', description: 'Distribution of response times', type: 'histogram', icon: 'BarChart2', query: { source: 'transactions', metric: 'avg_rt', groupBy: 'transaction', limit: 20 }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'heatmap', group: 'Charts', label: 'Heatmap', description: 'Two-dimensional density', type: 'heatmap', icon: 'Grid3x3', query: { source: 'latency_heatmap' }, options: {}, size: { w: 6, h: 8 } },
  { id: 'scatter', group: 'Charts', label: 'Scatter', description: 'Individual points over time', type: 'scatter', icon: 'ScatterChart', query: { source: 'run_series', metric: 'p95', groupBy: 'transaction' }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'gauge', group: 'Charts', label: 'Gauge', description: 'Bounded single value', type: 'gauge', icon: 'Gauge', query: { source: 'kpi', metric: 'cpu_pct' }, options: { unit: '%', max: 100 }, size: { w: 3, h: 5 } },
  { id: 'donut', group: 'Charts', label: 'Donut', description: 'Part-to-whole (≤ 6 parts)', type: 'donut', icon: 'PieChart', query: { source: 'errors', metric: 'errors', groupBy: 'response_code' }, options: {}, size: { w: 4, h: 6 } },
  { id: 'table', group: 'Charts', label: 'Table', description: 'Sortable, searchable rows', type: 'table', icon: 'Table2', query: { source: 'transactions', groupBy: 'transaction', limit: 50 }, options: {}, size: { w: 12, h: 8 } },
  { id: 'stat', group: 'Charts', label: 'Stat', description: 'Big number with trend', type: 'stat', icon: 'Hash', query: { source: 'kpi', metric: 'p95' }, options: { unit: 'ms', better: 'lower' }, size: { w: 3, h: 3 } },
  { id: 'timeline', group: 'Charts', label: 'Timeline', description: 'Events and alerts in order', type: 'timeline', icon: 'ListOrdered', query: { source: 'alerts', limit: 20 }, options: {}, size: { w: 6, h: 7 } },

  { id: 'percentiles', group: 'Performance', label: 'Percentile chart', description: 'P50 / P90 / P95 / P99 over time', type: 'percentiles', icon: 'Activity', query: { source: 'run_series', metrics: ['p50', 'p90', 'p95', 'p99'] }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'tps', group: 'Performance', label: 'TPS chart', description: 'Throughput over time', type: 'tps', icon: 'Zap', query: { source: 'run_series', metric: 'tps' }, options: { unit: 'tps' }, size: { w: 6, h: 7 } },
  { id: 'error_distribution', group: 'Performance', label: 'Error distribution', description: 'Errors by response code', type: 'error_distribution', icon: 'AlertTriangle', query: { source: 'errors', metric: 'errors', groupBy: 'response_code' }, options: {}, size: { w: 4, h: 7 } },
  { id: 'sla_gauge', group: 'Performance', label: 'SLA gauge', description: 'SLA pass percentage', type: 'sla_gauge', icon: 'ShieldCheck', query: { source: 'sla', metric: 'sla_pass_pct' }, options: { unit: '%', max: 100 }, size: { w: 3, h: 5 } },
  { id: 'users', group: 'Performance', label: 'Concurrent users', description: 'Active virtual users over time', type: 'users', icon: 'Users', query: { source: 'run_series', metric: 'users' }, options: {}, size: { w: 6, h: 7 } },
  { id: 'latency_heatmap', group: 'Performance', label: 'Latency heatmap', description: 'Response-time distribution over time', type: 'latency_heatmap', icon: 'Flame', query: { source: 'latency_heatmap' }, options: {}, size: { w: 6, h: 8 } },
  { id: 'endpoint_ranking', group: 'Performance', label: 'Endpoint ranking', description: 'Slowest endpoints', type: 'endpoint_ranking', icon: 'ListOrdered', query: { source: 'endpoints', metric: 'p95', groupBy: 'endpoint', limit: 10, sort: 'desc' }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'transaction_ranking', group: 'Performance', label: 'Transaction ranking', description: 'Slowest transactions', type: 'transaction_ranking', icon: 'ListOrdered', query: { source: 'transactions', metric: 'p95', groupBy: 'transaction', limit: 10, sort: 'desc' }, options: { unit: 'ms' }, size: { w: 6, h: 7 } },
  { id: 'bottleneck', group: 'Performance', label: 'Bottleneck panel', description: 'Most likely bottlenecks with evidence', type: 'bottleneck', icon: 'Crosshair', query: { source: 'bottleneck', limit: 5 }, options: {}, size: { w: 6, h: 7 } },

  { id: 'text', group: 'Content', label: 'Text / Markdown', description: 'Notes, links, runbooks', type: 'text', icon: 'FileText', query: { source: 'text', markdown: '### Notes\n\nDescribe what this dashboard is for, link runbooks, add context for viewers.' }, options: {}, size: { w: 4, h: 5 } },
];

export const VARIABLE_TYPES: { key: VariableType; label: string; defaultName: string }[] = [
  { key: 'project', label: 'Project', defaultName: 'project' }, { key: 'application', label: 'Application', defaultName: 'application' },
  { key: 'environment', label: 'Environment', defaultName: 'environment' }, { key: 'test', label: 'Test', defaultName: 'test' },
  { key: 'run', label: 'Run', defaultName: 'run' }, { key: 'transaction', label: 'Transaction', defaultName: 'transaction' },
  { key: 'endpoint', label: 'Endpoint', defaultName: 'endpoint' }, { key: 'server', label: 'Server', defaultName: 'server' },
  { key: 'service', label: 'Service', defaultName: 'service' }, { key: 'build', label: 'Build', defaultName: 'build' },
  { key: 'custom', label: 'Custom values', defaultName: 'custom' },
];

export const newPanelId = () => `p_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/** Place a new panel at the bottom of the grid. */
export function panelFromWidget(w: Widget, panels: Panel[]): Panel {
  const bottom = panels.reduce((m, p) => Math.max(m, p.grid.y + p.grid.h), 0);
  return {
    id: newPanelId(), title: w.title ?? w.label, type: w.type, query: structuredClone(w.query), options: structuredClone(w.options ?? {}),
    grid: { x: 0, y: bottom, w: w.size.w, h: w.size.h },
  };
}

/** Effective unit for a panel: explicit option → result unit → metric unit. */
export function effectiveUnit(opts: PanelOptions, resultUnit?: string, metric?: string) {
  if (opts.unit === 'none') return undefined;
  return opts.unit || resultUnit || metricDef(metric)?.unit || undefined;
}
