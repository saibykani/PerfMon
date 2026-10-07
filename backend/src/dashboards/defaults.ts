import { tx } from '../db/pool.js';
import type { PanelQuery, PanelType } from './query.js';

/**
 * Default (system) dashboards, one set per project. Idempotent: identified by a deterministic
 * uid per project; existing dashboards (including user edits to them) are never overwritten.
 */
interface P { title: string; type: PanelType; query: PanelQuery; grid: [number, number, number, number]; options?: Record<string, unknown> }
interface V { name: string; label: string; type: string; defaultValue?: string | null; multi?: boolean; includeAll?: boolean }
interface D { slug: string; name: string; description: string; tags: string[]; timeRange: Record<string, unknown>; refresh?: number | null; variables: V[]; panels: P[] }

const projectVar = (projectId: string): V => ({ name: 'project', label: 'Project', type: 'project', defaultValue: projectId, includeAll: false });
const envVar: V = { name: 'environment', label: 'Environment', type: 'environment', includeAll: true };
const testVar: V = { name: 'test', label: 'Test', type: 'test', includeAll: true };
const runVar: V = { name: 'run', label: 'Run ID', type: 'run', includeAll: true };

/** Layout helper: rows of panels, 12-column grid. */
function grid(rows: [number, Omit<P, 'grid'>[]][]): P[] {
  const out: P[] = [];
  let y = 0;
  for (const [h, panels] of rows) {
    const w = Math.floor(12 / panels.length);
    panels.forEach((p, i) => out.push({ ...p, grid: [i * w, y, i === panels.length - 1 ? 12 - i * w : w, h] }));
    y += h;
  }
  return out;
}
const kpi = (title: string, metric: string): Omit<P, 'grid'> => ({ title, type: 'kpi', query: { source: 'kpi', metric } });

