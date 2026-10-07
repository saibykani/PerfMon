import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Info, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { api } from '@/services/api';
import { Card, ConfirmDialog } from '@/components/ui';
import { fmtDate, fmtNum } from '@/components/format';
import { useUi } from '@/stores/ui';
import { seriesColor } from '@/charts/palette';
import { Chip, EmptyState, errMsg, FormField, relTime, SkeletonRows, toast, Unavailable } from '@/components/platform/kit';

type Settings = {
  score_weights: Record<string, number>;
  regression_thresholds: Record<string, number>;
  default_result_thresholds: { errorPctFail: number; errorPctWarn: number };
  retention: Record<string, number>;
  _meta?: Record<string, { updatedAt: string; updatedBy: string | null }>;
  _defaults?: Omit<Settings, '_meta' | '_defaults'>;
};

const useSettings = () => useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<Settings>('/admin/settings') });

function useSaveSetting(key: string, label: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: Record<string, unknown>) => api.put(`/admin/settings/${key}`, value),
    onSuccess: () => { toast.success(`${label} saved (audited).`); qc.invalidateQueries({ queryKey: ['admin-settings'] }); qc.invalidateQueries({ queryKey: ['admin-retention'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
}

const MetaLine = ({ m }: { m?: { updatedAt: string; updatedBy: string | null } }) =>
  m ? <span className="muted" style={{ fontSize: 12 }}>Last changed {relTime(m.updatedAt)}{m.updatedBy ? ` by ${m.updatedBy}` : ''}</span> : <span className="muted" style={{ fontSize: 12 }}>Using defaults</span>;

const numStr = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));

/* ------------------------------------------------------------------ settings */

const WEIGHTS: { key: string; label: string; help: string }[] = [
  { key: 'sla', label: 'SLA compliance', help: 'Share of SLA rules passed' },
  { key: 'responseTime', label: 'Response time', help: 'P95 vs SLA target / baseline' },
  { key: 'throughput', label: 'Throughput', help: 'TPS vs target / baseline' },
  { key: 'errorRate', label: 'Error rate', help: 'Failed request percentage' },
  { key: 'infrastructure', label: 'Infrastructure', help: 'CPU / memory headroom' },
  { key: 'regression', label: 'Regression', help: 'Regressions vs baseline run' },
];
const REGRESSION: { key: string; label: string; unit: string; int?: boolean }[] = [
  { key: 'p95Pct', label: 'P95 increase', unit: '%' }, { key: 'p99Pct', label: 'P99 increase', unit: '%' }, { key: 'avgPct', label: 'Average RT increase', unit: '%' },
  { key: 'tpsDropPct', label: 'TPS drop', unit: '%' }, { key: 'errorRateIncreasePts', label: 'Error rate increase', unit: 'pts' }, { key: 'cpuIncreasePts', label: 'CPU increase', unit: 'pts' },
  { key: 'memoryIncreasePts', label: 'Memory increase', unit: 'pts' }, { key: 'minTransactionSamples', label: 'Min. samples per transaction', unit: 'samples', int: true }, { key: 'minAbsoluteMs', label: 'Min. absolute change', unit: 'ms' },
];

export function SettingsTab() {
  const q = useSettings();
  if (q.isLoading) return <SkeletonRows rows={6} height={44} />;
  if (q.error || !q.data) return <Unavailable what="Settings" error={q.error} />;
  return (
    <div className="stack">
      <WeightsCard s={q.data} />
      <div className="pf-grid-2">
        <RegressionCard s={q.data} />
        <ResultCard s={q.data} />
      </div>
    </div>
  );
}

function WeightsCard({ s }: { s: Settings }) {
  const theme = useUi((x) => x.theme);
  const [w, setW] = useState<Record<string, number>>(s.score_weights);
  useEffect(() => setW(s.score_weights), [s.score_weights]);
  const save = useSaveSetting('score_weights', 'Performance Score weights');
  const total = WEIGHTS.reduce((a, x) => a + (Number(w[x.key]) || 0), 0);
  const dirty = JSON.stringify(w) !== JSON.stringify(s.score_weights);
  const invalid = total <= 0 || WEIGHTS.some((x) => !(Number(w[x.key]) >= 0 && Number(w[x.key]) <= 1000));
  const pct = (k: string) => (total ? ((Number(w[k]) || 0) / total) * 100 : 0);
  return (
    <Card title="Performance Score weights" actions={<>
      <MetaLine m={s._meta?.score_weights} />
      {s._defaults && <button className="btn btn-sm btn-ghost" onClick={() => setW(s._defaults!.score_weights)}><RotateCcw size={12} />Defaults</button>}
      <button className="btn btn-sm btn-primary" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate(Object.fromEntries(WEIGHTS.map((x) => [x.key, Number(w[x.key]) || 0])))}><Save size={12} />Save</button>
    </>}>
      <div className="pf-grid-2" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div>
          {WEIGHTS.map((x, i) => (
            <div key={x.key} className="pf-weight">
              <div><div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: seriesColor(theme, i), display: 'inline-block' }} />{x.label}</div><div className="muted" style={{ fontSize: 11 }}>{x.help}</div></div>
              <input type="range" min={0} max={100} step={1} value={Math.min(100, Number(w[x.key]) || 0)} onChange={(e) => setW({ ...w, [x.key]: Number(e.target.value) })} aria-label={`${x.label} weight`} />
              <input className="input num" style={{ width: 70, textAlign: 'right' }} inputMode="numeric" value={w[x.key] ?? 0} aria-label={`${x.label} weight value`}
                onChange={(e) => setW({ ...w, [x.key]: e.target.value === '' ? 0 : Number(e.target.value.replace(/[^\d.]/g, '')) })} />
              <div className="pct">{pct(x.key).toFixed(1)}%</div>
            </div>
          ))}
        </div>
        <div className="stack">
          <div>
            <div className="pf-section-title">Normalized share</div>
            <div className="pf-stack-bar" role="img" aria-label={WEIGHTS.map((x) => `${x.label} ${pct(x.key).toFixed(1)}%`).join(', ')}>
              {WEIGHTS.map((x, i) => <div key={x.key} style={{ width: `${pct(x.key)}%`, background: seriesColor(theme, i) }} title={`${x.label}: ${pct(x.key).toFixed(1)}%`} />)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Raw total {fmtNum(total, 0)} → normalized to 100%.</div>
          </div>
          <div className="pf-callout"><Info size={14} /><div>
            <b>Score = Σ (factor score × weight) / Σ weights of factors with data.</b> Weights are relative — they don’t need to add up to 100. A factor without data for a run
            (e.g. no SLA profile, no infrastructure metrics, no baseline) is <b>excluded</b> and the remaining weights are re-normalized, so missing data never lowers a score.
          </div></div>
          {invalid && <div className="pf-field-error"><AlertTriangle size={12} /> At least one weight must be greater than 0 (each 0 – 1000).</div>}
        </div>
      </div>
    </Card>
  );
}

