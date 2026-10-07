import { Kpi } from '@/components/ui';
import { fmtBytes, fmtMs, fmtNum, fmtPct } from '@/components/format';
import type { PercentileMethod, SummaryDto, WindowStats } from './types';

/** Normalized KPI set (from the stored run summary or a window recomputation). */
export interface KpiSet {
  requests: number | null; successful: number | null; failed: number | null; errorPct: number | null;
  tps: number | null; peakTps: number | null; avgRt: number | null; p50: number | null; p90: number | null; p95: number | null; p99: number | null;
  maxRt: number | null; minRt: number | null; usersAvg: number | null; usersPeak: number | null; receivedKbSec: number | null; sentKbSec: number | null;
  bytesReceived: number | null; bytesSent: number | null; slaPassPct: number | null; slaViolations: number | null; percentileMethod: PercentileMethod; durationSec: number | null;
}

export const fromSummary = (s: SummaryDto | null | undefined): KpiSet | null => s ? ({
  requests: s.requests, successful: s.successfulRequests, failed: s.failedRequests, errorPct: s.errorPct, tps: s.tps, peakTps: s.peakTps,
  avgRt: s.avgRt, p50: s.p50 ?? s.medianRt, p90: s.p90, p95: s.p95, p99: s.p99, maxRt: s.maxRt, minRt: s.minRt, usersAvg: s.usersAvg, usersPeak: s.usersPeak,
  receivedKbSec: s.receivedKbSec, sentKbSec: s.sentKbSec, bytesReceived: s.bytesReceived, bytesSent: s.bytesSent, slaPassPct: s.slaPassPct, slaViolations: s.slaViolations,
  percentileMethod: s.percentileMethod, durationSec: s.durationSec,
}) : null;

export const fromStats = (s: WindowStats | null | undefined, sla?: { slaPassPct: number | null; slaViolations: number | null }): KpiSet | null => s ? ({
  requests: s.totalSamples, successful: s.successCount, failed: s.failureCount, errorPct: s.errorPct, tps: s.tpsAvg, peakTps: s.tpsPeak,
  avgRt: s.avgRt, p50: s.p50 ?? s.medianRt, p90: s.p90, p95: s.p95, p99: s.p99, maxRt: s.maxRt, minRt: s.minRt, usersAvg: s.usersAvg, usersPeak: s.usersPeak,
  receivedKbSec: s.receivedKbSec, sentKbSec: s.sentKbSec, bytesReceived: s.bytesReceived, bytesSent: s.bytesSent,
  slaPassPct: sla?.slaPassPct ?? null, slaViolations: sla?.slaViolations ?? null, percentileMethod: s.percentileMethod, durationSec: s.durationSec,
}) : null;

export type Deltas = Partial<Record<'tpsAvg' | 'avgRt' | 'p50' | 'p90' | 'p95' | 'p99' | 'errorPct' | 'maxRt' | 'tpsPeak', number | null>>;