export function defaultDashboards(projectId: string): D[] {
  const pv = projectVar(projectId);
  return [
    {
      slug: 'executive', name: 'Executive Performance', tags: ['executive', 'system'], timeRange: { type: 'relative', value: '30d' },
      description: 'Release readiness at a glance: pass rate, SLA compliance, throughput and latency trends, regressions.',
      variables: [pv, envVar, testVar],
      panels: grid([
        [3, [
          { title: 'Completed runs', type: 'stat', query: { source: 'runs', metric: 'runs' } },
          { title: 'Pass rate', type: 'stat', query: { source: 'runs', metric: 'pass_rate' } },
          { title: 'Latest SLA compliance', type: 'sla_gauge', query: { source: 'sla' } },
          { title: 'Avg TPS', type: 'stat', query: { source: 'runs', metric: 'tps', aggregation: 'avg' } },
          { title: 'Latest P95', type: 'stat', query: { source: 'runs', metric: 'p95', aggregation: 'last' } },
          { title: 'Active regressions', type: 'stat', query: { source: 'regressions' } },
        ]],
        [8, [
          { title: 'P95 / P99 by run', type: 'line', query: { source: 'runs', metrics: ['p95', 'p99'] } },
          { title: 'Throughput by run', type: 'line', query: { source: 'runs', metric: 'tps' } },
        ]],
        [8, [
          { title: 'Performance score by build', type: 'bar', query: { source: 'runs', metric: 'score', groupBy: 'build', aggregation: 'last' } },
          { title: 'SLA compliance trend', type: 'line', query: { source: 'sla' } },
        ]],
        [8, [
          { title: 'Recent regressions', type: 'timeline', query: { source: 'regressions', limit: 10 } },
          { title: 'Recent runs', type: 'table', query: { source: 'runs', limit: 10 } },
        ]],
      ]),
    },
    {
      slug: 'jmeter', name: 'JMeter Test', tags: ['jmeter', 'run', 'system'], timeRange: { type: 'relative', value: '24h' }, refresh: 10,
      description: 'Single-run deep dive: users, throughput, percentiles, errors and transactions (latest run unless $run is set).',
      variables: [pv, envVar, testVar, runVar, { name: 'transaction', label: 'Transaction', type: 'transaction', includeAll: true }],
      panels: grid([
        [3, [kpi('TPS', 'tps'), kpi('P95', 'p95'), kpi('P99', 'p99'), kpi('Error %', 'error_pct'), kpi('Peak users', 'users'), kpi('Requests', 'requests')]],
        [8, [
          { title: 'Active users', type: 'users', query: { source: 'run_series', metric: 'users' } },
          { title: 'Throughput (TPS)', type: 'tps', query: { source: 'run_series', metric: 'tps' } },
        ]],
        [8, [
          { title: 'Response time percentiles', type: 'percentiles', query: { source: 'run_series', metrics: ['p50', 'p90', 'p95', 'p99'] } },
          { title: 'Error rate', type: 'area', query: { source: 'run_series', metric: 'error_pct' } },
        ]],
        [8, [
          { title: 'Slowest transactions (P95)', type: 'transaction_ranking', query: { source: 'transactions', metric: 'p95', limit: 10 } },
          { title: 'Errors by response code', type: 'error_distribution', query: { source: 'errors', groupBy: 'response_code' } },
        ]],
        [8, [{ title: 'Latency heatmap', type: 'latency_heatmap', query: { source: 'latency_heatmap' } }]],
        [10, [{ title: 'Transactions', type: 'table', query: { source: 'transactions', metric: 'p95' } }]],
      ]),
    },
    {
      slug: 'infrastructure', name: 'Infrastructure', tags: ['infrastructure', 'system'], timeRange: { type: 'relative', value: '6h' }, refresh: 30,
      description: 'Server CPU, memory, disk and network; JVM heap/GC; database latency and connections. Scope with $server or $run.',
      variables: [pv, envVar, { name: 'server', label: 'Server', type: 'server', includeAll: true, multi: true }, runVar],
      panels: grid([
        [3, [
          { title: 'CPU avg', type: 'gauge', query: { source: 'infra', metric: 'cpu_pct', aggregation: 'avg' } },
          { title: 'CPU max', type: 'stat', query: { source: 'infra', metric: 'cpu_pct', aggregation: 'max' } },
          { title: 'Memory max', type: 'gauge', query: { source: 'infra', metric: 'memory_pct', aggregation: 'max' } },
          { title: 'Heap max', type: 'gauge', query: { source: 'jvm', metric: 'heap_pct', aggregation: 'max' } },
        ]],
        [8, [
          { title: 'CPU by server', type: 'line', query: { source: 'infra', metric: 'cpu_pct', groupBy: 'server' } },
          { title: 'Memory by server', type: 'line', query: { source: 'infra', metric: 'memory_pct', groupBy: 'server' } },
        ]],
        [8, [
          { title: 'Disk usage', type: 'line', query: { source: 'infra', metric: 'disk_pct', groupBy: 'server' } },
          { title: 'Network throughput', type: 'area', query: { source: 'infra', metric: 'net_bps', groupBy: 'server' } },
        ]],
        [8, [
          { title: 'JVM heap %', type: 'line', query: { source: 'jvm', metric: 'heap_pct', groupBy: 'server' } },
          { title: 'GC max pause', type: 'line', query: { source: 'jvm', metric: 'gc_pause_ms', aggregation: 'max', groupBy: 'server' } },
        ]],
        [8, [
          { title: 'DB query latency', type: 'line', query: { source: 'database', metric: 'db_latency_ms', groupBy: 'server' } },
          { title: 'DB active connections', type: 'line', query: { source: 'database', metric: 'db_connections', aggregation: 'max', groupBy: 'server' } },
        ]],
        [8, [{ title: 'Servers', type: 'table', query: { source: 'infra', metric: 'cpu_pct' } }]],
      ]),
    },
    {
      slug: 'application', name: 'Application', tags: ['application', 'system'], timeRange: { type: 'relative', value: '24h' },
      description: 'Application view of a run: latency and errors, endpoints, JVM health and bottlenecks.',
      variables: [pv, { name: 'application', label: 'Application', type: 'application', includeAll: true }, envVar, runVar],
      panels: grid([
        [3, [kpi('Avg RT', 'avg_rt'), kpi('P95', 'p95'), kpi('Error %', 'error_pct'), kpi('CPU avg', 'cpu_pct'), kpi('Heap max', 'heap_pct'), kpi('DB latency', 'db_latency_ms')]],
        [8, [
          { title: 'Response time (avg / P95)', type: 'line', query: { source: 'run_series', metrics: ['avg_rt', 'p95'] } },
          { title: 'Errors over time by type', type: 'line', query: { source: 'errors' } },
        ]],
        [8, [
          { title: 'Slowest endpoints (P95)', type: 'endpoint_ranking', query: { source: 'endpoints', metric: 'p95', limit: 10 } },
          { title: 'Errors by type', type: 'donut', query: { source: 'errors', groupBy: 'error_type' } },
        ]],
        [8, [
          { title: 'JVM threads', type: 'line', query: { source: 'jvm', metric: 'threads' } },
          { title: 'Bottleneck analysis', type: 'bottleneck', query: { source: 'bottleneck' } },
        ]],
      ]),
    },
    {
      slug: 'api', name: 'API Performance', tags: ['api', 'endpoints', 'system'], timeRange: { type: 'relative', value: '7d' },
      description: 'Normalized API endpoints: ranking, latency over time, response codes and endpoint trends across builds.',
      variables: [pv, { name: 'application', label: 'Application', type: 'application', includeAll: true }, runVar, { name: 'endpoint', label: 'Endpoint', type: 'endpoint', includeAll: true, multi: true }],
      panels: grid([
        [8, [
          { title: 'Endpoints by P95', type: 'endpoint_ranking', query: { source: 'endpoints', metric: 'p95', limit: 15 } },
          { title: 'Endpoint latency over time (P95)', type: 'line', query: { source: 'endpoints', metric: 'p95', limit: 8 } },
        ]],
        [8, [
          { title: 'Endpoint throughput', type: 'line', query: { source: 'endpoints', metric: 'tps', limit: 8 } },
          { title: 'Response codes', type: 'donut', query: { source: 'errors', groupBy: 'response_code' } },
        ]],
        [8, [{ title: 'Transaction P95 across builds', type: 'line', query: { source: 'transactions', metric: 'p95', groupBy: 'build', limit: 8 } }]],
        [10, [{ title: 'Endpoints', type: 'table', query: { source: 'endpoints', metric: 'p95' } }]],
      ]),
    },
    {
      slug: 'sla', name: 'SLA', tags: ['sla', 'slo', 'system'], timeRange: { type: 'relative', value: '30d' },
      description: 'SLA/SLO compliance for the selected run and across runs, with violations by transaction.',
      variables: [pv, envVar, testVar, runVar],
      panels: grid([
        [5, [
          { title: 'SLA compliance', type: 'sla_gauge', query: { source: 'sla' } },
          { title: 'Assertions by status', type: 'donut', query: { source: 'sla' } },
          { title: 'Violations by transaction', type: 'bar', query: { source: 'sla', groupBy: 'transaction' } },
        ]],
        [8, [{ title: 'Compliance trend', type: 'line', query: { source: 'sla' } }]],
        [10, [{ title: 'SLA results', type: 'table', query: { source: 'sla' } }]],
      ]),
    },
    {
      slug: 'regression', name: 'Regression', tags: ['regression', 'system'], timeRange: { type: 'relative', value: '30d' },
      description: 'Regressions vs baseline and latency/throughput trends across builds.',
      variables: [pv, envVar, testVar, { name: 'transaction', label: 'Transaction', type: 'transaction', includeAll: true, multi: true }],
      panels: grid([
        [3, [
          { title: 'Regressions', type: 'stat', query: { source: 'regressions' } },
          { title: 'Latest P95', type: 'stat', query: { source: 'runs', metric: 'p95', aggregation: 'last' } },
          { title: 'Latest TPS', type: 'stat', query: { source: 'runs', metric: 'tps', aggregation: 'last' } },
          { title: 'Latest error %', type: 'stat', query: { source: 'runs', metric: 'error_pct', aggregation: 'last' } },
        ]],
        [8, [
          { title: 'P95 by build', type: 'line', query: { source: 'runs', metrics: ['p95', 'p99'], groupBy: 'build' } },
          { title: 'Transaction P95 by build', type: 'line', query: { source: 'transactions', metric: 'p95', groupBy: 'build', limit: 8 } },
        ]],
        [8, [
          { title: 'Regressions by metric', type: 'bar', query: { source: 'regressions', groupBy: 'transaction' } },
          { title: 'Latest findings', type: 'timeline', query: { source: 'regressions', limit: 15 } },
        ]],
        [10, [{ title: 'All regressions & improvements', type: 'table', query: { source: 'regressions' } }]],
      ]),
    },
    {
      slug: 'capacity', name: 'Capacity', tags: ['capacity', 'scalability', 'system'], timeRange: { type: 'relative', value: '90d' },
      description: 'Load vs latency across runs, users vs throughput within a run, and saturation signals. Capacity projections are estimates.',
      variables: [pv, envVar, testVar, runVar],
      panels: grid([
        [3, [
          { title: 'Peak TPS observed', type: 'stat', query: { source: 'runs', metric: 'tps', aggregation: 'max' } },
          { title: 'Peak users', type: 'stat', query: { source: 'runs', metric: 'users', aggregation: 'max' } },
          { title: 'CPU avg (latest run)', type: 'gauge', query: { source: 'kpi', metric: 'cpu_pct' } },
        ]],
        [8, [
          { title: 'P95 vs TPS (all runs)', type: 'scatter', query: { source: 'runs', metrics: ['tps', 'p95'] } },
          { title: 'Users and throughput (run)', type: 'line', query: { source: 'run_series', metrics: ['users', 'tps'] } },
        ]],
        [8, [
          { title: 'CPU during run', type: 'line', query: { source: 'infra', metric: 'cpu_pct', groupBy: 'server' } },
          { title: 'Saturation & bottlenecks', type: 'bottleneck', query: { source: 'bottleneck' } },
        ]],
        [4, [{ title: 'About capacity estimates', type: 'text', query: { source: 'text', markdown: 'Capacity figures are **estimates** derived from measured runs. Use *Capacity Planning* for projections with stated assumptions and confidence, and validate with a load test at the target level.' } }]],
      ]),
    },
    {
      slug: 'comparison', name: 'Run Comparison', tags: ['comparison', 'system'], timeRange: { type: 'relative', value: '30d' },
      description: 'Select two or more Run IDs ($run, multi) to compare KPIs, transactions and response-time curves.',
      variables: [pv, testVar, { name: 'run', label: 'Runs', type: 'run', multi: true, includeAll: false }],
      panels: grid([
        [8, [
          { title: 'Latency by run', type: 'bar', query: { source: 'runs', metrics: ['avg_rt', 'p95', 'p99'], groupBy: 'run' } },
          { title: 'Throughput & errors by run', type: 'bar', query: { source: 'runs', metrics: ['tps', 'error_pct'], groupBy: 'run' } },
        ]],
        [8, [
          { title: 'P95 over elapsed time', type: 'line', query: { source: 'run_series', metric: 'p95' } },
          { title: 'Transaction P95 by run', type: 'bar', query: { source: 'transactions', metric: 'p95', groupBy: 'run', limit: 8 } },
        ]],
        [8, [{ title: 'Runs', type: 'table', query: { source: 'runs' } }]],
      ]),
    },
  ];
}

