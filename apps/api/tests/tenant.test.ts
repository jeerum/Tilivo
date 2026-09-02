import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  TENANT_PERMISSIONS,
  isValidTenantSlug,
  normalizeTenantSlug,
} from '../src/lib/tenant';

describe('tenant domain rules', () => {
  it('normalizes and validates slugs', () => {
    expect(normalizeTenantSlug('  My Company Oy! ')).toBe('my-company-oy');
    expect(isValidTenantSlug('my-company-oy')).toBe(true);
    expect(isValidTenantSlug('a')).toBe(false);
    expect(isValidTenantSlug('has_underscore')).toBe(false);
  });

  it('contains built-in roles and global permission keys', () => {
    const roleNames = BUILTIN_ROLES.map((role) => role.name);
    expect(roleNames).toEqual(['Owner', 'Admin', 'Accountant', 'Employee', 'Viewer']);
    expect(new Set(TENANT_PERMISSIONS).size).toBe(TENANT_PERMISSIONS.length);
    const owner = BUILTIN_ROLES.find((role) => role.name === 'Owner')!;
    expect(owner.permissions).toEqual(TENANT_PERMISSIONS);
  });
});
