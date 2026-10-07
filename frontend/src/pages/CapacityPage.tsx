import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Info, LineChart, Target } from 'lucide-react';
import { api } from '@/services/api';
import { useFilters } from '@/stores/filters';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Kpi, Loading, PageHeader } from '@/components/ui';
import { GlobalFilterBar } from '@/components/GlobalFilters';
import { DataTable, type Column } from '@/components/DataTable';
import { Chart } from '@/charts/Chart';
import { xyOption } from '@/charts/builders';
import { fmtDate, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { EmptyState, Seg } from '@/components/inventory/common';
import { fitCurve, resolveFit, slaFromProfile, type CapacityModel, type Observation } from '@/components/capacity/model';
import { EstimateTag, ProjectionPanel } from '@/components/capacity/ProjectionPanel';
import '@/styles/capacity.css';

interface RunRow { runId: string; buildNumber: string | null; startedAt: string | null; testName: string; kpis?: { errorPct: number | null; tps: number | null } | null }
interface TestRow { id: string; project_id: string; name: string; application_name: string | null; environment_name: string | null; project_name: string | null; run_count?: number; sla_profile_id: string | null; environment_id: string | null }
interface SlaProfile { id: string; rules: { metric: string; scope: string; enabled: boolean; position: number; warning_value: number | null; critical_value: number | null }[] }
type Obs = Observation & { errorPct: number | null; buildNumber: string | null; startedAt: string | null };

export function CapacityPage() {
  const f = useFilters();
  const nav = useNavigate();
  const theme = useUi((s) => s.theme);
  const [xAxis, setXAxis] = useState<'tps' | 'users'>('tps');
  const ready = !!(f.testId || f.environmentId);

  const model = useQuery({
    queryKey: ['capacity-model', f.projectId, f.testId, f.environmentId],
    queryFn: () => api.get<CapacityModel>('/capacity/model', { testId: f.testId, environmentId: f.environmentId, projectId: f.projectId }),
    enabled: ready,
  });
  const runs = useQuery({
    queryKey: ['capacity-runs', f.projectId, f.applicationId, f.testId, f.environmentId],
    queryFn: () => api.get<{ items: RunRow[] }>('/runs', { projectId: f.projectId, applicationId: f.applicationId, testId: f.testId, environmentId: f.environmentId, status: 'COMPLETED', pageSize: 100, sort: 'start', order: 'desc' }),
    enabled: ready,
  });
  const test = useQuery({ queryKey: ['test', f.testId], queryFn: () => api.get<TestRow>(`/tests/${f.testId}`), enabled: !!f.testId });
  const profiles = useQuery({ queryKey: ['sla-profiles', test.data?.project_id], queryFn: () => api.get<SlaProfile[]>('/sla/profiles', { projectId: test.data!.project_id }), enabled: !!test.data?.sla_profile_id });
  const tests = useQuery({ queryKey: ['tests', { projectId: f.projectId, applicationId: f.applicationId }], queryFn: () => api.get<TestRow[]>('/tests', { projectId: f.projectId, applicationId: f.applicationId }), enabled: !ready, staleTime: 60000 });

  const rules = profiles.data?.find((p) => p.id === test.data?.sla_profile_id)?.rules;
  const slaP95 = model.data?.slaP95 ?? slaFromProfile(rules, 'p95');
  const errorSla = slaFromProfile(rules, 'error_pct');
  const fit = useMemo(() => resolveFit(model.data), [model.data]);

  const obs: Obs[] = useMemo(() => {
    const byKey = new Map((runs.data?.items ?? []).map((r) => [r.runId, r]));
    return (model.data?.observations ?? []).map((o) => {
      const r = byKey.get(o.runKey);
      return { ...o, errorPct: r?.kpis?.errorPct ?? null, buildNumber: r?.buildNumber ?? null, startedAt: r?.startedAt ?? null };
    });
  }, [model.data, runs.data]);
  const usable = obs.filter((o) => o.tps != null && o.p95 != null && o.tps > 0 && o.p95 > 0);
  const latest = usable[usable.length - 1] ?? null; // observations are chronological (oldest → newest)
  const sat = model.data?.estimatedSaturationTps ?? null;
  const headroom = sat && latest?.tps ? ((sat - latest.tps) / sat) * 100 : null;
  const errPts = useMemo(() => obs.filter((o) => o.tps != null && o.errorPct != null).map((o) => ({ tps: o.tps!, errorPct: Number(o.errorPct) })), [obs]);

  const mainChart = useMemo(() => {
    if (!usable.length) return null;
    const xOf = (o: Obs) => (xAxis === 'tps' ? o.tps : o.users);
    const pts = usable.filter((o) => xOf(o) != null);
    const older = pts.filter((o) => o !== latest);
    const points = [
      { name: 'Completed runs', data: older.map((o) => [xOf(o)!, o.p95!] as [number, number]), labels: older.map((o) => o.runKey), slot: 0 },
      ...(latest && xOf(latest) != null ? [{ name: 'Latest run', data: [[xOf(latest)!, latest.p95!] as [number, number]], labels: [latest.runKey], slot: 4 }] : []),
    ];
    const lines = [];
    if (xAxis === 'tps' && fit) {
      const hi = Math.max(fit.maxTps * 1.3, sat ? sat * 1.1 : 0);
      lines.push({ name: `Fitted ${fit.type} model (estimate)`, data: fitCurve(fit, Math.max(0, fit.minTps * 0.6), hi), slot: 1, dashed: true });
    }
    return { ...xyOption({
      theme, points, lines, xUnit: xAxis === 'tps' ? 'tps' : undefined, yUnit: 'ms', xName: xAxis === 'tps' ? 'Throughput (TPS)' : 'Peak users', yName: 'P95',
      refX: xAxis === 'tps' && sat ? [{ value: sat, label: `est. saturation ≈ ${fmtNum(sat, 1)} TPS` }] : [],
      refY: slaP95 ? [{ value: slaP95, label: `P95 SLA ${fmtMs(slaP95)}`, level: 'critical' }] : [],
    }), legend: { show: true, left: 56 } };
  }, [usable, latest, xAxis, fit, sat, slaP95, theme]);

  const cpuPts = usable.filter((o) => o.cpuAvg != null);
  const side = (pts: [number, number][], name: string, yUnit: string, slot: number, ref?: { value: number; label: string } | null) =>
    xyOption({ theme, points: [{ name, data: pts, slot }], xUnit: 'tps', yUnit, xName: 'TPS', yName: name, refY: ref ? [{ ...ref, level: 'critical' }] : [] });

  const openRun = (p: any) => { if (p?.name) nav(`/runs/${p.name}`); };

  const cols: Column<Obs>[] = [
    { key: 'runKey', header: 'Run', render: (o) => <Link className="mono" to={`/runs/${o.runKey}`}>{o.runKey}</Link> },
    { key: 'startedAt', header: 'Started', value: (o) => (o.startedAt ? +new Date(o.startedAt) : null), render: (o) => fmtDate(o.startedAt) },
    { key: 'buildNumber', header: 'Build', render: (o) => o.buildNumber ?? '—' },
    { key: 'users', header: 'Users', align: 'right', render: (o) => fmtNum(o.users) },
    { key: 'tps', header: 'TPS', align: 'right', render: (o) => fmtNum(o.tps, 2) },
    { key: 'p95', header: 'P95', align: 'right', render: (o) => fmtMs(o.p95) },
    { key: 'fit', header: 'Model P95', align: 'right', sortable: false, value: () => null, render: (o) => (fit && o.tps ? <span className="muted" title="Fitted model value at this TPS (estimate)">≈ {fmtMs(fit.type === 'linear' ? fit.a + fit.b * o.tps : Math.exp(fit.a + fit.b * o.tps))}</span> : '—') },
    { key: 'cpuAvg', header: 'CPU avg', align: 'right', render: (o) => fmtPct(o.cpuAvg, 1) },
    { key: 'errorPct', header: 'Errors', align: 'right', render: (o) => fmtPct(o.errorPct, 2) },
  ];

  const suggestions = (tests.data ?? []).filter((t) => (t.run_count ?? 0) > 0).sort((a, b) => (b.run_count ?? 0) - (a.run_count ?? 0)).slice(0, 6);

  return (
    <div className="cap-page">
      <PageHeader title="Capacity Planning" subtitle="Latency-vs-load model fitted from completed runs, estimated saturation, headroom and what-if projections. Every figure here is an estimate."
        actions={<Link className="btn" to="/help/capacity-planning"><Info size={14} />How it works</Link>} />
      <GlobalFilterBar show={['project', 'application', 'environment', 'test']} />

      {!ready ? (
        <Card>
          <EmptyState icon={<Target size={22} />} title="Pick a test or an environment">
            The model needs completed runs of one test (or one environment) at several load levels. Choose a <b>test</b> and/or <b>environment</b> in the filter bar above.
          </EmptyState>
          {suggestions.length > 0 && (
            <div className="cap-suggest">
              <div className="muted small">Tests with completed runs</div>
              <div className="cap-suggest-list">
                {suggestions.map((t) => (
                  <button key={t.id} className="cap-suggest-item" onClick={() => f.set({ projectId: t.project_id, testId: t.id, environmentId: t.environment_id ?? null })}>
                    <b>{t.name}</b><span className="muted small">{[t.project_name, t.application_name, t.environment_name].filter(Boolean).join(' · ')}</span>
                    <span className="badge">{t.run_count} runs</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <div className="stack">
          <ErrorBox error={model.error ?? runs.error} />
          <div className="cap-kpis">
            <Kpi label="Runs modelled" value={model.isLoading ? '…' : fmtNum(obs.length)} sub={model.data ? `${usable.length} with TPS & P95` : undefined} />
            <Kpi label="Latency model" value={model.isLoading ? '…' : model.data?.model.type === 'insufficient' ? 'Insufficient' : model.data?.model.type ?? '—'}
              sub={model.data?.model.r2 != null ? `R² ${model.data.model.r2.toFixed(2)} · ${model.data.model.r2 >= 0.8 ? 'good' : model.data.model.r2 >= 0.5 ? 'moderate' : 'weak'} fit` : 'needs ≥3 load levels'}
              status={model.data?.model.r2 == null ? null : model.data.model.r2 >= 0.8 ? 'pass' : model.data.model.r2 >= 0.5 ? 'warn' : 'fail'} />
            <Kpi label="Est. saturation" value={sat != null ? `≈ ${fmtNum(sat, 1)}` : '—'} unit={sat != null ? 'TPS' : undefined} sub={sat != null ? 'estimate — see notes' : 'not estimable yet'} />
            <Kpi label="Current load" value={latest ? fmtNum(latest.tps, 1) : '—'} unit={latest ? 'TPS' : undefined} sub={latest ? `${latest.runKey} · P95 ${fmtMs(latest.p95)}` : undefined} />
            <Kpi label="Headroom" value={headroom != null ? `${headroom >= 0 ? '' : '−'}${fmtPct(Math.abs(headroom), 0)}` : '—'}
              sub={headroom != null && latest?.tps ? `≈ ${(sat! / latest.tps).toFixed(1)}× current load (estimate)` : 'needs a saturation estimate'}
              status={headroom == null ? null : headroom >= 30 ? 'pass' : headroom >= 10 ? 'warn' : 'fail'} />
            <Kpi label="P95 SLA" value={slaP95 != null ? fmtMs(slaP95) : '—'} sub={slaP95 != null ? 'from the test’s SLA profile' : f.testId ? 'no RUN-scope P95 rule' : 'select a test'} />
          </div>

          <div className="cap-split">
            <Card title={<span className="row" style={{ gap: 6 }}><LineChart size={13} />Latency vs load</span>}
              actions={<><EstimateTag /><Seg label="X axis" value={xAxis} onChange={setXAxis} options={[{ value: 'tps', label: 'TPS' }, { value: 'users', label: 'Users' }]} /></>}>
              {model.isLoading ? <Loading height={300} /> : !usable.length ? (
                <EmptyState icon={<Gauge size={22} />} title="No completed runs with TPS and P95">Complete runs of this test at different load levels (a step or stress test works best) to build the model.</EmptyState>
              ) : (
                <>
                  <Chart height={320} option={mainChart!} onPointClick={openRun}
                    table={{ columns: ['Run', 'Users', 'TPS', 'P95 (ms)'], rows: usable.map((o) => [o.runKey, o.users, o.tps == null ? null : +o.tps.toFixed(2), o.p95 == null ? null : Math.round(o.p95)]) }} />
                  <div className="cap-model-desc">
                    <b>Model:</b> {model.data?.model.description}
                    {xAxis === 'users' && fit && <span className="muted"> · the fitted curve is TPS-based and only drawn on the TPS axis.</span>}
                  </div>
                </>
              )}
            </Card>
            <Card title={<span className="row" style={{ gap: 6 }}><Info size={13} />Model notes</span>}>
              {model.isLoading ? <Loading height={200} /> : (
                <ul className="cap-notes">{(model.data?.notes ?? []).map((n) => <li key={n}>{n}</li>)}</ul>
              )}
            </Card>
          </div>

          {model.data && (
            <ProjectionPanel key={`${f.testId}|${f.environmentId}|${latest?.runKey ?? ''}`} testId={f.testId ?? null} slaP95={slaP95} errorSla={errorSla} errPts={errPts}
              defaults={{ currentTps: latest?.tps ?? null, currentP95: latest?.p95 ?? null, currentUsers: latest?.users ?? null, currentCpu: latest?.cpuAvg ?? null, runKey: latest?.runKey ?? null }} />
          )}

          {usable.length > 0 && (
            <div className="cap-grid-2">
              <Card title="CPU vs load">
                {cpuPts.length ? <Chart height={220} onPointClick={openRun} option={side(cpuPts.map((o) => [o.tps!, o.cpuAvg!]), 'CPU avg', '%', 0, { value: 85, label: '85% planning limit' })} />
                  : <EmptyState icon={<Gauge size={20} />} title="No CPU data for these runs">Run the Perfmon Collector on the application servers during tests to add CPU to the model (Utilization Law). <Link to="/help/server-monitoring">Server monitoring guide</Link></EmptyState>}
              </Card>
              <Card title="Error rate vs load">
                {errPts.length ? <Chart height={220} option={side(errPts.map((p) => [p.tps, p.errorPct]), 'Error rate', '%', 7, errorSla != null ? { value: errorSla, label: `error SLA ${fmtPct(errorSla, 1)}` } : null)} />
                  : <EmptyState title="No error-rate data">Error rates come from the completed runs’ summaries.</EmptyState>}
              </Card>
            </div>
          )}

          <div className="card">
            <DataTable rows={[...obs].reverse()} columns={cols} rowKey={(o) => o.runKey} loading={model.isLoading} exportName="capacity-observations" maxHeight={420}
              empty={<EmptyState title="No completed runs match the selection" />} />
          </div>
        </div>
      )}
    </div>
  );
}
