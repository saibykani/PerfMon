import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Bell, CalendarClock, Crosshair, FileSearch, PenLine, Plus, Rocket, Search, X } from 'lucide-react';
import { api, ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { ErrorBox, Field, Modal } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { EmptyState, SeverityIcon, fmtTime } from '../common';
import type { RunDetail } from '../types';

const enc = encodeURIComponent;

interface LogItem { id: string; ts: string; level: string | null; service: string | null; server: string | null; logger: string | null; message: string }

export function LogsTab({ run }: { run: RunDetail }) {
  const [sp, setSp] = useSearchParams();
  const around = sp.get('around');
  const from = sp.get('from');
  const to = sp.get('to');
  const [level, setLevel] = useState('');
  const [service, setService] = useState('');
  const [text, setText] = useState('');
  const [qText, setQText] = useState('');
  const [windowSec, setWindowSec] = useState(60);
  useEffect(() => { const id = setTimeout(() => setQText(text), 300); return () => clearTimeout(id); }, [text]);
  const q = useQuery({
    queryKey: ['run-sub', run.runId, 'logs', around, from, to, level, service, qText, windowSec],
    queryFn: () => api.get<{ items: LogItem[]; facets: { level: string | null; service: string | null; n: number }[]; from?: string; to?: string }>(`/runs/${enc(run.runId)}/logs`, { around, from: around ? undefined : from, to: around ? undefined : to, windowSec: around ? windowSec : undefined, level, service, q: qText, limit: 1000 }),
    placeholderData: (p) => p,
  });
  const facets = q.data?.facets ?? [];
  const levels = useMemo(() => { const m = new Map<string, number>(); for (const f of facets) if (f.level) m.set(f.level, (m.get(f.level) ?? 0) + f.n); return [...m.entries()]; }, [facets]);
  const services = useMemo(() => [...new Set(facets.map((f) => f.service).filter(Boolean))] as string[], [facets]);
  const clearTime = () => { const n = new URLSearchParams(sp); n.delete('around'); n.delete('from'); n.delete('to'); setSp(n, { replace: true }); };
  const aroundTs = around ? Number(around) : null;
  const totalLogs = facets.reduce((a, f) => a + f.n, 0);

  return (
    <div className="stack">
      {(around || from) && (
        <div className="range-bar">
          <Crosshair size={14} />
          {around ? <span>Logs within <select className="select select-inline" value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))} aria-label="Correlation window">
            {[15, 30, 60, 120, 300].map((s) => <option key={s} value={s}>±{s}s</option>)}</select> of <b className="num">{fmtTime(aroundTs)}</b> (clicked on the timeline)</span>
            : <span>Logs between <b className="num">{fmtTime(Number(from))}</b> and <b className="num">{fmtTime(Number(to))}</b></span>}
          <div className="spacer" />
          <button className="btn btn-sm" onClick={clearTime}><X size={13} />Show whole run</button>
        </div>
      )}
      <section className="card">
        <div className="card-head row wrap">
          <div className="dt-search"><Search size={13} /><input className="input" placeholder="Search messages…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search log messages" /></div>
          <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Log level">
            <option value="">All levels</option>{levels.map(([l, n]) => <option key={l} value={l}>{l} ({n})</option>)}
          </select>
          <select className="select" value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
            <option value="">All services</option>{services.map((s) => <option key={s}>{s}</option>)}
          </select>
          <div className="spacer" />
          <span className="muted small">{q.data ? `${q.data.items.length.toLocaleString()} shown · ${totalLogs.toLocaleString()} indexed for this run` : ''}</span>
        </div>
        {q.error && <div className="card-body"><ErrorBox error={q.error} /></div>}
        {!q.isLoading && !q.data?.items.length ? (
          <EmptyState icon={<FileSearch size={24} />} title={totalLogs ? 'No log lines match' : 'No logs correlated with this run'}>
            {totalLogs ? 'Widen the time window or clear filters.' : <>Upload <b>SERVER_LOG</b> / <b>APP_LOG</b> artifacts (they are indexed automatically) or ship logs with the Run ID — then click any timeline point to jump here.</>}
          </EmptyState>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 620 }}>
            <table className="table log-table">
              <thead><tr><th style={{ width: 110 }}>Time</th><th style={{ width: 70 }}>Level</th><th style={{ width: 140 }}>Service</th><th>Message</th></tr></thead>
              <tbody>
                {q.isLoading && <tr><td colSpan={4}><div className="skeleton" style={{ height: 14 }} /></td></tr>}
                {q.data?.items.map((l) => {
                  const near = aroundTs != null && Math.abs(new Date(l.ts).getTime() - aroundTs) < 2000;
                  return (
                    <tr key={l.id} className={near ? 'row-current' : ''}>
                      <td className="mono num">{fmtTime(l.ts)}</td>
                      <td><span className={`lvl lvl-${(l.level ?? '').toLowerCase()}`}>{l.level ?? '—'}</span></td>
                      <td className="small">{l.service ?? '—'}{l.server && <div className="muted">{l.server}</div>}</td>
                      <td className="mono log-msg">{l.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface EventsResp {
  events: { id: string; type: string; severity: string; ts: string; title: string; description: string | null; source: string }[];
  annotations: { id: string; ts: string; ts_end: string | null; title: string; text: string | null; tags: string[]; created_by_name: string | null }[];
  alerts: { id: string; type: string; severity: string; status: string; title: string; message: string | null; value: number | null; threshold: number | null; fired_at: string; resolved_at: string | null }[];
}

export function EventsTab({ run }: { run: RunDetail }) {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'events'], queryFn: () => api.get<EventsResp>(`/runs/${enc(run.runId)}/events`) });
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'event' | 'annotation' | 'alert'>('all');
  const items = useMemo(() => {
    const d = q.data;
    if (!d) return [];
    return [
      ...d.events.map((e) => ({ kind: 'event' as const, id: e.id, ts: e.ts, title: e.title, sub: e.description, severity: e.severity, tag: e.type.replace(/_/g, ' '), meta: e.source })),
      ...d.annotations.map((a) => ({ kind: 'annotation' as const, id: a.id, ts: a.ts, title: a.title, sub: a.text, severity: 'INFO', tag: 'ANNOTATION', meta: [a.created_by_name, ...(a.tags ?? [])].filter(Boolean).join(' · ') })),
      ...d.alerts.map((a) => ({ kind: 'alert' as const, id: a.id, ts: a.fired_at, title: a.title, sub: a.message, severity: a.severity, tag: a.status, meta: a.value != null ? `value ${a.value}${a.threshold != null ? ` / threshold ${a.threshold}` : ''}` : '' })),
    ].filter((i) => filter === 'all' || i.kind === filter).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }, [q.data, filter]);
  const counts = { event: q.data?.events.length ?? 0, annotation: q.data?.annotations.length ?? 0, alert: q.data?.alerts.length ?? 0 };
  const icon = (k: string) => (k === 'annotation' ? <PenLine size={13} /> : k === 'alert' ? <Bell size={13} /> : <Rocket size={13} />);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <div className="seg" role="radiogroup" aria-label="Filter timeline">
            {(['all', 'event', 'annotation', 'alert'] as const).map((k) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{k === 'all' ? `All (${counts.event + counts.annotation + counts.alert})` : `${k[0].toUpperCase()}${k.slice(1)}s (${counts[k]})`}</button>)}
          </div>
          {can('VIEW_RUN') && <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}><Plus size={14} />Add annotation</button>}
        </div>
        {q.error && <div className="card-body"><ErrorBox error={q.error} /></div>}
        {!q.isLoading && !items.length ? (
          <EmptyState icon={<CalendarClock size={24} />} title="Nothing on the timeline">Deployments, config changes, alerts and annotations during the run window appear here and as markers on the Overview charts.</EmptyState>
        ) : (
          <ol className="evt-timeline">
            {items.map((i) => (
              <li key={`${i.kind}-${i.id}`} className={`evt evt-${i.kind} sev-${i.severity.toLowerCase()}`}>
                <span className="evt-dot">{icon(i.kind)}</span>
                <div className="evt-body">
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="mono num muted">{new Date(i.ts).toLocaleString()}</span>
                    {i.severity !== 'INFO' && <SeverityIcon severity={i.severity} size={13} />}
                    <b>{i.title}</b>
                    {i.kind === 'alert' ? <StatusBadge value={i.tag} /> : <span className="badge">{i.tag}</span>}
                  </div>
                  {i.sub && <div className="text-2 small">{i.sub}</div>}
                  {i.meta && <div className="muted small">{i.meta}</div>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <AnnotationModal open={open} onClose={() => setOpen(false)} run={run} onSaved={() => { qc.invalidateQueries({ queryKey: ['run-sub', run.runId, 'events'] }); qc.invalidateQueries({ queryKey: ['run-sub', run.runId, 'timeline'] }); }} />
    </div>
  );
}

function toLocalInput(ms: number) { const d = new Date(ms - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 19); }

export function AnnotationModal({ open, onClose, run, onSaved, defaultTs }: { open: boolean; onClose: () => void; run: RunDetail; onSaved: () => void; defaultTs?: number }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [ts, setTs] = useState('');
  const [tags, setTags] = useState('');
  useEffect(() => { if (open) setTs(toLocalInput(defaultTs ?? (run.startedAt ? new Date(run.startedAt).getTime() : Date.now()))); }, [open, defaultTs, run.startedAt]);
  const m = useMutation({
    mutationFn: () => api.post('/annotations', { projectId: run.projectId, runId: run.id, environmentId: run.environmentId, title, text: text || undefined, ts: new Date(ts).toISOString(), tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }),
    onSuccess: () => { onSaved(); onClose(); setTitle(''); setText(''); setTags(''); },
  });
  const missing = m.error instanceof ApiError && m.error.status === 404;
  return (
    <Modal open={open} onClose={onClose} title="Add annotation" width={480}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || !ts || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Add annotation'}</button></>}>
      <div className="stack">
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Cache flushed on app-02" /></Field>
        <Field label="Time"><input className="input" type="datetime-local" step={1} value={ts} onChange={(e) => setTs(e.target.value)} /></Field>
        <Field label="Note"><textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <Field label="Tags" hint="comma separated"><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        {missing ? <div className="notice">The annotations service is not available on this server yet — try again after the Events module is deployed.</div> : m.error ? <ErrorBox error={m.error} /> : null}
      </div>
    </Modal>
  );
}
