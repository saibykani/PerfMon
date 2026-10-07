import type { FastifyInstance } from 'fastify';
import { inventoryRoutes } from './inventory/routes.js';
import { runAnalysisRoutes } from './runs/analysisRoutes.js';
import { reportRoutes } from './reports/routes.js';
import { dashboardRoutes } from './dashboards/routes.js';
import { analyticsRoutes } from './analytics/routes.js';
import { searchRoutes } from './search/routes.js';
import { eventRoutes } from './events/routes.js';
import { alertRoutes } from './alerts/routes.js';
import { integrationRoutes } from './integrations/routes.js';
import { adminRoutes } from './admin/routes.js';
import { systemRoutes } from './system/routes.js';

/** Route modules registered under /api/v1 (in addition to auth, ingest, runs, artifacts). */
export const optionalRoutes: ((app: FastifyInstance) => Promise<void>)[] = [
  inventoryRoutes, runAnalysisRoutes, reportRoutes, dashboardRoutes, analyticsRoutes, searchRoutes, eventRoutes, alertRoutes, integrationRoutes, adminRoutes, systemRoutes,
];