function RegressionCard({ s }: { s: Settings }) {
  const [v, setV] = useState(numStr(s.regression_thresholds));
  useEffect(() => setV(numStr(s.regression_thresholds)), [s.regression_thresholds]);
  const save = useSaveSetting('regression_thresholds', 'Regression thresholds');
  const errs: Record<string, string> = {};
  for (const f of REGRESSION) {
    const n = Number(v[f.key]);
    if (v[f.key] === '' || !Number.isFinite(n) || n < 0) errs[f.key] = 'Number ≥ 0';
    else if (f.int && !Number.isInteger(n)) errs[f.key] = 'Whole number';
  }
  const dirty = JSON.stringify(v) !== JSON.stringify(numStr(s.regression_thresholds));
  return (
    <Card title="Regression thresholds" actions={<>
      <MetaLine m={s._meta?.regression_thresholds} />
      {s._defaults && <button className="btn btn-sm btn-ghost" onClick={() => setV(numStr(s._defaults!.regression_thresholds))}><RotateCcw size={12} />Defaults</button>}
      <button className="btn btn-sm btn-primary" disabled={!dirty || !!Object.keys(errs).length || save.isPending} onClick={() => save.mutate(Object.fromEntries(REGRESSION.map((f) => [f.key, Number(v[f.key])])))}><Save size={12} />Save</button>
    </>}>
      <div className="pf-form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {REGRESSION.map((f) => (
          <FormField key={f.key} label={f.label} error={errs[f.key]}>
            <div className="pf-input-unit"><input className="input num" inputMode="decimal" value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} /><span className="pf-unit">{f.unit}</span></div>
          </FormField>
        ))}
      </div>
      <div className="pf-sub" style={{ marginTop: 10 }}>A change vs the baseline run is flagged as a regression only when it exceeds the threshold, the transaction has enough samples, and the absolute change is above the minimum.</div>
    </Card>
  );
}

