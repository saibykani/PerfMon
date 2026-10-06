import type { FastifyInstance } from 'fastify';
import { inventoryRoutes } from './inventory/routes.js';
import { runAnalysisRoutes } from './runs/analysisRoutes.js';

/**
 * Additional route modules (inventory, analytics, dashboards, alerts, reports,
 * integrations, admin...). Each module registers under /api/v1.
 */
export const optionalRoutes: ((app: FastifyInstance) => Promise<void>)[] = [inventoryRoutes, runAnalysisRoutes];