/** Executive KPI cards (with baseline deltas; colour + arrow + sign carry the verdict together). */
export function RunKpis({ k, deltas, ranged, compact, onKpiClick }: { k: KpiSet; deltas?: Deltas; ranged?: boolean; compact?: boolean; onKpiClick?: (key: string) => void }) {
  const ax = k.percentileMethod === 'interval_weighted_approx' ? '≈ ' : '';
  const d = ranged ? {} : deltas ?? {};
  const pctTitle = ax ? 'Approximate percentile (interval-weighted). Upload a JTL for exact values.' : undefined;
  const errStatus = k.errorPct == null ? null : k.errorPct >= 5 ? 'fail' : k.errorPct >= 1 ? 'warn' : 'pass';
  const slaStatus = k.slaPassPct == null ? null : k.slaPassPct >= 100 ? 'pass' : k.slaPassPct >= 80 ? 'warn' : 'fail';
  const click = (key: string) => (onKpiClick ? () => onKpiClick(key) : undefined);
  const all = [
    <Kpi key="req" label="Requests" value={fmtNum(k.requests)} better="neutral" sub={k.durationSec ? `in ${Math.round(k.durationSec / 60)} min` : undefined} />,
    <Kpi key="ok" label="Successful" value={fmtNum(k.successful)} sub={k.requests ? fmtPct(((k.successful ?? 0) / k.requests) * 100, 2) : undefined} />,
    <Kpi key="fail" label="Failed" value={fmtNum(k.failed)} status={k.failed ? (errStatus as any) : null} onClick={click('errors')} sub="requests" />,
    <Kpi key="err" label="Error %" value={fmtPct(k.errorPct)} delta={d.errorPct} better="lower" status={errStatus as any} onClick={click('errors')} sub={errStatus ? <span className={`kpi-flag ${errStatus}`}>{errStatus === 'pass' ? 'OK' : errStatus === 'warn' ? 'Elevated' : 'High'}</span> : undefined} />,
    <Kpi key="tps" label="TPS (avg)" value={fmtNum(k.tps, 1)} unit="/s" delta={d.tpsAvg} better="higher" onClick={click('throughput')} />,
    <Kpi key="ptps" label="Peak TPS" value={fmtNum(k.peakTps, 1)} unit="/s" delta={d.tpsPeak} better="higher" />,
    <Kpi key="avg" label="Avg RT" value={fmtMs(k.avgRt)} delta={d.avgRt} better="lower" onClick={click('response-time')} />,
    <Kpi key="p50" label="P50" value={`${k.p50 != null ? ax : ''}${fmtMs(k.p50)}`} delta={d.p50} title={pctTitle} sub={k.p50 == null ? 'not reported' : undefined} />,
    <Kpi key="p90" label="P90" value={`${k.p90 != null ? ax : ''}${fmtMs(k.p90)}`} delta={d.p90} title={pctTitle} />,
    <Kpi key="p95" label="P95" value={`${k.p95 != null ? ax : ''}${fmtMs(k.p95)}`} delta={d.p95} title={pctTitle} onClick={click('response-time')} />,
    <Kpi key="p99" label="P99" value={`${k.p99 != null ? ax : ''}${fmtMs(k.p99)}`} delta={d.p99} title={pctTitle} />,
    <Kpi key="max" label="Max RT" value={fmtMs(k.maxRt)} delta={d.maxRt} sub={k.minRt != null ? `min ${fmtMs(k.minRt)}` : undefined} />,
    <Kpi key="users" label="Users (peak)" value={fmtNum(k.usersPeak)} better="neutral" sub={k.usersAvg != null ? `avg ${fmtNum(k.usersAvg)}` : undefined} />,
    <Kpi key="thr" label="Data received" value={k.receivedKbSec != null ? fmtBytes(k.receivedKbSec * 1024) : '—'} unit="/s" sub={k.bytesReceived != null ? `${fmtBytes(k.bytesReceived)} total · sent ${fmtBytes((k.sentKbSec ?? 0) * 1024)}/s` : undefined} />,
    <Kpi key="sla" label="SLA pass" value={k.slaPassPct != null ? fmtPct(k.slaPassPct, 1) : '—'} status={slaStatus as any} onClick={click('sla')} sub={k.slaPassPct == null ? (ranged ? 'whole run only' : 'no SLA profile') : undefined} />,
    <Kpi key="slav" label="SLA violations" value={k.slaViolations != null ? fmtNum(k.slaViolations) : '—'} status={k.slaViolations ? 'fail' : k.slaViolations === 0 ? 'pass' : null} onClick={click('sla')} />,
  ];
  // compact (manager) view: the headline numbers first
  const order = compact ? ['err', 'tps', 'p95', 'sla', 'req', 'avg', 'p99', 'users', 'slav', 'fail', 'ok', 'ptps', 'p50', 'p90', 'max', 'thr'] : null;
  const items = order ? order.map((key) => all.find((x) => x.key === key)!) : all;
  return <div className="kpis run-kpis">{items}</div>;
}
