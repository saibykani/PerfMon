import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EChartsOption } from 'echarts';
import {
  GitCompare, Save, Download, FileText, History, Trash2, Info, Sparkles, ListOrdered, Target, ArrowRightLeft, BookmarkCheck,
} from 'lucide-react';
import { api, ApiError } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { useFilters } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, ConfirmDialog, Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { fmtDate, fmtNum } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { seriesColor } from '@/charts/palette';
import { unitFormatter } from '@/charts/builders';
import {
  ChangeChip, PercentileMethodNote, RunChips, RunLetter, RunSearch, RUN_LETTERS, SlaStatus, downloadCsv, errMsg, fmtUnit, heatClass, pctChange,
  useToast, verdictOf, type Better, type RunLite, type Verdict,
} from '@/components/analysis/shared';

/* ------------------------------------------------------------------ API types (analytics/compare.ts) */

interface CmpRun {
  id: string; run_key: string; status: string; result: string | null; performance_score: number | null; build_number: string | null; version: string | null;
  started_at: string | null; ended_at: string | null; virtual_users: number | null; test_name: string; environment_name: string;
  summarySource: string | null; percentileMethod: string | null;
}
interface CmpMetric { key: string; label: string; unit: string; better: Better; values: (number | null)[]; changes: (number | null)[]; verdicts: Verdict[] }
interface CmpTxn { name: string; samples: (number | null)[]; tps: (number | null)[]; avg: (number | null)[]; p95: (number | null)[]; p99: (number | null)[]; errorPct: (number | null)[]; p95Change: (number | null)[] }
interface CmpEndpoint { endpoint: string; samples: (number | null)[]; avg: (number | null)[]; errorPct: (number | null)[]; avgChange: (number | null)[] }
interface Comparison { runs: CmpRun[]; metrics: CmpMetric[]; transactions: CmpTxn[]; endpoints: CmpEndpoint[]; sla: Record<string, number>[] }
interface Saved { id: string; name: string; projectId: string; runIds: string[]; runKeys: string[]; createdBy: string | null; createdById: string | null; createdAt: string }

/* ------------------------------------------------------------------ metric families */

const FAMILIES: { key: string; label: string; metrics: string[]; chart?: { metrics: string[]; unit: string; title: string } }[] = [
  { key: 'thr', label: 'Throughput & load', metrics: ['tps', 'tps_peak', 'total_samples', 'users_peak', 'received_kb_sec'], chart: { metrics: ['tps', 'tps_peak'], unit: 'tps', title: 'Throughput' } },
  { key: 'rt', label: 'Response time', metrics: ['avg_rt', 'p50', 'p90', 'p95', 'p99', 'max_rt'], chart: { metrics: ['avg_rt', 'p50', 'p90', 'p95', 'p99'], unit: 'ms', title: 'Response time' } },
  { key: 'q', label: 'Errors, SLA & score', metrics: ['error_pct', 'sla_pass_pct', 'performance_score'], chart: { metrics: ['error_pct'], unit: '%', title: 'Error rate' } },
  { key: 'infra', label: 'Infrastructure', metrics: ['cpu_avg', 'cpu_max', 'mem_max', 'net_avg_bps'], chart: { metrics: ['cpu_avg', 'cpu_max', 'mem_max'], unit: '%', title: 'CPU & memory utilization' } },
  { key: 'jvm', label: 'JVM & database', metrics: ['heap_pct_max', 'gc_pause_max', 'db_latency_avg', 'db_active_max'], chart: { metrics: ['gc_pause_max', 'db_latency_avg'], unit: 'ms', title: 'GC pause & DB latency' } },
];
const SCORE_CHART = { metrics: ['sla_pass_pct', 'performance_score'], unit: '', title: 'SLA pass % & performance score (0–100)' };
const PERCENTILE_KEYS = new Set(['p50', 'p90', 'p95', 'p99']);

