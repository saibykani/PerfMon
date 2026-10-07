import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, CheckCircle2, Info, Minus, Table2, TrendingDown, TrendingUp, XCircle } from 'lucide-react';
import { api } from '@/services/api';
import { useFilters, resolveRange, rangeLabel } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Loading, PageHeader } from '@/components/ui';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtDate } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { runTrendOption, unitFormatter } from '@/charts/builders';
import '@/styles/overview.css';

type MetricKey = 'p95' | 'p99' | 'avgRt' | 'tps' | 'errorPct' | 'cpuAvg' | 'slaPassPct' | 'score';
interface TrendPoint { key: string; label: string; runKey: string; runId: string; startedAt: string; buildNumber: string | null; releaseVersion: string | null; metrics: Record<MetricKey, number | null> }
interface Degradation { metric: string; direction: 'DEGRADING' | 'IMPROVING' | 'STABLE'; slopePerStep: number; r2: number; consecutiveWorse: number; changePct: number | null; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string }
interface TrendResponse { groupBy: string; points: TrendPoint[]; degradation: Degradation[] }

const METRICS: { key: MetricKey; label: string; unit: string; slot: string | number; better: 'lower' | 'higher'; max?: number }[] = [
  { key: 'p95', label: 'P95 response time', unit: 'ms', slot: 'p95', better: 'lower' },
  { key: 'p99', label: 'P99 response time', unit: 'ms', slot: 'p99', better: 'lower' },
  { key: 'avgRt', label: 'Average response time', unit: 'ms', slot: 'avg', better: 'lower' },
  { key: 'tps', label: 'Throughput', unit: 'tps', slot: 'tps', better: 'higher' },
  { key: 'errorPct', label: 'Error rate', unit: '%', slot: 'errorPct', better: 'lower' },
  { key: 'cpuAvg', label: 'CPU average', unit: '%', slot: 4, better: 'lower', max: 100 },
  { key: 'slaPassPct', label: 'SLA compliance', unit: '%', slot: 2, better: 'higher', max: 100 },
  { key: 'score', label: 'Performance score', unit: '', slot: 6, better: 'higher', max: 100 },
];
const GROUPS = [{ key: 'build', label: 'Build' }, { key: 'release', label: 'Release' }, { key: 'date', label: 'Date (each run)' }] as const;
const LS = 'perfmon.trends.metrics';

function DegChip({ d }: { d?: Degradation }) {
  if (!d) return null;
  if (d.direction === 'STABLE') return <span className="tr-chip flat"><Minus size={10} />Stable</span>;
  const pct = d.changePct != null ? `${d.changePct > 0 ? '+' : ''}${d.changePct.toFixed(0)}%` : '';
  if (d.direction === 'IMPROVING') return <span className="tr-chip good" title={d.message}><CheckCircle2 size={10} />Improving {pct}</span>;
  return <span className={`tr-chip ${d.severity === 'CRITICAL' ? 'bad' : 'warnc'}`} title={d.message}>{d.severity === 'CRITICAL' ? <XCircle size={10} /> : <AlertTriangle size={10} />}Degrading {pct}</span>;
}

