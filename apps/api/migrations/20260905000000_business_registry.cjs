exports.shorthands = undefined;

exports.up = (pgm) => {
  // Provenance of registry-imported parties. Existing manually entered rows
  // keep NULLs; the snapshot stores the normalized registry company (see
  // services/businessRegistryTypes.ts), not the large raw provider payload.
  pgm.addColumns('business_parties', {
    registry_source: { type: 'text' },
    registry_source_id: { type: 'text' },
    registry_fetched_at: { type: 'timestamptz' },
    registry_snapshot: { type: 'jsonb' },
  });
  pgm.createIndex('business_parties', ['tenant_id', 'registry_source_id']);

  // Provider cache. Registry data is public, so the table is intentionally
  // not tenant-scoped and needs no RLS policy.
  pgm.createTable('business_registry_cache', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    provider: { type: 'text', notNull: true },
    lookup_type: { type: 'text', notNull: true },
    lookup_key: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    fetched_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex(
    'business_registry_cache',
    ['provider', 'lookup_type', 'lookup_key'],
    { unique: true, name: 'business_registry_cache_provider_key_unique' },
  );
  pgm.createIndex('business_registry_cache', ['fetched_at']);
  pgm.sql(`
    ALTER TABLE business_registry_cache
    ADD CONSTRAINT business_registry_cache_lookup_type_check
    CHECK (lookup_type IN ('BUSINESS_ID', 'NAME'))
  `);
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON business_registry_cache TO tilivo_runtime');

  // New read permission for registry lookups (Owner/Admin/Accountant plus
  // read-only roles; registry data is public but rate limited).
  pgm.sql(`
    INSERT INTO permissions (key, description)
    VALUES ('registry.read', 'Search the business registry')
    ON CONFLICT (key) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner', 'Admin', 'Accountant', 'Employee', 'Viewer')
      AND p.key = 'registry.read'
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key = 'registry.read'
  `);
  pgm.sql(`DELETE FROM permissions WHERE key = 'registry.read'`);
  pgm.dropTable('business_registry_cache');
  pgm.sql('ALTER TABLE business_parties DROP COLUMN IF EXISTS registry_snapshot');
  pgm.sql('ALTER TABLE business_parties DROP COLUMN IF EXISTS registry_fetched_at');
  pgm.sql('ALTER TABLE business_parties DROP COLUMN IF EXISTS registry_source_id');
  pgm.sql('ALTER TABLE business_parties DROP COLUMN IF EXISTS registry_source');
};
