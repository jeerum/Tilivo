exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('audit_events', {
    object_type: { type: 'text' },
    object_id: { type: 'uuid' },
    previous_hash: { type: 'text' },
    event_hash: { type: 'text' },
  });
  pgm.createIndex('audit_events', ['tenant_id', 'created_at']);
  pgm.createIndex('audit_events', ['object_type', 'object_id']);

  pgm.createTable('documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true, default: 'GENERAL' },
    status: { type: 'text', notNull: true, default: 'UPLOADED' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('documents', ['tenant_id', 'created_at']);

  pgm.createTable('document_versions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    document_id: { type: 'uuid', notNull: true, references: 'documents', onDelete: 'CASCADE' },
    version_number: { type: 'integer', notNull: true },
    storage_key: { type: 'text', notNull: true },
    original_filename: { type: 'text', notNull: true },
    mime_type: { type: 'text', notNull: true },
    size_bytes: { type: 'bigint', notNull: true },
    sha256: { type: 'text', notNull: true },
    uploaded_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    confirmed_at: { type: 'timestamptz' },
  });
  pgm.createIndex('document_versions', ['tenant_id', 'document_id', 'version_number'], { unique: true });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_prevent_confirmed_document_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.confirmed_at IS NOT NULL THEN
        RAISE EXCEPTION 'confirmed document version is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_document_version_immutable
    BEFORE UPDATE ON document_versions
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_prevent_confirmed_document_update()
  `);

  pgm.createTable('retention_policies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    object_type: { type: 'text', notNull: true },
    country: { type: 'text', notNull: true, default: 'FI' },
    retention_days: { type: 'integer', notNull: true },
    effective_from: { type: 'date', notNull: true },
    effective_to: { type: 'date' },
    rule_version: { type: 'text', notNull: true, default: '1' },
  });
  pgm.createIndex('retention_policies', ['object_type', 'country', 'effective_from']);

  pgm.createTable('retention_holds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    object_type: { type: 'text', notNull: true },
    object_id: { type: 'uuid', notNull: true },
    reason: { type: 'text', notNull: true, default: '' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    released_at: { type: 'timestamptz' },
  });
  pgm.createIndex('retention_holds', ['tenant_id', 'object_type', 'object_id']);

  pgm.createTable('integration_inbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', references: 'tenants', onDelete: 'CASCADE' },
    provider: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    external_event_id: { type: 'text', notNull: true },
    payload: { type: 'text', notNull: true, default: '{}' },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    status: { type: 'text', notNull: true, default: 'PENDING' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_error_code: { type: 'text' },
  });
  pgm.createIndex('integration_inbox', ['provider', 'external_event_id'], { unique: true });
  pgm.createIndex('integration_inbox', ['status', 'received_at']);

  pgm.createTable('integration_outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    event_type: { type: 'text', notNull: true },
    aggregate_type: { type: 'text', notNull: true },
    aggregate_id: { type: 'uuid', notNull: true },
    payload: { type: 'text', notNull: true, default: '{}' },
    status: { type: 'text', notNull: true, default: 'PENDING' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    available_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    last_error_code: { type: 'text' },
  });
  pgm.createIndex('integration_outbox', ['status', 'available_at']);
  pgm.createIndex('integration_outbox', 'tenant_id');

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_outbox_append(
      p_tenant uuid,
      p_event_type text,
      p_aggregate_type text,
      p_aggregate_id uuid,
      p_payload text
    ) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      INSERT INTO integration_outbox
        (tenant_id, event_type, aggregate_type, aggregate_id, payload)
      VALUES (p_tenant, p_event_type, p_aggregate_type, p_aggregate_id, p_payload)
      RETURNING id
    $$;
  `);
  pgm.sql('GRANT EXECUTE ON FUNCTION public.tilivo_outbox_append(uuid, text, text, uuid, text) TO tilivo_runtime, tilivo_worker');

  const newPermissions = [
    ['audit.read', 'Read audit log'],
    ['document.read', 'Read documents'],
    ['document.upload', 'Upload documents'],
    ['document.manage', 'Manage documents'],
  ];
  for (const [key, description] of newPermissions) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
    WHERE r.name IN ('Owner', 'Admin')
      AND p.key IN ('audit.read', 'document.read', 'document.upload', 'document.manage')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
    WHERE r.name IN ('Accountant')
      AND p.key IN ('audit.read', 'document.read', 'document.upload')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
    WHERE r.name IN ('Viewer', 'Employee')
      AND p.key IN ('document.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);

  for (const table of ['documents', 'document_versions', 'retention_holds']) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
  }
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON documents TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT ON document_versions TO tilivo_runtime');
  pgm.sql('GRANT UPDATE ON document_versions TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON retention_holds TO tilivo_runtime');

  pgm.sql('REVOKE UPDATE, DELETE ON audit_events FROM tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT ON audit_events TO tilivo_runtime');
  pgm.sql('GRANT SELECT, UPDATE, INSERT ON integration_outbox TO tilivo_worker');
  pgm.sql('GRANT SELECT, UPDATE, INSERT ON integration_inbox TO tilivo_worker');
};

exports.down = (pgm) => {
  pgm.dropTable('integration_outbox');
  pgm.dropTable('integration_inbox');
  pgm.dropTable('retention_holds');
  pgm.dropTable('retention_policies');
  pgm.dropTable('document_versions');
  pgm.dropTable('documents');
  pgm.dropColumns('audit_events', ['object_type', 'object_id', 'previous_hash', 'event_hash']);
};
