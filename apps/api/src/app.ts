import crypto from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { AppConfig } from './config/env';
import type { Queryable } from './db/pool';
import { AppError, ErrorCodes, toErrorBody } from './lib/errors';
import { healthRoutes } from './routes/health';
import { rootRoutes } from './routes/root';

export interface BuildAppOptions {
  config: AppConfig;
  db: Queryable;
}

function makeLoggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  return {
    level: config.LOG_LEVEL,
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

export async function buildApp({ config, db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: makeLoggerOptions(config),
    requestIdHeader: 'x-trace-id',
    logController: new LogController({ requestIdLogLabel: 'trace_id' }),
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });

  if (config.EXPOSE_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'MRJKP Accounting API',
          description: 'Modular monolith accounting SaaS backend. v0.1 infrastructure.',
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

  await app.register(rootRoutes, { version: config.API_VERSION });
  await app.register(healthRoutes, {
    db,
    version: config.API_VERSION,
    environment: config.NODE_ENV,
  });

  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ action: 'route_not_found', path: request.url }, 'route not found');
    reply.code(404);
    return toErrorBody(ErrorCodes.notFound, 'Route not found', request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    if (error instanceof AppError) {
      request.log.warn(
        { error_id: error.code, action: 'app_error', details: error.details },
        error.message,
      );
      reply.code(error.statusCode);
      return toErrorBody(error.code, error.message, request.id);
    }

    request.log.error(
      { err: normalizedError, error_id: ErrorCodes.internal, action: 'unhandled_error' },
      'unhandled error',
    );

    const isPublicMessage = config.NODE_ENV === 'development' || config.NODE_ENV === 'test';
    reply.code(500);
    return toErrorBody(
      ErrorCodes.internal,
      isPublicMessage
        ? normalizedError.message
        : 'An unexpected error occurred. Please retry or contact support.',
      request.id,
    );
  });

  return app;
}