const TXN_METRICS = [
  { key: 'p95', label: 'P95', unit: 'ms', better: 'lower' as Better },
  { key: 'p99', label: 'P99', unit: 'ms', better: 'lower' as Better },
  { key: 'avg', label: 'Avg RT', unit: 'ms', better: 'lower' as Better },
  { key: 'tps', label: 'TPS', unit: 'tps', better: 'higher' as Better },
  { key: 'errorPct', label: 'Error %', unit: '%', better: 'lower' as Better },
  { key: 'samples', label: 'Samples', unit: '', better: 'neutral' as Better },
];
const EP_METRICS = [
  { key: 'avg', label: 'Avg RT', unit: 'ms', better: 'lower' as Better },
  { key: 'errorPct', label: 'Error %', unit: '%', better: 'lower' as Better },
  { key: 'samples', label: 'Samples', unit: '', better: 'neutral' as Better },
];

/* ------------------------------------------------------------------ page */

export function ComparePage() {
  const [sp, setSp] = useSearchParams();
  const runs = useMemo(() => (sp.get('runs') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6), [sp]);
  const setRuns = (next: string[]) => {
    const n = new URLSearchParams(sp);
    if (next.length) n.set('runs', [...new Set(next)].slice(0, 6).join(',')); else n.delete('runs');
    setSp(n, { replace: false });
  };
  const can = useAuth((s) => s.can);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [toast, showToast] = useToast();
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [delSaved, setDelSaved] = useState<Saved | null>(null);

  const cmp = useQuery({
    queryKey: ['compare', runs],
    enabled: runs.length >= 2,
    queryFn: async () => {
      try {
        return await api.post<Comparison>('/compare', { runIds: runs });
      } catch (e) {
        // Backwards-compatible fallback for 2 runs on backends without POST /compare.
        if (e instanceof ApiError && e.status === 404 && runs.length === 2 && e.message.startsWith('Route')) {
          const r = await api.get<Comparison & { available: boolean; reason?: string }>(`/runs/${encodeURIComponent(runs[1])}/comparison`, { with: runs[0] });
          if (!r.available) throw new Error(r.reason ?? 'Comparison unavailable');
          return r;
        }
        throw e;
      }
    },
  });

  const saved = useQuery({ queryKey: ['comparisons'], queryFn: () => api.get<Saved[]>('/comparisons'), retry: false });
  const save = useMutation({
    mutationFn: () => api.post<Saved>('/comparisons', { name: saveName.trim(), runIds: runs }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['comparisons'] }); setSaveOpen(false); showToast('Comparison saved'); },
    onError: (e) => showToast(`Could not save: ${errMsg(e)}`, true),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/comparisons/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['comparisons'] }); showToast('Saved comparison deleted'); },
    onError: (e) => showToast(errMsg(e), true),
  });
  const report = useMutation({
    mutationFn: () => api.post<{ id: string; status: string }>('/reports', { type: 'COMPARISON', runIds: cmp.data?.runs.map((r) => r.id) ?? runs, title: `Run comparison — ${runs.join(' vs ')}` }),
    onSuccess: (r) => nav(`/reports/${r.id}`),
    onError: (e) => showToast(`Report generation failed: ${errMsg(e)}`, true),
  });

  const data = cmp.data;
  const canSave = can('EXECUTE_TEST') || can('CREATE_DASHBOARD') || can('EXPORT_REPORT');

  const exportCsv = () => {
    if (!data) return;
    const rs = data.runs;
    const rows: (string | number | null)[][] = [['Metric', 'Unit', ...rs.flatMap((r, i) => (i === 0 ? [`${RUN_LETTERS[i]} ${r.run_key}`] : [`${RUN_LETTERS[i]} ${r.run_key}`, `${RUN_LETTERS[i]} change %`, `${RUN_LETTERS[i]} verdict`]))]];
    for (const m of data.metrics) rows.push([m.label, m.unit, ...m.values.flatMap((v, i) => (i === 0 ? [v] : [v, m.changes[i] == null ? null : +m.changes[i]!.toFixed(2), m.verdicts[i]]))]);
    rows.push([]);
    rows.push(['Transaction', 'Metric', ...rs.map((r, i) => `${RUN_LETTERS[i]} ${r.run_key}`)]);
    for (const t of data.transactions) for (const k of ['p95', 'p99', 'avg', 'tps', 'errorPct', 'samples'] as const) rows.push([t.name, k, ...t[k]]);
    if (data.endpoints.length) {
      rows.push([]);
      rows.push(['Endpoint', 'Metric', ...rs.map((r, i) => `${RUN_LETTERS[i]} ${r.run_key}`)]);
      for (const e of data.endpoints) for (const k of ['avg', 'errorPct', 'samples'] as const) rows.push([e.endpoint, k, ...e[k]]);
    }
    downloadCsv(`perfmon-comparison-${rs.map((r) => r.run_key).join('_vs_')}`, rows);
  };

  return (
    <div className="an-page">
      <PageHeader
        title="Compare Runs"
        subtitle="Side-by-side comparison of 2–6 runs. Run A is the reference: every change % is measured against it."
        actions={data && <>
          <button className="btn" onClick={exportCsv}><Download size={14} />Export CSV</button>
          {canSave && <button className="btn" onClick={() => { setSaveName(defaultName(data)); setSaveOpen(true); }}><Save size={14} />Save comparison</button>}
          {can('EXPORT_REPORT') && <button className="btn btn-primary" disabled={report.isPending} onClick={() => report.mutate()}><FileText size={14} />{report.isPending ? 'Queuing…' : 'Generate report'}</button>}
        </>}
      />

      <Selection runs={runs} setRuns={setRuns} saved={saved.data} savedLoading={saved.isLoading} savedError={saved.error} onDelete={setDelSaved} cmpRuns={data?.runs} />

      {runs.length < 2 && <IntroHero count={runs.length} />}
      {runs.length >= 2 && cmp.isLoading && <><Loading height={90} /><Loading height={320} /></>}
      {cmp.error && <ErrorBox error={cmp.error} />}
      {data && <ComparisonView data={data} />}

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save comparison" width={460}
        footer={<><button className="btn" onClick={() => setSaveOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!saveName.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button></>}>
        <div className="stack">
          <Field label="Name"><input className="input" autoFocus value={saveName} maxLength={200} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName.trim() && save.mutate()} /></Field>
          <div className="an-chips">{runs.map((k, i) => <span key={k} className="an-runchip"><RunLetter i={i} /><span className="mono">{k}</span></span>)}</div>
          <span className="muted">Saved comparisons are shared with everyone in the project and can be reopened from this page.</span>
        </div>
      </Modal>
      <ConfirmDialog open={!!delSaved} title="Delete saved comparison" message={<>Delete <b>{delSaved?.name}</b>? The runs themselves are not affected.</>}
        onConfirm={() => delSaved && del.mutate(delSaved.id)} onClose={() => setDelSaved(null)} />
      {toast}
    </div>
  );
}

