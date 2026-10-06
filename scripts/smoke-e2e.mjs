#!/usr/bin/env node
/**
 * End-to-end smoke test of the core Perfmon run lifecycle against a running backend.
 *   node scripts/smoke-e2e.mjs [baseUrl]
 * Creates: project → application → environment → SLA profile → test → 2 runs (baseline + candidate),
 * streams JMeter InfluxDB line protocol, raw samples and infrastructure metrics, completes the runs
 * and asserts that analysis (summary, SLA, regression, insights, result) was produced.
 */
const BASE = (process.argv[2] ?? process.env.PERFMON_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.PERFMON_EMAIL ?? 'admin@perfmon.local';
const PASSWORD = process.env.PERFMON_PASSWORD ?? 'Perfmon@123';
let token;
const fail = (m) => { console.error('✗', m); process.exit(1); };
const ok = (m) => console.log('✓', m);

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + '/api/v1' + path, {
    method, headers: { ...(body && typeof body === 'object' ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}`, ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) fail(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await (await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json();
token = login.token ?? fail('login failed: ' + JSON.stringify(login));
ok('login');

const key = 'smoke-' + Date.now().toString(36);
const project = await call('POST', '/projects', { key, name: 'Smoke ' + key });
const app = await call('POST', '/applications', { projectId: project.id, code: 'pay', name: 'Payments API' });
const env = await call('POST', '/environments', { applicationId: app.id, name: 'Performance', type: 'PERFORMANCE' });
const sla = await call('POST', '/sla/profiles', { projectId: project.id, name: 'Default SLA', rules: [
  { metric: 'p95', warningValue: 1000, criticalValue: 2000 },
  { metric: 'error_pct', warningValue: 1, criticalValue: 5 },
  { metric: 'tps', direction: 'HIGHER', warningValue: 15, criticalValue: 5 },
  { metric: 'p95', scope: 'TRANSACTION', warningValue: 1200, criticalValue: 2500 },
] });
const test = await call('POST', '/tests', { applicationId: app.id, environmentId: env.id, name: 'Payment Load', testType: 'LOAD', slaProfileId: sla.id, loadProfile: { virtualUsers: 50, durationSec: 120, targetTps: 20 } });
ok(`hierarchy created (project ${key})`);

async function runOnce(label, slowFactor, viaInflux) {
  const created = await call('POST', '/runs', { testId: test.id, buildNumber: label, branch: 'main', commit: 'abc' + label, status: 'QUEUED' });
  const runId = created.runId;
  const start = Date.now() - 120_000;
  const txns = ['POST /api/v1/payment', 'GET /api/v1/merchant/12345', 'POST /api/v1/token'];
  if (viaInflux) {
    // JMeter InfluxdbBackendListenerClient format, 5s intervals, ns timestamps
    for (let t = 0; t < 120; t += 5) {
      const ns = BigInt(start + t * 1000) * 1000000n;
      const lines = [];
      let total = 0, errs = 0;
      for (const tx of txns) {
        const base = (tx.includes('payment') ? 600 : 200) * slowFactor;
        const n = 30, e = tx.includes('token') && t > 60 ? 2 : 0;
        total += n; errs += e;
        const tag = tx.replace(/ /g, '\\ ');
        lines.push(`jmeter,application=pay,transaction=${tag},statut=all count=${n},avg=${base},min=${base * 0.4},max=${base * 3},sb=${n * 400},rb=${n * 2000},pct90.0=${base * 1.5},pct95.0=${base * 1.8},pct99.0=${base * 2.5} ${ns}`);
        if (e) lines.push(`jmeter,application=pay,transaction=${tag},statut=ko count=${e},avg=${base * 2} ${ns}`);
        if (e) lines.push(`jmeter,application=pay,transaction=${tag},responseCode=500,responseMessage=Internal\\ Server\\ Error count=${e} ${ns}`);
      }
      lines.push(`jmeter,application=pay,transaction=internal minAT=50,maxAT=50,meanAT=50,startedT=50,endedT=0 ${ns}`);
      const res = await fetch(`${BASE}/api/v1/ingest/influx/write?db=jmeter&runId=${runId}`, { method: 'POST', headers: { authorization: `Token ${token}`, 'content-type': 'text/plain' }, body: lines.join('\n') });
      if (res.status !== 204) fail(`influx write → ${res.status} ${await res.text()}`);
    }
  } else {
    const samples = [];
    for (let t = 0; t < 120_000; t += 50) {
      const tx = txns[(t / 50) % 3];
      const base = (tx.includes('payment') ? 600 : 200) * slowFactor;
      const elapsed = Math.round(base * (0.5 + Math.random()) + (Math.random() < 0.03 ? base * 3 : 0));
      const failed = Math.random() < 0.004;
      samples.push({ ts: start + t, label: tx, elapsed, success: !failed, responseCode: failed ? '503' : '200', responseMessage: failed ? 'Service Unavailable' : 'OK', bytes: 2000, sentBytes: 400, allThreads: 50, url: 'https://pay.example.com' + tx.split(' ')[1] });
    }
    for (let i = 0; i < samples.length; i += 1000) await call('POST', `/runs/${runId}/metrics`, { samples: samples.slice(i, i + 1000) });
  }
  // infrastructure: app server + db
  const metrics = [], db = [], jvm = [];
  for (let t = 0; t < 120; t += 5) {
    metrics.push({ ts: start + t * 1000, cpuPct: 35 + Math.random() * 10, memoryPct: 60 + t / 10, diskPct: 40, netInBps: 2e6, netOutBps: 3e6, loadAvg1m: 2.1 });
    db.push({ ts: start + t * 1000, engine: 'postgresql', connections: 40, activeConnections: 20, maxConnections: 100, queryLatencyMs: 40 * slowFactor * (1 + t / 240), slowQueries: slowFactor > 1 ? 3 : 0, cpuPct: 30 });
    jvm.push({ ts: start + t * 1000, heapUsedMb: 900 + t * 3, heapMaxMb: 2048, heapCommittedMb: 1500, gcCount: 10, gcTimeMs: 40, gcMaxPauseMs: 35, threadCount: 120 });
  }
  await call('POST', '/ingest/infrastructure', { runId, server: { name: `${key}-app-01`, role: 'app', cpuCores: 8, memoryMb: 16384 }, service: { name: 'payment-service', kind: 'service' }, metrics, jvm });
  await call('POST', '/ingest/infrastructure', { runId, server: { name: `${key}-db-01`, role: 'db' }, service: { name: 'payments-db', kind: 'database', technology: 'PostgreSQL' }, database: db });
  await call('POST', '/ingest/flush', { runId });
  const live = await call('GET', `/runs/${runId}`);
  if (live.status !== 'RUNNING') fail(`expected RUNNING after ingest, got ${live.status}`);
  ok(`${label}: ${runId} RUNNING, live TPS ${live.summary?.tps?.toFixed(1)} p95 ${live.summary?.p95?.toFixed(0)} (${live.summary?.percentileMethod})`);
  await call('POST', `/runs/${runId}/complete`, {});
  for (let i = 0; i < 60; i++) {
    const r = await call('GET', `/runs/${runId}`);
    if (r.status === 'COMPLETED') return r;
    if (i === 59) fail(`run did not complete (status ${r.status})`);
    await sleep(500);
  }
}

const a = await runOnce('101', 1.0, false);
ok(`baseline ${a.runId}: result=${a.result} score=${a.performanceScore} sla=${a.summary.slaPassPct?.toFixed(1)}% p95=${a.summary.p95?.toFixed(0)} (${a.summary.percentileMethod})`);
await call('POST', `/runs/${a.runId}/baseline`, { baseline: true });
const b = await runOnce('102', 1.6, true);
ok(`candidate ${b.runId}: result=${b.result} score=${b.performanceScore} sla=${b.summary.slaPassPct?.toFixed(1)}% p95=${b.summary.p95?.toFixed(0)} (${b.summary.percentileMethod})`);

const ins = await call('GET', `/runs/${b.runId}/insights`);
if (!ins.insights.length) fail('no insights generated');
const regs = ins.regressions.filter((r) => r.direction === 'REGRESSION');
if (!regs.length) fail('expected regressions vs baseline');
ok(`${ins.insights.length} insights, ${regs.length} regressions; top: ${ins.insights[0].title}`);
console.log('   bottlenecks:', (ins.analysis?.bottlenecks ?? []).slice(0, 3).map((c) => `${c.component} ${(c.confidence * 100).toFixed(0)}% (${c.label})`).join('; '));
const txns = await call('GET', `/runs/${b.runId}/transactions`);
ok(`transactions: ${txns.items.map((t) => `${t.name}=${t.p95?.toFixed(0)}ms/${t.slaStatus}`).join(', ')}`);
const eps = await call('GET', `/runs/${a.runId}/endpoints`);
ok(`endpoints normalized: ${eps.map((e) => `${e.method} ${e.endpoint}`).join(', ')}`);
const errs = await call('GET', `/runs/${b.runId}/errors?groupBy=response_code`);
ok(`errors by code: ${errs.map((e) => `${e.key}=${e.count}`).join(', ')}`);
const cmp = await call('GET', `/runs/${b.runId}/comparison`);
ok(`comparison vs ${cmp.baseline.runKey}: P95 change ${cmp.metrics.find((m) => m.key === 'p95')?.changes[1]?.toFixed(1)}%`);
const tl = await call('GET', `/runs/${a.runId}/timeline`);
ok(`timeline: ${tl.points.length} points @ ${tl.step}s, infra ${tl.infra.length}, events ${tl.events.length}`);
const text = await (await fetch(`${BASE}/api/v1/runs/${b.runId}/summary-text`, { headers: { authorization: `Bearer ${token}` } })).text();
console.log('\n' + text.split('\n').filter(Boolean).join(' | ') + '\n');
console.log(JSON.stringify({ projectKey: key, baseline: a.runId, candidate: b.runId }));
