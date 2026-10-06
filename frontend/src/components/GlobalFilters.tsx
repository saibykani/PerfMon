import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, RefreshCw, Check } from 'lucide-react';
import { api } from '@/services/api';
import { useFilters, TIME_RANGES, rangeLabel, type GlobalFilters } from '@/stores/filters';

type Opt = { id: string; name: string };
const useList = (key: string, path: string, query: Record<string, any>, enabled = true) =>
  useQuery({ queryKey: [key, query], queryFn: () => api.get<any[]>(path, query), enabled, staleTime: 60000 });

/**
 * Global filter bar: Project / Application / Environment / Test / Run + time range + refresh.
 * `show` limits which selectors render on a page.
 */
export function GlobalFilterBar({ show = ['project', 'application', 'environment', 'test', 'time'], extra }: { show?: ('project' | 'application' | 'environment' | 'test' | 'run' | 'time' | 'refresh')[]; extra?: React.ReactNode }) {
  const f = useFilters();
  const projects = useList('projects', '/projects', {});
  const apps = useList('applications', '/applications', { projectId: f.projectId }, show.includes('application'));
  const envs = useList('environments', '/environments', { projectId: f.projectId, applicationId: f.applicationId }, show.includes('environment'));
  const tests = useList('tests', '/tests', { projectId: f.projectId, applicationId: f.applicationId, environmentId: f.environmentId }, show.includes('test'));
  const runs = useQuery({ queryKey: ['runs-filter', f.testId, f.projectId], queryFn: () => api.get<{ items: any[] }>('/runs', { testId: f.testId, projectId: f.projectId, pageSize: 50 }), enabled: show.includes('run') });

  const sel = (key: keyof GlobalFilters, label: string, opts: Opt[] | undefined) => (
    <select className="select" aria-label={label} value={(f[key] as string) ?? ''} onChange={(e) => f.set({ [key]: e.target.value || null } as any)}>
      <option value="">All {label.toLowerCase()}</option>
      {opts?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
  return (
    <div className="filterbar">
      {show.includes('project') && sel('projectId', 'Projects', projects.data?.map((p) => ({ id: p.id, name: p.name })))}
      {show.includes('application') && sel('applicationId', 'Applications', apps.data?.map((a) => ({ id: a.id, name: a.name })))}
      {show.includes('environment') && sel('environmentId', 'Environments', envs.data?.map((e) => ({ id: e.id, name: `${e.name}${e.application_name ? ` · ${e.application_name}` : ''}` })))}
      {show.includes('test') && sel('testId', 'Tests', tests.data?.map((t) => ({ id: t.id, name: t.name })))}
      {show.includes('run') && sel('runId', 'Runs', runs.data?.items.map((r) => ({ id: r.runId, name: `${r.runId} · ${r.testName}` })))}
      {extra}
      <div className="spacer" />
      {show.includes('time') && <TimeRangePicker />}
      {show.includes('refresh') && <RefreshPicker />}
    </div>
  );
}

export function TimeRangePicker() {
  const { timeRange, set } = useFilters();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox"><Calendar size={14} />{rangeLabel(timeRange)}</button>
      {open && (
        <div className="dt-menu" style={{ minWidth: 240, right: 0 }} onMouseLeave={() => setOpen(false)}>
          {TIME_RANGES.map((t) => (
            <div key={t.key} className="dt-menu-item" onClick={() => { set({ timeRange: { type: 'relative', value: t.key } }); setOpen(false); }}>
              <span style={{ width: 16 }}>{timeRange.type === 'relative' && timeRange.value === t.key && <Check size={14} strokeWidth={3} />}</span>{t.label}
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }} className="stack">
            <span className="muted" style={{ padding: '0 6px' }}>Custom range</span>
            <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button className="btn btn-sm btn-primary" disabled={!from || !to} onClick={() => { set({ timeRange: { type: 'absolute', from: new Date(from).getTime(), to: new Date(to).getTime() } }); setOpen(false); }}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RefreshPicker() {
  const { refreshSec, set } = useFilters();
  return (
    <div className="row" title="Auto refresh">
      <RefreshCw size={14} className="muted" />
      <select className="select" value={refreshSec ?? ''} onChange={(e) => set({ refreshSec: e.target.value ? Number(e.target.value) : null })} aria-label="Refresh interval">
        <option value="">Off</option><option value="5">5s</option><option value="10">10s</option><option value="30">30s</option><option value="60">1m</option><option value="300">5m</option>
      </select>
    </div>
  );
}
