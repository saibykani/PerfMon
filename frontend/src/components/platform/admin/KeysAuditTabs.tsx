import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, KeyRound, Plus, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { api, download } from '@/services/api';
import { Card, Modal, ConfirmDialog } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtDate } from '@/components/format';
import { Chip, CopyBox, EmptyState, errMsg, FormField, JsonBlock, PillSelect, relTime, toast, Unavailable, useProjectScope } from '@/components/platform/kit';

/* ------------------------------------------------------------------ API keys */

interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; projectId: string | null; projectName?: string | null; rateLimitPerSec: number | null; createdAt: string;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdByName: string | null; status?: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

const keyStatus = (k: ApiKey) => k.status ?? (k.revokedAt ? 'REVOKED' : k.expiresAt && new Date(k.expiresAt) <= new Date() ? 'EXPIRED' : 'ACTIVE');

function ExpiryBadge({ k }: { k: ApiKey }) {
  const st = keyStatus(k);
  if (st === 'REVOKED') return <Chip tone="neutral">Revoked</Chip>;
  if (st === 'EXPIRED') return <Chip tone="fail">Expired</Chip>;
  if (!k.expiresAt) return <Chip tone="pass">No expiry</Chip>;
  const days = (new Date(k.expiresAt).getTime() - Date.now()) / 86400000;
  return <Chip tone={days < 14 ? 'warn' : 'pass'} title={fmtDate(k.expiresAt)}>{days < 14 ? `Expires ${relTime(k.expiresAt)}` : `Until ${new Date(k.expiresAt).toLocaleDateString()}`}</Chip>;
}

