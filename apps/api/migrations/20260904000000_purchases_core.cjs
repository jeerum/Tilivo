exports.shorthands = undefined;

exports.up = (pgm) => {
  // Supplier defaults on the shared business party table.
  pgm.addColumns('business_parties', {
    default_expense_account_id: { type: 'uuid' },
    default_tax_code_id: { type: 'uuid' },
  });
  pgm.sql(`
    ALTER TABLE business_parties
      ADD CONSTRAINT business_parties_default_expense_fk
      FOREIGN KEY (tenant_id, default_expense_account_id)
      REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT business_parties_default_tax_code_fk
      FOREIGN KEY (tenant_id, default_tax_code_id)
      REFERENCES tax_codes(tenant_id, id) ON DELETE SET NULL
  `);

  pgm.createTable('purchase_invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    company_id: { type: 'uuid' },
    supplier_id: { type: 'uuid' },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    supplier_invoice_number: { type: 'text' },
    supplier_invoice_number_normalized: { type: 'text' },
    invoice_date: { type: 'date' },
    due_date: { type: 'date' },
    currency_code: { type: 'text', notNull: true, default: 'EUR', references: 'currencies' },
    supplier_reference: { type: 'text' },
    supplier_iban: { type: 'text' },
    source_type: { type: 'text', notNull: true, default: 'MANUAL' },
    source_external_id: { type: 'text' },
    supplier_snapshot: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    source_total: { type: 'numeric(28,8)' },
    subtotal: { type: 'numeric(28,8)', notNull: true, default: 0 },
    tax_total: { type: 'numeric(28,8)', notNull: true, default: 0 },
    total: { type: 'numeric(28,8)', notNull: true, default: 0 },
    accounting_journal_entry_id: { type: 'uuid' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reviewed_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    approved_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    posted_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    reviewed_at: { type: 'timestamptz' },
    approved_at: { type: 'timestamptz' },
    posted_at: { type: 'timestamptz' },
  });
  pgm.sql(`
    ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_status_check
    CHECK (status IN ('INGESTED','DRAFT','NEEDS_REVIEW','READY_FOR_APPROVAL','APPROVED',
                      'POSTED','REJECTED','CANCELLED_DRAFT','CORRECTED'))
  `);
  pgm.createIndex('purchase_invoices', ['tenant_id', 'status', 'invoice_date']);
  pgm.createIndex('purchase_invoices', ['tenant_id', 'supplier_id']);
  pgm.createIndex('purchase_invoices', ['tenant_id', 'source_type', 'source_external_id']);
  pgm.sql(`
    CREATE UNIQUE INDEX purchase_invoices_source_external_unique
    ON purchase_invoices (tenant_id, source_type, source_external_id)
    WHERE source_external_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX purchase_invoices_journal_link_unique
    ON purchase_invoices (accounting_journal_entry_id)
    WHERE accounting_journal_entry_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX purchase_invoices_supplier_duplicate_unique
    ON purchase_invoices (tenant_id, supplier_id, supplier_invoice_number_normalized, invoice_date)
    WHERE supplier_id IS NOT NULL
      AND supplier_invoice_number_normalized IS NOT NULL
      AND status NOT IN ('REJECTED','CANCELLED_DRAFT','CORRECTED')
  `);

  pgm.createTable('purchase_invoice_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_invoice_id: { type: 'uuid', notNull: true },
    line_number: { type: 'integer', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    quantity: { type: 'numeric(18,6)' },
    unit: { type: 'text' },
    unit_price: { type: 'numeric(28,8)' },
    net_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    tax_code_id: { type: 'uuid' },
    tax_rate_snapshot: { type: 'numeric(10,4)' },
    tax_type_snapshot: { type: 'text' },
    reporting_mapping_snapshot: { type: 'text' },
    tax_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    gross_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    expense_account_id: { type: 'uuid', notNull: true },
    cost_center: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_invoice_lines', ['tenant_id', 'purchase_invoice_id', 'line_number'], { unique: true });
  pgm.createIndex('purchase_invoice_lines', ['tenant_id', 'tax_code_id']);
  pgm.createIndex('purchase_invoice_lines', ['tenant_id', 'expense_account_id']);

  pgm.createTable('purchase_invoice_documents', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_invoice_id: { type: 'uuid', notNull: true },
    document_id: { type: 'uuid', notNull: true },
    document_version_id: { type: 'uuid', notNull: true },
    role: { type: 'text', notNull: true, default: 'SOURCE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_invoice_documents', ['tenant_id', 'purchase_invoice_id', 'role']);
  pgm.sql(`
    CREATE UNIQUE INDEX purchase_invoice_documents_version_unique
    ON purchase_invoice_documents (tenant_id, purchase_invoice_id, document_version_id, role)
  `);

  pgm.createTable('purchase_invoice_approvals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_invoice_id: { type: 'uuid', notNull: true },
    action: { type: 'text', notNull: true },
    actor_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reason: { type: 'text', notNull: true, default: '' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_invoice_approvals', ['tenant_id', 'purchase_invoice_id', 'created_at']);

  pgm.createTable('purchase_invoice_extractions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_invoice_id: { type: 'uuid', notNull: true },
    field_name: { type: 'text', notNull: true },
    value: { type: 'text', notNull: true, default: '' },
    confidence: { type: 'numeric(5,4)' },
    source: { type: 'text', notNull: true, default: 'MANUAL' },
    source_region: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_invoice_extractions', ['tenant_id', 'purchase_invoice_id', 'field_name', 'source'], { unique: true });

  pgm.createTable('purchase_invoice_corrections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_invoice_id: { type: 'uuid', notNull: true },
    reversal_journal_entry_id: { type: 'uuid', notNull: true },
    reason: { type: 'text', notNull: true, default: '' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_invoice_corrections', ['purchase_invoice_id'], { unique: true });
  pgm.createIndex('purchase_invoice_corrections', ['reversal_journal_entry_id'], { unique: true });

  pgm.createTable('purchase_imports', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    source_type: { type: 'text', notNull: true },
    source_external_id: { type: 'text', notNull: true },
    supplier_name: { type: 'text' },
    supplier_invoice_number: { type: 'text' },
    total: { type: 'numeric(28,8)' },
    status: { type: 'text', notNull: true, default: 'RECEIVED' },
    error: { type: 'text' },
    purchase_invoice_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_imports', ['tenant_id', 'source_type', 'source_external_id'], { unique: true });

  pgm.createTable('purchase_settings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    company_id: { type: 'uuid' },
    accounts_payable_account_id: { type: 'uuid' },
    default_expense_account_id: { type: 'uuid' },
    input_vat_account_id: { type: 'uuid' },
    reverse_charge_input_account_id: { type: 'uuid' },
    reverse_charge_output_account_id: { type: 'uuid' },
    require_separate_approver: { type: 'boolean', notNull: true, default: false },
    auto_post_on_approval: { type: 'boolean', notNull: true, default: false },
    default_currency: { type: 'text', notNull: true, default: 'EUR', references: 'currencies' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('purchase_settings', ['tenant_id'], { unique: true });

  // Tenant-aware composite foreign keys.
  const uniqueIndexes = [
    ['purchase_invoices', 'purchase_invoices_tenant_id_id_unique', ['tenant_id', 'id']],
    ['purchase_settings', 'purchase_settings_tenant_id_id_unique', ['tenant_id', 'id']],
  ];
  for (const [table, name, columns] of uniqueIndexes) {
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')})`);
  }
  const compositeFks = [
    ['purchase_invoices', 'purchase_invoices_company_fk', 'company_id', 'companies', 'SET NULL'],
    ['purchase_invoices', 'purchase_invoices_supplier_fk', 'supplier_id', 'business_parties', 'SET NULL'],
    ['purchase_invoices', 'purchase_invoices_journal_fk', 'accounting_journal_entry_id', 'journal_entries', 'SET NULL'],
    ['purchase_invoice_lines', 'purchase_lines_invoice_fk', 'purchase_invoice_id', 'purchase_invoices', 'CASCADE'],
    ['purchase_invoice_lines', 'purchase_lines_tax_fk', 'tax_code_id', 'tax_codes', 'RESTRICT'],
    ['purchase_invoice_lines', 'purchase_lines_expense_fk', 'expense_account_id', 'accounts', 'RESTRICT'],
    ['purchase_invoice_documents', 'purchase_docs_invoice_fk', 'purchase_invoice_id', 'purchase_invoices', 'CASCADE'],
    ['purchase_invoice_documents', 'purchase_docs_document_fk', 'document_id', 'documents', 'RESTRICT'],
    ['purchase_invoice_documents', 'purchase_docs_version_fk', 'document_version_id', 'document_versions', 'RESTRICT'],
    ['purchase_invoice_approvals', 'purchase_approvals_invoice_fk', 'purchase_invoice_id', 'purchase_invoices', 'CASCADE'],
    ['purchase_invoice_extractions', 'purchase_extractions_invoice_fk', 'purchase_invoice_id', 'purchase_invoices', 'CASCADE'],
    ['purchase_invoice_corrections', 'purchase_corrections_invoice_fk', 'purchase_invoice_id', 'purchase_invoices', 'CASCADE'],
    ['purchase_invoice_corrections', 'purchase_corrections_journal_fk', 'reversal_journal_entry_id', 'journal_entries', 'RESTRICT'],
    ['purchase_imports', 'purchase_imports_invoice_fk', 'purchase_invoice_id', 'purchase_invoices', 'SET NULL'],
    ['purchase_settings', 'purchase_settings_company_fk', 'company_id', 'companies', 'SET NULL'],
    ['purchase_settings', 'purchase_settings_ap_fk', 'accounts_payable_account_id', 'accounts', 'SET NULL'],
    ['purchase_settings', 'purchase_settings_expense_fk', 'default_expense_account_id', 'accounts', 'SET NULL'],
    ['purchase_settings', 'purchase_settings_vat_fk', 'input_vat_account_id', 'accounts', 'SET NULL'],
    ['purchase_settings', 'purchase_settings_rc_in_fk', 'reverse_charge_input_account_id', 'accounts', 'SET NULL'],
    ['purchase_settings', 'purchase_settings_rc_out_fk', 'reverse_charge_output_account_id', 'accounts', 'SET NULL'],
  ];
  for (const [table, name, column, target, onDelete] of compositeFks) {
    pgm.sql(`
      ALTER TABLE ${table} ADD CONSTRAINT ${name}
      FOREIGN KEY (tenant_id, ${column})
      REFERENCES ${target}(tenant_id, id) ON DELETE ${onDelete}
    `);
  }

  // ---------------------------------------------------------------------------
  // Immutability / lifecycle triggers
  // ---------------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_purchase_invoices_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v_linked bigint;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('INGESTED', 'DRAFT') THEN
          RAISE EXCEPTION 'purchase invoices must be inserted as INGESTED or DRAFT';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('APPROVED','POSTED','CORRECTED','REJECTED','CANCELLED_DRAFT') THEN
          RAISE EXCEPTION 'posted purchase invoice is immutable';
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED_DRAFT' THEN RETURN NEW; END IF;
      IF OLD.status IN ('INGESTED','DRAFT','NEEDS_REVIEW') AND NEW.status = 'NEEDS_REVIEW' THEN
        RETURN NEW;
      END IF;
      IF OLD.status IN ('INGESTED','DRAFT','NEEDS_REVIEW') AND NEW.status = 'READY_FOR_APPROVAL' THEN
        IF NEW.supplier_id IS NULL OR NEW.supplier_snapshot = '{}'::jsonb THEN
          RAISE EXCEPTION 'review requires a confirmed supplier snapshot';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status IN ('NEEDS_REVIEW','READY_FOR_APPROVAL') AND NEW.status = 'REJECTED' THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'READY_FOR_APPROVAL' AND NEW.status = 'APPROVED' THEN
        IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
          RAISE EXCEPTION 'approval requires approver metadata';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status = 'APPROVED' AND NEW.status = 'POSTED' THEN
        IF NEW.accounting_journal_entry_id IS NULL OR NEW.posted_by IS NULL OR NEW.posted_at IS NULL THEN
          RAISE EXCEPTION 'posting requires journal and post metadata';
        END IF;
        IF NEW.supplier_invoice_number IS DISTINCT FROM OLD.supplier_invoice_number
           OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
           OR NEW.due_date IS DISTINCT FROM OLD.due_date
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
           OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
           OR NEW.total IS DISTINCT FROM OLD.total
           OR NEW.supplier_snapshot IS DISTINCT FROM OLD.supplier_snapshot
           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
          RAISE EXCEPTION 'posting may not alter approved purchase data';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status = 'POSTED' AND NEW.status = 'CORRECTED' THEN
        SELECT count(*) INTO v_linked
        FROM purchase_invoice_corrections c
        JOIN journal_entries je ON je.id = c.reversal_journal_entry_id
        WHERE c.purchase_invoice_id = OLD.id AND je.status = 'POSTED';
        IF v_linked <> 1 THEN
          RAISE EXCEPTION 'correction requires a posted reversal journal';
        END IF;
        IF NEW.supplier_invoice_number IS DISTINCT FROM OLD.supplier_invoice_number
           OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
           OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
           OR NEW.total IS DISTINCT FROM OLD.total
           OR NEW.supplier_snapshot IS DISTINCT FROM OLD.supplier_snapshot THEN
          RAISE EXCEPTION 'correction may not alter posted purchase data';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status IN ('APPROVED','POSTED','CORRECTED','REJECTED','CANCELLED_DRAFT')
         OR NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'purchase invoice status transition not allowed';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_purchase_invoices_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON purchase_invoices
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_purchase_invoices_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_purchase_lines_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE invoice_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        SELECT status INTO invoice_status FROM purchase_invoices WHERE id = OLD.purchase_invoice_id;
        IF invoice_status NOT IN ('INGESTED','DRAFT','NEEDS_REVIEW') THEN
          RAISE EXCEPTION 'posted purchase invoice lines are immutable';
        END IF;
        RETURN OLD;
      END IF;
      SELECT status INTO invoice_status FROM purchase_invoices WHERE id = NEW.purchase_invoice_id;
      IF invoice_status NOT IN ('INGESTED','DRAFT','NEEDS_REVIEW') THEN
        RAISE EXCEPTION 'posted purchase invoice lines are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_purchase_lines_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON purchase_invoice_lines
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_purchase_lines_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_purchase_history_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'purchase history records are immutable';
    END;
    $$;
  `);
  for (const table of ['purchase_invoice_approvals', 'purchase_invoice_extractions', 'purchase_invoice_corrections', 'purchase_invoice_documents']) {
    pgm.sql(`
      CREATE TRIGGER tilivo_${table}_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION public.tilivo_purchase_history_immutable()
    `);
  }

  // Seed purchase settings for existing tenants (account mappings are empty
  // until configured).
  pgm.sql(`
    INSERT INTO purchase_settings
      (tenant_id, company_id, require_separate_approver, auto_post_on_approval, default_currency)
    SELECT t.id,
           (SELECT c.id FROM companies c
            WHERE c.tenant_id = t.id AND c.status = 'ACTIVE' ORDER BY c.created_at LIMIT 1),
           false, false, 'EUR'
    FROM tenants t
    WHERE NOT EXISTS (SELECT 1 FROM purchase_settings ps WHERE ps.tenant_id = t.id)
  `);

  // RLS + grants.
  const tenantTables = [
    'purchase_invoices',
    'purchase_invoice_lines',
    'purchase_invoice_documents',
    'purchase_invoice_approvals',
    'purchase_invoice_extractions',
    'purchase_invoice_corrections',
    'purchase_imports',
    'purchase_settings',
  ];
  for (const table of tenantTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
    if (['purchase_invoice_documents', 'purchase_invoice_approvals', 'purchase_invoice_extractions', 'purchase_invoice_corrections'].includes(table)) {
      pgm.sql(`GRANT SELECT, INSERT ON ${table} TO tilivo_runtime`);
    } else {
      pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO tilivo_runtime`);
    }
    pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${table} TO tilivo_worker`);
  }
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON documents TO tilivo_worker');
  pgm.sql('GRANT SELECT, INSERT ON document_versions TO tilivo_worker');
  pgm.sql('GRANT SELECT ON business_parties TO tilivo_worker');
  pgm.sql('GRANT SELECT, INSERT ON audit_events TO tilivo_worker');

  const newPermissions = [
    ['purchase.read', 'Read purchases'],
    ['purchase.create', 'Create purchase invoices'],
    ['purchase.edit', 'Edit purchase invoices'],
    ['purchase.review', 'Review purchase invoices'],
    ['purchase.approve', 'Approve purchase invoices'],
    ['purchase.post', 'Post purchase invoices'],
    ['purchase.reject', 'Reject purchase invoices'],
    ['purchase.correct', 'Correct purchase invoices'],
    ['supplier.manage', 'Manage suppliers'],
    ['purchase.settings.manage', 'Manage purchase settings'],
    ['purchase.document.upload', 'Upload purchase documents'],
  ];
  for (const [key, description] of newPermissions) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner', 'Admin')
      AND p.key IN ('purchase.read','purchase.create','purchase.edit','purchase.review',
                    'purchase.approve','purchase.post','purchase.reject','purchase.correct',
                    'supplier.manage','purchase.settings.manage','purchase.document.upload')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name = 'Accountant'
      AND p.key IN ('purchase.read','purchase.create','purchase.edit','purchase.review',
                    'purchase.approve','purchase.post','purchase.reject','purchase.correct',
                    'supplier.manage','purchase.document.upload')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Viewer', 'Employee')
      AND p.key IN ('purchase.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN
      ('purchase.read','purchase.create','purchase.edit','purchase.review','purchase.approve',
       'purchase.post','purchase.reject','purchase.correct','supplier.manage',
       'purchase.settings.manage','purchase.document.upload')
  `);
  pgm.sql(`
    DELETE FROM permissions WHERE key IN
      ('purchase.read','purchase.create','purchase.edit','purchase.review','purchase.approve',
       'purchase.post','purchase.reject','purchase.correct','supplier.manage',
       'purchase.settings.manage','purchase.document.upload')
  `);
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_purchase_invoices_immutable()');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_purchase_lines_immutable()');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_purchase_history_immutable()');
  pgm.dropTable('purchase_settings');
  pgm.dropTable('purchase_imports');
  pgm.dropTable('purchase_invoice_corrections');
  pgm.dropTable('purchase_invoice_extractions');
  pgm.dropTable('purchase_invoice_approvals');
  pgm.dropTable('purchase_invoice_documents');
  pgm.dropTable('purchase_invoice_lines');
  pgm.dropTable('purchase_invoices');
  pgm.sql('ALTER TABLE business_parties DROP COLUMN IF EXISTS default_expense_account_id');
  pgm.sql('ALTER TABLE business_parties DROP COLUMN IF EXISTS default_tax_code_id');
};
