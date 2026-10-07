/**
 * Maps a PanelResult (POST /dashboards/query) onto the right visualisation.
 * The result `kind` decides the data shape; the panel `type` refines the presentation
 * (e.g. categories → bar / stacked / ranking / donut, stat → number / gauge).
 */
import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, Info, Inbox, XCircle } from 'lucide-react';
import { Chart } from '@/charts/Chart';
import {
  barOption, donutOption, gaugeOption, heatmapOption, sparklineOption, timeScatterOption, timeSeriesOption, unitFormatter, type TsSeries,
} from '@/charts/builders';
import { useUi } from '@/stores/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { approx } from '@/components/format';
import { Markdown } from './Markdown';
import { effectiveUnit, metricDef } from './catalog';
import type { Panel, PanelOptions, PanelResult } from './types';

export interface PanelRendererProps {
  panel: Panel;
  result: PanelResult | undefined;
  /** pixel height available for the visualisation */
  height: number;
  /** dashboard-level chart group: time-series panels share crosshair + zoom */
  group?: string;
  showTable?: boolean;
  /** run in scope (from $run or the result) used to build drill-down links */
  runKey?: string | null;
}

const RUN_KEY_RE = /^PF-\d{4}-\d{2}-\d{2}-\d+$/;

/** Generic tabular view of any result (relief rule / accessibility). */
export function resultToTable(result: PanelResult | undefined, unit?: string): { columns: string[]; rows: (string | number | null)[][] } | null {
  if (!result) return null;
  const f = unitFormatter(unit);
  switch (result.kind) {
    case 'timeseries': {
      const ts = [...new Set(result.series.flatMap((s) => s.data.map((d) => d[0])))].sort((a, b) => a - b);
      const maps = result.series.map((s) => new Map(s.data));
      return { columns: ['Time', ...result.series.map((s) => s.name)], rows: ts.map((t) => [new Date(t).toLocaleString(), ...maps.map((m) => (m.get(t) == null ? null : f(m.get(t)!)))]) };
    }
    case 'categories':
      return { columns: ['Category', ...result.series.map((s) => s.name)], rows: result.categories.map((c, i) => [c, ...result.series.map((s) => (s.data[i] == null ? null : f(s.data[i]!)))]) };
    case 'stat':
      return { columns: ['Metric', 'Value', 'Change'], rows: [[result.label ?? 'Value', f(result.value), result.delta == null ? null : `${result.delta > 0 ? '+' : ''}${result.delta.toFixed(1)}%`]] };
    case 'heatmap':
      return { columns: ['Time', 'Bucket', 'Count'], rows: result.cells.map(([x, y, v]) => [new Date(result.times[x]).toLocaleTimeString(), result.buckets[y], v]) };
    case 'items':
      return { columns: ['Title', 'Detail', 'Severity', 'Value'], rows: result.items.map((i) => [i.title, i.subtitle ?? null, i.severity ?? null, i.value ?? null]) };
    case 'table':
      return { columns: result.columns.map((c) => c.header), rows: result.rows.map((r) => result.columns.map((c) => r[c.key] ?? null)) };
    default:
      return null;
  }
}

function statusFor(value: number | null, opts: PanelOptions, better: 'lower' | 'higher'): 'pass' | 'warn' | 'fail' | null {
  if (value == null || !opts.thresholds?.length) return null;
  const crit = opts.thresholds.find((t) => t.level === 'critical')?.value;
  const warn = opts.thresholds.find((t) => t.level === 'warning')?.value;
  const bad = (t?: number) => t != null && (better === 'lower' ? value >= t : value <= t);
  return bad(crit) ? 'fail' : bad(warn) ? 'warn' : 'pass';
}

export const STATUS_META = {
  pass: { icon: CheckCircle2, label: 'OK' },
  warn: { icon: AlertTriangle, label: 'Warning' },
  fail: { icon: XCircle, label: 'Critical' },
} as const;

