import { migrate } from './migrate.js';
import { pool } from './pool.js';

migrate()
  .then(() => console.log('[migrate] done'))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
