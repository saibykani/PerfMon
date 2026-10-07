import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, HardDrive, MemoryStick, Network, Server, Thermometer, Timer, Activity, Layers } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import { api } from '@/services/api';
import { useUi } from '@/stores/ui';
import { Card, ErrorBox, Loading } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { fmtBytes, fmtDuration } from '@/components/format';
import { Chart } from '@/charts/Chart';
import { seriesColor } from '@/charts/palette';
import '@/styles/system.css';

interface Sample {
  t: number; cpu: number; cpuUser: number; cpuSystem: number; cores: number[]; memUsed: number; memTotal: number; memPct: number;
  swapUsed: number | null; swapTotal: number | null; rxSec: number | null; txSec: number | null; loopLagMs: number; rss: number; heapUsed: number; load1: number | null;
}
interface HostData {
  host: { hostname: string; platform: string; distro: string; release: string; arch: string; cpuModel: string; physicalCores: number | null; logicalCores: number;
    speedGHz: number | null; totalMemory: number; nodeVersion: string; pid: number; uptimeSec: number; processUptimeSec: number; gpu: string[] };
  current: Sample | null;
  history: Sample[];
  disks: { mount: string; fs: string; type: string; size: number; used: number; available: number; pct: number }[];
  network: { iface: string; state: string; rxBytes: number; txBytes: number; rxSec: number | null; txSec: number | null }[];
  processes: { total: number; running: number; blocked: number; sleeping: number; top: { pid: number; name: string; cpu: number; memPct: number; rss: number }[] } | null;
  temperature: number | null;
  intervalMs: number;
}

