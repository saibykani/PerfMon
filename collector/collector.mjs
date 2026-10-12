#!/usr/bin/env node
/**
 * Perfmon Collector — lightweight host + load-generator metrics agent (zero dependencies, Node 18+,
 * Windows / Linux / macOS). Sends batches to POST {PERFMON_URL}/api/v1/ingest/infrastructure.
 *
 * Host metrics:   CPU %, memory % / used MB, disk usage % of the working-directory volume,
 *                 network rx/tx bytes/s (Linux /proc/net/dev, Windows `netstat -e`), load average
 *                 (Linux/macOS), open file handles (Linux).
 * JMeter metrics: (role "loadgen", or whenever a JMeter process is found) CPU % and RSS of the JMeter
 *                 Java process, and JVM heap used/committed/max + GC count/time via `jstat` when the
 *                 JDK's jstat is on PATH or in JAVA_HOME/bin (skipped gracefully otherwise).
 *
 * Configuration — environment variable / CLI flag (flags win):
 *   PERFMON_URL            --url           Perfmon API base, e.g. http://perfmon:8080   (default http://localhost:8080)
 *   PERFMON_API_KEY        --key           API key with the "ingest" scope              (required unless --once)
 *   PERFMON_PROJECT        --project       project key (not needed when a run id is given)
 *   PERFMON_ENV            --env           environment name
 *   PERFMON_RUN_ID         --run-id        Run ID to attach metrics to (otherwise the environment's RUNNING run)
 *   PERFMON_SERVER         --server        server name (default: hostname)
 *   PERFMON_ROLE           --role          app | db | loadgen | gateway (default app)
 *   INTERVAL_SEC           --interval      sampling interval in seconds (default 5)
 *   PERFMON_BATCH          --batch         samples per request (default 3)
 *   PERFMON_BUFFER_MAX     --buffer-max    max samples kept while Perfmon is unreachable (default 2000; oldest dropped)
 *   PERFMON_JMETER         --jmeter        auto | true | false — JMeter process metrics (auto = only for role loadgen)
 *   PERFMON_JMETER_PID     --jmeter-pid    JMeter Java PID (otherwise found by "ApacheJMeter.jar" in the command line)
 *   PERFMON_JSTAT          --jstat         true | false — use jstat for JVM heap/GC (default true)
 *   PERFMON_CPU_WARN       --cpu-warn      local console warning threshold for host CPU % (default 90)
 *   PERFMON_MEM_WARN       --mem-warn      local console warning threshold for host memory % (default 90)
 *   PERFMON_HEAP_WARN      --heap-warn     local console warning threshold for JMeter heap % (default 90)
 *   PERFMON_STOP_FILE      --stop-file     when this file appears, flush and exit (used by the wrapper scripts)
 *                          --once          print one sample payload as JSON and exit (dry run, nothing is sent)
 *                          --help
 * Never crashes the host: every probe is optional, failures are logged and retried with exponential backoff.
 */
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ------------------------------------------------------------------ pure helpers (exported for tests)

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx != null && !nx.startsWith('--')) { out[k] = nx; i++; } else out[k] = true;
  }
  return out;
}

const bool = (v, d) => (v == null || v === '' ? d : !/^(0|false|no|off)$/i.test(String(v)));

export function buildConfig(env, args, hostname = os.hostname()) {
  const pick = (flag, name, d) => args[flag] ?? env[name] ?? d;
  const role = String(pick('role', 'PERFMON_ROLE', 'app'));
  const jm = String(pick('jmeter', 'PERFMON_JMETER', 'auto')).toLowerCase();
  return {
    url: String(pick('url', 'PERFMON_URL', 'http://localhost:8080')).replace(/\/+$/, ''),
    key: String(pick('key', 'PERFMON_API_KEY', '')),
    project: pick('project', 'PERFMON_PROJECT', undefined),
    env: pick('env', 'PERFMON_ENV', undefined),
    runId: pick('run-id', 'PERFMON_RUN_ID', undefined) || undefined,
    server: String(pick('server', 'PERFMON_SERVER', hostname)),
    role,
    interval: Math.max(1, Number(pick('interval', 'INTERVAL_SEC', 5)) || 5),
    batch: Math.max(1, Math.floor(Number(pick('batch', 'PERFMON_BATCH', 3)) || 3)),
    bufferMax: Math.max(10, Math.floor(Number(pick('buffer-max', 'PERFMON_BUFFER_MAX', 2000)) || 2000)),
    jmeter: jm === 'auto' ? role === 'loadgen' : bool(jm, false),
    jmeterPid: Number(pick('jmeter-pid', 'PERFMON_JMETER_PID', 0)) || null,
    jstat: bool(pick('jstat', 'PERFMON_JSTAT', 'true'), true),
    cpuWarn: Number(pick('cpu-warn', 'PERFMON_CPU_WARN', 90)),
    memWarn: Number(pick('mem-warn', 'PERFMON_MEM_WARN', 90)),
    heapWarn: Number(pick('heap-warn', 'PERFMON_HEAP_WARN', 90)),
    stopFile: pick('stop-file', 'PERFMON_STOP_FILE', undefined) || undefined,
    once: !!args.once,
    help: !!args.help,
  };
}

