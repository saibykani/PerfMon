import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileJson, FileSpreadsheet, FileText, Globe, Loader2, Table2 } from 'lucide-react';
import { api, download } from '@/services/api';
import { Modal, Field } from '@/components/ui';
import { RunSearch, RunChips, Segmented, type RunLite } from '@/components/analysis/shared';
import { useProjects } from '@/components/inventory/data';
import { toast, friendlyError } from '@/components/inventory/common';
import { useFilters } from '@/stores/filters';
import '@/styles/reports.css';

/* ------------------------------------------------------------------ types */

export type ReportType = 'TEST_EXECUTION' | 'COMPARISON' | 'EXECUTIVE' | string;
export type ReportStatus = 'QUEUED' | 'GENERATING' | 'READY' | 'FAILED';

export interface ReportRow {
  id: string; type: ReportType; title: string; version: number; status: ReportStatus; error: string | null;
  runId: string | null; runKey: string | null; runKeys: string[]; projectId: string; projectName: string;
  createdBy: string | null; createdAt: string; updatedAt: string; auto: boolean;
  params: { from?: string; to?: string; runIds?: string[]; runKeys?: string[]; testId?: string | null; environmentId?: string | null };
}
export interface ReportList { items: ReportRow[]; total: number; page: number; pageSize: number; totalPages: number }
export interface ReportSection { id: string; title: string; kind: string; data: unknown; note?: string }
export interface ReportContent {
  title: string; type: string; generatedAt: string; version: number; audience: string;
  subject: { runKey?: string; runKeys?: string[]; testName?: string; projectName?: string; environment?: string; build?: string; from?: string; to?: string };
  result?: { status: string; score: number | null; breakdown: Record<string, string>; reasons?: string[] };
  sections: ReportSection[];
}
export interface ReportDetail extends ReportRow { content: ReportContent | null }

export const REPORT_TYPES: { key: 'TEST_EXECUTION' | 'COMPARISON' | 'EXECUTIVE'; label: string; hint: string }[] = [
  { key: 'TEST_EXECUTION', label: 'Test execution', hint: 'One run: identity, result & score, KPIs vs baseline, SLA, transactions, errors, regressions, bottlenecks, infrastructure.' },
  { key: 'COMPARISON', label: 'Comparison', hint: '2–6 runs side by side. The first run is the reference for change %.' },
  { key: 'EXECUTIVE', label: 'Executive summary', hint: 'A project over a time window: pass rate, SLA compliance, trends, regressions and slowest transactions.' },
];
export const typeLabel = (t: string) => REPORT_TYPES.find((x) => x.key === t)?.label ?? t.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const isPending = (s?: string | null) => s === 'QUEUED' || s === 'GENERATING';

/* ------------------------------------------------------------------ status */

const STATUS_META: Record<string, { label: string; cls: string }> = {
  QUEUED: { label: 'Pending', cls: '' }, GENERATING: { label: 'Generating', cls: 'info' }, READY: { label: 'Ready', cls: 'pass' }, FAILED: { label: 'Failed', cls: 'fail' },
};
export function ReportStatusBadge({ status, error }: { status: string; error?: string | null }) {
  const m = STATUS_META[status] ?? { label: status, cls: '' };
  return (
    <span className={`badge ${m.cls} rp-status`} title={error ?? undefined}>
      {isPending(status) && <Loader2 size={11} className="spin" aria-hidden />}{m.label}
    </span>
  );
}

/* ------------------------------------------------------------------ downloads */

export const FORMATS: { key: 'pdf' | 'html' | 'xlsx' | 'csv' | 'json'; label: string; icon: ReactNode }[] = [
  { key: 'pdf', label: 'PDF', icon: <FileText size={13} /> },
  { key: 'html', label: 'HTML', icon: <Globe size={13} /> },
  { key: 'xlsx', label: 'Excel', icon: <FileSpreadsheet size={13} /> },
  { key: 'csv', label: 'CSV', icon: <Table2 size={13} /> },
  { key: 'json', label: 'JSON', icon: <FileJson size={13} /> },
];

export function downloadReport(r: Pick<ReportRow, 'id' | 'runKey' | 'type' | 'version'>, format: string) {
  const name = `${r.runKey ? r.runKey + '-' : ''}${r.type.toLowerCase().replace(/_/g, '-')}-v${r.version}.${format}`;
  return download(`/reports/${r.id}/export?format=${format}`, name).catch((e) => toast.error(friendlyError(e)));
}

