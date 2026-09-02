import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { BUILTIN_ROLES, type MembershipStatus } from '../lib/tenant';
import { findUserByEmail } from '../services/identityService';
import { writeAuditEvent } from '../services/audit';
import { resolveSessionUser } from '../services/sessionContext';
import { listTenantAudit } from '../services/auditQuery';
import {
  addMember,
  assignRole,
  createTenant,
  getCurrentCompany,
  listMembers,
  listMyTenants,
  listRoles,
  removeMember,
  requirePermission,
  resolveTenantAccess,
  revokeRole,
  setMemberStatus,
  updateCurrentCompany,
} from '../services/tenantService';

interface TenantRouteOptions {
  db: Db;
  config: AppConfig;
}

const TENANT_HEADER = 'x-tilivo-tenant-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantIdFromRequest(request: FastifyRequest): string {
  const value = request.headers[TENANT_HEADER];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(ErrorCodes.tenantInvalid, 'Valid tenant id is required', 400);
  }
  return value.toLowerCase();
}

async function authenticate(request: FastifyRequest, db: Db, config: AppConfig): Promise<string> {
  const { user } = await resolveSessionUser(db, request, config);
  return user.id;
}

async function enterTenant(
  request: FastifyRequest,
  db: Db,
  config: AppConfig,
): Promise<string> {
  const userId = await authenticate(request, db, config);
  const tenantId = tenantIdFromRequest(request);
  await resolveTenantAccess(db, userId, tenantId);
  (request as unknown as { tenant?: string }).tenant = tenantId;
  return tenantId;
}