/** Linux /proc/net/dev → total { rx, tx } bytes over all interfaces except loopback. */
export function parseProcNetDev(text) {
  let rx = 0, tx = 0, n = 0;
  for (const line of String(text).split('\n').slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m || m[1].trim() === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    rx += f[0]; tx += f[8]; n++;
  }
  return n ? { rx, tx } : null;
}

/** Windows `netstat -e` → { rx, tx } bytes (first row with two counters, i.e. "Bytes"). */
export function parseNetstatE(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*\S[^\d]*?\s+(\d+)\s+(\d+)\s*$/);
    if (m) return { rx: Number(m[1]), tx: Number(m[2]) };
  }
  return null;
}

/** `jstat -gc` / `-gccapacity` output (header line + value line) → { column: number }. */
export function parseJstat(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const h = lines[0].trim().split(/\s+/);
  const v = lines[lines.length - 1].trim().split(/\s+/).map((x) => Number(x.replace(',', '.')));
  // jstat prints "-" for unavailable columns → null
  const out = {};
  h.forEach((k, i) => { out[k] = Number.isFinite(v[i]) ? v[i] : null; });
  return out;
}

/** -Xmx from a Java command line → MB (null when absent). */
export function parseXmx(cmdline) {
  const m = String(cmdline ?? '').match(/-Xmx(\d+)([kKmMgGtT]?)/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return u === 'g' ? n * 1024 : u === 't' ? n * 1024 * 1024 : u === 'k' ? n / 1024 : u === 'm' ? n : n / 1048576;
}

/**
 * JVM heap from jstat (KB values): used/committed from `-gc`, max from -Xmx or `-gccapacity`
 * (G1 reports the whole heap as both NGCMX and OGCMX, so they are not summed when equal).
 */
export function heapFromJstat(gc, cap, xmxMb) {
  if (!gc) return null;
  const s = (...k) => k.reduce((a, x) => a + (gc[x] ?? 0), 0);
  const usedKb = s('S0U', 'S1U', 'EU', 'OU');
  const committedKb = s('S0C', 'S1C', 'EC', 'OC');
  let maxMb = xmxMb ?? null;
  if (maxMb == null && cap && cap.OGCMX != null) maxMb = (cap.NGCMX != null && cap.NGCMX !== cap.OGCMX ? cap.NGCMX + cap.OGCMX : cap.OGCMX) / 1024;
  return {
    heapUsedMb: +(usedKb / 1024).toFixed(1), heapCommittedMb: +(committedKb / 1024).toFixed(1), heapMaxMb: maxMb != null ? +maxMb.toFixed(1) : null,
    nonHeapUsedMb: gc.MU != null ? +((gc.MU + (gc.CCSU ?? 0)) / 1024).toFixed(1) : null,
    gcCount: (gc.YGC ?? 0) + (gc.FGC ?? 0) + (gc.CGC ?? 0), gcTimeSec: gc.GCT ?? null,
  };
}

/** Linux /proc/<pid>/stat → utime + stime in clock ticks. */
export function parseProcStat(text) {
  const s = String(text);
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return Number(f[11]) + Number(f[12]);
}

/** Linux /proc/<pid>/status → VmRSS in MB. */
export function parseVmRss(text) {
  const m = String(text).match(/VmRSS:\s+(\d+)\s*kB/);
  return m ? Number(m[1]) / 1024 : null;
}

/** macOS/BSD `ps -o time=` value ("[[dd-]hh:]mm:ss.ss") → seconds. */
export function parsePsTime(v) {
  const t = String(v).trim();
  let days = 0, rest = t;
  if (t.includes('-')) { const [d, r] = t.split('-'); days = Number(d); rest = r; }
  const parts = rest.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return days * 86400 + sec;
}

/** Process CPU % normalized to the whole machine (0–100) from a CPU-time delta. */
export function processCpuPct(cpuMsDelta, wallMsDelta, cores) {
  if (!(wallMsDelta > 0) || !(cores > 0) || cpuMsDelta < 0) return null;
  return +Math.min(100, (cpuMsDelta / (wallMsDelta * cores)) * 100).toFixed(2);
}

/** Exponential backoff in ms: base·2^failures, capped. */
export function backoffMs(failures, baseMs, maxMs = 300000) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

/** Bounded FIFO: pushing beyond `max` drops the oldest entries and counts them. */
export class BoundedBuffer {
  constructor(max) { this.max = max; this.items = []; this.dropped = 0; }
  push(...xs) { this.items.push(...xs); const over = this.items.length - this.max; if (over > 0) { this.items.splice(0, over); this.dropped += over; } }
  unshift(xs) { this.items.unshift(...xs); const over = this.items.length - this.max; if (over > 0) { this.items.splice(0, over); this.dropped += over; } }
  take(n) { return this.items.splice(0, n); }
  get length() { return this.items.length; }
}

/** Ingest payload for a batch of samples (pure). */
export function buildPayload(cfg, samples, hostInfo, jmeterFound) {
  const body = {
    project: cfg.project, environment: cfg.env, runId: cfg.runId,
    server: { name: cfg.server, hostname: hostInfo.hostname, os: hostInfo.os, cpuCores: hostInfo.cores, memoryMb: hostInfo.memoryMb, role: cfg.role },
    metrics: samples.map((s) => s.host),
  };
  const jvm = samples.filter((s) => s.jvm).map((s) => s.jvm);
  const proc = samples.filter((s) => s.proc).map((s) => s.proc);
  if (jmeterFound && (jvm.length || proc.length)) body.service = { name: `JMeter @ ${cfg.server}`, kind: 'loadgen', technology: 'Apache JMeter' };
  if (jvm.length) body.jvm = jvm;
  if (proc.length && body.service) body.serviceMetrics = proc;
  return body;
}

// ------------------------------------------------------------------ probes (side effects)

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 15000);

