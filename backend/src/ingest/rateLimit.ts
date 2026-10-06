import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { selfMetrics } from '../selfmon/registry.js';

/**
 * Token-bucket limiter for ingestion requests, keyed per API key (or user/IP).
 * Default: INGEST_RATE_LIMIT_PER_SEC requests/sec with a burst of 2x.
 * Per-key override: api_keys.rate_limit_per_sec.
 * Note: batching is the intended way to send high metric volumes — one request
 * can carry tens of thousands of samples.
 */
const buckets = new Map<string, { tokens: number; at: number }>();

export function checkIngestRate(req: FastifyRequest) {
  const p = req.principal;
  const key = p ? `${p.kind}:${p.id}` : `ip:${req.ip}`;
  const rate = p?.rateLimitPerSec ?? config.ingestRateLimitPerSec;
  if (rate <= 0) return;
  const burst = rate * 2;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    selfMetrics.inc('ingest_rate_limited');
    throw new ApiError(429, 'RATE_LIMITED', `Ingestion rate limit exceeded (${rate} requests/sec). Batch more samples per request or raise the key's limit.`);
  }
  b.tokens -= 1;
  buckets.set(key, b);
}

setInterval(() => {
  const cutoff = Date.now() - 600000;
  for (const [k, v] of buckets) if (v.at < cutoff) buckets.delete(k);
}, 60000).unref();
