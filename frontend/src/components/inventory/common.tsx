import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { AlertTriangle, Check, CheckCircle2, CircleHelp, Copy, Info, X, XCircle } from 'lucide-react';
import { ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import '@/styles/inventory.css';

/* ------------------------------------------------------------------ toasts */
type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; text: ReactNode }
interface ToastState { items: ToastItem[]; push: (kind: ToastKind, text: ReactNode) => void; dismiss: (id: number) => void }
let toastSeq = 0;
export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push(kind, text) {
    const id = ++toastSeq;
    set({ items: [...get().items, { id, kind, text }].slice(-4) });
    setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 4000);
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}));
export const toast = {
  success: (t: ReactNode) => useToasts.getState().push('success', t),
  error: (t: ReactNode) => useToasts.getState().push('error', t),
  info: (t: ReactNode) => useToasts.getState().push('info', t),
};

/** Render once per page (pages are mounted one at a time). */
export function Toaster() {
  const { items, dismiss } = useToasts();
  return (
    <div className="inv-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`inv-toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <XCircle size={15} /> : <Info size={15} />}
          <div className="inv-toast-text">{t.text}</div>
          <button className="btn btn-ghost icon-btn btn-sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ errors */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Map backend validation details (`[{path:'/key', message}]`) to a field → message record. */
export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && Array.isArray(e.details)) {
    for (const d of e.details as { path?: string; message?: string }[]) {
      const k = (d.path ?? '').replace(/^\//, '').split(/[/.]/)[0];
      if (k && !out[k]) out[k] = d.message ?? 'Invalid value';
    }
  }
  return out;
}

export function friendlyError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 409) return 'Something with the same identifier already exists. Choose a different key / name.';
    if (e.status === 403) return 'You do not have permission to perform this action.';
    if (e.code === 'VALIDATION_ERROR' && Array.isArray(e.details)) return 'Please fix the highlighted fields.';
  }
  return errMsg(e);
}

/* ------------------------------------------------------------------ permissions */
export function useCan() {
  const user = useAuth((s) => s.user);
  return (perm: string) => !!user?.permissions.includes(perm);
}

/* ------------------------------------------------------------------ drawer */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 520, icon }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; icon?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    const prev = document.activeElement as HTMLElement | null;
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,button.inv-autofocus')?.focus(), 30);
    return () => { window.removeEventListener('keydown', h); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="inv-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="inv-drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ maxWidth: width }} ref={ref}>
        <header className="inv-drawer-head">
          {icon && <div className="inv-drawer-icon">{icon}</div>}
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{title}</h2>
            {subtitle && <div className="muted inv-ellipsis">{subtitle}</div>}
          </div>
          <button className="btn btn-ghost icon-btn btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="inv-drawer-body">{children}</div>
        {footer && <footer className="inv-drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ form field */
export function FormField({ label, error, hint, required, children, htmlFor, span }: {
  label: string; error?: string | null; hint?: ReactNode; required?: boolean; children: ReactNode; htmlFor?: string; span?: 1 | 2;
}) {
  return (
    <div className={`field inv-field ${error ? 'has-error' : ''} ${span === 2 ? 'span-2' : ''}`}>
      <label htmlFor={htmlFor}>{label}{required && <span className="inv-req" aria-hidden> *</span>}</label>
      {children}
      {error ? <span className="inv-field-error" role="alert">{error}</span> : hint ? <span className="inv-field-hint">{hint}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ copy */
export function CopyButton({ text, label, className, size = 13 }: { text: string; label?: string; className?: string; size?: number }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <button type="button" className={`btn btn-sm ${label ? '' : 'btn-ghost icon-btn'} ${className ?? ''}`} onClick={copy} title={done ? 'Copied' : `Copy${label ? ` ${label}` : ''}`} aria-label={label ? `Copy ${label}` : 'Copy'}>
      {done ? <Check size={size} className="inv-ok" /> : <Copy size={size} />}{label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="inv-code">
      {label && <div className="inv-code-head"><span>{label}</span><CopyButton text={code} label="Copy" /></div>}
      {!label && <div className="inv-code-copy"><CopyButton text={code} /></div>}
      <pre><code>{code}</code></pre>
    </div>
  );
}

/* ------------------------------------------------------------------ health */
const HEALTH: Record<string, { cls: string; icon: typeof CheckCircle2; label: string }> = {
  HEALTHY: { cls: 'pass', icon: CheckCircle2, label: 'Healthy' },
  WARNING: { cls: 'warn', icon: AlertTriangle, label: 'Warning' },
  CRITICAL: { cls: 'fail', icon: XCircle, label: 'Critical' },
  UNKNOWN: { cls: '', icon: CircleHelp, label: 'Unknown' },
};
export function HealthChip({ status, compact }: { status?: string | null; compact?: boolean }) {
  const h = HEALTH[status ?? 'UNKNOWN'] ?? HEALTH.UNKNOWN;
  const Icon = h.icon;
  return <span className={`badge ${h.cls} inv-health`} title={`Health: ${h.label}`}><Icon size={12} />{!compact && h.label}</span>;
}
export const healthColor = (s?: string | null) => (s === 'HEALTHY' ? 'var(--pass)' : s === 'WARNING' ? 'var(--warn)' : s === 'CRITICAL' ? 'var(--fail)' : 'var(--text-3)');

/* ------------------------------------------------------------------ misc */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="inv-empty">
      {icon && <div className="inv-empty-icon">{icon}</div>}
      <div className="inv-empty-title">{title}</div>
      {children && <div className="inv-empty-text">{children}</div>}
      {action && <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export function Tags({ tags, max = 4 }: { tags?: string[] | null; max?: number }) {
  if (!tags?.length) return <span className="muted">—</span>;
  return (
    <span className="inv-tags">
      {tags.slice(0, max).map((t) => <span key={t} className="inv-tag">{t}</span>)}
      {tags.length > max && <span className="inv-tag muted" title={tags.slice(max).join(', ')}>+{tags.length - max}</span>}
    </span>
  );
}

const ENV_CLASS: Record<string, string> = { PRODUCTION: 'fail', STAGING: 'warn', PERFORMANCE: 'accent', UAT: 'info', SIT: 'info', QA: '', DEV: '' };
export const EnvBadge = ({ type }: { type?: string | null }) => (type ? <span className={`badge ${ENV_CLASS[type] ?? ''}`}>{type}</span> : <span className="muted">—</span>);

/** Usage bar for % values: color is paired with the numeric label (never color alone). */
export function UsageBar({ value, warn = 70, crit = 90 }: { value: number | null | undefined; warn?: number; crit?: number }) {
  if (value == null || !Number.isFinite(Number(value))) return <span className="muted">—</span>;
  const v = Number(value);
  const cls = v >= crit ? 'fail' : v >= warn ? 'warn' : 'pass';
  return (
    <span className="inv-usage" title={`${v.toFixed(1)}%`}>
      <span className="inv-usage-track"><span className={`inv-usage-fill ${cls}`} style={{ width: `${Math.min(100, Math.max(0, v))}%` }} /></span>
      <span className="num">{v.toFixed(0)}%</span>
    </span>
  );
}

export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Segmented control. */
export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Inline notice (info / warn). */
export function Notice({ kind = 'info', children, icon }: { kind?: 'info' | 'warn' | 'success'; children: ReactNode; icon?: ReactNode }) {
  return <div className={`inv-notice ${kind}`}>{icon ?? (kind === 'warn' ? <AlertTriangle size={15} /> : kind === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />)}<div>{children}</div></div>;
}