const cpuTimes = () => os.cpus().reduce((a, c) => { for (const [k, v] of Object.entries(c.times)) a[k] = (a[k] ?? 0) + v; return a; }, {});

function diskPct(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir);
    const used = s.blocks - s.bfree;
    const denom = used + s.bavail;
    return denom > 0 ? +((used / denom) * 100).toFixed(2) : null;
  } catch { return null; }
}

async function netTotals() {
  try {
    if (IS_LINUX) return parseProcNetDev(fs.readFileSync('/proc/net/dev', 'utf8'));
    if (IS_WIN) { const o = await run('netstat', ['-e'], 5000); return o ? parseNetstatE(o) : null; }
  } catch { /* optional */ }
  return null;
}

function fileHandles() {
  try { if (IS_LINUX) return Number(fs.readFileSync('/proc/sys/fs/file-nr', 'utf8').trim().split(/\s+/)[0]) || null; } catch { /* optional */ }
  return null;
}

/** Find the JMeter Java process → { pid, cmdline } or null. */
async function findJmeter() {
  try {
    if (IS_LINUX) {
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
        let cl = '';
        try { cl = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
        if (/ApacheJMeter\.jar/.test(cl) && /java/i.test(cl)) return { pid: Number(d), cmdline: cl };
      }
      return null;
    }
    if (IS_WIN) {
      const o = await ps(`Get-CimInstance Win32_Process -Filter "Name like 'java%'" | Where-Object { $_.CommandLine -like '*ApacheJMeter*' } | Select-Object -First 1 | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`);
      const line = o?.trim().split(/\r?\n/)[0];
      if (!line) return null;
      const [pid, ...rest] = line.split('\t');
      return Number(pid) ? { pid: Number(pid), cmdline: rest.join('\t') } : null;
    }
    const o = await run('ps', ['-axo', 'pid=,command=']);
    for (const line of (o ?? '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && /ApacheJMeter\.jar/.test(m[2]) && /java/i.test(m[2])) return { pid: Number(m[1]), cmdline: m[2] };
    }
  } catch { /* optional */ }
  return null;
}

async function commandLineOf(pid) {
  try {
    if (IS_LINUX) return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (IS_WIN) return (await ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`))?.trim() ?? '';
    return (await run('ps', ['-o', 'command=', '-p', String(pid)]))?.trim() ?? '';
  } catch { return ''; }
}

/** { cpuMs (cumulative), rssMb } of a process, or null when it is gone. */
async function procUsage(pid) {
  try {
    if (IS_LINUX) {
      const ticks = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return { cpuMs: (ticks / 100) * 1000, rssMb: parseVmRss(fs.readFileSync(`/proc/${pid}/status`, 'utf8')) };
    }
    if (IS_WIN) {
      const o = await ps(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { "$([double]$p.KernelModeTime + [double]$p.UserModeTime) $($p.WorkingSetSize)" }`);
      const [t, ws] = (o ?? '').trim().split(/\s+/).map(Number);
      if (!Number.isFinite(t) || !Number.isFinite(ws)) return null;
      return { cpuMs: t / 10000, rssMb: ws / 1048576 };
    }
    const o = await run('ps', ['-o', 'rss=,time=', '-p', String(pid)]);
    const m = (o ?? '').trim().match(/^(\d+)\s+(\S+)/);
    return m ? { cpuMs: parsePsTime(m[2]) * 1000, rssMb: Number(m[1]) / 1024 } : null;
  } catch { return null; }
}

