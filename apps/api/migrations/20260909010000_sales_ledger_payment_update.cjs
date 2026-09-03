exports.shorthands = undefined;

exports.up = (pgm) => {
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

      -- Manual payment records may update only payment fields on issued docs.
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
           OR NEW.document_type IS DISTINCT FROM OLD.document_type THEN
          RAISE EXCEPTION 'issued sales invoice is immutable';
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
};

exports.down = () => {
  // Forward-only function replacement.
};
