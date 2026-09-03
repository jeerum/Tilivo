exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---------------------------------------------------------------------------
  // Sales settings: delivery default, reminder fee and late-interest defaults.
  // Bank detail columns already exist from the first v0.12 migration.
  // ---------------------------------------------------------------------------
  pgm.addColumns('sales_settings', {
    default_delivery_method: { type: 'text', notNull: true, default: 'EMAIL' },
    reminder_fee_enabled: { type: 'boolean', notNull: true, default: false },
    reminder_fee_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    late_interest_enabled: { type: 'boolean', notNull: true, default: false },
    late_interest_rate: { type: 'numeric(10,6)', notNull: true, default: 0 },
    late_interest_grace_days: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql(`
    ALTER TABLE sales_settings
      ADD CONSTRAINT sales_settings_delivery_method_check
      CHECK (default_delivery_method IN ('EMAIL','E_INVOICE','PDF_MANUAL','OTHER')),
      ADD CONSTRAINT sales_settings_late_interest_rate_check
      CHECK (late_interest_rate >= 0 AND late_interest_rate <= 100),
      ADD CONSTRAINT sales_settings_reminder_fee_amount_check
      CHECK (reminder_fee_amount >= 0),
      ADD CONSTRAINT sales_settings_grace_days_check
      CHECK (late_interest_grace_days >= 0 AND late_interest_grace_days <= 3650)
  `);

  // ---------------------------------------------------------------------------
  // Customers: delivery method, OVT address and reminder/late-interest overrides.
  // ---------------------------------------------------------------------------
  pgm.addColumns('business_parties', {
    delivery_method: { type: 'text', notNull: true, default: 'EMAIL' },
    e_invoice_ovt: { type: 'text' },
    reminder_fee_amount: { type: 'numeric(28,8)' },
    late_interest_enabled: { type: 'boolean', notNull: true, default: false },
    late_interest_rate: { type: 'numeric(10,6)', notNull: true, default: 0 },
    late_interest_grace_days: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.sql(`
    ALTER TABLE business_parties
      ADD CONSTRAINT business_parties_delivery_method_check
      CHECK (delivery_method IN ('EMAIL','E_INVOICE','PDF_MANUAL','OTHER')),
      ADD CONSTRAINT business_parties_late_interest_rate_check
      CHECK (late_interest_rate >= 0 AND late_interest_rate <= 100),
      ADD CONSTRAINT business_parties_grace_days_check
      CHECK (late_interest_grace_days >= 0 AND late_interest_grace_days <= 3650),
      ADD CONSTRAINT business_parties_reminder_fee_amount_check
      CHECK (reminder_fee_amount IS NULL OR reminder_fee_amount >= 0)
  `);

  // ---------------------------------------------------------------------------
  // Sales invoices: invoice-level discount, credited amount, advance applied,
  // delivery preferences, reminder policy snapshot and language freeze.
  // ---------------------------------------------------------------------------
  pgm.addColumns('sales_invoices', {
    discount_percent: { type: 'numeric(5,2)', notNull: true, default: 0 },
    discount_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    credited_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    advance_applied: { type: 'numeric(28,8)', notNull: true, default: 0 },
    delivery_method: { type: 'text', notNull: true, default: 'EMAIL' },
    delivery_status: { type: 'text', notNull: true, default: 'NOT_SENT' },
    late_interest_enabled: { type: 'boolean', notNull: true, default: false },
    late_interest_rate: { type: 'numeric(10,6)', notNull: true, default: 0 },
    late_interest_grace_days: { type: 'integer', notNull: true, default: 0 },
    reminder_fee_enabled: { type: 'boolean', notNull: true, default: false },
    reminder_fee_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
  });
  pgm.sql(`
    ALTER TABLE sales_invoices
      ADD CONSTRAINT sales_invoices_discount_check
      CHECK (discount_percent >= 0 AND discount_percent <= 100
             AND discount_amount >= 0),
      ADD CONSTRAINT sales_invoices_credited_amount_check
      CHECK (credited_amount >= 0 AND credited_amount <= total),
      ADD CONSTRAINT sales_invoices_advance_applied_check
      CHECK (advance_applied >= 0 AND advance_applied <= total),
      ADD CONSTRAINT sales_invoices_delivery_method_check
      CHECK (delivery_method IN ('EMAIL','E_INVOICE','PDF_MANUAL','OTHER')),
      ADD CONSTRAINT sales_invoices_delivery_status_check
      CHECK (delivery_status IN ('NOT_SENT','SENT','FAILED','EINVOICE_READY','PDF_ONLY')),
      ADD CONSTRAINT sales_invoices_late_interest_rate_check
      CHECK (late_interest_rate >= 0 AND late_interest_rate <= 100),
      ADD CONSTRAINT sales_invoices_grace_days_check
      CHECK (late_interest_grace_days >= 0 AND late_interest_grace_days <= 3650),
      ADD CONSTRAINT sales_invoices_reminder_fee_amount_check
      CHECK (reminder_fee_amount >= 0)
  `);
  pgm.sql(`
    ALTER TABLE sales_invoices
      ADD CONSTRAINT sales_invoices_language_check
      CHECK (language IN ('fi','en','et'))
  `);

  // ---------------------------------------------------------------------------
  // Partial credit notes: an original invoice may have many credit links.
  // ---------------------------------------------------------------------------
  pgm.sql('DROP INDEX IF EXISTS sales_invoice_credit_links_original_invoice_id_unique_index');
  pgm.createIndex('sales_invoice_credit_links', ['original_invoice_id', 'credit_invoice_id'], { unique: true, name: 'sales_invoice_credit_links_original_credit_unique' });
  pgm.sql('DROP INDEX IF EXISTS sales_invoices_credit_of_unique');
  pgm.sql(`
    CREATE INDEX sales_invoices_credit_of_idx
    ON sales_invoices (tenant_id, credit_of_invoice_id)
    WHERE credit_of_invoice_id IS NOT NULL
  `);

  // ---------------------------------------------------------------------------
  // Advance invoice applications (many advances -> one final invoice, and an
  // advance may be split over several final invoices).
  // ---------------------------------------------------------------------------
  pgm.createTable('sales_invoice_advance_applications', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    final_invoice_id: { type: 'uuid', notNull: true },
    advance_invoice_id: { type: 'uuid', notNull: true },
    applied_amount: { type: 'numeric(28,8)', notNull: true },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE sales_invoice_advance_applications
      ADD CONSTRAINT advance_applications_final_fk
      FOREIGN KEY (tenant_id, final_invoice_id) REFERENCES sales_invoices(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT advance_applications_advance_fk
      FOREIGN KEY (tenant_id, advance_invoice_id) REFERENCES sales_invoices(tenant_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT advance_applications_amount_check CHECK (applied_amount > 0)
  `);
  pgm.createIndex('sales_invoice_advance_applications', ['tenant_id', 'advance_invoice_id', 'final_invoice_id'], { unique: true, name: 'sales_invoice_advance_applications_pair_unique' });
  pgm.createIndex('sales_invoice_advance_applications', ['tenant_id', 'final_invoice_id']);

  // ---------------------------------------------------------------------------
  // Reminder policy snapshot columns on reminders and PDF/attachment state.
  // ---------------------------------------------------------------------------
  pgm.addColumns('sales_reminders', {
    reminder_number: { type: 'text' },
    fee_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    interest_amount: { type: 'numeric(28,8)', notNull: true, default: 0 },
    interest_rate: { type: 'numeric(10,6)', notNull: true, default: 0 },
    interest_days: { type: 'integer', notNull: true, default: 0 },
    language: { type: 'text', notNull: true, default: 'fi' },
    pdf_status: { type: 'text', notNull: true, default: 'NONE' },
    pdf_document_id: { type: 'uuid' },
    sent_via: { type: 'text' },
    last_error: { type: 'text' },
  });
  pgm.sql(`
    ALTER TABLE sales_reminders
      ADD CONSTRAINT sales_reminders_status_check
      CHECK (status IN ('DRAFT','SENT','FAILED')),
      ADD CONSTRAINT sales_reminders_fee_amount_check CHECK (fee_amount >= 0),
      ADD CONSTRAINT sales_reminders_interest_amount_check CHECK (interest_amount >= 0),
      ADD CONSTRAINT sales_reminders_pdf_status_check
      CHECK (pdf_status IN ('NONE','GENERATING','READY','FAILED')),
      ADD CONSTRAINT sales_reminders_language_check
      CHECK (language IN ('fi','en','et'))
  `);
  pgm.sql(`
    ALTER TABLE sales_reminders
      ADD CONSTRAINT sales_reminders_pdf_document_fk
      FOREIGN KEY (tenant_id, pdf_document_id)
      REFERENCES documents(tenant_id, id) ON DELETE SET NULL
  `);
  pgm.createIndex('sales_reminders', ['tenant_id', 'status', 'created_at']);

  // ---------------------------------------------------------------------------
  // Delivery/send history (invoice e-mail, e-invoice export, reminder send).
  // ---------------------------------------------------------------------------
  pgm.createTable('document_send_history', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    document_type: { type: 'text', notNull: true },
    document_id: { type: 'uuid', notNull: true },
    channel: { type: 'text', notNull: true },
    recipient: { type: 'text' },
    subject: { type: 'text' },
    provider: { type: 'text', notNull: true, default: 'manual' },
    status: { type: 'text', notNull: true },
    error: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    ALTER TABLE document_send_history
      ADD CONSTRAINT document_send_history_channel_check
      CHECK (channel IN ('EMAIL','E_INVOICE','MANUAL_PDF')),
      ADD CONSTRAINT document_send_history_status_check
      CHECK (status IN ('QUEUED','SENT','FAILED'))
  `);
  pgm.createIndex('document_send_history', ['tenant_id', 'document_type', 'document_id']);
  pgm.createIndex('document_send_history', ['tenant_id', 'status', 'created_at']);

  // Dev e-mail provider needs attachment support for PDFs.
  pgm.addColumns('dev_email_outbox', {
    attachment_name: { type: 'text' },
    attachment_content_type: { type: 'text' },
    attachment_base64: { type: 'text' },
  });

  // ---------------------------------------------------------------------------
  // Permissions for sending documents and exporting e-invoices.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO permissions (key, description) VALUES
      ('sales.invoice.send', 'Send sales documents and reminders'),
      ('sales.einvoice.export', 'Export/ready e-invoice payloads')
    ON CONFLICT (key) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner','Admin','Accountant')
      AND p.key IN ('sales.invoice.send','sales.einvoice.export')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);

  // ---------------------------------------------------------------------------
  // RLS for the new tenant tables.
  // ---------------------------------------------------------------------------
  for (const table of ['sales_invoice_advance_applications', 'document_send_history']) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
    pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ${table} TO tilivo_runtime`);
  }

  // Runtime may read reminder pdf metadata for downloads; worker renders them.
  pgm.sql('GRANT SELECT, UPDATE ON sales_reminders TO tilivo_runtime');
  pgm.sql('GRANT SELECT ON sales_reminders TO tilivo_worker');

  // ---------------------------------------------------------------------------
  // Immutability upgrades: partial credits and payment/credit field updates.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_sales_invoices_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v_linked bigint;
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

      -- Manual payment records, credits and send state may update only the
      -- mutable bookkeeping fields on issued documents.
      IF OLD.status IN ('ISSUED','PARTIALLY_PAID') AND NEW.status = OLD.status THEN
        IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
           OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
           OR NEW.due_date IS DISTINCT FROM OLD.due_date
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
           OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
           OR NEW.total IS DISTINCT FROM OLD.total
           OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot
           OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
           OR NEW.document_type IS DISTINCT FROM OLD.document_type
           OR NEW.language IS DISTINCT FROM OLD.language
           OR NEW.discount_percent IS DISTINCT FROM OLD.discount_percent
           OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
           OR NEW.advance_applied IS DISTINCT FROM OLD.advance_applied
           OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
           OR NEW.late_interest_enabled IS DISTINCT FROM OLD.late_interest_enabled
           OR NEW.late_interest_rate IS DISTINCT FROM OLD.late_interest_rate
           OR NEW.late_interest_grace_days IS DISTINCT FROM OLD.late_interest_grace_days
           OR NEW.reminder_fee_enabled IS DISTINCT FROM OLD.reminder_fee_enabled
           OR NEW.reminder_fee_amount IS DISTINCT FROM OLD.reminder_fee_amount THEN
          RAISE EXCEPTION 'issued sales invoice is immutable';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'ISSUED' AND NEW.status = 'CREDITED' THEN
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
           OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
           OR NEW.document_type IS DISTINCT FROM OLD.document_type THEN
          RAISE EXCEPTION 'credit may not alter issued invoice data';
        END IF;
        IF abs(NEW.credited_amount - (NEW.total - NEW.advance_applied)) > 0.01 THEN
          RAISE EXCEPTION 'invoice can be marked credited only when fully credited';
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
    CREATE OR REPLACE FUNCTION public.tilivo_sales_credit_link_validate()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      v_original_status text;
      v_original_total numeric(28,8);
      v_original_advance numeric(28,8);
      v_original_currency text;
      v_original_customer uuid;
      v_credit_status text;
      v_credit_total numeric(28,8);
      v_credit_currency text;
      v_credit_customer uuid;
      v_credited numeric(28,8);
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'credit links are immutable';
      END IF;
      SELECT status, total, COALESCE(advance_applied, 0), currency_code, customer_id
        INTO v_original_status, v_original_total, v_original_advance, v_original_currency, v_original_customer
        FROM sales_invoices WHERE id = NEW.original_invoice_id;
      SELECT status, total, currency_code, customer_id
        INTO v_credit_status, v_credit_total, v_credit_currency, v_credit_customer
        FROM sales_invoices WHERE id = NEW.credit_invoice_id;
      IF v_original_status IS NULL OR v_credit_status IS NULL THEN
        RAISE EXCEPTION 'credit link references missing invoices';
      END IF;
      IF v_original_status NOT IN ('ISSUED','PARTIALLY_PAID') THEN
        RAISE EXCEPTION 'only issued invoices can be credited';
      END IF;
      IF v_credit_status <> 'ISSUED' THEN
        RAISE EXCEPTION 'credit invoice must be issued';
      END IF;
      IF v_original_currency IS DISTINCT FROM v_credit_currency
         OR v_original_customer IS DISTINCT FROM v_credit_customer THEN
        RAISE EXCEPTION 'credit invoice must match customer and currency';
      END IF;
      SELECT COALESCE(sum(c.total), 0) INTO v_credited
        FROM sales_invoice_credit_links l
        JOIN sales_invoices c ON c.id = l.credit_invoice_id AND c.tenant_id = l.tenant_id
        WHERE l.original_invoice_id = NEW.original_invoice_id
          AND l.credit_invoice_id IS DISTINCT FROM NEW.credit_invoice_id;
      IF v_credit_total > v_original_total - v_original_advance - v_credited + 0.001 THEN
        RAISE EXCEPTION 'credit exceeds remaining creditable amount';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  // Worker can read and update reminder PDF state.
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON sales_invoice_pdfs TO tilivo_runtime');
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON sales_reminders TO tilivo_worker');
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_sales_invoices_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE v_linked bigint;
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
      IF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED_DRAFT' THEN RETURN NEW; END IF;
      IF OLD.status = 'DRAFT' AND NEW.status = 'ISSUED' THEN
        IF NEW.invoice_number IS NULL OR NEW.issued_by IS NULL OR NEW.issued_at IS NULL
           OR NEW.accounting_journal_entry_id IS NULL
           OR NEW.customer_snapshot = '{}'::jsonb
           OR (NEW.payment_reference IS NULL AND NEW.reference_type <> 'NONE') THEN
          RAISE EXCEPTION 'issued invoice requires number, reference, snapshot and journal link';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status IN ('ISSUED','PARTIALLY_PAID') AND NEW.status = OLD.status THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'ISSUED' AND NEW.status = 'CREDITED' THEN
        IF NEW.credited_by_invoice_id IS NULL THEN RAISE EXCEPTION 'credit requires credit invoice linkage'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'issued sales invoice is immutable';
    END;
    $$;
  `);
  pgm.sql('DROP INDEX IF EXISTS sales_invoice_credit_links_original_credit_unique');
  pgm.createIndex('sales_invoice_credit_links', ['original_invoice_id'], { unique: true });
  pgm.dropTable('document_send_history');
  pgm.dropTable('sales_invoice_advance_applications');
  pgm.sql(`
    DELETE FROM role_permissions rp USING permissions p
    WHERE rp.permission_id = p.id AND p.key IN ('sales.invoice.send','sales.einvoice.export')
  `);
  pgm.sql(`DELETE FROM permissions WHERE key IN ('sales.invoice.send','sales.einvoice.export')`);
  pgm.dropColumns('sales_reminders', [
    'reminder_number','fee_amount','interest_amount','interest_rate','interest_days',
    'language','pdf_status','pdf_document_id','sent_via','last_error',
  ]);
  pgm.dropColumns('sales_invoices', [
    'discount_percent','discount_amount','credited_amount','advance_applied',
    'delivery_method','delivery_status','late_interest_enabled','late_interest_rate',
    'late_interest_grace_days','reminder_fee_enabled','reminder_fee_amount',
  ]);
  pgm.dropColumns('business_parties', [
    'delivery_method','e_invoice_ovt','reminder_fee_amount',
    'late_interest_enabled','late_interest_rate','late_interest_grace_days',
  ]);
  pgm.dropColumns('sales_settings', [
    'default_delivery_method','reminder_fee_enabled','reminder_fee_amount',
    'late_interest_enabled','late_interest_rate','late_interest_grace_days',
  ]);
  pgm.dropColumns('dev_email_outbox', ['attachment_name','attachment_content_type','attachment_base64']);
};
