import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  BUILTIN_ROLES,
  generateTenantId,
  isValidTenantSlug,
  normalizeTenantSlug,
  type MembershipStatus,
  type TenantStatus,
} from '../lib/tenant';

export interface TenantCreateInput {
  name: string;
  slug?: string;
  companyLegalName: string;
  businessId?: string;
  countryCode: string;
  baseCurrency: string;
}

export interface TenantView {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  membership_status: MembershipStatus;
}

export interface MemberView {
  id: string;
  user_id: string;
  email: string;
  status: MembershipStatus;
  roles: string[];
  created_at: string;
}

export interface RoleView {
  id: string;
  name: string;
  is_system: boolean;
  permissions: string[];
}

export async function withTenantTransaction<T>(
  pool: Db,
  tenantId: string,
  callback: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveTenantAccess(
  pool: Db,
  userId: string,
  requestedTenantId: string,
): Promise<{ membershipId: string; tenantStatus: TenantStatus }> {
  const result = await pool.query('SELECT * FROM public.tilivo_resolve_membership($1, $2)', [
    userId,
    requestedTenantId,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError(ErrorCodes.tenantAccessDenied, 'Tenant access denied', 404);
  }
  const membershipStatus = String(row.membership_status) as MembershipStatus;
  const tenantStatus = String(row.tenant_status) as TenantStatus;
  if (tenantStatus === 'SUSPENDED' || tenantStatus === 'ARCHIVED') {
    throw new AppError(ErrorCodes.tenantSuspended, 'Tenant is not active', 403);
  }
  if (membershipStatus !== 'ACTIVE') {
    throw new AppError(ErrorCodes.tenantMembershipInactive, 'Membership is not active', 403);
  }
  return { membershipId: String(row.membership_id), tenantStatus };
}

export async function listMyTenants(pool: Db, userId: string): Promise<TenantView[]> {
  const result = await pool.query('SELECT * FROM public.tilivo_list_my_tenants($1)', [userId]);
  return result.rows.map((row) => ({
    id: String(row.tenant_id),
    name: String(row.name),
    slug: String(row.slug),
    status: String(row.tenant_status) as TenantStatus,
    membership_status: String(row.membership_status) as MembershipStatus,
  }));
}

export async function hasPermission(
  pool: Db,
  userId: string,
  tenantId: string,
  permission: string,
): Promise<boolean> {
  const result = await pool.query('SELECT public.tilivo_has_permission($1, $2, $3) AS allowed', [
    userId,
    tenantId,
    permission,
  ]);
  return Boolean(result.rows[0]?.allowed);
}

export async function requirePermission(
  pool: Db,
  userId: string,
  tenantId: string,
  permission: string,
): Promise<void> {
  if (!(await hasPermission(pool, userId, tenantId, permission))) {
    throw new AppError(ErrorCodes.memberPermissionDenied, 'Permission denied', 403);
  }
}

async function seedRoles(client: DbClient, tenantId: string, membershipId: string): Promise<string> {
  const permissionRows = await client.query('SELECT id, key FROM permissions');
  const permissionIds = new Map<string, string>();
  for (const row of permissionRows.rows) {
    permissionIds.set(String(row.key), String(row.id));
  }

  let ownerRoleId = '';
  for (const definition of BUILTIN_ROLES) {
    const roleResult = await client.query(
      `INSERT INTO roles (tenant_id, name, is_system)
       VALUES ($1, $2, true)
       RETURNING id`,
      [tenantId, definition.name],
    );
    const roleId = String(roleResult.rows[0]!.id);
    if (definition.name === 'Owner') ownerRoleId = roleId;
    for (const permission of definition.permissions) {
      const permissionId = permissionIds.get(permission);
      if (!permissionId) continue;
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [tenantId, roleId, permissionId],
      );
    }
  }

  await client.query(
    `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
     VALUES ($1, $2, $3)`,
    [tenantId, membershipId, ownerRoleId],
  );
  return ownerRoleId;
}

export async function createTenant(
  pool: Db,
  userId: string,
  input: TenantCreateInput,
): Promise<{ tenant: TenantView; companyId: string }> {
  const name = input.name.trim();
  if (!name || name.length < 2 || name.length > 160) {
    throw new AppError(ErrorCodes.tenantInvalid, 'Tenant name must be between 2 and 160 characters', 400);
  }
  const slug = normalizeTenantSlug(input.slug ?? name);
  if (!isValidTenantSlug(slug)) {
    throw new AppError(ErrorCodes.tenantInvalid, 'Tenant slug is invalid', 400);
  }
  const tenantId = generateTenantId();

  return withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, slug, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [tenantId, name, slug],
    );
    const companyResult = await client.query(
      `INSERT INTO companies (tenant_id, legal_name, business_id, country_code, base_currency, status)
       VALUES ($1, $2, NULLIF($3, ''), $4, $5, 'ACTIVE')
       RETURNING id`,
      [
        tenantId,
        input.companyLegalName.trim(),
        input.businessId ?? '',
        input.countryCode.toUpperCase().slice(0, 2),
        input.baseCurrency.toUpperCase().slice(0, 3),
      ],
    );
    const membershipResult = await client.query(
      `INSERT INTO memberships (tenant_id, user_id, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [tenantId, userId],
    );
    const membershipId = String(membershipResult.rows[0]!.id);
    await seedRoles(client, tenantId, membershipId);

    return {
      tenant: {
        id: tenantId,
        name,
        slug,
        status: 'ACTIVE',
        membership_status: 'ACTIVE',
      },
      companyId: String(companyResult.rows[0]!.id),
    };
  });
}

export async function getCurrentCompany(
  pool: Db,
  tenantId: string,
): Promise<Record<string, unknown>> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, legal_name, business_id, country_code, base_currency, status, created_at, updated_at
       FROM companies
       WHERE status = 'ACTIVE'
       ORDER BY created_at
       LIMIT 1`,
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.tenantInvalid, 'Company not found', 404);
    return result.rows[0];
  });
}

