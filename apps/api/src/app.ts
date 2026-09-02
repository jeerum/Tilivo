import crypto from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AppConfig } from './config/env';
import type { Db } from './db/pool';
import { AppError, ErrorCodes, toErrorBody } from './lib/errors';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { rootRoutes } from './routes/root';
import { tenantRoutes } from './routes/tenant';
import { documentRoutes } from './routes/documents';
import { accountingRoutes } from './routes/accounting';
import { createEmailProvider } from './services/emailProvider';
import { findSessionByToken } from './services/sessionService';
import { hashToken } from './lib/security';
import { LocalObjectStorageProvider } from './services/documentStorage';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  loggerStream?: Writable;
}

function makeLoggerOptions(config: AppConfig, loggerStream?: Writable): FastifyServerOptions['logger'] {
  return {
    level: config.LOG_LEVEL,
    ...(loggerStream ? { stream: loggerStream } : {}),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.token',
        'err.config.headers.authorization',
      ],
      censor: '[redacted]',
    },
  };
}

export async function buildApp({ config, db, loggerStream }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: makeLoggerOptions(config, loggerStream),
    requestIdHeader: 'x-trace-id',
    logController: new LogController({ requestIdLogLabel: 'trace_id' }),
    genReqId: () => crypto.randomUUID(),
    trustProxy: config.TRUST_PROXY_CIDRS.split(','),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  const noCsrfPaths = new Set([
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/password/forgot',
    '/api/v1/auth/password/reset',
    '/api/v1/auth/email/verify',
  ]);
  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return;
    if (noCsrfPaths.has(request.url.split('?')[0] ?? '')) return;
    const rawSession = request.cookies?.[config.SESSION_COOKIE_NAME];
    if (!rawSession) return;
    const session = await findSessionByToken(db, rawSession);
    if (!session) return;
    const headerCsrf = request.headers['x-csrf-token'];
    const cookieCsrf = request.cookies?.[config.CSRF_COOKIE_NAME] ?? '';
    if (
      typeof headerCsrf !== 'string' ||
      !cookieCsrf ||
      hashToken(headerCsrf) !== session.csrfTokenHash
    ) {
      throw new AppError(ErrorCodes.authCsrfInvalid, 'CSRF validation failed', 403);
    }
  });

  if (config.EXPOSE_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Tilivo API',
          description: 'Tilivo modular monolith backend. v0.2 Identity.',
          version: config.API_VERSION,
        },
        servers: [{ url: '/' }],
      },
    });
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: false,
      },
    });
  }

  // Always return the trace id in the response and log the request id under
  // "trace_id" (configured above).
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-trace-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ action: 'route_not_found', path: request.url }, 'route not found');
    reply.code(404);
    return toErrorBody(ErrorCodes.notFound, 'Route not found', request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode =
      typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
    const isPublicMessage = config.NODE_ENV === 'development' || config.NODE_ENV === 'test';

    if (error instanceof AppError) {
      request.log.warn(
        { error_id: error.code, action: 'app_error', details: error.details },
        error.message,
      );
      reply.code(error.statusCode);
      return toErrorBody(error.code, error.message, request.id);
    }

    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(
        { err: normalizedError, error_id: ErrorCodes.invalidRequest, action: 'client_error' },
        'client request failed',
      );
      reply.code(statusCode);
      return toErrorBody(
        ErrorCodes.invalidRequest,
        isPublicMessage ? normalizedError.message : 'Request could not be processed',
        request.id,
      );
    }

    request.log.error(
      { err: normalizedError, error_id: ErrorCodes.internal, action: 'unhandled_error' },
      'unhandled error',
    );

    reply.code(500);
    return toErrorBody(
      ErrorCodes.internal,
      isPublicMessage
        ? normalizedError.message
        : 'An unexpected error occurred. Please retry or contact support.',
      request.id,
    );
  });

  await app.register(rootRoutes, { version: config.API_VERSION });
  await app.register(healthRoutes, {
    db,
    version: config.API_VERSION,
    environment: config.NODE_ENV,
    exposeDetails: config.NODE_ENV !== 'production',
  });

  const emailProvider = createEmailProvider(config.EMAIL_DRIVER, config.EMAIL_DEV_OUTBOX, db);
  await app.register(authRoutes, {
    db,
    emailProvider,
    config,
  });
  await app.register(tenantRoutes, {
    db,
    config,
  });
  const storage = new LocalObjectStorageProvider(config.DOCUMENT_STORAGE_DIR);
  await app.register(documentRoutes, {
    db,
    config,
    storage,
  });
  await app.register(accountingRoutes, { db, config });
  return app;
}