export const defaultUid = (slug: string, projectId: string) => `${slug}-${projectId.replace(/-/g, '')}`;

/** Create the 9 default dashboards for a project. Idempotent by uid. Returns the number created. */
export async function seedDefaultDashboards(orgId: string, projectId: string) {
  let created = 0;
  for (const d of defaultDashboards(projectId)) {
    created += await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO dashboards (organization_id, project_id, uid, name, description, tags, is_system, is_shared, time_range, refresh_interval)
         VALUES ($1,$2,$3,$4,$5,$6,true,true,$7,$8) ON CONFLICT (uid) DO NOTHING RETURNING id`,
        [orgId, projectId, defaultUid(d.slug, projectId), d.name, d.description, d.tags, JSON.stringify(d.timeRange), d.refresh ?? null]);
      const id = ins.rows[0]?.id;
      if (!id) return 0;
      let pos = 0;
      for (const p of d.panels) {
        await c.query(`INSERT INTO dashboard_panels (dashboard_id, title, type, query, options, grid_x, grid_y, grid_w, grid_h, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, p.title, p.type, JSON.stringify(p.query), JSON.stringify(p.options ?? {}), p.grid[0], p.grid[1], p.grid[2], p.grid[3], pos++]);
      }
      pos = 0;
      for (const v of d.variables) {
        await c.query(`INSERT INTO dashboard_variables (dashboard_id, name, label, type, default_value, multi, include_all, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, v.name, v.label, v.type, v.defaultValue ?? null, v.multi ?? false, v.includeAll ?? true, pos++]);
      }
      return 1;
    });
  }
  return created;
}
