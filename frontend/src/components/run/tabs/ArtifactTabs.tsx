import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, ExternalLink, FileUp, History, Maximize2, Minimize2, Paperclip, RefreshCw, Trash2, Upload, FileCode2, ShieldCheck, Loader2 } from 'lucide-react';
import { api, API_BASE, download } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { ConfirmDialog, ErrorBox, KeyValue, Modal } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { fmtBytes, fmtDate, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { CopyButton, EmptyState, SkeletonGrid, StatusChip } from '../common';
import type { RunDetail } from '../types';

const enc = encodeURIComponent;
export const ARTIFACT_KINDS = ['HTML_REPORT', 'JTL', 'CSV', 'JMX', 'LOG', 'SCREENSHOT', 'SERVER_LOG', 'APP_LOG', 'CONFIG', 'TEST_DATA', 'JSON', 'XML', 'PDF', 'EXCEL', 'ZIP', 'OTHER'];

export interface ArtifactVersion { id: string; version: number; originalFilename: string; mimeType: string; sizeBytes: number; sha256: string; uploadedBy: string | null; uploadedAt: string; processingStatus: string | null; processingError: string | null; scanStatus: string | null; metadata: any; hasViewer: boolean }
export interface Artifact { id: string; runId: string; runKey: string; kind: string; name: string; description: string | null; source: string; currentVersion: number; createdAt: string; updatedAt: string; latest?: ArtifactVersion }

const PROCESSING = new Set(['QUEUED', 'PROCESSING', 'PENDING']);

/** Drag-and-drop upload zone (multipart: file, kind, name). */
export function UploadZone({ run, defaultKind = '', onDone, compact }: { run: RunDetail; defaultKind?: string; onDone?: (msg: string) => void; compact?: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [kind, setKind] = useState(defaultKind);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const up = useMutation({
    mutationFn: async (files: File[]) => {
      const out: string[] = [];
      for (const f of files) {
        const fd = new FormData();
        if (kind) fd.append('kind', kind);
        if (name && files.length === 1) fd.append('name', name);
        fd.append('file', f);
        const r = await api.post<{ duplicate: boolean; message: string; artifact: Artifact }>(`/runs/${enc(run.runId)}/artifacts`, fd);
        out.push(`${f.name}: ${r.message}`);
      }
      return out.join(' · ');
    },
    onSuccess: (m) => { setMsg(m); setName(''); onDone?.(m); qc.invalidateQueries({ queryKey: ['run-sub', run.runId] }); qc.invalidateQueries({ queryKey: ['run', run.runId] }); },
  });
  const pick = (fl: FileList | null) => { if (fl?.length) up.mutate([...fl]); };
  return (
    <div className={`dropzone ${drag ? 'drag' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}>
      <div className="dz-main" role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}>
        {up.isPending ? <Loader2 size={20} className="spin" /> : <Upload size={20} />}
        <div>
          <b>{up.isPending ? 'Uploading…' : 'Drop files here or click to browse'}</b>
          <div className="muted small">JTL, JMeter HTML report (.zip), JMX, logs, CSV, screenshots, PDFs… Identical files (SHA-256) are not duplicated.</div>
        </div>
      </div>
      <div className="dz-opts row wrap" onClick={(e) => e.stopPropagation()}>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Artifact kind">
          <option value="">Kind: auto-detect</option>{ARTIFACT_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
        </select>
        <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Artifact name" />
      </div>
      <input ref={input} type="file" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
      {up.error && <ErrorBox error={up.error} />}
      {msg && !up.error && <div className="notice small">{msg}</div>}
    </div>
  );
}

function Preview({ art, version, onClose }: { art: Artifact | null; version: number | null; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; text?: string; truncated?: boolean; img?: string; none?: string; err?: string }>({ loading: true });
  useEffect(() => {
    if (!art || version == null) return;
    let url: string | null = null;
    setState({ loading: true });
    api.raw(`/artifacts/${art.id}/versions/${version}/preview`).then(async (res) => {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.startsWith('image/')) { url = URL.createObjectURL(await res.blob()); setState({ loading: false, img: url }); return; }
      const j = await res.json();
      if (!j.previewable) setState({ loading: false, none: `No inline preview for ${j.mimeType ?? 'this file type'} — download the original instead.` });
      else setState({ loading: false, text: j.content, truncated: j.truncated });
    }).catch((e) => setState({ loading: false, err: (e as Error).message }));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [art, version]);
  return (
    <Modal open={!!art} onClose={onClose} title={<span>{art?.name} <span className="muted">v{version}</span></span>} width={1000}
      footer={art && <button className="btn" onClick={() => download(`/artifacts/${art.id}/versions/${version}/download`, art.latest?.originalFilename)}><Download size={14} />Download original</button>}>
      {state.loading && <div className="skeleton" style={{ height: 300 }} />}
      {state.err && <ErrorBox error={new Error(state.err)} />}
      {state.none && <div className="notice">{state.none}</div>}
      {state.img && <img src={state.img} alt={art?.name} className="preview-img" />}
      {state.text != null && <>{state.truncated && <div className="notice small" style={{ marginBottom: 8 }}>Showing the first 256 KB.</div>}<pre className="preview-text">{state.text}</pre></>}
    </Modal>
  );
}

function Versions({ art, onClose, onPreview }: { art: Artifact | null; onClose: () => void; onPreview: (v: number) => void }) {
  const q = useQuery({ queryKey: ['artifact', art?.id], queryFn: () => api.get<Artifact & { versions: ArtifactVersion[] }>(`/artifacts/${art!.id}`), enabled: !!art });
  return (
    <Modal open={!!art} onClose={onClose} title={<span><History size={14} /> Versions — {art?.name}</span>} width={860}>
      {q.isLoading && <div className="skeleton" style={{ height: 120 }} />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <table className="table compact-table">
          <thead><tr><th>Version</th><th>File</th><th className="r">Size</th><th>SHA-256</th><th>Uploaded</th><th>Processing</th><th /></tr></thead>
          <tbody>{q.data.versions.map((v) => (
            <tr key={v.id}>
              <td><b>v{v.version}</b>{v.version === q.data!.currentVersion && <span className="badge accent" style={{ marginLeft: 6 }}>current</span>}</td>
              <td className="mono small">{v.originalFilename}</td><td className="r num">{fmtBytes(v.sizeBytes)}</td>
              <td className="mono small" title={v.sha256}>{v.sha256.slice(0, 12)}…<CopyButton text={v.sha256} label="Copy SHA-256" /></td>
              <td className="small">{v.uploadedBy ?? '—'}<div className="muted">{fmtDate(v.uploadedAt)}</div></td>
              <td><StatusBadge value={v.processingStatus} title={v.processingError ?? undefined} /></td>
              <td className="r"><button className="btn btn-ghost btn-sm icon-btn" aria-label="Preview" onClick={() => onPreview(v.version)}><Eye size={14} /></button>
                <button className="btn btn-ghost btn-sm icon-btn" aria-label="Download" onClick={() => download(`/artifacts/${art!.id}/versions/${v.version}/download`, v.originalFilename)}><Download size={14} /></button></td>
            </tr>))}</tbody>
        </table>
      )}
    </Modal>
  );
}

export function ArtifactsTab({ run, goTab }: { run: RunDetail; goTab: (t: string) => void }) {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const [preview, setPreview] = useState<{ art: Artifact; v: number } | null>(null);
  const [versions, setVersions] = useState<Artifact | null>(null);
  const [del, setDel] = useState<Artifact | null>(null);
  const [kindFilter, setKindFilter] = useState('');
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<Artifact | null>(null);
  const q = useQuery({
    queryKey: ['run-sub', run.runId, 'artifacts'], queryFn: () => api.get<Artifact[]>(`/runs/${enc(run.runId)}/artifacts`),
    refetchInterval: (query) => ((query.state.data as Artifact[] | undefined)?.some((a) => PROCESSING.has(a.latest?.processingStatus ?? '')) ? 3000 : false),
  });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['run-sub', run.runId] }); qc.invalidateQueries({ queryKey: ['run', run.runId] }); };
  const remove = useMutation({ mutationFn: (a: Artifact) => api.del(`/artifacts/${a.id}`, { confirm: true }), onSuccess: invalidate });
  const replace = useMutation({
    mutationFn: ({ a, f }: { a: Artifact; f: File }) => { const fd = new FormData(); fd.append('file', f); return api.post(`/artifacts/${a.id}/versions`, fd); },
    onSuccess: invalidate, onSettled: () => setReplacing(null),
  });
  const reprocess = useMutation({ mutationFn: (a: Artifact) => api.post(`/artifacts/${a.id}/versions/latest/reprocess`), onSuccess: invalidate });
  const rows = (q.data ?? []).filter((a) => !kindFilter || a.kind === kindFilter);
  const kinds = [...new Set((q.data ?? []).map((a) => a.kind))];
  const mutErr = remove.error ?? replace.error ?? reprocess.error;

  return (
    <div className="stack">
      {can('UPLOAD_ARTIFACT') && <UploadZone run={run} />}
      {mutErr && <ErrorBox error={mutErr} />}
      <section className="card">
        <div className="card-head">
          <h3><Paperclip size={13} /> Artifacts</h3>
          <div className="row">
            {kinds.length > 1 && <select className="select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Filter by kind"><option value="">All kinds</option>{kinds.map((k) => <option key={k}>{k}</option>)}</select>}
            <span className="muted small">{q.data?.length ?? 0} files</span>
          </div>
        </div>
        {q.error && <div className="card-body"><ErrorBox error={q.error} /></div>}
        {q.isLoading ? <div className="card-body"><div className="skeleton" style={{ height: 120 }} /></div> : !rows.length ? (
          <EmptyState icon={<Paperclip size={24} />} title="No artifacts attached">Upload the JMeter HTML report (.zip), JTL results, test plan (.jmx) and server logs — everything is versioned, checksummed and linked to <span className="mono">{run.runId}</span>.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table compact-table">
              <thead><tr><th>Name</th><th>Kind</th><th>Version</th><th className="r">Size</th><th>Uploaded</th><th>Processing</th><th>SHA-256</th><th className="r">Actions</th></tr></thead>
              <tbody>{rows.map((a) => {
                const v = a.latest;
                const busy = PROCESSING.has(v?.processingStatus ?? '');
                return (
                  <tr key={a.id}>
                    <td><b>{a.name}</b><div className="muted small mono">{v?.originalFilename}</div></td>
                    <td><span className="badge">{a.kind.replace(/_/g, ' ')}</span></td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => setVersions(a)} title="Version history"><History size={12} />v{a.currentVersion}</button></td>
                    <td className="r num">{fmtBytes(v?.sizeBytes)}</td>
                    <td className="small">{v?.uploadedBy ?? '—'}<div className="muted">{fmtDate(v?.uploadedAt)}</div></td>
                    <td>
                      <span className="row" style={{ gap: 4 }}>{busy && <Loader2 size={12} className="spin" />}<StatusBadge value={v?.processingStatus} title={v?.processingError ?? undefined} /></span>
                      {v?.processingError && <div className="ink-fail small wrap-cell">{v.processingError}</div>}
                      {v?.scanStatus && v.scanStatus !== 'CLEAN' && <div className="muted small"><ShieldCheck size={11} /> scan: {v.scanStatus}</div>}
                    </td>
                    <td className="mono small" title={v?.sha256}>{v?.sha256?.slice(0, 10)}…</td>
                    <td className="r nowrap">
                      {a.kind === 'HTML_REPORT' && <button className="btn btn-ghost btn-sm icon-btn" title="Open report viewer" aria-label="Open report viewer" onClick={() => goTab('html-report')}><FileCode2 size={14} /></button>}
                      <button className="btn btn-ghost btn-sm icon-btn" title="Preview" aria-label="Preview" onClick={() => setPreview({ art: a, v: a.currentVersion })}><Eye size={14} /></button>
                      <button className="btn btn-ghost btn-sm icon-btn" title="Download" aria-label="Download" onClick={() => download(`/artifacts/${a.id}/versions/${a.currentVersion}/download`, v?.originalFilename)}><Download size={14} /></button>
                      {can('UPLOAD_ARTIFACT') && <button className="btn btn-ghost btn-sm icon-btn" title="Replace (upload new version)" aria-label="Replace" disabled={replace.isPending} onClick={() => { setReplacing(a); replaceInput.current?.click(); }}>{replace.isPending && replacing?.id === a.id ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />}</button>}
                      {can('UPLOAD_ARTIFACT') && (v?.processingStatus === 'FAILED' || ['HTML_REPORT', 'JTL', 'SERVER_LOG', 'APP_LOG'].includes(a.kind)) && <button className="btn btn-ghost btn-sm icon-btn" title="Re-process" aria-label="Re-process" onClick={() => reprocess.mutate(a)}><RefreshCw size={14} /></button>}
                      {can('DELETE_ARTIFACT') && <button className="btn btn-ghost btn-sm icon-btn danger-ink" title="Delete" aria-label="Delete" onClick={() => setDel(a)}><Trash2 size={14} /></button>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>
      <input ref={replaceInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f && replacing) replace.mutate({ a: replacing, f }); e.target.value = ''; }} />
      <Preview art={preview?.art ?? null} version={preview?.v ?? null} onClose={() => setPreview(null)} />
      <Versions art={versions} onClose={() => setVersions(null)} onPreview={(v) => { const a = versions!; setVersions(null); setPreview({ art: a, v }); }} />
      <ConfirmDialog open={!!del} title="Delete artifact?" confirmLabel="Delete" onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del)}
        message={<>Delete <b>{del?.name}</b> ({del?.kind}) from <span className="mono">{run.runId}</span>? It is soft-deleted: files are retained until a confirmed retention purge and the action is audited.</>} />
    </div>
  );
}

interface HtmlReportResp {
  available: boolean; artifact?: Artifact; version?: ArtifactVersion; versions?: ArtifactVersion[]; viewerUrl?: string | null; downloadUrl?: string;
  summary?: { parser_version: string; report_generated_at: string | null; parsed_at: string; overall: any; transactions: any[]; errors: any[]; top_errors: any[]; response_codes: { code: string; count: number }[]; apdex: any; warnings: string[] } | null;
}
interface Recon { status: string; consistent: boolean; liveSource: string | null; rows: { metric: string; key: string; live: number | null; report: number | null; difference: number | null; differencePct: number | null; status: string; unit: string }[]; issues: string[]; notes?: string[]; message?: string }

const fmtVal = (v: number | null | undefined, unit: string) => (v == null ? '—' : unit === 'ms' ? fmtMs(v) : unit === '%' ? fmtPct(v, 3) : fmtNum(v, Math.abs(v) < 100 ? 2 : 0) + (unit && unit !== '' ? ` ${unit}` : ''));

export function HtmlReportTab({ run }: { run: RunDetail }) {
  const [ver, setVer] = useState<number | undefined>();
  const [full, setFull] = useState(false);
  const q = useQuery({
    queryKey: ['run-sub', run.runId, 'html-report', ver], queryFn: () => api.get<HtmlReportResp>(`/runs/${enc(run.runId)}/html-report`, { version: ver }),
    refetchInterval: (query) => (PROCESSING.has((query.state.data as HtmlReportResp | undefined)?.version?.processingStatus ?? '') ? 3000 : false),
  });
  const rec = useQuery({ queryKey: ['run-sub', run.runId, 'reconciliation'], queryFn: () => api.get<Recon>(`/runs/${enc(run.runId)}/reconciliation`), enabled: !!q.data?.available });
  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [full]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={4} height={100} />;
  const d = q.data!;
  if (!d.available) {
    return (
      <div className="stack">
        <EmptyState icon={<FileCode2 size={26} />} title="No JMeter HTML report for this run">Generate the dashboard with <span className="mono">jmeter -g results.jtl -o report/</span>, zip the folder and upload it. Perfmon parses its statistics, serves it in an isolated sandbox and reconciles it against the live metrics.</EmptyState>
        <UploadZone run={run} defaultKind="HTML_REPORT" compact />
      </div>
    );
  }
  const v = d.version!;
  const viewer = d.viewerUrl ? (/^https?:\/\//.test(d.viewerUrl) ? d.viewerUrl : `${API_BASE}${d.viewerUrl}`) : null;
  const s = d.summary;
  const o = s?.overall ?? {};
  const busy = PROCESSING.has(v.processingStatus ?? '');
  const recon = rec.data;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3><FileCode2 size={13} /> {d.artifact?.name ?? 'HTML report'}</h3>
          <div className="row wrap">
            {(d.versions?.length ?? 0) > 1 && (
              <select className="select" value={ver ?? v.version} onChange={(e) => setVer(Number(e.target.value))} aria-label="Report version">
                {d.versions!.map((x) => <option key={x.version} value={x.version}>v{x.version} · {fmtDate(x.uploadedAt)}</option>)}
              </select>
            )}
            {viewer && <button className="btn btn-sm" onClick={() => setFull(true)}><Maximize2 size={14} />Fullscreen</button>}
            {viewer && <a className="btn btn-sm" href={viewer} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />Open in new tab</a>}
            <button className="btn btn-sm" onClick={() => download(`/artifacts/${d.artifact!.id}/versions/${v.version}/download`, v.originalFilename)}><Download size={14} />Download original</button>
          </div>
        </div>
        <div className="card-body">
          <KeyValue items={[
            ['Version', `v${v.version}${d.versions && v.version === d.versions[0]?.version ? ' (latest)' : ''}`],
            ['File', <span className="mono" title={v.originalFilename}>{v.originalFilename}</span>],
            ['Size', fmtBytes(v.sizeBytes)],
            ['SHA-256', <span className="mono" title={v.sha256}>{v.sha256.slice(0, 16)}…<CopyButton text={v.sha256} label="Copy SHA-256" /></span>],
            ['Uploaded by', v.uploadedBy ?? '—'],
            ['Uploaded at', fmtDate(v.uploadedAt)],
            ['Processing', <StatusBadge value={v.processingStatus} title={v.processingError ?? undefined} />],
            ['Parser', s ? `v${s.parser_version}` : '—'],
            ['Report generated', s?.report_generated_at ?? '—'],
          ]} />
          {(s?.warnings?.length ?? 0) > 0 && <div className="notice small" style={{ marginTop: 10 }}><b>Parser warnings:</b><ul className="evidence">{s!.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
          {v.processingError && <div className="error-box small" style={{ marginTop: 10 }}>{v.processingError}</div>}
        </div>
      </section>

      <section className={`card report-frame-card ${full ? 'report-full' : ''}`}>
        {full && <div className="report-full-bar"><b>{d.artifact?.name}</b><span className="muted small mono">{run.runId} · v{v.version}</span><div className="spacer" /><button className="btn btn-sm" onClick={() => setFull(false)}><Minimize2 size={14} />Exit fullscreen</button></div>}
        {viewer ? (
          <iframe title="JMeter HTML report" src={viewer} className="report-frame" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="no-referrer" />
        ) : busy ? <EmptyState icon={<Loader2 size={22} className="spin" />} title="Processing report…">Extracting and parsing the upload — this view refreshes automatically.</EmptyState>
          : <EmptyState icon={<FileCode2 size={22} />} title="No viewer for this version">The upload is not an extractable report (e.g. a single file without assets). Download the original to view it.</EmptyState>}
        <div className="muted small report-note"><ShieldCheck size={11} /> The report runs in an isolated sandbox on a separate origin — its scripts cannot access Perfmon.</div>
      </section>

      {s && (
        <section className="card">
          <div className="card-head"><h3>Parsed report statistics</h3><span className="muted small">{s.transactions?.length ?? 0} samplers</span></div>
          <div className="card-body">
            <div className="kpis">
              {[['Samples', fmtNum(o.samples)], ['Failures', fmtNum(o.failures)], ['Error %', fmtPct(o.errorPct)], ['Avg', fmtMs(o.avg)], ['Median', fmtMs(o.median)],
                ['P90', fmtMs(o.percentiles?.p90)], ['P95', fmtMs(o.percentiles?.p95)], ['P99', fmtMs(o.percentiles?.p99)], ['Min / Max', `${fmtMs(o.min)} / ${fmtMs(o.max)}`],
                ['Throughput', `${fmtNum(o.throughput, 2)}/s`], ['Received', `${fmtNum(o.receivedKbSec, 1)} KB/s`], ['APDEX', s.apdex?.overall?.apdex != null ? fmtNum(s.apdex.overall.apdex, 3) : '—']]
                .map(([l, val]) => <div key={l} className="kpi"><div className="kpi-label">{l}</div><div className="kpi-value" style={{ fontSize: 16 }}>{val}</div></div>)}
            </div>
            {s.transactions?.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 10, maxHeight: 320 }}>
                <table className="table compact-table"><thead><tr><th>Label</th><th className="r">Samples</th><th className="r">Fail</th><th className="r">Error %</th><th className="r">Avg</th><th className="r">P90</th><th className="r">P95</th><th className="r">P99</th><th className="r">TPS</th></tr></thead>
                  <tbody>{s.transactions.map((t: any) => <tr key={t.label}><td className="mono txn-name">{t.label}</td><td className="r num">{fmtNum(t.samples)}</td><td className="r num">{fmtNum(t.failures)}</td><td className="r num">{fmtPct(t.errorPct)}</td><td className="r num">{fmtMs(t.avg)}</td><td className="r num">{fmtMs(t.percentiles?.p90)}</td><td className="r num">{fmtMs(t.percentiles?.p95)}</td><td className="r num">{fmtMs(t.percentiles?.p99)}</td><td className="r num">{fmtNum(t.throughput, 2)}</td></tr>)}</tbody></table>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Data consistency</h3>
          {recon && recon.status !== 'NOT_AVAILABLE' && <StatusChip status={recon.status} label={recon.status.replace(/_/g, ' ')} />}
        </div>
        <div className="card-body stack">
          {rec.isLoading && <div className="skeleton" style={{ height: 120 }} />}
          {rec.error && <ErrorBox error={rec.error} />}
          {recon?.status === 'NOT_AVAILABLE' && <div className="notice">{recon.message ?? 'Reconciliation is not available.'} {busy ? 'It runs once the report has been parsed.' : ''}</div>}
          {recon && recon.rows.length > 0 && <>
            <div className="muted small">Live metrics (<b>{recon.liveSource}</b>) vs the uploaded JMeter HTML report for the same Run ID. Tolerances: counts 0.1%, averages 2%, percentiles 5% (or 25 ms), throughput 2%.</div>
            <div className="table-wrap">
              <table className="table compact-table">
                <thead><tr><th>Metric</th><th className="r">Live</th><th className="r">Report</th><th className="r">Difference</th><th className="r">Diff %</th><th>Status</th></tr></thead>
                <tbody>{recon.rows.map((r) => (
                  <tr key={r.key} className={r.status === 'MISMATCH' ? 'row-bad' : ''}>
                    <td>{r.metric}</td><td className="r num">{fmtVal(r.live, r.unit)}</td><td className="r num">{fmtVal(r.report, r.unit)}</td>
                    <td className="r num">{r.difference == null ? '—' : `${r.difference > 0 ? '+' : ''}${fmtVal(r.difference, r.unit)}`}</td>
                    <td className="r num">{r.differencePct == null ? '—' : `${r.differencePct > 0 ? '+' : ''}${r.differencePct.toFixed(2)}%`}</td>
                    <td><StatusChip status={r.status === 'N/A' ? null : r.status} size="sm" label={r.status} /></td>
                  </tr>))}</tbody>
              </table>
            </div>
            {recon.issues.length > 0 && <div className="error-box small"><b>Mismatches:</b><ul className="evidence">{recon.issues.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            {recon.notes?.map((n, i) => <div key={i} className="muted small">• {n}</div>)}
          </>}
        </div>
      </section>
    </div>
  );
}
