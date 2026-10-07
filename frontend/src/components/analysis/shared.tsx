import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Minus, Search, X, AlertOctagon, AlertTriangle, Info, CheckCircle2, XCircle, CircleDashed,
} from 'lucide-react';
import { api } from '@/services/api';
import { fmtBytes, fmtDate, fmtMs, fmtNum } from '@/components/format';
import { StatusBadge } from '@/components/Status';
import '@/styles/analysis.css';

/* ------------------------------------------------------------------ formatting */

/** Format a value by the unit used in the compare/regression APIs. */
export function fmtUnit(v: number | null | undefined, unit?: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'ms': return fmtMs(v);
    case '%': return `${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}%`;
    case 'tps': return `${fmtNum(v, v < 100 ? 2 : 1)}/s`;
    case 'B/s': return `${fmtBytes(v)}/s`;
    case 'KB/s': return `${fmtNum(v, 1)} KB/s`;
    default: return Math.abs(v) >= 1000 ? fmtNum(v) : fmtNum(v, Number.isInteger(v) ? 0 : 1);
  }
}

export const pctChange = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a === 0 ? null : ((b - a) / Math.abs(a)) * 100;

export type Better = 'lower' | 'higher' | 'neutral';
export type Verdict = 'better' | 'worse' | 'neutral';

/** Same rule as the backend (analytics/compare.ts): |change| < 2% or neutral metric → neutral. */
export function verdictOf(change: number | null, better: Better): Verdict {
  if (change == null || better === 'neutral' || Math.abs(change) < 2) return 'neutral';
  return (better === 'lower') === change < 0 ? 'better' : 'worse';
}

/** Change chip: arrow + sign + color + (optional) word — never color alone. */
export function ChangeChip({ change, verdict, showWord = false, title, pts }: { change: number | null; verdict: Verdict; showWord?: boolean; title?: string; pts?: number | null }) {
  if (change == null && pts == null) return <span className="an-chg muted" title="No comparable value">—</span>;
  const v = pts ?? change ?? 0;
  const Icon = Math.abs(v) < 0.05 ? Minus : v > 0 ? ArrowUp : ArrowDown;
  const label = pts != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)} pts` : `${v > 0 ? '+' : ''}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
  return (
    <span className={`an-chg ${verdict}`} title={title ?? (verdict === 'neutral' ? 'Within ±2% or neutral metric' : verdict === 'better' ? 'Improvement' : 'Degradation')}>
      <Icon size={11} strokeWidth={2.5} aria-hidden />{label}{showWord && verdict !== 'neutral' && <span className="an-chg-word">{verdict}</span>}
    </span>
  );
}

/** Heat class for a change cell (5 steps per direction). */
export function heatClass(change: number | null, verdict: Verdict) {
  if (change == null || verdict === 'neutral') return '';
  const a = Math.abs(change);
  const step = a >= 50 ? 4 : a >= 25 ? 3 : a >= 10 ? 2 : 1;
  return `an-heat ${verdict === 'worse' ? 'bad' : 'good'}-${step}`;
}

/* ------------------------------------------------------------------ severity / confidence */

const SEV: Record<string, { cls: string; Icon: typeof Info; label: string }> = {
  CRITICAL: { cls: 'fail', Icon: AlertOctagon, label: 'Critical' },
  WARNING: { cls: 'warn', Icon: AlertTriangle, label: 'Warning' },
  INFO: { cls: 'info', Icon: Info, label: 'Info' },
};
export function SeverityBadge({ value, compact }: { value: string; compact?: boolean }) {
  const s = SEV[value] ?? SEV.INFO;
  return <span className={`badge ${s.cls} an-sev`}><s.Icon size={11} aria-hidden />{compact ? null : s.label}{compact && <span className="sr-only">{s.label}</span>}</span>;
}
export const severityRank = (s: string) => (s === 'CRITICAL' ? 0 : s === 'WARNING' ? 1 : 2);

