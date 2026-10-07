import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bug } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Chart } from '@/charts/Chart';
import { heatmapOption, stackedTimeBarsOption, timeSeriesOption, seriesTable, type TsSeries } from '@/charts/builders';
import { Kpi, ErrorBox } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtBytes, fmtDate, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { ApproxNote, EmptyState, Seg } from '../common';
import { SyncedCharts } from '../SyncedCharts';
import { CodesDonut, LatencyHistogram, codeColor } from '../Drilldowns';
import { useTimeline } from './OverviewTab';
import type { Bucket, RunDetail } from '../types';

const enc = encodeURIComponent;

export function ResponseTimeTab({ run, live }: { run: RunDetail; live: boolean }) {
  const theme = useUi((s) => s.theme);
  const tl = useTimeline(run.runId, live);
  const dist = useQuery({ queryKey: ['run-sub', run.runId, 'latency-dist'], queryFn: () => api.get<{ available: boolean; reason?: string; total?: number; buckets?: Bucket[] }>(`/runs/${enc(run.runId)}/latency-distribution`) });
  const heat = useQuery({ queryKey: ['run-sub', run.runId, 'latency-heat'], queryFn: () => api.get<{ available: boolean; reason?: string; times?: number[]; buckets?: string[]; cells?: [number, number, number][] }>(`/runs/${enc(run.runId)}/latency-heatmap`), retry: false });
  const pts = tl.data?.points ?? [];
  const s = run.summary;
  const ax = s?.percentileMethod === 'interval_weighted_approx' ? '≈ ' : '';
  const minmax: TsSeries[] = [{ name: 'Max', key: 'max', data: pts.map((p) => [p.t, p.max]) }, { name: 'Min', key: 'p50', data: pts.map((p) => [p.t, p.min]), dashed: true }];
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Avg" value={fmtMs(s?.avgRt)} />
        <Kpi label="Median" value={s?.p50 ?? s?.medianRt ? ax + fmtMs(s?.p50 ?? s?.medianRt) : '—'} />
        <Kpi label="P75" value={s?.p75 != null ? ax + fmtMs(s.p75) : '—'} />
        <Kpi label="P90" value={s?.p90 != null ? ax + fmtMs(s.p90) : '—'} />
        <Kpi label="P95" value={s?.p95 != null ? ax + fmtMs(s.p95) : '—'} />
        <Kpi label="P99" value={s?.p99 != null ? ax + fmtMs(s.p99) : '—'} />
        <Kpi label="P99.9" value={s?.p999 != null ? ax + fmtMs(s.p999) : '—'} />
        <Kpi label="Std dev" value={fmtMs(s?.stddevRt)} />
        <Kpi label="Min / Max" value={<span style={{ fontSize: 15 }}>{fmtMs(s?.minRt)} / {fmtMs(s?.maxRt)}</span>} />
      </div>
      <ApproxNote method={s?.percentileMethod} />
      <SyncedCharts points={pts} panels={['rt']} percentileMethod={tl.data?.percentileMethod} group={`rt-${run.runId}`} height={260} loading={tl.isLoading} />
      <Chart title="Min / max per interval" height={170} group={`rt-${run.runId}`} option={timeSeriesOption({ theme, series: minmax, unit: 'ms', min: 0 })} table={seriesTable(minmax)} empty={!pts.length ? 'No data' : null} />
      <div className="grid g2">
        <LatencyHistogram buckets={dist.data?.available ? dist.data.buckets : null} p95={s?.p95} p99={s?.p99} title={`Latency distribution${dist.data?.total ? ` · ${fmtNum(dist.data.total)} samples` : ''}`} height={260} />
        <Chart title="Latency heatmap" subtitle="time × latency bucket" height={260}
          option={heat.data?.available ? heatmapOption({ theme, times: heat.data.times!, buckets: heat.data.buckets!, cells: heat.data.cells! }) : {}}
          loading={heat.isLoading}
          empty={heat.error ? 'Heatmap could not be computed for this run (server error). Distribution and percentiles are still available.' : heat.data && !heat.data.available ? 'Latency heatmap requires raw samples (JTL upload or JSON samples). Pre-aggregated sources only report percentiles.' : null}
          table={heat.data?.available ? { columns: ['Time', 'Bucket', 'Samples'], rows: heat.data.cells!.map(([x, y, n]) => [new Date(heat.data!.times![x]).toLocaleTimeString(), heat.data!.buckets![y], n]) } : undefined} />
      </div>
    </div>
  );
}

