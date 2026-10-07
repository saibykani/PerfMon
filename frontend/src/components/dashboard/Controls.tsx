/** Dashboard header controls: variable selectors, time picker (relative / custom / run window), refresh. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Check, ChevronDown, PlayCircle, RefreshCw } from 'lucide-react';
import { api } from '@/services/api';
import { TIME_RANGES, rangeLabel, type TimeRange } from '@/stores/filters';
import type { Variable, VarValues, VariableType } from './types';

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  return { open, setOpen, ref };
}

/** Parent filters forwarded to /dashboards/variable-options so options cascade. */
const PARENT_PARAM: Partial<Record<VariableType, string>> = { project: 'projectId', application: 'applicationId', environment: 'environmentId', test: 'testId', run: 'runId' };

export function useVariableOptions(v: Variable, values: VarValues, variables: Variable[], projectId?: string | null) {
  const params: Record<string, string | undefined> = { type: v.type, projectId: projectId ?? undefined };
  for (const other of variables) {
    const p = PARENT_PARAM[other.type];
    if (!p || other.name === v.name) continue;
    const val = values[other.name];
    if (typeof val === 'string' && val && val !== 'All') params[p] = val;
  }
  return useQuery({
    queryKey: ['var-options', params],
    queryFn: () => api.get<{ value: string; label: string }[]>('/dashboards/variable-options', params),
    enabled: v.type !== 'custom',
    staleTime: 60000,
  });
}

