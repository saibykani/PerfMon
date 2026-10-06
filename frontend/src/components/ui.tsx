import { useEffect, type ReactNode } from 'react';
import { X, TrendingDown, TrendingUp, Minus } from 'lucide-react';

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {subtitle && <div className="sub">{subtitle}</div>}
        {children}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, bodyClass, noPad }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; noPad?: boolean }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && <div className="card-head"><h3>{title}</h3>{actions && <div className="row">{actions}</div>}</div>}
      <div className={noPad ? '' : `card-body ${bodyClass ?? ''}`}>{children}</div>
    </section>
  );
}

/**
 * KPI tile. `delta` is a % change vs baseline; `better` says which direction is good,
 * so color + arrow + sign carry meaning together (never color alone).
 */
export function Kpi({ label, value, unit, sub, delta, better = 'lower', status, title, onClick }: {
  label: string; value: ReactNode; unit?: string; sub?: ReactNode; delta?: number | null; better?: 'lower' | 'higher' | 'neutral';
  status?: 'pass' | 'warn' | 'fail' | null; title?: string; onClick?: () => void;
}) {
  let deltaEl: ReactNode = null;
  if (delta != null && Number.isFinite(delta)) {
    const good = better === 'neutral' || Math.abs(delta) < 2 ? null : (better === 'lower') === delta < 0;
    const Icon = Math.abs(delta) < 0.5 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
    deltaEl = <span className={`kpi-delta ${good == null ? '' : good ? 'good' : 'bad'}`}><Icon size={11} />{delta > 0 ? '+' : ''}{delta.toFixed(1)}%</span>;
  }
  return (
    <div className={`kpi ${status ? `kpi-${status}` : ''} ${onClick ? 'clickable' : ''}`} title={title} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}{unit && <span className="unit">{unit}</span>}</div>
      <div className="kpi-sub">{deltaEl}{sub}</div>
    </div>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return <div className="empty">{icon && <div style={{ marginBottom: 8, opacity: 0.6 }}>{icon}</div>}{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error-box" role="alert">{(error as Error).message ?? String(error)}</div>;
}

export function Loading({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-busy="true" />;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode; badge?: ReactNode }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={`tab ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}{t.badge != null && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" style={{ maxWidth: width }}>
        <div className="card-head"><h2 style={{ fontSize: 14 }}>{title}</h2><button className="btn btn-ghost icon-btn btn-sm" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
        <div className="card-body modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmation for destructive actions (nothing is hard-deleted without it). */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', danger = true, onConfirm, onClose, requireText }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void; requireText?: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={440}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} id="confirm-btn" onClick={() => { onConfirm(); onClose(); }}
          disabled={!!requireText && (document.getElementById('confirm-text') as HTMLInputElement | null)?.value !== requireText}>{confirmLabel}</button>
      </>}>
      <div className="stack">
        <div>{message}</div>
        {requireText && (
          <div className="field"><label>Type <b className="mono">{requireText}</b> to confirm</label>
            <input id="confirm-text" className="input" autoFocus onChange={(e) => { const b = document.getElementById('confirm-btn') as HTMLButtonElement | null; if (b) b.disabled = e.target.value !== requireText; }} />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{hint && <span className="muted" style={{ fontSize: 11 }}>{hint}</span>}</div>;
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>;
}