export async function tenantRoutes(app: FastifyInstance, options: TenantRouteOptions): Promise<void> {
  const { db, config } = options;

  app.post<{ Body: Record<string, unknown> }>(
    '/api/v1/tenants',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const userId = await authenticate(request, db, config);
      const body = request.body ?? {};
      const company = (body.company ?? {}) as Record<string, unknown>;
      const result = await createTenant(db, userId, {
        name: String(body.name ?? ''),
        slug: body.slug === undefined ? undefined : String(body.slug),
        companyLegalName: String(company.legal_name ?? body.name ?? ''),
        businessId: company.business_id === undefined ? undefined : String(company.business_id),
        countryCode: String(company.country_code ?? 'FI'),
        baseCurrency: String(company.base_currency ?? 'EUR'),
      });
      await writeAuditEvent(db, 'TENANT.CREATED', request, {
        userId,
        tenantId: result.tenant.id,
        metadata: { tenant_name: result.tenant.name },
      });
      await writeAuditEvent(db, 'COMPANY.CREATED', request, {
        userId,
        tenantId: result.tenant.id,
        metadata: { company_id: result.companyId },
      });
      await writeAuditEvent(db, 'MEMBERSHIP.CREATED', request, {
        userId,
        tenantId: result.tenant.id,
      });
      return reply.code(201).send({
        tenant: result.tenant,
        company_id: result.companyId,
      });
    },
  );

  app.get('/api/v1/tenants', async (request) => {
    const userId = await authenticate(request, db, config);
    const tenants = await listMyTenants(db, userId);
    return { tenants };
  });

  app.get('/api/v1/companies/current', async (request) => {
    const tenantId = await enterTenant(request, db, config);
    const userId = await authenticate(request, db, config);
    await requirePermission(db, userId, tenantId, 'company.read');
    const company = await getCurrentCompany(db, tenantId);
    return { company };
  });

  app.patch<{ Body: Record<string, unknown> }>(
    '/api/v1/companies/current',
    async (request, reply) => {
      const tenantId = await enterTenant(request, db, config);
      const userId = await authenticate(request, db, config);
      await requirePermission(db, userId, tenantId, 'company.update');
      const body = request.body ?? {};
      const company = await updateCurrentCompany(db, tenantId, {
        legal_name: body.legal_name === undefined ? undefined : String(body.legal_name),
        business_id: body.business_id === undefined ? undefined : String(body.business_id),
        country_code: body.country_code === undefined ? undefined : String(body.country_code),
        base_currency: body.base_currency === undefined ? undefined : String(body.base_currency),
      });
      await writeAuditEvent(db, 'COMPANY.UPDATED', request, {
        userId,
        tenantId,
        metadata: { company_id: company.id },
      });
      return reply.send({ company });
    },
  );

  app.get('/api/v1/members', async (request) => {
    const tenantId = await enterTenant(request, db, config);
    const userId = await authenticate(request, db, config);
    await requirePermission(db, userId, tenantId, 'member.read');
    const members = await listMembers(db, tenantId);
    return { members };
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/api/v1/members',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const tenantId = await enterTenant(request, db, config);
      const userId = await authenticate(request, db, config);
      await requirePermission(db, userId, tenantId, 'member.invite');
      const body = request.body ?? {};
      const email = String(body.email ?? '').trim().toLowerCase();
      const roleName = BUILTIN_ROLES.some((role) => role.name === body.role_name)
        ? String(body.role_name)
        : 'Employee';
      const user = await findUserByEmail(db, email);
      if (!user) {
        return reply.code(202).send({ message: 'If the account exists, an invitation was recorded.' });
      }
      await addMember(db, tenantId, { userId: user.id, roleName });
      await writeAuditEvent(db, 'MEMBERSHIP.INVITED', request, {
        userId,
        tenantId,
        metadata: { invited_user_id: user.id, role_name: roleName },
      });
      await writeAuditEvent(db, 'ROLE.ASSIGNED', request, {
        userId,
        tenantId,
        metadata: { target_user_id: user.id, role_name: roleName },
      });
      return reply.code(201).send({ message: 'Member added' });
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: string } }>(
    '/api/v1/members/:id',
    async (request, reply) => {
      const tenantId = await enterTenant(request, db, config);
      const userId = await authenticate(request, db, config);
      await requirePermission(db, userId, tenantId, 'member.manage');
      const status = String(request.body?.status ?? '') as MembershipStatus;
      if (!['ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED'].includes(status)) {
        throw new AppError(ErrorCodes.tenantInvalid, 'Invalid membership status', 400);
      }
      await setMemberStatus(db, tenantId, request.params.id, status);
      const auditAction =
        status === 'SUSPENDED'
          ? 'MEMBERSHIP.SUSPENDED'
          : status === 'REMOVED'
            ? 'MEMBERSHIP.REMOVED'
            : status === 'INVITED'
              ? 'MEMBERSHIP.INVITED'
              : 'MEMBERSHIP.ACTIVATED';
      await writeAuditEvent(db, auditAction, request, {
        userId,
        tenantId,
        metadata: { membership_id: request.params.id },
      });
      return reply.send({ message: 'Member updated' });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/members/:id',
    async (request, reply) => {
      const tenantId = await enterTenant(request, db, config);
      const userId = await authenticate(request, db, config);
      await requirePermission(db, userId, tenantId, 'member.remove');
      await removeMember(db, tenantId, request.params.id);
      await writeAuditEvent(db, 'MEMBERSHIP.REMOVED', request, {
        userId,
        tenantId,
        metadata: { membership_id: request.params.id },
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { role_id?: string } }>(
    '/api/v1/members/:id/roles',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const tenantId = await enterTenant(request, db, config);
      const userId = await authenticate(request, db, config);
      await requirePermission(db, userId, tenantId, 'role.manage');
      const roleId = String(request.body?.role_id ?? '');
      if (!UUID_PATTERN.test(roleId)) throw new AppError(ErrorCodes.roleInvalid, 'Invalid role id', 400);
      await assignRole(db, tenantId, request.params.id, roleId);
      await writeAuditEvent(db, 'ROLE.ASSIGNED', request, {
        userId,
        tenantId,
        metadata: { membership_id: request.params.id, role_id: roleId },
      });
      return reply.send({ message: 'Role assigned' });
    },
  );

  app.delete<{ Params: { id: string; roleId: string } }>(
    '/api/v1/members/:id/roles/:roleId',
    async (request, reply) => {
      const tenantId = await enterTenant(request, db, config);
      const userId = await authenticate(request, db, config);
      await requirePermission(db, userId, tenantId, 'role.manage');
      await revokeRole(db, tenantId, request.params.id, request.params.roleId);
      await writeAuditEvent(db, 'ROLE.REVOKED', request, {
        userId,
        tenantId,
        metadata: { membership_id: request.params.id, role_id: request.params.roleId },
      });
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/roles', async (request) => {
    const tenantId = await enterTenant(request, db, config);
    const userId = await authenticate(request, db, config);
    await requirePermission(db, userId, tenantId, 'role.read');
    const roles = await listRoles(db, tenantId);
    return { roles };
  });

  app.get('/api/v1/audit', async (request) => {
    const tenantId = await enterTenant(request, db, config);
    const userId = await authenticate(request, db, config);
    await requirePermission(db, userId, tenantId, 'audit.read');
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(query.offset ?? 0), 0);
    const result = await listTenantAudit(db, tenantId, { limit, offset });
    return { audit: result.events, total: result.total, limit, offset };
  });
}
