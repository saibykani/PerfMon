import type React from 'react';
/**
 * Shared building blocks for the platform modules (SLA, Alerts, Integrations, Administration):
 * copy-to-clipboard, write-only secret inputs, drawers, toasts, chips, sparklines, project scope.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import {
  AlertOctagon, AlertTriangle, Check, CheckCircle2, CircleDashed, Copy, Eye, EyeOff, Info, KeyRound, Lock, X, XCircle,
} from 'lucide-react';
import { api, ApiError } from '@/services/api';
import { useFilters } from '@/stores/filters';
import '@/styles/platform.css';

/* ------------------------------------------------------------------ data helpers */

const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Shallow snake_case → camelCase key normalisation (inventory endpoints return raw DB rows). Keeps nested objects as-is. */
export function camel<T = any>(o: any): T {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out: any = {};
  for (const [k, v] of Object.entries(o)) out[toCamel(k)] = v;
  return out as T;
}
export const camelAll = <T = any,>(rows: any): T[] => (Array.isArray(rows) ? rows.map((r) => camel<T>(r)) : []);

/** Accepts `T[]` or `{ items: T[] }` (lists are sometimes paginated). */
export const itemsOf = <T = any,>(d: any): T[] => (Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : []);

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error)?.message ?? String(e));
export const isNotFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 501);

export function relTime(v: string | number | Date | null | undefined) {
  if (!v) return '—';
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  const abs = Math.abs(s);
  const fut = s < 0;
  const f = (n: number, u: string) => (fut ? `in ${n}${u}` : `${n}${u} ago`);
  if (abs < 45) return fut ? 'in a moment' : 'just now';
  if (abs < 3600) return f(Math.round(abs / 60), 'm');
  if (abs < 86400) return f(Math.round(abs / 3600), 'h');
  if (abs < 86400 * 45) return f(Math.round(abs / 86400), 'd');
  return new Date(t).toLocaleDateString();
}

/* ------------------------------------------------------------------ project scope */

export interface ProjectOpt { id: string; name: string; key?: string }

/** Projects + the active project (global filter, else the first project). */
export function useProjectScope() {
  const projectId = useFilters((s) => s.projectId);
  const setFilters = useFilters((s) => s.set);
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<any[]>('/projects'), staleTime: 60000 });
  const projects: ProjectOpt[] = itemsOf(q.data).map((p: any) => ({ id: p.id, name: p.name, key: p.key }));
  const active = projects.find((p) => p.id === projectId) ?? null;
  return {
    projects, loading: q.isLoading, projectId: active?.id ?? null,
    /** project to use when creating project-scoped objects */
    writeProjectId: active?.id ?? projects[0]?.id ?? null,
    setProjectId: (id: string | null) => setFilters({ projectId: id }),
  };
}

export function ProjectPicker({ allowAll = true }: { allowAll?: boolean }) {
  const { projects, projectId, setProjectId } = useProjectScope();
  return (
    <select className="select" aria-label="Project" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
      {allowAll && <option value="">All projects</option>}
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

/* ------------------------------------------------------------------ toasts */

interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: ReactNode }
const useToasts = create<{ items: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.kind === 'error' ? 7000 : 3500);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  success: (text: ReactNode) => useToasts.getState().push({ kind: 'success', text }),
  error: (text: ReactNode) => useToasts.getState().push({ kind: 'error', text }),
  info: (text: ReactNode) => useToasts.getState().push({ kind: 'info', text }),
};

