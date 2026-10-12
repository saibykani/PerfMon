import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, Server } from 'lucide-react';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Chart } from '@/charts/Chart';
import { timeSeriesOption, seriesTable, type TsSeries } from '@/charts/builders';
import { ErrorBox, Kpi } from '@/components/ui';
import { fmtNum, fmtPct } from '@/components/format';
import { EmptyState, SkeletonGrid } from '../common';
import type { RunDetail } from '../types';

type HostStatus = 'HEALTHY' | 'WARNING' | 'SATURATED' | 'NO_DATA';
interface MetricEval { metric: 'cpu' | 'memory' | 'heap'; label: string; samples: number; peak: number | null; avg: number | null; warn: number; crit: number; shareAboveWarnPct: number; shareAboveCritPct: number; firstAboveTs: number | null; lastAboveTs: number | null; level: 'OK' | 'WARNING' | 'CRITICAL' | 'NO_DATA' }
interface LgHost {
  serverId: string; name: string; hostname: string | null; os: string | null; cpuCores: number | null; memoryMb: number | null; status: HostStatus; metrics: MetricEval[];
  jmeter: { serviceId: string | null; cpuPeak: number | null; cpuAvg: number | null; rssPeakMb: number | null; heapMaxMb: number | null; gcTimeMs: number | null };
}
export interface LoadgenResponse {
  thresholds: { cpuWarnPct: number; cpuCritPct: number; memWarnPct: number; memCritPct: number; heapWarnPct: number; heapCritPct: number; minSharePct: number };
  status: HostStatus; hosts: LgHost[]; step: number; series: any[];
}

const enc = encodeURIComponent;
const TONE: Record<HostStatus, string> = { HEALTHY: 'pass', WARNING: 'warn', SATURATED: 'fail', NO_DATA: '' };
const LABEL: Record<HostStatus, string> = { HEALTHY: 'Healthy', WARNING: 'Warning', SATURATED: 'Saturated', NO_DATA: 'No data' };
const LEVEL_STATUS = { OK: 'pass', WARNING: 'warn', CRITICAL: 'fail', NO_DATA: null } as const;

export function HealthChip({ status }: { status: HostStatus }) {
  return <span className={`badge ${TONE[status]}`}>{LABEL[status]}</span>;
}

export const useLoadgen = (runId: string, enabled = true) =>
  useQuery({ queryKey: ['run-sub', runId, 'loadgen'], queryFn: () => api.get<LoadgenResponse>(`/runs/${enc(runId)}/loadgen`), enabled });

/** Banner shown when a load generator was saturated (critical thresholds) or under pressure (warning thresholds). */
export function LoadgenBanner({ data, onOpen }: { data?: LoadgenResponse; onOpen?: () => void }) {
  if (!data || (data.status !== 'SATURATED' && data.status !== 'WARNING')) return null;
  const sat = data.status === 'SATURATED';
  const bad = data.hosts.filter((h) => h.status === 'SATURATED' || h.status === 'WARNING');
  return (
    <div className={`lg-banner ${sat ? 'lg-fail' : 'lg-warn'}`} role="alert">
      <AlertTriangle size={15} />
      <div>
        <b>{sat ? 'Load generator saturated — results may be unreliable.' : 'Load generator under pressure — results may be affected.'}</b>{' '}
        {bad.map((h) => `${h.name} (${h.metrics.filter((m) => m.level === 'CRITICAL' || m.level === 'WARNING').map((m) => `${m.label} peak ${fmtPct(m.peak, 0)}`).join(', ')})`).join('; ')}.
        {' '}Throughput and response times may reflect the load generator rather than the system under test.
      </div>
      {onOpen && <button className="btn btn-sm" onClick={onOpen}>Load generators</button>}
    </div>
  );
}

const fmtTime = (ts: number | null) => (ts == null ? '' : new Date(ts).toLocaleTimeString());

