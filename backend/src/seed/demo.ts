/**
 * Demo data: "Payment Platform" — a believable month of JMeter performance testing.
 *
 * Story (≈30 days):
 *   - Builds 101–104 (release 2.4.0): stable. Baselines are recorded for each test.
 *   - Build 105 (release 2.5.0) adds a real-time fraud-screening query on payment_authorizations.
 *     DB query latency climbs build after build (105 → 108) and P95 degrades with it
 *     (regressions vs baseline, DB bottleneck with high confidence, app CPU stays moderate).
 *   - The 500 TPS stress test on build 106 saturates the DB connection pool (TPS plateaus,
 *     P95 explodes, 503s and timeouts) → FAIL.
 *   - Build 108: db-01 is restarted mid-test → the run fails with JDBC connection errors.
 *   - Build 110 (release 2.5.1) adds a composite index → DB latency and P95 recover,
 *     even better than the original baseline. The stress test now sustains ~470 TPS.
 *
 * All metrics go through the real pipeline: raw JMeter-like samples → ingest aggregator
 * (histogram-exact percentiles) → analyzeRun() (summary, SLA, regression, bottleneck,
 * insights, score, result) → completion alerts.
 */
import { one, query, bulkInsert, pool } from '../db/pool.js';
import { aggregator, type RawSample } from '../ingest/aggregator.js';
import type { RunRef } from '../ingest/runCache.js';
import { invalidateRun } from '../ingest/runCache.js';
import { nextRunKey } from '../runs/service.js';
import { analyzeRun } from '../analytics/finalize.js';
import { evaluateRunCompletionAlerts } from '../alerts/evaluator.js';
import { enqueue } from '../jobs/queue.js';