export function ToastHost() {
  const { items, drop } = useToasts();
  return (
    <div className="pf-toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`pf-toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <XCircle size={15} /> : <Info size={15} />}
          <div style={{ flex: 1, minWidth: 0 }}>{t.text}</div>
          <button className="btn btn-ghost icon-btn btn-sm" onClick={() => drop(t.id)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ copy to clipboard */

async function writeClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label, small = true, className }: { text: string; label?: string; small?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<number>();
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <button type="button" className={`btn ${small ? 'btn-sm' : ''} ${done ? 'pf-copied' : ''} ${className ?? ''}`} aria-label={label ?? 'Copy to clipboard'}
      onClick={async () => { if (await writeClipboard(text)) { setDone(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setDone(false), 1800); } }}>
      {done ? <Check size={13} /> : <Copy size={13} />}{label !== '' && (done ? 'Copied' : label ?? 'Copy')}
    </button>
  );
}

/** A value presented for copying (one-time secrets, links, snippets). */
export function CopyBox({ value, title, warning, multiline, tone = 'neutral' }: { value: string; title?: ReactNode; warning?: ReactNode; multiline?: boolean; tone?: 'neutral' | 'secret' }) {
  return (
    <div className={`pf-copybox ${tone === 'secret' ? 'secret' : ''}`}>
      {title && <div className="pf-copybox-title">{tone === 'secret' && <KeyRound size={14} />}{title}</div>}
      <div className="pf-copybox-row">
        {multiline ? <pre className="pf-code" tabIndex={0}>{value}</pre> : <code className="pf-copybox-value" tabIndex={0}>{value}</code>}
        <CopyButton text={value} />
      </div>
      {warning && <div className="pf-copybox-warn"><AlertTriangle size={13} />{warning}</div>}
    </div>
  );
}

export function CodeSnippet({ title, code, lang }: { title: ReactNode; code: string; lang?: string }) {
  return (
    <div className="pf-snippet">
      <div className="pf-snippet-head"><span>{title}</span>{lang && <span className="pf-lang">{lang}</span>}<div className="spacer" /><CopyButton text={code} /></div>
      <pre className="pf-code">{code}</pre>
    </div>
  );
}

/* ------------------------------------------------------------------ write-only secrets */

/**
 * Write-only secret input. When a secret is already stored (`hasSecret`), the field shows
 * "••• stored" and only accepts a replacement — stored secrets are never read back.
 */
export function SecretInput({ value, onChange, hasSecret, placeholder, id, invalid, autoFocus }: {
  value: string; onChange: (v: string) => void; hasSecret?: boolean; placeholder?: string; id?: string; invalid?: boolean; autoFocus?: boolean;
}) {
  const [replacing, setReplacing] = useState(!hasSecret);
  const [show, setShow] = useState(false);
  useEffect(() => { setReplacing(!hasSecret); }, [hasSecret]);
  if (!replacing) {
    return (
      <div className="pf-secret-stored">
        <Lock size={13} /><span className="mono">••••••••</span><span className="muted">stored (encrypted)</span>
        <div className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => setReplacing(true)}>Replace</button>
      </div>
    );
  }
  return (
    <div className="pf-secret-input">
      <input id={id} className={`input ${invalid ? 'pf-invalid' : ''}`} type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false}
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      <button type="button" className="btn btn-ghost icon-btn btn-sm" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide value' : 'Show value'}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
      {hasSecret && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onChange(''); setReplacing(false); }}>Keep stored</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ form helpers */

