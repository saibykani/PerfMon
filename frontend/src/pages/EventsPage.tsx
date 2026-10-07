import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ExternalLink, Pencil, Plus, Search, StickyNote, Trash2, X, Zap } from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { useFilters, resolveRange } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { PageHeader, Kpi, Tabs, ConfirmDialog, ErrorBox } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { fmtDate, fmtNum } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { Segmented, useDebounced } from '@/components/analysis/shared';
import {
  Chip, Drawer, EmptyState, JsonBlock, KeyValueGrid, PillSelect, SeverityChip, ToastHost, errMsg, relTime, toast, plural,
} from '@/components/platform/kit';
import { EVENT_TYPES, TYPE_META, TypeTag, fmtSpan, toFeed, type AnnotationRow, type EventRow, type FeedRow } from '@/components/events/meta';
import { timelineOption } from '@/components/events/timeline';
import { AnnotationForm, EventForm } from '@/components/events/forms';
import '@/styles/events.css';

type TabKey = 'activity' | 'annotations';
type Sev = 'ALL' | 'CRITICAL' | 'WARNING' | 'INFO';
const NONE_E: EventRow[] = [];
const NONE_A: AnnotationRow[] = [];
const TYPE_OPTIONS = ['ANNOTATION', ...EVENT_TYPES].map((t) => ({ value: t, label: TYPE_META[t]?.label ?? t }));

