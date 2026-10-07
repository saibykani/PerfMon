import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Chart } from '@/charts/Chart';
import { donutOption, histogramOption, categoryLineOption, timeSeriesOption, seriesTable, type TsSeries } from '@/charts/builders';
import { seriesColor } from '@/charts/palette';
import { Kpi, ErrorBox } from '@/components/ui';
import { fmtMs, fmtNum, fmtPct } from '@/components/format';
import { ApproxNote, EmptyState, SidePanel, SkeletonGrid, StatusChip } from './common';
import { SyncedCharts } from './SyncedCharts';
import type { Bucket, SeriesPoint, TimeWindow, WindowStats } from './types';

/** Response code → colour following the code class (always shown with the code label). */
export function codeColor(theme: 'light' | 'dark', code: string) {
  const c = code[0];
  return seriesColor(theme, c === '2' ? 2 : c === '3' ? 0 : c === '4' ? 3 : c === '5' ? 7 : 6);
}

export function LatencyHistogram({ buckets, p95, p99, title = 'Latency distribution', height = 220 }: { buckets: Bucket[] | null | undefined; p95?: number | null; p99?: number | null; title?: string; height?: number }) {
  const theme = useUi((s) => s.theme);
  const opt = useMemo(() => histogramOption({ theme, buckets: buckets ?? [], markers: [p95 != null ? { value: p95, label: 'P95' } : null, p99 != null ? { value: p99, label: 'P99' } : null].filter(Boolean) as any }), [theme, buckets, p95, p99]);
  return (
    <Chart title={title} option={opt} height={height}
      empty={!buckets?.length ? 'Latency distribution requires raw samples (upload a JTL or send JSON samples). Pre-aggregated sources only report percentiles.' : null}
      table={{ columns: ['From (ms)', 'To (ms)', 'Samples'], rows: (buckets ?? []).map((b) => [+b.from.toFixed(1), +b.to.toFixed(1), b.count]) }} />
  );
}

export function CodesDonut({ codes, title = 'Response codes', height = 200 }: { codes: { code: string; n: number }[]; title?: string; height?: number }) {
  const theme = useUi((s) => s.theme);
  const items = useMemo(() => {
    const sorted = [...codes].sort((a, b) => b.n - a.n);
    const top = sorted.slice(0, 5);
    const rest = sorted.slice(5).reduce((a, x) => a + x.n, 0);
    return [...top.map((c) => ({ name: c.code, value: c.n, color: codeColor(theme, c.code) })), ...(rest ? [{ name: 'Other', value: rest, color: seriesColor(theme, 6) }] : [])];
  }, [codes, theme]);
  return <Chart title={title} option={donutOption({ theme, items })} height={height} empty={!codes.length ? 'No response codes recorded' : null}
    table={{ columns: ['Code', 'Count'], rows: codes.map((c) => [c.code, c.n]) }} />;
}

function HistoryCharts({ rows, current, group }: { rows: { key: string; avg: number | null; p95: number | null; p99?: number | null; err: number | null; tps?: number | null }[]; current: string; group?: string }) {
  const theme = useUi((s) => s.theme);
  if (rows.length < 2) return <EmptyState icon={<BarChart3 size={22} />} title="Not enough history yet">Comparison against previous runs appears once this test has at least two completed runs.</EmptyState>;
  const cats = rows.map((r) => (r.key === current ? `${r.key.slice(-6)} ●` : r.key.slice(-6)));
  return (
    <div className="grid g2">
      <Chart title="Response time across runs" subtitle="● = this run" height={180} group={group}
        option={categoryLineOption({ theme, categories: cats, unit: 'ms', series: [{ name: 'P95', key: 'p95', data: rows.map((r) => r.p95) }, ...(rows.some((r) => r.p99 != null) ? [{ name: 'P99', key: 'p99', data: rows.map((r) => r.p99 ?? null) }] : []), { name: 'Avg', key: 'avg', data: rows.map((r) => r.avg), dashed: true }].filter((s) => s.data.some((v) => v != null)) })}
        table={{ columns: ['Run', 'Avg (ms)', 'P95 (ms)', 'Error %'], rows: rows.map((r) => [r.key, r.avg == null ? null : Math.round(r.avg), r.p95 == null ? null : Math.round(r.p95), r.err == null ? null : +r.err.toFixed(2)]) }} />
      <Chart title="Error rate across runs" height={180}
        option={categoryLineOption({ theme, categories: cats, unit: '%', series: [{ name: 'Error %', key: 'errorPct', data: rows.map((r) => r.err) }] })}
        table={{ columns: ['Run', 'Error %'], rows: rows.map((r) => [r.key, r.err == null ? null : +r.err.toFixed(2)]) }} />
    </div>
  );
}