export function FormField({ label, children, hint, error, required, htmlFor, className }: {
  label: ReactNode; children: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; htmlFor?: string; className?: string;
}) {
  return (
    <div className={`field pf-field ${error ? 'has-error' : ''} ${className ?? ''}`}>
      <label htmlFor={htmlFor}>{label}{required && <span className="pf-req" aria-hidden>*</span>}</label>
      {children}
      {error ? <span className="pf-field-error" role="alert">{error}</span> : hint ? <span className="pf-hint">{hint}</span> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`pf-toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="pf-toggle-track"><span className="pf-toggle-thumb" /></span>
      {label && <span>{label}</span>}
    </label>
  );
}

/** Toggle-pill multi select. */
export function PillSelect<T extends string>({ options, value, onChange, disabled }: {
  options: { value: T; label: ReactNode; hint?: string }[]; value: T[]; onChange: (v: T[]) => void; disabled?: boolean;
}) {
  return (
    <div className="pf-pills" role="group">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button type="button" key={o.value} className={`pf-pill ${on ? 'on' : ''}`} aria-pressed={on} title={o.hint} disabled={disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}>
            {on && <Check size={12} />}{o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange, ariaLabel }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ status chips */

export type Tone = 'pass' | 'warn' | 'fail' | 'info' | 'neutral' | 'accent';
const TONE_ICON: Record<Tone, ReactNode> = {
  pass: <CheckCircle2 size={12} />, warn: <AlertTriangle size={12} />, fail: <XCircle size={12} />, info: <Info size={12} />, neutral: <CircleDashed size={12} />, accent: <Info size={12} />,
};

/** Status chip — color is always paired with an icon and a label. */
export function Chip({ tone = 'neutral', children, icon, title }: { tone?: Tone; children: ReactNode; icon?: ReactNode | false; title?: string }) {
  return <span className={`pf-chip ${tone}`} title={title}>{icon === false ? null : icon ?? TONE_ICON[tone]}{children}</span>;
}

export function SeverityChip({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  const tone: Tone = value === 'CRITICAL' ? 'fail' : value === 'WARNING' ? 'warn' : 'info';
  return <Chip tone={tone} icon={value === 'CRITICAL' ? <AlertOctagon size={12} /> : undefined}>{value.charAt(0) + value.slice(1).toLowerCase()}</Chip>;
}

export function HealthChip({ value }: { value?: string | null }) {
  const v = (value ?? 'UNKNOWN').toUpperCase();
  const tone: Tone = v === 'HEALTHY' || v === 'OK' || v === 'UP' ? 'pass' : v === 'DEGRADED' ? 'warn' : v === 'DOWN' || v === 'FAILED' || v === 'ERROR' ? 'fail' : 'neutral';
  return <Chip tone={tone}>{v.charAt(0) + v.slice(1).toLowerCase()}</Chip>;
}

/* ------------------------------------------------------------------ drawer */

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 520 }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="pf-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="pf-drawer" role="dialog" aria-modal="true" style={{ width: `min(${width}px, 100vw)` }}>
        <div className="pf-drawer-head">
          <div style={{ minWidth: 0 }}><h2>{title}</h2>{subtitle && <div className="muted" style={{ marginTop: 2 }}>{subtitle}</div>}</div>
          <button className="btn btn-ghost icon-btn btn-sm" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="pf-drawer-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ sparkline */

/** Minimal inline sparkline (single series, no axes). */
export function Sparkline({ values, color = 'var(--accent)', height = 28, width = 120, fill = true, max: maxIn }: {
  values: (number | null)[]; color?: string; height?: number; width?: number; fill?: boolean; max?: number;
}) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null && Number.isFinite(p[1]));
  if (pts.length < 2) return <svg width={width} height={height} className="pf-spark" aria-hidden><line x1="0" x2={width} y1={height - 1} y2={height - 1} stroke="var(--border)" strokeDasharray="2 3" /></svg>;
  const min = Math.min(0, ...pts.map((p) => p[1]));
  const max = Math.max(maxIn ?? 0, ...pts.map((p) => p[1]), min + 1e-9);
  const n = Math.max(values.length - 1, 1);
  const x = (i: number) => (i / n) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className="pf-spark" aria-hidden viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {fill && <path d={`${d} L${x(last[0]).toFixed(1)},${height} L${x(pts[0][0]).toFixed(1)},${height} Z`} fill={color} opacity={0.12} />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={2.2} fill={color} />
    </svg>
  );
}

/* ------------------------------------------------------------------ misc */

export function JsonBlock({ value, maxHeight = 260 }: { value: unknown; maxHeight?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  return <pre className="pf-code pf-json" style={{ maxHeight }}>{text}</pre>;
}

export function PermissionNote({ perm, children }: { perm: string; children?: ReactNode }) {
  return <div className="pf-perm"><Lock size={13} />{children ?? <>Read-only — you need the <b className="mono">{perm}</b> permission to make changes.</>}</div>;
}

export function SkeletonRows({ rows = 4, height = 38 }: { rows?: number; height?: number }) {
  return <div className="stack" style={{ gap: 8 }}>{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ height }} />)}</div>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="pf-empty">
      {icon && <div className="pf-empty-icon">{icon}</div>}
      <div className="pf-empty-title">{title}</div>
      {children && <div className="pf-empty-text">{children}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/** Notice for endpoints that are not available on this server build. */
export function Unavailable({ what, error }: { what: string; error: unknown }) {
  return (
    <div className="pf-unavail" role="status">
      <Info size={14} />
      <div>{isNotFound(error) ? <><b>{what}</b> is not available on this Perfmon server yet.</> : <><b>{what}</b> could not be loaded: {errMsg(error)}</>}</div>
    </div>
  );
}

export const plural = (n: number, s: string, p = `${s}s`) => `${n.toLocaleString()} ${n === 1 ? s : p}`;

/** Two-column label/value grid for detail drawers. */
export function KeyValueGrid({ items }: { items: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}
    </dl>
  );
}
