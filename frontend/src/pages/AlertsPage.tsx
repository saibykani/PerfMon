import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BellRing, Check, CheckCheck, CheckCircle2, Hash, Mail, MessageSquare, Pencil, Plus, Send, ShieldAlert, Trash2, Webhook, XCircle, Zap,
} from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { PageHeader, Card, Kpi, Tabs, Modal, ConfirmDialog, KeyValue } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/Status';
import { fmtDate, fmtNum } from '@/components/format';
import {
  Chip, CopyButton, Drawer, EmptyState, errMsg, FormField, itemsOf, PermissionNote, PillSelect, ProjectPicker, relTime, SecretInput, Seg,
  SeverityChip, SkeletonRows, toast, ToastHost, Toggle, Unavailable, useProjectScope, plural,
} from '@/components/platform/kit';

/* ------------------------------------------------------------------ types */

interface AlertRow {
  id: string; ruleId: string | null; ruleName: string | null; type: string; severity: string; status: 'FIRING' | 'ACKNOWLEDGED' | 'RESOLVED'; subject: string;
  title: string; message: string | null; value: number | null; threshold: number | null; runId: string | null; runKey: string | null; serverName: string | null;
  firedAt: string; acknowledgedAt: string | null; acknowledgedBy?: string | null; resolvedAt: string | null;
}
interface AlertEvent { id: string; ts: string; kind: string; channelId: string | null; channelName?: string | null; channelType?: string | null; details: any }
interface RuleType { type: string; label: string; defaultOperator: string; unit: string; needsThreshold: boolean; scope?: string }
interface Rule {
  id: string; projectId: string; projectName?: string; name: string; description: string | null; type: string; metric: string | null; operator: string; threshold: number | null;
  severity: string; windowSec: number; filters: { environmentId?: string; testId?: string; transaction?: string; serverId?: string }; channelIds: string[]; cooldownSec: number;
  enabled: boolean; openAlerts?: number; lastFiredAt?: string | null;
}
interface Channel { id: string; name: string; type: ChannelType; config: { recipients?: string[]; url?: string }; enabled: boolean; hasSecret: boolean; createdAt: string; updatedAt?: string }
type ChannelType = 'IN_APP' | 'EMAIL' | 'SLACK' | 'TEAMS' | 'WEBHOOK';
interface TestResult { ok: boolean; latencyMs: number; message: string; at: number }

type TabKey = 'alerts' | 'rules' | 'channels';
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

const CHANNEL_META: Record<ChannelType, { label: string; icon: JSX.Element; desc: string }> = {
  IN_APP: { label: 'In-app', icon: <Bell size={15} />, desc: 'Bell notifications inside Perfmon for everyone in the organization.' },
  EMAIL: { label: 'Email', icon: <Mail size={15} />, desc: 'Email via the server SMTP relay.' },
  SLACK: { label: 'Slack', icon: <Hash size={15} />, desc: 'Slack incoming webhook.' },
  TEAMS: { label: 'Microsoft Teams', icon: <MessageSquare size={15} />, desc: 'Teams incoming webhook (MessageCard).' },
  WEBHOOK: { label: 'Webhook', icon: <Webhook size={15} />, desc: 'JSON POST to your endpoint, optionally HMAC-SHA256 signed.' },
};

const fmtVal = (v: number | null | undefined, unit?: string) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const n = +v.toFixed(2);
  if (!unit) return String(n);
  if (unit === 'ms') return `${n} ms`;
  if (unit === '%') return `${n}%`;
  if (unit === 'tps') return `${n}/s`;
  return `${n} ${unit}`;
};
const fmtSec = (s: number) => (s % 3600 === 0 && s >= 3600 ? `${s / 3600} h` : s % 60 === 0 && s >= 60 ? `${s / 60} min` : `${s} s`);

/* ------------------------------------------------------------------ page */

export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (['alerts', 'rules', 'channels'].includes(params.get('tab') ?? '') ? params.get('tab') : 'alerts') as TabKey;
  const setTab = (t: TabKey) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'alerts') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  const { projectId } = useProjectScope();
  const counts = useQuery({ queryKey: ['alerts-counts', projectId], queryFn: () => api.get<{ counts: Record<string, number> }>('/alerts', { projectId, pageSize: 1 }), refetchInterval: 30000 });
  const rules = useQuery({ queryKey: ['alert-rules', projectId], queryFn: async () => itemsOf<Rule>(await api.get('/alert-rules', { projectId })) });
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: async () => itemsOf<Channel>(await api.get('/notification-channels')) });

  return (
    <div>
      <ToastHost />
      <PageHeader title="Alerts & notifications" subtitle="Live and completion-time alerting on response time, throughput, errors, infrastructure, SLA and regressions."
        actions={<ProjectPicker />} />
      <Tabs<TabKey> value={tab} onChange={setTab} tabs={[
        { key: 'alerts', label: 'Alerts', badge: counts.data?.counts?.FIRING ? counts.data.counts.FIRING : undefined },
        { key: 'rules', label: 'Rules', badge: rules.data?.length ?? undefined },
        { key: 'channels', label: 'Channels', badge: channels.data?.length ?? undefined },
      ]} />
      {tab === 'alerts' && <AlertsTab projectId={projectId} />}
      {tab === 'rules' && <RulesTab rulesQ={rules} channels={channels.data ?? []} />}
      {tab === 'channels' && <ChannelsTab q={channels} rules={rules.data ?? []} />}
    </div>
  );
}