interface TxnDetail {
  name: string; source: string; stats: WindowStats | null; series: { step: number; percentileMethod: string; points: SeriesPoint[] };
  responseCodes: { response_code: string; success: boolean; n: number }[]; failures: { error_type: string; response_code: string | null; message: string | null; n: number }[];
  latencyDistribution: Bucket[] | null; sla: { metric: string; actual_value: number | null; warning_value: number | null; critical_value: number | null; status: string; unit: string | null }[];
  history: { id: string; run_key: string; build_number: string | null; started_at: string; samples: number; tps: number; avg_rt: number; p95: number; p99: number; error_pct: number }[];
}

/** Transaction drill-down: trends, codes, distribution, failures, SLA, history. Shared by the run tab and /transactions. */
export function TransactionDrilldown({ runId, name, range, onClose }: { runId: string; name: string | null; range?: TimeWindow; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['txn-detail', runId, name, range?.from, range?.to],
    queryFn: () => api.get<TxnDetail>(`/runs/${encodeURIComponent(runId)}/transactions/detail`, { name: name!, from: range?.from, to: range?.to }),
    enabled: !!name,
  });
  const d = q.data;
  const s = d?.stats;
  const approx = s?.percentileMethod === 'interval_weighted_approx' ? '≈ ' : '';
  const theme = useUi((st) => st.theme);
  const group = `txn-${name}`;
  const errSeries: TsSeries[] = d ? [{ name: 'Errors', key: 'errors', data: d.series.points.map((p) => [p.t, p.errors]) }] : [];
  return (
    <SidePanel open={!!name} onClose={onClose} title={<span className="mono">{name}</span>}
      subtitle={<>Transaction drill-down · <span className="mono">{runId}</span>{range ? ' · selected range' : ''} {d && <ApproxNote method={s?.percentileMethod} compact />}</>}>
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <><SkeletonGrid count={6} /><div className="skeleton" style={{ height: 300, marginTop: 12 }} /></>}
      {d && (
        <div className="stack">
          <div className="kpis">
            <Kpi label="Requests" value={fmtNum(s?.totalSamples)} />
            <Kpi label="TPS" value={fmtNum(s?.tpsAvg, 2)} unit="/s" />
            <Kpi label="Avg" value={fmtMs(s?.avgRt)} />
            <Kpi label="P95" value={`${approx}${fmtMs(s?.p95)}`} />
            <Kpi label="P99" value={`${approx}${fmtMs(s?.p99)}`} />
            <Kpi label="Min / Max" value={<span style={{ fontSize: 15 }}>{fmtMs(s?.minRt)} / {fmtMs(s?.maxRt)}</span>} />
            <Kpi label="Errors" value={fmtNum(s?.failureCount)} status={s?.failureCount ? 'fail' : 'pass'} sub={fmtPct(s?.errorPct)} />
          </div>
          <SyncedCharts points={d.series.points} panels={['rt', 'tps', 'errors']} percentileMethod={d.series.percentileMethod} group={group} height={150} />
          <Chart title="Errors per interval" height={130} group={group} option={timeSeriesOption({ theme, series: errSeries, min: 0 })} table={seriesTable(errSeries)}
            empty={!d.series.points.some((p) => p.errors) ? 'No errors in this transaction' : null} />
          <div className="grid g2">
            <CodesDonut codes={d.responseCodes.map((c) => ({ code: c.response_code, n: c.n }))} />
            <LatencyHistogram buckets={d.latencyDistribution} p95={s?.p95} p99={s?.p99} height={200} />
          </div>
          <section className="card">
            <div className="card-head"><h3>Failure reasons</h3><span className="muted small">{d.failures.length} distinct</span></div>
            {d.failures.length ? (
              <div className="table-wrap" style={{ maxHeight: 240 }}>
                <table className="table"><thead><tr><th>Type</th><th>Code</th><th>Message</th><th className="r">Count</th></tr></thead>
                  <tbody>{d.failures.map((f, i) => <tr key={i}><td>{f.error_type}</td><td className="mono">{f.response_code ?? '—'}</td><td className="wrap-cell">{f.message ?? '—'}</td><td className="r num">{fmtNum(f.n)}</td></tr>)}</tbody></table>
              </div>
            ) : <div className="empty small">No failures recorded for this transaction.</div>}
          </section>
          <section className="card">
            <div className="card-head"><h3>SLA results</h3></div>
            {d.sla.length ? (
              <table className="table"><thead><tr><th>Metric</th><th className="r">Actual</th><th className="r">Warning</th><th className="r">Critical</th><th>Status</th></tr></thead>
                <tbody>{d.sla.map((r, i) => <tr key={i}><td>{r.metric}</td><td className="r num">{fmtNum(r.actual_value, 1)} {r.unit}</td><td className="r num">{fmtNum(r.warning_value, 1)}</td><td className="r num">{fmtNum(r.critical_value, 1)}</td><td><StatusChip status={r.status} size="sm" /></td></tr>)}</tbody></table>
            ) : <div className="empty small">No transaction-level SLA rules apply.</div>}
          </section>
          <section className="card">
            <div className="card-head"><h3>Comparison against previous runs</h3><span className="muted small">{d.history.length} runs of this test</span></div>
            <div className="card-body">
              <HistoryCharts current={runId} rows={d.history.map((h) => ({ key: h.run_key, avg: h.avg_rt, p95: h.p95, p99: h.p99, err: h.error_pct, tps: h.tps }))} />
              {d.history.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10, maxHeight: 220 }}>
                  <table className="table"><thead><tr><th>Run</th><th>Build</th><th className="r">Requests</th><th className="r">TPS</th><th className="r">Avg</th><th className="r">P95</th><th className="r">Error %</th></tr></thead>
                    <tbody>{[...d.history].reverse().map((h) => <tr key={h.id} className={h.run_key === runId ? 'row-current' : ''}><td><Link className="mono" to={`/runs/${h.run_key}/transactions`}>{h.run_key}</Link></td><td>{h.build_number ?? '—'}</td><td className="r num">{fmtNum(Number(h.samples))}</td><td className="r num">{fmtNum(h.tps, 2)}</td><td className="r num">{fmtMs(h.avg_rt)}</td><td className="r num">{fmtMs(h.p95)}</td><td className="r num">{fmtPct(h.error_pct)}</td></tr>)}</tbody></table>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </SidePanel>
  );
}

