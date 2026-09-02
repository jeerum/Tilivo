exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    subtype: { type: 'text' },
    normal_balance: { type: 'text', notNull: true, default: 'DEBIT' },
    currency_code: { type: 'text' },
    is_system: { type: 'boolean', notNull: true, default: false },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('accounts', ['tenant_id', 'code'], { unique: true });
  pgm.createIndex('accounts', ['tenant_id', 'type', 'is_active']);

  pgm.createTable('fiscal_years', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    start_date: { type: 'date', notNull: true },
    end_date: { type: 'date', notNull: true },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('fiscal_years', ['tenant_id', 'name'], { unique: true });
  pgm.createIndex('fiscal_years', ['tenant_id', 'start_date', 'end_date']);

  pgm.createTable('accounting_periods', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    fiscal_year_id: { type: 'uuid', notNull: true, references: 'fiscal_years', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    start_date: { type: 'date', notNull: true },
    end_date: { type: 'date', notNull: true },
    status: { type: 'text', notNull: true, default: 'OPEN' },
    closed_at: { type: 'timestamptz' },
    closed_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reopened_at: { type: 'timestamptz' },
    reopened_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    reopen_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('accounting_periods', ['tenant_id', 'name'], { unique: true });
  pgm.createIndex('accounting_periods', ['tenant_id', 'start_date', 'end_date']);

  pgm.createTable('currencies', {
    code: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    minor_units: { type: 'integer', notNull: true, default: 2 },
    is_active: { type: 'boolean', notNull: true, default: true },
  });

  pgm.createTable('tax_codes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    country_code: { type: 'text', notNull: true, default: 'FI' },
    rate: { type: 'numeric(10,4)', notNull: true },
    type: { type: 'text', notNull: true, default: 'VAT' },
    effective_from: { type: 'date', notNull: true },
    effective_to: { type: 'date' },
    reporting_mapping: { type: 'text' },
    is_active: { type: 'boolean', notNull: true, default: true },
  });
  pgm.createIndex('tax_codes', ['tenant_id', 'code', 'effective_from']);

  pgm.createTable('fx_rates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    base_currency: { type: 'text', notNull: true, references: 'currencies' },
    quote_currency: { type: 'text', notNull: true, references: 'currencies' },
    rate: { type: 'numeric(28,8)', notNull: true },
    rate_date: { type: 'date', notNull: true },
    source: { type: 'text', notNull: true, default: 'MANUAL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('fx_rates', ['tenant_id', 'base_currency', 'quote_currency', 'rate_date', 'source'], { unique: true });

  pgm.createTable('journal_sequences', {
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    fiscal_year_id: { type: 'uuid', notNull: true, references: 'fiscal_years', onDelete: 'CASCADE' },
    next_number: { type: 'bigint', notNull: true, default: 1 },
  });
  pgm.addConstraint('journal_sequences', 'journal_sequences_pk', {
    primaryKey: ['tenant_id', 'fiscal_year_id'],
  });

  pgm.createTable('journal_entries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    entry_number: { type: 'text' },
    business_date: { type: 'date', notNull: true },
    posting_date: { type: 'date' },
    description: { type: 'text', notNull: true, default: '' },
    status: { type: 'text', notNull: true, default: 'DRAFT' },
    source_type: { type: 'text', notNull: true, default: 'MANUAL' },
    source_id: { type: 'uuid' },
    currency_code: { type: 'text', notNull: true, default: 'EUR', references: 'currencies' },
    exchange_rate: { type: 'numeric(28,8)' },
    reversal_of_entry_id: { type: 'uuid', references: 'journal_entries', onDelete: 'SET NULL' },
    reversed_by_entry_id: { type: 'uuid', references: 'journal_entries', onDelete: 'SET NULL' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    posted_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    posted_at: { type: 'timestamptz' },
  });
  pgm.createIndex('journal_entries', ['tenant_id', 'business_date']);
  pgm.createIndex('journal_entries', ['tenant_id', 'status']);
  pgm.createIndex('journal_entries', ['tenant_id', 'entry_number'], { unique: true });
  pgm.createIndex('journal_entries', ['tenant_id', 'source_type', 'source_id']);

  pgm.createTable('journal_lines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    journal_entry_id: { type: 'uuid', notNull: true, references: 'journal_entries', onDelete: 'CASCADE' },
    line_number: { type: 'integer', notNull: true },
    account_id: { type: 'uuid', notNull: true, references: 'accounts' },
    description: { type: 'text' },
    debit: { type: 'numeric(28,8)', notNull: true, default: 0 },
    credit: { type: 'numeric(28,8)', notNull: true, default: 0 },
    currency_code: { type: 'text', notNull: true, default: 'EUR' },
    foreign_debit: { type: 'numeric(28,8)' },
    foreign_credit: { type: 'numeric(28,8)' },
    tax_code_id: { type: 'uuid', references: 'tax_codes', onDelete: 'SET NULL' },
    applied_tax_rate: { type: 'numeric(10,4)' },
    tax_snapshot: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('journal_lines', ['tenant_id', 'journal_entry_id', 'line_number'], { unique: true });
  pgm.createIndex('journal_lines', ['tenant_id', 'account_id']);

  pgm.createTable('journal_reversals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    original_entry_id: { type: 'uuid', notNull: true, references: 'journal_entries', onDelete: 'CASCADE' },
    reversal_entry_id: { type: 'uuid', notNull: true, references: 'journal_entries', onDelete: 'CASCADE' },
    reason: { type: 'text', notNull: true, default: '' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('journal_reversals', 'original_entry_id', { unique: true });
  pgm.createIndex('journal_reversals', 'reversal_entry_id', { unique: true });

  const newPermissions = [
    ['accounting.read', 'Read accounting'],
    ['journal.create', 'Create journal drafts'],
    ['journal.post', 'Post journals'],
    ['journal.reverse', 'Reverse journals'],
    ['period.manage', 'Manage periods'],
    ['period.reopen', 'Reopen periods'],
    ['chart.manage', 'Manage chart of accounts'],
  ];
  for (const [key, description] of newPermissions) {
    pgm.sql(`INSERT INTO permissions (key, description) VALUES ('${key}', '${description}') ON CONFLICT (key) DO NOTHING`);
  }
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Owner','Admin') AND p.key IN
      ('accounting.read','journal.create','journal.post','journal.reverse','period.manage','period.reopen','chart.manage')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO role_permissions (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM roles r CROSS JOIN permissions p
    WHERE r.name IN ('Accountant') AND p.key IN
      ('accounting.read','journal.create','journal.post')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);

  for (const code of [
    ['EUR', 'Euro', 2],
    ['USD', 'US Dollar', 2],
    ['GBP', 'Pound Sterling', 2],
    ['SEK', 'Swedish Krona', 2],
    ['NOK', 'Norwegian Krone', 2],
    ['DKK', 'Danish Krone', 2],
  ]) {
    pgm.sql(`INSERT INTO currencies (code, name, minor_units) VALUES ('${code[0]}','${code[1]}',${code[2]}) ON CONFLICT (code) DO NOTHING`);
  }

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_journal_entries_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.status IN ('POSTED','REVERSED') THEN
        RAISE EXCEPTION 'posted journal is immutable';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
           AND OLD.reversed_by_entry_id IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.status IN ('POSTED','REVERSED') THEN
          RAISE EXCEPTION 'posted journal is immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_journal_entries_immutable
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_entries_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_journal_lines_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE entry_status text;
    BEGIN
      SELECT status INTO entry_status FROM journal_entries WHERE id = OLD.journal_entry_id;
      IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND entry_status IN ('POSTED','REVERSED')) THEN
        RAISE EXCEPTION 'posted journal lines are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_journal_lines_immutable
    BEFORE UPDATE OR DELETE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_lines_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_journal_post_balanced()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE total_debit numeric(28,8);
            total_credit numeric(28,8);
            line_count integer;
    BEGIN
      IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;
      SELECT count(*), COALESCE(sum(debit),0), COALESCE(sum(credit),0)
        INTO line_count, total_debit, total_credit
        FROM journal_lines WHERE journal_entry_id = NEW.id;
      IF line_count < 2 THEN RAISE EXCEPTION 'journal needs at least two lines'; END IF;
      IF total_debit <> total_credit THEN RAISE EXCEPTION 'journal is not balanced'; END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER tilivo_journal_post_balanced
    AFTER UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_post_balanced()
  `);

  for (const table of ['accounts','fiscal_years','accounting_periods','tax_codes','fx_rates','journal_entries','journal_lines','journal_reversals']) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    pgm.sql(`CREATE POLICY tenant_all ON ${table}
      USING (tenant_id = public.tilivo_tenant_id())
      WITH CHECK (tenant_id = public.tilivo_tenant_id())`);
    pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO tilivo_runtime`);
  }
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON journal_sequences TO tilivo_runtime');
  pgm.sql('GRANT SELECT ON currencies TO tilivo_runtime');
};

exports.down = (pgm) => {
  pgm.dropTable('journal_reversals');
  pgm.dropTable('journal_lines');
  pgm.dropTable('journal_entries');
  pgm.dropTable('journal_sequences');
  pgm.dropTable('fx_rates');
  pgm.dropTable('tax_codes');
  pgm.dropTable('accounting_periods');
  pgm.dropTable('fiscal_years');
  pgm.dropTable('accounts');
};