export function LoadgenTab({ run }: { run: RunDetail }) {
  const theme = useUi((s) => s.theme);
  const q = useLoadgen(run.runId);
  const d = q.data;
  const charts = useMemo(() => {
    if (!d) return [];
    const t = d.thresholds;
    const per = (col: string, label?: string, dashed?: boolean) => d.hosts.map((h, i) => ({
      name: [d.hosts.length > 1 ? h.name : '', label].filter(Boolean).join(' · ') || h.name, slot: (i * 2 + (dashed ? 1 : 0)) % 8, dashed,
      data: d.series.filter((r) => r.server_id === h.serverId).map((r) => [Number(r.t), r[col] == null ? null : Number(r[col])] as [number, number | null]),
    })).filter((s) => s.data.some((p) => p[1] != null)) as TsSeries[];
    const thr = (w: number, c: number) => [{ value: w, label: `warn ${w}%`, level: 'warning' as const }, { value: c, label: `crit ${c}%`, level: 'critical' as const }];
    return [
      { title: 'Host CPU', unit: '%', max: 100, series: per('cpu_pct'), thresholds: thr(t.cpuWarnPct, t.cpuCritPct) },
      { title: 'Host memory', unit: '%', max: 100, series: per('memory_pct'), thresholds: thr(t.memWarnPct, t.memCritPct) },
      { title: 'JMeter heap usage', unit: '%', max: 100, series: per('heap_pct'), thresholds: thr(t.heapWarnPct, t.heapCritPct) },
      { title: 'JMeter heap', unit: 'MB', series: [...per('heap_used_mb', 'used'), ...per('heap_committed_mb', 'committed', true)] },
      { title: 'JMeter process CPU', unit: '%', max: 100, series: per('jmeter_cpu_pct') },
      { title: 'JMeter process memory (RSS)', unit: 'MB', series: per('jmeter_rss_mb') },
      { title: 'JMeter GC time per sample', unit: 'ms', series: per('gc_time_ms') },
    ].filter((c) => c.series.length);
  }, [d]);

  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isLoading) return <SkeletonGrid count={4} height={180} />;
  if (!d?.hosts.length) {
    return (
      <EmptyState icon={<Server size={22} />} title="No load generator metrics for this run">
        Run the test with the Perfmon wrapper script (run-perfmon-test.sh / .ps1) — it starts the Perfmon Collector on the load generator automatically —
        or start <code>perfmon-collector.mjs</code> yourself with <code>PERFMON_ROLE=loadgen</code> and <code>PERFMON_RUN_ID={run.runId}</code> on every JMeter engine.
      </EmptyState>
    );
  }
  const t = d.thresholds;
  const metric = (h: LgHost, k: MetricEval['metric']) => h.metrics.find((m) => m.metric === k);
  return (
    <div className="stack">
      <LoadgenBanner data={d} />
      <div className="kpis">
        <Kpi label="Load generators" value={fmtNum(d.hosts.length)} sub={<HealthChip status={d.status} />} />
        {(['cpu', 'memory', 'heap'] as const).map((k) => {
          const ms = d.hosts.map((h) => metric(h, k)).filter((m): m is MetricEval => !!m && m.peak != null);
          const worst = ms.sort((a, b) => (b.peak ?? 0) - (a.peak ?? 0))[0];
          const lvl = ms.some((m) => m.level === 'CRITICAL') ? 'CRITICAL' : ms.some((m) => m.level === 'WARNING') ? 'WARNING' : ms.length ? 'OK' : 'NO_DATA';
          return <Kpi key={k} label={`${worst?.label ?? (k === 'heap' ? 'JMeter heap' : k === 'cpu' ? 'CPU' : 'Memory')} peak`} value={fmtPct(worst?.peak ?? null, 1)}
            sub={worst ? `${fmtPct(worst.shareAboveWarnPct, 0)} of samples ≥ ${worst.warn}%` : 'not reported'} status={LEVEL_STATUS[lvl]} />;
        })}
      </div>

      <section className="card">
        <div className="card-head"><h3><Server size={13} /> Load generators in this run</h3><span className="muted small">step {d.step}s</span></div>
        <div className="table-wrap">
          <table className="table compact-table">
            <thead><tr><th>Load generator</th><th>Health</th><th className="r">Cores / RAM</th><th className="r">CPU peak</th><th className="r">CPU ≥ warn</th><th className="r">Mem peak</th><th className="r">Mem ≥ warn</th><th className="r">Heap peak</th><th className="r">Heap max</th><th className="r">JMeter CPU peak</th><th className="r">JMeter RSS peak</th><th>Above warning</th></tr></thead>
            <tbody>{d.hosts.map((h) => {
              const c = metric(h, 'cpu'), m = metric(h, 'memory'), hp = metric(h, 'heap');
              const above = h.metrics.filter((x) => x.firstAboveTs != null);
              return (
                <tr key={h.serverId}>
                  <td><b>{h.name}</b>{h.os && <span className="muted small"> · {h.os}</span>}</td>
                  <td><HealthChip status={h.status} /></td>
                  <td className="r num">{h.cpuCores ?? '—'} / {h.memoryMb ? `${Math.round(h.memoryMb / 1024)} GB` : '—'}</td>
                  <td className="r num"><Lvl m={c} v={c?.peak} /></td><td className="r num">{c?.samples ? fmtPct(c.shareAboveWarnPct, 0) : '—'}</td>
                  <td className="r num"><Lvl m={m} v={m?.peak} /></td><td className="r num">{m?.samples ? fmtPct(m.shareAboveWarnPct, 0) : '—'}</td>
                  <td className="r num"><Lvl m={hp} v={hp?.peak} /></td>
                  <td className="r num">{h.jmeter.heapMaxMb != null ? `${fmtNum(h.jmeter.heapMaxMb, 0)} MB` : '—'}</td>
                  <td className="r num">{h.jmeter.cpuPeak != null ? fmtPct(h.jmeter.cpuPeak, 1) : '—'}</td>
                  <td className="r num">{h.jmeter.rssPeakMb != null ? `${fmtNum(h.jmeter.rssPeakMb, 0)} MB` : '—'}</td>
                  <td className="small">{above.length ? above.map((x) => `${x.label} ${fmtTime(x.firstAboveTs)}–${fmtTime(x.lastAboveTs)}`).join('; ') : <span className="muted">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>

      <div className="grid g2">
        {charts.map((c) => (
          <Chart key={c.title} title={c.title} height={190} group={`loadgen-${run.runId}`}
            option={{ ...timeSeriesOption({ theme, series: c.series, unit: c.unit, min: 0, max: c.max, thresholds: c.thresholds }), grid: { left: 58, right: 18, containLabel: false, top: c.series.length > 1 ? 28 : 10, bottom: 22 } } as any}
            table={seriesTable(c.series)} />
        ))}
      </div>
      <div className="muted small">
        <Info size={11} /> Healthy / Warning / Saturated use the platform thresholds (Administration → Settings → Load generator thresholds): CPU {t.cpuWarnPct}/{t.cpuCritPct}%,
        memory {t.memWarnPct}/{t.memCritPct}%, JMeter heap {t.heapWarnPct}/{t.heapCritPct}% (warning/critical), reached when at least {t.minSharePct}% of the samples are at or above the threshold.
        Process CPU is a share of the whole machine; JVM heap needs <code>jstat</code> (JDK) on the load generator.
      </div>
    </div>
  );
}

function Lvl({ m, v }: { m?: MetricEval; v?: number | null }) {
  if (v == null || !m) return <span className="muted">—</span>;
  const cls = m.level === 'CRITICAL' ? 'fail' : m.level === 'WARNING' ? 'warn' : 'ok';
  return <span className={`util util-${cls}`}>{fmtPct(Number(v), 1)}</span>;
}
