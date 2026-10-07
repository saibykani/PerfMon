import { assertConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { bootstrap } from './bootstrap.js';
import { seedDemo } from './demo.js';
// job handlers referenced by the seed (alert.notify, run.finalize) are registered on import
import '../analytics/finalize.js';
import '../alerts/notifiers.js';

/** `npm run seed`: migrate, bootstrap and load demo data (idempotent). Jobs are processed by the server's worker. */
assertConfig();
await migrate();
const { orgId } = await bootstrap();
await seedDemo(orgId);
await pool.end();
