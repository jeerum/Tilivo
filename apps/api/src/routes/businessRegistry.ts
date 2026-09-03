import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { normalizeFinnishBusinessId } from '../lib/businessId';
import type { BusinessRegistryProvider } from '../services/businessRegistryProvider';
import { BusinessRegistryService } from '../services/businessRegistryService';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess } from '../services/tenantService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BusinessRegistryRouteOptions {
  db: Db;
  config: AppConfig;
  provider: BusinessRegistryProvider;
}

async function context(request: FastifyRequest, db: Db, config: AppConfig) {
  const { user } = await resolveSessionUser(db, request, config);
  const value = request.headers['x-tilivo-tenant-id'];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppError(ErrorCodes.tenantInvalid, 'Valid tenant id required', 400);
  }
  const tenantId = value.toLowerCase();
  await resolveTenantAccess(db, user.id, tenantId);
  return { userId: user.id, tenantId };
}

export async function businessRegistryRoutes(
  app: FastifyInstance,
  options: BusinessRegistryRouteOptions,
): Promise<void> {
  const { db, config, provider } = options;
  const service = new BusinessRegistryService(db, provider, config);

  app.get<{ Querystring: Record<string, unknown> }>('/api/v1/business-registry/search', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'registry.read');
    const query = request.query;
    const q = typeof query.q === 'string' ? query.q : '';
    const rawLimit = Number(query.limit ?? 20);
    const limit = Number.isInteger(rawLimit) ? rawLimit : 20;
    return service.search({ query: q, limit }, { userId, tenantId });
  });

  app.get<{ Params: { businessId: string } }>(
    '/api/v1/business-registry/companies/:businessId',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'registry.read');
      const canonical = normalizeFinnishBusinessId(request.params.businessId);
      if (!canonical) {
        throw new AppError(ErrorCodes.registryInvalidBusinessId, 'Invalid Business ID', 400);
      }
      const company = await service.getByBusinessId(canonical, { userId, tenantId });
      if (!company) {
        throw new AppError(ErrorCodes.registryNotFound, 'Company not found', 404);
      }
      return { company };
    },
  );
}