// ------------------------------------------------------------------ deterministic randomness
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(20261006);
const gauss = () => {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ workload model
interface Txn { label: string; method: string; path: () => string; weight: number; appMs: number; queries: number; extMs: number; reqBytes: number; respBytes: number }
const HOST = 'https://payments-perf.acme-pay.internal';
const merchantId = () => String(10000 + Math.floor(rnd() * 89999));
const txnId = () => `TXN-${String(Math.floor(rnd() * 1e9)).padStart(9, '0')}`;
const TXNS: Txn[] = [
  { label: 'POST /api/v1/token', method: 'POST', path: () => '/api/v1/token', weight: 0.25, appMs: 38, queries: 1, extMs: 0, reqBytes: 310, respBytes: 920 },
  { label: 'GET /api/v1/merchant/{id}', method: 'GET', path: () => `/api/v1/merchant/${merchantId()}`, weight: 0.25, appMs: 46, queries: 2, extMs: 0, reqBytes: 240, respBytes: 2650 },
  { label: 'POST /api/v1/payment', method: 'POST', path: () => '/api/v1/payment', weight: 0.3, appMs: 95, queries: 6, extMs: 45, reqBytes: 1180, respBytes: 1460 },
  { label: 'GET /api/v1/transaction/{id}', method: 'GET', path: () => `/api/v1/transaction/${txnId()}`, weight: 0.15, appMs: 52, queries: 2, extMs: 0, reqBytes: 230, respBytes: 1890 },
  { label: 'POST /api/v1/refund', method: 'POST', path: () => '/api/v1/refund', weight: 0.05, appMs: 110, queries: 6, extMs: 40, reqBytes: 760, respBytes: 1020 },
];
const CUM = (() => { let c = 0; return TXNS.map((t) => (c += t.weight)); })();
const pickTxn = () => { const x = rnd(); return TXNS[CUM.findIndex((c) => x <= c)] ?? TXNS[TXNS.length - 1]; };
const AVG_QUERIES = TXNS.reduce((a, t) => a + t.weight * t.queries, 0);
const DB_POOL = 40;           // HikariCP maximumPoolSize across app-01/app-02
const SIGMA = 0.42;           // log-normal spread of response times

type TestKey = 'baseline' | 'load200' | 'stress' | 'soak';
interface RunPlan {
  test: TestKey; build: string; daysAgo: number; hour: number; dbMs: number; cpuCap: number; errBase: number;
  tester: string; dbRestart?: boolean; dbDrift?: number; notes?: string;
}

const TEST_DEFS: Record<TestKey, { name: string; type: string; description: string; vu: number; tps: number; durationSec: number; rampSec: number; thinkMs: number }> = {
  baseline: { name: 'Baseline Payment Load', type: 'BASELINE', description: 'Steady 100 TPS reference load across the payment API mix (token, merchant lookup, payment, status, refund).', vu: 50, tps: 100, durationSec: 600, rampSec: 60, thinkMs: 400 },
  load200: { name: '200 TPS Payment Load', type: 'LOAD', description: 'Expected Black-Friday peak: 200 TPS for 10 minutes after a 60s ramp-up.', vu: 120, tps: 200, durationSec: 600, rampSec: 60, thinkMs: 350 },
  stress: { name: '500 TPS Stress Test', type: 'STRESS', description: 'Step load 100 → 500 TPS (five 2-minute steps) to find the saturation point.', vu: 400, tps: 500, durationSec: 600, rampSec: 30, thinkMs: 250 },
  soak: { name: '30 Minute Soak Test', type: 'SOAK', description: '100 TPS for 30 minutes to detect leaks, connection-pool drift and GC pressure.', vu: 80, tps: 100, durationSec: 1800, rampSec: 60, thinkMs: 500 },
};

const PLANS: RunPlan[] = [
  { test: 'baseline', build: '101', daysAgo: 29, hour: 9, dbMs: 11, cpuCap: 650, errBase: 0.0006, tester: 'Priya Nair', notes: 'Reference run for release 2.4.0' },
  { test: 'load200', build: '102', daysAgo: 27, hour: 14, dbMs: 12, cpuCap: 650, errBase: 0.0008, tester: 'Priya Nair', notes: 'Baseline for the 200 TPS profile' },
  { test: 'load200', build: '103', daysAgo: 25, hour: 10, dbMs: 12.5, cpuCap: 650, errBase: 0.0008, tester: 'Marco Rossi' },
  { test: 'soak', build: '103', daysAgo: 24, hour: 20, dbMs: 12, cpuCap: 650, errBase: 0.0007, tester: 'Marco Rossi', notes: 'Overnight soak' },
  { test: 'baseline', build: '104', daysAgo: 21, hour: 9, dbMs: 11.5, cpuCap: 650, errBase: 0.0006, tester: 'Priya Nair' },
  { test: 'load200', build: '105', daysAgo: 19, hour: 15, dbMs: 21, cpuCap: 640, errBase: 0.0012, tester: 'Priya Nair', dbDrift: 0.1, notes: 'First run on release 2.5.0 (fraud screening)' },
  { test: 'load200', build: '106', daysAgo: 17, hour: 11, dbMs: 29, cpuCap: 640, errBase: 0.0015, tester: 'Marco Rossi', dbDrift: 0.15 },
  { test: 'stress', build: '106', daysAgo: 15, hour: 13, dbMs: 30, cpuCap: 600, errBase: 0.002, tester: 'Marco Rossi', dbDrift: 0.1, notes: 'Capacity check before the marketing campaign' },
  { test: 'load200', build: '107', daysAgo: 13, hour: 10, dbMs: 43, cpuCap: 630, errBase: 0.002, tester: 'Priya Nair', dbDrift: 0.2 },
  { test: 'load200', build: '108', daysAgo: 11, hour: 16, dbMs: 46, cpuCap: 630, errBase: 0.002, tester: 'Marco Rossi', dbRestart: true, notes: 'db-01 restarted by the DBA during the test' },
  { test: 'soak', build: '108', daysAgo: 9, hour: 21, dbMs: 40, cpuCap: 630, errBase: 0.004, tester: 'Marco Rossi', dbDrift: 0.35 },
  { test: 'load200', build: '110', daysAgo: 6, hour: 10, dbMs: 8.5, cpuCap: 660, errBase: 0.0005, tester: 'Priya Nair', notes: 'Release 2.5.1: composite index on payment_authorizations' },
  { test: 'baseline', build: '111', daysAgo: 4, hour: 9, dbMs: 8, cpuCap: 660, errBase: 0.0005, tester: 'Priya Nair' },
  { test: 'stress', build: '111', daysAgo: 2, hour: 14, dbMs: 9, cpuCap: 560, errBase: 0.0008, tester: 'Marco Rossi', notes: 'Re-test of the saturation point after the index fix' },
  { test: 'soak', build: '112', daysAgo: 1, hour: 20, dbMs: 8.5, cpuCap: 660, errBase: 0.0006, tester: 'Marco Rossi' },
];

const RELEASES = [
  { version: '2.4.0', builds: ['101', '102', '103', '104'], daysAgo: 31, branch: 'release/2.4', notes: 'Tokenization v2, merchant cache' },
  { version: '2.5.0', builds: ['105', '106', '107', '108', '109'], daysAgo: 19.5, branch: 'release/2.5', notes: 'Real-time fraud screening on payment authorization' },
  { version: '2.5.1', builds: ['110', '111', '112'], daysAgo: 6.5, branch: 'release/2.5', notes: 'Hotfix: composite index payment_authorizations(merchant_id, created_at); HikariCP pool 40' },
];

interface Ctx {
  orgId: string; projectId: string; appId: string; envId: string; qaEnvId: string; slaId: string; userId: string | null;
  tests: Record<TestKey, string>; servers: Record<string, string>; services: Record<string, string>; builds: Record<string, { id: string; releaseId: string; version: string; commit: string; branch: string }>;
  ruleIds: string[];
}

const sha = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

// ------------------------------------------------------------------ per-second load model
interface SecondState { offered: number; users: number; dbMs: number; rho: number; achieved: number; qMult: number; overMs: number; errProb: number; restart: boolean }

function modelRun(plan: RunPlan, def: (typeof TEST_DEFS)[TestKey], durationSec: number, restartAt: number | null): SecondState[] {
  const out: SecondState[] = [];
  const phase = rnd() * Math.PI * 2;
  for (let t = 0; t < durationSec; t++) {
    let ramp: number;
    if (plan.test === 'stress') {
      const stepLen = def.durationSec / 5;
      const step = Math.floor(t / stepLen);
      const within = t - step * stepLen;
      const prev = step / 5;
      const next = (step + 1) / 5;
      ramp = within < def.rampSec ? prev + (next - prev) * ((within + 1) / def.rampSec) : next;
      ramp = Math.max(ramp, 0.05);
    } else ramp = t < def.rampSec ? (t + 1) / def.rampSec : 1;
    const restart = restartAt != null && t >= restartAt && t < restartAt + 40;
    const drift = 1 + (plan.dbDrift ?? 0) * (t / durationSec);
    const wave = 1 + 0.18 * Math.sin((2 * Math.PI * t) / 150 + phase) + 0.06 * gauss();
    const offered = def.tps * ramp * (1 + 0.025 * gauss());
    const prevRho = out.length ? out[out.length - 1].rho : 0.3;
    let dbMs = plan.dbMs * drift * wave * (1 + 0.35 * clamp(prevRho, 0, 1.2) ** 2);
    if (restart) dbMs = 900 + 400 * rnd();
    else if (restartAt != null && t >= restartAt + 40 && t < restartAt + 100) dbMs *= 2.2 - (t - restartAt - 40) / 60; // cold cache after restart
    const dbCap = DB_POOL / ((AVG_QUERIES * dbMs) / 1000);
    const cap = Math.min(plan.cpuCap, dbCap);
    const rho = offered / cap;
    const achieved = rho < 0.97 ? offered : cap * 0.97 * (1 + 0.02 * gauss());
    const qMult = 1 + (0.1 * rho * rho) / (1 - Math.min(rho, 0.97));
    const overMs = Math.max(0, rho - 0.97) * 4200;
    const errProb = restart ? 0.38 : plan.errBase + (rho > 0.88 ? (rho - 0.88) * 0.22 : 0);
    out.push({ offered, users: Math.max(1, Math.round(def.vu * ramp)), dbMs, rho, achieved: Math.max(0, achieved), qMult, overMs, errProb, restart });
  }
  return out;
}

function sampleError(st: SecondState, txn: Txn): Pick<RawSample, 'responseCode' | 'responseMessage' | 'failureMessage' | 'elapsed'> | null {
  if (rnd() >= st.errProb) return null;
  if (st.restart) {
    return rnd() < 0.7
      ? { responseCode: '500', responseMessage: 'Internal Server Error', failureMessage: 'Could not open JDBC Connection for transaction; nested exception is org.postgresql.util.PSQLException: Connection to db-01:5432 refused', elapsed: 40 + rnd() * 200 }
      : { responseCode: '503', responseMessage: 'Service Unavailable', failureMessage: 'HikariPool-1 - Connection is not available, request timed out after 30000ms', elapsed: 2000 + rnd() * 3000 };
  }
  const x = rnd();
  if (st.rho > 0.9 && x < 0.45) return { responseCode: '503', responseMessage: 'Service Unavailable', failureMessage: 'HikariPool-1 - Connection is not available, request timed out after 3000ms', elapsed: 3000 + rnd() * 400 };
  if (st.rho > 0.9 && x < 0.8) return { responseCode: 'Non HTTP response code: java.net.SocketTimeoutException', responseMessage: 'Non HTTP response message: Read timed out', failureMessage: null, elapsed: 10000 + rnd() * 50 };
  if (txn.extMs > 0 && x < 0.55) return { responseCode: '502', responseMessage: 'Bad Gateway', failureMessage: 'Card network gateway returned an invalid response (issuer unavailable)', elapsed: 300 + rnd() * 600 };
  if (txn.label.includes('payment') && x < 0.8) return { responseCode: '200', responseMessage: 'OK', failureMessage: 'Assertion failed: $.status expected APPROVED but was PENDING_REVIEW', elapsed: -1 };
  return { responseCode: '500', responseMessage: 'Internal Server Error', failureMessage: null, elapsed: -1 };
}

/** Feeds one run's raw samples through the ingest aggregator, second by second. */
async function generateSamples(ref: RunRef, startMs: number, states: SecondState[]) {
  let total = 0;
  for (let t = 0; t < states.length; t++) {
    const st = states[t];
    const n = Math.max(0, Math.round(st.achieved + gauss() * Math.sqrt(Math.max(1, st.achieved)) * 0.5));
    const batch: RawSample[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const txn = pickTxn();
      const median = (txn.appMs + txn.queries * st.dbMs) * st.qMult + txn.extMs * (1 + 0.15 * gauss() ** 2) + st.overMs;
      let elapsed = median * Math.exp(SIGMA * gauss());
      if (rnd() < 0.004) elapsed *= 3 + rnd() * 3; // GC / network outliers
      const err = sampleError(st, txn);
      if (err && err.elapsed >= 0) elapsed = err.elapsed;
      elapsed = Math.max(3, Math.round(elapsed));
      const path = txn.path();
      const connect = rnd() < 0.05 ? 2 + Math.round(rnd() * 20) : 0;
      batch[i] = {
        ts: startMs + t * 1000 + Math.floor((i / Math.max(1, n)) * 1000),
        label: txn.label, elapsed, success: !err,
        responseCode: err?.responseCode ?? (txn.method === 'POST' && !txn.label.includes('token') ? '201' : '200'),
        responseMessage: err?.responseMessage ?? (txn.method === 'POST' && !txn.label.includes('token') ? 'Created' : 'OK'),
        failureMessage: err?.failureMessage ?? null,
        bytes: err ? 180 : Math.round(txn.respBytes * (0.9 + rnd() * 0.2)), sentBytes: txn.reqBytes,
        latency: Math.max(1, Math.round(elapsed * 0.92)), connect,
        url: HOST + path, method: txn.method, allThreads: st.users,
      };
    }
    aggregator.addSamples(ref, batch, 'live');
    total += n;
  }
  await aggregator.flush(true, ref.id);
  return total;
}

// ------------------------------------------------------------------ infrastructure metrics (collector-style, 5s)
async function generateInfra(ctx: Ctx, runId: string, startMs: number, states: SecondState[], plan: RunPlan) {
  const server: unknown[][] = [];
  const jvm: unknown[][] = [];
  const db: unknown[][] = [];
  const svc: unknown[][] = [];
  const leak = plan.test === 'soak' && (plan.dbDrift ?? 0) > 0.3 ? 0.18 : 0.04;
  let heap = 820;
  let gcCount = 0;
  for (let t = 0; t < states.length; t += 5) {
    const win = states.slice(t, t + 5);
    const avg = (f: (s: SecondState) => number) => win.reduce((a, s) => a + f(s), 0) / win.length;
    const tps = avg((s) => s.achieved);
    const dbMs = avg((s) => s.dbMs);
    const users = Math.max(...win.map((s) => s.users));
    const restart = win.some((s) => s.restart);
    const ts = new Date(startMs + t * 1000);
    const util = tps / plan.cpuCap;
    const appCpu = (share: number) => clamp(11 + 78 * util * share + 2.5 * gauss(), 2, 99.5);
    const memBase = 58 + 6 * (t / states.length) * (plan.test === 'soak' ? 2 : 1);
    // app servers (traffic split 52/48)
    for (const [name, share] of [['app-01', 1.04], ['app-02', 0.96]] as const) {
      server.push([ts, ctx.servers[name], runId, round(appCpu(share)), round(clamp(memBase + 2 * gauss(), 30, 97)), round(16384 * (memBase / 100)), 47 + 0.002 * t, 2.1e5 + 4e4 * rnd(), 1.4e6 + 3e5 * util, round(tps * 2900 * share), round(tps * 2100 * share), round(8 * util * share + 0.4, 2), 212 + Math.round(rnd() * 6), Math.round(80 + users * 1.6), 900 + Math.round(users * 3)]);
    }
    // load generator
    server.push([ts, ctx.servers['lg-01'], runId, round(clamp(8 + tps / 9 + 2 * gauss(), 2, 99)), round(41 + 3 * (t / states.length)), 3360, 31, 1e4, 2e5, round(tps * 2050), round(tps * 2950), round(1 + tps / 150, 2), 148, users + 12, 400 + users * 2]);
    // database server
    const dbCpu = clamp(14 + 0.11 * tps + (dbMs > 25 ? dbMs * 0.5 : 0) + 3 * gauss(), 3, 98);
    server.push([ts, ctx.servers['db-01'], runId, restart ? 4 : round(dbCpu), round(clamp(71 + 2 * gauss(), 40, 96)), 22900, 61, round(3e6 + tps * 9e3), round(1.2e6 + tps * 6e3), round(tps * 1500), round(tps * 3800), round(2 + dbCpu / 20, 2), 96, Math.round(60 + tps * 0.3), 1800]);
    // JVM (payment service on app-01/app-02)
    const pause = clamp(18 + 40 * util + (heap > 1500 ? 90 : 0) + 8 * gauss(), 4, 900);
    gcCount += Math.max(1, Math.round(tps / 60));
    heap += tps * 0.9 * (0.7 + rnd() * 0.6);
    if (heap > 1650) heap = 760 + leak * t * 1.5 + 40 * rnd();
    for (const name of ['app-01', 'app-02']) {
      jvm.push([ts, ctx.servers[name], ctx.services['Payment Service'], runId, round(heap + 30 * gauss()), 1890, 2048, round(182 + 0.002 * t), gcCount, round(pause * 0.7), round(pause), Math.round(92 + users * 0.55), Math.round(110 + users * 0.6), 18342]);
    }
    // database (payments-db)
    const active = restart ? 0 : Math.min(DB_POOL + 20, Math.round(tps * (AVG_QUERIES * dbMs) / 1000 + 2 + rnd() * 2));
    db.push([ts, ctx.services['payments-db'], ctx.servers['db-01'], runId, 'postgresql', restart ? 3 : Math.min(60, active + 18), active, 60, round(dbMs, 2),
      dbMs > 25 ? Math.round((dbMs - 20) / 6 + rnd() * 2) : rnd() < 0.05 ? 1 : 0, Math.round(active * 0.3 + (dbMs > 30 ? 6 : 0)), restart ? 0 : dbMs > 40 && rnd() < 0.08 ? 1 : 0, round(dbCpu), round(70 + 2 * rnd()), round(tps * AVG_QUERIES)]);
    // services (APM view)
    const errPct = avg((s) => s.errProb) * 100;
    const p95 = (130 + AVG_QUERIES * dbMs) * avg((s) => s.qMult) * 2 + avg((s) => s.overMs);
    svc.push([ts, ctx.services['API Gateway'], runId, round(tps, 2), round(errPct, 3), round(p95 * 0.5 + 6, 1), round(p95 + 12, 1), 0, round(appCpu(0.35)), round(memBase - 20)]);
    svc.push([ts, ctx.services['Payment Service'], runId, round(tps, 2), round(errPct, 3), round(p95 * 0.48, 1), round(p95, 1), Math.round(errPct * tps * 0.05), round(appCpu(1)), round(memBase)]);
    svc.push([ts, ctx.services['External Card API'], runId, round(tps * 0.35, 2), round(0.08 + (rnd() < 0.05 ? 0.4 : 0), 3), round(44 + 6 * gauss(), 1), round(92 + 10 * rnd(), 1), 0, null, null]);
  }
  const ins = async (table: string, cols: string[], rows: unknown[][]) => {
    for (let i = 0; i < rows.length; i += 1000) {
      const [sql, params] = bulkInsert(table, cols, rows.slice(i, i + 1000));
      await query(sql, params);
    }
  };
  await ins('server_metrics', ['ts', 'server_id', 'run_id', 'cpu_pct', 'memory_pct', 'memory_used_mb', 'disk_pct', 'disk_read_bps', 'disk_write_bps', 'net_in_bps', 'net_out_bps', 'load_avg_1m', 'processes', 'tcp_connections', 'file_descriptors'], server);
  await ins('jvm_metrics', ['ts', 'server_id', 'service_id', 'run_id', 'heap_used_mb', 'heap_committed_mb', 'heap_max_mb', 'nonheap_used_mb', 'gc_count', 'gc_time_ms', 'gc_max_pause_ms', 'thread_count', 'peak_threads', 'classes_loaded'], jvm);
  await ins('database_metrics', ['ts', 'service_id', 'server_id', 'run_id', 'db_engine', 'connections', 'active_connections', 'max_connections', 'query_latency_ms', 'slow_queries', 'locks', 'deadlocks', 'cpu_pct', 'memory_pct', 'transactions_per_sec'], db);
  await ins('service_metrics', ['ts', 'service_id', 'run_id', 'request_rate', 'error_rate_pct', 'avg_latency_ms', 'p95_latency_ms', 'exceptions', 'cpu_pct', 'memory_pct'], svc);
}

// ------------------------------------------------------------------ logs
async function generateLogs(ctx: Ctx, runId: string, startMs: number, states: SecondState[], plan: RunPlan) {
  const rows: unknown[][] = [];
  const add = (t: number, level: string, service: string, server: string, logger: string, message: string) =>
    rows.push([runId, new Date(startMs + t * 1000), level, service, server, ctx.appId, ctx.envId, logger, message]);
  add(0, 'INFO', 'payment-service', 'app-01', 'c.a.p.PaymentApplication', `Started PaymentApplication (build ${plan.build}) — HikariPool-1 maximumPoolSize=${DB_POOL / 2}`);
  add(0, 'INFO', 'payment-service', 'app-02', 'c.a.p.PaymentApplication', `Started PaymentApplication (build ${plan.build}) — HikariPool-1 maximumPoolSize=${DB_POOL / 2}`);
  for (let t = 30; t < states.length; t += 30) {
    const st = states[t];
    if (st.dbMs > 25 && rnd() < 0.8) add(t, 'WARN', 'payment-service', pick(['app-01', 'app-02']), 'o.h.e.j.s.SqlStatementLogger',
      `Slow query (${Math.round(st.dbMs * (8 + rnd() * 10))} ms): select pa.* from payment_authorizations pa where pa.merchant_id=? and pa.created_at > now() - interval '24 hours' and pa.risk_score > ? order by pa.created_at desc`);
    if (st.rho > 0.9) add(t, 'ERROR', 'payment-service', pick(['app-01', 'app-02']), 'com.zaxxer.hikari.pool.HikariPool', 'HikariPool-1 - Connection is not available, request timed out after 3000ms (total=20, active=20, idle=0, waiting=37)');
    if (st.restart) add(t, 'ERROR', 'payment-service', 'app-01', 'o.s.j.s.SQLErrorCodeSQLExceptionTranslator', 'Could not open JDBC Connection for transaction; nested exception is org.postgresql.util.PSQLException: Connection to db-01:5432 refused');
    if (rnd() < 0.06) add(t, 'WARN', 'payment-service', pick(['app-01', 'app-02']), 'c.a.p.card.CardNetworkClient', 'Card network gateway returned 502 (issuer unavailable) — retrying once');
    if (rnd() < 0.15) add(t, 'INFO', 'api-gateway', 'app-01', 'gateway.access', `GET /actuator/health 200 ${Math.round(2 + rnd() * 4)}ms`);
  }
  const restartAt = states.findIndex((s) => s.restart);
  if (restartAt >= 0) {
    rows.push([runId, new Date(startMs + restartAt * 1000 - 2000), 'LOG', 'payments-db', 'db-01', ctx.appId, ctx.envId, 'postgres', 'LOG:  received fast shutdown request']);
    rows.push([runId, new Date(startMs + (restartAt + 38) * 1000), 'LOG', 'payments-db', 'db-01', ctx.appId, ctx.envId, 'postgres', 'LOG:  database system is ready to accept connections']);
  }
  for (let i = 0; i < rows.length; i += 1000) {
    const [sql, params] = bulkInsert('log_entries', ['run_id', 'ts', 'level', 'service', 'server', 'application_id', 'environment_id', 'logger', 'message'], rows.slice(i, i + 1000));
    await query(sql, params);
  }
}

// ------------------------------------------------------------------ inventory
async function createInventory(orgId: string): Promise<Ctx> {
  const admin = await one(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.organization_id = $1 AND r.name IN ('SUPER_ADMIN','ADMIN') ORDER BY u.created_at LIMIT 1`, [orgId]);
  const userId: string | null = admin?.id ?? null;
  const project = await one(`INSERT INTO projects (organization_id, key, name, description, created_by) VALUES ($1,'payments','Payment Platform',$2,$3) RETURNING id`,
    [orgId, 'Card payments, tokenization and refunds for online merchants. Demo project with a month of JMeter performance testing.', userId]);
  const projectId = project.id as string;
  const app = await one(`INSERT INTO applications (project_id, code, name, description, owner, team, technology, repository, version) VALUES ($1,'merchant-payments','Merchant Payments',$2,'Payments Platform Team','Team Falcon','Java 21 / Spring Boot 3.3','https://git.acme-pay.internal/payments/merchant-payments','2.5.1') RETURNING id`,
    [projectId, 'Merchant-facing payment API: tokenization, authorization, capture, refunds and transaction status.']);
  const env = await one(`INSERT INTO environments (project_id, application_id, name, type, description, base_url, config) VALUES ($1,$2,'Performance','PERFORMANCE',$3,$4,$5) RETURNING id`,
    [projectId, app.id, 'Production-like performance environment (2 app nodes, PostgreSQL 16 primary).', 'https://payments-perf.acme-pay.internal', JSON.stringify({ region: 'eu-west-1', appNodes: 2, dbInstance: 'db.r6g.2xlarge' })]);
  const qa = await one(`INSERT INTO environments (project_id, application_id, name, type, description, base_url) VALUES ($1,$2,'QA','QA','Functional QA environment (single node).','https://payments-qa.acme-pay.internal') RETURNING id`, [projectId, app.id]);

  const servers: Record<string, string> = {};
  for (const s of [
    { name: 'lg-01', host: 'lg-01.perf.acme-pay.internal', ip: '10.20.1.10', os: 'Ubuntu 22.04', cpu: 8, mem: 16384, disk: 100, role: 'loadgen' },
    { name: 'app-01', host: 'app-01.perf.acme-pay.internal', ip: '10.20.2.11', os: 'Ubuntu 22.04', cpu: 8, mem: 16384, disk: 200, role: 'app' },
    { name: 'app-02', host: 'app-02.perf.acme-pay.internal', ip: '10.20.2.12', os: 'Ubuntu 22.04', cpu: 8, mem: 16384, disk: 200, role: 'app' },
    { name: 'db-01', host: 'db-01.perf.acme-pay.internal', ip: '10.20.3.21', os: 'Ubuntu 22.04', cpu: 16, mem: 65536, disk: 1000, role: 'db' },
  ]) {
    const row = await one(`INSERT INTO servers (project_id, environment_id, application_id, name, hostname, ip_address, os, cpu_cores, memory_mb, disk_gb, role, status, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'HEALTHY',$12) RETURNING id`,
      [projectId, env.id, app.id, s.name, s.host, s.ip, s.os, s.cpu, s.mem, s.disk, s.role, JSON.stringify({ team: 'falcon', tier: s.role })]);
    servers[s.name] = row.id;
  }
  const services: Record<string, string> = {};
  for (const s of [
    { name: 'Load Generator', kind: 'loadgen', tech: 'Apache JMeter 5.6.3', server: 'lg-01' },
    { name: 'API Gateway', kind: 'gateway', tech: 'Spring Cloud Gateway', server: 'app-01' },
    { name: 'Payment Service', kind: 'service', tech: 'Java 21 / Spring Boot 3.3', server: 'app-01' },
    { name: 'payments-db', kind: 'database', tech: 'PostgreSQL 16', server: 'db-01' },
    { name: 'External Card API', kind: 'external', tech: 'Card network gateway (HTTPS)', server: null },
  ]) {
    const row = await one(`INSERT INTO services (project_id, application_id, environment_id, server_id, name, kind, technology, health_status) VALUES ($1,$2,$3,$4,$5,$6,$7,'HEALTHY') RETURNING id`,
      [projectId, app.id, env.id, s.server ? servers[s.server] : null, s.name, s.kind, s.tech]);
    services[s.name] = row.id;
  }
  for (const [a, b, proto] of [['Load Generator', 'API Gateway', 'HTTPS'], ['API Gateway', 'Payment Service', 'HTTP'], ['Payment Service', 'payments-db', 'JDBC'], ['Payment Service', 'External Card API', 'HTTPS']]) {
    await query(`INSERT INTO service_dependencies (source_service_id, target_service_id, protocol) VALUES ($1,$2,$3)`, [services[a], services[b], proto]);
  }

  const sla = await one(`INSERT INTO sla_profiles (project_id, name, description) VALUES ($1,'Payments API SLA',$2) RETURNING id`, [projectId, 'Contractual SLOs for the merchant payment API (P95 < 1s, errors < 1%).']);
  const rules: [string | null, string, string, string | null, string, number | null, number | null, string][] = [
    ['P95 response time', 'p95', 'RUN', null, 'LOWER', 1000, 2000, 'ms'],
    ['P99 response time', 'p99', 'RUN', null, 'LOWER', 2000, 4000, 'ms'],
    ['Error rate', 'error_pct', 'RUN', null, 'LOWER', 1, 5, '%'],
    ['Minimum throughput', 'tps', 'RUN', null, 'HIGHER', 90, 50, 'tps'],
    ['Application CPU (p90)', 'cpu_pct', 'RUN', null, 'LOWER', 75, 90, '%'],
    ['Memory (max)', 'memory_pct', 'RUN', null, 'LOWER', 85, 95, '%'],
    ['Payment authorization P95', 'p95', 'TRANSACTION', 'POST /api/v1/payment', 'LOWER', 1200, 2500, 'ms'],
    ['Any transaction P95', 'p95', 'TRANSACTION', '*', 'LOWER', 1500, 3000, 'ms'],
  ];
  let pos = 0;
  for (const [name, metric, scope, pattern, dir, warn, crit, unit] of rules) {
    await query(`INSERT INTO sla_rules (profile_id, name, metric, scope, transaction_pattern, direction, warning_value, critical_value, unit, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sla.id, name, metric, scope, pattern, dir, warn, crit, unit, pos++]);
  }

  const tests = {} as Record<TestKey, string>;
  for (const [key, d] of Object.entries(TEST_DEFS) as [TestKey, (typeof TEST_DEFS)[TestKey]][]) {
    const t = await one(`INSERT INTO performance_tests (project_id, application_id, environment_id, name, description, test_type, sla_profile_id, owner, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'Priya Nair',$8,$9) RETURNING id`,
      [projectId, app.id, env.id, d.name, d.description, d.type, sla.id, ['payments', key === 'stress' ? 'capacity' : key === 'soak' ? 'endurance' : 'regression'], userId]);
    await query(`INSERT INTO test_configurations (test_id, version, virtual_users, ramp_up_sec, ramp_down_sec, duration_sec, target_tps, thread_group, think_time_ms, properties, created_by) VALUES ($1,1,$2,$3,10,$4,$5,$6,$7,$8,$9)`,
      [t.id, d.vu, d.rampSec, d.durationSec, d.tps, key === 'stress' ? 'Concurrency Thread Group (5 steps)' : 'Throughput Shaping Timer + Thread Group', d.thinkMs,
        JSON.stringify({ jmx: `payments-${key}.jmx`, dataSet: 'merchants-50k.csv', jmeterVersion: '5.6.3', backendListener: 'InfluxdbBackendListenerClient' }), userId]);
    tests[key] = t.id;
  }
  await query(`INSERT INTO performance_tests (project_id, application_id, environment_id, name, description, test_type, sla_profile_id, owner, tags) VALUES ($1,$2,$3,'QA Smoke Load','10 TPS functional smoke load on QA before promotion.','LOAD',$4,'Marco Rossi','{smoke}')`,
    [projectId, app.id, qa.id, sla.id]);

  const builds: Ctx['builds'] = {};
  for (const rel of RELEASES) {
    const relRow = await one(`INSERT INTO releases (project_id, application_id, environment_id, name, version, build_number, branch, commit_sha, deployment_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [projectId, app.id, env.id, `Merchant Payments ${rel.version}`, rel.version, rel.builds[0], rel.branch, sha(), new Date(Date.now() - rel.daysAgo * 86400000), rel.notes]);
    for (const b of rel.builds) {
      const commit = sha();
      const row = await one(`INSERT INTO builds (project_id, application_id, release_id, build_number, branch, commit_sha, ci_system, ci_url) VALUES ($1,$2,$3,$4,$5,$6,'jenkins',$7) RETURNING id`,
        [projectId, app.id, relRow.id, b, rel.branch, commit, `https://jenkins.acme-pay.internal/job/merchant-payments/${b}/`]);
      builds[b] = { id: row.id, releaseId: relRow.id, version: rel.version, commit, branch: rel.branch };
    }
  }
  return { orgId, projectId, appId: app.id, envId: env.id, qaEnvId: qa.id, slaId: sla.id, userId, tests, servers, services, builds, ruleIds: [] };
}