function ResultCard({ s }: { s: Settings }) {
  const [v, setV] = useState(numStr(s.default_result_thresholds as any));
  useEffect(() => setV(numStr(s.default_result_thresholds as any)), [s.default_result_thresholds]);
  const save = useSaveSetting('default_result_thresholds', 'Default result thresholds');
  const warn = Number(v.errorPctWarn);
  const fail = Number(v.errorPctFail);
  const errs: Record<string, string> = {};
  if (!(warn >= 0 && warn <= 100) || v.errorPctWarn === '') errs.errorPctWarn = '0 – 100';
  if (!(fail >= 0 && fail <= 100) || v.errorPctFail === '') errs.errorPctFail = '0 – 100';
  if (!errs.errorPctWarn && !errs.errorPctFail && warn > fail) errs.errorPctWarn = 'Must be ≤ the fail threshold';
  const dirty = JSON.stringify(v) !== JSON.stringify(numStr(s.default_result_thresholds as any));
  return (
    <Card title="Default result thresholds" actions={<>
      <MetaLine m={s._meta?.default_result_thresholds} />
      <button className="btn btn-sm btn-primary" disabled={!dirty || !!Object.keys(errs).length || save.isPending} onClick={() => save.mutate({ errorPctWarn: warn, errorPctFail: fail })}><Save size={12} />Save</button>
    </>}>
      <div className="pf-form-grid">
        <FormField label="Error % → Pass with warnings" error={errs.errorPctWarn}><div className="pf-input-unit"><input className="input num" value={v.errorPctWarn} onChange={(e) => setV({ ...v, errorPctWarn: e.target.value })} /><span className="pf-unit">%</span></div></FormField>
        <FormField label="Error % → Fail" error={errs.errorPctFail}><div className="pf-input-unit"><input className="input num" value={v.errorPctFail} onChange={(e) => setV({ ...v, errorPctFail: e.target.value })} /><span className="pf-unit">%</span></div></FormField>
      </div>
      {!errs.errorPctWarn && !errs.errorPctFail && (
        <div className="row wrap" style={{ marginTop: 12, gap: 6 }}>
          <Chip tone="pass">Pass &lt; {warn}%</Chip><Chip tone="warn">Warnings {warn}–{fail}%</Chip><Chip tone="fail">Fail ≥ {fail}%</Chip>
        </div>
      )}
      <div className="pf-sub" style={{ marginTop: 10 }}>Applied only to tests without an SLA profile, to classify a run’s result from its error rate.</div>
    </Card>
  );
}

/* ------------------------------------------------------------------ retention */

interface Estimate { dataType: string; label: string; retentionDays: number; cutoff: string; rows: number }
interface Purge { id: string; dataType: string; cutoff: string; estimatedRows: number | null; status: string; requestedAt: string; requestedBy: string | null; confirmedBy: string | null; confirmedAt: string | null; executedAt: string | null; deletedRows: number | null; error: string | null }

const RET_FIELDS: { key: string; dataType: string; label: string; presets: number[]; min?: number }[] = [
  { key: 'rawMetricsDays', dataType: 'raw_metrics', label: 'Raw metrics', presets: [30, 60, 90, 180, 365] },
  { key: 'aggregatedMetricsDays', dataType: 'aggregated_metrics', label: 'Aggregated metrics', presets: [180, 365, 730, 1095, 1825] },
  { key: 'artifactsDays', dataType: 'artifacts', label: 'Artifacts', presets: [90, 180, 365, 730] },
  { key: 'reportsDays', dataType: 'reports', label: 'Reports', presets: [180, 365, 730, 1095] },
  { key: 'logsDays', dataType: 'logs', label: 'Logs', presets: [7, 14, 30, 60, 90] },
  { key: 'auditDays', dataType: 'audit', label: 'Audit log', presets: [90, 180, 365, 730, 2555], min: 30 },
];
const dayLabel = (d: number) => (d % 365 === 0 ? `${d / 365} year${d / 365 > 1 ? 's' : ''}` : `${d} days`);
const PURGE_TONE: Record<string, 'pass' | 'warn' | 'fail' | 'neutral' | 'info'> = { EXECUTED: 'pass', PENDING_CONFIRMATION: 'warn', EXECUTING: 'info', CONFIRMED: 'info', CANCELLED: 'neutral', FAILED: 'fail' };

