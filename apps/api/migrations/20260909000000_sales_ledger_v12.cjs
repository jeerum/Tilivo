exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('sales_settings', {
    bank_iban: { type: 'text' },
    bank_bic: { type: 'text' },
    bank_account_holder: { type: 'text' },
    advance_payments_received_account_id: { type: 'uuid' },
  });
  pgm.sql(`
    ALTER TABLE sales_settings
      ADD CONSTRAINT sales_settings_advance_account_fk
      FOREIGN KEY (tenant_id, advance_payments_received_account_id)
      REFERENCES accounts(tenant_id, id) ON DELETE SET NULL
  `);
  pgm.addColumns('sales_invoices', {
    document_type: { type: 'text', notNull: true, default: 'SALES_INVOICE' },
    payment_status: { type: 'text', notNull: true, default: 'UNPAID' },
    amount_paid: { type: 'numeric(28,8)', notNull: true, default: 0 },
    paid_at: { type: 'timestamptz' },
    customer_po_number: { type: 'text' },
    customer_reference: { type: 'text' },
    source_recurring_template_id: { type: 'uuid' },
    source_recurring_key: { type: 'text' },
  });
  pgm.addConstraint('sales_invoices', 'sales_invoices_document_type_check', {
    check: "document_type IN ('SALES_INVOICE','SALES_CREDIT_NOTE','ADVANCE_INVOICE','RECURRING_INVOICE')",
  });
  pgm.addConstraint('sales_invoices', 'sales_invoices_payment_status_check', {
    check: "payment_status IN ('UNPAID','PARTIALLY_PAID','PAID','OVERPAID')",
  });
  pgm.sql(`
    DROP TRIGGER IF EXISTS tilivo_sales_invoices_immutable ON sales_invoices;
    UPDATE sales_invoices
    SET document_type = CASE WHEN credit_of_invoice_id IS NOT NULL THEN 'SALES_CREDIT_NOTE' ELSE 'SALES_INVOICE' END
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_sales_invoices_immutable
    BEFORE UPDATE OR DELETE ON sales_invoices
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_sales_invoices_immutable()
  `);
  pgm.createIndex('sales_invoices', ['tenant_id', 'document_type', 'issue_date']);
  pgm.createIndex('sales_invoices', ['tenant_id', 'payment_status', 'due_date']);

  pgm.createTable('sales_invoice_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true },
    amount: { type: 'numeric(28,8)', notNull: true },
    payment_date: { type: 'date', notNull: true },
    method: { type: 'text', notNull: true, default: 'MANUAL' },
    reference: { type: 'text' },
    note: { type: 'text' },
    is_manual: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE sales_invoice_payments
      ADD CONSTRAINT sales_payments_invoice_fk
      FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT sales_payments_amount_check CHECK (amount > 0)
  `);
  pgm.createIndex('sales_invoice_payments', ['tenant_id', 'invoice_id', 'payment_date']);

  pgm.createTable('sales_reminders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    invoice_id: { type: 'uuid', notNull: true },
    level: { type: 'integer', notNull: true, default: 1 },
    amount_due: { type: 'numeric(28,8)', notNull: true },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    note: { type: 'text' },
    recipient: { type: 'text' },
    sent_at: { type: 'timestamptz' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE sales_reminders
      ADD CONSTRAINT sales_reminders_invoice_fk
      FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices(tenant_id, id) ON DELETE CASCADE
  `);
  pgm.createIndex('sales_reminders', ['tenant_id', 'invoice_id', 'created_at']);

  pgm.createTable('recurring_invoice_templates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    customer_id: { type: 'uuid', notNull: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    frequency: { type: 'text', notNull: true, default: 'MONTHLY' },
    start_date: { type: 'date', notNull: true },
    end_date: { type: 'date' },
    next_run_date: { type: 'date', notNull: true },
    language: { type: 'text', notNull: true, default: 'fi' },
    payment_terms_days: { type: 'integer', notNull: true, default: 14 },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE recurring_invoice_templates
      ADD CONSTRAINT recurring_templates_customer_fk
      FOREIGN KEY (tenant_id, customer_id) REFERENCES business_parties(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT recurring_templates_frequency_check
      CHECK (frequency IN ('MONTHLY','QUARTERLY','YEARLY'))
  `);
  pgm.createIndex('recurring_invoice_templates', ['tenant_id', 'next_run_date', 'is_active']);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS recurring_invoice_templates_tenant_id_id_unique
    ON recurring_invoice_templates (tenant_id, id)`);
  pgm.createTable('recurring_invoice_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    template_id: { type: 'uuid', notNull: true },
    line_number: { type: 'integer', notNull: true },
    description: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true, default: 1 },
    unit: { type: 'text' },
    unit_price: { type: 'numeric(28,8)', notNull: true, default: 0 },
    discount_percent: { type: 'numeric(5,2)', notNull: true, default: 0 },
    tax_code_id: { type: 'uuid', notNull: true },
  });
  pgm.sql(`
    ALTER TABLE recurring_invoice_lines
      ADD CONSTRAINT recurring_lines_template_fk
      FOREIGN KEY (tenant_id, template_id) REFERENCES recurring_invoice_templates(tenant_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT recurring_lines_tax_fk
      FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes(tenant_id, id) ON DELETE RESTRICT
  `);
  pgm.createIndex('recurring_invoice_lines', ['tenant_id', 'template_id', 'line_number'], { unique: true });
  pgm.sql(`
    ALTER TABLE sales_invoices
      ADD CONSTRAINT sales_invoices_recurring_template_fk
      FOREIGN KEY (tenant_id, source_recurring_template_id)
      REFERENCES recurring_invoice_templates(tenant_id, id) ON DELETE SET NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX sales_invoices_recurring_key_unique
    ON sales_invoices (tenant_id, source_recurring_key)
    WHERE source_recurring_key IS NOT NULL
  `);

  const tenantTables = ['sales_invoice_payments', 'sales_reminders', 'recurring_invoice_templates', 'recurring_invoice_lines'];
  for (const table of tenantTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
    pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${table} TO tilivo_runtime`);
  }

  for (const [key, description] of [
    ['sales.payment.record', 'Record sales payments'],
    ['sales.reminder.create', 'Create sales reminders'],
    ['sales.recurring.manage', 'Manage recurring invoice templates'],
  ]) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner','Admin','Accountant')
      AND p.key IN ('sales.payment.record','sales.reminder.create','sales.recurring.manage')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE sales_settings DROP CONSTRAINT IF EXISTS sales_settings_advance_account_fk');
  pgm.dropColumns('sales_settings', [
    'bank_iban','bank_bic','bank_account_holder','advance_payments_received_account_id',
  ]);
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN
      ('sales.payment.record','sales.reminder.create','sales.recurring.manage')
  `);
  pgm.sql(`DELETE FROM permissions WHERE key IN
    ('sales.payment.record','sales.reminder.create','sales.recurring.manage')`);
  pgm.dropTable('recurring_invoice_lines');
  pgm.dropTable('recurring_invoice_templates');
  pgm.dropTable('sales_reminders');
  pgm.dropTable('sales_invoice_payments');
  pgm.dropColumns('sales_invoices', [
    'document_type','payment_status','amount_paid','paid_at',
    'customer_po_number','customer_reference','source_recurring_template_id','source_recurring_key',
  ]);
};
