import { useEffect, useRef, useState } from 'react';
import { Activity, Wifi, WifiOff } from 'lucide-react';
import { useLiveRun } from '@/hooks/useLiveRun';
import { Kpi } from '@/components/ui';
import { fmtDuration, fmtMs, fmtNum, fmtPct } from '@/components/format';
import { ApproxNote, Seg } from './common';
import { SyncedCharts } from './SyncedCharts';

const INTERVALS = [2, 5, 10, 30];

/**
 * Live wall for a running test: SSE stream with a configurable refresh interval,
 * last-60s + total KPIs and synchronized live charts. Calls `onFinished` once when
 * the run leaves RUNNING.
 */
export function LiveWall({ runId, onFinished, big }: { runId: string; onFinished?: (status: string) => void; big?: boolean }) {
  const [interval, setIntervalSec] = useState(() => { try { return Number(localStorage.getItem('perfmon.liveInterval')) || 5; } catch { return 5; } });
  const live = useLiveRun(runId, interval);
  const wasRunning = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const st = live.run?.status;
    if (st === 'RUNNING') wasRunning.current = true;
    else if (st && wasRunning.current) { wasRunning.current = false; onFinished?.(st); }
  }, [live.run?.status, onFinished]);
  const setIv = (v: number) => { setIntervalSec(v); try { localStorage.setItem('perfmon.liveInterval', String(v)); } catch { /* ignore */ } };

  const l = live.last60s;
  const t = live.totals;
  const ax = live.percentileMethod === 'interval_weighted_approx' ? '≈ ' : '';
  const running = live.run?.status === 'RUNNING';
  const lastIngest = live.run?.live_last_ingest_at ? Math.max(0, Math.round((now - new Date(live.run.live_last_ingest_at).getTime()) / 1000)) : null;
  const stale = running && lastIngest != null && lastIngest > 30;
  const errLvl = (v: number | null | undefined) => (v == null ? null : v >= 5 ? 'fail' : v >= 1 ? 'warn' : 'pass');
  const cpuLvl = (v: number | null | undefined) => (v == null ? null : v >= 90 ? 'fail' : v >= 80 ? 'warn' : 'pass');

  return (
    <div className={`stack live-wall ${big ? 'big' : ''}`}>
      <div className="live-bar">
        {running ? <span className="live-pill lg"><span className="dot live-dot" />LIVE</span> : <span className="badge">{live.run?.status ?? 'CONNECTING'}</span>}
        <span className={`conn ${live.connected ? 'ok' : 'bad'}`} role="status">{live.connected ? <Wifi size={13} /> : <WifiOff size={13} />}{live.connected ? 'Connected' : live.error ?? 'Connecting…'}</span>
        {lastIngest != null && <span className={`muted small ${stale ? 'ink-warn' : ''}`}><Activity size={12} /> last data {lastIngest}s ago{stale ? ' — no metrics received recently' : ''}</span>}
        {live.run?.started_at && <span className="muted small">elapsed {fmtDuration((now - new Date(live.run.started_at).getTime()) / 1000)}</span>}
        <div className="spacer" />
        <span className="muted small">Refresh</span>
        <Seg label="Refresh interval" value={interval} onChange={setIv} options={INTERVALS.map((s) => ({ value: s, label: `${s}s` }))} />
      </div>
      <div>
        <div className="kpi-group-label">Last 60 seconds <ApproxNote method={live.percentileMethod} compact /></div>
        <div className="kpis live-kpis">
          <Kpi label="TPS" value={fmtNum(l?.tpsAvg, 1)} unit="/s" />
          <Kpi label="P95" value={l?.p95 != null ? ax + fmtMs(l.p95) : '—'} />
          <Kpi label="P99" value={l?.p99 != null ? ax + fmtMs(l.p99) : '—'} />
          <Kpi label="Error %" value={fmtPct(l?.errorPct)} status={errLvl(l?.errorPct) as any} />
          <Kpi label="Users" value={fmtNum(l?.usersPeak ?? live.points.at(-1)?.users)} />
          <Kpi label="CPU" value={live.infra?.cpu != null ? fmtPct(Number(live.infra.cpu), 0) : '—'} status={cpuLvl(live.infra?.cpu) as any} sub="avg last 30s" />
          <Kpi label="Memory" value={live.infra?.mem != null ? fmtPct(Number(live.infra.mem), 0) : '—'} status={cpuLvl(live.infra?.mem) as any} sub="avg last 30s" />
        </div>
      </div>
      <div>
        <div className="kpi-group-label">Totals</div>
        <div className="kpis live-kpis">
          <Kpi label="Requests" value={fmtNum(t?.totalSamples)} />
          <Kpi label="Errors" value={fmtNum(t?.failureCount)} sub={fmtPct(t?.errorPct)} status={errLvl(t?.errorPct) as any} />
          <Kpi label="Avg TPS" value={fmtNum(t?.tpsAvg, 1)} unit="/s" sub={t?.tpsPeak != null ? `peak ${fmtNum(t.tpsPeak, 1)}` : undefined} />
          <Kpi label="Avg RT" value={fmtMs(t?.avgRt)} />
          <Kpi label="P95" value={t?.p95 != null ? ax + fmtMs(t.p95) : '—'} />
          <Kpi label="P99" value={t?.p99 != null ? ax + fmtMs(t.p99) : '—'} />
          <Kpi label="Peak users" value={fmtNum(t?.usersPeak)} />
        </div>
      </div>
      <SyncedCharts points={live.points.map((p) => ({ ...p, sentBps: 0, receivedBps: 0 }))} panels={['users', 'tps', 'rt', 'errors']} percentileMethod={live.percentileMethod} group={`live-${runId}`} columns={2} height={big ? 210 : 170}
        loading={!live.points.length && !live.error} animate={false} />
    </div>
  );
}
