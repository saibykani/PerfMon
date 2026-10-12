import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Filter, RefreshCw, Search, X, ZoomOut } from 'lucide-react';
import { useObsFilters } from '@/stores/obsFilters';
import { useApplications, useEnvironments, useProjects } from '@/components/inventory/data';
import { useObsInventory, type ObsInventory } from './obsApi';
import {
  FILTER_KEYS, QUICK_RANGES, REFRESH_OPTIONS, autoStep, formatDateTime, formatSpan, formatStep, obsUrlPart, parseDateTime, rangeLabel, readUrlState,
  resolveTime, shiftRange, toPickerValue, tzLabel, validateRange, writeUrlState, zoomOut, type FilterKey, type ObsFilterValues, type QuickKey,
} from './obsTime';
import '@/styles/observability.css';

export const FILTER_LABEL: Record<FilterKey, string> = {
  projectId: 'Project', environmentId: 'Environment', applicationId: 'Application', runId: 'Run', role: 'Role', hostId: 'Host', databaseId: 'Database', serviceId: 'Service',
  cluster: 'Cluster', namespace: 'Namespace', workload: 'Workload', pod: 'Pod', node: 'Node',
};

export const HOST_ROLES = ['app', 'db', 'loadgen', 'gateway'];
export const ROLE_LABEL: Record<string, string> = { app: 'Application', db: 'Database', loadgen: 'Load generator', gateway: 'Gateway' };

export interface Opt { value: string; label: string; hint?: string }

/* ------------------------------------------------------------------ URL sync */

/** Two-way sync between the store and the URL query string (back/forward + shareable links). */
export function useObsUrlSync() {
  const [sp, setSp] = useSearchParams();
  const search = sp.toString();
  const state = useObsFilters();
  const serialized = obsUrlPart(writeUrlState(state));

  // URL → store (initial load, back/forward, pasted links)
  useEffect(() => {
    const parsed = readUrlState(search);
    if (!parsed) return;
    const cur = obsUrlPart(writeUrlState(useObsFilters.getState()));
    if (obsUrlPart(writeUrlState(parsed)) !== cur) useObsFilters.getState().hydrate(parsed);
  }, [search]);

  // store → URL (push so that back/forward walks through window/filter changes)
  const first = useRef(true);
  useEffect(() => {
    // read the live query string: other params (e.g. panels) may have been written in this tick
    const live = window.location.search;
    const fresh = writeUrlState(useObsFilters.getState(), live);
    if (obsUrlPart(fresh) !== obsUrlPart(live)) setSp(fresh, { replace: first.current });
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
}

/* ------------------------------------------------------------------ popover */

function Popover({ label, children, className, open, setOpen, title, active }: {
  label: ReactNode; children: ReactNode; className?: string; open: boolean; setOpen: (v: boolean) => void; title?: string; active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open, setOpen]);
  return (
    <div className="obs-pop-wrap" ref={ref}>
      <button type="button" className={`btn btn-sm obs-pop-btn ${active ? 'obs-active' : ''}`} aria-expanded={open} title={title} onClick={() => setOpen(!open)}>{label}<ChevronDown size={12} /></button>
      {open && <div className={`obs-pop ${className ?? ''}`} role="dialog">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ multi-select */

export function MultiSelect({ label, options, value, onChange, placeholder }: { label: string; options: Opt[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = n ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(n)) : options;
    return list.slice(0, 300);
  }, [options, q]);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Popover open={open} setOpen={setOpen} active={value.length > 0} className="obs-ms"
      label={<>{label}{value.length > 0 && <span className="obs-count">{value.length}</span>}</>}>
      <div className="obs-ms-search"><Search size={13} /><input className="input" autoFocus placeholder={placeholder ?? `Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${label}`} /></div>
      <div className="obs-ms-list" role="listbox" aria-multiselectable="true">
        {!shown.length && <div className="muted small obs-ms-empty">{options.length ? 'No match' : 'Nothing reported in this window'}</div>}
        {shown.map((o) => {
          const on = value.includes(o.value);
          return (
            <button key={o.value} type="button" role="option" aria-selected={on} className={`obs-ms-item ${on ? 'on' : ''}`} onClick={() => toggle(o.value)}>
              <span className="obs-check">{on && <Check size={11} />}</span>
              <span className="obs-ms-label">{o.label}</span>{o.hint && <span className="muted small obs-ms-hint">{o.hint}</span>}
            </button>
          );
        })}
      </div>
      <div className="obs-ms-foot">
        <span className="muted small">{value.length} selected</span>
        <span className="row" style={{ gap: 4 }}>
          {shown.length > 0 && shown.length < 50 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.value)])])}>All</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])} disabled={!value.length}>Clear</button>
        </span>
      </div>
    </Popover>
  );
}

/* ------------------------------------------------------------------ time picker */