const defaultName = (d: Comparison) => {
  const tests = [...new Set(d.runs.map((r) => r.test_name))];
  const builds = d.runs.map((r) => r.build_number ? `#${r.build_number}` : r.run_key.slice(-6));
  return `${tests.join(' / ')} — ${builds.join(' vs ')}`.slice(0, 200);
};

/* ------------------------------------------------------------------ selection */

function Selection({ runs, setRuns, saved, savedLoading, savedError, onDelete, cmpRuns }: {
  runs: string[]; setRuns: (r: string[]) => void; saved?: Saved[]; savedLoading: boolean; savedError: unknown; onDelete: (s: Saved) => void; cmpRuns?: CmpRun[];
}) {
  const projectId = useFilters((s) => s.projectId);
  const user = useAuth((s) => s.user);
  const [testId, setTestId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tests = useQuery({ queryKey: ['tests', { projectId }], queryFn: () => api.get<any[]>('/tests', { projectId }), staleTime: 60000 });

  const lastN = async (n: number) => {
    setErr(null); setBusy(`last${n}`);
    try {
      const r = await api.get<{ items: RunLite[] }>('/runs', { testId, status: 'COMPLETED', pageSize: n, sort: 'start', order: 'desc' });
      if (r.items.length < 2) setErr('This test has fewer than 2 completed runs.');
      else setRuns(r.items.map((x) => x.runId).reverse()); // oldest first → Run A = older run
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  const vsBaseline = async () => {
    setErr(null); setBusy('base');
    try {
      let cand = runs[runs.length - 1];
      if (!cand && testId) {
        const r = await api.get<{ items: RunLite[] }>('/runs', { testId, status: 'COMPLETED', pageSize: 1, sort: 'start', order: 'desc' });
        cand = r.items[0]?.runId;
      }
      if (!cand) { setErr('Select a run (or a test) first.'); return; }
      const c = await api.get<{ available: boolean; reason?: string; baseline?: { runKey: string } }>(`/runs/${encodeURIComponent(cand)}/comparison`);
      if (!c.available || !c.baseline) setErr(c.reason ?? `No baseline found for ${cand}.`);
      else if (c.baseline.runKey === cand) setErr(`${cand} is its own baseline.`);
      else setRuns([c.baseline.runKey, cand]);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  const meta = Object.fromEntries((cmpRuns ?? []).map((r) => [r.run_key, <span key={r.run_key} className="muted" style={{ fontSize: 11 }}>{r.test_name}{r.build_number ? ` · #${r.build_number}` : ''}</span>]));
  return (
    <Card>
      <div className="an-side" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px' }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row wrap">
            <RunSearch onPick={(r) => runs.length < 6 && setRuns([...runs, r.runId])} exclude={runs} disabled={runs.length >= 6}
              placeholder={runs.length >= 6 ? 'Maximum of 6 runs' : runs.length ? 'Add another run…' : 'Search runs to compare (Run ID, test, build, branch)…'} />
            {runs.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setRuns([])}>Clear</button>}
            <span className="muted">{runs.length}/6 selected</span>
          </div>
          {runs.length > 0 && <RunChips runs={runs} meta={meta} onRemove={(k) => setRuns(runs.filter((x) => x !== k))} onMakeRef={(k) => setRuns([k, ...runs.filter((x) => x !== k)])} />}
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="an-section-title" style={{ marginRight: 4 }}>Shortcuts</span>
            <select className="select" value={testId} onChange={(e) => setTestId(e.target.value)} aria-label="Test for shortcuts" style={{ maxWidth: 240 }}>
              <option value="">Choose a test…</option>
              {tests.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="btn btn-sm" disabled={!testId || !!busy} onClick={() => lastN(2)}><ListOrdered size={13} />{busy === 'last2' ? 'Loading…' : 'Last 2 runs of test'}</button>
            <button className="btn btn-sm" disabled={!testId || !!busy} onClick={() => lastN(6)}>Last 6 runs</button>
            <button className="btn btn-sm" disabled={(!runs.length && !testId) || !!busy} onClick={vsBaseline} title="Compare the last selected run (or the latest run of the chosen test) with its baseline"><Target size={13} />{busy === 'base' ? 'Resolving…' : 'vs baseline'}</button>
            {runs.length >= 2 && <button className="btn btn-sm btn-ghost" onClick={() => setRuns([...runs].reverse())} title="Reverse order"><ArrowRightLeft size={13} />Reverse</button>}
          </div>
          {err && <div className="an-note warn" role="alert"><Info size={14} />{err}</div>}
        </div>
        <div>
          <div className="row" style={{ marginBottom: 6 }}><History size={13} className="muted" /><span className="an-section-title">Saved comparisons</span><div className="spacer" /><span className="muted">{saved?.length ?? ''}</span></div>
          <div className="card" style={{ maxHeight: 176, overflow: 'auto', boxShadow: 'none' }}>
            {savedLoading && <div style={{ padding: 8 }}><Loading height={40} /></div>}
            {!!savedError && <div className="an-search-empty">Saved comparisons unavailable</div>}
            {saved && !saved.length && <div className="an-search-empty">None yet — select runs and choose “Save comparison”.</div>}
            <div className="an-list">
              {saved?.map((s) => (
                <div key={s.id} className="an-list-item">
                  <BookmarkCheck size={14} className="muted" />
                  <Link to={`/compare?runs=${(s.runKeys.length ? s.runKeys : s.runIds).join(',')}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
                    <div className="title">{s.name}</div>
                    <div className="sub mono">{s.runKeys.join(' · ')}</div>
                    <div className="sub">{s.createdBy ?? 'API'} · {fmtDate(s.createdAt)}</div>
                  </Link>
                  {(s.createdById === user?.id || useAuth.getState().can('MANAGE_PROJECT')) &&
                    <button className="btn btn-ghost icon-btn btn-sm an-mini" aria-label={`Delete ${s.name}`} onClick={() => onDelete(s)}><Trash2 size={12} /></button>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function IntroHero({ count }: { count: number }) {
  return (
    <Card>
      <div className="an-empty-hero">
        <div className="icon"><GitCompare size={22} /></div>
        <h3>{count === 1 ? 'Add at least one more run' : 'Pick the runs you want to compare'}</h3>
        <p>Search by Run ID, test name, build, branch or tag — or use a shortcut such as <b>Last 2 runs of test</b> or <b>vs baseline</b>.
          The first run (A) is the reference; later runs show change % with a better/worse verdict for each metric, transaction and endpoint.</p>
        <p className="muted" style={{ fontSize: 12 }}>Tip: comparisons are shareable — the URL contains the Run IDs (<span className="mono">/compare?runs=PF-…,PF-…</span>).</p>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ comparison view */

function ComparisonView({ data }: { data: Comparison }) {
  const theme = useUi((s) => s.theme);
  const byKey = useMemo(() => new Map(data.metrics.map((m) => [m.key, m])), [data.metrics]);
  const methods = data.runs.map((r) => r.percentileMethod);
  const approxRuns = data.runs.map((r, i) => ({ r, i })).filter((x) => x.r.percentileMethod === 'interval_weighted_approx');
  const mixed = new Set(methods.filter(Boolean)).size > 1;
  const tests = new Set(data.runs.map((r) => r.test_name));
  const envs = new Set(data.runs.map((r) => r.environment_name));

  const families = FAMILIES.map((f) => ({ ...f, rows: f.metrics.map((k) => byKey.get(k)).filter(Boolean) as CmpMetric[] })).filter((f) => f.rows.length);
  const known = new Set(FAMILIES.flatMap((f) => f.metrics));
  const other = data.metrics.filter((m) => !known.has(m.key));
  if (other.length) families.push({ key: 'other', label: 'Other', metrics: other.map((m) => m.key), rows: other });

  const charts = [...FAMILIES.map((f) => f.chart!).filter(Boolean), SCORE_CHART]
    .map((c) => ({ ...c, rows: c.metrics.map((k) => byKey.get(k)).filter((m): m is CmpMetric => !!m && m.values.some((v) => v != null)) }))
    .filter((c) => c.rows.length);

  return (
    <>
      {(tests.size > 1 || envs.size > 1) && (
        <div className="an-note warn"><Info size={14} />
          <span>These runs span {tests.size > 1 ? `${tests.size} different tests` : ''}{tests.size > 1 && envs.size > 1 ? ' and ' : ''}{envs.size > 1 ? `${envs.size} environments` : ''}. Differences may reflect workload or environment rather than code changes.</span>
        </div>
      )}

      <VerdictSummary data={data} />

      <Card title="Run comparison" noPad actions={<HeatLegend />}>
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="table an-cmp">
            <thead>
              <tr>
                <th className="an-sticky-col">Metric</th>
                {data.runs.map((r, i) => <th key={r.id} className="r run"><RunHead r={r} i={i} /></th>)}
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <FamilyRows key={f.key} label={f.label} rows={f.rows} runs={data.runs} methods={methods} />
              ))}
              <tr className="grp"><td colSpan={data.runs.length + 1}>Percentile method</td></tr>
              <tr>
                <td className="an-sticky-col metric">Calculation<span className="muted">source</span></td>
                {data.runs.map((r) => <td key={r.id} className="r"><div className="an-cell"><span className="muted" style={{ fontSize: 11 }}>{r.summarySource ?? '—'}</span><PercentileMethodNote method={r.percentileMethod} /></div></td>)}
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}><Info size={13} className="muted" style={{ marginTop: 2 }} />
              <span className="muted" style={{ fontSize: 12 }}>
                Verdicts: <b>better</b>/<b>worse</b> when the change exceeds ±2% in the metric’s good/bad direction; volume metrics (requests, users, network) are neutral.
                Exact percentiles are merged from latency histograms built from raw samples (≈2.5% bucket resolution). Percentiles marked <b>≈</b> come from JMeter Backend Listener interval reports and are approximations.
              </span>
            </div>
            {approxRuns.length > 0 && <div className="an-note warn"><Info size={14} /><span>Approximate percentiles in {approxRuns.map((x) => `${RUN_LETTERS[x.i]} (${x.r.run_key})`).join(', ')}. Upload the JTL (raw samples) for exact percentiles.{mixed ? ' Runs use different percentile methods — treat small P50–P99 differences with caution.' : ''}</span></div>}
          </div>
        </div>
      </Card>

      {charts.length > 0 && (
        <div className="an-grid-2">
          {charts.map((c) => <Chart key={c.title} title={c.title} subtitle={c.unit === 'ms' ? 'lower is better' : undefined} height={250} option={groupedBar(theme, data.runs, c.rows, c.unit)}
            table={{ columns: ['Metric', ...data.runs.map((r, i) => `${RUN_LETTERS[i]} ${r.run_key}`)], rows: c.rows.map((m) => [m.label, ...m.values.map((v) => (v == null ? null : +v.toFixed(2)))]) }} />)}
        </div>
      )}

      <EntityTable kind="transactions" runs={data.runs} methods={methods}
        rows={data.transactions.map((t) => ({ name: t.name, values: t as unknown as Record<string, (number | null)[]> }))} metrics={TXN_METRICS} />
      <EntityTable kind="endpoints" runs={data.runs} methods={methods}
        rows={data.endpoints.map((e) => ({ name: e.endpoint, values: e as unknown as Record<string, (number | null)[]> }))} metrics={EP_METRICS} />

      <SlaComparison data={data} slaPct={byKey.get('sla_pass_pct')} />
    </>
  );
}

function RunHead({ r, i }: { r: CmpRun; i: number }) {
  return (
    <div className="an-runhead">
      <span className="t"><RunLetter i={i} /><Link to={`/runs/${r.run_key}`} className="mono" onClick={(e) => e.stopPropagation()}>{r.run_key}</Link></span>
      <span className="s" title={`${r.test_name} · ${r.environment_name}`}>{r.test_name} · {r.environment_name}</span>
      <span className="t" style={{ fontWeight: 400 }}>{r.build_number && <span className="pf-tag">#{r.build_number}</span>}<StatusBadge value={r.result ?? r.status} /></span>
      <span className="s">{fmtDate(r.started_at)}</span>
    </div>
  );
}

function FamilyRows({ label, rows, runs, methods }: { label: string; rows: CmpMetric[]; runs: CmpRun[]; methods: (string | null)[] }) {
  return (
    <>
      <tr className="grp"><td colSpan={runs.length + 1}>{label}</td></tr>
      {rows.map((m) => (
        <tr key={m.key}>
          <td className="an-sticky-col metric">{m.label}<span className="muted">{m.unit && m.unit !== 'tps' ? m.unit : m.unit === 'tps' ? 'req/s' : ''}</span></td>
          {m.values.map((v, i) => {
            const isApprox = PERCENTILE_KEYS.has(m.key) && methods[i] === 'interval_weighted_approx';
            return (
              <td key={i} className={`r num ${i > 0 ? heatClass(m.changes[i], m.verdicts[i]) : ''}`}>
                <div className="an-cell">
                  <span title={isApprox ? 'Approximate percentile (interval-reported)' : undefined}>{isApprox && v != null ? '≈ ' : ''}{fmtUnit(v, m.unit)}</span>
                  {i > 0 && <ChangeChip change={m.changes[i]} verdict={m.verdicts[i]} />}
                </div>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function HeatLegend() {
  return (
    <span className="an-heat-legend" aria-label="Heat legend">
      better <i className="an-heat good-4" /><i className="an-heat good-2" /><i style={{ background: 'var(--surface-3)' }} /><i className="an-heat bad-2" /><i className="an-heat bad-4" /> worse
    </span>
  );
}

function VerdictSummary({ data }: { data: Comparison }) {
  if (data.runs.length < 2) return null;
  return (
    <div className="an-verdicts">
      {data.runs.slice(1).map((r, j) => {
        const i = j + 1;
        const scored = data.metrics.filter((m) => m.better !== 'neutral' && m.changes[i] != null);
        const better = scored.filter((m) => m.verdicts[i] === 'better');
        const worse = scored.filter((m) => m.verdicts[i] === 'worse');
        const neutral = scored.length - better.length - worse.length;
        const worst = [...worse].sort((a, b) => Math.abs(b.changes[i]!) - Math.abs(a.changes[i]!))[0];
        const best = [...better].sort((a, b) => Math.abs(b.changes[i]!) - Math.abs(a.changes[i]!))[0];
        const total = Math.max(1, scored.length);
        const overall = worse.length > better.length ? { t: 'Mostly worse', c: 'fail' } : better.length > worse.length ? { t: 'Mostly better', c: 'pass' } : { t: 'Mixed / unchanged', c: '' };
        return (
          <div key={r.id} className="an-verdict">
            <div className="an-verdict-head"><RunLetter i={i} /><span className="mono" style={{ fontWeight: 500 }}>{r.run_key}</span><span className="muted" style={{ fontWeight: 400 }}>vs A</span><div className="spacer" /><span className={`badge ${overall.c}`}>{overall.t}</span></div>
            <div className="an-verdict-bar" aria-hidden><span className="b" style={{ width: `${(better.length / total) * 100}%` }} /><span className="n" style={{ width: `${(neutral / total) * 100}%` }} /><span className="w" style={{ width: `${(worse.length / total) * 100}%` }} /></div>
            <div className="an-verdict-counts"><span style={{ color: 'var(--pass)' }}>{better.length} better</span><span>{neutral} unchanged</span><span style={{ color: 'var(--fail)' }}>{worse.length} worse</span></div>
            {worst && <div style={{ fontSize: 12 }}>Largest degradation: <b>{worst.label}</b> <ChangeChip change={worst.changes[i]} verdict="worse" /></div>}
            {best && <div style={{ fontSize: 12 }}>Largest improvement: <b>{best.label}</b> <ChangeChip change={best.changes[i]} verdict="better" /></div>}
          </div>
        );
      })}
    </div>
  );
}

function groupedBar(theme: 'light' | 'dark', runs: CmpRun[], rows: CmpMetric[], unit: string): EChartsOption {
  const fmt = unitFormatter(unit === 'tps' ? 'tps' : unit === 'ms' ? 'ms' : unit === '%' ? '%' : undefined);
  return {
    legend: { show: true },
    grid: { top: 30, bottom: 4, left: 8, right: 12, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: any) => fmt(v as number) },
    xAxis: { type: 'category', data: rows.map((m) => m.label), axisLabel: { interval: 0 } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmt(v) }, splitNumber: 4 },
    series: runs.map((r, i) => ({
      type: 'bar', name: `${RUN_LETTERS[i]} · ${r.run_key}`, data: rows.map((m) => m.values[i]), barMaxWidth: 26, barGap: '12%',
      itemStyle: { color: seriesColor(theme, i), borderRadius: [3, 3, 0, 0] },
    })),
  } as EChartsOption;
}

/* ------------------------------------------------------------------ transactions / endpoints */

function EntityTable({ kind, runs, rows, metrics }: {
  kind: 'transactions' | 'endpoints'; runs: CmpRun[]; methods: (string | null)[];
  rows: { name: string; values: Record<string, (number | null)[]> }[]; metrics: { key: string; label: string; unit: string; better: Better }[];
}) {
  const [mk, setMk] = useState(metrics[0].key);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'worst' | 'name' | 'value'>('worst');
  const m = metrics.find((x) => x.key === mk)!;
  const last = runs.length - 1;
  const prepared = useMemo(() => {
    let out = rows.map((r) => {
      const vals = r.values[mk] ?? [];
      const changes = vals.map((v, i) => (i === 0 ? null : pctChange(vals[0], v)));
      const verdicts = changes.map((c) => verdictOf(c, m.better));
      const worstScore = Math.max(0, ...changes.map((c, i) => (verdicts[i] === 'worse' && c != null ? Math.abs(c) : 0)));
      return { name: r.name, vals, changes, verdicts, worstScore };
    });
    if (q.trim()) out = out.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
    if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'value') out.sort((a, b) => (b.vals[last] ?? -Infinity) - (a.vals[last] ?? -Infinity));
    else out.sort((a, b) => b.worstScore - a.worstScore || a.name.localeCompare(b.name));
    return out;
  }, [rows, mk, m.better, q, sort, last]);
  const title = kind === 'transactions' ? 'Transaction comparison' : 'Endpoint comparison';
  const worseCount = prepared.filter((r) => r.verdicts.some((v) => v === 'worse')).length;

  return (
    <Card title={<>{title} <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· {rows.length} {kind}{worseCount ? ` · ${worseCount} degraded` : ''}</span></>} noPad
      actions={<>
        <div className="seg" role="radiogroup" aria-label="Metric">{metrics.map((x) => <button key={x.key} className={x.key === mk ? 'on' : ''} role="radio" aria-checked={x.key === mk} onClick={() => setMk(x.key)}>{x.label}</button>)}</div>
      </>}>
      {!rows.length ? <Empty>{kind === 'endpoints' ? 'No normalized endpoint metrics for these runs (endpoints are derived from raw samples with URLs).' : 'No transaction metrics for these runs.'}</Empty> : (
        <>
          <div className="dt-toolbar">
            <div className="dt-search"><input className="input" placeholder={`Filter ${kind}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Filter ${kind}`} style={{ paddingLeft: 8 }} /></div>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
              <option value="worst">Sort: largest degradation</option><option value="value">Sort: highest value (last run)</option><option value="name">Sort: name</option>
            </select>
            <div className="spacer" /><HeatLegend />
          </div>
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table className="table an-cmp">
              <thead><tr><th className="an-sticky-col">{kind === 'transactions' ? 'Transaction' : 'Endpoint'}</th>{runs.map((r, i) => <th key={r.id} className="r run"><span className="row" style={{ justifyContent: 'flex-end', gap: 5 }}><RunLetter i={i} /><span className="mono" style={{ textTransform: 'none' }}>{r.run_key.slice(-6)}</span> {m.label}</span></th>)}</tr></thead>
              <tbody>
                {prepared.map((r) => (
                  <tr key={r.name}>
                    <td className="an-sticky-col" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{kind === 'endpoints' ? <span className="mono">{r.name}</span> : r.name}</td>
                    {r.vals.map((v, i) => (
                      <td key={i} className={`r num ${i > 0 ? heatClass(r.changes[i], r.verdicts[i]) : ''}`}>
                        <div className="an-cell"><span>{m.unit ? fmtUnit(v, m.unit) : fmtNum(v)}</span>{i > 0 && <ChangeChip change={r.changes[i]} verdict={r.verdicts[i]} />}</div>
                      </td>
                    ))}
                  </tr>
                ))}
                {!prepared.length && <tr><td colSpan={runs.length + 1}><div className="empty">No {kind} match the filter</div></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ SLA */

function SlaComparison({ data, slaPct }: { data: Comparison; slaPct?: CmpMetric }) {
  const any = data.sla.some((s) => Object.keys(s ?? {}).length);
  return (
    <Card title="SLA comparison">
      {!any && !slaPct ? <Empty icon={<Sparkles size={20} />}>No SLA evaluations for these runs. Attach an SLA profile to the test to evaluate SLA rules.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Run</th><th className="r">SLA pass</th><th>Rule outcomes</th><th style={{ width: '35%' }}>Distribution</th></tr></thead>
            <tbody>
              {data.runs.map((r, i) => {
                const s = data.sla[i] ?? {};
                const pass = s.PASS ?? 0, warn = s.WARNING ?? 0, fail = s.FAIL ?? 0, total = pass + warn + fail;
                return (
                  <tr key={r.id}>
                    <td><span className="row" style={{ gap: 6 }}><RunLetter i={i} /><Link className="mono" to={`/runs/${r.run_key}/sla`}>{r.run_key}</Link></span></td>
                    <td className="r num"><div className="an-cell">{fmtUnit(slaPct?.values[i], '%')}{i > 0 && slaPct && <ChangeChip change={slaPct.changes[i]} verdict={slaPct.verdicts[i]} />}</div></td>
                    <td>{total ? <span className="row wrap" style={{ gap: 4 }}>{pass > 0 && <SlaStatus status="PASS" count={pass} />}{warn > 0 && <SlaStatus status="WARNING" count={warn} />}{fail > 0 && <SlaStatus status="FAIL" count={fail} />}</span> : <span className="muted">Not evaluated</span>}</td>
                    <td>{total > 0 && (
                      <div className="an-verdict-bar" style={{ height: 8 }} title={`${pass} pass · ${warn} warning · ${fail} fail`} aria-label={`${pass} pass, ${warn} warning, ${fail} fail`}>
                        <span className="b" style={{ width: `${(pass / total) * 100}%` }} /><span style={{ width: `${(warn / total) * 100}%`, background: 'var(--warn)' }} /><span className="w" style={{ width: `${(fail / total) * 100}%` }} />
                      </div>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
