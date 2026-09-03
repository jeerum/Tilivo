exports.shorthands = undefined;

exports.up = (pgm) => {
  // Unified purchase-document fields: receipts share the purchase lifecycle,
  // accounting core and VAT engine; they are not a separate subsystem.
  pgm.addColumns('purchase_invoices', {
    document_type: { type: 'text', notNull: true, default: 'PURCHASE_INVOICE' },
    payment_method: { type: 'text', notNull: true, default: 'BANK_TRANSFER' },
    payment_status: { type: 'text', notNull: true, default: 'UNPAID' },
    merchant_name: { type: 'text' },
    description: { type: 'text' },
    ocr_status: { type: 'text', notNull: true, default: 'NOT_REQUESTED' },
    ocr_provider: { type: 'text' },
    ocr_error: { type: 'text' },
    duplicate_warning: { type: 'text' },
  });

  pgm.addConstraint('purchase_invoices', 'purchase_invoices_document_type_check', {
    check: "document_type IN ('PURCHASE_INVOICE','RECEIPT','CREDIT_NOTE','CASH_EXPENSE','CARD_EXPENSE')",
  });
  pgm.addConstraint('purchase_invoices', 'purchase_invoices_payment_method_check', {
    check: "payment_method IN ('BANK_TRANSFER','COMPANY_CARD','CASH','PERSONAL_CARD','EMPLOYEE_PAID','OTHER')",
  });
  pgm.addConstraint('purchase_invoices', 'purchase_invoices_payment_status_check', {
    check: "payment_status IN ('UNPAID','PAID','PARTIALLY_PAID','PAID_AT_PURCHASE')",
  });
  pgm.addConstraint('purchase_invoices', 'purchase_invoices_ocr_status_check', {
    check: "ocr_status IN ('NOT_REQUESTED','QUEUED','PROCESSING','COMPLETE','FAILED')",
  });

  pgm.createIndex('purchase_invoices', ['tenant_id', 'document_type', 'status', 'invoice_date']);
  pgm.createIndex('purchase_invoices', ['tenant_id', 'payment_method', 'payment_status']);
  pgm.createIndex('purchase_invoices', ['tenant_id', 'ocr_status']);

  // Payment counter-accounts. Receipts paid at purchase must not credit AP.
  pgm.addColumns('purchase_settings', {
    cash_account_id: { type: 'uuid' },
    company_card_account_id: { type: 'uuid' },
    employee_payable_account_id: { type: 'uuid' },
  });
  pgm.sql(`
    ALTER TABLE purchase_settings
      ADD CONSTRAINT purchase_settings_cash_fk
      FOREIGN KEY (tenant_id, cash_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT purchase_settings_card_fk
      FOREIGN KEY (tenant_id, company_card_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL,
      ADD CONSTRAINT purchase_settings_employee_fk
      FOREIGN KEY (tenant_id, employee_payable_account_id) REFERENCES accounts(tenant_id, id) ON DELETE SET NULL
  `);

  // Employees may capture receipts without full accounting permissions.
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name = 'Employee' AND p.key IN ('purchase.create', 'purchase.document.upload')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN ('purchase.create','purchase.document.upload')
      AND rp.role_id IN (SELECT id FROM roles WHERE name = 'Employee')
  `);
  pgm.sql('ALTER TABLE purchase_settings DROP CONSTRAINT IF EXISTS purchase_settings_employee_fk');
  pgm.sql('ALTER TABLE purchase_settings DROP CONSTRAINT IF EXISTS purchase_settings_card_fk');
  pgm.sql('ALTER TABLE purchase_settings DROP CONSTRAINT IF EXISTS purchase_settings_cash_fk');
  pgm.dropColumns('purchase_settings', ['cash_account_id', 'company_card_account_id', 'employee_payable_account_id']);
  pgm.dropConstraint('purchase_invoices', 'purchase_invoices_ocr_status_check');
  pgm.dropConstraint('purchase_invoices', 'purchase_invoices_payment_status_check');
  pgm.dropConstraint('purchase_invoices', 'purchase_invoices_payment_method_check');
  pgm.dropConstraint('purchase_invoices', 'purchase_invoices_document_type_check');
  pgm.dropColumns('purchase_invoices', [
    'document_type',
    'payment_method',
    'payment_status',
    'merchant_name',
    'description',
    'ocr_status',
    'ocr_provider',
    'ocr_error',
    'duplicate_warning',
  ]);
};
