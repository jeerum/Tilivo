exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---------------------------------------------------------------------------
  // Tenant banking mapping defaults on purchase invoices (paid-amount state).
  // ---------------------------------------------------------------------------
  pgm.addColumns('purchase_invoices', {
    amount_paid: { type: 'numeric(28,8)', notNull: true, default: 0 },
  });
  pgm.sql(`
    ALTER TABLE purchase_invoices
      ADD CONSTRAINT purchase_invoices_amount_paid_check
      CHECK (amount_paid >= 0 AND amount_paid <= total)
  `);

  // ---------------------------------------------------------------------------
  // Bank accounts.
  // ---------------------------------------------------------------------------
  pgm.createTable('bank_accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    iban: { type: 'text', notNull: true },
    bic: { type: 'text' },
    currency: { type: 'text', notNull: true, default: 'EUR', references: 'currencies' },
    bank_name: { type: 'text' },
    ledger_account_id: { type: 'uuid', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    is_default: { type: 'boolean', notNull: true, default: false },
    external_provider: { type: 'text' },
    external_account_id: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE bank_accounts
      ADD CONSTRAINT bank_accounts_ledger_fk
      FOREIGN KEY (tenant_id, ledger_account_id) REFERENCES accounts(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT bank_accounts_iban_upper_check
      CHECK (iban = upper(iban) AND iban NOT LIKE '% %')
  `);
  pgm.createIndex('bank_accounts', ['tenant_id', 'iban'], { unique: true });
  pgm.sql(`CREATE UNIQUE INDEX bank_accounts_default_unique
    ON bank_accounts (tenant_id) WHERE is_default`);
  pgm.createIndex('bank_accounts', ['tenant_id', 'is_active']);
  pgm.sql(`CREATE UNIQUE INDEX bank_accounts_tenant_id_id_unique
    ON bank_accounts (tenant_id, id)`);

  // ---------------------------------------------------------------------------
  // Import batches.
  // ---------------------------------------------------------------------------
  pgm.createTable('bank_import_batches', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    bank_account_id: { type: 'uuid', notNull: true },
    filename: { type: 'text', notNull: true },
    file_hash_sha256: { type: 'text', notNull: true },
    parser_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'IMPORTED' },
    statement_from: { type: 'date' },
    statement_to: { type: 'date' },
    opening_balance: { type: 'numeric(28,8)' },
    closing_balance: { type: 'numeric(28,8)' },
    row_count: { type: 'integer', notNull: true, default: 0 },
    imported_count: { type: 'integer', notNull: true, default: 0 },
    duplicate_count: { type: 'integer', notNull: true, default: 0 },
    error_count: { type: 'integer', notNull: true, default: 0 },
    warnings: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    imported_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE bank_import_batches
      ADD CONSTRAINT bank_import_batches_account_fk
      FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT bank_import_batches_parser_check
      CHECK (parser_type IN ('GENERIC_CSV','CAMT053')),
      ADD CONSTRAINT bank_import_batches_status_check
      CHECK (status IN ('PREVIEW','IMPORTED','FAILED'))
  `);
  pgm.createIndex('bank_import_batches', ['tenant_id', 'file_hash_sha256'], { unique: true });
  pgm.createIndex('bank_import_batches', ['tenant_id', 'bank_account_id', 'imported_at']);
  pgm.sql(`CREATE UNIQUE INDEX bank_import_batches_tenant_id_id_unique
    ON bank_import_batches (tenant_id, id)`);

  // ---------------------------------------------------------------------------
  // Normalized bank transactions (immutable imported evidence).
  // ---------------------------------------------------------------------------
  pgm.createTable('bank_transactions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    bank_account_id: { type: 'uuid', notNull: true },
    import_batch_id: { type: 'uuid', notNull: true },
    external_transaction_id: { type: 'text' },
    booking_date: { type: 'date', notNull: true },
    value_date: { type: 'date' },
    amount: { type: 'numeric(28,8)', notNull: true },
    currency: { type: 'text', notNull: true, default: 'EUR' },
    direction: { type: 'text', notNull: true },
    counterparty_name: { type: 'text' },
    counterparty_iban: { type: 'text' },
    reference: { type: 'text' },
    message: { type: 'text' },
    bank_archive_id: { type: 'text' },
    source_type: { type: 'text', notNull: true, default: 'FILE_IMPORT' },
    source_fingerprint: { type: 'text', notNull: true },
    reconciliation_status: { type: 'text', notNull: true, default: 'UNMATCHED' },
    accounting_date: { type: 'date', notNull: true },
    raw_metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE bank_transactions
      ADD CONSTRAINT bank_transactions_account_fk
      FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT bank_transactions_import_fk
      FOREIGN KEY (tenant_id, import_batch_id) REFERENCES bank_import_batches(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT bank_transactions_direction_check
      CHECK (direction IN ('IN','OUT')),
      ADD CONSTRAINT bank_transactions_amount_check
      CHECK (amount > 0),
      ADD CONSTRAINT bank_transactions_status_check
      CHECK (reconciliation_status IN
        ('UNMATCHED','SUGGESTED','PARTIALLY_MATCHED','MATCHED','POSTED','REVIEWED_NO_POST'))
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX bank_transactions_external_unique
    ON bank_transactions (tenant_id, bank_account_id, external_transaction_id)
    WHERE external_transaction_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX bank_transactions_fingerprint_unique
    ON bank_transactions (tenant_id, source_fingerprint)
    WHERE external_transaction_id IS NULL
  `);
  pgm.createIndex('bank_transactions', ['tenant_id', 'bank_account_id', 'booking_date']);
  pgm.createIndex('bank_transactions', ['tenant_id', 'reconciliation_status', 'booking_date']);
  pgm.createIndex('bank_transactions', ['tenant_id', 'import_batch_id']);
  pgm.sql(`CREATE UNIQUE INDEX bank_transactions_tenant_id_id_unique
    ON bank_transactions (tenant_id, id)`);

  // ---------------------------------------------------------------------------
  // Allocations (one transaction may split across several targets).
  // ---------------------------------------------------------------------------
  pgm.createTable('bank_transaction_allocations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    bank_transaction_id: { type: 'uuid', notNull: true },
    allocation_type: { type: 'text', notNull: true },
    target_id: { type: 'uuid' },
    account_id: { type: 'uuid' },
    amount: { type: 'numeric(28,8)', notNull: true },
    tax_code_id: { type: 'uuid' },
    project_code: { type: 'text' },
    cost_center: { type: 'text' },
    description: { type: 'text' },
    posted_journal_entry_id: { type: 'uuid' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE bank_transaction_allocations
      ADD CONSTRAINT bank_allocations_transaction_fk
      FOREIGN KEY (tenant_id, bank_transaction_id) REFERENCES bank_transactions(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT bank_allocations_account_fk
      FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT bank_allocations_journal_fk
      FOREIGN KEY (tenant_id, posted_journal_entry_id) REFERENCES journal_entries(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT bank_allocations_type_check
      CHECK (allocation_type IN
        ('SALES_INVOICE','PURCHASE_INVOICE','BANK_FEE','INTEREST_INCOME','INTEREST_EXPENSE',
         'EXPENSE','TRANSFER','CARD_CLEARING','CUSTOMER_CREDIT','SUPPLIER_PREPAYMENT','OTHER')),
      ADD CONSTRAINT bank_allocations_amount_check
      CHECK (amount > 0)
  `);
  pgm.createIndex('bank_transaction_allocations', ['tenant_id', 'bank_transaction_id']);
  pgm.createIndex('bank_transaction_allocations', ['tenant_id', 'allocation_type', 'target_id']);
  pgm.sql(`CREATE UNIQUE INDEX bank_allocations_journal_unique
    ON bank_transaction_allocations (tenant_id, posted_journal_entry_id)
    WHERE posted_journal_entry_id IS NOT NULL`);

  // ---------------------------------------------------------------------------
  // Purchase payments (granular AP records alongside sales payments).
  // ---------------------------------------------------------------------------
  pgm.addColumns('sales_invoice_payments', {
    source: { type: 'text', notNull: true, default: 'MANUAL' },
    bank_transaction_id: { type: 'uuid' },
  });
  pgm.sql(`
    ALTER TABLE sales_invoice_payments
      ADD CONSTRAINT sales_payments_source_check
      CHECK (source IN ('MANUAL','BANK_IMPORT','OPEN_BANKING')),
      ADD CONSTRAINT sales_payments_bank_tx_fk
      FOREIGN KEY (tenant_id, bank_transaction_id) REFERENCES bank_transactions(tenant_id, id) ON DELETE SET NULL
  `);
  pgm.sql(`CREATE UNIQUE INDEX sales_payments_bank_tx_unique
    ON sales_invoice_payments (tenant_id, bank_transaction_id, invoice_id)
    WHERE bank_transaction_id IS NOT NULL`);
  pgm.createTable('purchase_invoice_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    purchase_invoice_id: { type: 'uuid', notNull: true },
    bank_transaction_id: { type: 'uuid' },
    payment_date: { type: 'date', notNull: true },
    amount: { type: 'numeric(28,8)', notNull: true },
    source: { type: 'text', notNull: true, default: 'MANUAL' },
    reference: { type: 'text' },
    note: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE purchase_invoice_payments
      ADD CONSTRAINT purchase_payments_invoice_fk
      FOREIGN KEY (tenant_id, purchase_invoice_id) REFERENCES purchase_invoices(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT purchase_payments_bank_tx_fk
      FOREIGN KEY (tenant_id, bank_transaction_id) REFERENCES bank_transactions(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT purchase_payments_amount_check CHECK (amount > 0),
      ADD CONSTRAINT purchase_payments_source_check
      CHECK (source IN ('MANUAL','BANK_IMPORT','OPEN_BANKING'))
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX purchase_payments_bank_tx_unique
    ON purchase_invoice_payments (tenant_id, bank_transaction_id, purchase_invoice_id)
    WHERE bank_transaction_id IS NOT NULL
  `);
  pgm.createIndex('purchase_invoice_payments', ['tenant_id', 'purchase_invoice_id', 'payment_date']);

  // ---------------------------------------------------------------------------
  // Banking permission set.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO permissions (key, description) VALUES
      ('banking.read', 'Read banking data'),
      ('banking.import', 'Import bank statements'),
      ('banking.match', 'Match and allocate bank transactions'),
      ('banking.post', 'Post bank-originated accounting'),
      ('banking.accounts.manage', 'Manage bank accounts')
    ON CONFLICT (key) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner','Admin','Accountant')
      AND p.key IN ('banking.read','banking.import','banking.match','banking.post','banking.accounts.manage')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);

  // ---------------------------------------------------------------------------
  // RLS + grants.
  // ---------------------------------------------------------------------------
  const tenantTables = [
    'bank_accounts',
    'bank_import_batches',
    'bank_transactions',
    'bank_transaction_allocations',
    'purchase_invoice_payments',
  ];
  for (const table of tenantTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO tilivo_runtime`);
  }

  // Tenant-wide banking classification mappings.
  pgm.createTable('banking_settings', {
    tenant_id: { type: 'uuid', primaryKey: true, references: 'tenants', onDelete: 'CASCADE' },
    bank_fee_expense_account_id: { type: 'uuid' },
    interest_income_account_id: { type: 'uuid' },
    interest_expense_account_id: { type: 'uuid' },
    card_clearing_account_id: { type: 'uuid' },
    transfer_clearing_account_id: { type: 'uuid' },
    customer_unallocated_account_id: { type: 'uuid' },
    supplier_unallocated_account_id: { type: 'uuid' },
  });
  pgm.sql(`
    ALTER TABLE banking_settings
      ADD CONSTRAINT banking_settings_bank_fee_fk
      FOREIGN KEY (tenant_id, bank_fee_expense_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT banking_settings_interest_income_fk
      FOREIGN KEY (tenant_id, interest_income_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT banking_settings_interest_expense_fk
      FOREIGN KEY (tenant_id, interest_expense_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT banking_settings_card_clearing_fk
      FOREIGN KEY (tenant_id, card_clearing_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT banking_settings_transfer_clearing_fk
      FOREIGN KEY (tenant_id, transfer_clearing_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT banking_settings_customer_unallocated_fk
      FOREIGN KEY (tenant_id, customer_unallocated_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT banking_settings_supplier_unallocated_fk
      FOREIGN KEY (tenant_id, supplier_unallocated_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL
  `);
  pgm.sql(`ALTER TABLE banking_settings ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE banking_settings FORCE ROW LEVEL SECURITY`);
  pgm.sql(`CREATE POLICY tenant_all ON banking_settings
    USING (tenant_id = public.tilivo_tenant_id())
    WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON banking_settings TO tilivo_runtime`);
};

exports.down = (pgm) => {
  for (const table of [
    'purchase_invoice_payments',
    'bank_transaction_allocations',
    'bank_transactions',
    'bank_import_batches',
    'bank_accounts',
  ]) {
    pgm.dropTable(table);
  }
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key LIKE 'banking.%'
  `);
  pgm.sql(`DELETE FROM permissions WHERE key LIKE 'banking.%'`);
  pgm.dropColumns('purchase_invoices', ['amount_paid']);
};
