exports.shorthands = undefined;

exports.up = (pgm) => {
  // Document date on the journal header (source documents keep their own
  // dates; manual entries may record the original document date).
  pgm.addColumns('journal_entries', {
    document_date: { type: 'date' },
  });

  // Minimal dimension readiness on journal lines. No projects module exists
  // yet, so these are free-form identifiers/codes that later modules can
  // promote to real FK relations without a schema-breaking redesign.
  pgm.addColumns('journal_lines', {
    cost_center: { type: 'text' },
    project_code: { type: 'text' },
  });

  // Amount sanity at the DB layer. Debit/credit must never be negative and a
  // single line may only use one side (both zero is allowed for incomplete
  // drafts; posting validation rejects zero lines).
  pgm.sql(`
    ALTER TABLE journal_lines
      ADD CONSTRAINT journal_lines_amounts_nonnegative
      CHECK (debit >= 0 AND credit >= 0),
      ADD CONSTRAINT journal_lines_debit_credit_exclusive
      CHECK (debit = 0 OR credit = 0)
  `);

  // One posted opening-balance entry per tenant per business date. A reversed
  // opening entry stops blocking because the index is partial on POSTED.
  pgm.sql(`
    CREATE UNIQUE INDEX journal_entries_opening_balance_date_unique
    ON journal_entries (tenant_id, business_date)
    WHERE source_type = 'OPENING_BALANCE' AND status = 'POSTED'
  `);

  pgm.createIndex('journal_lines', ['tenant_id', 'cost_center']);
  pgm.createIndex('journal_lines', ['tenant_id', 'project_code']);

  // Reversal mirrors now include dimension fields, keeping DB-enforced mirror
  // validation consistent with service-created reversals.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_journal_reversal_validate()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      v_original_status text;
      v_reversal_status text;
      v_original_currency text;
      v_reversal_currency text;
      v_original_date date;
      v_reversal_date date;
      v_mirror boolean;
    BEGIN
      SELECT status, currency_code, business_date
        INTO v_original_status, v_original_currency, v_original_date
        FROM journal_entries WHERE id = NEW.original_entry_id;
      SELECT status, currency_code, business_date
        INTO v_reversal_status, v_reversal_currency, v_reversal_date
        FROM journal_entries WHERE id = NEW.reversal_entry_id;
      IF v_original_status IS NULL OR v_reversal_status IS NULL THEN
        RAISE EXCEPTION 'reversal references missing journal entries';
      END IF;
      IF v_original_status <> 'POSTED' THEN
        RAISE EXCEPTION 'only posted journals can be reversed';
      END IF;
      IF v_reversal_status <> 'POSTED' THEN
        RAISE EXCEPTION 'reversal journal must be posted';
      END IF;
      IF v_original_currency IS DISTINCT FROM v_reversal_currency THEN
        RAISE EXCEPTION 'reversal currency must match original';
      END IF;
      IF v_original_date IS DISTINCT FROM v_reversal_date THEN
        RAISE EXCEPTION 'reversal business date must match original';
      END IF;
      SELECT
        (SELECT count(*) FROM journal_lines WHERE journal_entry_id = NEW.original_entry_id) =
        (SELECT count(*) FROM journal_lines WHERE journal_entry_id = NEW.reversal_entry_id)
        AND
        (SELECT jsonb_agg(
           jsonb_build_array(account_id::text, description, debit, credit, tax_code_id::text,
                             cost_center, project_code)
           ORDER BY line_number)
         FROM journal_lines WHERE journal_entry_id = NEW.original_entry_id)
        =
        (SELECT jsonb_agg(
           jsonb_build_array(account_id::text, description, credit, debit, tax_code_id::text,
                             cost_center, project_code)
           ORDER BY line_number)
         FROM journal_lines WHERE journal_entry_id = NEW.reversal_entry_id)
      INTO v_mirror;
      IF NOT v_mirror THEN
        RAISE EXCEPTION 'reversal lines must mirror original lines';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS journal_entries_opening_balance_date_unique');
  pgm.sql('DROP INDEX IF EXISTS journal_lines_tenant_id_cost_center_idx');
  pgm.sql('DROP INDEX IF EXISTS journal_lines_tenant_id_project_code_idx');
  pgm.sql('ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_debit_credit_exclusive');
  pgm.sql('ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_amounts_nonnegative');
  pgm.sql('ALTER TABLE journal_lines DROP COLUMN IF EXISTS project_code');
  pgm.sql('ALTER TABLE journal_lines DROP COLUMN IF EXISTS cost_center');
  pgm.sql('ALTER TABLE journal_entries DROP COLUMN IF EXISTS document_date');
};