/** Compact per-format download buttons (table rows) or labelled buttons (report page). */
export function DownloadButtons({ report, compact, disabled }: { report: Pick<ReportRow, 'id' | 'runKey' | 'type' | 'version' | 'status'>; compact?: boolean; disabled?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const off = disabled || report.status !== 'READY';
  const go = async (f: string) => { setBusy(f); try { await downloadReport(report, f); } finally { setBusy(null); } };
  return (
    <span className={`rp-downloads ${compact ? 'compact' : ''}`} role="group" aria-label="Download report">
      {!compact && <Download size={14} className="muted" aria-hidden />}
      {FORMATS.map((f) => (
        <button key={f.key} className={`btn btn-sm ${compact ? 'btn-ghost rp-fmt' : ''}`} disabled={off || !!busy} onClick={(e) => { e.stopPropagation(); go(f.key); }}
          title={off ? 'Available when the report is ready' : `Download ${f.label}`} aria-label={`Download ${f.label}`}>
          {busy === f.key ? <Loader2 size={13} className="spin" /> : !compact && f.icon}{f.label}
        </button>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ new report */

const RANGES = [{ key: '7', label: '7 days' }, { key: '30', label: '30 days' }, { key: '90', label: '90 days' }, { key: 'custom', label: 'Custom' }] as const;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function NewReportDialog({ open, onClose, initialRun, initialType = 'TEST_EXECUTION' }: { open: boolean; onClose: () => void; initialRun?: RunLite | null; initialType?: 'TEST_EXECUTION' | 'COMPARISON' | 'EXECUTIVE' }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const filters = useFilters();
  const projects = useProjects();
  const [type, setType] = useState<'TEST_EXECUTION' | 'COMPARISON' | 'EXECUTIVE'>(initialType);
  const [run, setRun] = useState<RunLite | null>(initialRun ?? null);
  const [runs, setRuns] = useState<RunLite[]>(initialRun ? [initialRun] : []);
  const [projectId, setProjectId] = useState<string>(filters.projectId ?? '');
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('30');
  const [from, setFrom] = useState(day(new Date(Date.now() - 30 * 86400e3)));
  const [to, setTo] = useState(day(new Date()));
  const [title, setTitle] = useState('');
  const effProject = projectId || projects.data?.[0]?.id || '';

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { type, title: title.trim() || undefined };
      if (type === 'TEST_EXECUTION') Object.assign(body, { runId: run!.runId, projectId: run!.projectId });
      if (type === 'COMPARISON') body.runIds = runs.map((r) => r.runId);
      if (type === 'EXECUTIVE') {
        const t = range === 'custom' ? new Date(`${to}T23:59:59`) : new Date();
        const f = range === 'custom' ? new Date(`${from}T00:00:00`) : new Date(t.getTime() - Number(range) * 86400e3);
        Object.assign(body, { projectId: effProject, params: { from: f.toISOString(), to: t.toISOString() } });
      }
      return api.post<{ id: string; version: number }>('/reports', body);
    },
    onSuccess: (r) => {
      toast.success('Report queued — it will be ready in a few seconds');
      qc.invalidateQueries({ queryKey: ['reports'] });
      onClose();
      nav(`/reports/${r.id}`);
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const valid = type === 'TEST_EXECUTION' ? !!run : type === 'COMPARISON' ? runs.length >= 2 && runs.length <= 6 : !!effProject && (range !== 'custom' || (!!from && !!to && from <= to));
  const hint = REPORT_TYPES.find((t) => t.key === type)?.hint;

  return (
    <Modal open={open} onClose={onClose} title="New report" width={620}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending && <Loader2 size={14} className="spin" />}Generate report
        </button>
      </>}>
      <div className="stack rp-new">
        <Field label="Report type">
          <Segmented label="Report type" value={type} onChange={setType} options={REPORT_TYPES.map((t) => ({ key: t.key, label: t.label }))} />
        </Field>
        {hint && <div className="muted small">{hint}</div>}

        {type === 'TEST_EXECUTION' && (
          <Field label="Run" hint="Only finished runs can be reported (completed, failed or aborted).">
            {run
              ? <div className="rp-picked"><span className="mono">{run.runId}</span><span className="muted">{run.testName}{run.environmentName ? ` · ${run.environmentName}` : ''}{run.buildNumber ? ` · build ${run.buildNumber}` : ''}</span><button className="btn btn-sm btn-ghost" onClick={() => setRun(null)}>Change</button></div>
              : <RunSearch onPick={setRun} autoFocus />}
          </Field>
        )}

        {type === 'COMPARISON' && (
          <Field label={`Runs (${runs.length}/6)`} hint="Add 2–6 runs. Run A is the reference.">
            <div className="stack" style={{ gap: 8 }}>
              {runs.length > 0 && <RunChips runs={runs.map((r) => r.runId)} onRemove={(k) => setRuns((rs) => rs.filter((r) => r.runId !== k))}
                onMakeRef={(k) => setRuns((rs) => [rs.find((r) => r.runId === k)!, ...rs.filter((r) => r.runId !== k)])} />}
              {runs.length < 6 && <RunSearch onPick={(r) => setRuns((rs) => (rs.some((x) => x.runId === r.runId) ? rs : [...rs, r]))} exclude={runs.map((r) => r.runId)} placeholder="Add a run…" />}
            </div>
          </Field>
        )}

        {type === 'EXECUTIVE' && (
          <>
            <Field label="Project">
              <select className="select" value={effProject} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Period">
              <div className="row wrap" style={{ gap: 8 }}>
                <Segmented label="Period" value={range} onChange={setRange} options={RANGES.map((r) => ({ key: r.key, label: r.label }))} />
                {range === 'custom' && <>
                  <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                  <span className="muted">to</span>
                  <input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
                </>}
              </div>
            </Field>
          </>
        )}

        <Field label="Title (optional)" hint="Defaults to the report type and subject.">
          <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Release 4.2 sign-off" />
        </Field>
      </div>
    </Modal>
  );
}
