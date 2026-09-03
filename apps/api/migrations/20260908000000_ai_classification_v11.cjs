exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('purchase_invoices', {
    category: { type: 'text' },
  });
  pgm.createTable('expense_classification_runs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_document_id: { type: 'uuid', notNull: true },
    provider: { type: 'text', notNull: true },
    model: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'PROCESSING' },
    input_fingerprint: { type: 'text' },
    request_metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    suggestions: { type: 'jsonb' },
    accepted_fields: { type: 'jsonb' },
    final_outcome: { type: 'jsonb' },
    latency_ms: { type: 'integer' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  });
  pgm.sql(`
    ALTER TABLE expense_classification_runs
      ADD CONSTRAINT expense_classification_document_fk
      FOREIGN KEY (tenant_id, purchase_document_id)
      REFERENCES purchase_invoices(tenant_id, id) ON DELETE CASCADE
  `);
  pgm.createIndex('expense_classification_runs', ['tenant_id', 'purchase_document_id', 'created_at']);
  pgm.sql(`
    CREATE UNIQUE INDEX expense_classification_fingerprint_unique
    ON expense_classification_runs (tenant_id, purchase_document_id, input_fingerprint)
    WHERE status IN ('READY','ACCEPTED','PARTIALLY_ACCEPTED','REJECTED')
  `);
  pgm.sql('ALTER TABLE expense_classification_runs ENABLE ROW LEVEL SECURITY');
  pgm.sql('ALTER TABLE expense_classification_runs FORCE ROW LEVEL SECURITY');
  pgm.sql(`CREATE POLICY tenant_all ON expense_classification_runs
    USING (tenant_id = public.tilivo_tenant_id())
    WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON expense_classification_runs TO tilivo_runtime');

  for (const [key, description] of [
    ['purchase.classify', 'Run AI expense classification'],
    ['purchase.classification.apply', 'Apply AI expense classification'],
  ]) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner','Admin','Accountant')
      AND p.key IN ('purchase.classify','purchase.classification.apply')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name = 'Employee' AND p.key = 'purchase.classify'
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN ('purchase.classify','purchase.classification.apply')
  `);
  pgm.sql(`DELETE FROM permissions WHERE key IN ('purchase.classify','purchase.classification.apply')`);
  pgm.dropTable('expense_classification_runs');
  pgm.dropColumns('purchase_invoices', ['category']);
};