/** Confidence vocabulary (never overstated): the label is primary, the score secondary. */
export const CONFIDENCE_LEVELS = ['Strong correlation', 'Likely bottleneck', 'Possible bottleneck', 'Insufficient evidence'] as const;
export function confidenceLevel(label?: string | null, confidence?: number | null): number {
  const i = CONFIDENCE_LEVELS.findIndex((l) => l.toLowerCase() === (label ?? '').toLowerCase());
  if (i >= 0) return 3 - i; // 3 strong … 0 insufficient
  if (confidence == null) return -1;
  return confidence >= 0.8 ? 3 : confidence >= 0.65 ? 2 : confidence >= 0.45 ? 1 : 0;
}
export function ConfidenceLabel({ label, confidence }: { label?: string | null; confidence?: number | null }) {
  const lvl = confidenceLevel(label, confidence);
  if (lvl < 0) return null;
  const text = label ?? CONFIDENCE_LEVELS[3 - lvl];
  return (
    <span className={`an-conf lvl-${lvl}`} title={`${text}${confidence != null ? ` — model score ${Math.round(confidence * 100)}%` : ''}. Correlation is evidence, not proof of root cause.`}>
      <span className="an-conf-bars" aria-hidden>{[0, 1, 2].map((i) => <i key={i} className={i < lvl ? 'on' : ''} />)}</span>
      {lvl === 0 && <CircleDashed size={11} aria-hidden />}
      {text}{confidence != null && <span className="an-conf-score">{Math.round(confidence * 100)}%</span>}
    </span>
  );
}

const PRIO: Record<string, string> = { HIGH: 'fail', MEDIUM: 'warn', LOW: '' };
export const PriorityChip = ({ value }: { value: string }) => <span className={`badge ${PRIO[value] ?? ''}`}>{value} priority</span>;

/** SLA status with icon + label. */
export function SlaStatus({ status, count }: { status: 'PASS' | 'WARNING' | 'FAIL' | string; count?: number }) {
  const m = status === 'PASS' ? { cls: 'pass', Icon: CheckCircle2 } : status === 'FAIL' ? { cls: 'fail', Icon: XCircle } : { cls: 'warn', Icon: AlertTriangle };
  return <span className={`badge ${m.cls}`}><m.Icon size={11} aria-hidden />{count != null ? `${count} ` : ''}{status === 'WARNING' ? 'Warning' : status === 'PASS' ? 'Pass' : status === 'FAIL' ? 'Fail' : status}</span>;
}

export const PercentileMethodNote = ({ method }: { method?: string | null }) =>
  !method ? <span className="muted">—</span>
    : method === 'interval_weighted_approx'
      ? <span className="pf-chip warn an-pm" title="Derived from interval-reported percentiles (JMeter Backend Listener). Shown with ≈.">≈ approximate</span>
      : <span className="pf-chip pass an-pm" title="Merged from latency histograms built from raw samples (~2.5% bucket resolution).">exact histogram</span>;

/* ------------------------------------------------------------------ metric labels */

export const METRIC_META: Record<string, { label: string; unit: string; better: Better }> = {
  p95: { label: 'P95', unit: 'ms', better: 'lower' },
  p99: { label: 'P99', unit: 'ms', better: 'lower' },
  p90: { label: 'P90', unit: 'ms', better: 'lower' },
  p50: { label: 'P50', unit: 'ms', better: 'lower' },
  avg_rt: { label: 'Avg response time', unit: 'ms', better: 'lower' },
  max_rt: { label: 'Max response time', unit: 'ms', better: 'lower' },
  tps: { label: 'Throughput', unit: 'tps', better: 'higher' },
  error_pct: { label: 'Error rate', unit: '%', better: 'lower' },
  cpu_avg: { label: 'CPU avg', unit: '%', better: 'lower' },
  cpu_max: { label: 'CPU max', unit: '%', better: 'lower' },
  mem_max: { label: 'Memory max', unit: '%', better: 'lower' },
  db_latency_avg: { label: 'DB latency', unit: 'ms', better: 'lower' },
  heap_pct_max: { label: 'Heap max', unit: '%', better: 'lower' },
  gc_pause_max: { label: 'GC pause max', unit: 'ms', better: 'lower' },
};
export const metricLabel = (m: string) => METRIC_META[m]?.label ?? m.replace(/_/g, ' ').toUpperCase();

/* ------------------------------------------------------------------ run colours (fixed per position A..F) */

export const RUN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const RunLetter = ({ i }: { i: number }) => <span className={`an-run-letter s${i}`} aria-label={`Run ${RUN_LETTERS[i]}`}>{RUN_LETTERS[i]}</span>;

/* ------------------------------------------------------------------ run picker */

