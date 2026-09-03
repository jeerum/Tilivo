exports.shorthands = undefined;

exports.up = (pgm) => {
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
        IF NEW.supplier_snapshot = '{}'::jsonb THEN
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
};

exports.down = () => {
  // Forward-only function replacement; original behavior returns on migration down of v0.7.
};
