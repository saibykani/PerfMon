import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen, CheckCircle2, Download, Pencil, PlugZap, Plus, Power, ShieldCheck, Trash2, Wifi, XCircle, AlertTriangle, Code2, Minus,
} from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { PageHeader, Card, Modal, ConfirmDialog, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtDate, fmtNum } from '@/components/format';
import {
  Chip, CodeSnippet, EmptyState, errMsg, FormField, HealthChip, itemsOf, PermissionNote, ProjectPicker, relTime, SecretInput, SkeletonRows, toast,
  ToastHost, Toggle, Unavailable, useProjectScope, plural,
} from '@/components/platform/kit';
import * as S from '@/components/platform/snippets';

interface FieldDef { key: string; label: string; required: boolean; secret?: boolean; placeholder?: string; help?: string }
interface ImportQuery { metric: string; query: string; target: 'server' | 'jvm' | 'database' | 'service' | 'custom'; serverName?: string; serviceName?: string; scale?: number; transform?: 'invert_pct'; role?: string }
interface IType { type: string; label: string; category: string; authTypes: string[]; fields: FieldDef[]; supportsImport: boolean; docs: string; defaultMappings?: ImportQuery[] }
interface Integration {
  id: string; name: string; type: string; url: string | null; authType: string; config: Record<string, any>; status: 'ENABLED' | 'DISABLED'; health: string;
  lastConnectedAt: string | null; lastError: string | null; lastImportAt?: string | null; hasCredentials: boolean; credentialKeys?: string[]; projectId?: string | null; projectName?: string | null;
}
interface TestRes { ok: boolean; latencyMs: number; message: string; health?: string; at: number }
interface ImportRes { imported: number; series: number; warnings: string[]; runId?: string; servers?: string[]; services?: string[]; window?: { from: string; to: string; stepSec: number } }

const CATEGORY_LABEL: Record<string, string> = { LOAD_TESTING: 'Load testing', METRICS: 'Metrics', APM: 'APM', OBSERVABILITY: 'Observability', CI_CD: 'CI/CD', DASHBOARDS: 'Dashboards' };
const BRAND: Record<string, [string, string]> = {
  JMETER: ['#d22128', 'JM'], INFLUXDB: ['#9b2aff', 'IX'], PROMETHEUS: ['#e6522c', 'PR'], GRAFANA: ['#f46800', 'GF'], DYNATRACE: ['#1496ff', 'DT'], OPENTELEMETRY: ['#425cc7', 'OT'],
  JENKINS: ['#335061', 'JK'], GITHUB_ACTIONS: ['#24292f', 'GH'], GITLAB: ['#fc6d26', 'GL'], AZURE_DEVOPS: ['#0078d4', 'AZ'],
};
const AUTH_LABEL: Record<string, string> = { NONE: 'None', TOKEN: 'Bearer token', BASIC: 'Basic auth', API_KEY: 'API key' };
const IMPORT_METRICS: Record<string, string[]> = {
  server: ['cpu_pct', 'memory_pct', 'memory_used_mb', 'disk_pct', 'disk_read_bps', 'disk_write_bps', 'net_in_bps', 'net_out_bps', 'load_avg_1m', 'processes', 'tcp_connections', 'file_descriptors'],
  jvm: ['heap_used_mb', 'heap_committed_mb', 'heap_max_mb', 'nonheap_used_mb', 'gc_count', 'gc_time_ms', 'gc_max_pause_ms', 'thread_count', 'peak_threads', 'classes_loaded'],
  database: ['connections', 'active_connections', 'max_connections', 'query_latency_ms', 'slow_queries', 'locks', 'deadlocks', 'cpu_pct', 'memory_pct', 'transactions_per_sec'],
  service: ['request_rate', 'error_rate_pct', 'avg_latency_ms', 'p95_latency_ms', 'exceptions', 'cpu_pct', 'memory_pct'],
  custom: [],
};
const PUSH_ONLY = new Set(['JMETER', 'OPENTELEMETRY']);

export function BrandIcon({ type, size = 34 }: { type: string; size?: number }) {
  const [bg, txt] = BRAND[type] ?? ['var(--text-3)', type.slice(0, 2)];
  return <div className="pf-cat-icon" style={{ background: bg, width: size, height: size, fontSize: size * 0.38 }} aria-hidden>{txt}</div>;
}

