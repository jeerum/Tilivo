exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---------------------------------------------------------------------------
  // 1. business_parties
  // ---------------------------------------------------------------------------
  pgm.createTable('business_parties', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    is_customer: { type: 'boolean', notNull: true, default: true },
    is_supplier: { type: 'boolean', notNull: true, default: false },
    business_id: { type: 'text' },
    vat_id: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    address_line1: { type: 'text' },
    address_line2: { type: 'text' },
    postal_code: { type: 'text' },
    city: { type: 'text' },
    country_code: { type: 'text', notNull: true, default: 'FI' },
    language: { type: 'text', notNull: true, default: 'fi' },
    payment_terms_days: { type: 'integer', notNull: true, default: 14 },
    default_currency: { type: 'text', notNull: true, default: 'EUR' },
    iban: { type: 'text' },
    e_invoice_address: { type: 'text' },
    e_invoice_operator: { type: 'text' },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('business_parties', ['tenant_id', 'name']);
  pgm.createIndex('business_parties', ['tenant_id', 'is_customer', 'is_active']);

  // 2. invoice_number_series
  pgm.createTable('invoice_number_series', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    prefix: { type: 'text', notNull: true, default: '' },
    fiscal_year_id: { type: 'uuid', references: 'fiscal_years', onDelete: 'SET NULL' },
    next_number: { type: 'bigint', notNull: true, default: 1 },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('invoice_number_series', ['tenant_id', 'name'], { unique: true });

  // 3. sales_settings
  pgm.createTable('sales_settings', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    company_id: { type: 'uuid' },
    default_invoice_series_id: { type: 'uuid' },
    default_payment_terms_days: { type: 'integer', notNull: true, default: 14 },
    accounts_receivable_account_id: { type: 'uuid' },
    default_sales_revenue_account_id: { type: 'uuid' },
    tax_payable_account_id: { type: 'uuid' },
    default_language: { type: 'text', notNull: true, default: 'fi' },
    default_currency: { type: 'text', notNull: true, default: 'EUR', references: 'currencies' },
    payment_reference_type: { type: 'text', notNull: true, default: 'FI_DOMESTIC' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sales_settings', ['tenant_id'], { unique: true });

  // 4. sales_invoices
  pgm.createTable('sales_invoices', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    company_id: { type: 'uuid' },
    customer_id: { type: 'uuid', notNull: true },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    series_id: { type: 'uuid', notNull: true },
    invoice_number: { type: 'text' },
    issue_date: { type: 'date' },
    due_date: { type: 'date', notNull: true },
    currency_code: { type: 'text', notNull: true, default: 'EUR', references: 'currencies' },
    language: { type: 'text', notNull: true, default: 'fi' },
    reference_type: { type: 'text', notNull: true, default: 'FI_DOMESTIC' },
    payment_reference: { type: 'text' },
    customer_snapshot: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    subtotal: { type: 'numeric(28,8)', notNull: true, default: 0 },
    tax_total: { type: 'numeric(28,8)', notNull: true, default: 0 },
    total: { type: 'numeric(28,8)', notNull: true, default: 0 },
    accounting_journal_entry_id: { type: 'uuid' },
    credit_of_invoice_id: { type: 'uuid' },
    credited_by_invoice_id: { type: 'uuid' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    issued_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    issued_at: { type: 'timestamptz' },
  });
  pgm.createIndex('sales_invoices', ['tenant_id', 'status', 'issue_date']);
  pgm.createIndex('sales_invoices', ['tenant_id', 'customer_id']);
  pgm.createIndex('sales_invoices', ['tenant_id', 'issue_date']);
  pgm.sql(`
    CREATE UNIQUE INDEX sales_invoices_tenant_number_unique
    ON sales_invoices (tenant_id, invoice_number)
    WHERE invoice_number IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX sales_invoices_journal_link_unique
    ON sales_invoices (accounting_journal_entry_id)
    WHERE accounting_journal_entry_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX sales_invoices_credit_of_unique
    ON sales_invoices (credit_of_invoice_id)
    WHERE credit_of_invoice_id IS NOT NULL
  `);

  // 5. sales_invoice_lines
  pgm.createTable('sales_invoice_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    sales_invoice_id: { type: 'uuid', notNull: true },
    line_number: { type: 'integer', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    quantity: { type: 'numeric(18,6)', notNull: true, default: 1 },
    unit: { type: 'text', notNull: true, default: '' },
    unit_price: { type: 'numeric(28,8)', notNull: true, default: 0 },
    discount_percent: { type: 'numeric(5,2)', notNull: true, default: 0 },
    net_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    tax_code_id: { type: 'uuid' },
    tax_rate_snapshot: { type: 'numeric(10,4)' },
    tax_type_snapshot: { type: 'text' },
    reporting_mapping_snapshot: { type: 'text' },
    tax_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    gross_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    revenue_account_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sales_invoice_lines', ['tenant_id', 'sales_invoice_id', 'line_number'], { unique: true });
  pgm.createIndex('sales_invoice_lines', ['tenant_id', 'tax_code_id']);
  pgm.createIndex('sales_invoice_lines', ['tenant_id', 'revenue_account_id']);

  // 6. sales_invoice_credit_links
  pgm.createTable('sales_invoice_credit_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    original_invoice_id: { type: 'uuid', notNull: true },
    credit_invoice_id: { type: 'uuid', notNull: true },
    reason: { type: 'text', notNull: true, default: '' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sales_invoice_credit_links', ['original_invoice_id'], { unique: true });
  pgm.createIndex('sales_invoice_credit_links', ['credit_invoice_id'], { unique: true });

  // 7. sales_invoice_pdfs
  pgm.createTable('sales_invoice_pdfs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true },
    document_id: { type: 'uuid' },
    status: { type: 'text', notNull: true, default: 'GENERATING' },
    sha256: { type: 'text' },
    size_bytes: { type: 'bigint' },
    failure_reason: { type: 'text' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sales_invoice_pdfs', ['tenant_id', 'invoice_id'], { unique: true });

  // ---------------------------------------------------------------------------
  // Tenant-aware composite foreign keys. RLS is defense in depth; these make
  // cross-tenant relations impossible even for a role that bypasses RLS.
  // ---------------------------------------------------------------------------
  const uniqueTenantIdIndexes = [
    ['business_parties', 'business_parties_tenant_id_id_unique', ['tenant_id', 'id']],
    ['invoice_number_series', 'invoice_number_series_tenant_id_id_unique', ['tenant_id', 'id']],
    ['sales_settings', 'sales_settings_tenant_id_id_unique', ['tenant_id', 'id']],
    ['sales_invoices', 'sales_invoices_tenant_id_id_unique', ['tenant_id', 'id']],
    ['accounts', 'accounts_tenant_id_id_unique', ['tenant_id', 'id']],
    ['tax_codes', 'tax_codes_tenant_id_id_unique', ['tenant_id', 'id']],
    ['journal_entries', 'journal_entries_tenant_id_id_unique', ['tenant_id', 'id']],
    ['documents', 'documents_tenant_id_id_unique', ['tenant_id', 'id']],
    ['document_versions', 'document_versions_tenant_id_id_unique', ['tenant_id', 'id']],
    ['companies', 'companies_tenant_id_id_unique', ['tenant_id', 'id']],
  ];
  for (const [table, name, columns] of uniqueTenantIdIndexes) {
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')})`);
  }

  const compositeForeignKeys = [
    ['sales_settings', 'sales_settings_company_fk', 'company_id', 'companies'],
    ['sales_settings', 'sales_settings_series_fk', 'default_invoice_series_id', 'invoice_number_series'],
    ['sales_settings', 'sales_settings_ar_account_fk', 'accounts_receivable_account_id', 'accounts'],
    ['sales_settings', 'sales_settings_revenue_account_fk', 'default_sales_revenue_account_id', 'accounts'],
    ['sales_settings', 'sales_settings_tax_account_fk', 'tax_payable_account_id', 'accounts'],
    ['sales_invoices', 'sales_invoices_company_fk', 'company_id', 'companies'],
    ['sales_invoices', 'sales_invoices_customer_fk', 'customer_id', 'business_parties'],
    ['sales_invoices', 'sales_invoices_series_fk', 'series_id', 'invoice_number_series'],
    ['sales_invoices', 'sales_invoices_journal_entry_fk', 'accounting_journal_entry_id', 'journal_entries'],
    ['sales_invoices', 'sales_invoices_credit_of_fk', 'credit_of_invoice_id', 'sales_invoices'],
    ['sales_invoices', 'sales_invoices_credited_by_fk', 'credited_by_invoice_id', 'sales_invoices'],
    ['sales_invoice_lines', 'sales_invoice_lines_invoice_fk', 'sales_invoice_id', 'sales_invoices'],
    ['sales_invoice_lines', 'sales_invoice_lines_tax_code_fk', 'tax_code_id', 'tax_codes'],
    ['sales_invoice_lines', 'sales_invoice_lines_revenue_account_fk', 'revenue_account_id', 'accounts'],
    ['sales_invoice_credit_links', 'sales_invoice_credit_links_original_fk', 'original_invoice_id', 'sales_invoices'],
    ['sales_invoice_credit_links', 'sales_invoice_credit_links_credit_fk', 'credit_invoice_id', 'sales_invoices'],
    ['sales_invoice_pdfs', 'sales_invoice_pdfs_invoice_fk', 'invoice_id', 'sales_invoices'],
    ['sales_invoice_pdfs', 'sales_invoice_pdfs_document_fk', 'document_id', 'documents'],
  ];
  for (const [table, name, column, target] of compositeForeignKeys) {
    pgm.sql(`
      ALTER TABLE ${table}
      ADD CONSTRAINT ${name}
      FOREIGN KEY (tenant_id, ${column})
      REFERENCES ${target}(tenant_id, id)
      ON DELETE ${target === 'companies' || target === 'journal_entries' || target === 'documents' ? 'SET NULL' : 'RESTRICT'}
    `);
  }
  // invoice_number_series.fiscal_year_id -> fiscal_years is a tenant-owned
  // reference as well; fiscal_years already gets a unique (tenant_id,id) index.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS fiscal_years_tenant_id_id_unique ON fiscal_years (tenant_id, id)
  `);
  pgm.sql(`
    ALTER TABLE invoice_number_series
    ADD CONSTRAINT invoice_number_series_fiscal_year_fk
    FOREIGN KEY (tenant_id, fiscal_year_id)
    REFERENCES fiscal_years(tenant_id, id)
    ON DELETE SET NULL
  `);

  // ---------------------------------------------------------------------------
  // Immutability triggers
  // ---------------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_sales_invoices_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      v_linked bigint;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('DRAFT', 'CANCELLED_DRAFT') THEN
          RAISE EXCEPTION 'sales invoices must be inserted as DRAFT';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('ISSUED', 'CREDITED', 'CANCELLED_DRAFT') THEN
          RAISE EXCEPTION 'issued sales invoice is immutable';
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED_DRAFT' THEN
        RETURN NEW;
      END IF;

      IF OLD.status = 'DRAFT' AND NEW.status = 'ISSUED' THEN
        IF NEW.invoice_number IS NULL OR NEW.issued_by IS NULL OR NEW.issued_at IS NULL
           OR NEW.accounting_journal_entry_id IS NULL
           OR NEW.customer_snapshot = '{}'::jsonb
           OR (NEW.payment_reference IS NULL AND NEW.reference_type <> 'NONE') THEN
          RAISE EXCEPTION 'issued invoice requires number, reference, snapshot and journal link';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'ISSUED' AND NEW.status = 'CREDITED' THEN
        IF OLD.credited_by_invoice_id IS NOT NULL THEN
          RAISE EXCEPTION 'invoice already credited';
        END IF;
        IF NEW.credited_by_invoice_id IS NULL THEN
          RAISE EXCEPTION 'credit requires credit invoice linkage';
        END IF;
        SELECT count(*) INTO v_linked
          FROM sales_invoice_credit_links
          WHERE original_invoice_id = OLD.id AND credit_invoice_id = NEW.credited_by_invoice_id;
        IF v_linked <> 1 THEN
          RAISE EXCEPTION 'credit requires a matching credit link';
        END IF;
        IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
           OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
           OR NEW.due_date IS DISTINCT FROM OLD.due_date
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot
           OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
           OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
           OR NEW.total IS DISTINCT FROM OLD.total
           OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
          RAISE EXCEPTION 'credit may not alter issued invoice data';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status IN ('ISSUED', 'CREDITED', 'CANCELLED_DRAFT') OR NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'issued sales invoice is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_sales_invoices_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON sales_invoices
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_sales_invoices_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_sales_invoice_lines_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE invoice_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        SELECT status INTO invoice_status FROM sales_invoices WHERE id = OLD.sales_invoice_id;
        IF invoice_status IN ('ISSUED', 'CREDITED', 'CANCELLED_DRAFT') THEN
          RAISE EXCEPTION 'issued invoice lines are immutable';
        END IF;
        RETURN OLD;
      END IF;
      SELECT status INTO invoice_status FROM sales_invoices WHERE id = NEW.sales_invoice_id;
      IF invoice_status IN ('ISSUED', 'CREDITED', 'CANCELLED_DRAFT') THEN
        RAISE EXCEPTION 'issued invoice lines are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_sales_invoice_lines_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_lines
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_sales_invoice_lines_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_sales_credit_link_validate()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      v_original_status text;
      v_credit_status text;
      v_original_total numeric(28,8);
      v_credit_total numeric(28,8);
      v_original_currency text;
      v_credit_currency text;
      v_original_customer uuid;
      v_credit_customer uuid;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'credit links are immutable';
      END IF;
      SELECT status, total, currency_code, customer_id
        INTO v_original_status, v_original_total, v_original_currency, v_original_customer
        FROM sales_invoices WHERE id = NEW.original_invoice_id;
      SELECT status, total, currency_code, customer_id
        INTO v_credit_status, v_credit_total, v_credit_currency, v_credit_customer
        FROM sales_invoices WHERE id = NEW.credit_invoice_id;
      IF v_original_status IS NULL OR v_credit_status IS NULL THEN
        RAISE EXCEPTION 'credit link references missing invoices';
      END IF;
      IF v_original_status <> 'ISSUED' THEN
        RAISE EXCEPTION 'only issued invoices can be credited';
      END IF;
      IF v_credit_status <> 'ISSUED' THEN
        RAISE EXCEPTION 'credit invoice must be issued';
      END IF;
      IF v_original_total <> v_credit_total THEN
        RAISE EXCEPTION 'full credit total must equal the original invoice total';
      END IF;
      IF v_original_currency IS DISTINCT FROM v_credit_currency
         OR v_original_customer IS DISTINCT FROM v_credit_customer THEN
        RAISE EXCEPTION 'credit invoice must match customer and currency';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_sales_credit_link_validate
    BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_credit_links
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_sales_credit_link_validate()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_sales_invoice_pdfs_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'READY' THEN
          RAISE EXCEPTION 'ready invoice pdf is immutable';
        END IF;
        RETURN OLD;
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.status = 'READY' THEN
        RAISE EXCEPTION 'ready invoice pdf is immutable';
      END IF;
      IF TG_OP = 'INSERT' AND NEW.status <> 'GENERATING' THEN
        RAISE EXCEPTION 'invoice pdfs must be inserted as GENERATING';
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.status = 'READY' THEN
        IF NEW.sha256 IS NULL OR NEW.size_bytes IS NULL OR NEW.document_id IS NULL THEN
          RAISE EXCEPTION 'ready pdf requires document metadata';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_sales_invoice_pdfs_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON sales_invoice_pdfs
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_sales_invoice_pdfs_immutable()
  `);

  // ---------------------------------------------------------------------------
  // Default sales settings for existing tenants. Existing tenants keep their
  // data; each gets one active default invoice number series (prefix-less,
  // year-prefixed numbers such as 2026-000001). Accounting mappings are left
  // empty and must be configured before the first invoice can be issued.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO invoice_number_series (tenant_id, name, prefix)
    SELECT t.id, 'Default', ''
    FROM tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM invoice_number_series s WHERE s.tenant_id = t.id
    )
  `);
  pgm.sql(`
    INSERT INTO sales_settings
      (tenant_id, company_id, default_invoice_series_id, default_payment_terms_days,
       default_language, default_currency, payment_reference_type)
    SELECT t.id,
           (SELECT c.id FROM companies c
            WHERE c.tenant_id = t.id AND c.status = 'ACTIVE'
            ORDER BY c.created_at LIMIT 1),
           (SELECT s.id FROM invoice_number_series s
            WHERE s.tenant_id = t.id
            ORDER BY s.created_at LIMIT 1),
           14, 'fi', 'EUR', 'FI_DOMESTIC'
    FROM tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM sales_settings ss WHERE ss.tenant_id = t.id
    )
  `);

  // ---------------------------------------------------------------------------
  // RLS + grants
  // ---------------------------------------------------------------------------
  const tenantTables = [
    'business_parties',
    'invoice_number_series',
    'sales_settings',
    'sales_invoices',
    'sales_invoice_lines',
    'sales_invoice_credit_links',
    'sales_invoice_pdfs',
  ];
  for (const table of tenantTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
    if (table === 'sales_invoice_credit_links') {
      // Insert-only: credit links are immutable once created (triggers also
      // protect against owner-level tampering).
      pgm.sql(`GRANT SELECT, INSERT ON ${table} TO tilivo_runtime`);
    } else if (table === 'sales_invoice_pdfs') {
      pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${table} TO tilivo_runtime`);
    } else {
      pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO tilivo_runtime`);
    }
  }

  // Worker renders and stores PDFs; it runs with an explicit per-event tenant
  // context (app.tenant_id) so tenant RLS applies to it as well.
  pgm.sql('GRANT SELECT ON sales_invoices TO tilivo_worker');
  pgm.sql('GRANT SELECT ON sales_invoice_lines TO tilivo_worker');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON sales_invoice_pdfs TO tilivo_worker');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON documents TO tilivo_worker');
  pgm.sql('GRANT SELECT, INSERT ON document_versions TO tilivo_worker');
  pgm.sql('GRANT SELECT ON business_parties TO tilivo_worker');
  pgm.sql('GRANT SELECT ON sales_settings TO tilivo_worker');
  pgm.sql('GRANT SELECT ON companies TO tilivo_worker');
  pgm.sql('GRANT SELECT, INSERT ON audit_events TO tilivo_worker');

  const newPermissions = [
    ['sales.read', 'Read sales'],
    ['sales.customer.manage', 'Manage customers'],
    ['invoice.create', 'Create invoice drafts'],
    ['invoice.issue', 'Issue invoices'],
    ['invoice.credit', 'Credit invoices'],
    ['invoice.pdf.retry', 'Retry invoice PDF generation'],
    ['sales.settings.manage', 'Manage sales settings'],
  ];
  for (const [key, description] of newPermissions) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner', 'Admin')
      AND p.key IN ('sales.read','sales.customer.manage','invoice.create','invoice.issue',
                    'invoice.credit','invoice.pdf.retry','sales.settings.manage')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name = 'Accountant'
      AND p.key IN ('sales.read','sales.customer.manage','invoice.create','invoice.issue',
                    'invoice.credit','invoice.pdf.retry')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Viewer', 'Employee')
      AND p.key IN ('sales.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN
      ('sales.read','sales.customer.manage','invoice.create','invoice.issue',
       'invoice.credit','invoice.pdf.retry','sales.settings.manage')
  `);
  pgm.sql(`
    DELETE FROM permissions WHERE key IN
      ('sales.read','sales.customer.manage','invoice.create','invoice.issue',
       'invoice.credit','invoice.pdf.retry','sales.settings.manage')
  `);
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_sales_invoices_immutable()');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_sales_invoice_lines_immutable()');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_sales_credit_link_validate()');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_sales_invoice_pdfs_immutable()');
  pgm.dropTable('sales_invoice_pdfs');
  pgm.dropTable('sales_invoice_credit_links');
  pgm.dropTable('sales_invoice_lines');
  pgm.dropTable('sales_invoices');
  pgm.dropTable('sales_settings');
  pgm.dropTable('invoice_number_series');
  pgm.dropTable('business_parties');
  const extraIndexes = [
    'fiscal_years_tenant_id_id_unique',
    'companies_tenant_id_id_unique',
    'documents_tenant_id_id_unique',
    'document_versions_tenant_id_id_unique',
    'accounts_tenant_id_id_unique',
    'tax_codes_tenant_id_id_unique',
    'journal_entries_tenant_id_id_unique',
  ];
  for (const index of extraIndexes) {
    pgm.sql(`DROP INDEX IF EXISTS ${index}`);
  }
};
