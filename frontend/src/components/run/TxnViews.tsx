import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Network } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Chart } from '@/charts/Chart';
import { rankingOption } from '@/charts/builders';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorBox } from '@/components/ui';
import { fmtMs, fmtNum, fmtPct } from '@/components/format';
import { ApproxNote, EmptyState, Seg, StatusChip } from './common';
import { EndpointDrilldown, TransactionDrilldown, codeColor } from './Drilldowns';
import type { EndpointRow, TimeWindow, TxnRow } from './types';

type RankMetric = 'p95' | 'avg' | 'p99' | 'errorPct' | 'tps';
const RANK_LABEL: Record<RankMetric, string> = { p95: 'P95', avg: 'Avg', p99: 'P99', errorPct: 'Error %', tps: 'TPS' };

function Ranking<T>({ rows, label, metric, setMetric, value, onPick, n = 10 }: { rows: T[]; label: (r: T) => string; metric: RankMetric; setMetric: (m: RankMetric) => void; value: (r: T, m: RankMetric) => number | null; onPick: (r: T) => void; n?: number }) {
  const theme = useUi((s) => s.theme);
  const top = useMemo(() => [...rows].filter((r) => value(r, metric) != null).sort((a, b) => (value(b, metric) ?? 0) - (value(a, metric) ?? 0)).slice(0, n), [rows, metric, value, n]);
  const unit = metric === 'errorPct' ? '%' : metric === 'tps' ? 'tps' : 'ms';
  const slot = metric === 'errorPct' ? 7 : metric === 'tps' ? 0 : metric === 'p99' ? 3 : metric === 'avg' ? 2 : 1;
  return (
    <Chart title={`Top ${top.length} by ${RANK_LABEL[metric]}`} subtitle={metric === 'tps' ? 'highest throughput' : 'slowest / worst first'} height={Math.max(140, top.length * 26 + 20)}
      option={rankingOption({ theme, labels: top.map(label), values: top.map((r) => value(r, metric)), unit, slot })}
      onPointClick={(p) => { const r = top[p.dataIndex]; if (r) onPick(r); }}
      empty={!top.length ? 'No data for this metric' : null}
      table={{ columns: ['Name', RANK_LABEL[metric]], rows: top.map((r) => [label(r), value(r, metric)]) }}
      actions={<Seg label="Ranking metric" value={metric} onChange={setMetric} options={(['p95', 'p99', 'avg', 'errorPct', 'tps'] as RankMetric[]).map((m) => ({ value: m, label: RANK_LABEL[m] }))} />} />
  );
}

/** Transactions table + top-N ranking + drill-down (run tab and /transactions page). */
export function TransactionsView({ runId, range, layout = 'stacked' }: { runId: string; range?: TimeWindow; layout?: 'stacked' | 'side' }) {
  const [sel, setSel] = useState<string | null>(null);
  const [metric, setMetric] = useState<RankMetric>('p95');
  const q = useQuery({
    queryKey: ['run-sub', runId, 'transactions', range?.from, range?.to],
    queryFn: () => api.get<{ source: string; items: TxnRow[] }>(`/runs/${encodeURIComponent(runId)}/transactions`, { from: range?.from, to: range?.to }),
    placeholderData: (p) => p,
  });
  const rows = q.data?.items ?? [];
  const method = rows.find((r) => r.percentileMethod)?.percentileMethod;
  const ax = method === 'interval_weighted_approx' ? '≈ ' : '';
  const cols: Column<TxnRow>[] = [
    { key: 'name', header: 'Transaction', render: (r) => <span className="mono txn-name" title={r.name}>{r.name}</span>, width: 300 },
    { key: 'samples', header: 'Requests', align: 'right', render: (r) => fmtNum(r.samples) },
    { key: 'tps', header: 'TPS', align: 'right', render: (r) => fmtNum(r.tps, 2) },
    { key: 'avg', header: 'Avg', align: 'right', render: (r) => fmtMs(r.avg) },
    { key: 'median', header: 'Median', align: 'right', render: (r) => (r.median == null ? '—' : ax + fmtMs(r.median)), hidden: true },
    { key: 'p90', header: 'P90', align: 'right', render: (r) => (r.p90 == null ? '—' : ax + fmtMs(r.p90)), hidden: true },
    { key: 'p95', header: 'P95', align: 'right', render: (r) => (r.p95 == null ? '—' : ax + fmtMs(r.p95)) },
    { key: 'p99', header: 'P99', align: 'right', render: (r) => (r.p99 == null ? '—' : ax + fmtMs(r.p99)) },
    { key: 'min', header: 'Min', align: 'right', render: (r) => fmtMs(r.min) },
    { key: 'max', header: 'Max', align: 'right', render: (r) => fmtMs(r.max) },
    { key: 'errors', header: 'Errors', align: 'right', render: (r) => (r.errors ? <span className="ink-fail">{fmtNum(r.errors)}</span> : '0') },
    { key: 'errorPct', header: 'Error %', align: 'right', render: (r) => <ErrBar v={r.errorPct} /> },
    { key: 'receivedKbSec', header: 'Recv KB/s', align: 'right', render: (r) => fmtNum(r.receivedKbSec, 1), hidden: true },
    { key: 'slaStatus', header: 'SLA', render: (r) => (r.slaStatus ? <StatusChip status={r.slaStatus} size="sm" /> : <span className="muted">—</span>) },
  ];
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.isLoading && !rows.length) {
    return <EmptyState icon={<ArrowLeftRight size={24} />} title="No transactions recorded">{range ? 'No samples in the selected time range — reset the range.' : 'Transactions appear once JMeter samplers report metrics for this Run ID (Backend Listener, JTL upload or HTML report).'}</EmptyState>;
  }
  return (
    <div className={layout === 'side' ? 'txn-layout-side' : 'stack'}>
      <Ranking rows={rows} label={(r) => r.name} metric={metric} setMetric={setMetric} onPick={(r) => setSel(r.name)}
        value={(r, m) => (m === 'errorPct' ? r.errorPct : m === 'tps' ? r.tps : (r as any)[m])} />
      <section className="card" style={{ minWidth: 0 }}>
        <DataTable rows={rows} columns={cols} rowKey={(r) => r.name} onRowClick={(r) => setSel(r.name)} loading={q.isLoading} exportName={`${runId}-transactions`}
          initialSort={{ key: 'samples', order: 'desc' }} maxHeight={560}
          toolbar={<><span className="muted small">source: {q.data?.source ?? '—'}</span><ApproxNote method={method} compact />{q.isFetching && !q.isLoading && <span className="muted small">updating…</span>}</>} />
      </section>
      <TransactionDrilldown runId={runId} name={sel} range={range} onClose={() => setSel(null)} />
    </div>
  );
}

