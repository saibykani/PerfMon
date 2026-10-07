import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FlaskConical, HelpCircle, XCircle } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Field, Kpi } from '@/components/ui';
import { Chart } from '@/charts/Chart';
import { xyOption } from '@/charts/builders';
import { fmtMs, fmtNum, fmtPct } from '@/components/format';
import { Seg } from '@/components/inventory/common';
import { estimateErrorPct, type Confidence, type Projection, type ProjectionInput } from './model';

export interface ProjectionDefaults { currentTps: number | null; currentP95: number | null; currentUsers: number | null; currentCpu: number | null; runKey: string | null }

/** Confidence label: word first, 3 bars as a secondary cue (never colour alone). */
export function ConfidenceChip({ value }: { value: Confidence }) {
  const lvl = value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : 1;
  return (
    <span className={`cap-conf lvl-${lvl}`} title={`${value.toLowerCase()} confidence — an estimate, validate with a load test at the target level`}>
      <span className="cap-conf-bars" aria-hidden>{[0, 1, 2].map((i) => <i key={i} className={i < lvl ? 'on' : ''} />)}</span>
      {value} confidence
    </span>
  );
}

export const EstimateTag = () => <span className="cap-estimate" title="Derived from measured runs and stated assumptions — not a measurement">Estimate</span>;

const numOr = (s: string) => (s.trim() === '' ? undefined : Number(s));
const str = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '' : String(+v.toFixed(d)));

