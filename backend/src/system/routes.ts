import type { FastifyInstance } from 'fastify';
import { requirePermission, principalOf } from '../auth/principal.js';
import { hostMonitor } from './hostMonitor.js';

/** Live CPU / memory / disk / network / process metrics of the host running Perfmon. */
export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/host', { preHandler: requirePermission('VIEW_RUN'), schema: { tags: ['System'], summary: 'Live metrics of the host executing Perfmon' } }, async (req) => {
    const p = principalOf(req);
    // process names can reveal what else runs on the machine — admins only
    const canSeeProcesses = p.permissions.has('MANAGE_SETTINGS') || p.roles.includes('SUPER_ADMIN') || p.roles.includes('ADMIN');
    return hostMonitor.snapshot(canSeeProcesses);
  });
}
