import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FileArchive, History, RefreshCw, RotateCcw, Trash2, Upload, UploadCloud } from 'lucide-react';
import { api, download } from '@/services/api';
import { ConfirmDialog, ErrorBox, Loading, Modal, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/Status';
import { fmtBytes, fmtDate, fmtRelative } from '@/components/format';
import { CopyButton, EmptyState, FormField, Notice, Toaster, friendlyError, toast, useCan } from '@/components/inventory/common';
import { ARTIFACT_KINDS, useProjects, useRuns, type ArtifactRow, type ArtifactVersion, type Paged } from '@/components/inventory/data';

const PREVIEW_KINDS = new Set(['JTL', 'CSV', 'JMX', 'LOG', 'SERVER_LOG', 'APP_LOG', 'CONFIG', 'TEST_DATA', 'JSON', 'XML', 'SCREENSHOT']);
const fileName = (a: ArtifactRow) => a.latest?.originalFilename ?? a.name;

function Sha({ sha }: { sha?: string | null }) {
  if (!sha) return <span className="muted">—</span>;
  return <span className="inv-sha" title={sha}>{sha.slice(0, 12)}…<CopyButton text={sha} size={12} /></span>;
}

export function ArtifactsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [qInput, setQInput] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const kind = params.get('kind') ?? '';
  const projectId = params.get('projectId') ?? '';
  const runId = params.get('runId') ?? '';
  const uploadedBy = params.get('uploadedBy') ?? '';
  const includeDeleted = params.get('deleted') === '1';
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'uploaded', order: 'desc' });
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); setPage(1); };
  useEffect(() => { const h = setTimeout(() => { if (qInput !== q) setParam('q', qInput); }, 300); return () => clearTimeout(h); }, [qInput]); // eslint-disable-line

  const projects = useProjects();
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['inv', 'artifacts', q, kind, projectId, runId, uploadedBy, includeDeleted, page, sort],
    queryFn: () => api.get<Paged<ArtifactRow>>('/artifacts', { q, kind, projectId, runId, uploadedBy, includeDeleted, page, pageSize: 25, sort: sort.key, order: sort.order }),
    placeholderData: (p) => p,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['inv', 'artifacts'] });

  const [preview, setPreview] = useState<{ a: ArtifactRow; version: number | 'latest' } | null>(null);
  const [history, setHistory] = useState<ArtifactRow | null>(null);
  const [del, setDel] = useState<ArtifactRow | null>(null);
  const [upload, setUpload] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceFor, setReplaceFor] = useState<ArtifactRow | null>(null);

  const doReplace = async (a: ArtifactRow, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api.post<{ duplicate: boolean; message: string }>(`/artifacts/${a.id}/versions`, fd);
      toast[res.duplicate ? 'info' : 'success'](`${a.name}: ${res.message}`);
      refresh();
    } catch (e) { toast.error(friendlyError(e)); }
  };
  const remove = async (a: ArtifactRow) => { try { await api.del(`/artifacts/${a.id}`, { confirm: true }); toast.success(`“${a.name}” deleted — it can be restored`); refresh(); } catch (e) { toast.error(friendlyError(e)); } };
  const restore = async (a: ArtifactRow) => { try { await api.post(`/artifacts/${a.id}/restore`); toast.success(`“${a.name}” restored`); refresh(); } catch (e) { toast.error(friendlyError(e)); } };
  const dl = (a: ArtifactRow, v: number | 'latest' = 'latest') => download(`/artifacts/${a.id}/versions/${v}/download`, fileName(a)).catch((e) => toast.error(friendlyError(e)));

  const cols: Column<ArtifactRow>[] = [
    { key: 'name', header: 'File', render: (a) => <span><b>{fileName(a)}</b>{a.name !== fileName(a) && <div className="muted" style={{ fontSize: 11 }}>{a.name}</div>}</span> },
    { key: 'kind', header: 'Type', render: (a) => <span className="badge">{a.kind.replace(/_/g, ' ')}</span> },
    { key: 'size', header: 'Size', align: 'right', render: (a) => fmtBytes(a.latest?.sizeBytes) },
    { key: 'uploadedBy', header: 'Uploaded by', sortable: false, render: (a) => a.latest?.uploadedBy ?? '—' },
    { key: 'uploaded', header: 'Uploaded', render: (a) => <span title={fmtDate(a.latest?.uploadedAt)}>{fmtRelative(a.latest?.uploadedAt)}</span> },
    { key: 'source', header: 'Source', sortable: false, render: (a) => <span className="badge">{a.source ?? '—'}</span> },
    { key: 'run', header: 'Run', render: (a) => <span><Link className="mono" to={`/runs/${a.runKey}`}>{a.runKey}</Link>{a.testName && <div className="muted" style={{ fontSize: 11 }}>{a.testName}</div>}</span> },
    { key: 'version', header: 'Version', sortable: false, align: 'right', render: (a) => <button className="inv-link-btn" onClick={() => setHistory(a)}>v{a.currentVersion}</button> },
    { key: 'sha', header: 'SHA-256', sortable: false, render: (a) => <Sha sha={a.latest?.sha256} /> },
    { key: 'status', header: 'Processing', sortable: false, render: (a) => (a.deletedAt ? <span className="badge fail">DELETED</span> : <StatusBadge value={a.latest?.processingStatus} title={a.latest?.processingError ?? undefined} />) },
    { key: 'act', header: '', sortable: false, render: (a) => (
      <span className="inv-actions">
        {PREVIEW_KINDS.has(a.kind) && !a.deletedAt && <button className="btn btn-ghost icon-btn btn-sm" title="Preview" aria-label={`Preview ${a.name}`} onClick={() => setPreview({ a, version: 'latest' })}><Eye size={14} /></button>}
        <button className="btn btn-ghost icon-btn btn-sm" title="Download" aria-label={`Download ${a.name}`} onClick={() => dl(a)}><Download size={14} /></button>
        {can('UPLOAD_ARTIFACT') && !a.deletedAt && <button className="btn btn-ghost icon-btn btn-sm" title="Replace (upload new version)" aria-label={`Replace ${a.name}`} onClick={() => { setReplaceFor(a); replaceInput.current?.click(); }}><Upload size={14} /></button>}
        <button className="btn btn-ghost icon-btn btn-sm" title="Version history" aria-label={`Versions of ${a.name}`} onClick={() => setHistory(a)}><History size={14} /></button>
        {can('DELETE_ARTIFACT') && (a.deletedAt
          ? <button className="btn btn-ghost icon-btn btn-sm" title="Restore" aria-label={`Restore ${a.name}`} onClick={() => restore(a)}><RotateCcw size={14} /></button>
          : <button className="btn btn-ghost icon-btn btn-sm" title="Delete" aria-label={`Delete ${a.name}`} onClick={() => setDel(a)}><Trash2 size={14} /></button>)}
      </span>) },
  ];
  const filtered = !!(q || kind || projectId || runId || uploadedBy);

  return (
    <div>
      <Toaster />
      <PageHeader title="Artifacts" subtitle="Every file attached to a run — JTL, JMX, HTML reports, logs, screenshots — versioned with SHA-256 checksums."
        actions={can('UPLOAD_ARTIFACT') && <button className="btn btn-primary" onClick={() => setUpload(true)}><UploadCloud size={15} />Upload artifact</button>} />
      <ErrorBox error={error} />
      <div className="card">
        <DataTable rows={data?.items ?? []} columns={cols} rowKey={(a) => a.id} loading={isLoading} exportName="artifacts" maxHeight={680}
          server={{ page, pageSize: 25, total: data?.total ?? 0, sort: sort.key, order: sort.order, onPage: setPage, onSort: (key, order) => { setSort({ key, order }); setPage(1); }, search: qInput, onSearch: setQInput }}
          toolbar={<>
            <select className="select" aria-label="Type" value={kind} onChange={(e) => setParam('kind', e.target.value)} style={{ maxWidth: 170 }}>
              <option value="">All types</option>{ARTIFACT_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
            <select className="select" aria-label="Project" value={projectId} onChange={(e) => setParam('projectId', e.target.value)} style={{ maxWidth: 190 }}>
              <option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="input mono" aria-label="Run ID" placeholder="Run ID" defaultValue={runId} onBlur={(e) => setParam('runId', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && setParam('runId', (e.target as HTMLInputElement).value.trim())} style={{ width: 190 }} />
            <input className="input" aria-label="Uploaded by" placeholder="Uploaded by" defaultValue={uploadedBy} onBlur={(e) => setParam('uploadedBy', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && setParam('uploadedBy', (e.target as HTMLInputElement).value.trim())} style={{ width: 140 }} />
            <label className="row" style={{ gap: 5 }}><input type="checkbox" checked={includeDeleted} onChange={(e) => setParam('deleted', e.target.checked ? '1' : '')} />Include deleted</label>
            <button className="btn btn-ghost icon-btn btn-sm" title="Refresh" aria-label="Refresh" onClick={refresh}><RefreshCw size={14} className={isFetching ? 'spin' : ''} /></button>
          </>}
          empty={<EmptyState icon={<FileArchive size={20} />} title={filtered ? 'No artifacts match these filters' : 'No artifacts yet'}
            action={!filtered && can('UPLOAD_ARTIFACT') && <button className="btn btn-primary" onClick={() => setUpload(true)}><UploadCloud size={14} />Upload artifact</button>}>
            {filtered ? 'Clear a filter or search by file name, Run ID or full SHA-256.' : <>Upload JTL results, the JMX script or the JMeter HTML report (zip) to a run — from here, the run page, or CI via <span className="mono">POST /runs/&lt;RUN_ID&gt;/artifacts</span>.</>}
          </EmptyState>} />
      </div>
      <input ref={replaceInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f && replaceFor) doReplace(replaceFor, f); e.target.value = ''; }} />
      <PreviewModal target={preview} onClose={() => setPreview(null)} />
      <HistoryModal artifact={history} onClose={() => setHistory(null)} onPreview={(a, v) => { setHistory(null); setPreview({ a, version: v }); }} onChanged={refresh} />
      <UploadModal open={upload} onClose={() => setUpload(false)} defaultRun={runId} onDone={refresh} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} title={`Delete “${del?.name ?? ''}”?`} confirmLabel="Delete"
        message="The artifact is soft-deleted: hidden from the run and searches, files retained until a retention purge. You can restore it with “Include deleted”." onConfirm={() => del && remove(del)} />
    </div>
  );
}