export async function updateCurrentCompany(
  pool: Db,
  tenantId: string,
  input: { legal_name?: string; business_id?: string; country_code?: string; base_currency?: string },
): Promise<Record<string, unknown>> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const current = await client.query(
      `SELECT id FROM companies WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
    );
    if (!current.rows[0]) throw new AppError(ErrorCodes.tenantInvalid, 'Company not found', 404);
    const result = await client.query(
      `UPDATE companies
       SET legal_name = COALESCE(NULLIF($2, ''), legal_name),
           business_id = $3,
           country_code = COALESCE(NULLIF($4, ''), country_code),
           base_currency = COALESCE(NULLIF($5, ''), base_currency),
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, legal_name, business_id, country_code, base_currency, status, updated_at`,
      [
        current.rows[0].id,
        input.legal_name ?? '',
        input.business_id ?? null,
        input.country_code ?? '',
        input.base_currency ?? '',
      ],
    );
    return result.rows[0]!;
  });
}

export async function listMembers(pool: Db, tenantId: string): Promise<MemberView[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT m.id, m.status, m.created_at,
              u.id AS user_id, u.email,
              COALESCE(json_agg(r.name ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.tenant_id = m.tenant_id
       LEFT JOIN roles r ON r.id = mr.role_id AND r.tenant_id = m.tenant_id
       GROUP BY m.id, u.id
       ORDER BY m.created_at`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      email: String(row.email),
      status: String(row.status) as MembershipStatus,
      roles: JSON.parse(String(row.roles)) as string[],
      created_at: String(row.created_at),
    }));
  });
}

async function lockTenant(client: DbClient, tenantId: string): Promise<void> {
  await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
}

async function countActiveOwners(client: DbClient, tenantId: string, targetUserId?: string): Promise<number> {
  const result = await client.query(
    `SELECT count(DISTINCT m.id)::int AS owners
     FROM memberships m
     JOIN membership_roles mr ON mr.membership_id = m.id AND mr.tenant_id = m.tenant_id
     JOIN roles r ON r.id = mr.role_id AND r.tenant_id = m.tenant_id
     WHERE m.tenant_id = $1
       AND m.status = 'ACTIVE'
       AND r.name = 'Owner'
       AND ($2::uuid IS NULL OR m.user_id <> $2)`,
    [tenantId, targetUserId ?? null],
  );
  return Number(result.rows[0]?.owners ?? 0);
}