export function ThroughputTab({ run, live }: { run: RunDetail; live: boolean }) {
  const tl = useTimeline(run.runId, live);
  const s = run.summary;
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="TPS avg" value={fmtNum(s?.tps, 2)} unit="/s" />
        <Kpi label="Peak TPS" value={fmtNum(s?.peakTps, 2)} unit="/s" />
        <Kpi label="Target TPS" value={fmtNum(run.targetTps, 1)} unit={run.targetTps ? '/s' : undefined} status={run.targetTps && s?.tps != null ? (s.tps >= run.targetTps * 0.95 ? 'pass' : s.tps >= run.targetTps * 0.8 ? 'warn' : 'fail') : null}
          sub={run.targetTps && s?.tps != null ? `${fmtPct((s.tps / run.targetTps) * 100, 0)} of target` : undefined} />
        <Kpi label="Requests" value={fmtNum(s?.requests)} />
        <Kpi label="Received" value={s?.receivedKbSec != null ? fmtBytes(s.receivedKbSec * 1024) : '—'} unit="/s" sub={`${fmtBytes(s?.bytesReceived)} total`} />
        <Kpi label="Sent" value={s?.sentKbSec != null ? fmtBytes(s.sentKbSec * 1024) : '—'} unit="/s" sub={`${fmtBytes(s?.bytesSent)} total`} />
        <Kpi label="Users peak" value={fmtNum(s?.usersPeak)} />
      </div>
      <SyncedCharts points={tl.data?.points ?? []} panels={['tps', 'users', 'throughput']} group={`thr-${run.runId}`} height={190} loading={tl.isLoading} />
    </div>
  );
}

type GroupBy = 'response_code' | 'transaction' | 'endpoint' | 'message' | 'error_type' | 'time';
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'response_code', label: 'HTTP status' }, { value: 'transaction', label: 'Sampler' }, { value: 'endpoint', label: 'Endpoint' },
  { value: 'message', label: 'Message' }, { value: 'error_type', label: 'Type' }, { value: 'time', label: 'Time' },
];
interface ErrGroup { key: string | null; count: number; types: string[]; sample_message: string | null; first_seen: string; last_seen: string; pctOfErrors: number; pctOfAll: number | null }