function DateTimeInput({ label, value, onChange, tz, seconds }: { label: string; value: string; onChange: (v: string) => void; tz: 'local' | 'utc'; seconds: boolean }) {
  const pick = useRef<HTMLInputElement>(null);
  const parsed = parseDateTime(value, tz);
  return (
    <label className="obs-dt">
      <span className="obs-dt-label">{label}</span>
      <span className="obs-dt-row">
        <input className={`input mono ${value && parsed == null ? 'obs-invalid' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={seconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm'} aria-label={`${label} date and time`} spellCheck={false} />
        <span className="obs-dt-pick">
          <button type="button" className="btn btn-ghost icon-btn btn-sm" aria-label={`Pick ${label}`} title="Pick date and time"
            onClick={() => { try { pick.current?.showPicker?.(); } catch { pick.current?.focus(); } }}><CalendarClock size={14} /></button>
          <input ref={pick} type="datetime-local" tabIndex={-1} aria-hidden="true" step={seconds ? 1 : 60} value={parsed != null ? toPickerValue(parsed, tz, seconds) : ''}
            onChange={(e) => e.target.value && onChange(e.target.value.replace('T', ' ').slice(0, seconds ? 19 : 16))} />
        </span>
      </span>
    </label>
  );
}

function TimePicker() {
  const { time, tz, anchor, setTime } = useObsFilters();
  const [open, setOpen] = useState(false);
  const r = resolveTime(time, anchor);
  const [seconds, setSeconds] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (!open) return;
    const secs = r.from % 60_000 !== 0 || r.to % 60_000 !== 0;
    setSeconds(secs);
    setFrom(formatDateTime(r.from, tz, secs));
    setTo(formatDateTime(r.to, tz, secs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tz]);
  const f = parseDateTime(from, tz);
  const t = parseDateTime(to, tz);
  const err = validateRange(f, t);
  const apply = () => { if (!err && f != null && t != null) { setTime({ mode: 'absolute', from: f, to: t }); setOpen(false); } };

  return (
    <Popover open={open} setOpen={setOpen} className="obs-time-pop" title="Time range"
      label={<><Clock size={13} /><span className="obs-time-label">{rangeLabel(time, tz)}</span></>}>
      <div className="obs-time-grid">
        <div className="obs-quick">
          <div className="obs-pop-title">Quick ranges</div>
          {QUICK_RANGES.map((q) => (
            <button key={q.key} type="button" className={`obs-quick-item ${time.mode === 'relative' && time.key === q.key ? 'on' : ''}`}
              onClick={() => { setTime({ mode: 'relative', key: q.key as QuickKey }); setOpen(false); }}>{q.label}</button>
          ))}
        </div>
        <form className="obs-abs" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <div className="obs-pop-title">Absolute range <span className="muted">({tzLabel(tz)})</span></div>
          <DateTimeInput label="From" value={from} onChange={setFrom} tz={tz} seconds={seconds} />
          <DateTimeInput label="To" value={to} onChange={setTo} tz={tz} seconds={seconds} />
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTo(formatDateTime(Date.now(), tz, seconds))}>To = now</button>
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={seconds} onChange={(e) => {
              const on = e.target.checked; setSeconds(on);
              if (f != null) setFrom(formatDateTime(f, tz, on));
              if (t != null) setTo(formatDateTime(t, tz, on));
            }} />Seconds</label>
          </div>
          {err ? <div className="obs-err" role="alert">{err}</div> : f != null && t != null && <div className="muted small">Window {formatSpan(t - f)} · step {formatStep(autoStep(f, t))} (auto)</div>}
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!err}>Apply range</button>
        </form>
      </div>
    </Popover>
  );
}

/* ------------------------------------------------------------------ options */

const uniq = (opts: Opt[]) => { const seen = new Set<string>(); return opts.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true))); };
const sel = (f: ObsFilterValues, k: FilterKey) => f[k] ?? [];
const within = (vals: string[], v?: string | null) => !vals.length || (v != null && vals.includes(v));

/** Options per filter, narrowed by the parent selections (cluster → namespace → workload → pod). Pure. */
export function buildOptions(inv: ObsInventory | undefined, f: ObsFilterValues, extra: { projects?: Opt[]; environments?: Opt[]; applications?: Opt[] } = {}): Record<FilterKey, Opt[]> {
  const k8s = inv?.kubernetes;
  const cl = sel(f, 'cluster'); const ns = sel(f, 'namespace'); const wl = sel(f, 'workload'); const nd = sel(f, 'node');
  const clusterName = Object.fromEntries((k8s?.clusters ?? []).map((c) => [c.id, c.name]));
  const pods = (k8s?.pods ?? []).filter((p) => within(cl, p.cluster));
  return {
    projectId: extra.projects ?? [],
    environmentId: extra.environments ?? [],
    applicationId: extra.applications ?? [],
    runId: (inv?.runs ?? []).map((r) => ({ value: r.id, label: r.runKey, hint: r.testName })),
    role: uniq([...HOST_ROLES, ...(inv?.hosts ?? []).map((h) => h.role).filter((x): x is string => !!x)].map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r, hint: ROLE_LABEL[r] ? r : undefined }))),
    hostId: (inv?.hosts ?? []).filter((h) => within(sel(f, 'environmentId'), h.environmentId) && within(sel(f, 'projectId'), h.projectId) && within(sel(f, 'role'), h.role))
      .map((h) => ({ value: h.id, label: h.name, hint: h.role ?? undefined })),
    databaseId: (inv?.databases ?? []).filter((d) => within(sel(f, 'hostId'), d.hostId)).map((d) => ({ value: d.id, label: d.name, hint: d.engine ?? undefined })),
    serviceId: (inv?.services ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.kind ?? undefined })),
    cluster: (k8s?.clusters ?? []).map((c) => ({ value: c.id, label: c.name })),
    namespace: uniq((k8s?.namespaces ?? []).filter((n) => within(cl, n.cluster)).map((n) => ({ value: n.name, label: n.name, hint: cl.length === 1 ? undefined : clusterName[n.cluster] }))),
    workload: uniq((k8s?.workloads ?? []).filter((w) => within(cl, w.cluster) && within(ns, w.namespace)).map((w) => ({ value: w.name, label: w.name, hint: [w.kind, w.namespace].filter(Boolean).join(' · ') }))),
    pod: uniq(pods.filter((p) => within(ns, p.namespace) && within(wl, p.workload) && within(nd, p.node)).map((p) => ({ value: p.name, label: p.name, hint: p.namespace }))),
    node: uniq(pods.filter((p) => p.node).map((p) => ({ value: p.node!, label: p.node! }))),
  };
}

/** After a parent changes, drop child selections that are no longer reachable. Pure. */
export function narrowChildren(f: ObsFilterValues, changed: FilterKey, opts: (f: ObsFilterValues) => Record<FilterKey, Opt[]>): ObsFilterValues {
  const chain: FilterKey[] = changed === 'cluster' ? ['namespace', 'workload', 'pod', 'node'] : changed === 'namespace' ? ['workload', 'pod'] : changed === 'workload' ? ['pod']
    : changed === 'node' ? ['pod'] : changed === 'role' ? ['hostId', 'databaseId'] : changed === 'hostId' ? ['databaseId'] : changed === 'projectId' ? ['applicationId', 'environmentId', 'hostId'] : changed === 'applicationId' ? ['environmentId'] : [];
  let out = { ...f };
  for (const k of chain) {
    const cur = out[k];
    if (!cur?.length) continue;
    const allowed = new Set(opts(out)[k].map((o) => o.value));
    if (!allowed.size) continue; // options unknown (e.g. still loading) — keep the selection
    const kept = cur.filter((v) => allowed.has(v));
    out = { ...out, [k]: kept };
    if (!kept.length) delete out[k];
  }
  return out;
}

/* ------------------------------------------------------------------ bar */

export const ALL_DIMS: FilterKey[] = [...FILTER_KEYS];
export const K8S_DIMS: FilterKey[] = ['cluster', 'namespace', 'workload', 'pod', 'node'];

export function ObsFilterBar({ dims = ALL_DIMS, hideEmptyK8s = true, extra, fixed }: { dims?: FilterKey[]; hideEmptyK8s?: boolean; extra?: ReactNode; fixed?: ObsFilterValues }) {
  useObsUrlSync();
  const qc = useQueryClient();
  const { time, tz, refreshSec, filters, anchor, setTime, setTz, setRefresh, setFilters, refreshNow, clearFilters } = useObsFilters();
  const r = resolveTime(time, anchor);
  const inv = useObsInventory(r.from, r.to);
  const one = (k: FilterKey) => (filters[k]?.length === 1 ? filters[k]![0] : null);
  const projects = useProjects();
  const apps = useApplications(one('projectId'));
  const envs = useEnvironments({ projectId: one('projectId'), applicationId: one('applicationId') });

  const extraOpts = useMemo(() => ({
    projects: (projects.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.key })),
    applications: (apps.data ?? []).filter((a) => within(sel(filters, 'projectId'), a.project_id)).map((a) => ({ value: a.id, label: a.name, hint: a.project_name })),
    environments: (envs.data ?? []).filter((e) => within(sel(filters, 'projectId'), e.project_id) && within(sel(filters, 'applicationId'), e.application_id))
      .map((e) => ({ value: e.id, label: e.name, hint: e.application_name })),
  }), [projects.data, apps.data, envs.data, filters]);
  const optsFor = (f: ObsFilterValues) => buildOptions(inv.data, { ...f, ...(fixed ?? {}) }, extraOpts);
  const options = optsFor(filters);

  // auto refresh (relative ranges only)
  useEffect(() => {
    if (time.mode !== 'relative' || !refreshSec) return;
    const id = setInterval(() => refreshNow(), refreshSec * 1000);
    return () => clearInterval(id);
  }, [time.mode, refreshSec, refreshNow]);

  const hasK8s = (inv.data?.kubernetes?.clusters.length ?? 0) > 0;
  const shownDims = dims.filter((k) => !(hideEmptyK8s && K8S_DIMS.includes(k) && !hasK8s && !filters[k]?.length));
  const change = (k: FilterKey, v: string[]) => {
    const next = { ...filters, [k]: v };
    if (!v.length) delete next[k];
    setFilters(narrowChildren(next, k, optsFor));
  };
  const labelOf = (k: FilterKey, v: string) => options[k].find((o) => o.value === v)?.label ?? (v.length > 24 ? `${v.slice(0, 8)}…` : v);
  const chips = shownDims.flatMap((k) => (filters[k] ?? []).map((v) => ({ k, v })));
  const span = r.to - r.from;

  return (
    <div className="obs-bar card">
      <div className="obs-bar-row">
        <TimePicker />
        <div className="obs-btn-group">
          <button type="button" className="btn btn-sm icon-btn" title="Shift earlier" aria-label="Shift earlier" onClick={() => setTime({ mode: 'absolute', ...shiftRange(r.from, r.to, -1) })}><ChevronLeft size={14} /></button>
          <button type="button" className="btn btn-sm icon-btn" title="Zoom out ×2" aria-label="Zoom out" onClick={() => setTime({ mode: 'absolute', ...zoomOut(r.from, r.to) })}><ZoomOut size={14} /></button>
          <button type="button" className="btn btn-sm icon-btn" title="Shift later" aria-label="Shift later" disabled={time.mode === 'relative' || r.to >= Date.now() - 1000}
            onClick={() => setTime({ mode: 'absolute', ...shiftRange(r.from, r.to, 1) })}><ChevronRight size={14} /></button>
        </div>
        <div className="seg obs-tz" role="radiogroup" aria-label="Timezone">
          {(['local', 'utc'] as const).map((z) => <button key={z} type="button" role="radio" aria-checked={tz === z} className={tz === z ? 'on' : ''} onClick={() => setTz(z)} title={tzLabel(z)}>{z === 'local' ? 'Local' : 'UTC'}</button>)}
        </div>
        <select className="select obs-refresh" aria-label="Auto refresh" value={time.mode === 'relative' ? refreshSec : 0} disabled={time.mode !== 'relative'}
          title={time.mode === 'relative' ? 'Auto refresh' : 'Auto refresh is available for relative ranges'} onChange={(e) => setRefresh(Number(e.target.value))}>
          {REFRESH_OPTIONS.map((o) => <option key={o.sec} value={o.sec}>{o.sec ? `Every ${o.label}` : 'Auto-refresh off'}</option>)}
        </select>
        <button type="button" className="btn btn-sm icon-btn" title="Refresh now" aria-label="Refresh now" onClick={() => { refreshNow(); qc.invalidateQueries({ queryKey: ['obs'] }); }}>
          <RefreshCw size={13} className={inv.isFetching ? 'spin' : ''} />
        </button>
        {extra}
        <span className="obs-window muted small" title={`${formatDateTime(r.from, tz, true)} → ${formatDateTime(r.to, tz, true)} ${tzLabel(tz, r.to)}`}>
          <span className="mono">{formatDateTime(r.from, tz)}</span> → <span className="mono">{time.mode === 'relative' ? 'now' : formatDateTime(r.to, tz)}</span> {tzLabel(tz, r.to)} · {formatSpan(span)} · step {formatStep(autoStep(r.from, r.to))}
        </span>
      </div>
      <div className="obs-bar-row obs-filters">
        <Filter size={13} className="muted" aria-hidden="true" />
        {shownDims.map((k) => <MultiSelect key={k} label={FILTER_LABEL[k]} options={options[k]} value={filters[k] ?? []} onChange={(v) => change(k, v)} />)}
        {chips.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear all</button>}
      </div>
      {chips.length > 0 && (
        <div className="obs-chips" aria-label="Active filters">
          {chips.map(({ k, v }) => (
            <span key={`${k}:${v}`} className="obs-chip"><span className="muted">{FILTER_LABEL[k]}</span> {labelOf(k, v)}
              <button type="button" aria-label={`Remove ${FILTER_LABEL[k]} ${labelOf(k, v)}`} onClick={() => change(k, (filters[k] ?? []).filter((x) => x !== v))}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      {inv.error && <div className="obs-err small">Filter options unavailable: {(inv.error as Error).message}</div>}
    </div>
  );
}