async function createAlerting(ctx: Ctx) {
  const ch = await one(`INSERT INTO notification_channels (organization_id, name, type, config, enabled) VALUES ($1,'In-app (Payments team)','IN_APP','{}',true) RETURNING id`, [ctx.orgId]);
  const rules = [
    { name: 'SLA violation', type: 'SLA_VIOLATION', severity: 'CRITICAL', threshold: null, op: '>', window: 60, filters: {} },
    { name: 'Test failed', type: 'TEST_FAILURE', severity: 'CRITICAL', threshold: null, op: '>', window: 60, filters: {} },
    { name: 'Regression vs baseline', type: 'REGRESSION', severity: 'WARNING', threshold: null, op: '>', window: 60, filters: {} },
    { name: 'Payment P95 above 1.5s (live)', type: 'HIGH_P95', severity: 'WARNING', threshold: 1500, op: '>', window: 60, filters: { environmentId: ctx.envId, transaction: 'POST /api/v1/payment' } },
    { name: 'Error rate above 2% (live)', type: 'HIGH_ERROR_RATE', severity: 'CRITICAL', threshold: 2, op: '>', window: 60, filters: { environmentId: ctx.envId } },
    { name: 'App server CPU above 85%', type: 'CPU', severity: 'WARNING', threshold: 85, op: '>', window: 300, filters: { environmentId: ctx.envId } },
    { name: 'JVM heap above 90%', type: 'JVM_HEAP', severity: 'WARNING', threshold: 90, op: '>', window: 300, filters: { environmentId: ctx.envId } },
  ];
  for (const r of rules) {
    const row = await one(`INSERT INTO alert_rules (project_id, name, type, operator, threshold, severity, window_sec, filters, channel_ids, cooldown_sec, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,300,true,$10) RETURNING id`,
      [ctx.projectId, r.name, r.type, r.op, r.threshold, r.severity, r.window, JSON.stringify(r.filters), [ch.id], ctx.userId]);
    ctx.ruleIds.push(row.id);
  }
}