export function ErrorsTab({ run }: { run: RunDetail }) {
  const theme = useUi((s) => s.theme);
  const [g, setG] = useState<GroupBy>('response_code');
  const q = useQuery({ queryKey: ['run-sub', run.runId, 'errors', g], queryFn: () => api.get<any[]>(`/runs/${enc(run.runId)}/errors`, { groupBy: g }), placeholderData: (p) => p });
  const codes = useQuery({ queryKey: ['run-sub', run.runId, 'response-codes'], queryFn: () => api.get<{ step: number; distribution: { response_code: string; success: boolean; n: number }[]; series: { t: number; response_code: string; n: number }[] }>(`/runs/${enc(run.runId)}/response-codes`) });
  const s = run.summary;

  const timeSeries = useMemo(() => {
    if (g !== 'time' || !q.data) return [];
    const by = new Map<string, [number, number][]>();
    for (const r of q.data as { t: number; error_type: string; n: number }[]) { const a = by.get(r.error_type) ?? []; a.push([Number(r.t), r.n]); by.set(r.error_type, a); }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, data], i) => ({ name, slot: [7, 3, 4, 6, 5, 1][i % 6], data }));
  }, [g, q.data]);
  const codeSeries = useMemo(() => {
    const by = new Map<string, [number, number][]>();
    for (const r of codes.data?.series ?? []) { const a = by.get(r.response_code) ?? []; a.push([Number(r.t), r.n]); by.set(r.response_code, a); }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, data]) => ({ name, color: codeColor(theme, name), data }));
  }, [codes.data, theme]);

  const cols: Column<ErrGroup>[] = [
    { key: 'key', header: GROUPS.find((x) => x.value === g)?.label ?? 'Key', render: (r) => <span className={g === 'message' ? 'wrap-cell' : 'mono'}>{r.key ?? '(none)'}</span>, value: (r) => r.key ?? '' },
    { key: 'count', header: 'Errors', align: 'right', render: (r) => fmtNum(r.count) },
    { key: 'pctOfErrors', header: '% of errors', align: 'right', render: (r) => <span className="share"><span className="share-bar"><span style={{ width: `${r.pctOfErrors}%` }} /></span>{fmtPct(r.pctOfErrors, 1)}</span> },
    { key: 'pctOfAll', header: '% of all requests', align: 'right', render: (r) => fmtPct(r.pctOfAll, 3) },
    { key: 'types', header: 'Types', value: (r) => (r.types ?? []).join(', '), render: (r) => (r.types ?? []).map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>) },
    { key: 'sample_message', header: 'Sample message', render: (r) => <span className="wrap-cell muted">{r.sample_message ?? '—'}</span>, hidden: g === 'message' },
    { key: 'first_seen', header: 'First seen', render: (r) => fmtDate(r.first_seen) },
    { key: 'last_seen', header: 'Last seen', render: (r) => fmtDate(r.last_seen) },
  ];
  const totalErr = s?.failedRequests ?? 0;
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Failed requests" value={fmtNum(s?.failedRequests)} status={totalErr ? 'fail' : 'pass'} />
        <Kpi label="Error %" value={fmtPct(s?.errorPct)} status={s?.errorPct == null ? null : s.errorPct >= 5 ? 'fail' : s.errorPct >= 1 ? 'warn' : 'pass'} />
        <Kpi label="Distinct codes" value={fmtNum(codes.data?.distribution.length)} />
        <Kpi label="Non-2xx codes" value={fmtNum((codes.data?.distribution ?? []).filter((c) => !c.response_code.startsWith('2')).reduce((a, c) => a + c.n, 0))} />
      </div>
      <div className="grid g-1-2">
        <CodesDonut codes={(codes.data?.distribution ?? []).map((c) => ({ code: c.response_code, n: c.n }))} height={220} />
        <Chart title="Response codes over time" height={220} option={stackedTimeBarsOption({ theme, series: codeSeries })} loading={codes.isLoading}
          empty={!codes.isLoading && !codeSeries.length ? 'No per-code series — response codes are recorded from raw samples or JMeter Backend Listener detail metrics.' : null}
          table={{ columns: ['Time', 'Code', 'Count'], rows: (codes.data?.series ?? []).map((r) => [new Date(Number(r.t)).toLocaleTimeString(), r.response_code, r.n]) }} />
      </div>
      <section className="card">
        <div className="card-head">
          <h3>Errors grouped by</h3>
          <Seg label="Group errors by" value={g} onChange={setG} options={GROUPS} />
        </div>
        {q.error && <div className="card-body"><ErrorBox error={q.error} /></div>}
        {g === 'time' ? (
          <div className="card-body">
            <Chart title="Errors over time by type" height={260} option={stackedTimeBarsOption({ theme, series: timeSeries })} loading={q.isLoading}
              empty={!q.isLoading && !timeSeries.length ? 'No errors recorded' : null}
              table={{ columns: ['Time', 'Type', 'Errors'], rows: ((q.data ?? []) as any[]).map((r) => [new Date(Number(r.t)).toLocaleTimeString(), r.error_type, r.n]) }} />
          </div>
        ) : (q.data?.length === 0 && !q.isLoading) ? (
          <EmptyState icon={<Bug size={22} />} title="No errors recorded">Every request in this run succeeded — or error details were not reported by the load generator.</EmptyState>
        ) : (
          <DataTable rows={(q.data ?? []) as ErrGroup[]} columns={cols} rowKey={(r) => String(r.key)} loading={q.isLoading} exportName={`${run.runId}-errors-${g}`} initialSort={{ key: 'count', order: 'desc' }} />
        )}
      </section>
    </div>
  );
}
