/** SLA rule model helpers: human-readable sentences, Good / Warning / Critical bands, validation. */
import type { ReactNode } from 'react';

export interface SlaMetricDef { label: string; unit: string; direction: 'LOWER' | 'HIGHER' }
export type SlaMetrics = Record<string, SlaMetricDef>;

/** Metrics a TRANSACTION-scoped rule can be evaluated against (per-transaction statistics). */
export const TXN_METRICS = new Set(['avg_rt', 'p50', 'p90', 'p95', 'p99', 'max_rt', 'error_pct', 'tps']);

/** Short labels used in rule sentences. */
export const SHORT: Record<string, string> = {
  avg_rt: 'Avg RT', p50: 'P50', p90: 'P90', p95: 'P95', p99: 'P99', max_rt: 'Max RT', error_pct: 'Error %', tps: 'TPS',
  cpu_pct: 'CPU (p90)', memory_pct: 'Memory (max)', heap_pct: 'JVM heap (max)', gc_pause_ms: 'GC pause (max)', db_latency_ms: 'DB latency (avg)',
};

/** Display order + grouping for the metric picker. */
export const METRIC_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Response time', keys: ['p50', 'p90', 'p95', 'p99', 'avg_rt', 'max_rt'] },
  { label: 'Throughput & errors', keys: ['error_pct', 'tps'] },
  { label: 'Infrastructure & runtime', keys: ['cpu_pct', 'memory_pct', 'heap_pct', 'gc_pause_ms', 'db_latency_ms'] },
];

export interface RuleDraft {
  key: string;
  name: string;
  metric: string;
  scope: 'RUN' | 'TRANSACTION';
  transactionPattern: string;
  direction: 'LOWER' | 'HIGHER';
  warningValue: string;
  criticalValue: string;
  unit: string;
  enabled: boolean;
}

let seq = 0;
export const newKey = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

export function ruleFromRow(r: any): RuleDraft {
  const g = (a: string, b: string) => r[a] ?? r[b];
  const num = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
  return {
    key: r.id ?? newKey(),
    name: g('name', 'name') ?? '',
    metric: g('metric', 'metric'),
    scope: (g('scope', 'scope') ?? 'RUN') as RuleDraft['scope'],
    transactionPattern: g('transactionPattern', 'transaction_pattern') ?? '',
    direction: (g('direction', 'direction') ?? 'LOWER') as RuleDraft['direction'],
    warningValue: num(g('warningValue', 'warning_value')),
    criticalValue: num(g('criticalValue', 'critical_value')),
    unit: g('unit', 'unit') ?? '',
    enabled: g('enabled', 'enabled') !== false,
  };
}

export function ruleToBody(r: RuleDraft) {
  const n = (v: string) => (v.trim() === '' ? null : Number(v));
  return {
    name: r.name.trim() || null,
    metric: r.metric,
    scope: r.scope,
    transactionPattern: r.scope === 'TRANSACTION' ? r.transactionPattern.trim() || null : null,
    direction: r.direction,
    warningValue: n(r.warningValue),
    criticalValue: n(r.criticalValue),
    unit: r.unit || null,
    enabled: r.enabled,
  };
}

export function blankRule(metrics: SlaMetrics, metric = 'p95'): RuleDraft {
  const def = metrics[metric] ?? { unit: 'ms', direction: 'LOWER' as const };
  const ms = def.unit === 'ms';
  return {
    key: newKey(), name: '', metric, scope: 'RUN', transactionPattern: '', direction: def.direction,
    warningValue: ms ? '1000' : '', criticalValue: ms ? '2000' : '', unit: def.unit, enabled: true,
  };
}

export const unitSuffix = (unit: string) => (unit === 'tps' ? '/s' : unit === '%' ? '%' : unit ? ` ${unit}` : '');

/** Format a threshold for sentences ("1 s", "750 ms", "2%", "120/s"). */
export function fmtThreshold(v: number, unit: string) {
  const n = (x: number) => String(+x.toFixed(2));
  if (unit === 'ms') return v >= 1000 ? `${n(v / 1000)} s` : `${n(v)} ms`;
  if (unit === '%') return `${n(v)}%`;
  if (unit === 'tps') return `${n(v)}/s`;
  return `${n(v)}${unit ? ` ${unit}` : ''}`;
}

const numOrNull = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

/** "P95 < 1000 ms" — the hard SLA (critical, else warning) expressed as the passing condition. */
export function ruleSentence(r: RuleDraft) {
  const w = numOrNull(r.warningValue);
  const c = numOrNull(r.criticalValue);
  const hard = c ?? w;
  const label = SHORT[r.metric] ?? r.metric;
  const scope = r.scope === 'TRANSACTION' ? `${r.transactionPattern.trim() || '*'} · ` : '';
  if (hard == null) return `${scope}${label} — no threshold`;
  const raw = r.unit === 'ms' ? `${+hard.toFixed(2)} ms` : fmtThreshold(hard, r.unit);
  return `${scope}${label} ${r.direction === 'LOWER' ? '<' : '≥'} ${raw}`;
}