// ------------------------------------------------------------------ one run
async function seedRun(ctx: Ctx, plan: RunPlan, index: number) {
  const def = TEST_DEFS[plan.test];
  const build = ctx.builds[plan.build];
  const day = new Date(Date.now() - plan.daysAgo * 86400000);
  day.setUTCHours(plan.hour, Math.floor(rnd() * 50), 0, 0);
  const startMs = Math.min(day.getTime(), Date.now() - def.durationSec * 1000 - 3600000);
  const restartAt = plan.dbRestart ? Math.floor(def.durationSec * 0.55) : null;
  const durationSec = plan.dbRestart ? Math.floor(def.durationSec * 0.72) : def.durationSec;
  const states = modelRun(plan, def, durationSec, restartAt);

  const runKey = await nextRunKey(pool, new Date(startMs));
  const run = await one(
    `INSERT INTO test_runs (run_key, execution_id, organization_id, project_id, application_id, environment_id, test_id, test_configuration_id, release_id, build_id, build_number,
       version, branch, commit_sha, status, tester, triggered_by, ci_system, ci_url, tags, virtual_users, target_tps, description, started_at, created_by, created_at, load_engine)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT id FROM test_configurations WHERE test_id = $7 AND is_current LIMIT 1),$8,$9,$10,$11,$12,$13,'RUNNING',$14,'CI','jenkins',$15,$16,$17,$18,$19,$20,$21,$22,'JMETER') RETURNING id`,
    [runKey, `jenkins-perf-${4100 + index}`, ctx.orgId, ctx.projectId, ctx.appId, ctx.envId, ctx.tests[plan.test], build.releaseId, build.id, plan.build, build.version, build.branch, build.commit,
      plan.tester, `https://jenkins.acme-pay.internal/job/payments-perf/${4100 + index}/`, [plan.test === 'stress' ? 'stress' : plan.test === 'soak' ? 'soak' : 'nightly', `build-${plan.build}`],
      def.vu, def.tps, plan.notes ?? null, new Date(startMs), ctx.userId, new Date(startMs - 120000)]);
  const ref: RunRef = { id: run.id, runKey, orgId: ctx.orgId, projectId: ctx.projectId, applicationId: ctx.appId, environmentId: ctx.envId, testId: ctx.tests[plan.test], status: 'RUNNING', startedAt: new Date(startMs) };

  const samples = await generateSamples(ref, startMs, states);
  await generateInfra(ctx, run.id, startMs, states, plan);
  await generateLogs(ctx, run.id, startMs, states, plan);

  const endMs = startMs + durationSec * 1000;
  const finalStatus = plan.dbRestart ? 'FAILED' : 'COMPLETED';
  await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, ts, title, source) VALUES ($1,$2,$3,$4,'TEST_START','INFO',$5,$6,'jmeter'), ($1,$2,$3,$4,'TEST_END',$7,$8,$9,'jmeter')`,
    [ctx.projectId, ctx.appId, ctx.envId, run.id, new Date(startMs), `Test started (${runKey})`, finalStatus === 'COMPLETED' ? 'INFO' : 'WARNING', new Date(endMs), `Test ${finalStatus.toLowerCase()} (${runKey})`]);
  await query(`UPDATE test_runs SET status = $2, ended_at = $3, result_reason = $4, live_last_ingest_at = $3, updated_at = $3 WHERE id = $1`,
    [run.id, plan.dbRestart ? 'FAILED' : 'ANALYZING', new Date(endMs), plan.dbRestart ? 'Stopped by tester: db-01 was restarted mid-test (JDBC connection failures).' : null]);
  invalidateRun(ref);

  const res = await analyzeRun(run.id);
  await query(`UPDATE test_runs SET status = $2, analyzed_at = $3, updated_at = $3 WHERE id = $1`, [run.id, finalStatus, new Date(endMs + 45000)]);
  if (res.regressions.some((r) => r.direction === 'REGRESSION')) {
    await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, ts, title, source) VALUES ($1,$2,$3,$4,'REGRESSION',$5,$6,$7,'analytics')`,
      [ctx.projectId, ctx.appId, ctx.envId, run.id, res.regressions.some((r) => r.severity === 'CRITICAL') ? 'CRITICAL' : 'WARNING', new Date(endMs + 60000), `Performance regression detected (${runKey})`]);
  }
  await evaluateRunCompletionAlerts(run.id, { status: finalStatus, result: res.result.result, regressions: res.regressions, slaViolations: res.sla.violations });
  // Alerts/events created "now" by the evaluator belong to the run's completion time.
  const firedAt = new Date(endMs + 60000);
  await query(`UPDATE alerts SET fired_at = $2, last_evaluated_at = $2 WHERE run_id = $1`, [run.id, firedAt]);
  await query(`UPDATE alert_events SET ts = $2 WHERE alert_id IN (SELECT id FROM alerts WHERE run_id = $1)`, [run.id, firedAt]);
  await query(`UPDATE events SET ts = $2 WHERE run_id = $1 AND type = 'ALERT'`, [run.id, firedAt]);
  // Final Test Execution report, as the real finalize job does
  await enqueue('report.generate', { type: 'TEST_EXECUTION', runId: run.id, projectId: ctx.projectId, auto: true }, { runId: run.id, priority: 6 });
  return { id: run.id, runKey, startMs, endMs, samples, result: res.result.result, score: res.score.score, p95: res.summary?.p95 ?? null, tps: res.summary?.tps_avg ?? null, errorPct: res.summary?.error_pct ?? null };
}

