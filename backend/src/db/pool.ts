import pg from 'pg';
import { config } from '../config.js';
import { selfMetrics } from '../selfmon/registry.js';

// bigint/numeric -> number (values we store fit comfortably in double precision)
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30000 });
// Time-series pool: same database unless TIMESERIES_DB_URL points elsewhere.
export const tsPool = config.timeseriesDbUrl ? new pg.Pool({ connectionString: config.timeseriesDbUrl, max: 20 }) : pool;

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const start = performance.now();
  try {
    const res = await db.query<T>(text, params as any[]);
    return res.rows;
  } finally {
    selfMetrics.observe('db_query_ms', performance.now() - start);
  }
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Build a multi-row INSERT. Returns [sql, params]. */
export function bulkInsert(table: string, columns: string[], rows: unknown[][], suffix = ''): [string, unknown[]] {
  const params: unknown[] = [];
  const values = rows.map((r) => '(' + r.map((v) => { params.push(v); return '$' + params.length; }).join(',') + ')');
  return [`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')} ${suffix}`, params];
}
