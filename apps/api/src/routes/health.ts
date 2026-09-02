import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db/pool';
import { ErrorCodes, toErrorBody } from '../lib/errors';

interface HealthRouteOptions {
  db: Queryable;
  version: string;
  environment: string;
}

export async function healthRoutes(app: FastifyInstance, options: HealthRouteOptions): Promise<void> {
  app.get(
    '/api/v1/health',
    {
      schema: {
        description: 'Liveness and readiness probe. Verifies the database connection.',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              checks: {
                type: 'object',
                properties: {
                  database: { type: 'string' },
                },
                additionalProperties: false,
              },
              version: { type: 'string' },
              environment: { type: 'string' },
              time: { type: 'string', format: 'date-time' },
              trace_id: { type: 'string' },
            },
            required: ['status', 'checks', 'version', 'environment', 'time', 'trace_id'],
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              checks: {
                type: 'object',
                properties: {
                  database: { type: 'string' },
                },
                additionalProperties: false,
              },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  trace_id: { type: 'string' },
                },
                required: ['code', 'message', 'trace_id'],
              },
            },
            required: ['status', 'checks', 'error'],
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await options.db.query('SELECT 1');
        return {
          status: 'ok',
          checks: { database: 'up' },
          version: options.version,
          environment: options.environment,
          time: new Date().toISOString(),
          trace_id: request.id,
        };
      } catch (error) {
        request.log.error(
          { err: error, error_id: ErrorCodes.databaseUnreachable, action: 'database_healthcheck' },
          'database health check failed',
        );
        reply.code(503);
        return reply.send({
          status: 'degraded',
          checks: { database: 'down' },
          error: toErrorBody(ErrorCodes.databaseUnreachable, 'Database is unreachable', request.id).error,
        });
      }
    },
  );
}
