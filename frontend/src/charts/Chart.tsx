import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption, ECharts } from 'echarts';
import { Download, Maximize2, Minimize2, RotateCcw, Table2 } from 'lucide-react';
import { useUi } from '@/stores/ui';
import { CHROME, CATEGORICAL } from './palette';

export interface ChartProps {
  option: EChartsOption;
  height?: number | string;
  title?: string;
  subtitle?: string;
  /** charts in the same group share crosshair, tooltip and zoom (echarts.connect) */
  group?: string;
  /** called with the selected time range when the user zooms / brushes (epoch ms) */
  onRangeSelect?: (from: number, to: number) => void;
  onPointClick?: (params: any) => void;
  /** optional table view (accessibility / relief rule) */
  table?: { columns: string[]; rows: (string | number | null)[][] };
  loading?: boolean;
  empty?: string | null;
  className?: string;
  actions?: React.ReactNode;
}

/** Base option applied to every chart: theme-aware chrome, recessive grid/axes, crosshair tooltip. */
export function baseOption(theme: 'light' | 'dark'): EChartsOption {
  const c = CHROME[theme];
  return {
    color: CATEGORICAL[theme],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: c.ink2, fontSize: 11 },
    animationDuration: 300,
    grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 3, textStyle: { color: c.ink2, fontSize: 11 }, inactiveColor: c.axis },
    tooltip: {
      trigger: 'axis', confine: true, backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1, padding: [6, 9],
      textStyle: { color: c.ink, fontSize: 12 }, axisPointer: { type: 'line', lineStyle: { color: c.muted, width: 1, type: 'dashed' }, label: { backgroundColor: c.ink2 } },
      extraCssText: 'box-shadow:0 6px 18px rgba(0,0,0,.12);border-radius:6px;',
    },
    xAxis: { axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false }, axisLabel: { color: c.muted, hideOverlap: true }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.muted }, splitLine: { lineStyle: { color: c.grid } }, nameTextStyle: { color: c.muted, fontSize: 10 } },
  } as EChartsOption;
}

function merge(base: any, extra: any): any {
  if (Array.isArray(extra)) return extra.map((e) => (typeof e === 'object' && e && !Array.isArray(e) ? merge(Array.isArray(base) ? base[0] ?? {} : base ?? {}, e) : e));
  if (typeof extra !== 'object' || extra === null) return extra;
  const out: any = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = k in out && typeof v === 'object' && v !== null && !(v instanceof Date) && k !== 'data' && k !== 'series' ? merge(out[k], v) : v;
  return out;
}

export function Chart({ option, height = 240, title, subtitle, group, onRangeSelect, onPointClick, table, loading, empty, className, actions }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<ECharts | null>(null);
  const theme = useUi((s) => s.theme);
  const [full, setFull] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const cbRange = useRef(onRangeSelect);
  const cbClick = useRef(onPointClick);
  cbRange.current = onRangeSelect;
  cbClick.current = onPointClick;

  const merged = useMemo(() => {
    const b = baseOption(theme);
    const o: any = { ...option };
    // xAxis/yAxis may be arrays: merge each with the base axis style
    for (const ax of ['xAxis', 'yAxis'] as const) {
      if (Array.isArray(o[ax])) o[ax] = o[ax].map((a: any) => merge((b as any)[ax], a));
      else if (o[ax]) o[ax] = merge((b as any)[ax], o[ax]);
    }
    const { xAxis: _x, yAxis: _y, ...rest } = b as any;
    const out = merge(rest, o);
    if (o.xAxis) out.xAxis = o.xAxis;
    if (o.yAxis) out.yAxis = o.yAxis;
    return out;
  }, [option, theme]);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    inst.current = chart;
    if (group) { (chart as any).group = group; echarts.connect(group); }
    chart.on('datazoom', () => {
      if (!cbRange.current) return;
      const opt: any = chart.getOption();
      const dz = opt.dataZoom?.[0];
      if (dz?.startValue != null && dz?.endValue != null) cbRange.current(Number(dz.startValue), Number(dz.endValue));
    });
    chart.on('click', (p) => cbClick.current?.(p));
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.dispose(); inst.current = null; };
  }, [group]);

  useEffect(() => {
    inst.current?.setOption(merged, { notMerge: true, lazyUpdate: true });
  }, [merged]);

  useEffect(() => { setTimeout(() => inst.current?.resize(), 50); }, [full, showTable]);

  const download = () => {
    const url = inst.current?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: CHROME[theme].surface });
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title ?? 'chart').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    a.click();
  };
  const resetZoom = () => inst.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });

  const body = (
    <div className={`chart-card ${full ? 'chart-full' : ''} ${className ?? ''}`}>
      {(title || actions) && (
        <div className="chart-head">
          <div className="chart-title">
            {title && <h3>{title}</h3>}
            {subtitle && <span className="muted">{subtitle}</span>}
          </div>
          <div className="chart-tools">
            {actions}
            <button className="btn btn-ghost icon-btn btn-sm" title="Reset zoom" aria-label="Reset zoom" onClick={resetZoom}><RotateCcw size={13} /></button>
            {table && <button className={`btn btn-ghost icon-btn btn-sm ${showTable ? 'active' : ''}`} title="Table view" aria-label="Table view" onClick={() => setShowTable((v) => !v)}><Table2 size={13} /></button>}
            <button className="btn btn-ghost icon-btn btn-sm" title="Download PNG" aria-label="Download PNG" onClick={download}><Download size={13} /></button>
            <button className="btn btn-ghost icon-btn btn-sm" title={full ? 'Exit fullscreen' : 'Fullscreen'} aria-label="Toggle fullscreen" onClick={() => setFull((v) => !v)}>{full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
          </div>
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <div ref={ref} style={{ height: full ? 'calc(100vh - 120px)' : height, width: '100%', display: showTable ? 'none' : 'block' }} role="img" aria-label={title} />
        {showTable && table && (
          <div className="table-wrap" style={{ maxHeight: full ? 'calc(100vh - 120px)' : height }}>
            <table className="table"><thead><tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'r num' : ''}>{v ?? '—'}</td>)}</tr>)}</tbody></table>
          </div>
        )}
        {loading && <div className="chart-overlay"><div className="skeleton" style={{ width: '100%', height: '100%' }} /></div>}
        {!loading && empty && <div className="chart-overlay chart-empty">{empty}</div>}
      </div>
    </div>
  );
  return full ? <div className="chart-backdrop" onClick={(e) => e.target === e.currentTarget && setFull(false)}>{body}</div> : body;
}
