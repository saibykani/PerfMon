import type { FastifyInstance } from 'fastify';

/**
 * Additional route modules (inventory, analytics, dashboards, alerts, reports,
 * integrations, admin...). Each module registers under /api/v1.
 */
export const optionalRoutes: ((app: FastifyInstance) => Promise<void>)[] = [];