type Tab = 'configured' | 'catalog' | 'snippets';

export function IntegrationsPage() {
  const can = useAuth((s) => s.can);
  const manage = can('MANAGE_INTEGRATIONS');
  const { projectId } = useProjectScope();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('configured');
  const types = useQuery({ queryKey: ['integration-types'], queryFn: () => api.get<IType[]>('/integrations/types'), staleTime: Infinity });
  const list = useQuery({ queryKey: ['integrations', projectId], queryFn: async () => itemsOf<Integration>(await api.get('/integrations', { projectId })) });
  const typeMap = useMemo(() => new Map((types.data ?? []).map((t) => [t.type, t])), [types.data]);
  const [editing, setEditing] = useState<{ type: IType; item: Integration | null } | null>(null);
  const [deleting, setDeleting] = useState<Integration | null>(null);
  const [importing, setImporting] = useState<Integration | null>(null);
  const [tests, setTests] = useState<Record<string, TestRes>>({});

  const test = useMutation({
    mutationFn: (i: Integration) => api.post<Omit<TestRes, 'at'>>(`/integrations/${i.id}/test`, {}),
    onSuccess: (r, i) => { setTests((x) => ({ ...x, [i.id]: { ...r, at: Date.now() } })); (r.ok ? toast.success : toast.error)(`${i.name}: ${r.message} (${r.latencyMs} ms)`); qc.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e, i) => setTests((x) => ({ ...x, [i.id]: { ok: false, latencyMs: 0, message: errMsg(e), at: Date.now() } })),
  });
  const toggle = useMutation({
    mutationFn: (i: Integration) => api.patch(`/integrations/${i.id}`, { status: i.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' }),
    onSuccess: (_d, i) => { toast.success(`${i.name} ${i.status === 'ENABLED' ? 'disabled' : 'enabled'}.`); qc.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (i: Integration) => api.del(`/integrations/${i.id}`),
    onSuccess: () => { toast.success('Integration deleted; stored credentials were destroyed. Imported metrics are kept.'); qc.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const rows = list.data ?? [];
  const cols: Column<Integration>[] = [
    { key: 'name', header: 'Name', render: (i) => <div className="row"><BrandIcon type={i.type} size={24} /><div><b>{i.name}</b>{i.projectName && <div className="muted" style={{ fontSize: 11 }}>{i.projectName}</div>}</div></div> },
    { key: 'type', header: 'Type', render: (i) => typeMap.get(i.type)?.label ?? i.type },
    { key: 'url', header: 'URL', render: (i) => (i.url ? <span className="pf-mono-sm" title={i.url} style={{ display: 'inline-block', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}>{i.url}</span> : <span className="muted">—</span>) },
    { key: 'authType', header: 'Authentication', render: (i) => <div className="row" style={{ gap: 4 }}><span>{AUTH_LABEL[i.authType] ?? i.authType}</span>{i.hasCredentials && <Chip tone="pass" icon={<ShieldCheck size={11} />} title={`Stored encrypted: ${(i.credentialKeys ?? []).join(', ')}`}>••• stored</Chip>}</div> },
    { key: 'status', header: 'Status', render: (i) => (i.status === 'ENABLED' ? <Chip tone="accent" icon={<Power size={11} />}>Enabled</Chip> : <Chip tone="neutral" icon={<Minus size={11} />}>Disabled</Chip>) },
    { key: 'lastConnectedAt', header: 'Last connected', render: (i) => <span title={fmtDate(i.lastConnectedAt)}>{relTime(i.lastConnectedAt)}</span>, value: (i) => (i.lastConnectedAt ? new Date(i.lastConnectedAt).getTime() : 0) },
    {
      key: 'health', header: 'Health', render: (i) => {
        const t = tests[i.id];
        return <div className="row" style={{ gap: 6 }}><HealthChip value={i.health} />{t && <span className="muted num" style={{ fontSize: 11 }}>{t.latencyMs} ms</span>}{i.lastError && i.health !== 'HEALTHY' && <span title={i.lastError}><AlertTriangle size={13} style={{ color: 'var(--warn)' }} /></span>}</div>;
      },
    },
    {
      key: 'actions', header: '', sortable: false, render: (i) => {
        const t = typeMap.get(i.type);
        return (
          <div className="pf-actions" onClick={(e) => e.stopPropagation()}>
            {manage && <button className="btn btn-sm" disabled={test.isPending && test.variables?.id === i.id} onClick={() => test.mutate(i)}><Wifi size={12} />{test.isPending && test.variables?.id === i.id ? 'Testing…' : 'Test'}</button>}
            {t?.supportsImport && (can('MANAGE_INTEGRATIONS') || can('INGEST_METRICS')) && <button className="btn btn-sm" disabled={i.status !== 'ENABLED'} title={i.status !== 'ENABLED' ? 'Enable the integration to import' : 'Import metrics for a run'} onClick={() => setImporting(i)}><Download size={12} />Import</button>}
            {manage && <Toggle checked={i.status === 'ENABLED'} onChange={() => toggle.mutate(i)} disabled={toggle.isPending} />}
            {manage && t && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Edit ${i.name}`} onClick={() => setEditing({ type: t, item: i })}><Pencil size={13} /></button>}
            {manage && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Delete ${i.name}`} onClick={() => setDeleting(i)}><Trash2 size={13} /></button>}
          </div>
        );
      },
    },
  ];

  const lastTestEntries = Object.entries(tests).filter(([id]) => rows.some((r) => r.id === id)).sort((a, b) => b[1].at - a[1].at);

  return (
    <div>
      <ToastHost />
      <PageHeader title="Integrations" subtitle="Connect load generators, metric stores, APM and CI/CD pipelines. Credentials are encrypted at rest and never returned by the API."
        actions={<><ProjectPicker />{manage && <button className="btn btn-primary" onClick={() => setTab('catalog')}><Plus size={14} />Add integration</button>}</>} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { key: 'configured', label: 'Configured', badge: rows.length || undefined },
        { key: 'catalog', label: 'Catalog', badge: types.data?.length },
        { key: 'snippets', label: 'Pipelines & snippets' },
      ]} />
      {!manage && tab !== 'snippets' && <PermissionNote perm="MANAGE_INTEGRATIONS" />}

      {tab === 'configured' && (
        <div className="stack">
          <Card noPad>
            {list.error ? <div className="card-body"><Unavailable what="Integrations" error={list.error} /></div> : (
              <DataTable rows={rows} columns={cols} rowKey={(i) => i.id} loading={list.isLoading} exportName="integrations"
                onRowClick={manage ? (i) => { const t = typeMap.get(i.type); if (t) setEditing({ type: t, item: i }); } : undefined}
                empty={<EmptyState icon={<PlugZap size={20} />} title="No integrations configured" action={manage && <button className="btn btn-primary btn-sm" onClick={() => setTab('catalog')}><Plus size={13} />Browse catalog</button>}>
                  Connect InfluxDB, Prometheus or Dynatrace to import server, JVM and database metrics for a run window, or wire up your CI pipeline.</EmptyState>} />
            )}
          </Card>
          {lastTestEntries.length > 0 && (
            <Card title="Connection tests (this session)">
              <div className="stack" style={{ gap: 6 }}>
                {lastTestEntries.map(([id, t]) => (
                  <div key={id} className={`pf-result ${t.ok ? 'ok' : 'bad'}`}>
                    {t.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    <b style={{ color: 'var(--text)' }}>{rows.find((r) => r.id === id)?.name}</b>
                    <span className="msg">{t.message}</span>
                    <span className="num">{t.latencyMs} ms</span>
                    <span className="muted">{relTime(t.at)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'catalog' && (
        types.isLoading ? <SkeletonRows rows={3} height={120} /> : types.error ? <Unavailable what="Integration catalog" error={types.error} /> : (
          <div className="stack">
            {Object.entries(groupBy(types.data ?? [], (t) => t.category)).map(([cat, items]) => (
              <div key={cat}>
                <div className="pf-section-title">{CATEGORY_LABEL[cat] ?? cat}</div>
                <div className="pf-catalog">
                  {items.map((t) => <CatalogCard key={t.type} t={t} count={rows.filter((r) => r.type === t.type).length} canAdd={manage} onAdd={() => setEditing({ type: t, item: null })} />)}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'snippets' && <Snippets />}

      {editing && <IntegrationForm type={editing.type} item={editing.item} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog integration={importing} type={typeMap.get(importing.type)} onClose={() => setImporting(null)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete integration"
        message={<>Delete <b>{deleting?.name}</b>? Its stored credentials are destroyed. Metrics already imported into runs are kept.</>}
        onConfirm={() => deleting && del.mutate(deleting)} />
    </div>
  );
}

function groupBy<T>(arr: T[], f: (x: T) => string) {
  const out: Record<string, T[]> = {};
  for (const x of arr) (out[f(x)] ??= []).push(x);
  return out;
}

function CatalogCard({ t, count, canAdd, onAdd }: { t: IType; count: number; canAdd: boolean; onAdd: () => void }) {
  const [docs, setDocs] = useState(false);
  return (
    <div className="pf-cat-card">
      <div className="row">
        <BrandIcon type={t.type} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{t.label}</div>
          <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
            <span className="pf-tag">{CATEGORY_LABEL[t.category] ?? t.category}</span>
            {t.supportsImport && <span className="pf-tag"><Download size={10} />Import</span>}
            {PUSH_ONLY.has(t.type) && <span className="pf-tag">Push</span>}
          </div>
        </div>
        {count > 0 && <Chip tone="pass">{count} configured</Chip>}
      </div>
      <div className="pf-cat-desc" style={docs ? { WebkitLineClamp: 'unset' as any, display: 'block' } : undefined}>{t.docs}</div>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={() => setDocs((v) => !v)} aria-expanded={docs}><BookOpen size={12} />{docs ? 'Less' : 'Docs'}</button>
        <div className="spacer" />
        {canAdd && <button className="btn btn-sm btn-primary" onClick={onAdd}><Plus size={12} />Add</button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ create / edit form */

function IntegrationForm({ type, item, onClose }: { type: IType; item: Integration | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { projects, projectId } = useProjectScope();
  const [name, setName] = useState(item?.name ?? type.label);
  const [url, setUrl] = useState(item?.url ?? '');
  const [authType, setAuthType] = useState(item?.authType ?? type.authTypes[0] ?? 'NONE');
  const [proj, setProj] = useState<string>(item ? item.projectId ?? '' : projectId ?? '');
  const [enabled, setEnabled] = useState(item ? item.status === 'ENABLED' : true);
  const configFields = type.fields.filter((f) => !f.secret);
  const secretFields = type.fields.filter((f) => f.secret);
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(configFields.map((f) => [f.key, item?.config?.[f.key] != null ? String(item.config[f.key]) : ''])));
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [mappings, setMappings] = useState<string>(() => (item?.config?.mappings ? JSON.stringify(item.config.mappings, null, 2) : ''));
  const [submitted, setSubmitted] = useState(false);
  const stored = new Set(item?.credentialKeys ?? []);
  const needsUrl = !PUSH_ONLY.has(type.type);

  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Name is required';
  if (url.trim() && !/^https?:\/\/\S+$/i.test(url.trim())) errors.url = 'Must start with http:// or https://';
  if (needsUrl && !url.trim() && !['GITHUB_ACTIONS', 'GITLAB'].includes(type.type)) errors.url = 'URL is required';
  for (const f of configFields) if (f.required && !config[f.key]?.trim()) errors[f.key] = `${f.label} is required`;
  for (const f of secretFields) if (f.required && authType !== 'NONE' && !creds[f.key] && !stored.has(f.key)) errors[f.key] = `${f.label} is required`;
  let parsedMappings: unknown = undefined;
  if (mappings.trim()) {
    try { parsedMappings = JSON.parse(mappings); if (!Array.isArray(parsedMappings)) errors.mappings = 'Must be a JSON array'; } catch (e) { errors.mappings = `Invalid JSON: ${(e as Error).message}`; }
  }
  const valid = !Object.keys(errors).length;
  const err = (k: string) => (submitted ? errors[k] : undefined);

  const save = useMutation({
    mutationFn: () => {
      const cfg: Record<string, unknown> = { ...(item?.config ?? {}) };
      for (const f of configFields) { const v = config[f.key]?.trim(); if (v) cfg[f.key] = v; else delete cfg[f.key]; }
      if (type.supportsImport) { if (parsedMappings) cfg.mappings = parsedMappings; else delete cfg.mappings; }
      const credentials = Object.fromEntries(Object.entries(creds).filter(([, v]) => v));
      const body: any = { name: name.trim(), url: url.trim() || null, authType, config: cfg, projectId: proj || null, status: enabled ? 'ENABLED' : 'DISABLED' };
      if (Object.keys(credentials).length) body.credentials = credentials;
      return item ? api.patch(`/integrations/${item.id}`, body) : api.post('/integrations', { ...body, type: type.type });
    },
    onSuccess: () => { toast.success(`${name.trim()} ${item ? 'updated' : 'added'}. Use “Test” to verify the connection.`); qc.invalidateQueries({ queryKey: ['integrations'] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const submit = () => { setSubmitted(true); if (valid) save.mutate(); };

  return (
    <Modal open onClose={onClose} width={680} title={<span className="row"><BrandIcon type={type.type} size={22} />{item ? `Edit ${item.name}` : `Add ${type.label}`}</span>}
      footer={<><Toggle checked={enabled} onChange={setEnabled} label="Enabled" /><div className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : item ? 'Save changes' : 'Add integration'}</button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="pf-callout"><BookOpen size={14} /><div>{type.docs}</div></div>
        <div className="pf-form-grid">
          <FormField label="Name" required error={err('name')}><input className="input" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Project" hint="Empty = available to every project">
            <select className="select" value={proj} onChange={(e) => setProj(e.target.value)}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </FormField>
          {needsUrl && (
            <FormField label="URL" required={!['GITHUB_ACTIONS', 'GITLAB'].includes(type.type)} error={err('url')} className="span-2"
              hint={type.type === 'GITHUB_ACTIONS' ? 'Defaults to https://api.github.com' : type.type === 'GITLAB' ? 'Defaults to https://gitlab.com' : undefined}>
              <input className="input mono" value={url} placeholder={placeholderUrl(type.type)} onChange={(e) => setUrl(e.target.value)} />
            </FormField>
          )}
          {type.authTypes.length > 0 && (
            <FormField label="Authentication">
              <select className="select" value={authType} onChange={(e) => setAuthType(e.target.value)}>{type.authTypes.map((a) => <option key={a} value={a}>{AUTH_LABEL[a] ?? a}</option>)}</select>
            </FormField>
          )}
          {configFields.map((f) => (
            <FormField key={f.key} label={f.label} required={f.required} error={err(f.key)} hint={f.help}>
              <input className="input" value={config[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} />
            </FormField>
          ))}
        </div>
        {secretFields.length > 0 && authType !== 'NONE' && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="pf-secure-note"><ShieldCheck size={14} style={{ flex: 'none', marginTop: 1 }} /><div><b>Credentials are write-only.</b> They are encrypted with AES-256-GCM and never stored in plaintext or returned by the API. Leave a stored value untouched to keep it.</div></div>
            <div className="pf-form-grid">
              {secretFields.map((f) => (
                <FormField key={f.key} label={f.label} required={f.required && !stored.has(f.key)} error={err(f.key)} hint={f.help}>
                  <SecretInput value={creds[f.key] ?? ''} onChange={(v) => setCreds((c) => ({ ...c, [f.key]: v }))} hasSecret={stored.has(f.key)} placeholder={f.placeholder} />
                </FormField>
              ))}
            </div>
          </div>
        )}
        {type.supportsImport && (
          <FormField label="Metric mappings (optional)" error={err('mappings')}
            hint={<>JSON array of {'{ metric, query, target: server|jvm|database|service|custom, serverName?, serviceName?, scale?, transform? }'}. Empty = connector defaults{type.defaultMappings?.length ? ` (${type.defaultMappings.length})` : ''}.</>}>
            <textarea className="textarea mono" rows={6} value={mappings} spellCheck={false} placeholder={type.defaultMappings?.length ? JSON.stringify(type.defaultMappings.slice(0, 2), null, 2) : '[]'} onChange={(e) => setMappings(e.target.value)} />
            {type.defaultMappings?.length ? <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setMappings(JSON.stringify(type.defaultMappings, null, 2))}>Start from defaults</button> : null}
          </FormField>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const placeholderUrl = (t: string) => ({
  INFLUXDB: 'http://influxdb:8086', PROMETHEUS: 'http://prometheus:9090', GRAFANA: 'https://grafana.example.com', DYNATRACE: 'https://abc12345.live.dynatrace.com',
  JENKINS: 'https://jenkins.example.com', GITHUB_ACTIONS: 'https://api.github.com', GITLAB: 'https://gitlab.com', AZURE_DEVOPS: 'https://dev.azure.com/<organization>',
} as Record<string, string>)[t] ?? 'https://';

/* ------------------------------------------------------------------ import dialog */

interface QRow { key: number; metric: string; query: string; target: ImportQuery['target']; serverName: string; serviceName: string; scale: string; invert: boolean }

function ImportDialog({ integration, type, onClose }: { integration: Integration; type?: IType; onClose: () => void }) {
  const runs = useQuery({ queryKey: ['import-runs', integration.projectId], queryFn: () => api.get<{ items: any[] }>('/runs', { projectId: integration.projectId ?? undefined, pageSize: 100, sort: 'start', order: 'desc' }) });
  const [runId, setRunId] = useState('');
  const [mode, setMode] = useState<'default' | 'custom'>('default');
  const defaults: ImportQuery[] = (Array.isArray(integration.config?.mappings) && integration.config.mappings.length ? integration.config.mappings : type?.defaultMappings) ?? [];
  const [rows, setRows] = useState<QRow[]>(() => (defaults.length ? defaults : [{ metric: 'cpu_pct', query: '', target: 'server' } as ImportQuery]).map((q, i) => ({
    key: i, metric: q.metric, query: q.query, target: q.target, serverName: q.serverName ?? '', serviceName: q.serviceName ?? '', scale: q.scale != null ? String(q.scale) : '', invert: q.transform === 'invert_pct',
  })));
  const [result, setResult] = useState<ImportRes | null>(null);
  const qc = useQueryClient();
  const startedRuns = (runs.data?.items ?? []).filter((r) => r.startedAt);

  const rowErr = (r: QRow) => (!r.metric.trim() ? 'metric' : !r.query.trim() ? 'query' : r.scale && !Number.isFinite(Number(r.scale)) ? 'scale' : null);
  const valid = !!runId && (mode === 'default' || (rows.length > 0 && rows.every((r) => !rowErr(r))));
  const run = useMutation({
    mutationFn: () => api.post<ImportRes>(`/integrations/${integration.id}/import`, {
      runId,
      ...(mode === 'custom' ? { queries: rows.map((r) => ({ metric: r.metric.trim(), query: r.query.trim(), target: r.target, ...(r.serverName.trim() ? { serverName: r.serverName.trim() } : {}), ...(r.serviceName.trim() ? { serviceName: r.serviceName.trim() } : {}), ...(r.scale ? { scale: Number(r.scale) } : {}), ...(r.invert ? { transform: 'invert_pct' } : {}) })) } : {}),
    }),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['integrations'] }); (r.imported ? toast.success : toast.info)(`Imported ${fmtNum(r.imported)} points from ${plural(r.series, 'series', 'series')}.`); },
    onError: (e) => toast.error(`Import failed: ${errMsg(e)}`),
  });
  const set = (k: number, p: Partial<QRow>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...p } : r)));
  const queryHint = integration.type === 'PROMETHEUS' ? 'PromQL' : integration.type === 'INFLUXDB' ? 'measurement:field{tag=value} or Flux/InfluxQL' : integration.type === 'DYNATRACE' ? 'Metric selector' : 'Query';

  return (
    <Modal open onClose={onClose} width={860} title={<span className="row"><BrandIcon type={integration.type} size={22} />Import metrics · {integration.name}</span>}
      footer={<><span className="pf-sub">Data for the run’s execution window is stored in Perfmon and correlated to the Run ID; completed runs are re-analyzed.</span><div className="spacer" />
        <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        <button className="btn btn-primary" disabled={!valid || run.isPending} onClick={() => run.mutate()}><Download size={13} />{run.isPending ? 'Importing…' : 'Import'}</button></>}>
      <div className="stack">
        <div className="pf-form-grid">
          <FormField label="Run" required hint={runs.isLoading ? 'Loading runs…' : `${startedRuns.length} started runs${integration.projectName ? ` in ${integration.projectName}` : ''}`}>
            <select className="select" value={runId} onChange={(e) => { setRunId(e.target.value); setResult(null); }}>
              <option value="">Select a run…</option>
              {startedRuns.map((r) => <option key={r.id} value={r.runId}>{r.runId} · {r.testName} · {r.status}</option>)}
            </select>
          </FormField>
          <FormField label="Queries">
            <div className="seg">
              <button type="button" className={mode === 'default' ? 'on' : ''} onClick={() => setMode('default')}>{Array.isArray(integration.config?.mappings) && integration.config.mappings.length ? 'Configured mappings' : 'Connector defaults'} ({defaults.length})</button>
              <button type="button" className={mode === 'custom' ? 'on' : ''} onClick={() => setMode('custom')}>Custom</button>
            </div>
          </FormField>
        </div>
        {mode === 'custom' ? (
          <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 6, maxHeight: 320 }}>
            <table className="table">
              <thead><tr><th>Target</th><th>Perfmon metric</th><th>{queryHint}</th><th>Server / service</th><th className="r">Scale</th><th title="100 − value (e.g. CPU idle → used)">Invert %</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const e = rowErr(r);
                  return (
                    <tr key={r.key}>
                      <td><select className="select" value={r.target} onChange={(ev) => set(r.key, { target: ev.target.value as QRow['target'] })}>{Object.keys(IMPORT_METRICS).map((t) => <option key={t}>{t}</option>)}</select></td>
                      <td>{r.target === 'custom' ? <input className={`input mono ${e === 'metric' ? 'pf-invalid' : ''}`} style={{ width: 150 }} value={r.metric} onChange={(ev) => set(r.key, { metric: ev.target.value })} />
                        : <select className="select" value={r.metric} onChange={(ev) => set(r.key, { metric: ev.target.value })}>{!IMPORT_METRICS[r.target].includes(r.metric) && <option value={r.metric}>{r.metric}</option>}{IMPORT_METRICS[r.target].map((m) => <option key={m}>{m}</option>)}</select>}</td>
                      <td><input className={`input mono ${e === 'query' ? 'pf-invalid' : ''}`} style={{ width: 260 }} value={r.query} placeholder={queryHint} onChange={(ev) => set(r.key, { query: ev.target.value })} /></td>
                      <td><input className="input" style={{ width: 130 }} value={r.target === 'server' || r.target === 'jvm' ? r.serverName : r.serviceName} placeholder="from labels" onChange={(ev) => set(r.key, r.target === 'server' || r.target === 'jvm' ? { serverName: ev.target.value } : { serviceName: ev.target.value })} /></td>
                      <td className="r"><input className={`input num ${e === 'scale' ? 'pf-invalid' : ''}`} style={{ width: 80 }} value={r.scale} placeholder="1" onChange={(ev) => set(r.key, { scale: ev.target.value })} /></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={r.invert} onChange={(ev) => set(r.key, { invert: ev.target.checked })} aria-label="Invert percentage" /></td>
                      <td><button className="btn btn-ghost icon-btn btn-sm" aria-label="Remove query" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 size={13} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ padding: 8 }}><button className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { key: Date.now(), metric: 'cpu_pct', query: '', target: 'server', serverName: '', serviceName: '', scale: '', invert: false }])}><Plus size={12} />Add query</button></div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            {defaults.length ? defaults.map((q, i) => (
              <div key={i} className="row" style={{ fontSize: 12 }}><span className="pf-tag">{q.target}</span><b className="mono">{q.metric}</b><span className="muted">←</span><span className="pf-mono-sm muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.query}</span></div>
            )) : <div className="notice">No mappings are configured and this connector has no defaults — switch to Custom.</div>}
          </div>
        )}
        {run.error && <div className="pf-result bad"><XCircle size={14} /><span className="msg">{errMsg(run.error)}</span></div>}
        {result && (
          <div className="card" style={{ padding: 12 }}>
            <div className="row wrap" style={{ gap: 16 }}>
              <div className={`pf-result ${result.imported ? 'ok' : 'bad'}`} style={{ padding: '4px 8px' }}>{result.imported ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<b>{fmtNum(result.imported)}</b> points imported</div>
              <span><b>{fmtNum(result.series)}</b> <span className="muted">series</span></span>
              {result.runId && <span className="mono">{result.runId}</span>}
              {result.window && <span className="muted">{fmtDate(result.window.from)} → {fmtDate(result.window.to)} · step {result.window.stepSec}s</span>}
            </div>
            {(result.servers?.length || result.services?.length) ? <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>{result.servers?.map((s) => <span key={`s${s}`} className="pf-tag">server · {s}</span>)}{result.services?.map((s) => <span key={`v${s}`} className="pf-tag">service · {s}</span>)}</div> : null}
            {result.warnings.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="pf-section-title">Warnings · {result.warnings.length}</div>
                <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--warn)', fontSize: 12 }}>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ snippets */

type SnipKey = 'jmeter' | 'github' | 'jenkins' | 'gitlab' | 'azure' | 'otlp';

function Snippets() {
  const base = typeof window !== 'undefined' ? window.location.origin : 'https://perfmon.example.com';
  const [ctx, setCtx] = useState<S.SnippetCtx>({ base, project: 'My Project', application: 'My App', environment: 'Performance', test: 'Checkout Load Test' });
  const [k, setK] = useState<SnipKey>('jmeter');
  const items: Record<SnipKey, { label: string; title: string; lang: string; code: string; note: string }> = {
    jmeter: { label: 'JMeter Backend Listener', title: 'Backend Listener settings', lang: 'properties', code: S.jmeterListener(ctx), note: 'Streams live samples, percentiles and errors to Perfmon while the test runs (InfluxDB line protocol compatible).' },
    github: { label: 'GitHub Actions', title: '.github/workflows/performance.yml', lang: 'yaml', code: S.githubActions(ctx), note: 'Store an API key with the “ingest” scope as the PERFMON_API_KEY repository secret.' },
    jenkins: { label: 'Jenkins', title: 'Jenkinsfile', lang: 'groovy', code: S.jenkinsfile(ctx), note: 'Store the key as a “Secret text” credential with id perfmon-api-key.' },
    gitlab: { label: 'GitLab CI', title: '.gitlab-ci.yml', lang: 'yaml', code: S.gitlabCi(ctx), note: 'Define PERFMON_API_KEY as a masked, protected CI/CD variable.' },
    azure: { label: 'Azure DevOps', title: 'azure-pipelines.yml', lang: 'yaml', code: S.azureDevops(ctx), note: 'Add PERFMON_API_KEY as a secret pipeline variable.' },
    otlp: { label: 'OpenTelemetry (OTLP)', title: 'OTLP/HTTP metrics endpoint', lang: 'yaml', code: S.otlp(ctx), note: 'JSON-encoded OTLP metrics; gauges/sums are stored as metric points tagged with resource attributes.' },
  };
  const cur = items[k];
  return (
    <div className="pf-split" style={{ gridTemplateColumns: '260px minmax(0, 1fr)' }}>
      <div className="stack">
        <Card noPad title="Snippet">
          <div className="pf-list">
            {(Object.keys(items) as SnipKey[]).map((key) => (
              <button key={key} className={`pf-list-item ${k === key ? 'active' : ''}`} onClick={() => setK(key)}><div className="t"><Code2 size={13} /><span className="name">{items[key].label}</span></div></button>
            ))}
          </div>
        </Card>
        <Card title="Fill in">
          <div className="stack" style={{ gap: 8 }}>
            {(['base', 'project', 'application', 'environment', 'test'] as const).map((f) => (
              <FormField key={f} label={f === 'base' ? 'Perfmon URL' : f.charAt(0).toUpperCase() + f.slice(1)}>
                <input className="input" value={ctx[f]} onChange={(e) => setCtx((c) => ({ ...c, [f]: e.target.value }))} />
              </FormField>
            ))}
          </div>
        </Card>
      </div>
      <div className="stack">
        <div className="pf-callout"><BookOpen size={14} /><div>{cur.note} Create the key under <b>Administration → API Keys</b>; it is shown only once.
          {k !== 'jmeter' && k !== 'otlp' && <> Pipeline flow: <b>create run</b> → start → run JMeter → <b>upload artifacts</b> → <b>complete</b> (triggers SLA, regression and scoring).</>}</div></div>
        <CodeSnippet title={cur.title} lang={cur.lang} code={cur.code} />
      </div>
    </div>
  );
}