function PreviewModal({ target, onClose }: { target: { a: ArtifactRow; version: number | 'latest' } | null; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; text?: string; truncated?: boolean; img?: string; note?: string; error?: unknown }>({ loading: false });
  useEffect(() => {
    if (!target) return;
    let url: string | undefined;
    let alive = true;
    setState({ loading: true });
    api.raw(`/artifacts/${target.a.id}/versions/${target.version}/preview`).then(async (res) => {
      const ct = res.headers.get('content-type') ?? '';
      if (ct.startsWith('image/')) { url = URL.createObjectURL(await res.blob()); if (alive) setState({ loading: false, img: url }); return; }
      const j = await res.json();
      if (!alive) return;
      if (!j.previewable) setState({ loading: false, note: `This file type (${j.mimeType ?? 'unknown'}) cannot be previewed. Download it instead.` });
      else setState({ loading: false, text: j.content, truncated: j.truncated });
    }).catch((e) => alive && setState({ loading: false, error: e }));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [target]);
  return (
    <Modal open={!!target} onClose={onClose} width={980} title={target ? `${fileName(target.a)} · ${target.version === 'latest' ? `v${target.a.currentVersion}` : `v${target.version}`}` : ''}
      footer={target && <><span className="muted" style={{ marginRight: 'auto' }}>{state.truncated ? 'Showing the first 256 KB' : ''}</span>
        <button className="btn" onClick={() => download(`/artifacts/${target.a.id}/versions/${target.version}/download`, fileName(target.a))}><Download size={14} />Download</button></>}>
      {state.loading && <Loading height={300} />}
      <ErrorBox error={state.error} />
      {state.note && <Notice>{state.note}</Notice>}
      {state.img && <img className="inv-preview-img" src={state.img} alt={target ? fileName(target.a) : ''} />}
      {state.text != null && <pre className="inv-preview">{state.text || '(empty file)'}</pre>}
    </Modal>
  );
}

function HistoryModal({ artifact, onClose, onPreview, onChanged }: { artifact: ArtifactRow | null; onClose: () => void; onPreview: (a: ArtifactRow, v: number) => void; onChanged: () => void }) {
  const can = useCan();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['inv', 'artifact', artifact?.id], enabled: !!artifact, queryFn: () => api.get<ArtifactRow & { versions: ArtifactVersion[] }>(`/artifacts/${artifact!.id}`) });
  const reprocess = async (v: number) => {
    try { await api.post(`/artifacts/${artifact!.id}/versions/${v}/reprocess`); toast.success(`Version ${v} queued for processing`); refetch(); onChanged(); } catch (e) { toast.error(friendlyError(e)); }
  };
  return (
    <Modal open={!!artifact} onClose={onClose} width={900} title={artifact ? <>Version history · {artifact.name}</> : ''}>
      {isLoading && <Loading height={160} />}
      <ErrorBox error={error} />
      {data && (
        <div className="table-wrap card"><table className="table"><thead><tr><th>Version</th><th>File</th><th className="r">Size</th><th>Uploaded</th><th>By</th><th>SHA-256</th><th>Processing</th><th /></tr></thead>
          <tbody>{data.versions.map((v) => (
            <tr key={v.id}>
              <td><span className="row" style={{ gap: 6 }}><b>v{v.version}</b>{v.version === data.currentVersion && <span className="badge pass">CURRENT</span>}</span></td>
              <td>{v.originalFilename}</td><td className="r num">{fmtBytes(v.sizeBytes)}</td><td>{fmtDate(v.uploadedAt)}</td><td>{v.uploadedBy ?? '—'}</td><td><Sha sha={v.sha256} /></td>
              <td><StatusBadge value={v.processingStatus} title={v.processingError ?? undefined} />{v.processingError && <div className="muted" style={{ fontSize: 11, maxWidth: 200, whiteSpace: 'normal' }}>{v.processingError}</div>}</td>
              <td className="r"><span className="inv-actions">
                {PREVIEW_KINDS.has(data.kind) && <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Preview v${v.version}`} onClick={() => onPreview(data, v.version)}><Eye size={14} /></button>}
                <button className="btn btn-ghost icon-btn btn-sm" aria-label={`Download v${v.version}`} onClick={() => download(`/artifacts/${data.id}/versions/${v.version}/download`, v.originalFilename)}><Download size={14} /></button>
                {can('UPLOAD_ARTIFACT') && <button className="btn btn-ghost icon-btn btn-sm" title="Re-process" aria-label={`Reprocess v${v.version}`} onClick={() => reprocess(v.version)}><RefreshCw size={14} /></button>}
              </span></td>
            </tr>
          ))}</tbody></table></div>
      )}
    </Modal>
  );
}

function UploadModal({ open, onClose, defaultRun, onDone }: { open: boolean; onClose: () => void; defaultRun?: string; onDone: () => void }) {
  const [run, setRun] = useState(defaultRun ?? '');
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const recent = useRuns({ pageSize: 30, sort: 'start', order: 'desc' }, open);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setRun(defaultRun ?? ''); setKind(''); setName(''); setDescription(''); setFile(null); setErrors({}); setFormError(null); } }, [open, defaultRun]);
  const submit = async () => {
    const er: Record<string, string> = {};
    if (!run.trim()) er.run = 'Choose the run this file belongs to';
    if (!file) er.file = 'Select a file';
    setErrors(er);
    if (Object.keys(er).length || !file) return;
    const fd = new FormData();
    if (kind) fd.append('kind', kind);
    if (name.trim()) fd.append('name', name.trim());
    if (description.trim()) fd.append('description', description.trim());
    fd.append('file', file);
    setBusy(true); setFormError(null);
    try {
      const res = await api.post<{ duplicate: boolean; message: string }>(`/runs/${encodeURIComponent(run.trim())}/artifacts`, fd);
      toast[res.duplicate ? 'info' : 'success'](`${file.name}: ${res.message}`);
      onDone(); onClose();
    } catch (e) { setFormError(friendlyError(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} width={560} title="Upload artifact"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}><UploadCloud size={14} />{busy ? 'Uploading…' : 'Upload'}</button></>}>
      <div className="stack">
        {formError && <div className="error-box">{formError}</div>}
        <FormField label="Run" required error={errors.run} htmlFor="up-run" hint="Run ID (PF-…) — pick a recent run or paste one">
          <input id="up-run" className="input mono" list="up-runs" value={run} onChange={(e) => setRun(e.target.value)} placeholder="PF-2026-10-06-000127" />
          <datalist id="up-runs">{recent.data?.items.map((r) => <option key={r.id} value={r.runId}>{r.testName} · {r.status}</option>)}</datalist>
        </FormField>
        <div className="inv-form-grid">
          <FormField label="Type" htmlFor="up-kind" hint="Auto-detected from the extension when empty">
            <select id="up-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Auto-detect</option>{ARTIFACT_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}</select>
          </FormField>
          <FormField label="Name" htmlFor="up-name" hint="Same type + name creates a new version"><input id="up-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the file name" /></FormField>
          <FormField label="Description" htmlFor="up-desc" span={2}><input id="up-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></FormField>
        </div>
        <FormField label="File" required error={errors.file}>
          <div className={`inv-dropzone ${over ? 'over' : ''}`} role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}>
            <UploadCloud size={22} />
            <div>{file ? <><b>{file.name}</b> · {fmtBytes(file.size)}</> : 'Drop a file here or click to browse'}</div>
            <div style={{ fontSize: 11 }}>HTML reports: upload the JMeter report folder as .zip. Executables are rejected.</div>
          </div>
          <input ref={input} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </FormField>
      </div>
    </Modal>
  );
}