function findJstat() {
  const exe = IS_WIN ? 'jstat.exe' : 'jstat';
  const dirs = [...(process.env.JAVA_HOME ? [path.join(process.env.JAVA_HOME, 'bin')] : []), ...String(process.env.PATH ?? '').split(path.delimiter)];
  for (const d of dirs) { try { const f = path.join(d.replace(/^"|"$/g, ''), exe); if (d && fs.existsSync(f)) return f; } catch { /* ignore */ } }
  return null;
}

// ------------------------------------------------------------------ agent

const HELP = `Perfmon Collector - host and load-generator metrics agent
Usage: node perfmon-collector.mjs [--url URL] [--key KEY] [--run-id RUN] [--role loadgen] [--interval 5] [--once] ...
See the header of this file (or the "Load generator monitoring" chapter of the user manual) for every option.`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cfg = buildConfig(env, parseArgs(argv));
  if (cfg.help) { console.log(HELP); return 0; }
  if (!cfg.key && !cfg.once) { console.error('[collector] PERFMON_API_KEY (or --key) is required'); return 1; }

  const log = (...a) => console.log(new Date().toISOString(), '[collector]', ...a);
  const warn = (...a) => console.error(new Date().toISOString(), '[collector]', ...a);
  const hostInfo = { hostname: os.hostname(), os: `${os.type()} ${os.release()}`, cores: os.cpus().length || 1, memoryMb: Math.round(os.totalmem() / 1048576) };
  const jstatPath = cfg.jmeter && cfg.jstat ? findJstat() : null;

  let prevCpu = cpuTimes();
  let prevNet = await netTotals();
  let prevT = Date.now();
  let jm = null;            // { pid, cmdline, xmxMb, cap, prevCpuMs, prevT, prevGcSec, prevGcCount }
  let lastDiscovery = 0;
  const warned = {};

  const warnOnce = (k, msg) => { if (!warned[k]) { warned[k] = true; warn(msg); } };

  async function jmeterSample(now) {
    if (!cfg.jmeter) return {};
    if (!jm && now - lastDiscovery >= Math.max(15000, cfg.interval * 1000)) {
      lastDiscovery = now;
      const found = cfg.jmeterPid ? { pid: cfg.jmeterPid, cmdline: await commandLineOf(cfg.jmeterPid) } : await findJmeter();
      if (found) {
        jm = { ...found, xmxMb: parseXmx(found.cmdline), cap: null, prevCpuMs: null, prevT: null, prevGcSec: null, prevGcCount: null };
        if (jstatPath) { const c = await run(jstatPath, ['-gccapacity', String(found.pid)]); jm.cap = c ? parseJstat(c) : null; }
        log(`JMeter process found: pid ${found.pid}${jm.xmxMb ? `, -Xmx ${jm.xmxMb} MB` : ''}${jstatPath ? '' : ' (jstat not found - JVM heap not reported)'}`);
      }
    }
    if (!jm) return {};
    const u = await procUsage(jm.pid);
    if (!u) { log(`JMeter process ${jm.pid} ended`); jm = null; lastDiscovery = now; return {}; }
    const out = {};
    const cpu = jm.prevCpuMs != null ? processCpuPct(u.cpuMs - jm.prevCpuMs, now - jm.prevT, hostInfo.cores) : null;
    jm.prevCpuMs = u.cpuMs; jm.prevT = now;
    out.proc = { ts: now, cpuPct: cpu, memoryPct: u.rssMb != null ? +((u.rssMb / hostInfo.memoryMb) * 100).toFixed(2) : null };
    if (jstatPath) {
      const o = await run(jstatPath, ['-gc', String(jm.pid)]);
      const h = o ? heapFromJstat(parseJstat(o), jm.cap, jm.xmxMb) : null;
      if (h) {
        const gcTimeMs = h.gcTimeSec != null && jm.prevGcSec != null ? Math.max(0, Math.round((h.gcTimeSec - jm.prevGcSec) * 1000)) : null;
        const gcCount = jm.prevGcCount != null ? Math.max(0, h.gcCount - jm.prevGcCount) : null;
        jm.prevGcSec = h.gcTimeSec; jm.prevGcCount = h.gcCount;
        out.jvm = { ts: now, heapUsedMb: h.heapUsedMb, heapCommittedMb: h.heapCommittedMb, heapMaxMb: h.heapMaxMb, nonHeapUsedMb: h.nonHeapUsedMb, gcCount, gcTimeMs };
      } else warnOnce('jstat', `jstat -gc ${jm.pid} returned no data - JVM heap not reported`);
    }
    return out;
  }

  async function sample() {
    const now = Date.now();
    const c = cpuTimes();
    const total = Object.keys(c).reduce((a, k) => a + (c[k] - (prevCpu[k] ?? 0)), 0);
    const idle = c.idle - prevCpu.idle;
    prevCpu = c;
    const net = await netTotals();
    const dt = (now - prevT) / 1000;
    const rate = (a, b) => (a != null && b != null && dt > 0 && a >= b ? Math.round((a - b) / dt) : null);
    const host = {
      ts: now,
      cpuPct: total > 0 ? +(100 * (1 - idle / total)).toFixed(2) : null,
      memoryPct: +((1 - os.freemem() / os.totalmem()) * 100).toFixed(2),
      memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      diskPct: diskPct(process.cwd()),
      netInBps: rate(net?.rx, prevNet?.rx), netOutBps: rate(net?.tx, prevNet?.tx),
      loadAvg1m: IS_WIN ? null : os.loadavg()[0] ?? null,
      fileDescriptors: fileHandles(),
    };
    prevNet = net; prevT = now;
    const j = await jmeterSample(now);
    // local warnings (once per crossing)
    const heapPct = j.jvm?.heapUsedMb != null && (j.jvm.heapMaxMb || j.jvm.heapCommittedMb) ? (j.jvm.heapUsedMb / (j.jvm.heapMaxMb || j.jvm.heapCommittedMb)) * 100 : null;
    for (const [k, v, t] of [['CPU', host.cpuPct, cfg.cpuWarn], ['memory', host.memoryPct, cfg.memWarn], ['JMeter heap', heapPct, cfg.heapWarn]]) {
      if (v != null && v >= t && !warned[k]) { warned[k] = true; warn(`WARNING ${k} ${v.toFixed(1)}% >= ${t}% - the load generator may be saturated`); }
      if (v != null && v < t) warned[k] = false;
    }
    return { host, ...j };
  }

  if (cfg.once) {
    await new Promise((r) => setTimeout(r, 1000));
    const first = await sample();
    let s = first;
    if (jm) { await new Promise((r) => setTimeout(r, 1000)); s = await sample(); } // second sample for process CPU / GC deltas
    console.log(JSON.stringify(buildPayload(cfg, [s], hostInfo, !!jm), null, 2));
    return 0;
  }

  const buffer = new BoundedBuffer(cfg.bufferMax);
  let failures = 0, nextSendAt = 0, reportedDropped = 0, stopping = false, sending = false, inflight = null;

  async function flush(force = false) {
    if (sending || !buffer.length) return true;
    if (!force && Date.now() < nextSendAt) return false;
    sending = true;
    try {
      while (buffer.length) {
        const batch = buffer.take(Math.max(cfg.batch, 500));
        let res;
        try {
          res = await fetch(`${cfg.url}/api/v1/ingest/infrastructure`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cfg.key },
            body: JSON.stringify(buildPayload(cfg, batch, hostInfo, !!jm || batch.some((s) => s.jvm || s.proc))), signal: AbortSignal.timeout(15000),
          });
        } catch (e) { res = { ok: false, status: 0, text: async () => e?.cause?.code ?? e?.message ?? String(e) }; }
        if (res.ok) {
          if (failures) log(`Perfmon reachable again - sent ${batch.length} buffered samples`);
          failures = 0; nextSendAt = 0;
          continue;
        }
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          warn(`Perfmon rejected ${batch.length} samples (HTTP ${res.status}): ${detail}${res.status === 401 || res.status === 403 ? ' - check PERFMON_API_KEY (scope "ingest")' : ''}`);
          continue; // not retryable — drop this batch
        }
        buffer.unshift(batch);
        failures++;
        const wait = backoffMs(failures, cfg.interval * 1000);
        nextSendAt = Date.now() + wait;
        warn(`send failed (${res.status ? `HTTP ${res.status}` : detail}); ${buffer.length} samples buffered, retry in ${Math.round(wait / 1000)}s`);
        return false;
      }
      return true;
    } finally {
      sending = false;
      if (buffer.dropped > reportedDropped) { warn(`buffer full - dropped ${buffer.dropped - reportedDropped} oldest samples (${buffer.dropped} in total)`); reportedDropped = buffer.dropped; }
    }
  }

  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    if (inflight) await Promise.race([inflight, new Promise((r) => setTimeout(r, 15000))]); // finish the sample being taken
    log(`stopping (${reason}) - flushing ${buffer.length} samples`);
    for (let i = 0; i < 3 && buffer.length; i++) { if (await flush(true)) break; await new Promise((r) => setTimeout(r, 1000)); }
    if (buffer.length) warn(`${buffer.length} samples could not be delivered`);
    log(`stopped${buffer.dropped ? ` (${buffer.dropped} samples dropped while Perfmon was unreachable)` : ''}`);
    process.exit(0);
  }

  log(`server "${cfg.server}" (role ${cfg.role}) -> ${cfg.url} every ${cfg.interval}s${cfg.runId ? `, run ${cfg.runId}` : cfg.env ? `, environment ${cfg.env}` : ''}`);
  log(`host: ${hostInfo.os}, ${hostInfo.cores} cores, ${hostInfo.memoryMb} MB; JMeter metrics ${cfg.jmeter ? `on${cfg.jmeterPid ? ` (pid ${cfg.jmeterPid})` : ' (auto-detect)'}${jstatPath ? `, jstat ${jstatPath}` : ', jstat not found'}` : 'off'}${cfg.stopFile ? `; stop file ${cfg.stopFile}` : ''}`);

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (e) => warn('unexpected error (continuing):', e?.stack ?? e));
  process.on('unhandledRejection', (e) => warn('unexpected rejection (continuing):', e?.stack ?? e));

  if (cfg.stopFile) {
    setInterval(() => { try { if (fs.existsSync(cfg.stopFile)) stop('stop file'); } catch { /* ignore */ } }, 1000).unref?.();
  }

  let n = 0;
  const tick = async () => {
    if (stopping) return;
    const t0 = Date.now();
    let done;
    inflight = new Promise((r) => { done = r; });
    try {
      buffer.push(await sample());
      done();
      if (++n % cfg.batch === 0 || failures) await flush();
    } catch (e) { warn('sample failed (continuing):', e?.message ?? e); }
    finally { done(); inflight = null; }
    if (!stopping) setTimeout(tick, Math.max(200, cfg.interval * 1000 - (Date.now() - t0)));
  };
  setTimeout(tick, cfg.interval * 1000);
  return null; // keeps running
}

const isMain = (() => { try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  main().then((code) => { if (code != null) process.exit(code); }).catch((e) => { console.error('[collector] fatal:', e?.stack ?? e); process.exit(1); });
}