function VarSelect({ v, value, onChange, variables, values, projectId }: { v: Variable; value: string | string[] | null; onChange: (val: string | string[] | null) => void; variables: Variable[]; values: VarValues; projectId?: string | null }) {
  const opts = useVariableOptions(v, values, variables, projectId);
  const options = useMemo(() => (v.type === 'custom' ? (v.customValues ?? []).map((c) => ({ value: c, label: c })) : opts.data ?? []), [v, opts.data]);
  const pop = usePopover();
  const [q, setQ] = useState('');
  const label = v.label || v.name;
  const labelOf = (val: string) => options.find((o) => o.value === val)?.label ?? val;

  if (!v.multi) {
    return (
      <label className="var-chip">
        <span className="var-name">${v.name}</span>
        <select className="var-select" aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
          {(v.includeAll !== false) && <option value="">All</option>}
          {v.includeAll === false && !value && <option value="">{opts.isLoading ? 'Loading…' : 'Latest'}</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {typeof value === 'string' && value && !options.some((o) => o.value === value) && <option value={value}>{value}</option>}
        </select>
      </label>
    );
  }
  const sel = Array.isArray(value) ? value : value ? [value] : [];
  const toggle = (val: string) => {
    const next = sel.includes(val) ? sel.filter((x) => x !== val) : [...sel, val];
    onChange(next.length ? next : null);
  };
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="var-chip" ref={pop.ref} style={{ position: 'relative' }}>
      <span className="var-name">${v.name}</span>
      <button className="var-select var-multi" aria-haspopup="listbox" aria-label={label} onClick={() => pop.setOpen((x) => !x)}>
        {sel.length === 0 ? 'All' : sel.length === 1 ? labelOf(sel[0]) : `${labelOf(sel[0])} +${sel.length - 1}`}
        <ChevronDown size={12} />
      </button>
      {pop.open && (
        <div className="dt-menu var-menu" role="listbox" aria-multiselectable>
          {options.length > 8 && <input className="input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus style={{ width: '100%', marginBottom: 4 }} />}
          {v.includeAll !== false && (
            <label className="dt-menu-item"><input type="checkbox" checked={sel.length === 0} onChange={() => onChange(null)} />All</label>
          )}
          {shown.map((o) => (
            <label key={o.value} className="dt-menu-item"><input type="checkbox" checked={sel.includes(o.value)} onChange={() => toggle(o.value)} />{o.label}</label>
          ))}
          {!shown.length && <div className="muted" style={{ padding: 6 }}>{opts.isLoading ? 'Loading…' : 'No values'}</div>}
        </div>
      )}
    </div>
  );
}

export function VariableBar({ variables, values, onChange, projectId }: { variables: Variable[]; values: VarValues; onChange: (name: string, val: string | string[] | null) => void; projectId?: string | null }) {
  if (!variables.length) return null;
  return (
    <div className="var-bar" aria-label="Dashboard variables">
      {variables.map((v) => <VarSelect key={v.name} v={v} value={values[v.name] ?? null} onChange={(val) => onChange(v.name, val)} variables={variables} values={values} projectId={projectId} />)}
    </div>
  );
}

const toLocal = (ms?: number) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

export function DashTimePicker({ value, onChange, runId }: { value: TimeRange; onChange: (t: TimeRange) => void; runId?: string | null }) {
  const pop = usePopover();
  const [from, setFrom] = useState(toLocal(value.from));
  const [to, setTo] = useState(toLocal(value.to));
  const [run, setRun] = useState(value.runId ?? runId ?? '');
  const recent = useQuery({ queryKey: ['runs-recent-picker'], queryFn: () => api.get<{ items: any[] }>('/runs', { pageSize: 15, sort: 'start', order: 'desc' }), enabled: pop.open, staleTime: 30000 });
  const label = value.type === 'run' ? `Run window${value.runId ? ` · ${value.runId}` : runId ? ` · $run` : ''}` : rangeLabel(value);
  return (
    <div style={{ position: 'relative' }} ref={pop.ref}>
      <button className="btn" onClick={() => pop.setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={pop.open}>
        {value.type === 'run' ? <PlayCircle size={14} /> : <Calendar size={14} />}<span className="tp-label">{label}</span><ChevronDown size={12} />
      </button>
      {pop.open && (
        <div className="dt-menu time-menu" role="dialog" aria-label="Time range">
          <div className="time-cols">
            <div>
              <div className="menu-label">Relative</div>
              {TIME_RANGES.map((t) => (
                <div key={t.key} className="dt-menu-item" role="option" aria-selected={value.type === 'relative' && value.value === t.key}
                  onClick={() => { onChange({ type: 'relative', value: t.key }); pop.setOpen(false); }}>
                  <span style={{ width: 14 }}>{value.type === 'relative' && value.value === t.key && <Check size={13} strokeWidth={3} />}</span>{t.label}
                </div>
              ))}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <div>
                <div className="menu-label">Custom range</div>
                <div className="stack" style={{ gap: 6 }}>
                  <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                  <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
                  <button className="btn btn-sm btn-primary" disabled={!from || !to || new Date(from) >= new Date(to)}
                    onClick={() => { onChange({ type: 'absolute', from: new Date(from).getTime(), to: new Date(to).getTime() }); pop.setOpen(false); }}>Apply range</button>
                </div>
              </div>
              <div>
                <div className="menu-label">Run window</div>
                <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>Exact execution window of a run{runId ? ' (defaults to $run)' : ''}.</div>
                <select className="select" style={{ width: '100%' }} value={run} onChange={(e) => setRun(e.target.value)} aria-label="Run">
                  <option value="">{runId ? `Use $run (${runId})` : 'Use $run variable'}</option>
                  {recent.data?.items.map((r) => <option key={r.id} value={r.runId}>{r.runId} · {r.testName}</option>)}
                </select>
                <button className="btn btn-sm" style={{ marginTop: 6, width: '100%', justifyContent: 'center' }}
                  onClick={() => { onChange({ type: 'run', runId: run || undefined }); pop.setOpen(false); }}><PlayCircle size={13} />Use run window</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const REFRESH_OPTIONS = [
  { v: 0, l: 'Off' }, { v: 5, l: '5s' }, { v: 10, l: '10s' }, { v: 30, l: '30s' }, { v: 60, l: '1m' }, { v: 300, l: '5m' }, { v: 900, l: '15m' },
];

export function RefreshControl({ value, onChange, onRefresh, fetching }: { value: number | null; onChange: (s: number | null) => void; onRefresh: () => void; fetching?: boolean }) {
  return (
    <div className="seg refresh-seg">
      <button onClick={onRefresh} title="Refresh now" aria-label="Refresh now"><RefreshCw size={13} className={fetching ? 'spin' : ''} /></button>
      <select className="seg-select" value={value ?? 0} onChange={(e) => onChange(Number(e.target.value) || null)} aria-label="Auto refresh interval" title="Auto refresh">
        {REFRESH_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );
}
