import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import si from 'systeminformation';

/**
 * Live metrics of the host running the Perfmon backend.
 *
 * Fast metrics (CPU per core, memory, event loop, process) come from node:os every 2s.
 * Slow metrics (disks, network, processes, static hardware info) come from systeminformation
 * on a separate, non-overlapping loop — on Windows these shell out and can take seconds.
 * Sampling starts on first request and stops after IDLE_STOP_MS without readers.
 */

const FAST_MS = 2000;
const SLOW_MS = 10_000;
const HISTORY = 300; // 10 min at 2s
const IDLE_STOP_MS = 90_000;

export interface HostSample {
  t: number;
  cpu: number;          // % total
  cpuUser: number;
  cpuSystem: number;
  cores: number[];      // % per logical core
  memUsed: number;      // bytes
  memTotal: number;
  memPct: number;
  swapUsed: number | null;
  swapTotal: number | null;
  rxSec: number | null; // bytes/s, all physical interfaces
  txSec: number | null;
  loopLagMs: number;    // event loop p99 delay
  rss: number;          // backend process RSS
  heapUsed: number;
  load1: number | null; // null on Windows
}

interface Slow {
  disks: { mount: string; fs: string; type: string; size: number; used: number; available: number; pct: number }[];
  network: { iface: string; state: string; rxBytes: number; txBytes: number; rxSec: number | null; txSec: number | null }[];
  processes: { total: number; running: number; blocked: number; sleeping: number; top: { pid: number; name: string; cpu: number; memPct: number; rss: number }[] } | null;
  swap: { used: number; total: number } | null;
  temperature: number | null;
  updatedAt: number | null;
}

interface Static {
  hostname: string; platform: string; distro: string; release: string; arch: string; kernel: string;
  cpuModel: string; cpuVendor: string; physicalCores: number | null; logicalCores: number; speedGHz: number | null;
  totalMemory: number; nodeVersion: string; pid: number; startedAt: number; gpu: string[];
}

class HostMonitor {
  private history: HostSample[] = [];
  private prevCpu: os.CpuInfo[] | null = null;
  private prevNet = new Map<string, { t: number; rx: number; tx: number }>();
  private fastTimer: NodeJS.Timeout | null = null;
  private slowRunning = false;
  private slowTimer: NodeJS.Timeout | null = null;
  private lastRead = 0;
  private loop = monitorEventLoopDelay({ resolution: 20 });
  private staticInfo: Static;
  private staticDetailed = false;
  private slowTick = 0;
  private slow: Slow = { disks: [], network: [], processes: null, swap: null, temperature: null, updatedAt: null };

  constructor() {
    const cpus = os.cpus();
    this.staticInfo = {
      hostname: os.hostname(), platform: os.platform(), distro: os.type(), release: os.release(), arch: os.arch(), kernel: os.release(),
      cpuModel: cpus[0]?.model?.trim() ?? 'Unknown CPU', cpuVendor: '', physicalCores: null, logicalCores: cpus.length,
      speedGHz: cpus[0]?.speed ? cpus[0].speed / 1000 : null, totalMemory: os.totalmem(), nodeVersion: process.version, pid: process.pid,
      startedAt: Date.now() - process.uptime() * 1000, gpu: [],
    };
  }

  /** Called on every read; (re)starts sampling and returns a snapshot. */
  snapshot(includeProcesses: boolean) {
    this.lastRead = Date.now();
    this.start();
    return {
      host: { ...this.staticInfo, uptimeSec: os.uptime(), processUptimeSec: process.uptime() },
      current: this.history[this.history.length - 1] ?? null,
      history: this.history,
      disks: this.slow.disks,
      network: this.slow.network,
      processes: includeProcesses ? this.slow.processes : this.slow.processes ? { ...this.slow.processes, top: [] } : null,
      temperature: this.slow.temperature,
      slowUpdatedAt: this.slow.updatedAt,
      intervalMs: FAST_MS,
    };
  }

  private start() {
    if (this.fastTimer) return;
    this.loop.enable();
    this.sampleFast();
    this.fastTimer = setInterval(() => {
      if (Date.now() - this.lastRead > IDLE_STOP_MS) return this.stop();
      this.sampleFast();
    }, FAST_MS);
    this.fastTimer.unref();
    this.scheduleSlow(0);
  }

