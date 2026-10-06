#!/usr/bin/env node
/**
 * Perfmon Collector — lightweight host metrics agent (no dependencies).
 * Collects CPU, memory, load, process info and sends batches to
 *   POST {PERFMON_URL}/api/v1/ingest/infrastructure
 *
 * Env:
 *   PERFMON_URL        e.g. http://localhost:8080
 *   PERFMON_API_KEY    API key with the "ingest" scope
 *   PERFMON_PROJECT    project key (e.g. payments)
 *   PERFMON_ENV        environment name (e.g. Performance)
 *   PERFMON_RUN_ID     optional; otherwise correlated to the environment's RUNNING run
 *   PERFMON_SERVER     server name (default: hostname)
 *   PERFMON_ROLE       app | db | loadgen | gateway (default: app)
 *   INTERVAL_SEC       sampling interval (default 5); batches are sent every 3 samples
 */
import os from 'node:os';

const cfg = {
  url: (process.env.PERFMON_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  key: process.env.PERFMON_API_KEY ?? '',
  project: process.env.PERFMON_PROJECT,
  env: process.env.PERFMON_ENV,
  runId: process.env.PERFMON_RUN_ID,
  server: process.env.PERFMON_SERVER ?? os.hostname(),
  role: process.env.PERFMON_ROLE ?? 'app',
  interval: Number(process.env.INTERVAL_SEC ?? 5),
};
if (!cfg.key) { console.error('PERFMON_API_KEY is required'); process.exit(1); }

const cpuTimes = () => os.cpus().reduce((a, c) => { for (const [k, v] of Object.entries(c.times)) a[k] = (a[k] ?? 0) + v; return a; }, {});
let prev = cpuTimes();
const buffer = [];

function sample() {
  const now = cpuTimes();
  const total = Object.keys(now).reduce((a, k) => a + (now[k] - (prev[k] ?? 0)), 0);
  const idle = now.idle - prev.idle;
  prev = now;
  const mem = 1 - os.freemem() / os.totalmem();
  buffer.push({
    ts: Date.now(),
    cpuPct: total > 0 ? +(100 * (1 - idle / total)).toFixed(2) : null,
    memoryPct: +(mem * 100).toFixed(2),
    memoryUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
    loadAvg1m: os.loadavg()[0] || null,
  });
}

async function flush() {
  if (!buffer.length) return;
  const metrics = buffer.splice(0);
  const body = {
    project: cfg.project, environment: cfg.env, runId: cfg.runId,
    server: { name: cfg.server, hostname: os.hostname(), os: `${os.type()} ${os.release()}`, cpuCores: os.cpus().length, memoryMb: Math.round(os.totalmem() / 1048576), role: cfg.role },
    metrics,
  };
  try {
    const res = await fetch(`${cfg.url}/api/v1/ingest/infrastructure`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cfg.key }, body: JSON.stringify(body) });
    if (!res.ok) console.error(`[collector] ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error('[collector] send failed:', e.message);
    buffer.unshift(...metrics.slice(-120)); // keep recent samples for retry
  }
}

console.log(`[collector] ${cfg.server} → ${cfg.url} every ${cfg.interval}s`);
let n = 0;
setInterval(() => { sample(); if (++n % 3 === 0) flush(); }, cfg.interval * 1000);
process.on('SIGINT', async () => { await flush(); process.exit(0); });