// ------------------------------------------------------------------ entry point
export async function seedDemo(orgId: string) {
  const exists = await one(`SELECT id FROM projects WHERE organization_id = $1 AND key = 'payments'`, [orgId]);
  if (exists) return;
  const t0 = Date.now();
  rnd = mulberry32(20261006);
  console.log('[seed] creating demo data (Payment Platform)…');
  const ctx = await createInventory(orgId);
  try {
    await createAlerting(ctx);
    const out: Awaited<ReturnType<typeof seedRun>>[] = [];
    const baselineFor: Partial<Record<TestKey, string>> = {};
    const deployed = new Set<string>();
    for (let i = 0; i < PLANS.length; i++) {
      const plan = PLANS[i];
      // Deployment events precede the first run of a new release
      const rel = RELEASES.find((x) => x.builds.includes(plan.build))!;
      if (!deployed.has(rel.version)) {
        deployed.add(rel.version);
        await query(`INSERT INTO events (project_id, application_id, environment_id, type, severity, ts, title, description, source, data) VALUES ($1,$2,$3,'DEPLOYMENT','INFO',$4,$5,$6,'jenkins',$7)`,
          [ctx.projectId, ctx.appId, ctx.envId, new Date(Date.now() - rel.daysAgo * 86400000), `Deployed Merchant Payments ${rel.version} (build ${plan.build})`, rel.notes, JSON.stringify({ version: rel.version, build: plan.build })]);
      }
      const r = await seedRun(ctx, plan, i);
      out.push(r);
      if (!baselineFor[plan.test] && plan.test !== 'stress') {
        baselineFor[plan.test] = r.id;
        await query(`UPDATE test_runs SET is_baseline = true WHERE id = $1`, [r.id]);
        await query(`UPDATE performance_tests SET baseline_run_id = $2 WHERE id = $1`, [ctx.tests[plan.test], r.id]);
      }
      if (plan.dbRestart) {
        const restartTs = new Date(r.startMs + Math.floor(TEST_DEFS[plan.test].durationSec * 0.55) * 1000);
        await query(`INSERT INTO events (project_id, application_id, environment_id, run_id, type, severity, ts, title, description, source) VALUES ($1,$2,$3,$4,'DB_RESTART','CRITICAL',$5,'payments-db restarted (db-01)',$6,'dba')`,
          [ctx.projectId, ctx.appId, ctx.envId, r.id, restartTs, 'PostgreSQL restarted to apply max_connections/shared_buffers change during the test window. ~40s of JDBC connection failures.']);
        await query(`INSERT INTO annotations (project_id, run_id, environment_id, ts, ts_end, title, text, tags, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,'DB restart during test',$6,$7,$8,'Marco Rossi')`,
          [ctx.projectId, r.id, ctx.envId, restartTs, new Date(restartTs.getTime() + 40000), 'DBA applied a config change without notice. Run stopped; re-test scheduled after the 2.5.1 fix.', ['incident', 'database'], ctx.userId]);
      }
      console.log(`[seed]   ${r.runKey} ${TEST_DEFS[plan.test].name} build ${plan.build}: ${r.samples} samples, p95 ${r.p95?.toFixed(0)} ms, ${r.tps?.toFixed(1)} TPS, err ${r.errorPct?.toFixed(2)}% → ${r.result} (score ${r.score})`);
    }

    // Other annotations / events that make the story readable on dashboards
    const at = (p: number) => out[p];
    await query(`INSERT INTO events (project_id, application_id, environment_id, type, severity, ts, title, description, source) VALUES ($1,$2,$3,'CONFIG_CHANGE','INFO',$4,'HikariCP maximumPoolSize 16 → 20 per node',$5,'ansible')`,
      [ctx.projectId, ctx.appId, ctx.envId, new Date(at(7).startMs - 3 * 3600000), 'Pool increased ahead of the stress test; did not help — DB query latency is the limiting factor.']);
    await query(`INSERT INTO annotations (project_id, run_id, environment_id, ts, title, text, tags, created_by, created_by_name) VALUES
       ($1,$2,$3,$4,'P95 regression after 2.5.0','P95 up vs baseline since build 105. DB query latency doubled; app CPU unchanged. Suspect new fraud-screening query on payment_authorizations.',$5,$6,'Priya Nair'),
       ($1,$7,$3,$8,'Saturation at ~330 TPS','TPS plateaus while users keep rising; HikariCP waits and 503s. Bottleneck: payments-db.',$9,$6,'Marco Rossi'),
       ($1,$10,$3,$11,'Index fix verified','Composite index (merchant_id, created_at) brings DB latency back to ~9 ms; P95 better than the 2.4.0 baseline.',$12,$6,'Priya Nair')`,
      [ctx.projectId, at(5).id, ctx.envId, new Date(at(5).startMs + 300000), ['regression', 'database'], ctx.userId, at(7).id, new Date(at(7).startMs + 420000), ['capacity', 'saturation'], at(11).id, new Date(at(11).startMs + 300000), ['fix', 'database']]);

    // Alerts raised before the 2.5.1 fix are resolved; recent ones stay open.
    const fixTs = new Date(Date.now() - 6.5 * 86400000);
    const resolved = await query(`UPDATE alerts SET status = 'RESOLVED', resolved_at = $2 WHERE project_id = $1 AND status <> 'RESOLVED' AND fired_at < $2 RETURNING id`, [ctx.projectId, fixTs]);
    for (const a of resolved) await query(`INSERT INTO alert_events (alert_id, ts, kind, details) VALUES ($1,$2,'RESOLVED','{"reason":"fixed in release 2.5.1"}')`, [a.id, fixTs]);
    const ack = await one(`UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = fired_at + interval '25 minutes', acknowledged_by = $2 WHERE id = (SELECT id FROM alerts WHERE project_id = $1 AND status = 'FIRING' ORDER BY fired_at LIMIT 1) RETURNING id, acknowledged_at`, [ctx.projectId, ctx.userId]);
    if (ack) await query(`INSERT INTO alert_events (alert_id, ts, kind, details) VALUES ($1,$2,'ACKNOWLEDGED','{"by":"Marco Rossi","comment":"Known: stress profile above contracted peak"}')`, [ack.id, ack.acknowledged_at]);

    // A queued run for the next build (picked up by scripts/simulate-jmeter.mjs --run <id>)
    const qb = ctx.builds['112'];
    const qKey = await nextRunKey(pool);
    await query(
      `INSERT INTO test_runs (run_key, organization_id, project_id, application_id, environment_id, test_id, test_configuration_id, release_id, build_id, build_number, version, branch, commit_sha, status, tester, triggered_by, ci_system, tags, virtual_users, target_tps, description, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,(SELECT id FROM test_configurations WHERE test_id = $6 AND is_current LIMIT 1),$7,$8,'112','2.5.1',$9,$10,'QUEUED','Priya Nair','CI','jenkins',$11,120,200,'Nightly regression run for build 112',$12,$13)`,
      [qKey, ctx.orgId, ctx.projectId, ctx.appId, ctx.envId, ctx.tests.load200, qb.releaseId, qb.id, qb.branch, qb.commit, ['nightly', 'build-112'], new Date(Date.now() + 2 * 3600000), ctx.userId]);

    await query(`UPDATE servers SET status = 'HEALTHY', last_seen_at = $2 WHERE project_id = $1`, [ctx.projectId, new Date(at(out.length - 1).endMs)]);

    try {
      const { seedDefaultDashboards } = await import('../dashboards/defaults.js');
      await seedDefaultDashboards(orgId, ctx.projectId);
    } catch (e) {
      console.error('[seed] default dashboards failed:', (e as Error).message);
    }
    console.log(`[seed] demo data ready: ${out.length} completed runs + 1 queued (${qKey}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    // Leave no half-seeded project behind: the next start retries from scratch.
    await query(`DELETE FROM projects WHERE id = $1`, [ctx.projectId]).catch(() => undefined);
    throw e;
  }
}
