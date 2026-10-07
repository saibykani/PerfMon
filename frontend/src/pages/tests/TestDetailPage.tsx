import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Archive, ChevronRight, Download, FileCode2, Flag, KeyRound, Lock, Pencil, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { api, download } from '@/services/api';
import { Card, ConfirmDialog, ErrorBox, KeyValue, Kpi, Loading } from '@/components/ui';
import { StatusBadge } from '@/components/Status';
import { Chart } from '@/charts/Chart';
import { seriesTable, timeSeriesOption, type TsSeries } from '@/charts/builders';
import { useUi } from '@/stores/ui';
import { fmtDate, fmtDuration, fmtMs, fmtNum, fmtPct, fmtRelative } from '@/components/format';
import { EmptyState, EnvBadge, Notice, Tags, Toaster, friendlyError, num, toast, useCan } from '@/components/inventory/common';
import { useInvalidateInventory, type TestConfiguration, type TestData, type TestDetail } from '@/components/inventory/data';
import { TestForm } from '@/components/inventory/forms';
import { NewRunDialog } from '@/components/inventory/NewRun';
import { Sparkline } from '@/components/inventory/viz';

const CFG_FIELDS: { key: keyof TestConfiguration; label: string; fmt: (v: any) => string }[] = [
  { key: 'virtual_users', label: 'VUs', fmt: (v) => fmtNum(num(v)) },
  { key: 'ramp_up_sec', label: 'Ramp-up', fmt: (v) => fmtDuration(num(v)) },
  { key: 'ramp_down_sec', label: 'Ramp-down', fmt: (v) => fmtDuration(num(v)) },
  { key: 'duration_sec', label: 'Duration', fmt: (v) => fmtDuration(num(v)) },
  { key: 'target_tps', label: 'Target TPS', fmt: (v) => fmtNum(num(v), num(v) != null && num(v)! % 1 ? 1 : 0) },
  { key: 'thread_group', label: 'Thread group', fmt: (v) => v ?? '—' },
  { key: 'think_time_ms', label: 'Think time', fmt: (v) => fmtMs(num(v)) },
];

