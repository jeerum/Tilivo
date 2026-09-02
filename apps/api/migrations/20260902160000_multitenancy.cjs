exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('tenants', 'slug', { unique: true });

  pgm.createTable('companies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    legal_name: { type: 'text', notNull: true },
    business_id: { type: 'text' },
    country_code: { type: 'text', notNull: true, default: 'FI' },
    base_currency: { type: 'text', notNull: true, default: 'EUR' },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('companies', ['tenant_id', 'id']);

  pgm.createTable('permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    key: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
  });
  pgm.createIndex('permissions', 'key', { unique: true });

  pgm.createTable('roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    is_system: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('roles', ['tenant_id', 'name'], { unique: true });

  pgm.createTable('role_permissions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    role_id: { type: 'uuid', notNull: true, references: 'roles', onDelete: 'CASCADE' },
    permission_id: { type: 'uuid', notNull: true, references: 'permissions', onDelete: 'CASCADE' },
  });
  pgm.createIndex('role_permissions', ['tenant_id', 'role_id']);
  pgm.createIndex('role_permissions', ['role_id', 'permission_id'], { unique: true });

  pgm.createTable('memberships', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true, default: 'ACTIVE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('memberships', ['tenant_id', 'user_id'], { unique: true });
  pgm.createIndex('memberships', ['tenant_id', 'status']);

  pgm.createTable('membership_roles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    membership_id: { type: 'uuid', notNull: true, references: 'memberships', onDelete: 'CASCADE' },
    role_id: { type: 'uuid', notNull: true, references: 'roles', onDelete: 'CASCADE' },
  });
  pgm.createIndex('membership_roles', ['tenant_id', 'membership_id']);
  pgm.createIndex('membership_roles', ['membership_id', 'role_id'], { unique: true });

  pgm.addColumns('audit_events', {
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'SET NULL' },
  });
  pgm.createIndex('audit_events', 'tenant_id');

  const permissions = [
    ['tenant.read', 'View tenant information'],
    ['tenant.manage', 'Manage tenant'],
    ['company.read', 'Read company'],
    ['company.update', 'Update company'],
    ['member.read', 'Read members'],
    ['member.invite', 'Invite members'],
    ['member.manage', 'Manage members'],
    ['member.remove', 'Remove members'],
    ['role.read', 'Read roles'],
    ['role.manage', 'Manage roles'],
  ];
  for (const [key, description] of permissions) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN current_setting('app.tenant_id', true) ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN current_setting('app.tenant_id', true)::uuid
        ELSE NULL
      END
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_resolve_membership(p_user uuid, p_tenant uuid)
    RETURNS TABLE(membership_id uuid, membership_status text, tenant_status text)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT m.id, m.status, t.status
      FROM memberships m
      JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = p_user AND m.tenant_id = p_tenant
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_list_my_tenants(p_user uuid)
    RETURNS TABLE(tenant_id uuid, name text, slug text, tenant_status text, membership_status text)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT t.id, t.name, t.slug, t.status, m.status
      FROM memberships m
      JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = p_user
      ORDER BY t.created_at
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_has_permission(
      p_user uuid,
      p_tenant uuid,
      p_permission text
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (
        SELECT 1
        FROM memberships m
        JOIN membership_roles mr ON mr.membership_id = m.id AND mr.tenant_id = m.tenant_id
        JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.tenant_id = m.tenant_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE m.user_id = p_user
          AND m.tenant_id = p_tenant
          AND m.status = 'ACTIVE'
          AND p.key = p_permission
      )
    $$;
  `);

  pgm.sql('GRANT EXECUTE ON FUNCTION public.tilivo_resolve_membership(uuid, uuid) TO tilivo_runtime');
  pgm.sql('GRANT EXECUTE ON FUNCTION public.tilivo_list_my_tenants(uuid) TO tilivo_runtime');
  pgm.sql('GRANT EXECUTE ON FUNCTION public.tilivo_has_permission(uuid, uuid, text) TO tilivo_runtime');

  const tenantTables = ['companies', 'roles', 'role_permissions', 'memberships', 'membership_roles'];
  pgm.sql('ALTER TABLE tenants ENABLE ROW LEVEL SECURITY');
  pgm.sql('ALTER TABLE tenants FORCE ROW LEVEL SECURITY');
  for (const table of tenantTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`
      CREATE POLICY tenant_select ON ${table}
      FOR SELECT USING (tenant_id = public.tilivo_tenant_id())
    `);
    pgm.sql(`
      CREATE POLICY tenant_insert ON ${table}
      FOR INSERT WITH CHECK (tenant_id = public.tilivo_tenant_id())
    `);
    pgm.sql(`
      CREATE POLICY tenant_update ON ${table}
      FOR UPDATE USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())
    `);
    pgm.sql(`
      CREATE POLICY tenant_delete ON ${table}
      FOR DELETE USING (tenant_id = public.tilivo_tenant_id())
    `);
    pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO tilivo_runtime`);
  }

  pgm.sql(`
    CREATE POLICY tenant_self_select ON tenants
    FOR SELECT USING (id = public.tilivo_tenant_id())
  `);
  pgm.sql(`
    CREATE POLICY tenant_self_insert ON tenants
    FOR INSERT WITH CHECK (id = public.tilivo_tenant_id())
  `);
  pgm.sql(`
    CREATE POLICY tenant_self_update ON tenants
    FOR UPDATE USING (id = public.tilivo_tenant_id())
    WITH CHECK (id = public.tilivo_tenant_id())
  `);
  pgm.sql('GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO tilivo_runtime');

  pgm.sql('GRANT SELECT, INSERT ON audit_events TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE, DELETE ON dev_email_outbox TO tilivo_runtime');
};

exports.down = (pgm) => {
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_has_permission(uuid, uuid, text)');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_list_my_tenants(uuid)');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_resolve_membership(uuid, uuid)');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_tenant_id()');
  pgm.dropTable('membership_roles');
  pgm.dropTable('memberships');
  pgm.dropTable('role_permissions');
  pgm.dropTable('roles');
  pgm.dropTable('permissions');
  pgm.dropTable('companies');
  pgm.dropTable('tenants');
  pgm.dropColumns('audit_events', ['tenant_id']);
};
