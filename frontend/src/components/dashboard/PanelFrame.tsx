import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { BarChart3, Copy, Download, GripVertical, Info, Maximize2, MoreVertical, Pencil, Table2, Trash2, X } from 'lucide-react';
import { useUi } from '@/stores/ui';
import { CHROME } from '@/charts/palette';
import { PanelRenderer } from './PanelRenderer';
import { panelTypeLabel } from './catalog';
import type { Panel, PanelResult } from './types';

function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setH(el.clientHeight);
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

export interface PanelFrameProps {
  panel: Panel;
  result: PanelResult | undefined;
  loading: boolean;
  editing: boolean;
  canEdit: boolean;
  group?: string;
  runKey?: string | null;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
}

const NO_CHART = new Set(['stat', 'kpi', 'table', 'text', 'bottleneck', 'timeline']);

export function PanelFrame({ panel, result, loading, editing, canEdit, group, runKey, onEdit, onDuplicate, onRemove }: PanelFrameProps) {
  const [bodyRef, bodyH] = useElementHeight<HTMLDivElement>();
  const [menu, setMenu] = useState(false);
  const [table, setTable] = useState(false);
  const [full, setFull] = useState(false);
  const theme = useUi((s) => s.theme);
  const menuRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [full]);

  const chartCapable = !NO_CHART.has(panel.type) && result != null && ['timeseries', 'categories', 'heatmap', 'stat'].includes(result.kind);
  const downloadPng = () => {
    const root = full ? fullRef.current : bodyRef.current;
    const el = root?.querySelector('[role="img"]') as HTMLElement | null;
    const inst = el ? echarts.getInstanceByDom(el) : undefined;
    const url = inst?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: CHROME[theme].surface });
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${panel.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'panel'}.png`;
    a.click();
  };
  const isLoading = loading && !result && panel.type !== 'text';
  const approx = result?.kind === 'timeseries' && result.percentileMethod === 'interval_weighted_approx';

  const item = (icon: React.ReactNode, label: string, fn: () => void, danger = false) => (
    <button className={`dt-menu-item menu-btn ${danger ? 'danger' : ''}`} role="menuitem" onClick={() => { setMenu(false); fn(); }}>{icon}{label}</button>
  );

  const header = (inFull: boolean) => (
    <div className={`panel-head ${editing && !inFull ? 'panel-drag' : ''}`}>
      {editing && !inFull && <GripVertical size={14} className="panel-grip" aria-hidden />}
      <h3 className="panel-title" title={panel.title}>{panel.title || panelTypeLabel(panel.type)}</h3>
      {approx && <span className="approx-chip" title="Percentiles approximated from interval aggregates">≈</span>}
      {panel.options?.description && <span className="no-drag panel-info" title={panel.options.description}><Info size={13} /></span>}
      {loading && result && <span className="panel-refreshing" aria-label="Refreshing" />}
      <div className="spacer" />
      {inFull ? (
        <div className="row no-drag">
          {chartCapable && <button className="btn btn-ghost icon-btn btn-sm" title={table ? 'Chart view' : 'Table view'} onClick={() => setTable((v) => !v)}>{table ? <BarChart3 size={14} /> : <Table2 size={14} />}</button>}
          {chartCapable && !table && <button className="btn btn-ghost icon-btn btn-sm" title="Download PNG" onClick={downloadPng}><Download size={14} /></button>}
          <button className="btn btn-ghost icon-btn btn-sm" title="Close" aria-label="Close fullscreen" onClick={() => setFull(false)}><X size={15} /></button>
        </div>
      ) : (
        <div className="panel-actions no-drag" ref={menuRef}>
          {editing && canEdit && <button className="btn btn-ghost icon-btn btn-sm" title="Edit panel" aria-label="Edit panel" onClick={onEdit}><Pencil size={13} /></button>}
          <button className="btn btn-ghost icon-btn btn-sm" aria-label="Panel menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><MoreVertical size={14} /></button>
          {menu && (
            <div className="dt-menu panel-menu" role="menu">
              {canEdit && onEdit && item(<Pencil size={13} />, 'Edit', onEdit)}
              {canEdit && onDuplicate && item(<Copy size={13} />, 'Duplicate', onDuplicate)}
              {item(<Maximize2 size={13} />, 'View fullscreen', () => setFull(true))}
              {chartCapable && item(table ? <BarChart3 size={13} /> : <Table2 size={13} />, table ? 'View chart' : 'View table', () => setTable((v) => !v))}
              {chartCapable && !table && item(<Download size={13} />, 'Download PNG', downloadPng)}
              {canEdit && onRemove && <div className="menu-sep" />}
              {canEdit && onRemove && item(<Trash2 size={13} />, 'Remove', onRemove, true)}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className={`panel ${editing ? 'panel-editing' : ''} panel-t-${panel.type}`} data-panel-id={panel.id}>
        {header(false)}
        <div className="panel-body" ref={bodyRef}>
          {isLoading ? <div className="skeleton panel-skeleton" aria-busy="true" />
            : bodyH > 0 && <PanelRenderer panel={panel} result={result} height={bodyH} group={full ? undefined : group} showTable={table} runKey={runKey} />}
        </div>
      </div>
      {full && (
        <div className="chart-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setFull(false)}>
          <div className="panel panel-fullscreen" ref={fullRef} role="dialog" aria-modal="true" aria-label={panel.title}>
            {header(true)}
            <div className="panel-body"><PanelRenderer panel={panel} result={result} height={Math.max(300, window.innerHeight - 140)} showTable={table} runKey={runKey} /></div>
          </div>
        </div>
      )}
    </>
  );
}
