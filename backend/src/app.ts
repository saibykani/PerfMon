import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { ApiError, errorBody } from './lib/errors.js';
import { resolvePrincipal } from './auth/principal.js';
import { selfMetrics } from './selfmon/registry.js';
import { audit } from './audit/audit.js';
import { authRoutes } from './auth/routes.js';
import { ingestRoutes } from './ingest/routes.js';
import { runRoutes } from './runs/routes.js';
import { artifactRoutes, reportContentRoutes } from './artifacts/routes.js';
import { optionalRoutes } from './routes-registry.js';

// Routes that do not require authentication
const PUBLIC = [/^\/api\/v1\/auth\/(login|forgot-password|reset-password|config)$/, /^\/api\/v1\/health/, /^\/api\/docs/, /^\/metrics$/, /^\/report-content\//];

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, transport: config.env === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined },
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    ajv: { customOptions: { coerceTypes: 'array' } },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: false, // API responses are JSON; the SPA sets its own CSP via nginx
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: false, exposedHeaders: ['content-disposition', 'x-checksum-sha256'] });
  await app.register(rateLimit, {
    global: true, max: config.apiRateLimitPerMin, timeWindow: '1 minute',
    keyGenerator: (req) => (req.headers.authorization ?? req.headers['x-api-key'] ?? req.ip) as string,
    allowList: (req) => req.url.startsWith('/report-content/') || req.url.includes('/ingest/') || /\/runs\/[^/]+\/metrics$/.test(req.url),
    errorResponseBuilder: (req, ctx) => ({ ...errorBody(429, 'RATE_LIMITED', `Rate limit exceeded, retry in ${Math.ceil(ctx.ttl / 1000)}s`, req.url), statusCode: 429 }),
  });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 } });
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 50 * 1024 * 1024 }, (_r, body, done) => done(null, body));

  await app.register(swagger, {
    openapi: {
      info: { title: 'Perfmon API', version: '1.0.0', description: 'Perfmon — Performance Engineering. Observability. Intelligence.\n\nAuthenticate with `Authorization: Bearer <JWT>` (from /auth/login) or an API key (`Authorization: Bearer pmk_...` or `X-API-Key`).\n\nErrors use `{ timestamp, status, error, message, path, details? }`.' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      security: [{ bearer: [] }, { apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  // Authentication: resolve principal for every request; enforce on non-public routes
  app.addHook('onRequest', async (req) => {
    (req as any).__t0 = performance.now();
    if (req.method === 'OPTIONS') return;
    req.principal = (await resolvePrincipal(req)) ?? undefined;
    const path = req.url.split('?')[0];
    if (!req.principal && !PUBLIC.some((re) => re.test(path))) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  });
  app.addHook('onResponse', async (req, reply) => {
    const t = performance.now() - ((req as any).__t0 ?? performance.now());
    selfMetrics.observe('api_latency_ms', t);
    selfMetrics.inc('api_requests');
    if (reply.statusCode >= 500) selfMetrics.inc('api_errors_5xx');
    else if (reply.statusCode >= 400) selfMetrics.inc('api_errors_4xx');
  });

  app.setErrorHandler(async (err: FastifyError | ApiError, req, reply) => {
    const path = req.url.split('?')[0];
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v: any) => ({ path: v.instancePath || v.params?.issue?.path?.join('.'), message: v.message }));
      return reply.code(400).send(errorBody(400, 'VALIDATION_ERROR', `Invalid request: ${details.map((d) => `${d.path ? d.path + ' ' : ''}${d.message}`).join('; ')}`, path, details));
    }
    if (err instanceof ApiError) {
      if (err.status === 403) await audit(req, { action: 'access.denied', resourceType: 'route', resourceId: `${req.method} ${path}`, result: 'DENIED', details: { message: err.message } });
      return reply.code(err.status).send(errorBody(err.status, err.code, err.message, path, err.details));
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 413 || (err as any).code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send(errorBody(413, 'PAYLOAD_TOO_LARGE', 'Request or file exceeds the size limit', path));
    if (status === 429) return reply.code(429).send(errorBody(429, 'RATE_LIMITED', err.message, path));
    if (status < 500) return reply.code(status).send(errorBody(status, (err as FastifyError).code ?? 'BAD_REQUEST', err.message, path));
    if ((err as any).code === '23505') return reply.code(409).send(errorBody(409, 'CONFLICT', 'A resource with the same unique key already exists', path, { constraint: (err as any).constraint }));
    if ((err as any).code === '22P02') return reply.code(400).send(errorBody(400, 'VALIDATION_ERROR', 'Invalid identifier format', path));
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody(500, 'INTERNAL_ERROR', 'An unexpected error occurred', path));
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody(404, 'NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`, req.url.split('?')[0])));

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => reply.type('text/plain; version=0.0.4').send(selfMetrics.prometheus()));
  app.get('/api/v1/health', { schema: { tags: ['System'], summary: 'Liveness/readiness', security: [] } }, async () => {
    const { one } = await import('./db/pool.js');
    await one('SELECT 1');
    return { status: 'UP', time: new Date().toISOString() };
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(ingestRoutes);
    await api.register(runRoutes);
    await api.register(artifactRoutes);
    for (const r of optionalRoutes) await api.register(r);
  }, { prefix: '/api/v1' });

  // When no separate report origin is configured, serve report content here (still CSP-sandboxed).
  if (!config.reportContentOrigin) await app.register(reportContentRoutes);
  return app;
}

/** Minimal app that ONLY serves sandboxed report content on its own origin/port. */
export async function buildReportContentApp() {
  const app = Fastify({ logger: false });
  await app.register(reportContentRoutes);
  app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Not found'));
  return app;
}