  private stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.fastTimer = this.slowTimer = null;
    this.prevCpu = null;
    this.loop.disable();
  }

  private sampleFast() {
    const cpus = os.cpus();
    let cores: number[] = [];
    let user = 0, sys = 0, total = 0;
    if (this.prevCpu && this.prevCpu.length === cpus.length) {
      let tu = 0, ts = 0, tt = 0;
      cores = cpus.map((c, i) => {
        const p = this.prevCpu![i].times;
        const d = { user: c.times.user - p.user, nice: c.times.nice - p.nice, sys: c.times.sys - p.sys, idle: c.times.idle - p.idle, irq: c.times.irq - p.irq };
        const all = d.user + d.nice + d.sys + d.idle + d.irq;
        tu += d.user + d.nice; ts += d.sys + d.irq; tt += all;
        return all > 0 ? clampPct(((all - d.idle) / all) * 100) : 0;
      });
      user = tt ? (tu / tt) * 100 : 0;
      sys = tt ? (ts / tt) * 100 : 0;
      total = clampPct(user + sys);
    }
    this.prevCpu = cpus;
    if (!cores.length) return; // first tick only primes the CPU deltas

    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    const mu = process.memoryUsage();
    const net = this.slow.network.filter((n) => !/loopback|^lo$/i.test(n.iface));
    const sum = (k: 'rxSec' | 'txSec') => (net.some((n) => n[k] != null) ? net.reduce((a, n) => a + (n[k] ?? 0), 0) : null);
    const lag = this.loop.percentile(99) / 1e6;
    this.loop.reset();

    this.history.push({
      t: Date.now(), cpu: round(total), cpuUser: round(user), cpuSystem: round(sys), cores: cores.map(round),
      memUsed, memTotal, memPct: round((memUsed / memTotal) * 100),
      swapUsed: this.slow.swap?.used ?? null, swapTotal: this.slow.swap?.total ?? null,
      rxSec: sum('rxSec'), txSec: sum('txSec'),
      loopLagMs: Number.isFinite(lag) ? round(lag) : 0, rss: mu.rss, heapUsed: mu.heapUsed,
      load1: os.platform() === 'win32' ? null : round(os.loadavg()[0]),
    });
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
  }

  private scheduleSlow(delay: number) {
    if (this.slowTimer || this.slowRunning) return;
    this.slowTimer = setTimeout(async () => {
      this.slowTimer = null;
      if (!this.fastTimer) return;
      this.slowRunning = true;
      try { await this.sampleSlow(); } catch { /* keep last good values */ } finally { this.slowRunning = false; }
      if (this.fastTimer) this.scheduleSlow(SLOW_MS);
    }, delay);
    this.slowTimer.unref();
  }

  private async loadStatic(settle: <T>(p: Promise<T>) => Promise<T | null>) {
    const [cpu, osi, gfx] = await Promise.all([settle(si.cpu()), settle(si.osInfo()), settle(si.graphics())]);
    if (cpu) Object.assign(this.staticInfo, { cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(), cpuVendor: cpu.vendor, physicalCores: cpu.physicalCores, logicalCores: cpu.cores, speedGHz: cpu.speedMax || cpu.speed || this.staticInfo.speedGHz });
    if (osi) Object.assign(this.staticInfo, { distro: osi.distro, release: osi.release, kernel: osi.kernel, arch: osi.arch, hostname: osi.hostname || this.staticInfo.hostname });
    if (gfx) this.staticInfo.gpu = gfx.controllers.map((c) => c.model).filter(Boolean);
  }

  private async sampleSlow() {
    const settle = <T>(p: Promise<T>) => p.then((v) => v, () => null);
    if (!this.staticDetailed) {
      this.staticDetailed = true;
      void this.loadStatic(settle); // hardware details are slow on Windows; never block live samples on them
    }
    // the process table is the most expensive call (parsing hundreds of rows): refresh it every other cycle
    const wantProcs = this.slowTick++ % 2 === 0;
    const [fs, net, procs, mem, temp] = await Promise.all([settle(si.fsSize()), settle(si.networkStats('*')), wantProcs ? settle(si.processes()) : null, settle(si.mem()), settle(si.cpuTemperature())]);
    const now = Date.now();
    if (fs) {
      const seen = new Set<string>();
      this.slow.disks = fs.filter((d) => d.size > 0 && !seen.has(d.mount) && seen.add(d.mount))
        .map((d) => ({ mount: d.mount, fs: d.fs, type: d.type, size: d.size, used: d.used, available: d.available, pct: round(d.use) }));
    }
    if (net) {
      this.slow.network = net.map((n) => {
        const prev = this.prevNet.get(n.iface);
        this.prevNet.set(n.iface, { t: now, rx: n.rx_bytes, tx: n.tx_bytes });
        const dt = prev ? (now - prev.t) / 1000 : 0;
        return {
          iface: n.iface, state: n.operstate, rxBytes: n.rx_bytes, txBytes: n.tx_bytes,
          rxSec: prev && dt > 0 ? Math.max(0, (n.rx_bytes - prev.rx) / dt) : null,
          txSec: prev && dt > 0 ? Math.max(0, (n.tx_bytes - prev.tx) / dt) : null,
        };
      }).filter((n) => n.rxBytes + n.txBytes > 0);
    }
    if (procs) {
      const ncpu = os.cpus().length || 1;
      this.slow.processes = {
        total: procs.all, running: procs.running, blocked: procs.blocked, sleeping: procs.sleeping,
        top: procs.list.filter((p) => p.pid > 0 && !/idle process/i.test(p.name))
          .sort((a, b) => b.cpu - a.cpu || b.memRss - a.memRss).slice(0, 12)
          // Windows reports per-process CPU relative to one core; normalise to the whole machine
          .map((p) => ({ pid: p.pid, name: p.name, cpu: round(os.platform() === 'win32' ? p.cpu : p.cpu / ncpu), memPct: round(p.mem), rss: p.memRss * 1024 })),
      };
    }
    if (mem) this.slow.swap = mem.swaptotal > 0 ? { used: mem.swapused, total: mem.swaptotal } : null;
    this.slow.temperature = temp?.main ?? null;
    this.slow.updatedAt = now;
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
const clampPct = (n: number) => Math.max(0, Math.min(100, n));

export const hostMonitor = new HostMonitor();
