import { pool, bulkInsert, query } from '../db/pool.js';
import { Histogram } from '../lib/histogram.js';
import { inferEndpoint } from '../lib/endpoints.js';
import { config } from '../config.js';
import { selfMetrics } from '../selfmon/registry.js';
import { publishRunEvent } from '../live/hub.js';
import type { RunRef } from './runCache.js';

/** One JMeter-style sample result (JTL row / raw JSON sample). */
export interface RawSample {
  ts: number;               // epoch ms (sample timestamp)
  label: string;
  elapsed: number;          // ms
  success: boolean;
  responseCode?: string | null;
  responseMessage?: string | null;
  failureMessage?: string | null;
  bytes?: number | null;
  sentBytes?: number | null;
  latency?: number | null;
  connect?: number | null;
  url?: string | null;
  method?: string | null;
  allThreads?: number | null;
}

/** Pre-aggregated point (JMeter Backend Listener, CI tools, JSON API). transaction null => run total. */
export interface AggregatePoint {
  ts: number;
  intervalSec?: number;
  transaction?: string | null;
  count: number;
  errors?: number;
  avg?: number | null;
  min?: number | null;
  max?: number | null;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
  p95?: number | null;
  p99?: number | null;
  p999?: number | null;
  sentBytes?: number | null;
  receivedBytes?: number | null;
  activeThreads?: number | null;
  startedThreads?: number | null;
  finishedThreads?: number | null;
  responseCodes?: Record<string, number>;
  errorDetails?: { responseCode?: string | null; message?: string | null; count: number }[];
}

const PCTS = ['p50', 'p75', 'p90', 'p95', 'p99', 'p999'] as const;
type Pct = (typeof PCTS)[number];
const PCT_VALUES: Record<Pct, number> = { p50: 50, p75: 75, p90: 90, p95: 95, p99: 99, p999: 99.9 };

class Acc {
  count = 0;
  errors = 0;
  sum = 0;
  sumSq: number | null = 0;
  min = Infinity;
  max = -Infinity;
  hist: Histogram | null = null;          // only when every contribution was raw
  reported: Partial<Record<Pct, { w: number; v: number }>> = {}; // count-weighted reported percentiles
  bytesSent = 0;
  bytesRecv = 0;
  latSum: number | null = 0;
  conSum: number | null = 0;
  threads: number | null = null;
  started: number | null = null;
  finished: number | null = null;
  interval = 1;
  touched = Date.now();
  rawOnly = true;
  statusCodes: Record<string, number> = {};

  addRaw(s: RawSample) {
    this.count++;
    if (!s.success) this.errors++;
    this.sum += s.elapsed;
    if (this.sumSq != null) this.sumSq += s.elapsed * s.elapsed;
    if (s.elapsed < this.min) this.min = s.elapsed;
    if (s.elapsed > this.max) this.max = s.elapsed;
    if (this.rawOnly) (this.hist ??= new Histogram()).record(s.elapsed);
    this.bytesRecv += s.bytes ?? 0;
    this.bytesSent += s.sentBytes ?? 0;
    if (this.latSum != null) this.latSum += s.latency ?? 0;
    if (this.conSum != null) this.conSum += s.connect ?? 0;
    if (s.allThreads != null) this.threads = Math.max(this.threads ?? 0, s.allThreads);
    this.touched = Date.now();
  }

  addAggregate(p: AggregatePoint) {
    const n = p.count;
    this.rawOnly = false;
    this.hist = null;
    this.sumSq = null;
    this.latSum = null;
    this.conSum = null;
    this.count += n;
    this.errors += p.errors ?? 0;
    if (p.avg != null) this.sum += p.avg * n;
    if (p.min != null && p.min < this.min) this.min = p.min;
    if (p.max != null && p.max > this.max) this.max = p.max;
    for (const k of PCTS) {
      const v = p[k];
      if (v == null || !Number.isFinite(v) || n <= 0) continue;
      const r = (this.reported[k] ??= { w: 0, v: 0 });
      r.v = (r.v * r.w + v * n) / (r.w + n);
      r.w += n;
    }
    this.bytesSent += p.sentBytes ?? 0;
    this.bytesRecv += p.receivedBytes ?? 0;
    if (p.activeThreads != null) this.threads = Math.max(this.threads ?? 0, p.activeThreads);
    if (p.startedThreads != null) this.started = Math.max(this.started ?? 0, p.startedThreads);
    if (p.finishedThreads != null) this.finished = Math.max(this.finished ?? 0, p.finishedThreads);
    if (p.intervalSec) this.interval = p.intervalSec;
    this.touched = Date.now();
  }