export interface RunLite {
  id: string; runId: string; testId?: string; testName: string; environmentName?: string; buildNumber?: string | null; status: string; result?: string | null;
  startedAt?: string | null; createdAt?: string; isBaseline?: boolean; projectId?: string;
}

export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Searchable run picker (GET /runs?q=). Calls onPick with the chosen run. */
export function RunSearch({ onPick, exclude = [], placeholder = 'Search Run ID, test, build, branch, tag…', disabled, statusFilter, autoFocus }: {
  onPick: (r: RunLite) => void; exclude?: string[]; placeholder?: string; disabled?: boolean; statusFilter?: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const dq = useDebounced(q);
  const wrap = useRef<HTMLDivElement>(null);
  const { data, isFetching } = useQuery({
    queryKey: ['run-search', dq, statusFilter],
    queryFn: () => api.get<{ items: RunLite[] }>('/runs', { q: dq || undefined, pageSize: 12, sort: 'start', order: 'desc', status: statusFilter }),
    enabled: open, staleTime: 10000,
  });
  const items = (data?.items ?? []).filter((r) => !exclude.includes(r.runId));
  useEffect(() => {
    const h = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const pick = (r: RunLite) => { onPick(r); setQ(''); setHi(0); };
  return (
    <div className="an-search" ref={wrap}>
      <Search size={14} className="an-search-icon" aria-hidden />
      <input className="input" value={q} disabled={disabled} placeholder={placeholder} autoFocus={autoFocus}
        role="combobox" aria-expanded={open} aria-controls="an-run-results" aria-label="Search runs"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && items[hi]) { e.preventDefault(); pick(items[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {open && !disabled && (
        <div className="an-search-menu" id="an-run-results" role="listbox">
          {isFetching && !items.length && <div className="an-search-empty">Searching…</div>}
          {!isFetching && !items.length && <div className="an-search-empty">No matching runs</div>}
          {items.map((r, i) => (
            <div key={r.id} role="option" aria-selected={i === hi} className={`an-search-item ${i === hi ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
              <span className="mono an-search-key">{r.runId}</span>
              <span className="an-search-test">{r.testName}<span className="muted"> · {r.environmentName}{r.buildNumber ? ` · build ${r.buildNumber}` : ''}</span></span>
              <span className="an-search-meta">{r.isBaseline && <span className="pf-chip accent">baseline</span>}<StatusBadge value={r.result ?? r.status} /><span className="muted">{fmtDate(r.startedAt ?? r.createdAt)}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ordered selection of runs with letter, reorder ("make reference") and remove. */
export function RunChips({ runs, onRemove, onMakeRef, meta }: { runs: string[]; onRemove: (k: string) => void; onMakeRef?: (k: string) => void; meta?: Record<string, ReactNode> }) {
  return (
    <div className="an-chips">
      {runs.map((k, i) => (
        <span key={k} className={`an-runchip ${i === 0 ? 'ref' : ''}`}>
          
          <RunLetter i={i} />
          <span className="mono">{k}</span>
          {meta?.[k]}
          {i === 0 ? <span className="pf-chip accent" title="Reference: change % is computed against this run">reference</span>
            : onMakeRef && <button className="btn btn-ghost btn-sm an-mini" onClick={() => onMakeRef(k)} title="Use as reference (Run A)">Make A</button>}
          <button className="btn btn-ghost icon-btn btn-sm an-mini" onClick={() => onRemove(k)} aria-label={`Remove ${k}`}><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ misc */

export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith('.csv') ? name : `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.key} role="radio" aria-checked={value === o.key} className={value === o.key ? 'on' : ''} onClick={() => onChange(o.key)}>{o.label}</button>)}
    </div>
  );
}

/** Group helper preserving first-seen order. */
export function groupBy<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return [...m.entries()];
}

export const useNow = () => useMemo(() => Date.now(), []);

/** Minimal transient toast: const [toast, show] = useToast(); show('Saved'); render {toast}. */
export function useToast(): [ReactNode, (msg: string, err?: boolean) => void] {
  const [t, setT] = useState<{ msg: string; err: boolean } | null>(null);
  useEffect(() => { if (!t) return; const h = setTimeout(() => setT(null), t.err ? 6000 : 3000); return () => clearTimeout(h); }, [t]);
  return [t ? <div className={`an-toast ${t.err ? 'err' : ''}`} role="status" aria-live="polite">{t.msg}</div> : null, (msg, err = false) => setT({ msg, err })];
}

export const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);