const level = (pct: number | null | undefined) => (pct == null ? 'none' : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'good');
const LEVEL_TEXT = { good: 'Healthy', warn: 'Elevated', bad: 'Critical', none: '—' } as const;
const rate = (b: number | null | undefined) => (b == null ? '—' : `${fmtBytes(b)}/s`);
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Ring gauge: value + status word, so state never relies on color alone. */
function Ring({ label, pct, detail, icon }: { label: string; pct: number | null; detail: string; icon: React.ReactNode }) {
  const r = 42, c = 2 * Math.PI * r;
  const lv = level(pct);
  return (
    <div className={`sys-ring lv-${lv}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="track" />
        <circle cx="50" cy="50" r={r} className="val" strokeDasharray={`${((pct ?? 0) / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
      </svg>
      <div className="sys-ring-in">
        <span className="sys-ring-ico">{icon}</span>
        <b className="num">{pct == null ? '—' : `${Math.round(pct)}%`}</b>
      </div>
      <div className="sys-ring-label">{label}<span className={`sys-lv lv-${lv}`}>{LEVEL_TEXT[lv]}</span></div>
      <div className="sys-ring-detail num">{detail}</div>
    </div>
  );
}

function areaOption(theme: 'light' | 'dark', history: Sample[], series: { name: string; slot: number | string; pick: (s: Sample) => number | null }[], unit: (v: number) => string, max?: number): EChartsOption {
  return {
    animation: false,
    grid: { left: 8, right: 12, top: 28, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: (v: any) => (v == null ? '—' : unit(Number(v))) },
    xAxis: { type: 'time', axisLabel: { formatter: (v: number) => clock(v).slice(0, 5) } },
    yAxis: { type: 'value', min: 0, max, axisLabel: { formatter: (v: number) => unit(v) } },
    series: series.map((s, i) => ({
      name: s.name, type: 'line', showSymbol: false, smooth: 0.3, sampling: 'lttb',
      lineStyle: { width: 1.6, color: seriesColor(theme, s.slot) }, itemStyle: { color: seriesColor(theme, s.slot) },
      areaStyle: i === 0 ? { opacity: 0.12, color: seriesColor(theme, s.slot) } : undefined,
      data: history.map((h) => [h.t, s.pick(h)]),
    })),
  } as EChartsOption;
}

export function SystemMonitorPage() {
  const theme = useUi((s) => s.theme);
  const q = useQuery({ queryKey: ['system-host'], queryFn: () => api.get<HostData>('/system/host'), refetchInterval: 2000, refetchIntervalInBackground: false });
  const d = q.data;
  const cur = d?.current;
  const hist = d?.history ?? [];

  const charts = useMemo(() => d && {
    cpu: areaOption(theme, hist, [{ name: 'Total', slot: 'cpu', pick: (h) => h.cpu }, { name: 'User', slot: 2, pick: (h) => h.cpuUser }, { name: 'System', slot: 4, pick: (h) => h.cpuSystem }], (v) => `${Math.round(v)}%`, 100),
    mem: areaOption(theme, hist, [{ name: 'Memory used', slot: 'memory', pick: (h) => h.memPct }, { name: 'Swap used', slot: 5, pick: (h) => (h.swapTotal ? (100 * (h.swapUsed ?? 0)) / h.swapTotal : null) }], (v) => `${Math.round(v)}%`, 100),
    net: areaOption(theme, hist, [{ name: 'Received', slot: 'network', pick: (h) => h.rxSec }, { name: 'Sent', slot: 0, pick: (h) => h.txSec }], (v) => `${fmtBytes(v)}/s`),
    app: areaOption(theme, hist, [{ name: 'Event-loop p99 lag', slot: 'p95', pick: (h) => h.loopLagMs }], (v) => `${v.toFixed(v < 10 ? 1 : 0)} ms`),
  }, [d, hist, theme]);

  if (q.isLoading) return <div className="sys-page"><Loading height={140} /><Loading height={260} /></div>;
  if (q.error && !d) return <div className="sys-page"><ErrorBox error={q.error} /></div>;
  if (!d) return null;

  const busiestDisk = [...d.disks].sort((a, b) => b.pct - a.pct)[0];
  const swapPct = cur?.swapTotal ? (100 * (cur.swapUsed ?? 0)) / cur.swapTotal : null;
  const hot = [
    cur && cur.cpu >= 85 && `CPU is at ${Math.round(cur.cpu)}% — load tests run on this host will be CPU-bound.`,
    cur && cur.memPct >= 90 && `Memory is ${Math.round(cur.memPct)}% used — expect paging and slower response times.`,
    busiestDisk && busiestDisk.pct >= 90 && `Disk ${busiestDisk.mount} is ${Math.round(busiestDisk.pct)}% full (${fmtBytes(busiestDisk.available)} free) — results and artifacts may fail to write.`,
    cur && cur.loopLagMs >= 100 && `Perfmon event loop lag is ${Math.round(cur.loopLagMs)} ms — the API is responding slowly.`,
  ].filter(Boolean) as string[];

  return (
    <div className="sys-page">
      <section className="sys-hero">
        <div className="sys-hero-ico"><Server size={22} /></div>
        <div className="sys-hero-main">
          <div className="sys-hero-top">
            <h1>{d.host.hostname}</h1>
            <span className="sys-live"><i />LIVE · every {d.intervalMs / 1000}s</span>
          </div>
          <div className="sys-hero-facts">
            <span>{d.host.distro} {d.host.release} · {d.host.arch}</span>
            <span><Cpu size={12} /> {d.host.cpuModel} · {d.host.physicalCores ? `${d.host.physicalCores}C/` : ''}{d.host.logicalCores}T{d.host.speedGHz ? ` · ${d.host.speedGHz.toFixed(1)} GHz` : ''}</span>
            <span><MemoryStick size={12} /> {fmtBytes(d.host.totalMemory)} RAM</span>
            {d.host.gpu.length > 0 && <span><Layers size={12} /> {d.host.gpu.join(', ')}</span>}
            <span><Timer size={12} /> Host up {fmtDuration(d.host.uptimeSec)} · Perfmon up {fmtDuration(d.host.processUptimeSec)}</span>
          </div>
        </div>
      </section>

      {hot.length > 0 && <div className="sys-warn" role="status">{hot.map((h) => <div key={h}>⚠ {h}</div>)}</div>}

      <div className="sys-rings">
        <Ring label="CPU" pct={cur?.cpu ?? null} icon={<Cpu size={15} />} detail={cur ? `user ${Math.round(cur.cpuUser)}% · sys ${Math.round(cur.cpuSystem)}%` : 'warming up…'} />
        <Ring label="Memory" pct={cur?.memPct ?? null} icon={<MemoryStick size={15} />} detail={cur ? `${fmtBytes(cur.memUsed)} of ${fmtBytes(cur.memTotal)}` : '—'} />
        <Ring label="Swap / page file" pct={swapPct} icon={<Layers size={15} />} detail={cur?.swapTotal ? `${fmtBytes(cur.swapUsed)} of ${fmtBytes(cur.swapTotal)}` : 'collecting…'} />
        <Ring label={busiestDisk ? `Disk ${busiestDisk.mount}` : 'Disk'} pct={busiestDisk?.pct ?? null} icon={<HardDrive size={15} />} detail={busiestDisk ? `${fmtBytes(busiestDisk.available)} free` : 'collecting…'} />
        <div className="sys-stat-col">
          <div className="sys-stat"><Network size={14} /><span>Network in</span><b className="num">{rate(cur?.rxSec)}</b></div>
          <div className="sys-stat"><Network size={14} /><span>Network out</span><b className="num">{rate(cur?.txSec)}</b></div>
          <div className="sys-stat"><Activity size={14} /><span>Processes</span><b className="num">{d.processes?.total ?? '—'}</b></div>
          <div className="sys-stat"><Thermometer size={14} /><span>CPU temp</span><b className="num">{d.temperature != null ? `${Math.round(d.temperature)} °C` : 'n/a'}</b></div>
          <div className="sys-stat"><Timer size={14} /><span>Perfmon RSS</span><b className="num">{fmtBytes(cur?.rss)}</b></div>
        </div>
      </div>

      {charts && (
        <div className="sys-charts">
          <Chart title="CPU utilisation" subtitle="% of all cores" option={charts.cpu} height={200} group="sys" empty={hist.length < 2 ? 'Collecting samples…' : null} />
          <Chart title="Memory" subtitle="% used" option={charts.mem} height={200} group="sys" empty={hist.length < 2 ? 'Collecting samples…' : null} />
          <Chart title="Network throughput" subtitle="all interfaces" option={charts.net} height={200} group="sys" empty={hist.length < 2 ? 'Collecting samples…' : null} />
          <Chart title="Perfmon responsiveness" subtitle="Node.js event-loop p99" option={charts.app} height={200} group="sys" empty={hist.length < 2 ? 'Collecting samples…' : null} />
        </div>
      )}

      <div className="sys-row">
        <Card title={`CPU cores · ${cur?.cores.length ?? d.host.logicalCores}`}>
          <div className="sys-cores">
            {(cur?.cores ?? []).map((v, i) => (
              <div key={i} className={`sys-core lv-${level(v)}`} title={`Core ${i}: ${v}%`}>
                <div className="sys-core-fill" style={{ height: `${Math.max(3, v)}%` }} />
                <span className="num">{Math.round(v)}</span>
                <em>#{i}</em>
              </div>
            ))}
            {!cur && <span className="muted">Collecting…</span>}
          </div>
        </Card>
        <Card title="Disks">
          <div className="sys-disks">
            {d.disks.map((k) => (
              <div key={k.mount} className="sys-disk">
                <div className="sys-disk-top"><b>{k.mount}</b><span className="muted">{k.type}</span><span className={`sys-lv lv-${level(k.pct)}`}>{Math.round(k.pct)}%</span></div>
                <div className={`sys-bar lv-${level(k.pct)}`}><i style={{ width: `${k.pct}%` }} /></div>
                <div className="muted small num">{fmtBytes(k.used)} used · {fmtBytes(k.available)} free · {fmtBytes(k.size)}</div>
              </div>
            ))}
            {!d.disks.length && <span className="muted">Collecting…</span>}
          </div>
        </Card>
      </div>

      <div className="sys-row">
        <Card title="Network interfaces" noPad>
          <DataTable rows={d.network} rowKey={(n) => n.iface} empty="Collecting…" columns={[
            { key: 'iface', header: 'Interface', render: (n) => <b>{n.iface}</b> },
            { key: 'state', header: 'State', render: (n) => <span className={`sys-lv ${n.state === 'up' ? 'lv-good' : 'lv-none'}`}>{n.state}</span> },
            { key: 'rx', header: 'In', align: 'right', render: (n) => rate(n.rxSec) },
            { key: 'tx', header: 'Out', align: 'right', render: (n) => rate(n.txSec) },
            { key: 'tot', header: 'Total in / out', align: 'right', render: (n) => `${fmtBytes(n.rxBytes)} / ${fmtBytes(n.txBytes)}` },
          ]} />
        </Card>
        <Card title="Top processes by CPU" noPad>
          {d.processes?.top.length ? (
            <DataTable rows={d.processes.top} rowKey={(p) => String(p.pid)} columns={[
              { key: 'name', header: 'Process', render: (p) => <span className="sys-proc">{p.name}</span> },
              { key: 'pid', header: 'PID', align: 'right', render: (p) => p.pid },
              { key: 'cpu', header: 'CPU', align: 'right', render: (p) => `${p.cpu.toFixed(1)}%` },
              { key: 'mem', header: 'Memory', align: 'right', render: (p) => fmtBytes(p.rss) },
            ]} />
          ) : <div className="card-body muted">{d.processes ? 'Process details are visible to administrators.' : 'Collecting…'}</div>}
        </Card>
      </div>
    </div>
  );
}