  percentiles(): Record<Pct, number | null> {
    const out = {} as Record<Pct, number | null>;
    for (const k of PCTS) {
      out[k] = this.hist ? this.hist.percentile(PCT_VALUES[k], this.min, this.max) : this.reported[k]?.v ?? null;
    }
    return out;
  }
}

interface Keyed<T> { run: RunRef; ts: number; source: string; acc: T }

const trunc = (ms: number, step: number) => Math.floor(ms / (step * 1000)) * step * 1000;

export function classifyError(code: string | null | undefined, message: string | null | undefined, failureMessage?: string | null): string {
  const c = (code ?? '').toString();
  const text = `${c} ${message ?? ''} ${failureMessage ?? ''}`.toLowerCase();
  if (/unknownhost|name or service not known|nodename nor servname|dns/.test(text)) return 'DNS';
  if (/ssl|handshake|certificate|tls/.test(text)) return 'SSL';
  if (/timeout|timed out|sockettimeout/.test(text)) return 'TIMEOUT';
  if (/connect(ion)? refused|connectexception|connection reset|nohttpresponse|broken pipe|connection closed|econn/.test(text)) return 'CONNECTION';
  const num = Number(c);
  if (Number.isFinite(num) && num >= 400) return 'HTTP';
  if (failureMessage && (!Number.isFinite(num) || num < 400)) return 'ASSERTION';
  if (/exception|error/.test(text)) return 'EXCEPTION';
  return 'OTHER';
}

class Aggregator {
  private txn = new Map<string, Keyed<Acc> & { name: string }>();
  private runLevel = new Map<string, Keyed<Acc> & { explicit: boolean }>();
  private codes = new Map<string, { run: RunRef; ts: number; source: string; txn: string; code: string; success: boolean; count: number; touched: number }>();
  private errors = new Map<string, { run: RunRef; ts: number; source: string; txn: string; endpoint: string | null; code: string | null; type: string; message: string; count: number; touched: number }>();
  private endpoints = new Map<string, Keyed<Acc> & { method: string; path: string }>();
  private endpointIds = new Map<string, string>();
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private runsTouched = new Map<string, RunRef>();

  get size() {
    return this.txn.size + this.runLevel.size + this.codes.size + this.errors.size + this.endpoints.size;
  }

