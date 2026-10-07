import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependency). Real environment variables always win.
function loadDotEnv() {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}
if (process.env.NODE_ENV !== 'test') loadDotEnv();

const env = (key: string, fallback?: string) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const int = (key: string, fallback: number) => {
  const v = env(key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key: string, fallback: boolean) => {
  const v = env(key);
  return v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const config = {
  env: env('NODE_ENV', 'development')!,
  port: int('PORT', 8080),
  host: env('HOST', '0.0.0.0')!,
  reportContentPort: int('REPORT_CONTENT_PORT', 8081),
  reportContentOrigin: env('REPORT_CONTENT_ORIGIN', ''),
  publicUrl: env('PUBLIC_URL', 'http://localhost:5173')!,
  corsOrigins: (env('CORS_ORIGINS', 'http://localhost:5173,http://localhost:3000') || '').split(',').map((s) => s.trim()).filter(Boolean),
  logLevel: env('LOG_LEVEL', 'info')!,

  databaseUrl: env('DATABASE_URL', 'postgres://perfmon:perfmon@localhost:5433/perfmon')!,
  timeseriesDbUrl: env('TIMESERIES_DB_URL', ''),
  redisUrl: env('REDIS_URL', ''),

  storage: {
    driver: (env('STORAGE_DRIVER', 'local') as 'local' | 's3' | 'azure' | 'postgres'),
    localPath: env('LOCAL_STORAGE_PATH', './storage-data')!,
    s3: {
      endpoint: env('OBJECT_STORAGE_URL', ''),
      bucket: env('OBJECT_STORAGE_BUCKET', 'perfmon')!,
      region: env('OBJECT_STORAGE_REGION', 'us-east-1')!,
      accessKeyId: env('OBJECT_STORAGE_ACCESS_KEY', ''),
      secretAccessKey: env('OBJECT_STORAGE_SECRET_KEY', ''),
      forcePathStyle: bool('OBJECT_STORAGE_FORCE_PATH_STYLE', true),
    },
    azure: {
      connectionString: env('AZURE_STORAGE_CONNECTION_STRING', ''),
      container: env('AZURE_STORAGE_CONTAINER', 'perfmon')!,
    },
  },

  jwtSecret: env('JWT_SECRET', '')!,
  jwtExpiresIn: env('JWT_EXPIRES_IN', '12h')!,
  encryptionKey: env('ENCRYPTION_KEY', '')!,
  maxUploadBytes: int('MAX_UPLOAD_MB', 512) * 1024 * 1024,
  ingestRateLimitPerSec: int('INGEST_RATE_LIMIT_PER_SEC', 100),
  apiRateLimitPerMin: int('API_RATE_LIMIT_PER_MIN', 1200),
  malwareScanUrl: env('MALWARE_SCAN_URL', ''),

  ingestFlushIntervalMs: int('INGEST_FLUSH_INTERVAL_MS', 1000),
  ingestMaxBuffer: int('INGEST_MAX_BUFFER', 50000),
  workerConcurrency: int('WORKER_CONCURRENCY', 4),
  enableWorker: bool('ENABLE_WORKER', true),

  influxdbUrl: env('INFLUXDB_URL', ''),
  prometheusUrl: env('PROMETHEUS_URL', ''),
  dynatraceUrl: env('DYNATRACE_URL', ''),

  smtp: {
    host: env('SMTP_HOST', ''),
    port: int('SMTP_PORT', 587),
    user: env('SMTP_USER', ''),
    password: env('SMTP_PASSWORD', ''),
    from: env('SMTP_FROM', 'perfmon@localhost')!,
  },

  seedDemoData: bool('SEED_DEMO_DATA', true),
  /** Show the demo login on the sign-in page. Keep false for any shared/production deployment. */
  showDemoCredentials: bool('SHOW_DEMO_CREDENTIALS', false),
  demoAdminEmail: env('DEMO_ADMIN_EMAIL', 'admin@perfmon.local')!,
  demoAdminPassword: env('DEMO_ADMIN_PASSWORD', ''),
};

export function assertConfig() {
  const problems: string[] = [];
  if (!config.jwtSecret || config.jwtSecret.length < 16) problems.push('JWT_SECRET must be set (>= 16 chars)');
  if (!config.encryptionKey || config.encryptionKey.length < 16) problems.push('ENCRYPTION_KEY must be set (>= 16 chars)');
  if (config.env === 'production') {
    if (config.jwtSecret.startsWith('change-me')) console.warn('[perfmon] WARNING: JWT_SECRET uses the development default. Override it in production.');
    if (config.encryptionKey.startsWith('change-me')) console.warn('[perfmon] WARNING: ENCRYPTION_KEY uses the development default. Override it in production.');
  }
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
}
