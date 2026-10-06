import { config, assertConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { storage } from './storage/storage.js';
import { bootstrap } from './seed/bootstrap.js';
import { buildApp, buildReportContentApp } from './app.js';
import { startWorker } from './jobs/queue.js';
import { aggregator } from './ingest/aggregator.js';
import { startAlertLoop } from './alerts/evaluator.js';
// job handlers (side-effect registration)
import './analytics/finalize.js';
import './artifacts/service.js';
import './alerts/notifiers.js';

async function main() {
  assertConfig();
  await migrate();
  await storage.init();
  const { orgId } = await bootstrap();
  if (config.seedDemoData) {
    try {
      const { seedDemo } = await import('./seed/demo.js');
      await seedDemo(orgId);
    } catch (e) {
      if ((e as any).code !== 'ERR_MODULE_NOT_FOUND') console.error('[seed] demo data failed:', (e as Error).message);
    }
  }

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  if (config.reportContentOrigin) {
    const content = await buildReportContentApp();
    await content.listen({ port: config.reportContentPort, host: config.host });
    app.log.info(`report content (sandbox origin) listening on :${config.reportContentPort}`);
  }
  aggregator.start();
  if (config.enableWorker) await startWorker();
  startAlertLoop();
  app.log.info(`Perfmon API ready — docs at http://localhost:${config.port}/api/docs`);

  const shutdown = async () => {
    app.log.info('shutting down…');
    await aggregator.flush(true).catch(() => undefined);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[perfmon] fatal startup error:', e);
  process.exit(1);
});