  start() {
    this.timer ??= setInterval(() => this.flush(false).catch((e) => console.error('[ingest] flush failed', e)), config.ingestFlushIntervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  addSamples(run: RunRef, samples: RawSample[], source = 'live') {
    for (const s of samples) {
      if (!s.label || !Number.isFinite(s.ts) || !Number.isFinite(s.elapsed)) continue;
      const sec = trunc(s.ts, 1);
      const tk = `${run.id}|${s.label}|${sec}|${source}`;
      let t = this.txn.get(tk);
      if (!t) this.txn.set(tk, (t = { run, ts: sec, source, acc: new Acc(), name: s.label }));
      t.acc.addRaw(s);

      const rk = `${run.id}|${sec}|${source}`;
      let r = this.runLevel.get(rk);
      if (!r) this.runLevel.set(rk, (r = { run, ts: sec, source, acc: new Acc(), explicit: false }));
      r.acc.addRaw(s);

      const code = (s.responseCode ?? (s.success ? '200' : 'ERR')).toString().slice(0, 120);
      const ck = `${run.id}|${s.label}|${code}|${sec}|${source}`;
      const c = this.codes.get(ck);
      if (c) { c.count++; c.touched = Date.now(); }
      else this.codes.set(ck, { run, ts: sec, source, txn: s.label, code, success: s.success, count: 1, touched: Date.now() });

      const ep = inferEndpoint(s.label, s.url, s.method);
      if (ep) {
        const ek = `${run.id}|${ep.method} ${ep.path}|${sec}|${source}`;
        let e = this.endpoints.get(ek);
        if (!e) this.endpoints.set(ek, (e = { run, ts: sec, source, acc: new Acc(), method: ep.method, path: ep.path }));
        e.acc.addRaw(s);
        e.acc.statusCodes[code] = (e.acc.statusCodes[code] ?? 0) + 1;
      }

      if (!s.success) {
        const type = classifyError(s.responseCode, s.responseMessage, s.failureMessage);
        const message = (s.failureMessage || s.responseMessage || '').toString().slice(0, 500);
        const ets = trunc(s.ts, 5);
        const endpoint = ep ? `${ep.method} ${ep.path}` : null;
        const errKey = `${run.id}|${s.label}|${endpoint}|${code}|${type}|${message}|${ets}|${source}`;
        const er = this.errors.get(errKey);
        if (er) { er.count++; er.touched = Date.now(); }
        else this.errors.set(errKey, { run, ts: ets, source, txn: s.label, endpoint, code, type, message, count: 1, touched: Date.now() });
      }
    }
    this.runsTouched.set(run.id, run);
    selfMetrics.inc('ingest_samples', samples.length);
  }

  addAggregates(run: RunRef, points: AggregatePoint[], source = 'live') {
    for (const p of points) {
      if (!Number.isFinite(p.ts) || !(p.count >= 0)) continue;
      const sec = trunc(p.ts, 1);
      const isTotal = !p.transaction || p.transaction === 'all' || p.transaction === '__all__';
      if (isTotal) {
        const rk = `${run.id}|${sec}|${source}`;
        let r = this.runLevel.get(rk);
        if (!r || !r.explicit) this.runLevel.set(rk, (r = { run, ts: sec, source, acc: new Acc(), explicit: true }));
        r.acc.addAggregate(p);
      } else {
        const tk = `${run.id}|${p.transaction}|${sec}|${source}`;
        let t = this.txn.get(tk);
        if (!t) this.txn.set(tk, (t = { run, ts: sec, source, acc: new Acc(), name: p.transaction! }));
        t.acc.addAggregate(p);
        // Derived run-level row unless the source sends an explicit total for this bucket
        const rk = `${run.id}|${sec}|${source}`;
        let r = this.runLevel.get(rk);
        if (!r) this.runLevel.set(rk, (r = { run, ts: sec, source, acc: new Acc(), explicit: false }));
        if (!r.explicit) r.acc.addAggregate({ ...p, activeThreads: p.activeThreads });
      }
      for (const [code, count] of Object.entries(p.responseCodes ?? {})) {
        const txn = isTotal ? '__all__' : p.transaction!;
        const ck = `${run.id}|${txn}|${code}|${sec}|${source}`;
        const c = this.codes.get(ck);
        const success = /^[123]\d\d$/.test(code);
        if (c) c.count += count;
        else this.codes.set(ck, { run, ts: sec, source, txn, code, success, count, touched: Date.now() });
      }
      for (const e of p.errorDetails ?? []) {
        const txn = isTotal ? '__all__' : p.transaction!;
        const type = classifyError(e.responseCode, e.message);
        const message = (e.message ?? '').slice(0, 500);
        const ek = `${run.id}|${txn}|null|${e.responseCode}|${type}|${message}|${sec}|${source}`;
        const er = this.errors.get(ek);
        if (er) er.count += e.count;
        else this.errors.set(ek, { run, ts: sec, source, txn, endpoint: null, code: e.responseCode ?? null, type, message, count: e.count, touched: Date.now() });
      }
    }
    this.runsTouched.set(run.id, run);
    selfMetrics.inc('ingest_points', points.length);
  }

  /** Thread-count only update (e.g. JMeter "internal" users line). */
  setThreads(run: RunRef, ts: number, active: number, started?: number | null, finished?: number | null, source = 'live') {
    const sec = trunc(ts, 1);
    const rk = `${run.id}|${sec}|${source}`;
    let r = this.runLevel.get(rk);
    if (!r) this.runLevel.set(rk, (r = { run, ts: sec, source, acc: new Acc(), explicit: false }));
    r.acc.threads = Math.max(r.acc.threads ?? 0, active);
    if (started != null) r.acc.started = started;
    if (finished != null) r.acc.finished = finished;
    r.acc.touched = Date.now();
    this.runsTouched.set(run.id, run);
  }

  async maybeFlush() {
    if (this.size > config.ingestMaxBuffer) await this.flush(true);
  }

  /** Flush buckets not touched in the last second (or everything when force=true). */
  async flush(force: boolean, runId?: string): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (!force) return;
    }
    this.flushing = this.doFlush(force, runId).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private take<T extends { touched?: number; acc?: Acc; run: RunRef }>(map: Map<string, T>, force: boolean, runId?: string) {
    const cutoff = Date.now() - 1000;
    const out: T[] = [];
    for (const [k, v] of map) {
      if (runId && v.run.id !== runId) continue;
      const touched = v.acc ? v.acc.touched : v.touched!;
      if (force || touched < cutoff) { out.push(v); map.delete(k); }
    }
    return out;
  }

  private async doFlush(force: boolean, runId?: string) {
    const t0 = performance.now();
    const txns = this.take(this.txn, force, runId);
    const runs = this.take(this.runLevel, force, runId);
    const codes = this.take(this.codes, force, runId);
    const errors = this.take(this.errors, force, runId);
    const eps = this.take(this.endpoints, force, runId);
    if (!txns.length && !runs.length && !codes.length && !errors.length && !eps.length) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const num = (v: number) => (Number.isFinite(v) ? v : null);

      for (let i = 0; i < runs.length; i += 400) {
        const rows = runs.slice(i, i + 400).map(({ run, ts, source, acc }) => {
          const p = acc.percentiles();
          return [run.id, new Date(ts), acc.interval, acc.threads, acc.started, acc.finished, acc.count, acc.errors, acc.sum, acc.sumSq, num(acc.min), num(acc.max),
            p.p50, p.p75, p.p90, p.p95, p.p99, p.p999, acc.bytesSent, acc.bytesRecv, acc.hist?.toSparse() ?? null, source];
        });
        const [sql, params] = bulkInsert('run_metrics',
          ['run_id', 'ts', 'interval_sec', 'active_threads', 'started_threads', 'finished_threads', 'sample_count', 'error_count', 'sum_rt', 'sum_sq_rt', 'min_rt', 'max_rt', 'p50', 'p75', 'p90', 'p95', 'p99', 'p999', 'bytes_sent', 'bytes_received', 'histogram', 'source'],
          rows,
          `ON CONFLICT (run_id, ts, source) DO UPDATE SET
             active_threads = GREATEST(run_metrics.active_threads, EXCLUDED.active_threads),
             started_threads = GREATEST(run_metrics.started_threads, EXCLUDED.started_threads),
             finished_threads = GREATEST(run_metrics.finished_threads, EXCLUDED.finished_threads),
             sample_count = run_metrics.sample_count + EXCLUDED.sample_count,
             error_count = run_metrics.error_count + EXCLUDED.error_count,
             sum_rt = run_metrics.sum_rt + EXCLUDED.sum_rt,
             sum_sq_rt = run_metrics.sum_sq_rt + EXCLUDED.sum_sq_rt,
             min_rt = LEAST(run_metrics.min_rt, EXCLUDED.min_rt),
             max_rt = GREATEST(run_metrics.max_rt, EXCLUDED.max_rt),
             p50 = GREATEST(run_metrics.p50, EXCLUDED.p50), p75 = GREATEST(run_metrics.p75, EXCLUDED.p75),
             p90 = GREATEST(run_metrics.p90, EXCLUDED.p90), p95 = GREATEST(run_metrics.p95, EXCLUDED.p95),
             p99 = GREATEST(run_metrics.p99, EXCLUDED.p99), p999 = GREATEST(run_metrics.p999, EXCLUDED.p999),
             bytes_sent = run_metrics.bytes_sent + EXCLUDED.bytes_sent,
             bytes_received = run_metrics.bytes_received + EXCLUDED.bytes_received,
             histogram = CASE WHEN run_metrics.histogram IS NULL OR EXCLUDED.histogram IS NULL THEN NULL ELSE run_metrics.histogram || EXCLUDED.histogram END`);
        await client.query(sql, params as any[]);
      }

      for (let i = 0; i < txns.length; i += 400) {
        const rows = txns.slice(i, i + 400).map(({ run, ts, source, acc, name }) => {
          const p = acc.percentiles();
          return [run.id, new Date(ts), acc.interval, name.slice(0, 300), acc.count, acc.errors, acc.sum, acc.sumSq, num(acc.min), num(acc.max),
            p.p50, p.p75, p.p90, p.p95, p.p99, p.p999, acc.bytesSent, acc.bytesRecv, acc.latSum, acc.conSum, acc.hist?.toSparse() ?? null, source];
        });
        const [sql, params] = bulkInsert('transaction_metrics',
          ['run_id', 'ts', 'interval_sec', 'transaction', 'sample_count', 'error_count', 'sum_rt', 'sum_sq_rt', 'min_rt', 'max_rt', 'p50', 'p75', 'p90', 'p95', 'p99', 'p999', 'bytes_sent', 'bytes_received', 'sum_latency', 'sum_connect', 'histogram', 'source'],
          rows,
          `ON CONFLICT (run_id, transaction, ts, source) DO UPDATE SET
             sample_count = transaction_metrics.sample_count + EXCLUDED.sample_count,
             error_count = transaction_metrics.error_count + EXCLUDED.error_count,
             sum_rt = transaction_metrics.sum_rt + EXCLUDED.sum_rt,
             sum_sq_rt = transaction_metrics.sum_sq_rt + EXCLUDED.sum_sq_rt,
             min_rt = LEAST(transaction_metrics.min_rt, EXCLUDED.min_rt),
             max_rt = GREATEST(transaction_metrics.max_rt, EXCLUDED.max_rt),
             p50 = GREATEST(transaction_metrics.p50, EXCLUDED.p50), p75 = GREATEST(transaction_metrics.p75, EXCLUDED.p75),
             p90 = GREATEST(transaction_metrics.p90, EXCLUDED.p90), p95 = GREATEST(transaction_metrics.p95, EXCLUDED.p95),
             p99 = GREATEST(transaction_metrics.p99, EXCLUDED.p99), p999 = GREATEST(transaction_metrics.p999, EXCLUDED.p999),
             bytes_sent = transaction_metrics.bytes_sent + EXCLUDED.bytes_sent,
             bytes_received = transaction_metrics.bytes_received + EXCLUDED.bytes_received,
             sum_latency = transaction_metrics.sum_latency + EXCLUDED.sum_latency,
             sum_connect = transaction_metrics.sum_connect + EXCLUDED.sum_connect,
             histogram = CASE WHEN transaction_metrics.histogram IS NULL OR EXCLUDED.histogram IS NULL THEN NULL ELSE transaction_metrics.histogram || EXCLUDED.histogram END`);
        await client.query(sql, params as any[]);
      }

      for (let i = 0; i < codes.length; i += 1000) {
        const rows = codes.slice(i, i + 1000).map((c) => [c.run.id, new Date(c.ts), c.txn.slice(0, 300), c.code, c.success, c.count, c.source]);
        const [sql, params] = bulkInsert('response_code_metrics', ['run_id', 'ts', 'transaction', 'response_code', 'success', 'count', 'source'], rows,
          `ON CONFLICT (run_id, transaction, response_code, ts, source) DO UPDATE SET count = response_code_metrics.count + EXCLUDED.count`);
        await client.query(sql, params as any[]);
      }

      for (let i = 0; i < errors.length; i += 1000) {
        const rows = errors.slice(i, i + 1000).map((e) => [e.run.id, new Date(e.ts), e.txn.slice(0, 300), e.endpoint, e.code, e.type, e.message, e.count, e.source]);
        const [sql, params] = bulkInsert('error_metrics', ['run_id', 'ts', 'transaction', 'endpoint', 'response_code', 'error_type', 'message', 'count', 'source'], rows);
        await client.query(sql, params as any[]);
      }

      if (eps.length) {
        // resolve endpoint ids (upsert into api_endpoints, cached)
        for (const e of eps) {
          const k = `${e.run.applicationId}|${e.method}|${e.path}`;
          if (this.endpointIds.has(k)) continue;
          const r = await client.query(
            `INSERT INTO api_endpoints (application_id, method, path_template) VALUES ($1,$2,$3)
             ON CONFLICT (application_id, method, path_template) DO UPDATE SET method = EXCLUDED.method RETURNING id`,
            [e.run.applicationId, e.method, e.path.slice(0, 500)]);
          this.endpointIds.set(k, r.rows[0].id);
        }
        for (let i = 0; i < eps.length; i += 500) {
          const rows = eps.slice(i, i + 500).map(({ run, ts, source, acc, method, path }) => {
            const p = acc.percentiles();
            return [run.id, this.endpointIds.get(`${run.applicationId}|${method}|${path}`), new Date(ts), acc.interval, acc.count, acc.errors, acc.sum, num(acc.min), num(acc.max), p.p95, p.p99, acc.hist?.toSparse() ?? null, JSON.stringify(acc.statusCodes), source];
          });
          const [sql, params] = bulkInsert('api_metrics', ['run_id', 'endpoint_id', 'ts', 'interval_sec', 'sample_count', 'error_count', 'sum_rt', 'min_rt', 'max_rt', 'p95', 'p99', 'histogram', 'status_codes', 'source'], rows,
            `ON CONFLICT (run_id, endpoint_id, ts, source) DO UPDATE SET
               sample_count = api_metrics.sample_count + EXCLUDED.sample_count,
               error_count = api_metrics.error_count + EXCLUDED.error_count,
               sum_rt = api_metrics.sum_rt + EXCLUDED.sum_rt,
               min_rt = LEAST(api_metrics.min_rt, EXCLUDED.min_rt), max_rt = GREATEST(api_metrics.max_rt, EXCLUDED.max_rt),
               p95 = GREATEST(api_metrics.p95, EXCLUDED.p95), p99 = GREATEST(api_metrics.p99, EXCLUDED.p99),
               histogram = CASE WHEN api_metrics.histogram IS NULL OR EXCLUDED.histogram IS NULL THEN NULL ELSE api_metrics.histogram || EXCLUDED.histogram END,
               status_codes = api_metrics.status_codes || EXCLUDED.status_codes`);
          await client.query(sql, params as any[]);
        }
      }

      const touchedRuns = new Set([...runs, ...txns].map((r) => r.run.id));
      if (touchedRuns.size) await client.query(`UPDATE test_runs SET live_last_ingest_at = now() WHERE id = ANY($1::uuid[])`, [[...touchedRuns]]);
      await client.query('COMMIT');

      for (const id of touchedRuns) publishRunEvent(id, 'metrics', { flushedAt: Date.now() });
      selfMetrics.inc('ingest_rows_written', runs.length + txns.length + codes.length + errors.length + eps.length);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      selfMetrics.inc('ingest_failures');
      throw e;
    } finally {
      client.release();
      selfMetrics.observe('ingest_flush_ms', performance.now() - t0);
      selfMetrics.set('ingest_buffer_size', this.size);
    }
  }
}

export const aggregator = new Aggregator();

/** Utility used by tests and the run finalizer to drain everything for one run. */
export async function flushRun(runId: string) {
  await aggregator.flush(true, runId);
}

export async function deleteRunMetrics(runId: string, source: string) {
  for (const t of ['run_metrics', 'transaction_metrics', 'api_metrics', 'response_code_metrics', 'error_metrics']) {
    await query(`DELETE FROM ${t} WHERE run_id = $1 AND source = $2`, [runId, source]);
  }
}