interface EpDetail {
  endpoint: { id: string; method: string; path_template: string }; step: number;
  points: { t: number; count: number; tps: number; errors: number; avg: number | null; p95: number | null; p99: number | null }[];
  statusCodes: { code: string; n: number }[]; latencyDistribution: Bucket[] | null; p95: number | null; p99: number | null;
  history: { run_key: string; build_number: string | null; started_at: string; n: number; avg: number | null; err: number | null }[];
}

export function EndpointDrilldown({ runId, endpoint, onClose }: { runId: string; endpoint: { id: string; method: string; endpoint: string } | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ep-detail', runId, endpoint?.id], queryFn: () => api.get<EpDetail>(`/runs/${encodeURIComponent(runId)}/endpoints/${endpoint!.id}`), enabled: !!endpoint });
  const d = q.data;
  const pts: SeriesPoint[] = (d?.points ?? []).map((p) => ({ t: p.t, count: p.count, errors: p.errors, tps: p.tps, errorPct: p.count ? (p.errors / p.count) * 100 : null, avg: p.avg, min: null, max: null, p50: null, p90: null, p95: p.p95, p99: p.p99, users: null, sentBps: 0, receivedBps: 0 }));
  const total = pts.reduce((a, p) => a + p.count, 0);
  const errs = pts.reduce((a, p) => a + p.errors, 0);
  return (
    <SidePanel open={!!endpoint} onClose={onClose} title={<span className="row"><span className={`method m-${endpoint?.method}`}>{endpoint?.method}</span><span className="mono">{endpoint?.endpoint}</span></span>} subtitle={<>API endpoint drill-down · <span className="mono">{runId}</span></>}>
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <SkeletonGrid count={5} />}
      {d && (
        <div className="stack">
          <div className="kpis">
            <Kpi label="Requests" value={fmtNum(total)} />
            <Kpi label="Avg" value={fmtMs(total ? pts.reduce((a, p) => a + (p.avg ?? 0) * p.count, 0) / total : null)} />
            <Kpi label="P95" value={fmtMs(d.p95)} />
            <Kpi label="P99" value={fmtMs(d.p99)} />
            <Kpi label="Errors" value={fmtNum(errs)} sub={fmtPct(total ? (errs / total) * 100 : null)} status={errs ? 'fail' : 'pass'} />
          </div>
          <SyncedCharts points={pts} panels={['rt', 'tps', 'errors']} group={`ep-${endpoint?.id}`} height={150} />
          <div className="grid g2">
            <CodesDonut codes={d.statusCodes} title="Status codes" />
            <LatencyHistogram buckets={d.latencyDistribution} p95={d.p95} p99={d.p99} height={200} />
          </div>
          <section className="card">
            <div className="card-head"><h3>Comparison against previous runs</h3></div>
            <div className="card-body"><HistoryCharts current={runId} rows={d.history.map((h) => ({ key: h.run_key, avg: h.avg, p95: null, err: h.err }))} /></div>
          </section>
        </div>
      )}
    </SidePanel>
  );
}