/* ------------------------------------------------------------------ alerts tab */

function AlertsTab({ projectId }: { projectId: string | null }) {
  const can = useAuth((s) => s.can);
  const canAct = can('CONFIGURE_ALERT');
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('ACTIVE');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const statusParam = status === 'ACTIVE' ? 'FIRING,ACKNOWLEDGED' : status;
  const q = useQuery({
    queryKey: ['alerts', projectId, statusParam, severity, search, page],
    queryFn: () => api.get<{ items: AlertRow[]; total: number; counts: Record<string, number> }>('/alerts', { projectId, status: statusParam, severity, q: search, page, pageSize: 25 }),
    refetchInterval: 15000,
    placeholderData: (p) => p,
  });
  useEffect(() => setPage(1), [statusParam, severity, search, projectId]);
  const counts = q.data?.counts ?? { FIRING: 0, ACKNOWLEDGED: 0, RESOLVED: 0 };

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'acknowledge' | 'resolve' }) => api.post(`/alerts/${id}/${action}`, {}),
    onSuccess: (_d, v) => { toast.success(v.action === 'acknowledge' ? 'Alert acknowledged.' : 'Alert resolved.'); qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['alerts-counts'] }); qc.invalidateQueries({ queryKey: ['alert', v.id] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const cols: Column<AlertRow>[] = [
    { key: 'severity', header: 'Severity', render: (a) => <SeverityChip value={a.severity} />, sortable: false },
    { key: 'title', header: 'Alert', sortable: false, render: (a) => <div style={{ minWidth: 220, maxWidth: 420, whiteSpace: 'normal' }}><b>{a.title}</b>{a.subject && <div className="muted" style={{ fontSize: 12 }}>{a.subject}</div>}</div> },
    { key: 'value', header: 'Value / threshold', align: 'right', sortable: false, render: (a) => <span className="num">{a.value != null ? +a.value.toFixed(2) : '—'}<span className="muted"> / {a.threshold != null ? +a.threshold.toFixed(2) : '—'}</span></span> },
    { key: 'runKey', header: 'Run', sortable: false, render: (a) => (a.runKey ? <Link className="mono" to={`/runs/${a.runKey}`} onClick={(e) => e.stopPropagation()}>{a.runKey}</Link> : <span className="muted">—</span>) },
    { key: 'serverName', header: 'Server', sortable: false, render: (a) => a.serverName ?? <span className="muted">—</span> },
    { key: 'ruleName', header: 'Rule', sortable: false, hidden: true },
    { key: 'firedAt', header: 'Fired', sortable: false, render: (a) => <span title={fmtDate(a.firedAt)}>{relTime(a.firedAt)}</span> },
    { key: 'status', header: 'Status', sortable: false, render: (a) => <StatusBadge value={a.status} /> },
    {
      key: 'actions', header: '', sortable: false, render: (a) => canAct && a.status !== 'RESOLVED' ? (
        <div className="pf-actions" onClick={(e) => e.stopPropagation()}>
          {a.status === 'FIRING' && <button className="btn btn-sm" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: 'acknowledge' })}><Check size={12} />Ack</button>}
          <button className="btn btn-sm" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: 'resolve' })}><CheckCheck size={12} />Resolve</button>
        </div>
      ) : null,
    },
  ];

  return (
    <div className="stack">
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
        <Kpi label="Firing" value={fmtNum(counts.FIRING)} status={counts.FIRING ? 'fail' : 'pass'} sub="needs attention" onClick={() => setStatus('FIRING')} />
        <Kpi label="Acknowledged" value={fmtNum(counts.ACKNOWLEDGED)} status={counts.ACKNOWLEDGED ? 'warn' : null} sub="being worked on" onClick={() => setStatus('ACKNOWLEDGED')} />
        <Kpi label="Resolved" value={fmtNum(counts.RESOLVED)} sub="history" onClick={() => setStatus('RESOLVED')} />
      </div>
      <Card noPad>
        {q.error ? <div className="card-body"><Unavailable what="Alerts" error={q.error} /></div> : (
          <DataTable rows={q.data?.items ?? []} columns={cols} rowKey={(a) => a.id} loading={q.isLoading} onRowClick={(a) => setOpenId(a.id)} exportName="alerts"
            server={{ page, pageSize: 25, total: q.data?.total ?? 0, onPage: setPage, onSort: () => undefined, search, onSearch: setSearch }}
            toolbar={<>
              <Seg ariaLabel="Status filter" value={status} onChange={setStatus} options={[
                { value: 'ACTIVE', label: 'Active' }, { value: 'FIRING', label: 'Firing' }, { value: 'ACKNOWLEDGED', label: 'Acknowledged' }, { value: 'RESOLVED', label: 'Resolved' }, { value: '', label: 'All' },
              ]} />
              <select className="select" aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="">All severities</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
              </select>
            </>}
            empty={<EmptyState icon={<CheckCircle2 size={20} />} title={status === 'RESOLVED' ? 'No resolved alerts' : 'All quiet'}>
              {status === 'RESOLVED' ? 'Resolved alerts will appear here.' : 'No alerts match these filters. Alerts fire from the rules on the Rules tab.'}</EmptyState>} />
        )}
      </Card>
      <AlertDrawer id={openId} onClose={() => setOpenId(null)} canAct={canAct} onAct={(action) => openId && act.mutate({ id: openId, action })} busy={act.isPending} />
    </div>
  );
}