export interface Band { tone: 'g' | 'w' | 'c'; label: string; text: string; frac: number }

/**
 * Good / Warning / Critical bands matching the backend evaluator:
 * LOWER-is-better breaches at value ≥ threshold, HIGHER-is-better breaches at value < threshold.
 */
export function ruleBands(r: RuleDraft): Band[] {
  const w = numOrNull(r.warningValue);
  const c = numOrNull(r.criticalValue);
  const f = (v: number) => fmtThreshold(v, r.unit);
  if (w == null && c == null) return [];
  if (r.direction === 'LOWER') {
    if (w != null && c != null) {
      const max = Math.max(c * 1.35, 1e-9);
      return [
        { tone: 'g', label: 'Good', text: `< ${f(w)}`, frac: w / max },
        { tone: 'w', label: 'Warning', text: `${f(w)}–${f(c)}`, frac: Math.max((c - w) / max, 0.04) },
        { tone: 'c', label: 'Critical', text: `≥ ${f(c)}`, frac: Math.max(1 - c / max, 0.18) },
      ];
    }
    const t = (c ?? w)!;
    return [
      { tone: 'g', label: 'Good', text: `< ${f(t)}`, frac: 0.7 },
      c != null ? { tone: 'c', label: 'Critical', text: `≥ ${f(t)}`, frac: 0.3 } : { tone: 'w', label: 'Warning', text: `≥ ${f(t)}`, frac: 0.3 },
    ];
  }
  if (w != null && c != null) {
    const max = Math.max(w * 1.35, 1e-9);
    return [
      { tone: 'c', label: 'Critical', text: `< ${f(c)}`, frac: Math.max(c / max, 0.12) },
      { tone: 'w', label: 'Warning', text: `${f(c)}–${f(w)}`, frac: Math.max((w - c) / max, 0.04) },
      { tone: 'g', label: 'Good', text: `≥ ${f(w)}`, frac: Math.max(1 - w / max, 0.18) },
    ];
  }
  const t = (c ?? w)!;
  return [
    c != null ? { tone: 'c', label: 'Critical', text: `< ${f(t)}`, frac: 0.3 } : { tone: 'w', label: 'Warning', text: `< ${f(t)}`, frac: 0.3 },
    { tone: 'g', label: 'Good', text: `≥ ${f(t)}`, frac: 0.7 },
  ];
}

const BAND_VAR: Record<Band['tone'], string> = { g: 'var(--pass)', w: 'var(--warn)', c: 'var(--fail)' };

export function BandPreview({ rule }: { rule: RuleDraft }) {
  const bands = ruleBands(rule);
  if (!bands.length) return <span className="muted">Set a warning and/or critical threshold to preview the bands.</span>;
  const total = bands.reduce((a, b) => a + b.frac, 0);
  const label = SHORT[rule.metric] ?? rule.metric;
  return (
    <div className="pf-band" aria-label={`${label} ${bands.map((b) => `${b.label} ${b.text}`).join(', ')}`}>
      <div className="pf-band-bar" aria-hidden>{bands.map((b, i) => <div key={i} className={b.tone} style={{ width: `${(b.frac / total) * 100}%` }} />)}</div>
      <div className="pf-band-legend">
        <b style={{ color: 'var(--text)' }}>{label}</b>
        {bands.map((b, i) => <span key={i}><i style={{ background: BAND_VAR[b.tone] }} />{b.label} <b className="num">{b.text}</b></span>)}
      </div>
    </div>
  );
}

/** Returns field → message map (empty = valid). */
export function validateRule(r: RuleDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!r.metric) e.metric = 'Pick a metric';
  if (r.scope === 'TRANSACTION') {
    if (!r.transactionPattern.trim()) e.transactionPattern = 'Pattern required (glob, e.g. Login* or *)';
    if (r.metric && !TXN_METRICS.has(r.metric)) e.metric = 'Transaction scope supports response time, error % and TPS only';
  }
  const bad = (s: string) => s.trim() !== '' && (!Number.isFinite(Number(s)) || Number(s) < 0);
  if (bad(r.warningValue)) e.warningValue = 'Must be a number ≥ 0';
  if (bad(r.criticalValue)) e.criticalValue = 'Must be a number ≥ 0';
  const w = numOrNull(r.warningValue);
  const c = numOrNull(r.criticalValue);
  if (w == null && c == null && !e.warningValue && !e.criticalValue) e.criticalValue = 'Set a warning and/or critical threshold';
  if (w != null && c != null) {
    if (r.direction === 'LOWER' && w >= c) e.warningValue = 'Warning must be lower than critical (lower is better)';
    if (r.direction === 'HIGHER' && w <= c) e.warningValue = 'Warning must be higher than critical (higher is better)';
  }
  if (r.unit === '%' && ((w ?? 0) > 100 || (c ?? 0) > 100)) e.criticalValue = e.criticalValue ?? 'Percentages cannot exceed 100';
  return e;
}

export const Explain = ({ children }: { children: ReactNode }) => <span className="pf-sub">{children}</span>;
