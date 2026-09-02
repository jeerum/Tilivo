exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_journal_entries_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      v_linked bigint;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IN ('POSTED', 'REVERSED') THEN
          RAISE EXCEPTION 'journal entries must be inserted with status DRAFT';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('POSTED', 'REVERSED') THEN
          RAISE EXCEPTION 'posted journal is immutable';
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
        IF NEW.entry_number IS NULL OR NEW.posted_by IS NULL OR NEW.posted_at IS NULL THEN
          RAISE EXCEPTION 'posting requires entry number and post metadata';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
        IF OLD.reversed_by_entry_id IS NOT NULL THEN
          RAISE EXCEPTION 'journal already reversed';
        END IF;
        IF NEW.reversed_by_entry_id IS NULL THEN
          RAISE EXCEPTION 'reversal requires reversal entry linkage';
        END IF;
        SELECT count(*) INTO v_linked
          FROM journal_reversals
          WHERE original_entry_id = OLD.id AND reversal_entry_id = NEW.reversed_by_entry_id;
        IF v_linked <> 1 THEN
          RAISE EXCEPTION 'reversal requires a matching reversal record';
        END IF;
        IF NEW.business_date IS DISTINCT FROM OLD.business_date
           OR NEW.description IS DISTINCT FROM OLD.description
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
           OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
           OR NEW.source_type IS DISTINCT FROM OLD.source_type
           OR NEW.source_id IS DISTINCT FROM OLD.source_id
           OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
           OR NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
          RAISE EXCEPTION 'reversal may not alter posted journal data';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status IN ('POSTED', 'REVERSED') OR NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'posted journal is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql('DROP TRIGGER IF EXISTS tilivo_journal_entries_immutable ON journal_entries');
  pgm.sql(`
    CREATE TRIGGER tilivo_journal_entries_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_entries_immutable()
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.tilivo_journal_lines_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE entry_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        SELECT status INTO entry_status FROM journal_entries WHERE id = OLD.journal_entry_id;
        IF entry_status IN ('POSTED', 'REVERSED') THEN
          RAISE EXCEPTION 'posted journal lines are immutable';
        END IF;
        RETURN OLD;
      END IF;
      SELECT status INTO entry_status FROM journal_entries WHERE id = NEW.journal_entry_id;
      IF entry_status IN ('POSTED', 'REVERSED') THEN
        RAISE EXCEPTION 'posted journal lines are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER tilivo_journal_lines_insert_immutable
    BEFORE INSERT ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_lines_immutable()
  `);

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
           jsonb_build_array(account_id::text, description, debit, credit, tax_code_id::text)
           ORDER BY line_number)
         FROM journal_lines WHERE journal_entry_id = NEW.original_entry_id)
        =
        (SELECT jsonb_agg(
           jsonb_build_array(account_id::text, description, credit, debit, tax_code_id::text)
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

  pgm.sql(`
    CREATE TRIGGER tilivo_journal_reversal_validate
    BEFORE INSERT ON journal_reversals
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_reversal_validate()
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS tilivo_journal_reversal_validate ON journal_reversals');
  pgm.sql('DROP FUNCTION IF EXISTS public.tilivo_journal_reversal_validate()');
  pgm.sql('DROP TRIGGER IF EXISTS tilivo_journal_lines_insert_immutable ON journal_lines');
  pgm.sql('DROP TRIGGER IF EXISTS tilivo_journal_entries_immutable ON journal_entries');

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
    CREATE TRIGGER tilivo_journal_entries_immutable
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.tilivo_journal_entries_immutable()
  `);
};