const EVENT_META: Record<string, { tone: string; label: string; icon: JSX.Element }> = {
  FIRED: { tone: 'fail', label: 'Fired', icon: <BellRing size={8} /> },
  REFIRED: { tone: 'fail', label: 'Re-fired', icon: <BellRing size={8} /> },
  ACKNOWLEDGED: { tone: 'warn', label: 'Acknowledged', icon: <Check size={8} /> },
  RESOLVED: { tone: 'pass', label: 'Resolved', icon: <CheckCheck size={8} /> },
  NOTIFIED: { tone: 'info', label: 'Notification delivered', icon: <Send size={8} /> },
  NOTIFY_FAILED: { tone: 'fail', label: 'Notification failed', icon: <XCircle size={8} /> },
};

function AlertDrawer({ id, onClose, canAct, onAct, busy }: { id: string | null; onClose: () => void; canAct: boolean; onAct: (a: 'acknowledge' | 'resolve') => void; busy: boolean }) {
  const q = useQuery({ queryKey: ['alert', id], queryFn: () => api.get<AlertRow & { events: AlertEvent[]; rule?: Rule | null }>(`/alerts/${id}`), enabled: !!id });
  const a = q.data;
  const events = a?.events ?? [];
  const delivered = events.filter((e) => e.kind === 'NOTIFIED');
  const failed = events.filter((e) => e.kind === 'NOTIFY_FAILED');
  return (
    <Drawer open={!!id} onClose={onClose} width={560} title={a ? a.title : 'Alert'} subtitle={a && <span className="row wrap" style={{ gap: 6 }}><SeverityChip value={a.severity} /><StatusBadge value={a.status} /><span>{a.type.replace(/_/g, ' ').toLowerCase()}</span></span>}
      footer={a && canAct && a.status !== 'RESOLVED' ? <>
        {a.status === 'FIRING' && <button className="btn" disabled={busy} onClick={() => onAct('acknowledge')}><Check size={13} />Acknowledge</button>}
        <button className="btn btn-primary" disabled={busy} onClick={() => onAct('resolve')}><CheckCheck size={13} />Resolve</button>
      </> : undefined}>
      {q.isLoading && <SkeletonRows rows={5} />}
      {q.error && <Unavailable what="Alert detail" error={q.error} />}
      {a && <>
        {a.message && <div className="notice" style={{ whiteSpace: 'pre-wrap' }}>{a.message}</div>}
        <KeyValue items={[
          ['Value', <span className="num">{fmtVal(a.value, a.rule ? undefined : undefined)}</span>],
          ['Threshold', <span className="num">{a.rule ? `${a.rule.operator} ` : ''}{fmtVal(a.threshold)}</span>],
          ['Subject', a.subject || '—'],
          ['Rule', a.ruleName ?? '—'],
          ['Run', a.runKey ? <Link className="mono" to={`/runs/${a.runKey}`}>{a.runKey}</Link> : '—'],
          ['Server', a.serverName ?? '—'],
          ['Fired', fmtDate(a.firedAt)],
          ['Acknowledged', a.acknowledgedAt ? `${fmtDate(a.acknowledgedAt)}${a.acknowledgedBy ? ` · ${a.acknowledgedBy}` : ''}` : '—'],
          ['Resolved', a.resolvedAt ? fmtDate(a.resolvedAt) : '—'],
        ]} />
        <div>
          <div className="pf-section-title">Notifications</div>
          <div className="row wrap">
            <Chip tone={delivered.length ? 'pass' : 'neutral'}>{plural(delivered.length, 'delivered', 'delivered')}</Chip>
            <Chip tone={failed.length ? 'fail' : 'neutral'}>{plural(failed.length, 'failed', 'failed')}</Chip>
          </div>
        </div>
        <div>
          <div className="pf-section-title">Event history</div>
          {!events.length ? <div className="muted">No events recorded.</div> : (
            <ul className="pf-timeline">
              {events.map((e) => {
                const m = EVENT_META[e.kind] ?? { tone: '', label: e.kind, icon: <Zap size={8} /> };
                const d = e.details ?? {};
                return (
                  <li key={e.id}>
                    <span className={`pf-tl-dot ${m.tone}`}>{m.icon}</span>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <b>{m.label}</b>
                      {(e.channelName || d.type) && <span className="pf-tag">{e.channelName ?? CHANNEL_META[(e.channelType ?? d.type) as ChannelType]?.label ?? d.type}</span>}
                      <span className="spacer" />
                      <span className="muted" style={{ fontSize: 12 }} title={fmtDate(e.ts)}>{new Date(e.ts).toLocaleString()}</span>
                    </div>
                    {d.error && <div className="pf-row-error">{d.error}</div>}
                    {d.by && <div className="muted" style={{ fontSize: 12 }}>by {d.by}{d.comment ? ` — “${d.comment}”` : ''}</div>}
                    {d.reason && <div className="muted" style={{ fontSize: 12 }}>{d.reason}</div>}
                    {e.kind === 'FIRED' && d.value != null && <div className="muted" style={{ fontSize: 12 }}>value {+Number(d.value).toFixed(2)} vs threshold {d.threshold ?? '—'}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </>}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ rules tab */

function RulesTab({ rulesQ, channels }: { rulesQ: { data?: Rule[]; isLoading: boolean; error: unknown }; channels: Channel[] }) {
  const can = useAuth((s) => s.can);
  const editable = can('CONFIGURE_ALERT');
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['alert-rule-types'], queryFn: () => api.get<RuleType[]>('/alert-rules/types'), staleTime: Infinity });
  const typeMap = useMemo(() => new Map((types.data ?? []).map((t) => [t.type, t])), [types.data]);
  const { projects } = useProjectScope();
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);

  const toggle = useMutation({
    mutationFn: (r: Rule) => api.patch(`/alert-rules/${r.id}`, { enabled: !r.enabled }),
    onSuccess: (_d, r) => { toast.success(`Rule “${r.name}” ${r.enabled ? 'disabled' : 'enabled'}.`); qc.invalidateQueries({ queryKey: ['alert-rules'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (r: Rule) => api.del(`/alert-rules/${r.id}`),
    onSuccess: () => { toast.success('Rule deleted. Its open alerts were resolved; history is kept.'); qc.invalidateQueries({ queryKey: ['alert-rules'] }); qc.invalidateQueries({ queryKey: ['alerts'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const condition = (r: Rule) => {
    const t = typeMap.get(r.type);
    if (t && !t.needsThreshold) return <span className="muted">{t.label}</span>;
    return <span className="mono">{t?.label.split('(')[0].trim() ?? r.type} {r.operator} {fmtVal(r.threshold, t?.unit)}<span className="muted"> for {fmtSec(r.windowSec)}</span></span>;
  };
  const chName = new Map(channels.map((c) => [c.id, c]));
  const cols: Column<Rule>[] = [
    { key: 'enabled', header: 'On', width: 50, render: (r) => <span onClick={(e) => e.stopPropagation()}><Toggle checked={r.enabled} disabled={!editable || toggle.isPending} onChange={() => toggle.mutate(r)} /></span>, value: (r) => (r.enabled ? 1 : 0) },
    { key: 'name', header: 'Name', render: (r) => <div><b>{r.name}</b>{r.description && <div className="muted" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.description}</div>}</div> },
    { key: 'condition', header: 'Condition', render: condition, value: (r) => r.type },
    { key: 'severity', header: 'Severity', render: (r) => <SeverityChip value={r.severity} /> },
    { key: 'channels', header: 'Channels', render: (r) => r.channelIds.length ? <div className="row wrap" style={{ gap: 4 }}>{r.channelIds.map((id) => <span key={id} className="pf-tag">{CHANNEL_META[chName.get(id)?.type as ChannelType]?.icon}{chName.get(id)?.name ?? 'deleted'}</span>)}</div> : <span className="muted">In-app only</span>, value: (r) => r.channelIds.length },
    { key: 'openAlerts', header: 'Open', align: 'right', render: (r) => (r.openAlerts ? <Chip tone="fail">{r.openAlerts}</Chip> : <span className="muted">0</span>) },
    { key: 'lastFiredAt', header: 'Last fired', render: (r) => <span title={fmtDate(r.lastFiredAt)}>{relTime(r.lastFiredAt)}</span> },
    { key: 'projectName', header: 'Project', hidden: true },
    {
      key: 'actions', header: '', sortable: false, render: (r) => editable ? (
        <div className="pf-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${r.name}`} title="Edit" onClick={() => setEditing(r)}><Pencil size={13} /></button>
          <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${r.name}`} title="Delete" onClick={() => setDeleting(r)}><Trash2 size={13} /></button>
        </div>
      ) : null,
    },
  ];

  return (
    <div className="stack">
      {!editable && <PermissionNote perm="CONFIGURE_ALERT" />}
      <Card noPad title="Alert rules" actions={editable && <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')} disabled={!projects.length}><Plus size={13} />New rule</button>}>
        {rulesQ.error ? <div className="card-body"><Unavailable what="Alert rules" error={rulesQ.error} /></div> : (
          <DataTable rows={rulesQ.data ?? []} columns={cols} rowKey={(r) => r.id} loading={rulesQ.isLoading} exportName="alert-rules" onRowClick={editable ? (r) => setEditing(r) : undefined}
            empty={<EmptyState icon={<ShieldAlert size={20} />} title="No alert rules" action={editable && <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}><Plus size={13} />Create rule</button>}>
              Rules watch running tests (P95, TPS, errors), infrastructure (CPU, memory, heap, GC) and completed runs (SLA violations, failures, regressions).</EmptyState>} />
        )}
      </Card>
      {editing && <RuleForm rule={editing === 'new' ? null : editing} types={types.data ?? []} channels={channels} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete alert rule"
        message={<>Delete <b>{deleting?.name}</b>? {deleting?.openAlerts ? <>Its <b>{plural(deleting.openAlerts, 'open alert')}</b> will be resolved. </> : null}Alert history is kept.</>}
        onConfirm={() => deleting && del.mutate(deleting)} />
    </div>
  );
}

interface RuleDraft {
  projectId: string; name: string; description: string; type: string; operator: string; threshold: string; severity: string; windowSec: string; cooldownSec: string;
  environmentId: string; testId: string; transaction: string; serverId: string; channelIds: string[]; enabled: boolean;
}

function RuleForm({ rule, types, channels, onClose }: { rule: Rule | null; types: RuleType[]; channels: Channel[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { projects, writeProjectId } = useProjectScope();
  const [d, setD] = useState<RuleDraft>(() => rule ? {
    projectId: rule.projectId, name: rule.name, description: rule.description ?? '', type: rule.type, operator: rule.operator, threshold: rule.threshold == null ? '' : String(rule.threshold),
    severity: rule.severity, windowSec: String(rule.windowSec), cooldownSec: String(rule.cooldownSec), environmentId: rule.filters?.environmentId ?? '', testId: rule.filters?.testId ?? '',
    transaction: rule.filters?.transaction ?? '', serverId: rule.filters?.serverId ?? '', channelIds: rule.channelIds ?? [], enabled: rule.enabled,
  } : {
    projectId: writeProjectId ?? '', name: '', description: '', type: 'HIGH_P95', operator: '>', threshold: '2000', severity: 'WARNING', windowSec: '60', cooldownSec: '300',
    environmentId: '', testId: '', transaction: '', serverId: '', channelIds: [], enabled: true,
  });
  const [submitted, setSubmitted] = useState(false);
  const t = types.find((x) => x.type === d.type);
  const set = (p: Partial<RuleDraft>) => setD((x) => ({ ...x, ...p }));
  const envs = useQuery({ queryKey: ['environments', { projectId: d.projectId }], queryFn: () => api.get<any[]>('/environments', { projectId: d.projectId }), enabled: !!d.projectId });
  const tests = useQuery({ queryKey: ['tests', { projectId: d.projectId }], queryFn: () => api.get<any[]>('/tests', { projectId: d.projectId }), enabled: !!d.projectId });
  const servers = useQuery({ queryKey: ['servers', { projectId: d.projectId }], queryFn: () => api.get<any[]>('/servers', { projectId: d.projectId }), enabled: !!d.projectId });

  const errors: Record<string, string> = {};
  if (!d.projectId) errors.projectId = 'Choose a project';
  if (!d.name.trim()) errors.name = 'Name is required';
  if (!d.type) errors.type = 'Choose a rule type';
  if (t?.needsThreshold && (d.threshold.trim() === '' || !Number.isFinite(Number(d.threshold)))) errors.threshold = 'A numeric threshold is required for this rule type';
  if (d.threshold.trim() !== '' && !Number.isFinite(Number(d.threshold))) errors.threshold = 'Must be a number';
  const w = Number(d.windowSec);
  if (!Number.isInteger(w) || w < 10 || w > 86400) errors.windowSec = '10 s – 24 h';
  const c = Number(d.cooldownSec);
  if (!Number.isInteger(c) || c < 0 || c > 604800) errors.cooldownSec = '0 s – 7 days';
  const valid = !Object.keys(errors).length;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: d.name.trim(), description: d.description.trim() || null, type: d.type, operator: d.operator, threshold: d.threshold.trim() === '' ? null : Number(d.threshold),
        severity: d.severity, windowSec: w, cooldownSec: c, enabled: d.enabled, channelIds: d.channelIds,
        filters: { environmentId: d.environmentId || null, testId: d.testId || null, transaction: d.transaction.trim() || null, serverId: d.serverId || null },
      };
      return rule ? api.patch(`/alert-rules/${rule.id}`, body) : api.post('/alert-rules', { ...body, projectId: d.projectId });
    },
    onSuccess: () => { toast.success(`Alert rule “${d.name.trim()}” ${rule ? 'updated' : 'created'}.`); qc.invalidateQueries({ queryKey: ['alert-rules'] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const err = (k: string) => (submitted ? errors[k] : undefined);
  const unit = t?.unit === 'tps' ? '/s' : t?.unit ?? '';
  const scopeHint = t?.scope === 'LIVE' ? 'Evaluated continuously while a test is running.' : t?.scope === 'INFRA' ? 'Evaluated on incoming server / JVM metrics.' : t?.scope === 'COMPLETION' ? 'Evaluated once when a run completes.' : undefined;

  return (
    <Modal open onClose={onClose} width={720} title={rule ? `Edit rule · ${rule.name}` : 'New alert rule'}
      footer={<>
        <Toggle checked={d.enabled} onChange={(v) => set({ enabled: v })} label="Enabled" />
        <div className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => { setSubmitted(true); if (valid) save.mutate(); }}>{save.isPending ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}</button>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setSubmitted(true); if (valid) save.mutate(); }}>
        <div className="pf-form-grid">
          <FormField label="Name" required error={err('name')}><input className="input" autoFocus value={d.name} maxLength={200} placeholder="e.g. Checkout P95 above 2 s" onChange={(e) => set({ name: e.target.value })} /></FormField>
          <FormField label="Project" required error={err('projectId')}>
            <select className="select" value={d.projectId} disabled={!!rule} onChange={(e) => set({ projectId: e.target.value, environmentId: '', testId: '', serverId: '' })}>
              <option value="">Select project…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FormField>
          <FormField label="Rule type" required error={err('type')} hint={scopeHint} className="span-2">
            <select className="select" value={d.type} onChange={(e) => { const nt = types.find((x) => x.type === e.target.value); set({ type: e.target.value, operator: nt?.defaultOperator ?? d.operator, threshold: nt?.needsThreshold ? d.threshold : '' }); }}>
              {['LIVE', 'INFRA', 'COMPLETION', undefined].map((sc) => {
                const list = types.filter((x) => x.scope === sc || (sc === undefined && !x.scope));
                if (!list.length) return null;
                return <optgroup key={sc ?? 'other'} label={sc === 'LIVE' ? 'Running test' : sc === 'INFRA' ? 'Infrastructure & JVM' : sc === 'COMPLETION' ? 'Run completion' : 'Other'}>{list.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}</optgroup>;
              })}
            </select>
          </FormField>
          {t?.needsThreshold !== false && (
            <FormField label="Condition" required error={err('threshold')} className="span-2">
              <div className="row">
                <span className="pf-tag" style={{ height: 30, padding: '0 10px' }}>{t?.label.split('(')[0].trim() ?? 'Value'}</span>
                <select className="select" aria-label="Operator" style={{ width: 70 }} value={d.operator} onChange={(e) => set({ operator: e.target.value })}>{['>', '>=', '<', '<='].map((o) => <option key={o}>{o}</option>)}</select>
                <div className="pf-input-unit" style={{ flex: 1, maxWidth: 220 }}><input className="input num" inputMode="decimal" aria-label="Threshold" value={d.threshold} onChange={(e) => set({ threshold: e.target.value })} />{unit && <span className="pf-unit">{unit}</span>}</div>
              </div>
            </FormField>
          )}
          <FormField label="Severity">
            <Seg ariaLabel="Severity" value={d.severity} onChange={(v) => set({ severity: v })} options={SEVERITIES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
          </FormField>
          <div className="pf-form-grid" style={{ gap: 10 }}>
            <FormField label="Window" error={err('windowSec')} hint="Evaluation window">
              <div className="pf-input-unit"><input className="input num" inputMode="numeric" value={d.windowSec} onChange={(e) => set({ windowSec: e.target.value })} /><span className="pf-unit">s</span></div>
            </FormField>
            <FormField label="Cooldown" error={err('cooldownSec')} hint="Quiet period after resolve">
              <div className="pf-input-unit"><input className="input num" inputMode="numeric" value={d.cooldownSec} onChange={(e) => set({ cooldownSec: e.target.value })} /><span className="pf-unit">s</span></div>
            </FormField>
          </div>
        </div>
        <div>
          <div className="pf-section-title">Filters <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>— leave empty to match everything in the project</span></div>
          <div className="pf-form-grid">
            <FormField label="Environment"><select className="select" value={d.environmentId} onChange={(e) => set({ environmentId: e.target.value })}><option value="">Any environment</option>{itemsOf(envs.data).map((x: any) => <option key={x.id} value={x.id}>{x.name}{x.application_name ? ` · ${x.application_name}` : ''}</option>)}</select></FormField>
            <FormField label="Test"><select className="select" value={d.testId} onChange={(e) => set({ testId: e.target.value })}><option value="">Any test</option>{itemsOf(tests.data).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></FormField>
            <FormField label="Transaction" hint="Exact transaction name"><input className="input mono" value={d.transaction} maxLength={300} placeholder="Any transaction" onChange={(e) => set({ transaction: e.target.value })} /></FormField>
            <FormField label="Server"><select className="select" value={d.serverId} onChange={(e) => set({ serverId: e.target.value })}><option value="">Any server</option>{itemsOf(servers.data).map((x: any) => <option key={x.id} value={x.id}>{x.name}{x.hostname ? ` (${x.hostname})` : ''}</option>)}</select></FormField>
          </div>
        </div>
        <FormField label="Notification channels" hint="In-app notifications are always delivered. Manage channels on the Channels tab.">
          {channels.length ? <PillSelect value={d.channelIds} onChange={(v) => set({ channelIds: v })} options={channels.map((c) => ({ value: c.id, label: <>{CHANNEL_META[c.type]?.icon}{c.name}</>, hint: CHANNEL_META[c.type]?.label }))} />
            : <span className="muted">No channels configured yet.</span>}
        </FormField>
        <FormField label="Description"><textarea className="textarea" rows={2} maxLength={2000} value={d.description} placeholder="Runbook link, owner, context…" onChange={(e) => set({ description: e.target.value })} /></FormField>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ channels tab */

function ChannelsTab({ q, rules }: { q: { data?: Channel[]; isLoading: boolean; error: unknown }; rules: Rule[] }) {
  const can = useAuth((s) => s.can);
  const editable = can('CONFIGURE_ALERT');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const test = useMutation({
    mutationFn: (c: Channel) => api.post<Omit<TestResult, 'at'>>(`/notification-channels/${c.id}/test`, {}),
    onSuccess: (r, c) => { setResults((x) => ({ ...x, [c.id]: { ...r, at: Date.now() } })); (r.ok ? toast.success : toast.error)(r.ok ? `Test sent via ${c.name}.` : `Test via ${c.name} failed: ${r.message}`); },
    onError: (e, c) => setResults((x) => ({ ...x, [c.id]: { ok: false, latencyMs: 0, message: errMsg(e), at: Date.now() } })),
  });
  const toggle = useMutation({
    mutationFn: (c: Channel) => api.patch(`/notification-channels/${c.id}`, { enabled: !c.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-channels'] }),
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (c: Channel) => api.del(`/notification-channels/${c.id}`),
    onSuccess: () => { toast.success('Channel deleted and removed from alert rules.'); qc.invalidateQueries({ queryKey: ['notification-channels'] }); qc.invalidateQueries({ queryKey: ['alert-rules'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const usage = (id: string) => rules.filter((r) => r.channelIds.includes(id)).length;
  const channels = q.data ?? [];

  return (
    <div className="stack">
      {!editable && <PermissionNote perm="CONFIGURE_ALERT" />}
      <div className="row">
        <div className="pf-sub">Secrets (Slack/Teams webhook URLs, webhook signing keys) are encrypted at rest and never shown again after saving.</div>
        <div className="spacer" />
        {editable && <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={13} />New channel</button>}
      </div>
      {q.isLoading ? <SkeletonRows rows={3} height={86} /> : q.error ? <Unavailable what="Notification channels" error={q.error} /> : !channels.length ? (
        <Card><EmptyState icon={<Send size={20} />} title="No notification channels" action={editable && <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus size={13} />Add channel</button>}>
          Route alerts to email, Slack, Microsoft Teams or any webhook. In-app notifications are always on.</EmptyState></Card>
      ) : (
        <div className="pf-catalog" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {channels.map((c) => {
            const m = CHANNEL_META[c.type];
            const r = results[c.id];
            const n = usage(c.id);
            return (
              <div key={c.id} className={`pf-cat-card ${c.enabled ? '' : 'pf-dim'}`}>
                <div className="row">
                  <div className="pf-cat-icon" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{m?.icon}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{m?.label ?? c.type} · {plural(n, 'rule')}</div>
                  </div>
                  <Toggle checked={c.enabled} disabled={!editable} onChange={() => toggle.mutate(c)} label={<span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Enabled</span>} />
                </div>
                <div className="pf-cat-desc" style={{ WebkitLineClamp: 'unset' as any }}>
                  {c.type === 'EMAIL' && <div className="row wrap" style={{ gap: 4 }}>{(c.config.recipients ?? []).map((x) => <span key={x} className="pf-tag">{x}</span>)}</div>}
                  {c.type === 'WEBHOOK' && <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{c.config.url}</div>}
                  {c.type === 'IN_APP' && <span>{m.desc}</span>}
                  {(c.type === 'SLACK' || c.type === 'TEAMS' || c.type === 'WEBHOOK') && (
                    <div className="row" style={{ marginTop: 4 }}>{c.hasSecret ? <Chip tone="pass">{c.type === 'WEBHOOK' ? 'Signing secret' : 'Webhook URL'} ••• stored</Chip> : <Chip tone={c.type === 'WEBHOOK' ? 'neutral' : 'warn'}>{c.type === 'WEBHOOK' ? 'Unsigned' : 'No webhook URL'}</Chip>}</div>
                  )}
                </div>
                {r && (
                  <div className={`pf-result ${r.ok ? 'ok' : 'bad'}`}>
                    {r.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    <span className="msg">{r.message}</span>
                    <span className="muted num">{r.latencyMs} ms</span>
                  </div>
                )}
                <div className="row">
                  {editable && <button className="btn btn-sm" disabled={test.isPending && test.variables?.id === c.id} onClick={() => test.mutate(c)}><Send size={12} />{test.isPending && test.variables?.id === c.id ? 'Sending…' : 'Send test'}</button>}
                  <div className="spacer" />
                  {editable && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil size={13} /></button>}
                  {editable && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Trash2 size={13} /></button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editing && <ChannelForm channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete notification channel"
        message={<>Delete <b>{deleting?.name}</b>?{deleting && usage(deleting.id) ? <> It is used by <b>{plural(usage(deleting.id), 'alert rule')}</b> and will be removed from them.</> : null}</>}
        onConfirm={() => deleting && del.mutate(deleting)} />
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ChannelForm({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(channel?.name ?? '');
  const [type, setType] = useState<ChannelType>(channel?.type ?? 'SLACK');
  const [recipients, setRecipients] = useState((channel?.config.recipients ?? []).join(', '));
  const [url, setUrl] = useState(channel?.config.url ?? '');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [submitted, setSubmitted] = useState(false);
  const hasSecret = !!channel?.hasSecret;
  const list = recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Name is required';
  if (type === 'EMAIL') {
    if (!list.length) errors.recipients = 'Add at least one recipient';
    else if (list.some((x) => !EMAIL_RE.test(x))) errors.recipients = `Invalid address: ${list.find((x) => !EMAIL_RE.test(x))}`;
  }
  if (type === 'WEBHOOK' && !/^https?:\/\/\S+$/i.test(url.trim())) errors.url = 'Enter an http(s) URL';
  if ((type === 'SLACK' || type === 'TEAMS') && !secret && !hasSecret) errors.secret = 'Paste the incoming-webhook URL';
  if ((type === 'SLACK' || type === 'TEAMS') && secret && !/^https:\/\//i.test(secret)) errors.secret = 'Webhook URL must start with https://';
  const valid = !Object.keys(errors).length;
  const err = (k: string) => (submitted ? errors[k] : undefined);

  const save = useMutation({
    mutationFn: () => {
      const config = type === 'EMAIL' ? { recipients: list } : type === 'WEBHOOK' ? { url: url.trim() } : {};
      const body: any = { name: name.trim(), config, enabled };
      if (secret) body.secret = secret; // omitted = keep stored secret
      return channel ? api.patch(`/notification-channels/${channel.id}`, body) : api.post('/notification-channels', { ...body, type });
    },
    onSuccess: () => { toast.success(`Channel “${name.trim()}” ${channel ? 'updated' : 'created'}.`); qc.invalidateQueries({ queryKey: ['notification-channels'] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const submit = () => { setSubmitted(true); if (valid) save.mutate(); };

  return (
    <Modal open onClose={onClose} width={600} title={channel ? `Edit channel · ${channel.name}` : 'New notification channel'}
      footer={<>
        <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
        <div className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : channel ? 'Save channel' : 'Create channel'}</button>
      </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormField label="Type" hint={CHANNEL_META[type].desc}>
          {channel ? <div className="row" style={{ height: 30 }}>{CHANNEL_META[type].icon}<b>{CHANNEL_META[type].label}</b><span className="muted">(type cannot be changed)</span></div> : (
            <div className="pf-pills">{(Object.keys(CHANNEL_META) as ChannelType[]).map((k) => (
              <button type="button" key={k} className={`pf-pill ${type === k ? 'on' : ''}`} aria-pressed={type === k} onClick={() => setType(k)}>{CHANNEL_META[k].icon}{CHANNEL_META[k].label}</button>
            ))}</div>
          )}
        </FormField>
        <FormField label="Name" required error={err('name')}><input className="input" autoFocus value={name} maxLength={120} placeholder="e.g. #perf-alerts" onChange={(e) => setName(e.target.value)} /></FormField>
        {type === 'EMAIL' && (
          <FormField label="Recipients" required error={err('recipients')} hint={`${plural(list.length, 'recipient')} · separate with commas or new lines`}>
            <textarea className="textarea mono" rows={3} value={recipients} placeholder="perf-team@example.com, sre-oncall@example.com" onChange={(e) => setRecipients(e.target.value)} />
          </FormField>
        )}
        {type === 'WEBHOOK' && (
          <FormField label="Endpoint URL" required error={err('url')} hint="Perfmon POSTs a JSON payload (source, severity, title, message, link, status, value, threshold, runKey).">
            <input className="input mono" value={url} placeholder="https://hooks.example.com/perfmon" onChange={(e) => setUrl(e.target.value)} />
          </FormField>
        )}
        {(type === 'SLACK' || type === 'TEAMS') && (
          <FormField label={`${CHANNEL_META[type].label} incoming-webhook URL`} required={!hasSecret} error={err('secret')} hint="Treated as a secret: encrypted at rest and never displayed again.">
            <SecretInput value={secret} onChange={setSecret} hasSecret={hasSecret} placeholder={type === 'SLACK' ? 'https://hooks.slack.com/services/…' : 'https://….webhook.office.com/…'} />
          </FormField>
        )}
        {type === 'WEBHOOK' && (
          <FormField label="Signing secret (optional)" hint={<>When set, requests carry <span className="mono">x-perfmon-signature: sha256=&lt;HMAC of body&gt;</span>.</>}>
            <SecretInput value={secret} onChange={setSecret} hasSecret={hasSecret} placeholder="Shared secret for HMAC-SHA256" />
          </FormField>
        )}
        {type === 'WEBHOOK' && secret && <div className="row"><span className="pf-sub">Copy this secret to your receiver now — it can’t be shown again.</span><CopyButton text={secret} /></div>}
        {type === 'IN_APP' && <div className="notice">In-app notifications appear in the bell menu for everyone in the organization. No configuration needed.</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