export function ProjectionPanel({ testId, defaults, slaP95, errorSla, errPts }: {
  testId: string | null; defaults: ProjectionDefaults; slaP95: number | null; errorSla: number | null; errPts: { tps: number; errorPct: number }[];
}) {
  const theme = useUi((s) => s.theme);
  const [mode, setMode] = useState<'tps' | 'users'>('tps');
  const [f, setF] = useState(() => ({
    currentTps: str(defaults.currentTps, 2), currentP95: str(defaults.currentP95, 0), currentUsers: str(defaults.currentUsers, 0), currentCpu: str(defaults.currentCpu, 1),
    targetTps: defaults.currentTps ? str(defaults.currentTps * 1.5, 1) : '', targetUsers: defaults.currentUsers ? String(Math.round(defaults.currentUsers * 1.5)) : '', slaP95: '',
  }));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const cur = { tps: numOr(f.currentTps), p95: numOr(f.currentP95), users: numOr(f.currentUsers), cpu: numOr(f.currentCpu) };
  const tpsPerUser = cur.tps && cur.users ? cur.tps / cur.users : null;
  const targetUsers = numOr(f.targetUsers);
  const targetTps = mode === 'tps' ? numOr(f.targetTps) : targetUsers && tpsPerUser ? targetUsers * tpsPerUser : undefined;

  const errors: string[] = [];
  if (!cur.tps || cur.tps <= 0) errors.push('Current TPS must be a positive number.');
  if (!cur.p95 || cur.p95 <= 0) errors.push('Current P95 must be a positive number (ms).');
  if (cur.cpu != null && (!Number.isFinite(cur.cpu) || cur.cpu < 0 || cur.cpu > 100)) errors.push('Current CPU must be between 0 and 100 %.');
  if (cur.users != null && (!Number.isInteger(cur.users) || cur.users <= 0)) errors.push('Current users must be a positive whole number.');
  if (mode === 'users') {
    if (!targetUsers || !Number.isInteger(targetUsers) || targetUsers <= 0) errors.push('Target users must be a positive whole number.');
    else if (!tpsPerUser) errors.push('Enter current users so target users can be converted to TPS.');
  } else if (!targetTps || targetTps <= 0) errors.push('Target TPS must be a positive number.');
  const sla = numOr(f.slaP95);
  if (sla != null && !(sla > 0)) errors.push('P95 SLA override must be a positive number (ms).');

  const m = useMutation({
    mutationFn: (body: ProjectionInput) => api.post<Projection>('/capacity/project', body),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (errors.length) return;
    const body: ProjectionInput = { currentTps: cur.tps!, targetTps: +targetTps!.toFixed(3), currentP95: cur.p95! };
    if (testId) body.testId = testId;
    if (cur.users) body.currentUsers = cur.users;
    if (mode === 'users' && targetUsers) body.targetUsers = targetUsers;
    if (cur.cpu != null) body.currentCpu = cur.cpu;
    if (sla) body.slaP95 = sla;
    m.mutate(body);
  };

  const res = m.data;
  const sent = m.variables;
  const effSla = sent?.slaP95 ?? slaP95;
  const err = useMemo(() => (sent ? estimateErrorPct(errPts, sent.targetTps) : null), [errPts, sent]);
  const saturated = !!res && res.projected.p95 == null && res.assumptions.some((a) => /saturate/i.test(a));

  const chart = useMemo(() => {
    if (!res || !sent || !res.curve.length) return null;
    const pts: { name: string; data: [number, number][]; slot?: number }[] = [{ name: 'Current (measured)', data: [[sent.currentTps, sent.currentP95]], slot: 0 }];
    if (res.projected.p95 != null) pts.push({ name: 'Target (estimate)', data: [[sent.targetTps, res.projected.p95]], slot: 4 });
    return xyOption({
      theme, xUnit: 'tps', yUnit: 'ms', xName: 'TPS', yName: 'P95',
      lines: [{ name: 'Projected P95 (estimate)', data: res.curve.map((c) => [c.tps, c.p95]), slot: 1, dashed: true }], points: pts,
      refX: [{ value: sent.targetTps, label: 'target' }],
      refY: effSla ? [{ value: effSla, label: `P95 SLA ${fmtMs(effSla)}`, level: 'critical' }] : [],
    });
  }, [res, sent, theme, effSla]);

  const slaStatus = res?.meetsSla == null ? null : res.meetsSla ? 'pass' : 'fail';
  return (
    <Card title={<span className="row" style={{ gap: 6 }}><FlaskConical size={13} />What-if projection</span>} actions={<EstimateTag />}>
      <div className="cap-proj">
        <form className="cap-form" onSubmit={submit} noValidate>
          <div className="cap-form-sec">Current load{defaults.runKey && <span className="muted small"> · prefilled from {defaults.runKey}</span>}</div>
          <div className="cap-form-grid">
            <Field label="Current TPS *"><input className="input" inputMode="decimal" value={f.currentTps} onChange={set('currentTps')} /></Field>
            <Field label="Current P95 (ms) *"><input className="input" inputMode="decimal" value={f.currentP95} onChange={set('currentP95')} /></Field>
            <Field label="Current users"><input className="input" inputMode="numeric" value={f.currentUsers} onChange={set('currentUsers')} /></Field>
            <Field label="Current CPU %" hint="Enables the Utilization Law"><input className="input" inputMode="decimal" value={f.currentCpu} onChange={set('currentCpu')} /></Field>
          </div>
          <div className="cap-form-sec row" style={{ justifyContent: 'space-between' }}>
            <span>Target</span>
            <Seg label="Target by" value={mode} onChange={setMode} options={[{ value: 'tps', label: 'TPS' }, { value: 'users', label: 'Users' }]} />
          </div>
          <div className="cap-form-grid">
            {mode === 'tps'
              ? <Field label="Target TPS *"><input className="input" inputMode="decimal" value={f.targetTps} onChange={set('targetTps')} /></Field>
              : <Field label="Target users *" hint={targetTps ? `≈ ${fmtNum(targetTps, 1)} TPS at ${fmtNum(tpsPerUser, 3)} TPS/user` : undefined}><input className="input" inputMode="numeric" value={f.targetUsers} onChange={set('targetUsers')} /></Field>}
            <Field label="P95 SLA override (ms)" hint={slaP95 ? `Test SLA: ${fmtMs(slaP95)}` : 'No P95 SLA on the test'}><input className="input" inputMode="decimal" value={f.slaP95} onChange={set('slaP95')} placeholder={slaP95 ? String(slaP95) : ''} /></Field>
          </div>
          {errors.length > 0 && <ul className="cap-errors" role="alert">{errors.map((x) => <li key={x}>{x}</li>)}</ul>}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={!!errors.length || m.isPending}>{m.isPending ? 'Projecting…' : 'Project'}</button>
            <span className="muted small">{testId ? 'Uses the selected test’s fitted model and SLA.' : 'No test selected — the generic Utilization-Law model is used.'}</span>
          </div>
          <ErrorBox error={m.error} />
        </form>

        <div className="cap-result" aria-live="polite">
          {!res ? (
            <div className="cap-result-empty">
              <HelpCircle size={18} />
              <div>Enter a target load and press <b>Project</b> to estimate P95, CPU, users and error rate at that load.</div>
              <div className="muted small">Projections are estimates with a stated confidence; confirm capacity decisions with a load test at the target level.</div>
            </div>
          ) : (
            <div className="stack">
              <div className="row wrap">
                <EstimateTag /><ConfidenceChip value={res.confidence} />
                {slaStatus && <span className={`badge ${slaStatus}`}>{slaStatus === 'pass' ? <CheckCircle2 size={11} /> : <XCircle size={11} />}{slaStatus === 'pass' ? 'Within P95 SLA' : 'Breaches P95 SLA'}</span>}
                {saturated && <span className="badge fail"><AlertTriangle size={11} />Saturated</span>}
              </div>
              <div className="cap-method"><b>Method:</b> {res.method}</div>
              <div className="cap-kpis">
                <Kpi label={`P95 @ ${fmtNum(sent!.targetTps, 1)} TPS`} value={res.projected.p95 != null ? `≈ ${fmtMs(res.projected.p95)}` : saturated ? 'Unbounded' : '—'} sub={`now ${fmtMs(sent!.currentP95)}`} status={slaStatus} />
                <Kpi label="CPU (estimate)" value={res.projected.cpuPct != null ? `≈ ${fmtPct(res.projected.cpuPct, 0)}` : '—'} sub={sent!.currentCpu != null ? `now ${fmtPct(sent!.currentCpu, 0)}` : 'no CPU input'}
                  status={res.projected.cpuPct == null ? null : res.projected.cpuPct >= 85 ? 'fail' : res.projected.cpuPct >= 70 ? 'warn' : 'pass'} />
                <Kpi label="Users (estimate)" value={res.projected.users != null ? `≈ ${fmtNum(res.projected.users)}` : '—'} sub={res.projected.tpsPerUser != null ? `${fmtNum(res.projected.tpsPerUser, 3)} TPS/user` : 'no users input'} />
                <Kpi label="Error rate (estimate)" value={err?.value != null ? `≈ ${fmtPct(err.value, 2)}` : '—'} sub={err ? `${err.confidence.toLowerCase()} confidence${errorSla != null ? ` · SLA ${fmtPct(errorSla, 1)}` : ''}` : undefined}
                  status={err?.value == null || errorSla == null ? null : err.value <= errorSla ? 'pass' : 'fail'} title={err?.method} />
                <Kpi label="Headroom" value={res.headroomPct != null ? `${res.headroomPct > 0 ? '' : '−'}${fmtPct(Math.abs(res.headroomPct), 0)}` : '—'}
                  sub={res.headroomPct == null ? 'needs SLA or CPU' : effSla != null && res.projected.p95 != null ? 'margin to P95 SLA' : 'CPU remaining'} status={res.headroomPct == null ? null : res.headroomPct >= 20 ? 'pass' : res.headroomPct >= 0 ? 'warn' : 'fail'} />
              </div>
              {chart && <Chart title="Projected P95 vs load" subtitle="estimate" height={220} option={chart} table={{ columns: ['TPS', 'Projected P95 (ms)'], rows: res.curve.map((c) => [c.tps, c.p95]) }} />}
              <div>
                <div className="cap-form-sec">Assumptions</div>
                <ul className="cap-assumptions">
                  {res.assumptions.map((a) => <li key={a}>{a}</li>)}
                  {err && <li>Error rate: {err.method}</li>}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