export function ErrBar({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="muted">—</span>;
  const lvl = v >= 5 ? 'fail' : v >= 1 ? 'warn' : v > 0 ? 'low' : 'none';
  return <span className={`errbar errbar-${lvl}`}><span className="errbar-track"><span style={{ width: `${Math.min(100, v * 10)}%` }} /></span>{fmtPct(v)}</span>;
}

/** Normalized endpoints table + ranking + drill-down. */
export function EndpointsView({ runId, range, layout = 'stacked' }: { runId: string; range?: TimeWindow; layout?: 'stacked' | 'side' }) {
  const theme = useUi((s) => s.theme);
  const [sel, setSel] = useState<EndpointRow | null>(null);
  const [metric, setMetric] = useState<RankMetric>('p95');
  const q = useQuery({
    queryKey: ['run-sub', runId, 'endpoints', range?.from, range?.to],
    queryFn: () => api.get<EndpointRow[]>(`/runs/${encodeURIComponent(runId)}/endpoints`, { from: range?.from, to: range?.to }),
    placeholderData: (p) => p,
  });
  const rows = q.data ?? [];
  const cols: Column<EndpointRow>[] = [
    { key: 'method', header: 'Method', render: (r) => <span className={`method m-${r.method}`}>{r.method}</span>, width: 70 },
    { key: 'endpoint', header: 'Endpoint', render: (r) => <span className="mono txn-name" title={r.endpoint}>{r.endpoint}</span>, width: 300 },
    { key: 'requests', header: 'Requests', align: 'right', render: (r) => fmtNum(r.requests) },
    { key: 'tps', header: 'TPS', align: 'right', render: (r) => fmtNum(r.tps, 2) },
    { key: 'avg', header: 'Avg', align: 'right', render: (r) => fmtMs(r.avg) },
    { key: 'p95', header: 'P95', align: 'right', render: (r) => fmtMs(r.p95), title: 'Exact (histogram) — empty when only aggregated data exists' },
    { key: 'p99', header: 'P99', align: 'right', render: (r) => fmtMs(r.p99) },
    { key: 'max', header: 'Max', align: 'right', render: (r) => fmtMs(r.max), hidden: true },
    { key: 'errorPct', header: 'Error %', align: 'right', render: (r) => <ErrBar v={r.errorPct} /> },
    {
      key: 'statusCodes', header: 'Status codes', sortable: false, value: (r) => Object.entries(r.statusCodes).map(([c, n]) => `${c}:${n}`).join(' '),
      render: (r) => <span className="codes">{Object.entries(r.statusCodes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => <span key={c} className="code-pill"><i style={{ background: codeColor(theme, c) }} />{c}<b className="num">{fmtNum(n)}</b></span>)}</span>,
    },
  ];
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.isLoading && !rows.length) {
    return <EmptyState icon={<Network size={24} />} title="No API endpoint data">Endpoint statistics are derived from raw samples that carry a URL (JTL upload or JSON samples). Pre-aggregated JMeter Backend Listener data only provides sampler-level transactions — see the Transactions tab.</EmptyState>;
  }
  return (
    <div className={layout === 'side' ? 'txn-layout-side' : 'stack'}>
      <Ranking rows={rows} label={(r) => `${r.method} ${r.endpoint}`} metric={metric} setMetric={setMetric} onPick={setSel}
        value={(r, m) => (m === 'errorPct' ? r.errorPct : m === 'tps' ? r.tps : (r as any)[m])} />
      <section className="card" style={{ minWidth: 0 }}>
        <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} onRowClick={setSel} loading={q.isLoading} exportName={`${runId}-endpoints`} initialSort={{ key: 'requests', order: 'desc' }} maxHeight={560}
          toolbar={<span className="muted small">{rows.length} normalized endpoints · IDs and numbers in paths are templated (e.g. <span className="mono">{'{id}'}</span>)</span>} />
      </section>
      <EndpointDrilldown runId={runId} endpoint={sel} onClose={() => setSel(null)} />
    </div>
  );
}