export function RetentionTab() {
  const qc = useQueryClient();
  const settings = useSettings();
  const ret = useQuery({ queryKey: ['admin-retention'], queryFn: () => api.get<{ policy: Record<string, number>; estimates: Estimate[]; pending: Purge[]; note?: string }>('/admin/retention') });
  const hist = useQuery({ queryKey: ['admin-purges'], queryFn: () => api.get<Purge[]>('/admin/retention/purges') });
  const policy = ret.data?.policy ?? settings.data?.retention ?? {};
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => setV(numStr(policy)), [JSON.stringify(policy)]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useSaveSetting('retention', 'Retention policy');
  const [confirm, setConfirm] = useState<Purge | null>(null);
  const [requestFor, setRequestFor] = useState<Estimate | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['admin-retention'] }); qc.invalidateQueries({ queryKey: ['admin-purges'] }); };
  const request = useMutation({
    mutationFn: (dataType: string) => api.post<Purge>('/admin/retention/purges', { dataType }),
    onSuccess: (p) => { toast.info(`Purge request created for ${p.dataType} — awaiting explicit confirmation.`); invalidate(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const exec = useMutation({
    mutationFn: (p: Purge) => api.post<Purge>(`/admin/retention/purges/${p.id}/confirm`, {}),
    onSuccess: (p) => { toast.success(`Purge executed: ${fmtNum(p.deletedRows ?? 0)} rows deleted.`); invalidate(); },
    onError: (e) => { toast.error(`Purge failed: ${errMsg(e)}`); invalidate(); },
  });
  const cancel = useMutation({
    mutationFn: (p: Purge) => api.post(`/admin/retention/purges/${p.id}/cancel`, {}),
    onSuccess: () => { toast.success('Purge request cancelled.'); invalidate(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const errs: Record<string, string> = {};
  for (const f of RET_FIELDS) {
    const n = Number(v[f.key]);
    if (!Number.isInteger(n) || n < (f.min ?? 1) || n > 36500) errs[f.key] = `${f.min ?? 1} – 36500 days`;
  }
  const dirty = RET_FIELDS.some((f) => String(policy[f.key] ?? '') !== (v[f.key] ?? ''));
  const pending = useMemo(() => new Map((ret.data?.pending ?? []).map((p) => [p.dataType, p])), [ret.data]);

  if (ret.isLoading) return <SkeletonRows rows={6} height={44} />;
  if (ret.error) return <Unavailable what="Data retention" error={ret.error} />;

  return (
    <div className="stack">
      <div className="pf-callout"><Info size={14} /><div>{ret.data?.note ?? 'Data is never deleted automatically.'} A purge removes data older than the policy cut-off; artifacts are also deleted from object storage. Every step is audited.</div></div>
      <Card title="Retention policy" actions={<><MetaLine m={settings.data?._meta?.retention} />
        <button className="btn btn-sm btn-primary" disabled={!dirty || !!Object.keys(errs).length || save.isPending} onClick={() => save.mutate(Object.fromEntries(RET_FIELDS.map((f) => [f.key, Number(v[f.key])])))}><Save size={12} />Save policy</button></>}>
        <div className="pf-form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {RET_FIELDS.map((f) => {
            const isPreset = f.presets.includes(Number(v[f.key]));
            return (
              <FormField key={f.key} label={f.label} error={errs[f.key]}>
                <div className="row" style={{ gap: 6 }}>
                  <select className="select" style={{ flex: 1 }} value={isPreset ? v[f.key] : 'custom'} onChange={(e) => e.target.value !== 'custom' && setV({ ...v, [f.key]: e.target.value })}>
                    {f.presets.map((d) => <option key={d} value={String(d)}>{dayLabel(d)}</option>)}
                    <option value="custom">Custom…</option>
                  </select>
                  <div className="pf-input-unit" style={{ width: 120 }}><input className="input num" inputMode="numeric" value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} aria-label={`${f.label} days`} /><span className="pf-unit">days</span></div>
                </div>
              </FormField>
            );
          })}
        </div>
        {dirty && <div className="pf-sub" style={{ marginTop: 8 }}>Save the policy to refresh the estimates below.</div>}
      </Card>

      <Card noPad title="Eligible for purge (estimates)">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Data type</th><th>Description</th><th className="r">Retention</th><th>Cut-off</th><th className="r">Rows older than cut-off</th><th /></tr></thead>
            <tbody>
              {(ret.data?.estimates ?? []).map((e) => {
                const p = pending.get(e.dataType);
                return (
                  <tr key={e.dataType}>
                    <td><b>{RET_FIELDS.find((f) => f.dataType === e.dataType)?.label ?? e.dataType}</b></td>
                    <td className="muted" style={{ whiteSpace: 'normal', maxWidth: 320 }}>{e.label}</td>
                    <td className="r num">{dayLabel(e.retentionDays)}</td>
                    <td>{fmtDate(e.cutoff)}</td>
                    <td className="r num">{e.rows ? <b>{fmtNum(e.rows)}</b> : <span className="muted">0</span>}</td>
                    <td>
                      <div className="pf-actions">
                        {p ? <>
                          <Chip tone="warn">Pending</Chip>
                          <button className="btn btn-sm btn-danger" onClick={() => setConfirm(p)}><Trash2 size={12} />Confirm…</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => cancel.mutate(p)} aria-label="Cancel purge request"><X size={12} /></button>
                        </> : <button className="btn btn-sm" disabled={!e.rows || request.isPending} title={e.rows ? 'Create a purge request (nothing is deleted yet)' : 'Nothing to purge'} onClick={() => setRequestFor(e)}><Archive size={12} />Request purge</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card noPad title="Purge history">
        {hist.isLoading ? <div className="card-body"><SkeletonRows rows={2} /></div> : !(hist.data ?? []).length ? <EmptyState icon={<Archive size={20} />} title="No purge requests yet" /> : (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="table">
              <thead><tr><th>Requested</th><th>Data type</th><th>Cut-off</th><th className="r">Estimated</th><th className="r">Deleted</th><th>Status</th><th>Requested by</th><th>Confirmed by</th></tr></thead>
              <tbody>
                {(hist.data ?? []).map((p) => (
                  <tr key={p.id}>
                    <td title={fmtDate(p.requestedAt)}>{relTime(p.requestedAt)}</td>
                    <td>{RET_FIELDS.find((f) => f.dataType === p.dataType)?.label ?? p.dataType}</td>
                    <td>{fmtDate(p.cutoff)}</td>
                    <td className="r num">{fmtNum(p.estimatedRows)}</td>
                    <td className="r num">{p.deletedRows != null ? fmtNum(p.deletedRows) : '—'}</td>
                    <td><Chip tone={PURGE_TONE[p.status] ?? 'neutral'}>{p.status.replace(/_/g, ' ').toLowerCase()}</Chip>{p.error && <div className="pf-row-error">{p.error}</div>}</td>
                    <td>{p.requestedBy ?? '—'}</td>
                    <td>{p.confirmedBy ? `${p.confirmedBy} · ${relTime(p.confirmedAt)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog open={!!requestFor} onClose={() => setRequestFor(null)} danger={false} confirmLabel="Create purge request" title="Request purge"
        message={<>Create a purge request for <b>{requestFor?.label}</b> older than <b>{fmtDate(requestFor?.cutoff)}</b> (~{fmtNum(requestFor?.rows)} rows)? Nothing is deleted until the request is explicitly confirmed.</>}
        onConfirm={() => requestFor && request.mutate(requestFor.dataType)} />
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} confirmLabel="Permanently delete" requireText={confirm?.dataType}
        title="Confirm purge — this cannot be undone"
        message={<div className="stack" style={{ gap: 8 }}>
          <div className="pf-callout danger"><AlertTriangle size={14} /><div>Permanently delete <b>~{fmtNum(confirm?.estimatedRows)}</b> rows of <b>{RET_FIELDS.find((f) => f.dataType === confirm?.dataType)?.label}</b> older than <b>{fmtDate(confirm?.cutoff)}</b>.{confirm?.dataType === 'artifacts' && ' Files are removed from object storage too.'}</div></div>
          <span className="muted">Requested {relTime(confirm?.requestedAt)}{confirm?.requestedBy ? ` by ${confirm.requestedBy}` : ''}. Requests older than 24 h must be re-created.</span>
        </div>}
        onConfirm={() => confirm && exec.mutate(confirm)} />
    </div>
  );
}