export function EventsPage() {
  const f = useFilters();
  const theme = useUi((s) => s.theme);
  const can = useAuth((s) => s.can);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canAnnotate = can('EDIT_DASHBOARD') || can('EXECUTE_TEST') || can('MANAGE_PROJECT');
  const canRecord = can('EXECUTE_TEST') || can('MANAGE_PROJECT');
  const canDeleteEvent = can('MANAGE_PROJECT');

  const [tab, setTab] = useState<TabKey>('activity');
  const [types, setTypes] = useState<string[]>([]);
  const [sev, setSev] = useState<Sev>('ALL');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [selected, setSelected] = useState<FeedRow | null>(null);
  const [annForm, setAnnForm] = useState<{ open: boolean; initial?: AnnotationRow | null }>({ open: false });
  const [eventForm, setEventForm] = useState(false);
  const [confirm, setConfirm] = useState<FeedRow | null>(null);

  const range = resolveRange(f.timeRange);
  const win = {
    from: range ? new Date(range.from).toISOString() : undefined,
    to: range ? new Date(range.to).toISOString() : undefined,
  };
  const minuteKey = [range?.from && Math.floor(range.from / 60000), range?.to && Math.floor(range.to / 60000)];
  const eventTypes = types.filter((t) => t !== 'ANNOTATION');
  const wantEvents = !types.length || eventTypes.length > 0;
  const wantAnnotations = (!types.length || types.includes('ANNOTATION')) && sev === 'ALL';
  const refetchInterval = f.refreshSec ? f.refreshSec * 1000 : false;

  const evQ = useQuery({
    queryKey: ['events-feed', f.projectId, f.environmentId, eventTypes.join(','), sev, q, ...minuteKey],
    queryFn: () => api.get<EventRow[]>('/events', {
      projectId: f.projectId, environmentId: f.environmentId, type: eventTypes.join(',') || undefined, severity: sev === 'ALL' ? undefined : sev, q: q || undefined, ...win, limit: 2000,
    }),
    enabled: wantEvents, refetchInterval, placeholderData: (p) => p,
  });
  const annQ = useQuery({
    queryKey: ['annotations-feed', f.projectId, f.environmentId, q, ...minuteKey],
    queryFn: () => api.get<AnnotationRow[]>('/annotations', { projectId: f.projectId, environmentId: f.environmentId, q: q || undefined, ...win, limit: 2000 }),
    refetchInterval, placeholderData: (p) => p,
  });

  const events = useMemo(() => (wantEvents ? evQ.data ?? NONE_E : NONE_E), [wantEvents, evQ.data]);
  const annotations = annQ.data ?? NONE_A;
  const feed = useMemo(() => toFeed(events, wantAnnotations ? annotations : []), [events, annotations, wantAnnotations]);
  const loading = (wantEvents && evQ.isLoading) || annQ.isLoading;
  const filtersActive = types.length > 0 || sev !== 'ALL' || !!q;

  const kpi = useMemo(() => {
    const by = (pred: (e: EventRow) => boolean) => events.filter(pred).length;
    return {
      total: events.length,
      deployments: by((e) => ['DEPLOYMENT', 'CONFIG_CHANGE', 'APP_RESTART', 'DB_RESTART'].includes(e.type)),
      runs: new Set(events.filter((e) => e.type === 'TEST_START' && e.runKey).map((e) => e.runKey)).size,
      alerts: by((e) => e.type === 'ALERT' || e.type === 'INCIDENT'),
      critical: by((e) => e.severity === 'CRITICAL'),
      regressions: by((e) => e.type === 'REGRESSION'),
    };
  }, [events]);

  const option = useMemo(() => timelineOption(feed, { from: range?.from, to: range?.to, theme }), [feed, range?.from, range?.to, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const del = useMutation({
    mutationFn: (r: FeedRow) => (r.kind === 'event' ? api.del(`/events/${r.event.id}`) : api.del(`/annotations/${r.annotation.id}`)),
    onSuccess: (_d, r) => {
      toast.success(r.kind === 'event' ? 'Event deleted' : 'Annotation deleted');
      qc.invalidateQueries({ queryKey: ['events-feed'] });
      qc.invalidateQueries({ queryKey: ['annotations-feed'] });
      setSelected((s) => (s?.key === r.key ? null : s));
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const rowActions = (r: FeedRow) => (
    <div className="row ev-actions" onClick={(e) => e.stopPropagation()}>
      {r.kind === 'annotation' && canAnnotate && <>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${r.title}`} title="Edit" onClick={() => setAnnForm({ open: true, initial: r.annotation })}><Pencil size={13} /></button>
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${r.title}`} title="Delete" onClick={() => setConfirm(r)}><Trash2 size={13} /></button>
      </>}
      {r.kind === 'event' && canDeleteEvent && (
        <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${r.title}`} title="Delete event" onClick={() => setConfirm(r)}><Trash2 size={13} /></button>
      )}
    </div>
  );

  const runCell = (k: string | null) => (k ? <Link className="mono" to={`/runs/${k}`} onClick={(e) => e.stopPropagation()}>{k}</Link> : <span className="muted">—</span>);

  const feedCols: Column<FeedRow>[] = [
    {
      key: 'ts', header: 'When', width: 170, value: (r) => r.ts,
      render: (r) => <div className="ev-when"><span>{fmtDate(r.ts)}</span><span className="muted">{relTime(r.ts)}{r.tsEnd ? ` · ${fmtSpan(r.tsEnd - r.ts)} window` : ''}</span></div>,
    },
    { key: 'type', header: 'Type', width: 150, value: (r) => TYPE_META[r.type]?.label ?? r.type, render: (r) => <TypeTag type={r.type} /> },
    {
      key: 'severity', header: 'Severity', width: 110, value: (r) => (r.severity === 'CRITICAL' ? 0 : r.severity === 'WARNING' ? 1 : r.severity === 'INFO' ? 2 : 3),
      render: (r) => (r.kind === 'event' ? <SeverityChip value={r.severity} /> : <span className="muted">—</span>),
    },
    {
      key: 'title', header: 'Title', value: (r) => `${r.title} ${r.text ?? ''}`,
      render: (r) => (
        <div className="ev-title-cell">
          <span className="ev-title">{r.title}</span>
          {r.text && <span className="ev-desc">{r.text}</span>}
          {r.kind === 'annotation' && r.annotation.tags.length > 0 && <span className="ev-tags">{r.annotation.tags.map((t) => <span key={t} className="ev-tag">#{t}</span>)}</span>}
        </div>
      ),
    },
    { key: 'run', header: 'Run', width: 180, value: (r) => r.runKey, render: (r) => runCell(r.runKey) },
    { key: 'env', header: 'Environment', width: 120, value: (r) => (r.kind === 'event' ? r.event.environmentName : null), render: (r) => (r.kind === 'event' && r.event.environmentName) || <span className="muted">—</span>, hidden: true },
    {
      key: 'by', header: 'Source', width: 120, value: (r) => (r.kind === 'event' ? r.event.source : r.annotation.createdByName),
      render: (r) => <span className="text-2">{r.kind === 'event' ? r.event.source ?? '—' : r.annotation.createdByName ?? '—'}</span>,
    },
    { key: 'actions', header: '', width: 72, sortable: false, value: () => '', render: rowActions },
  ];

  const annCols: Column<FeedRow>[] = [
    {
      key: 'title', header: 'Annotation', value: (r) => `${r.title} ${r.text ?? ''}`,
      render: (r) => <div className="ev-title-cell"><span className="ev-title">{r.title}</span>{r.text && <span className="ev-desc">{r.text}</span>}</div>,
    },
    { key: 'ts', header: 'Start', width: 160, value: (r) => r.ts, render: (r) => fmtDate(r.ts) },
    { key: 'dur', header: 'Window', width: 90, align: 'right', value: (r) => (r.tsEnd ? r.tsEnd - r.ts : null), render: (r) => (r.tsEnd ? fmtSpan(r.tsEnd - r.ts) : <span className="muted">point</span>) },
    { key: 'run', header: 'Run', width: 180, value: (r) => r.runKey, render: (r) => runCell(r.runKey) },
    {
      key: 'tags', header: 'Tags', width: 180, value: (r) => (r.kind === 'annotation' ? r.annotation.tags.join(' ') : ''),
      render: (r) => (r.kind === 'annotation' && r.annotation.tags.length ? <span className="ev-tags">{r.annotation.tags.map((t) => <span key={t} className="ev-tag">#{t}</span>)}</span> : <span className="muted">—</span>),
    },
    { key: 'by', header: 'Author', width: 130, value: (r) => (r.kind === 'annotation' ? r.annotation.createdByName : null) },
    { key: 'actions', header: '', width: 72, sortable: false, value: () => '', render: rowActions },
  ];
  const annFeed = useMemo(() => toFeed([], annotations), [annotations]);

  const emptyFeed = (
    <EmptyState icon={<CalendarClock size={22} />} title={filtersActive ? 'No events match these filters' : 'No events in this time range'}
      action={filtersActive
        ? <button className="btn btn-sm" onClick={() => { setTypes([]); setSev('ALL'); setText(''); }}>Clear filters</button>
        : canAnnotate && <button className="btn btn-primary btn-sm" onClick={() => setAnnForm({ open: true })}><Plus size={13} />Add annotation</button>}>
      Test start/end, regressions and alerts are recorded automatically. Deployments and config changes can be sent from CI with <span className="mono">POST /api/v1/events</span>, or marked here as annotations.
    </EmptyState>
  );

  return (
    <div className="ev-page">
      <ToastHost />
      <PageHeader title="Events & Annotations"
        subtitle="Everything that happened around your tests — runs starting and finishing, deployments, alerts, regressions — and the notes your team added for context."
        actions={<>
          {canRecord && <button className="btn" onClick={() => setEventForm(true)}><Zap size={14} />Record event</button>}
          {canAnnotate && <button className="btn btn-primary" onClick={() => setAnnForm({ open: true })}><Plus size={14} />Add annotation</button>}
        </>} />
      <GlobalFilterBar show={['project', 'environment', 'time', 'refresh']} />

      {evQ.error && <ErrorBox error={evQ.error} />}
      {annQ.error && <ErrorBox error={annQ.error} />}

      <div className="kpis">
        <Kpi label="Events" value={loading ? '…' : fmtNum(kpi.total)} sub="in range" />
        <Kpi label="Test runs" value={loading ? '…' : fmtNum(kpi.runs)} sub="started" />
        <Kpi label="Deployments & changes" value={loading ? '…' : fmtNum(kpi.deployments)} sub="deploys, config, restarts" />
        <Kpi label="Alerts & incidents" value={loading ? '…' : fmtNum(kpi.alerts)} status={kpi.alerts ? 'warn' : null} />
        <Kpi label="Critical" value={loading ? '…' : fmtNum(kpi.critical)} status={kpi.critical ? 'fail' : null} sub="severity" onClick={() => setSev('CRITICAL')} />
        <Kpi label="Annotations" value={annQ.isLoading ? '…' : fmtNum(annotations.length)} sub="team notes" onClick={() => setTab('annotations')} />
      </div>

      <Chart title="Timeline" subtitle="drag to pan · shift + wheel to zoom · click a marker for details" height={300} option={option} loading={loading}
        empty={!loading && !feed.length ? (filtersActive ? 'No events match these filters' : 'Nothing happened in this time range') : null}
        onPointClick={(p: any) => {
          const v = p?.value ?? p?.data?.value;
          if (!Array.isArray(v)) return;
          if (v[2] === -1 && v[3]) navigate(`/runs/${v[3]}`);
          else if (feed[v[2]]) setSelected(feed[v[2]]);
        }}
        table={{ columns: ['Time', 'Type', 'Severity', 'Title', 'Run'], rows: feed.slice(0, 500).map((r) => [fmtDate(r.ts), TYPE_META[r.type]?.label ?? r.type, r.severity ?? '—', r.title, r.runKey]) }} />

      <div className="ev-filters">
        <div className="ev-search">
          <Search size={14} aria-hidden />
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search titles, descriptions, tags…" aria-label="Search events" />
          {text && <button className="btn btn-ghost icon-btn btn-sm" onClick={() => setText('')} aria-label="Clear search"><X size={12} /></button>}
        </div>
        <Segmented label="Severity" value={sev} onChange={setSev} options={[
          { key: 'ALL', label: 'Any severity' }, { key: 'CRITICAL', label: 'Critical' }, { key: 'WARNING', label: 'Warning' }, { key: 'INFO', label: 'Info' },
        ]} />
        <div className="spacer" />
        <span className="muted">{plural(feed.length, 'item')}{evQ.data?.length === 2000 ? ' (latest 2,000 events)' : ''}</span>
      </div>
      <div className="ev-types" aria-label="Event types">
        <PillSelect options={TYPE_OPTIONS} value={types} onChange={setTypes} />
        {types.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setTypes([])}>All types</button>}
      </div>
      {sev !== 'ALL' && <div className="ev-note muted">Annotations have no severity, so they are hidden while a severity filter is active.</div>}

      <Tabs<TabKey> value={tab} onChange={setTab} tabs={[
        { key: 'activity', label: 'All activity', badge: feed.length || undefined },
        { key: 'annotations', label: 'Annotations', badge: annotations.length || undefined },
      ]} />

      {tab === 'activity' && (
        <section className="card" style={{ marginTop: 0 }}>
          <DataTable rows={feed} columns={feedCols} rowKey={(r) => r.key} onRowClick={setSelected} loading={loading} empty={emptyFeed}
            exportName="events" searchable={false} initialSort={{ key: 'ts', order: 'desc' }} pageSize={50} />
        </section>
      )}
      {tab === 'annotations' && (
        <section className="card" style={{ marginTop: 0 }}>
          <DataTable rows={annFeed} columns={annCols} rowKey={(r) => r.key} onRowClick={setSelected} loading={annQ.isLoading} exportName="annotations" searchable={false}
            initialSort={{ key: 'ts', order: 'desc' }}
            empty={<EmptyState icon={<StickyNote size={22} />} title={q ? 'No annotations match your search' : 'No annotations yet'}
              action={canAnnotate && <button className="btn btn-primary btn-sm" onClick={() => setAnnForm({ open: true })}><Plus size={13} />Add annotation</button>}>
              Annotations mark moments that explain the numbers — “Deployed v2.3 to perf env”, “DB index rebuilt”, “Cache warmed”. They appear on this timeline and can be linked to a run.
            </EmptyState>} />
        </section>
      )}

      <DetailDrawer row={selected} onClose={() => setSelected(null)}
        onEdit={canAnnotate ? (a) => { setSelected(null); setAnnForm({ open: true, initial: a }); } : undefined}
        onDelete={(r) => ((r.kind === 'annotation' ? canAnnotate : canDeleteEvent) ? () => setConfirm(r) : undefined)} />

      <AnnotationForm open={annForm.open} initial={annForm.initial} onClose={() => setAnnForm({ open: false })} defaults={{ projectId: f.projectId }} />
      <EventForm open={eventForm} onClose={() => setEventForm(false)} />
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)}
        title={confirm?.kind === 'annotation' ? 'Delete annotation' : 'Delete event'}
        message={<>Delete <b>{confirm?.title}</b>? This cannot be undone.</>}
        onConfirm={() => confirm && del.mutate(confirm)} />
    </div>
  );
}

function DetailDrawer({ row, onClose, onEdit, onDelete }: {
  row: FeedRow | null; onClose: () => void; onEdit?: (a: AnnotationRow) => void; onDelete: (r: FeedRow) => (() => void) | undefined;
}) {
  if (!row) return null;
  const del = onDelete(row);
  const e = row.kind === 'event' ? row.event : null;
  const a = row.kind === 'annotation' ? row.annotation : null;
  const hasData = e && Object.keys(e.data ?? {}).length > 0;
  const items: [ReactNode, ReactNode][] = [[a?.tsEnd ? 'Start' : 'Time', fmtDate(row.ts)]];
  if (a?.tsEnd) items.push(['End', fmtDate(a.tsEnd)], ['Window', fmtSpan(new Date(a.tsEnd).getTime() - row.ts)]);
  if (e) items.push(['Severity', <SeverityChip value={e.severity} />], ['Source', e.source ?? '—'], ['Environment', e.environmentName ?? '—']);
  items.push(['Run', row.runKey ? <Link className="mono" to={`/runs/${row.runKey}`}>{row.runKey}</Link> : '—']);
  if (a) items.push(['Author', a.createdByName ?? '—'], ['Created', fmtDate(a.createdAt)]);
  return (
    <Drawer open onClose={onClose} title={row.title} subtitle={<TypeTag type={row.type} />} width={520}
      footer={<>
        {row.runKey && <Link className="btn" to={`/runs/${row.runKey}`}><ExternalLink size={13} />Open run</Link>}
        <div className="spacer" />
        {a && onEdit && <button className="btn" onClick={() => onEdit(a)}><Pencil size={13} />Edit</button>}
        {del && <button className="btn btn-danger" onClick={del}><Trash2 size={13} />Delete</button>}
      </>}>
      <div className="stack">
        {row.text && <p className="ev-drawer-text">{row.text}</p>}
        <KeyValueGrid items={items} />
        {a && a.tags.length > 0 && <div className="ev-tags">{a.tags.map((t) => <Chip key={t} tone="neutral" icon={false}>#{t}</Chip>)}</div>}
        {hasData && <div><div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Event data</div><JsonBlock value={e!.data} /></div>}
      </div>
    </Drawer>
  );
}