export function ApiKeysTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<ApiKey[]>('/api-keys', { includeRevoked: true }) });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ key: ApiKey & { secret: string }; rotated: boolean } | null>(null);
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const rotate = useMutation({
    mutationFn: (k: ApiKey) => api.post<ApiKey & { secret: string }>(`/api-keys/${k.id}/rotate`, {}),
    onSuccess: (key) => { setSecret({ key, rotated: true }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api.del(`/api-keys/${k.id}`),
    onSuccess: (_d, k) => { toast.success(`Key ${k.prefix}… revoked.`); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const all = q.data ?? [];
  const rows = showRevoked ? all : all.filter((k) => keyStatus(k) !== 'REVOKED');
  const cols: Column<ApiKey>[] = [
    { key: 'name', header: 'Name', render: (k) => <div><b>{k.name}</b><div className="pf-mono-sm muted">{k.prefix}…</div></div> },
    { key: 'scopes', header: 'Scopes', render: (k) => <div className="row" style={{ gap: 4 }}>{k.scopes.map((s) => <span key={s} className="pf-tag">{s}</span>)}</div>, value: (k) => k.scopes.join(',') },
    { key: 'projectName', header: 'Project', render: (k) => k.projectName ?? <span className="muted">All projects</span> },
    { key: 'rateLimitPerSec', header: 'Rate limit', align: 'right', render: (k) => (k.rateLimitPerSec ? `${k.rateLimitPerSec.toLocaleString()}/s` : <span className="muted">default</span>) },
    { key: 'lastUsedAt', header: 'Last used', render: (k) => <span title={fmtDate(k.lastUsedAt)}>{k.lastUsedAt ? relTime(k.lastUsedAt) : <span className="muted">never</span>}</span>, value: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt).getTime() : 0) },
    { key: 'expiresAt', header: 'Expiry', render: (k) => <ExpiryBadge k={k} />, value: (k) => (k.expiresAt ? new Date(k.expiresAt).getTime() : Infinity) },
    { key: 'createdAt', header: 'Created', render: (k) => <span title={fmtDate(k.createdAt)}>{relTime(k.createdAt)}{k.createdByName && <span className="muted"> · {k.createdByName}</span>}</span>, value: (k) => new Date(k.createdAt).getTime() },
    {
      key: 'actions', header: '', sortable: false, render: (k) => keyStatus(k) === 'REVOKED' ? null : (
        <div className="pf-actions">
          <button className="btn btn-sm" onClick={() => setRotating(k)}><RefreshCw size={12} />Rotate</button>
          <button className="btn btn-sm btn-danger" onClick={() => setRevoking(k)}><Trash2 size={12} />Revoke</button>
        </div>
      ),
    },
  ];
  return (
    <div className="stack">
      <Card noPad title="API keys" actions={<button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><Plus size={13} />Create key</button>}>
        {q.error ? <div className="card-body"><Unavailable what="API keys" error={q.error} /></div> : (
          <DataTable rows={rows} columns={cols} rowKey={(k) => k.id} loading={q.isLoading} exportName="api-keys"
            toolbar={<label className="row" style={{ gap: 6 }}><input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />Show revoked ({all.filter((k) => keyStatus(k) === 'REVOKED').length})</label>}
            empty={<EmptyState icon={<KeyRound size={20} />} title="No API keys" action={<button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><Plus size={13} />Create key</button>}>
              API keys authenticate JMeter, CI pipelines and agents. Use the <b>ingest</b> scope for pushing metrics and artifacts, <b>read</b> for reporting.</EmptyState>} />
        )}
      </Card>
      {creating && <CreateKey onClose={() => setCreating(false)} onCreated={(key) => { setCreating(false); setSecret({ key, rotated: false }); }} />}
      <Modal open={!!secret} onClose={() => setSecret(null)} width={600} title={secret?.rotated ? 'Key rotated — new secret' : 'API key created'}
        footer={<button className="btn btn-primary" onClick={() => setSecret(null)}>I’ve stored the secret</button>}>
        {secret && (
          <div className="stack">
            <CopyBox tone="secret" title={<>{secret.key.name} · <span className="mono">{secret.key.prefix}</span></>} value={secret.key.secret}
              warning="Copy it now — this secret is shown only once and cannot be retrieved later." />
            {secret.rotated && <div className="pf-callout warn"><RefreshCw size={14} /><div>The previous key was revoked. Update every pipeline and JMeter config that used it.</div></div>}
            <div className="pf-sub">Use it as <span className="mono">Authorization: Bearer {secret.key.prefix}…</span> or as <span className="mono">influxdbToken</span> in the JMeter Backend Listener.</div>
          </div>
        )}
      </Modal>
      <ConfirmDialog open={!!rotating} onClose={() => setRotating(null)} danger={false} confirmLabel="Rotate key" title="Rotate API key"
        message={<>Issue a new secret for <b>{rotating?.name}</b> with the same scopes and settings? The current key (<span className="mono">{rotating?.prefix}…</span>) is <b>revoked immediately</b>.</>}
        onConfirm={() => rotating && rotate.mutate(rotating)} />
      <ConfirmDialog open={!!revoking} onClose={() => setRevoking(null)} confirmLabel="Revoke" title="Revoke API key"
        message={<>Revoke <b>{revoking?.name}</b> (<span className="mono">{revoking?.prefix}…</span>)? Any client using it is rejected immediately. This cannot be undone.</>}
        onConfirm={() => revoking && revoke.mutate(revoking)} />
    </div>
  );
}

function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (k: ApiKey & { secret: string }) => void }) {
  const qc = useQueryClient();
  const { projects } = useProjectScope();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<('ingest' | 'read')[]>(['ingest']);
  const [projectId, setProjectId] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [customDate, setCustomDate] = useState('');
  const [rate, setRate] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Name is required';
  if (!scopes.length) errors.scopes = 'Choose at least one scope';
  if (expiry === 'custom' && (!customDate || new Date(customDate).getTime() <= Date.now())) errors.expiry = 'Pick a future date';
  if (rate && (!/^\d+$/.test(rate) || Number(rate) < 1 || Number(rate) > 100000)) errors.rate = '1 – 100,000 requests/s';
  const valid = !Object.keys(errors).length;
  const err = (k: string) => (submitted ? errors[k] : undefined);
  const expiresAt = expiry === 'never' ? null : expiry === 'custom' ? (customDate ? new Date(`${customDate}T23:59:59`).toISOString() : null) : new Date(Date.now() + Number(expiry) * 86400000).toISOString();
  const save = useMutation({
    mutationFn: () => api.post<ApiKey & { secret: string }>('/api-keys', { name: name.trim(), scopes, projectId: projectId || null, expiresAt, rateLimitPerSec: rate ? Number(rate) : null }),
    onSuccess: (k) => { qc.invalidateQueries({ queryKey: ['api-keys'] }); onCreated(k); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const submit = () => { setSubmitted(true); if (valid) save.mutate(); };
  return (
    <Modal open onClose={onClose} width={560} title="Create API key"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={submit}><KeyRound size={13} />{save.isPending ? 'Creating…' : 'Create key'}</button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormField label="Name" required error={err('name')} hint="Where is it used? e.g. “Jenkins — checkout pipeline”"><input className="input" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></FormField>
        <FormField label="Scopes" required error={err('scopes')} hint="ingest: create/start/complete runs, push metrics, upload artifacts · read: view runs, reports and exports">
          <PillSelect value={scopes} onChange={setScopes} options={[{ value: 'ingest', label: 'ingest' }, { value: 'read', label: 'read' }]} />
        </FormField>
        <div className="pf-form-grid">
          <FormField label="Project" hint="Restrict the key to one project">
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </FormField>
          <FormField label="Rate limit" error={err('rate')} hint="Empty = server default">
            <div className="pf-input-unit"><input className="input num" inputMode="numeric" value={rate} placeholder="default" onChange={(e) => setRate(e.target.value)} /><span className="pf-unit">req/s</span></div>
          </FormField>
          <FormField label="Expiry" error={err('expiry')}>
            <select className="select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option><option value="custom">Custom date…</option><option value="never">Never (not recommended)</option>
            </select>
          </FormField>
          {expiry === 'custom' && <FormField label="Expires on" error={err('expiry')}><input className="input" type="date" value={customDate} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} onChange={(e) => setCustomDate(e.target.value)} /></FormField>}
        </div>
        <div className="pf-sub">The secret is displayed once after creation. Perfmon stores only its SHA-256 hash.</div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ audit log */

interface AuditRow { id: number | string; ts: string; userId: string | null; userEmail: string | null; apiKeyId: string | null; action: string; resourceType: string; resourceId: string | null; ip: string | null; userAgent: string | null; result: string; details: any }

const RESOURCE_TYPES = ['run', 'test', 'project', 'application', 'environment', 'server', 'release', 'artifact', 'report', 'dashboard', 'sla_profile', 'alert', 'alert_rule', 'notification_channel', 'integration', 'user', 'api_key', 'setting', 'retention_purge', 'job', 'audit_log', 'session'];

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function AuditTab() {
  const [f, setF] = useState({ q: '', action: '', resourceType: '', user: '', result: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const df = useDebounced(f);
  const params = {
    q: df.q, action: df.action, resourceType: df.resourceType, user: df.user, result: df.result,
    from: df.from ? new Date(df.from).toISOString() : undefined, to: df.to ? new Date(df.to).toISOString() : undefined,
  };
  useEffect(() => setPage(1), [df]);
  const q = useQuery({ queryKey: ['audit', params, page], queryFn: () => api.get<{ items: AuditRow[]; total: number }>('/admin/audit', { ...params, page, pageSize: 50 }), placeholderData: (p) => p });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const doExport = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
      await download(`/admin/audit/export${qs ? `?${qs}` : ''}`, 'perfmon-audit.csv');
      toast.success('Audit log exported (the export itself is audited).');
    } catch (e) { toast.error(errMsg(e)); } finally { setExporting(false); }
  };
  const anyFilter = Object.values(f).some(Boolean);
  const cols: Column<AuditRow>[] = [
    { key: 'x', header: '', sortable: false, width: 28, render: (a) => (open.has(String(a.id)) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) },
    { key: 'ts', header: 'Time', sortable: false, render: (a) => <span title={new Date(a.ts).toISOString()}>{new Date(a.ts).toLocaleString()}</span> },
    { key: 'userEmail', header: 'Actor', sortable: false, render: (a) => a.userEmail ?? (a.apiKeyId ? <span className="pf-tag"><KeyRound size={10} />API key</span> : <span className="muted">system</span>) },
    { key: 'action', header: 'Action', sortable: false, render: (a) => <span className="mono" style={{ fontWeight: 600 }}>{a.action}</span> },
    { key: 'resource', header: 'Resource', sortable: false, render: (a) => <span><span className="pf-tag">{a.resourceType}</span> {a.resourceId && <span className="pf-mono-sm muted">{String(a.resourceId).slice(0, 36)}</span>}</span> },
    { key: 'result', header: 'Result', sortable: false, render: (a) => <Chip tone={a.result === 'SUCCESS' ? 'pass' : a.result === 'DENIED' ? 'warn' : 'fail'}>{a.result.charAt(0) + a.result.slice(1).toLowerCase()}</Chip> },
    { key: 'ip', header: 'IP', sortable: false, render: (a) => <span className="pf-mono-sm">{a.ip ?? '—'}</span> },
  ];
  const items = q.data?.items ?? [];
  return (
    <Card noPad title="Audit log" actions={<button className="btn btn-sm" disabled={exporting} onClick={doExport}><Download size={13} />{exporting ? 'Exporting…' : 'Export CSV'}</button>}>
      <div className="dt-toolbar pf-toolbar" style={{ borderBottom: '1px solid var(--border)' }}>
        <input className="input" placeholder="Search actions, resources, details…" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search audit log" style={{ maxWidth: 240 }} />
        <input className="input mono" placeholder="Action (e.g. api_key.*)" value={f.action} onChange={(e) => set({ action: e.target.value })} aria-label="Action" />
        <select className="select" value={f.resourceType} onChange={(e) => set({ resourceType: e.target.value })} aria-label="Resource type"><option value="">All resources</option>{RESOURCE_TYPES.map((r) => <option key={r}>{r}</option>)}</select>
        <input className="input" placeholder="User email" value={f.user} onChange={(e) => set({ user: e.target.value })} aria-label="User" />
        <select className="select" value={f.result} onChange={(e) => set({ result: e.target.value })} aria-label="Result"><option value="">All results</option><option value="SUCCESS">Success</option><option value="FAILURE">Failure</option><option value="DENIED">Denied</option></select>
        <input className="input" type="datetime-local" value={f.from} onChange={(e) => set({ from: e.target.value })} aria-label="From" title="From" />
        <input className="input" type="datetime-local" value={f.to} onChange={(e) => set({ to: e.target.value })} aria-label="To" title="To" />
        {anyFilter && <button className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', action: '', resourceType: '', user: '', result: '', from: '', to: '' })}>Clear</button>}
      </div>
      {q.error ? <div className="card-body"><Unavailable what="Audit log" error={q.error} /></div> : (
        <>
          <div className="table-wrap" style={{ maxHeight: 640 }}>
            <table className="table">
              <thead><tr>{cols.map((c) => <th key={c.key} style={{ width: c.width }}>{c.header}</th>)}</tr></thead>
              <tbody>
                {q.isLoading && Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={cols.length}><div className="skeleton" style={{ height: 14 }} /></td></tr>)}
                {!q.isLoading && !items.length && <tr><td colSpan={cols.length}><EmptyState icon={<ScrollText size={20} />} title="No audit entries">{anyFilter ? 'Nothing matches these filters.' : 'Security-relevant actions will be recorded here.'}</EmptyState></td></tr>}
                {items.map((a) => {
                  const id = String(a.id);
                  const isOpen = open.has(id);
                  return (
                    <Fragment key={id}>
                      <tr className="clickable" tabIndex={0} aria-expanded={isOpen} onClick={() => toggle(id)} onKeyDown={(e) => e.key === 'Enter' && toggle(id)}>
                        {cols.map((c) => <td key={c.key}>{c.render!(a)}</td>)}
                      </tr>
                      {isOpen && (
                        <tr><td colSpan={cols.length} style={{ background: 'var(--surface-2)', whiteSpace: 'normal' }}>
                          <div className="pf-grid-2" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
                            <div><div className="pf-section-title">Details</div><JsonBlock value={a.details} /></div>
                            <div className="stack" style={{ gap: 6, fontSize: 12 }}>
                              <div className="pf-section-title">Context</div>
                              <div><span className="muted">Entry #</span> <span className="mono">{id}</span></div>
                              <div><span className="muted">Resource ID</span> <span className="mono" style={{ wordBreak: 'break-all' }}>{a.resourceId ?? '—'}</span></div>
                              <div><span className="muted">User ID</span> <span className="mono">{a.userId ?? '—'}</span></div>
                              {a.apiKeyId && <div><span className="muted">API key</span> <span className="mono">{a.apiKeyId}</span></div>}
                              <div><span className="muted">User agent</span> <span style={{ wordBreak: 'break-word' }}>{a.userAgent ?? '—'}</span></div>
                            </div>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="dt-pager">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted">Page {page} of {Math.max(1, Math.ceil((q.data?.total ?? 0) / 50))} · {(q.data?.total ?? 0).toLocaleString()} entries</span>
            <button className="btn btn-sm" disabled={page >= Math.ceil((q.data?.total ?? 0) / 50)} onClick={() => setPage(page + 1)}>Next</button>
            {q.isFetching && <span className="muted">Updating…</span>}
          </div>
        </>
      )}
    </Card>
  );
}
