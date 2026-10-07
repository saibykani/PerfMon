import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Cpu, Database, HardDrive, Layers, Pause, Play, Radio, RotateCcw, Server, Upload, XCircle, Zap } from 'lucide-react';
import { api } from '@/services/api';
import { Card, Kpi } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/Status';
import { fmtBytes, fmtDate, fmtDuration, fmtNum } from '@/components/format';
import { Chip, Drawer, EmptyState, errMsg, JsonBlock, KeyValueGrid, relTime, Sparkline, toast, Unavailable } from '@/components/platform/kit';

/* ------------------------------------------------------------------ background jobs */

interface Job {
  id: string; type: string; status: string; payload: any; result: any; error: string | null; errorDetail?: string | null; runId: string | null; runKey: string | null; priority: number;
  attempts: number; maxAttempts: number; runAfter: string; lockedBy: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
}

export function JobsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Job | null>(null);
  useEffect(() => setPage(1), [status, type]);
  const q = useQuery({
    queryKey: ['admin-jobs', status, type, page],
    queryFn: () => api.get<{ items: Job[]; total: number; stats: Record<string, number>; types?: { type: string; n: number; failed: number }[] }>('/admin/jobs', { status, type, page, pageSize: 50 }),
    refetchInterval: 10000, placeholderData: (p) => p,
  });
  const retry = useMutation({
    mutationFn: (j: Job) => api.post(`/admin/jobs/${j.id}/retry`, {}),
    onSuccess: (_d, j) => { toast.success(`Job ${j.type} re-queued.`); qc.invalidateQueries({ queryKey: ['admin-jobs'] }); setOpen(null); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const st = q.data?.stats ?? { QUEUED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
  const cols: Column<Job>[] = [
    { key: 'type', header: 'Type', sortable: false, render: (j) => <span className="mono" style={{ fontWeight: 600 }}>{j.type}</span> },
    { key: 'status', header: 'Status', sortable: false, render: (j) => <StatusBadge value={j.status} /> },
    { key: 'runKey', header: 'Run', sortable: false, render: (j) => (j.runKey ? <span className="mono">{j.runKey}</span> : <span className="muted">—</span>) },
    { key: 'attempts', header: 'Attempts', align: 'right', sortable: false, render: (j) => <span className={j.attempts >= j.maxAttempts && j.status === 'FAILED' ? 'num' : 'num muted'}>{j.attempts}/{j.maxAttempts}</span> },
    { key: 'createdAt', header: 'Created', sortable: false, render: (j) => <span title={fmtDate(j.createdAt)}>{relTime(j.createdAt)}</span> },
    { key: 'durationMs', header: 'Duration', align: 'right', sortable: false, render: (j) => (j.durationMs != null ? (j.durationMs < 1000 ? `${j.durationMs} ms` : fmtDuration(j.durationMs / 1000)) : <span className="muted">—</span>) },
    { key: 'error', header: 'Error', sortable: false, render: (j) => (j.error ? <span className="pf-row-error" style={{ display: 'inline-block', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.error}>{j.error}</span> : null) },
    { key: 'actions', header: '', sortable: false, render: (j) => (j.status === 'FAILED' ? <span onClick={(e) => e.stopPropagation()}><button className="btn btn-sm" disabled={retry.isPending} onClick={() => retry.mutate(j)}><RotateCcw size={12} />Retry</button></span> : null) },
  ];
  return (
    <div className="stack">
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
        <Kpi label="Queued" value={fmtNum(st.QUEUED)} onClick={() => setStatus('QUEUED')} sub="waiting for a worker" />
        <Kpi label="Processing" value={fmtNum(st.PROCESSING)} status={st.PROCESSING ? 'pass' : null} onClick={() => setStatus('PROCESSING')} />
        <Kpi label="Completed" value={fmtNum(st.COMPLETED)} onClick={() => setStatus('COMPLETED')} />
        <Kpi label="Failed" value={fmtNum(st.FAILED)} status={st.FAILED ? 'fail' : 'pass'} onClick={() => setStatus('FAILED')} sub={st.FAILED ? 'retry after fixing the cause' : 'no failures'} />
      </div>
      <Card noPad>
        {q.error ? <div className="card-body"><Unavailable what="Background jobs" error={q.error} /></div> : (
          <DataTable rows={q.data?.items ?? []} columns={cols} rowKey={(j) => j.id} loading={q.isLoading} searchable={false} onRowClick={setOpen} exportName="jobs"
            server={{ page, pageSize: 50, total: q.data?.total ?? 0, onPage: setPage, onSort: () => undefined }}
            toolbar={<>
              <div className="seg">{['', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'].map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s ? s.charAt(0) + s.slice(1).toLowerCase() : 'All'}</button>)}</div>
              <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Job type">
                <option value="">All types</option>{(q.data?.types ?? []).map((t) => <option key={t.type} value={t.type}>{t.type} ({t.n}{t.failed ? `, ${t.failed} failed` : ''})</option>)}
              </select>
            </>}
            empty={<EmptyState icon={<Layers size={20} />} title="No jobs">Analysis, report generation, notifications and imports run as background jobs.</EmptyState>} />
        )}
      </Card>
      <Drawer open={!!open} onClose={() => setOpen(null)} width={600} title={<span className="mono">{open?.type}</span>} subtitle={open && <span className="row" style={{ gap: 6 }}><StatusBadge value={open.status} />{open.runKey && <span className="mono">{open.runKey}</span>}</span>}
        footer={open?.status === 'FAILED' ? <button className="btn btn-primary" disabled={retry.isPending} onClick={() => retry.mutate(open)}><RotateCcw size={13} />Retry job</button> : undefined}>
        {open && <>
          <KeyValueGrid items={[
            ['Job ID', <span className="mono" style={{ fontSize: 11 }}>{open.id}</span>], ['Priority', open.priority], ['Attempts', `${open.attempts} / ${open.maxAttempts}`],
            ['Created', fmtDate(open.createdAt)], ['Started', fmtDate(open.startedAt)], ['Finished', fmtDate(open.finishedAt)], ['Run after', fmtDate(open.runAfter)], ['Worker', open.lockedBy ?? '—'],
          ]} />
          {(open.errorDetail || open.error) && <div><div className="pf-section-title">Error</div><pre className="pf-code pf-json" style={{ color: 'var(--fail)', maxHeight: 240 }}>{open.errorDetail ?? open.error}</pre></div>}
          <div><div className="pf-section-title">Payload</div><JsonBlock value={open.payload} /></div>
          {open.result != null && <div><div className="pf-section-title">Result</div><JsonBlock value={open.result} /></div>}
        </>}
      </Drawer>
    </div>
  );
}

/* ------------------------------------------------------------------ system health */

interface Health {
  status: 'UP' | 'DEGRADED' | 'DOWN' | string; uptimeSec: number; version: string;
  api: { requests: number; rps: number | null; latencyP50: number | null; latencyP95: number | null; latencyP99: number | null; errors4xx: number; errors5xx: number; errorRatePct: number | null };
  db: { ok?: boolean; pingMs?: number | null; latencyP50: number | null; latencyP95: number | null; poolTotal: number; poolIdle: number; poolWaiting: number; sizeBytes: number | null };
  ingestion: { samplesPerSec: number | null; pointsPerSec: number | null; rowsWritten: number; failures: number; bufferSize: number; flushP95Ms: number | null; rateLimited: number; parseErrors?: number };
  jobs: { queued: number | null; processing: number | null; failed24h: number | null; completed24h: number | null; avgDurationMs: number | null };
  live: { connections: number }; artifacts: { uploaded: number; processed: number; failed: number; processingP95Ms?: number | null };
  process: { heapUsedMb: number | null; rssMb: number | null; cpuPct: number | null; nodeVersion: string; pid?: number }; storage: { driver: string; ok: boolean; detail: string | null }; alertsFired: number;
}
type Sample = { t: number; h: Health };
const MAX_SAMPLES = 90;

const ms = (v: number | null | undefined) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${+v.toFixed(1)} ms`);

export function HealthTab() {
  const [paused, setPaused] = useState(false);
  const hist = useRef<Sample[]>([]);
  const [, force] = useState(0);
  const q = useQuery({ queryKey: ['system-health'], queryFn: () => api.get<Health>('/system/health'), refetchInterval: paused ? false : 10000, refetchIntervalInBackground: false });
  useEffect(() => {
    if (!q.data) return;
    const last = hist.current[hist.current.length - 1];
    if (last && last.h === q.data) return;
    hist.current = [...hist.current, { t: q.dataUpdatedAt || Date.now(), h: q.data }].slice(-MAX_SAMPLES);
    force((x) => x + 1);
  }, [q.data, q.dataUpdatedAt]);

  if (q.isLoading) return <div className="stack"><div className="skeleton" style={{ height: 64 }} /><div className="pf-metrics">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div></div>;
  if (q.error && !q.data) return <Unavailable what="System health (/system/health)" error={q.error} />;
  const h = q.data!;
  const S = hist.current;
  const series = (f: (h: Health) => number | null | undefined) => S.map((s) => { const v = f(s.h); return v == null || !Number.isFinite(v) ? null : v; });
  // per-interval deltas for monotonic counters
  const delta = (f: (h: Health) => number) => S.map((s, i) => (i === 0 ? null : Math.max(0, f(s.h) - f(S[i - 1].h))));
  const tone = h.status === 'UP' ? 'pass' : h.status === 'DEGRADED' ? 'warn' : 'fail';
  const issues: string[] = [];
  if (h.db.ok === false) issues.push('Database is unreachable');
  if (!h.storage.ok) issues.push(`Storage (${h.storage.driver}) unhealthy${h.storage.detail ? `: ${h.storage.detail}` : ''}`);
  if ((h.jobs.failed24h ?? 0) > 0) issues.push(`${h.jobs.failed24h} background jobs failed in the last 24 h`);
  if (h.db.poolWaiting > 0) issues.push(`${h.db.poolWaiting} queries waiting for a DB connection`);
  if (h.ingestion.failures > 0) issues.push(`${fmtNum(h.ingestion.failures)} ingestion failures since start`);
  if ((h.api.errorRatePct ?? 0) > 5) issues.push(`API error rate ${h.api.errorRatePct}%`);

  return (
    <div className="stack">
      <div className={`pf-banner ${tone}`} role="status">
        <div className="big">{tone === 'pass' ? <CheckCircle2 size={20} /> : tone === 'warn' ? <AlertTriangle size={20} /> : <XCircle size={20} />}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Perfmon System Health · {h.status === 'UP' ? 'All systems operational' : h.status === 'DEGRADED' ? 'Degraded' : 'Down'}</div>
          <div className="muted" style={{ fontSize: 12 }}>v{h.version} · uptime {fmtDuration(h.uptimeSec)} · Node {h.process.nodeVersion}{h.process.pid ? ` · pid ${h.process.pid}` : ''} · {issues.length ? issues.join(' · ') : 'no issues detected'}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>{paused ? 'Paused' : 'Refreshing every 10 s'} · {S.length} samples</span>
          <button className="btn btn-sm" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? 'Resume' : 'Pause'}</button>
        </div>
      </div>
      {q.error && <div className="pf-callout warn"><AlertTriangle size={14} /><div>Last refresh failed: {errMsg(q.error)} — showing the previous sample.</div></div>}

      <Section title="API">
        <M icon={<Zap size={12} />} label="Latency p50" value={ms(h.api.latencyP50)} spark={series((x) => x.api.latencyP50)} />
        <M icon={<Zap size={12} />} label="Latency p95" value={ms(h.api.latencyP95)} spark={series((x) => x.api.latencyP95)} sub={`p99 ${ms(h.api.latencyP99)}`} />
        <M icon={<Activity size={12} />} label="Request rate" value={fmtNum(h.api.rps, 2)} unit="req/s" spark={series((x) => x.api.rps)} sub={`${fmtNum(h.api.requests)} total`} />
        <M icon={<AlertTriangle size={12} />} label="API error rate" value={fmtNum(h.api.errorRatePct, 2)} unit="%" spark={series((x) => x.api.errorRatePct)} tone={(h.api.errorRatePct ?? 0) > 5 ? 'fail' : undefined}
          sub={`${fmtNum(h.api.errors4xx)} 4xx · ${fmtNum(h.api.errors5xx)} 5xx`} />
      </Section>
      <Section title="Database">
        <M icon={<Database size={12} />} label="Query latency p95" value={ms(h.db.latencyP95)} spark={series((x) => x.db.latencyP95)} sub={`p50 ${ms(h.db.latencyP50)}${h.db.pingMs != null ? ` · ping ${ms(h.db.pingMs)}` : ''}`} tone={h.db.ok === false ? 'fail' : undefined} />
        <M icon={<Database size={12} />} label="Connection pool" value={`${h.db.poolTotal - h.db.poolIdle} / ${h.db.poolTotal}`} unit="in use" spark={series((x) => x.db.poolTotal - x.db.poolIdle)} sub={`${h.db.poolIdle} idle · ${h.db.poolWaiting} waiting`} tone={h.db.poolWaiting > 0 ? 'warn' : undefined} />
        <M icon={<HardDrive size={12} />} label="Database size" value={fmtBytes(h.db.sizeBytes)} spark={series((x) => x.db.sizeBytes)} />
        <M icon={<HardDrive size={12} />} label="Object storage" value={h.storage.ok ? 'Healthy' : 'Unhealthy'} sub={`${h.storage.driver}${h.storage.detail ? ` · ${h.storage.detail}` : ''}`} tone={h.storage.ok ? 'pass' : 'fail'} />
      </Section>
      <Section title="Ingestion & live">
        <M icon={<Activity size={12} />} label="Ingestion rate" value={fmtNum(h.ingestion.samplesPerSec, 1)} unit="samples/s" spark={series((x) => x.ingestion.samplesPerSec)} sub={`${fmtNum(h.ingestion.pointsPerSec, 1)} points/s`} />
        <M icon={<XCircle size={12} />} label="Ingestion failures" value={fmtNum(h.ingestion.failures)} spark={delta((x) => x.ingestion.failures)} sub={`${fmtNum(h.ingestion.rateLimited)} rate-limited${h.ingestion.parseErrors != null ? ` · ${fmtNum(h.ingestion.parseErrors)} parse errors` : ''}`} tone={h.ingestion.failures ? 'warn' : undefined} />
        <M icon={<Layers size={12} />} label="Write buffer" value={fmtNum(h.ingestion.bufferSize)} unit="rows" spark={series((x) => x.ingestion.bufferSize)} sub={`flush p95 ${ms(h.ingestion.flushP95Ms)} · ${fmtNum(h.ingestion.rowsWritten)} written`} />
        <M icon={<Radio size={12} />} label="WebSocket / SSE" value={fmtNum(h.live.connections)} unit="connections" spark={series((x) => x.live.connections)} />
      </Section>
      <Section title="Background work">
        <M icon={<Layers size={12} />} label="Job queue" value={fmtNum(h.jobs.queued)} unit="queued" spark={series((x) => x.jobs.queued)} sub={`${fmtNum(h.jobs.processing)} processing`} />
        <M icon={<CheckCircle2 size={12} />} label="Jobs (24 h)" value={fmtNum(h.jobs.completed24h)} unit="completed" sub={`${fmtNum(h.jobs.failed24h)} failed · avg ${ms(h.jobs.avgDurationMs)}`} tone={(h.jobs.failed24h ?? 0) > 0 ? 'warn' : undefined} />
        <M icon={<Upload size={12} />} label="Artifact processing" value={fmtNum(h.artifacts.processed)} unit="processed" spark={delta((x) => x.artifacts.processed)} sub={`${fmtNum(h.artifacts.uploaded)} uploaded · ${fmtNum(h.artifacts.failed)} failed${h.artifacts.processingP95Ms != null ? ` · p95 ${ms(h.artifacts.processingP95Ms)}` : ''}`} tone={h.artifacts.failed ? 'warn' : undefined} />
        <M icon={<AlertTriangle size={12} />} label="Alerts fired" value={fmtNum(h.alertsFired)} unit="since start" spark={delta((x) => x.alertsFired)} />
      </Section>
      <Section title="Process (Node.js runtime)">
        <M icon={<Cpu size={12} />} label="Process CPU" value={fmtNum(h.process.cpuPct, 1)} unit="%" spark={series((x) => x.process.cpuPct)} max={100} />
        <M icon={<Server size={12} />} label="Heap used" value={fmtNum(h.process.heapUsedMb, 1)} unit="MB" spark={series((x) => x.process.heapUsedMb)} />
        <M icon={<Server size={12} />} label="Resident memory (RSS)" value={fmtNum(h.process.rssMb, 1)} unit="MB" spark={series((x) => x.process.rssMb)} />
        <M icon={<Activity size={12} />} label="Uptime" value={fmtDuration(h.uptimeSec)} sub={`since ${new Date(Date.now() - h.uptimeSec * 1000).toLocaleString()}`} />
      </Section>
      <div className="pf-sub">Sparklines accumulate client-side while this tab is open (one sample every 10 s, last {MAX_SAMPLES}). Counters marked “since start” reset when the API process restarts.</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div><div className="pf-section-title">{title}</div><div className="pf-metrics">{children}</div></div>;
}

function M({ icon, label, value, unit, sub, spark, tone, max }: { icon?: ReactNode; label: string; value: ReactNode; unit?: string; sub?: ReactNode; spark?: (number | null)[]; tone?: 'pass' | 'warn' | 'fail'; max?: number }) {
  const color = tone === 'fail' ? 'var(--fail)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="pf-metric" style={tone ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}>
      <div className="pf-metric-label">{icon}{label}{tone && tone !== 'pass' && <Chip tone={tone}>{tone === 'fail' ? 'Critical' : 'Warning'}</Chip>}</div>
      <div className="pf-metric-value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {spark && <Sparkline values={spark} color={color} height={26} width={220} max={max} />}
      {sub && <div className="pf-metric-sub" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>}
    </div>
  );
}