export function TrendsPage() {
  const nav = useNavigate();
  const f = useFilters();
  const theme = useUi((s) => s.theme);
  const [groupBy, setGroupBy] = useState<'build' | 'release' | 'date'>('date');
  const [view, setView] = useState<'charts' | 'table'>('charts');
  const [sel, setSel] = useState<MetricKey[]>(() => { try { const v = JSON.parse(localStorage.getItem(LS) ?? 'null'); if (Array.isArray(v) && v.length) return v; } catch { /* ignore */ } return METRICS.map((m) => m.key); });
  const toggle = (k: MetricKey) => {
    const next = sel.includes(k) ? sel.filter((x) => x !== k) : METRICS.map((m) => m.key).filter((x) => x === k || sel.includes(x));
    if (!next.length) return;
    setSel(next);
    try { localStorage.setItem(LS, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const rangeKey = f.timeRange.type === 'relative' ? f.timeRange.value : `${f.timeRange.from}-${f.timeRange.to}`;
  const q = useQuery({
    queryKey: ['trends', f.projectId, f.applicationId, f.environmentId, f.testId, groupBy, rangeKey],
    queryFn: () => {
      const r = resolveRange(f.timeRange);
      return api.get<TrendResponse>('/trends', { projectId: f.projectId, applicationId: f.applicationId, environmentId: f.environmentId, testId: f.testId, groupBy, from: r?.from, to: r?.to });
    },
  });
  const pts = q.data?.points ?? [];
  const deg = q.data?.degradation ?? [];
  const degBy = useMemo(() => new Map(deg.map((d) => [d.metric, d])), [deg]);
  const callouts = deg.filter((d) => d.direction !== 'STABLE').sort((a, b) => ({ CRITICAL: 0, WARNING: 1, INFO: 2 }[a.severity] - { CRITICAL: 0, WARNING: 1, INFO: 2 }[b.severity]) || (a.direction === 'DEGRADING' ? -1 : 1));
  const labels = pts.map((p) => p.label);
  const openPoint = (p: any) => { const pt = pts[p.dataIndex]; if (pt) nav(`/runs/${pt.runKey}`); };

  const tooltip = (unit: string) => {
    const fmt = unitFormatter(unit);
    return {
      trigger: 'axis', formatter: (ps: any[]) => {
        const pt = pts[ps[0]?.dataIndex];
        if (!pt) return '';
        return `<b>${pt.label}</b><br/><span style="opacity:.7">${pt.runKey} · ${fmtDate(pt.startedAt)}${pt.releaseVersion ? ` · rel ${pt.releaseVersion}` : ''}</span><br/>${ps.map((p) => `${p.marker}${p.seriesName}: <b>${fmt(p.value)}</b>`).join('<br/>')}<br/><span style="opacity:.6">Click to open run</span>`;
      },
    };
  };

  const options = useMemo(() => Object.fromEntries(METRICS.map((m) => {
    const o: any = runTrendOption({ theme, labels, unit: m.unit, series: [{ name: m.label, key: typeof m.slot === 'string' ? m.slot : undefined, slot: typeof m.slot === 'number' ? m.slot : undefined, data: pts.map((p) => p.metrics[m.key]), area: true }], min: m.max ? 0 : undefined, max: m.max });
    o.tooltip = tooltip(m.unit);
    o.xAxis = { ...o.xAxis, axisLabel: { hideOverlap: true, width: 90, overflow: 'truncate' } };
    return [m.key, o];
  })), [pts, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols: Column<TrendPoint>[] = [
    { key: 'label', header: GROUPS.find((g) => g.key === groupBy)?.label ?? 'Point' },
    { key: 'runKey', header: 'Run', render: (p) => <span className="mono link-like">{p.runKey}</span> },
    { key: 'startedAt', header: 'Started', render: (p) => fmtDate(p.startedAt) },
    { key: 'buildNumber', header: 'Build', hidden: groupBy === 'build' },
    { key: 'releaseVersion', header: 'Release', hidden: groupBy === 'release' },
    ...METRICS.map((m): Column<TrendPoint> => ({ key: m.key, header: m.label.replace(' response time', ''), align: 'right', value: (p) => p.metrics[m.key], render: (p) => unitFormatter(m.unit)(p.metrics[m.key]) })),
  ];
  const stats = (k: MetricKey) => {
    const vals = pts.map((p) => p.metrics[k]).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return { last: vals[vals.length - 1], first: vals[0] };
  };

  return (
    <div>
      <PageHeader title="Trends" subtitle="How performance moves across builds, releases and time — with automatic degradation detection." />
      <GlobalFilterBar show={['project', 'application', 'environment', 'test', 'time']} />
      <div className="tr-controls">
        <div className="seg" role="group" aria-label="Group by">
          {GROUPS.map((g) => <button key={g.key} className={groupBy === g.key ? 'on' : ''} onClick={() => setGroupBy(g.key)}>By {g.label.toLowerCase()}</button>)}
        </div>
        <div className="chips">
          {METRICS.map((m) => <button key={m.key} className={`chip ${sel.includes(m.key) ? 'on' : ''}`} aria-pressed={sel.includes(m.key)} onClick={() => toggle(m.key)}>{m.label.replace(' response time', '')}</button>)}
        </div>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="View">
          <button className={view === 'charts' ? 'on' : ''} onClick={() => setView('charts')}><BarChart3 size={13} /> Charts</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}><Table2 size={13} /> Table</button>
        </div>
      </div>
      {!f.testId && pts.length > 0 && <div className="ov-focus"><Info size={14} />Showing all tests in scope — pick a test for a clean like-for-like trend (degradation is detected per test and environment).</div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <div className="tr-grid">{Array.from({ length: 6 }).map((_, i) => <Loading key={i} height={250} />)}</div>
      ) : !pts.length ? (
        <div className="card ov-empty">
          <div className="ov-empty-art"><TrendingUp size={28} /></div>
          <h2>No completed runs to trend</h2>
          <p className="muted">Nothing matches {(rangeLabel(f.timeRange) ?? '').toLowerCase()} with the current filters. Trends need at least two completed runs of the same test.</p>
          <div className="row"><button className="btn" onClick={() => f.set({ timeRange: { type: 'relative', value: '90d' } })}>Show last 90 days</button><Link className="btn btn-primary" to="/runs">Browse runs</Link></div>
        </div>
      ) : (
        <div className="stack">
          {callouts.length > 0 ? (
            <div className="tr-callouts" aria-label="Degradation callouts">
              {callouts.map((d) => {
                const improving = d.direction === 'IMPROVING';
                const Icon = improving ? TrendingDown : d.severity === 'CRITICAL' ? XCircle : d.severity === 'WARNING' ? AlertTriangle : TrendingUp;
                const m = METRICS.find((x) => x.key === d.metric);
                return (
                  <div key={d.metric} className={`callout ${improving ? 'improving' : d.severity}`}>
                    <span className="callout-ico"><Icon size={14} /></span>
                    <div>
                      <div className="callout-title">{d.message}</div>
                      <div className="callout-sub">{m?.label ?? d.metric} · {improving ? 'improving' : d.severity.toLowerCase()} · {d.consecutiveWorse} consecutive worse step{d.consecutiveWorse === 1 ? '' : 's'} · fit R² {d.r2.toFixed(2)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : pts.length > 1 && <div className="callout improving"><span className="callout-ico"><CheckCircle2 size={14} /></span><div><div className="callout-title">No sustained degradation detected</div><div className="callout-sub">All tracked metrics are stable across {pts.length} points.</div></div></div>}

          {view === 'charts' ? (
            <div className="tr-grid">
              {METRICS.filter((m) => sel.includes(m.key)).map((m) => {
                const s = stats(m.key);
                const hasData = !!s;
                return (
                  <Chart key={m.key} title={m.label} subtitle={hasData ? `latest ${unitFormatter(m.unit)(s!.last)}` : 'no data'} option={options[m.key]} height={190} group="trends"
                    onPointClick={openPoint} empty={hasData ? null : 'No values recorded for this metric'}
                    actions={<DegChip d={degBy.get(m.key)} />}
                    table={{ columns: ['Point', 'Run', m.label], rows: pts.map((p) => [p.label, p.runKey, p.metrics[m.key] == null ? null : +p.metrics[m.key]!.toFixed(2)]) }} />
                );
              })}
            </div>
          ) : (
            <Card noPad title={`${pts.length} points`}>
              <DataTable rows={pts} columns={cols} rowKey={(p) => p.key + p.runKey} onRowClick={(p) => nav(`/runs/${p.runKey}`)} exportName={`trends-by-${groupBy}`} maxHeight={600} />
            </Card>
          )}
          <div className="muted" style={{ fontSize: 11.5 }}>
            Degradation = sustained worsening fitted over consecutive {groupBy === 'date' ? 'runs' : `${groupBy}s`} (slope + consecutive worse steps). Click any point to open its run.
          </div>
        </div>
      )}
    </div>
  );
}
