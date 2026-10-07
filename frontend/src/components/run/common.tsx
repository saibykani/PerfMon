import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as echarts from 'echarts';
import { AlertTriangle, CheckCircle2, Check, Copy, HelpCircle, Info, MinusCircle, X, XCircle } from 'lucide-react';
import { ApiError } from '@/services/api';
import type { PercentileMethod } from './types';

/** Fetch helper: returns `fallback` on HTTP 404 (endpoint owned by another module not deployed yet). */
export async function orMissing<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch (e) { if (e instanceof ApiError && e.status === 404) return fallback; throw e; }
}

export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

/** Status chip with icon + label (status colours are never used alone). */
export function StatusChip({ status, label, title, size = 'md' }: { status: string | null | undefined; label?: ReactNode; title?: string; size?: 'sm' | 'md' }) {
  const s = (status ?? 'N/A').toUpperCase();
  const cls = s === 'PASS' || s === 'OK' || s === 'CONSISTENT' || s === 'BETTER' ? 'pass'
    : s === 'WARNING' || s === 'WARN' || s === 'MINOR' || s === 'MINOR_DIFFERENCES' || s === 'PASS_WITH_WARNINGS' ? 'warn'
      : s === 'FAIL' || s === 'CRITICAL' || s === 'MISMATCH' || s === 'INCONSISTENT' || s === 'WORSE' ? 'fail' : 'neutral';
  const Icon = cls === 'pass' ? CheckCircle2 : cls === 'warn' ? AlertTriangle : cls === 'fail' ? XCircle : MinusCircle;
  return (
    <span className={`chip chip-${cls} ${size === 'sm' ? 'chip-sm' : ''}`} title={title}>
      <Icon size={size === 'sm' ? 11 : 12} strokeWidth={2.4} />
      {label ?? s.replace(/_/g, ' ')}
    </span>
  );
}

export function SeverityIcon({ severity, size = 14 }: { severity: string; size?: number }) {
  if (severity === 'CRITICAL') return <XCircle size={size} className="sev-critical" aria-label="Critical" />;
  if (severity === 'WARNING') return <AlertTriangle size={size} className="sev-warning" aria-label="Warning" />;
  return <Info size={size} className="sev-info" aria-label="Info" />;
}

/** Bottleneck confidence wording — never claims certainty. */
export function confidenceWord(c: number | null | undefined, label?: string | null) {
  if (label) return label;
  if (c == null) return 'Insufficient evidence';
  if (c >= 0.8) return 'Strong correlation';
  if (c >= 0.65) return 'Likely bottleneck';
  if (c >= 0.45) return 'Possible bottleneck';
  return 'Insufficient evidence';
}

export function ConfidenceMeter({ value, label }: { value: number | null | undefined; label?: string | null }) {
  const pct = Math.round((value ?? 0) * 100);
  const word = confidenceWord(value, label);
  const lvl = (value ?? 0) >= 0.8 ? 'strong' : (value ?? 0) >= 0.65 ? 'likely' : (value ?? 0) >= 0.45 ? 'possible' : 'weak';
  return (
    <span className={`conf conf-${lvl}`} title={`Confidence ${pct}% — ${word}`}>
      <span className="conf-bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="conf-label">{word}</span>
      <span className="conf-pct num">{pct}%</span>
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn btn-ghost btn-sm icon-btn copy-btn" aria-label={label ?? `Copy ${text}`} title={ok ? 'Copied' : 'Copy'}
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); }).catch(() => undefined); }}>
      {ok ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** Segmented control. */
export function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Note shown whenever percentiles are approximations. */
export function ApproxNote({ method, compact }: { method?: PercentileMethod; compact?: boolean }) {
  if (method !== 'interval_weighted_approx') return null;
  return (
    <span className={`approx-note ${compact ? 'compact' : ''}`} title="Percentiles were reported per interval by the load generator and combined with a sample-weighted average. They are approximations, not exact percentiles over all samples.">
      <HelpCircle size={12} /> ≈ approximate percentiles{compact ? '' : ' (interval-weighted — upload a JTL for exact values)'}
    </span>
  );
}

/** Right-hand drawer for drill-downs. */
export function SidePanel({ open, onClose, title, subtitle, actions, children, width = 880 }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" style={{ width: `min(${width}px, 100vw)` }}>
        <header className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="drawer-title">{title}</div>
            {subtitle && <div className="muted drawer-sub">{subtitle}</div>}
          </div>
          <div className="row">{actions}<button className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Close panel"><X size={16} /></button></div>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

/** Small anchored popover (click to toggle, closes on outside click / Escape). */
export function Popover({ trigger, children, align = 'left', width = 320 }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && <div className="popover" style={{ width, [align]: 0 }} role="dialog">{children}</div>}
    </div>
  );
}

/** Empty state with an icon, explanation and next steps. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function SkeletonGrid({ count = 6, height = 64 }: { count?: number; height?: number }) {
  return <div className="kpis">{Array.from({ length: count }).map((_, i) => <div key={i} className="skeleton" style={{ height }} />)}</div>;
}

/** Access the ECharts instances rendered inside a container (for brush-select / reset). */
export function chartsIn(el: HTMLElement | null): echarts.ECharts[] {
  if (!el) return [];
  return [...el.querySelectorAll<HTMLElement>('[_echarts_instance_]')].map((d) => echarts.getInstanceByDom(d)).filter(Boolean) as echarts.ECharts[];
}

/** Enable drag-to-select time range (brush zoom) on every chart in the container. */
export function enableBrushZoom(el: HTMLElement | null) {
  for (const c of chartsIn(el)) {
    try { c.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true }); } catch { /* chart not ready */ }
  }
}

export const toolboxZoom = { toolbox: { show: false, feature: { dataZoom: { yAxisIndex: 'none' as const, xAxisIndex: 0 } } } };

export const fmtTime = (t: number | string | null | undefined, sec = true) =>
  t == null ? '—' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined });

export const pctOf = (a: number | null | undefined, b: number | null | undefined) => (a == null || !b ? null : (a / b) * 100);
