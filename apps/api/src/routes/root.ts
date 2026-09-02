import type { FastifyInstance } from 'fastify';

interface RootRouteOptions {
  version: string;
}

export async function rootRoutes(app: FastifyInstance, options: RootRouteOptions): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        description: 'Minimal service information.',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              version: { type: 'string' },
              api: { const: '/api/v1' },
            },
            required: ['service', 'version', 'api'],
          },
        },
      },
    },
    async () => ({
      service: 'mrjkp-accounting-api',
      version: options.version,
      api: '/api/v1',
    }),
  );

  app.get(
    '/api/v1',
    {
      schema: {
        description: 'API v1 base resource.',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: {
              api: { const: 'v1' },
              version: { type: 'string' },
              health: { const: '/api/v1/health' },
            },
            required: ['api', 'version', 'health'],
          },
        },
      },
    },
    async () => ({
      api: 'v1',
      version: options.version,
      health: '/api/v1/health',
    }),
  );
}

