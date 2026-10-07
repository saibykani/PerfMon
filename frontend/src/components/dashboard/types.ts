/** Dashboard model — mirrors docs/architecture/api-contracts.md §5. */
import type { TimeRange } from '@/stores/filters';

export type PanelType =
  | 'kpi' | 'stat' | 'line' | 'area' | 'bar' | 'stacked_bar' | 'histogram' | 'heatmap' | 'scatter' | 'gauge' | 'donut' | 'table' | 'timeline'
  | 'percentiles' | 'tps' | 'error_distribution' | 'sla_gauge' | 'users' | 'latency_heatmap' | 'endpoint_ranking' | 'transaction_ranking' | 'bottleneck' | 'text';

export type QuerySource =
  | 'run_series' | 'runs' | 'transactions' | 'endpoints' | 'infra' | 'jvm' | 'database' | 'sla' | 'regressions' | 'errors' | 'kpi'
  | 'bottleneck' | 'latency_heatmap' | 'alerts' | 'text';

export type Aggregation = 'avg' | 'max' | 'min' | 'sum' | 'last';
export type GroupBy = 'run' | 'build' | 'release' | 'transaction' | 'endpoint' | 'server' | 'environment' | 'test' | 'day' | 'response_code' | 'error_type';

export interface PanelQuery {
  source: QuerySource;
  metric?: string;
  metrics?: string[];
  aggregation?: Aggregation;
  groupBy?: GroupBy;
  limit?: number;
  sort?: 'asc' | 'desc';
  markdown?: string;
}

export interface Threshold { value: number; level: 'warning' | 'critical' }

export interface PanelOptions {
  unit?: string;
  decimals?: number;
  thresholds?: Threshold[];
  better?: 'lower' | 'higher';
  colorSlot?: number;
  showLegend?: boolean;
  stacked?: boolean;
  horizontal?: boolean;
  max?: number;
  description?: string;
  [k: string]: any;
}

export interface GridPos { x: number; y: number; w: number; h: number }

export interface Panel {
  id: string;
  title: string;
  type: PanelType;
  query: PanelQuery;
  options: PanelOptions;
  grid: GridPos;
}

export type VariableType = 'project' | 'application' | 'environment' | 'test' | 'run' | 'transaction' | 'endpoint' | 'server' | 'service' | 'build' | 'custom';

export interface Variable {
  name: string;
  label?: string;
  type: VariableType;
  customValues?: string[];
  defaultValue?: string | null;
  multi?: boolean;
  includeAll?: boolean;
}

export interface DashboardSummary {
  id: string; uid: string; name: string; description: string | null; tags: string[]; projectId: string | null;
  isSystem: boolean; isShared: boolean; ownerName: string | null; updatedAt: string; panelCount: number;
}

export interface Dashboard {
  id: string; uid: string; name: string; description: string | null; tags: string[]; projectId: string | null;
  isSystem: boolean; isShared: boolean; timeRange: TimeRange | null; refreshInterval: number | string | null; version: number;
  panels: Panel[]; variables: Variable[]; updatedAt: string; ownerName?: string | null;
}

export type DashboardBody = Pick<Dashboard, 'name' | 'description' | 'projectId' | 'tags' | 'timeRange' | 'refreshInterval' | 'isShared' | 'panels' | 'variables'>;

export type PanelResult =
  | { kind: 'timeseries'; unit?: string; series: { name: string; key?: string; data: [number, number | null][] }[]; percentileMethod?: string; runKey?: string }
  | { kind: 'stat'; unit?: string; value: number | null; label?: string; delta?: number | null; better?: 'lower' | 'higher'; sparkline?: number[]; status?: 'pass' | 'warn' | 'fail' | null }
  | { kind: 'categories'; unit?: string; categories: string[]; series: { name: string; data: (number | null)[] }[] }
  | { kind: 'table'; columns: { key: string; header: string; unit?: string }[]; rows: Record<string, any>[] }
  | { kind: 'heatmap'; times: number[]; buckets: string[]; cells: [number, number, number][] }
  | { kind: 'items'; items: { title: string; subtitle?: string; severity?: string; value?: string; link?: string }[] }
  | { kind: 'text'; markdown: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

export type VarValues = Record<string, string | string[] | null>;

/** Accepts the dashboard-level refresh as seconds or a duration string ('30s', '1m', '5m'). */
export function refreshToSec(v: number | string | null | undefined): number | null {
  if (v == null || v === '' || v === 'off') return null;
  if (typeof v === 'number') return v > 0 ? v : null;
  const m = /^(\d+)\s*(s|m|h)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}