export async function removeMember(pool: Db, tenantId: string, memberId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    await lockTenant(client, tenantId);
    const member = await client.query(
      `SELECT m.user_id,
              EXISTS (SELECT 1 FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                      WHERE mr.membership_id = m.id AND r.name = 'Owner') AS is_owner
       FROM memberships m WHERE m.id = $1`,
      [memberId],
    );
    if (!member.rows[0]) throw new AppError(ErrorCodes.memberNotFound, 'Member not found', 404);
    if (member.rows[0].is_owner) {
      const otherOwners = await countActiveOwners(client, tenantId, String(member.rows[0].user_id));
      if (otherOwners === 0) {
        throw new AppError(ErrorCodes.memberLastOwner, 'Cannot remove the last Owner', 409);
      }
    }
    await client.query(`UPDATE memberships SET status = 'REMOVED', updated_at = now() WHERE id = $1`, [
      memberId,
    ]);
  });
}

export async function setMemberStatus(
  pool: Db,
  tenantId: string,
  memberId: string,
  status: MembershipStatus,
): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    await lockTenant(client, tenantId);
    const member = await client.query(
      `SELECT m.user_id,
              EXISTS (SELECT 1 FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                      WHERE mr.membership_id = m.id AND r.name = 'Owner') AS is_owner
       FROM memberships m WHERE m.id = $1`,
      [memberId],
    );
    if (!member.rows[0]) throw new AppError(ErrorCodes.memberNotFound, 'Member not found', 404);
    if ((status === 'SUSPENDED' || status === 'REMOVED') && member.rows[0].is_owner) {
      const otherOwners = await countActiveOwners(client, tenantId, String(member.rows[0].user_id));
      if (otherOwners === 0) {
        throw new AppError(ErrorCodes.memberLastOwner, 'Cannot suspend or remove the last Owner', 409);
      }
    }
    await client.query(`UPDATE memberships SET status = $2, updated_at = now() WHERE id = $1`, [
      memberId,
      status,
    ]);
  });
}

export async function addMember(
  pool: Db,
  tenantId: string,
  input: { userId: string; roleName: string },
): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    await lockTenant(client, tenantId);
    const result = await client.query(
      `INSERT INTO memberships (tenant_id, user_id, status)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (tenant_id, user_id) DO NOTHING
       RETURNING id`,
      [tenantId, input.userId],
    );
    const membershipId = result.rows[0]?.id;
    if (!membershipId) return;
    const role = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`,
      [tenantId, input.roleName],
    );
    if (!role.rows[0]) throw new AppError(ErrorCodes.roleInvalid, 'Role not found', 404);
    await client.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       VALUES ($1, $2, $3)`,
      [tenantId, membershipId, role.rows[0].id],
    );
  });
}

export async function assignRole(pool: Db, tenantId: string, memberId: string, roleId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const role = await client.query(
      `SELECT id FROM roles WHERE id = $1 AND tenant_id = $2`,
      [roleId, tenantId],
    );
    if (!role.rows[0]) throw new AppError(ErrorCodes.roleInvalid, 'Role not found', 404);
    await client.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       VALUES ($2, $1, $3)
       ON CONFLICT (membership_id, role_id) DO NOTHING`,
      [memberId, tenantId, roleId],
    );
  });
}

export async function revokeRole(pool: Db, tenantId: string, memberId: string, roleId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    await lockTenant(client, tenantId);
    const role = await client.query(
      `SELECT id, name FROM roles WHERE id = $1 AND tenant_id = $2`,
      [roleId, tenantId],
    );
    if (!role.rows[0]) throw new AppError(ErrorCodes.roleInvalid, 'Role not found', 404);
    if (role.rows[0].name === 'Owner') {
      const member = await client.query(
        `SELECT m.user_id FROM memberships m WHERE m.id = $1 AND m.tenant_id = $2`,
        [memberId, tenantId],
      );
      if (!member.rows[0]) throw new AppError(ErrorCodes.memberNotFound, 'Member not found', 404);
      const otherOwners = await countActiveOwners(client, tenantId, String(member.rows[0].user_id));
      if (otherOwners === 0) {
        throw new AppError(ErrorCodes.memberLastOwner, 'Cannot revoke the last Owner role', 409);
      }
    }
    await client.query(
      `DELETE FROM membership_roles WHERE membership_id = $1 AND role_id = $2 AND tenant_id = $3`,
      [memberId, roleId, tenantId],
    );
  });
}

export async function listRoles(pool: Db, tenantId: string): Promise<RoleView[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT r.id, r.name, r.is_system,
              COALESCE(json_agg(p.key ORDER BY p.key) FILTER (WHERE p.id IS NOT NULL), '[]') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.id
       ORDER BY r.created_at`,
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      is_system: Boolean(row.is_system),
      permissions: JSON.parse(String(row.permissions)) as string[],
    }));
  });
}
