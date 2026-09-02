import { randomUUID } from 'node:crypto';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type MembershipStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REMOVED';

export const TENANT_PERMISSIONS = [
  'tenant.read',
  'tenant.manage',
  'company.read',
  'company.update',
  'member.read',
  'member.invite',
  'member.manage',
  'member.remove',
  'role.read',
  'role.manage',
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number];

export interface BuiltinRoleDefinition {
  name: string;
  permissions: TenantPermission[];
}

export const BUILTIN_ROLES: BuiltinRoleDefinition[] = [
  {
    name: 'Owner',
    permissions: [...TENANT_PERMISSIONS],
  },
  {
    name: 'Admin',
    permissions: [
      'tenant.read',
      'company.read',
      'company.update',
      'member.read',
      'member.invite',
      'member.manage',
      'member.remove',
      'role.read',
      'role.manage',
    ],
  },
  {
    name: 'Accountant',
    permissions: ['tenant.read', 'company.read', 'member.read', 'role.read'],
  },
  {
    name: 'Employee',
    permissions: ['tenant.read', 'company.read'],
  },
  {
    name: 'Viewer',
    permissions: ['tenant.read', 'company.read'],
  },
];

export function generateTenantId(): string {
  return randomUUID();
}

export function isValidTenantSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,62}$/.test(slug);
}

export function normalizeTenantSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