export function PanelMessage({ icon, children, tone }: { icon?: ReactNode; children: ReactNode; tone?: 'error' | 'muted' }) {
  return (
    <div className={`panel-msg ${tone === 'error' ? 'panel-msg-error' : ''}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon ?? (tone === 'error' ? <AlertOctagon size={18} /> : <Inbox size={18} />)}
      <span>{children}</span>
    </div>
  );
}

function fmtValue(v: number | null | undefined, unit: string | undefined, decimals?: number) {
  if (v == null || !Number.isFinite(v)) return { num: '—', unit: '' };
  if (decimals != null) {
    const n = v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return { num: n, unit: unit === 'tps' ? '/s' : unit ?? '' };
  }
  const s = unitFormatter(unit)(v);
  const m = /^(-?[\d.,]+)\s*(.*)$/.exec(s);
  return m ? { num: m[1], unit: m[2] } : { num: s, unit: '' };
}

function StatView({ panel, result, height }: { panel: Panel; result: Extract<PanelResult, { kind: 'stat' }>; height: number }) {
  const theme = useUi((s) => s.theme);
  const o = panel.options;
  const unit = effectiveUnit(o, result.unit, panel.query.metric);
  const better = o.better ?? result.better ?? metricDef(panel.query.metric)?.better ?? 'lower';
  const status = statusFor(result.value, o, better) ?? result.status ?? null;
  const { num, unit: u } = fmtValue(result.value, unit, o.decimals);
  const spark = result.sparkline?.filter((v) => v != null) ?? [];
  const compact = height < 90;
  let delta: ReactNode = null;
  if (result.delta != null && Number.isFinite(result.delta)) {
    const good = Math.abs(result.delta) < 2 ? null : (better === 'lower') === result.delta < 0;
    delta = <span className={`kpi-delta ${good == null ? '' : good ? 'good' : 'bad'}`} title="Change vs baseline">{result.delta > 0 ? '▲ +' : result.delta < 0 ? '▼ ' : ''}{result.delta.toFixed(1)}%</span>;
  }
  const S = status ? STATUS_META[status] : null;
  return (
    <div className={`stat-view ${status ? `stat-${status}` : ''}`} style={{ height }}>
      <div className="stat-main">
        <div className="stat-value num" style={{ fontSize: compact ? 22 : Math.min(40, Math.max(24, height / 3.2)) }}>
          {num}{u && <span className="stat-unit">{u}</span>}
        </div>
        <div className="stat-meta">
          {delta}
          {S && <span className={`stat-status ${status}`}><S.icon size={12} />{S.label}</span>}
          {result.label && <span className="muted stat-label">{result.label}</span>}
        </div>
      </div>
      {spark.length > 1 && !compact && (
        <div className="stat-spark"><Chart option={sparklineOption({ theme, data: spark, slot: metricDef(panel.query.metric)?.slot ?? 0 })} height={Math.max(24, Math.min(56, height - 70))} /></div>
      )}
    </div>
  );
}

const SEV_ICON: Record<string, typeof Info> = { CRITICAL: XCircle, HIGH: XCircle, FAIL: XCircle, WARNING: AlertTriangle, MEDIUM: AlertTriangle, WARN: AlertTriangle, INFO: Info, LOW: Info };
const sevClass = (s?: string) => {
  const v = (s ?? '').toUpperCase();
  return ['CRITICAL', 'HIGH', 'FAIL', 'FIRING'].includes(v) ? 'fail' : ['WARNING', 'MEDIUM', 'WARN', 'ACKNOWLEDGED'].includes(v) ? 'warn' : ['PASS', 'RESOLVED', 'OK'].includes(v) ? 'pass' : 'info';
};

function ItemsView({ result, height, timeline }: { result: Extract<PanelResult, { kind: 'items' }>; height: number; timeline: boolean }) {
  const nav = useNavigate();
  return (
    <ul className={`panel-items ${timeline ? 'timeline' : ''}`} style={{ maxHeight: height }}>
      {result.items.map((it, i) => {
        const Icon = SEV_ICON[(it.severity ?? '').toUpperCase()] ?? Info;
        const cls = sevClass(it.severity);
        const go = it.link ? () => (/^https?:/.test(it.link!) ? window.open(it.link, '_blank') : nav(it.link!)) : undefined;
        return (
          <li key={i} className={go ? 'clickable' : ''} onClick={go} tabIndex={go ? 0 : undefined} onKeyDown={go ? (e) => e.key === 'Enter' && go() : undefined}>
            <span className={`item-sev ${cls}`} title={it.severity}><Icon size={13} /></span>
            <div className="item-body">
              <div className="item-title">{it.title}</div>
              {it.subtitle && <div className="item-sub">{it.subtitle}</div>}
            </div>
            {it.value && <span className="item-value num">{it.value}</span>}
            {go && <ChevronRight size={14} className="muted" />}
          </li>
        );
      })}
    </ul>
  );
}

function TableView({ result, height, unit }: { result: Extract<PanelResult, { kind: 'table' }>; height: number; unit?: string }) {
  const nav = useNavigate();
  const columns: Column<Record<string, any>>[] = result.columns.map((c) => {
    const u = c.unit ?? (c.key === 'runKey' ? undefined : unit);
    const numeric = result.rows.some((r) => typeof r[c.key] === 'number');
    return {
      key: c.key, header: c.header, align: numeric ? 'right' : 'left',
      render: (r) => {
        const v = r[c.key];
        if (typeof v === 'number') return c.unit || u ? unitFormatter(c.unit ?? u)(v) : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
        if (typeof v === 'string' && RUN_KEY_RE.test(v)) return <span className="mono link-like">{v}</span>;
        return v ?? '—';
      },
    };
  });
  const rowLink = (r: Record<string, any>): string | null => {
    if (typeof r.link === 'string') return r.link;
    const rk = r.runKey ?? r.runId;
    if (typeof rk === 'string' && RUN_KEY_RE.test(rk)) return `/runs/${rk}`;
    return null;
  };
  const clickable = result.rows.some((r) => rowLink(r));
  return (
    <div className="panel-table">
      <DataTable rows={result.rows} columns={columns} rowKey={(r) => String(r.id ?? r.runKey ?? r.name ?? JSON.stringify(r)).slice(0, 200)}
        onRowClick={clickable ? (r) => { const l = rowLink(r); if (l) nav(l); } : undefined} maxHeight={Math.max(80, height - 44)} pageSize={200} exportName="panel" />
    </div>
  );
}

export function PanelRenderer({ panel, result, height, group, showTable, runKey }: PanelRendererProps) {
  const theme = useUi((s) => s.theme);
  const nav = useNavigate();
  const o = panel.options ?? {};
  const unit = effectiveUnit(o, (result as any)?.unit, panel.query.metric ?? panel.query.metrics?.[0]);
  const t = panel.type;
  const effRunKey = (result && result.kind === 'timeseries' && result.runKey) || runKey || null;

  const option = useMemo(() => {
    if (!result) return null;
    if (result.kind === 'timeseries') {
      const single = result.series.length === 1;
      const mslot = metricDef(panel.query.metric)?.slot;
      const series: TsSeries[] = result.series.map((s, i) => ({
        name: s.name, data: s.data,
        ...(single
          ? (o.colorSlot != null ? { slot: o.colorSlot } : s.key ? { key: s.key } : typeof mslot === 'number' ? { slot: mslot } : { key: mslot ?? 'tps' })
          : (s.key && metricDef(s.key) ? (typeof metricDef(s.key)!.slot === 'number' ? { slot: metricDef(s.key)!.slot as number } : { key: metricDef(s.key)!.slot as string }) : s.key ? { key: s.key } : { slot: i })),
        area: t === 'area' || t === 'users' || t === 'tps',
        step: t === 'timeline',
      }));
      if (t === 'scatter') return timeScatterOption({ theme, series, unit });
      return timeSeriesOption({
        theme, series, unit, showLegend: o.showLegend, slider: false,
        thresholds: o.thresholds?.map((th) => ({ value: th.value, level: th.level, label: th.level === 'critical' ? 'Critical' : 'Warning' })),
      });
    }
    if (result.kind === 'categories') {
      const ranking = t === 'endpoint_ranking' || t === 'transaction_ranking';
      const wantDonut = t === 'donut' || (t === 'error_distribution' && result.series.length === 1 && result.categories.length <= 6);
      if (wantDonut && result.series.length >= 1) {
        return donutOption({ theme, items: result.categories.map((c, i) => ({ name: c, value: result.series[0].data[i] ?? 0 })) });
      }
      return barOption({
        theme, categories: result.categories, series: result.series.map((s) => ({ name: s.name, data: s.data })), unit,
        horizontal: o.horizontal ?? (ranking || (t === 'bar' && result.categories.some((c) => c.length > 14))),
        stacked: o.stacked ?? t === 'stacked_bar', showLegend: o.showLegend, slot: o.colorSlot ?? (metricDef(panel.query.metric)?.slot as any),
      });
    }
    if (result.kind === 'stat' && (t === 'gauge' || t === 'sla_gauge')) {
      return gaugeOption({ theme, value: result.value, max: o.max ?? 100, unit: unit === '%' ? '%' : '' });
    }
    if (result.kind === 'heatmap') return heatmapOption({ theme, times: result.times, buckets: result.buckets, cells: result.cells });
    return null;
  }, [result, theme, t, unit, o.showLegend, o.thresholds, o.horizontal, o.stacked, o.colorSlot, o.max, panel.query.metric]);

  // text panels render locally (no query round-trip needed)
  if (t === 'text') {
    const md = result?.kind === 'text' ? result.markdown : panel.query.markdown ?? o.markdown ?? '';
    return <div className="panel-md" style={{ maxHeight: height }}><Markdown source={md} /></div>;
  }
  if (!result) return <div className="skeleton" style={{ height }} aria-busy="true" />;
  if (result.kind === 'error') return <PanelMessage tone="error">{result.message || 'Query failed'}</PanelMessage>;
  if (result.kind === 'empty') return <PanelMessage>{result.message || 'No data for the selected filters'}</PanelMessage>;
  if (result.kind === 'text') return <div className="panel-md" style={{ maxHeight: height }}><Markdown source={result.markdown} /></div>;

  const isEmpty = (result.kind === 'timeseries' && !result.series.some((s) => s.data.length))
    || (result.kind === 'categories' && !result.categories.length)
    || (result.kind === 'table' && !result.rows.length)
    || (result.kind === 'items' && !result.items.length)
    || (result.kind === 'heatmap' && !result.cells.length);
  if (isEmpty) return <PanelMessage>No data for the selected filters and time range</PanelMessage>;

  if (showTable && result.kind !== 'table') {
    const tbl = resultToTable(result, unit);
    if (tbl) {
      return (
        <div className="table-wrap" style={{ maxHeight: height }}>
          <table className="table"><thead><tr>{tbl.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{tbl.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={j > 0 && typeof v !== 'string' ? 'r num' : ''}>{v ?? '—'}</td>)}</tr>)}</tbody></table>
        </div>
      );
    }
  }

  if (result.kind === 'stat' && !option) return <StatView panel={panel} result={result} height={height} />;
  if (result.kind === 'items') return <ItemsView result={result} height={height} timeline={t === 'timeline'} />;
  if (result.kind === 'table') return <TableView result={result} height={height} unit={unit} />;
  if (!option) return <PanelMessage>This visualisation can’t display a “{result.kind}” result. Pick another panel type.</PanelMessage>;

  const onClick = (p: any) => {
    if (result.kind === 'categories') {
      const name = String(p.name ?? '');
      const gb = panel.query.groupBy;
      if (RUN_KEY_RE.test(name)) return nav(`/runs/${name}`);
      if (gb === 'transaction' || t === 'transaction_ranking') return nav(effRunKey ? `/runs/${effRunKey}/transactions?name=${encodeURIComponent(name)}` : `/transactions?name=${encodeURIComponent(name)}`);
      if (gb === 'endpoint' || t === 'endpoint_ranking') return nav(effRunKey ? `/runs/${effRunKey}/endpoints?name=${encodeURIComponent(name)}` : `/apis?name=${encodeURIComponent(name)}`);
    }
  };
  const approxMark = result.kind === 'timeseries' ? approx(result.percentileMethod) : '';
  return (
    <div className="panel-chart-wrap">
      {approxMark && <span className="approx-flag" title="Percentiles are approximated from interval aggregates">≈ approx.</span>}
      <Chart option={option} height={height} group={result.kind === 'timeseries' ? group : undefined} onPointClick={onClick} className="panel-chart" />
    </div>
  );
}