export function TestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const can = useCan();
  const theme = useUi((s) => s.theme);
  const inv = useInvalidateInventory();
  const { data: t, isLoading, error } = useQuery({ queryKey: ['inv', 'test', id], enabled: !!id, queryFn: () => api.get<TestDetail>(`/tests/${id}`), refetchInterval: 15_000 });
  const [edit, setEdit] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const chrono = useMemo(() => [...(t?.runs ?? [])].filter((r) => r.started_at).sort((a, b) => +new Date(a.started_at!) - +new Date(b.started_at!)), [t?.runs]);
  const baseline = t?.runs.find((r) => r.is_baseline);
  const markers = baseline?.started_at ? [{ ts: +new Date(baseline.started_at), label: 'Baseline' }] : [];
  const p95: TsSeries[] = [{ name: 'P95', key: 'p95', data: chrono.map((r) => [+new Date(r.started_at!), num(r.p95)]) }];
  const tps: TsSeries[] = [{ name: 'TPS (avg)', key: 'tps', data: chrono.map((r) => [+new Date(r.started_at!), num(r.tps_avg)]) }];
  const baseIdx = baseline ? chrono.findIndex((r) => r.id === baseline.id) : -1;

  const setBaseline = async (runKey: string, on: boolean) => {
    try { await api.post(`/runs/${runKey}/baseline`, { baseline: on }); inv(); toast.success(on ? `${runKey} is now the baseline` : 'Baseline cleared'); } catch (e) { toast.error(friendlyError(e)); }
  };
  const archive = async () => {
    try { await api.del(`/tests/${id}`); inv(); toast.success('Test archived (runs are kept)'); nav('/tests'); } catch (e) { toast.error(friendlyError(e)); }
  };

  if (isLoading) return <div className="stack"><Loading height={70} /><Loading height={90} /><Loading height={260} /></div>;
  if (error || !t) return <div className="stack"><ErrorBox error={error ?? new Error('Test not found')} /><Link to="/tests">← Back to tests</Link></div>;
  const current = t.configurations.find((c) => c.is_current) ?? t.configurations[0];
  const last = t.runs[0];

  return (
    <div>
      <Toaster />
      <div className="inv-crumbs"><Link to="/tests">Performance Tests</Link><ChevronRight size={12} /><span>{t.project_name}</span><ChevronRight size={12} /><span>{t.name}</span></div>
      <div className="inv-hero">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="inv-title-row"><h1>{t.name}</h1><span className="badge accent">{t.test_type}</span></div>
          {t.description && <div className="text-2" style={{ marginTop: 2 }}>{t.description}</div>}
          <div className="inv-hero-meta">
            <span>{t.application_name}</span><span>{t.environment_name} <EnvBadge type={t.environment_type} /></span>
            <span>SLA: {t.sla_profile_name ?? 'none'}</span>{t.owner && <span>Owner: {t.owner}</span>}<Tags tags={t.tags} max={6} />
          </div>
        </div>
        <div className="row wrap">
          {can('DELETE_TEST') && <button className="btn" onClick={() => setArchiveOpen(true)}><Archive size={14} />Archive</button>}
          {can('EDIT_TEST') && <button className="btn" onClick={() => setEdit(true)}><Pencil size={14} />Edit</button>}
          {can('EXECUTE_TEST') && <button className="btn btn-primary" onClick={() => setRunOpen(true)}><Play size={14} />New run</button>}
        </div>
      </div>

      <div className="inv-kpis">
        <Kpi label="Runs" value={fmtNum(t.run_count)} />
        <Kpi label="Last result" value={last ? <StatusBadge value={last.result ?? last.status} /> : '—'} sub={last ? fmtRelative(last.started_at) : 'never run'}
          status={last?.result === 'FAIL' ? 'fail' : last?.result === 'PASS' ? 'pass' : last?.result === 'PASS_WITH_WARNINGS' ? 'warn' : null} />
        <Kpi label="Last P95" value={fmtMs(num(last?.p95))} sub={baseline ? `baseline ${fmtMs(num(baseline.p95))}` : 'no baseline'} />
        <Kpi label="Last TPS" value={fmtNum(num(last?.tps_avg), 1)} sub={baseline ? `baseline ${fmtNum(num(baseline.tps_avg), 1)}` : undefined} />
        <Kpi label="Baseline" value={<span className="mono" style={{ fontSize: 13 }}>{t.baseline_run_key ?? '—'}</span>} onClick={t.baseline_run_key ? () => nav(`/runs/${t.baseline_run_key}`) : undefined} />
        <Kpi label="Configuration" value={`v${t.config_version ?? 1}`} sub={`${t.configurations.length} version${t.configurations.length === 1 ? '' : 's'}`} />
      </div>

      <div className="inv-grid-2" style={{ marginBottom: 12 }}>
        <Chart title="P95 response time per run" subtitle={baseline ? 'dashed line = baseline run' : undefined} height={190}
          option={timeSeriesOption({ theme, series: p95, unit: 'ms', markers, zoom: false })} table={seriesTable(p95)} empty={chrono.length ? null : 'No completed runs yet'} />
        <Chart title="Average TPS per run" height={190} option={timeSeriesOption({ theme, series: tps, unit: 'tps', markers, zoom: false })} table={seriesTable(tps)} empty={chrono.length ? null : 'No completed runs yet'} />
      </div>

      <div className="inv-split">
        <div className="stack">
          <Card title="Recent runs" noPad actions={chrono.length > 1 && (
            <span className="row" style={{ gap: 12, fontSize: 11 }}>
              <span className="row" style={{ gap: 4 }}><span className="muted">P95</span><Sparkline values={chrono.map((r) => num(r.p95))} slot="p95" markIndex={baseIdx >= 0 ? baseIdx : null} label="P95 trend" /></span>
              <span className="row" style={{ gap: 4 }}><span className="muted">TPS</span><Sparkline values={chrono.map((r) => num(r.tps_avg))} slot="tps" markIndex={baseIdx >= 0 ? baseIdx : null} label="TPS trend" /></span>
            </span>
          )}>
            {t.runs.length ? (
              <div className="table-wrap"><table className="table"><thead><tr><th>Run ID</th><th>Build</th><th>Started</th><th className="r">TPS</th><th className="r">P95</th><th className="r">Error %</th><th className="r">Score</th><th>Status</th><th>Result</th><th /></tr></thead>
                <tbody>{t.runs.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/runs/${r.run_key}`)}>
                    <td><span className="row" style={{ gap: 6 }}><Link className="mono" to={`/runs/${r.run_key}`} onClick={(e) => e.stopPropagation()}>{r.run_key}</Link>{r.is_baseline && <span className="badge accent" title="Baseline for regression comparison"><Flag size={10} />BASELINE</span>}</span></td>
                    <td className="mono">{r.build_number ?? '—'}</td>
                    <td title={fmtDate(r.started_at)}>{r.started_at ? fmtRelative(r.started_at) : <span className="muted">not started</span>}</td>
                    <td className="r num">{fmtNum(num(r.tps_avg), 1)}</td><td className="r num">{fmtMs(num(r.p95))}</td><td className="r num">{fmtPct(num(r.error_pct))}</td>
                    <td className="r num">{fmtNum(num(r.performance_score))}</td>
                    <td><StatusBadge value={r.status} /></td><td><StatusBadge value={r.result} /></td>
                    <td className="r" onClick={(e) => e.stopPropagation()}>
                      {r.status === 'RUNNING' && <Link className="btn btn-sm" to={`/live/${r.run_key}`}>Live</Link>}
                      {can('EDIT_TEST') && r.status === 'COMPLETED' && (r.is_baseline
                        ? <button className="btn btn-ghost btn-sm" onClick={() => setBaseline(r.run_key, false)}>Unset baseline</button>
                        : <button className="btn btn-ghost btn-sm" onClick={() => setBaseline(r.run_key, true)}><Flag size={12} />Set baseline</button>)}
                    </td>
                  </tr>
                ))}</tbody></table></div>
            ) : <EmptyState icon={<Play size={20} />} title="No runs yet" action={can('EXECUTE_TEST') && <button className="btn btn-primary" onClick={() => setRunOpen(true)}><Play size={14} />New run</button>}>Generate a Run ID, point JMeter's Backend Listener at Perfmon and execute.</EmptyState>}
          </Card>

          <Card title="Configuration history" noPad>
            <div className="table-wrap"><table className="table"><thead><tr><th>Version</th><th>Created</th>{CFG_FIELDS.map((f) => <th key={f.key} className={f.key === 'thread_group' ? '' : 'r'}>{f.label}</th>)}</tr></thead>
              <tbody>{t.configurations.map((c, i) => {
                const prev = t.configurations[i + 1];
                return (
                  <tr key={c.id}>
                    <td><span className="row" style={{ gap: 6 }}><b>v{c.version}</b>{c.is_current && <span className="badge pass">CURRENT</span>}</span></td>
                    <td>{fmtDate(c.created_at)}</td>
                    {CFG_FIELDS.map((f) => {
                      const changed = prev && String(prev[f.key] ?? '') !== String(c[f.key] ?? '');
                      return <td key={f.key} className={f.key === 'thread_group' ? '' : 'r num'} style={changed ? { background: 'var(--warn-soft)', fontWeight: 600 } : undefined} title={changed ? `Changed from ${f.fmt(prev[f.key])}` : undefined}>{f.fmt(c[f.key])}</td>;
                    })}
                  </tr>
                );
              })}</tbody></table></div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Load profile" actions={current && <span className="badge">v{current.version}</span>}>
            {current ? <KeyValue items={CFG_FIELDS.map((f) => [f.label, f.fmt(current[f.key])])} /> : <span className="muted">No configuration</span>}
          </Card>
          <Card title="JMeter script (JMX)">
            <div className="stack" style={{ gap: 8 }}>
              {current?.jmx_artifact_id ? (
                <button className="btn" onClick={() => download(`/artifacts/${current.jmx_artifact_id}/versions/latest/download`, `${t.name}.jmx`).catch((e) => toast.error(friendlyError(e)))}><Download size={14} />Download current JMX</button>
              ) : <div className="muted" style={{ fontSize: 12 }}>No JMX linked to this configuration. Upload it to a run as an artifact of type <b>JMX</b> to keep it versioned with the results.</div>}
              <Link className="btn btn-sm" to={`/artifacts?kind=JMX&q=${encodeURIComponent(t.name)}`}><FileCode2 size={13} />Browse JMX artifacts</Link>
            </div>
          </Card>
          <TestDataCard testId={t.id} items={t.testData} canEdit={can('EDIT_TEST')} />
        </div>
      </div>

      <TestForm open={edit} test={t} onClose={() => setEdit(false)} />
      <NewRunDialog open={runOpen} test={t} onClose={() => setRunOpen(false)} />
      <ConfirmDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} title={`Archive “${t.name}”?`} confirmLabel="Archive test"
        message="The test is hidden from lists and can no longer start new runs. All existing runs, metrics and reports are kept." onConfirm={archive} />
    </div>
  );
}

/* ------------------------------------------------------------------ test data editor */
interface Row { key: string; value: string; isSensitive: boolean; existing: boolean; existingSensitive: boolean; dirty: boolean }
const SENSITIVE = /pass(word)?|secret|token|api[_-]?key|credential|private/i;

function TestDataCard({ testId, items, canEdit }: { testId: string; items: TestData[]; canEdit: boolean }) {
  const inv = useInvalidateInventory();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const start = () => { setRows(items.map((i) => ({ key: i.key, value: i.is_sensitive ? '' : i.value ?? '', isSensitive: i.is_sensitive, existing: true, existingSensitive: i.is_sensitive, dirty: false }))); setErr(null); setEditing(true); };
  useEffect(() => { if (!editing) setRows([]); }, [editing]);
  const upd = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch, dirty: true } : x)));

  const save = async () => {
    const keys = rows.map((r) => r.key.trim());
    if (keys.some((k) => !k)) return setErr('Every row needs a key');
    if (new Set(keys).size !== keys.length) return setErr('Keys must be unique');
    const payload = rows.filter((r) => !r.existing || r.dirty).filter((r) => !(r.existingSensitive && r.value === '' && r.isSensitive))
      .map((r) => ({ key: r.key.trim(), value: r.value === '' ? null : r.value, isSensitive: r.isSensitive }));
    if (!payload.length) { setEditing(false); return; }
    setSaving(true); setErr(null);
    try { await api.put(`/tests/${testId}/data`, { items: payload }); inv(); toast.success(`Saved ${payload.length} test data value${payload.length === 1 ? '' : 's'}`); setEditing(false); }
    catch (e) { setErr(friendlyError(e)); } finally { setSaving(false); }
  };

  return (
    <Card title="Test data" actions={canEdit && (editing
      ? <><button className="btn btn-sm" onClick={() => setEditing(false)}><X size={13} />Cancel</button><button className="btn btn-sm btn-primary" disabled={saving} onClick={save}><Save size={13} />{saving ? 'Saving…' : 'Save'}</button></>
      : <button className="btn btn-sm" onClick={start}><Pencil size={13} />Edit</button>)}>
      {!editing ? (
        items.length ? (
          <table className="table"><tbody>{items.map((d) => (
            <tr key={d.id}><td className="mono" style={{ width: '45%' }}>{d.key}</td><td className="mono">{d.is_sensitive ? <span className="row muted" style={{ gap: 4 }}><Lock size={11} />••••••••</span> : d.value ?? <span className="muted">null</span>}</td></tr>
          ))}</tbody></table>
        ) : <div className="muted" style={{ fontSize: 12 }}><KeyRound size={13} style={{ verticalAlign: -2 }} /> Key/value metadata for this test (data set names, tenant IDs, feature flags). Secrets are encrypted and never shown again.</div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {err && <div className="error-box">{err}</div>}
          {rows.map((r, i) => (
            <div key={i} className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input className="input mono" style={{ width: '38%' }} aria-label="Key" value={r.key} disabled={r.existing} placeholder="key"
                onChange={(e) => upd(i, { key: e.target.value, isSensitive: r.isSensitive || SENSITIVE.test(e.target.value) })} />
              <input className="input mono" style={{ flex: 1 }} aria-label={`Value for ${r.key || 'new key'}`} type={r.isSensitive ? 'password' : 'text'} value={r.value}
                placeholder={r.existingSensitive ? '•••••••• (unchanged)' : 'value'} onChange={(e) => upd(i, { value: e.target.value })} autoComplete="new-password" />
              <label className="row" style={{ gap: 3, fontSize: 11 }} title="Sensitive values are encrypted and masked"><input type="checkbox" checked={r.isSensitive} onChange={(e) => upd(i, { isSensitive: e.target.checked })} /><Lock size={11} /></label>
              {!r.existing && <button className="btn btn-ghost icon-btn btn-sm" aria-label="Remove row" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 size={13} /></button>}
            </div>
          ))}
          <div className="row"><button className="btn btn-sm" onClick={() => setRows((x) => [...x, { key: '', value: '', isSensitive: false, existing: false, existingSensitive: false, dirty: true }])}><Plus size={13} />Add value</button></div>
          <Notice>Keys matching password / secret / token / api key are always stored encrypted. Existing keys can be updated or cleared (empty value) but not renamed.</Notice>
        </div>
      )}
    </Card>
  );
}
