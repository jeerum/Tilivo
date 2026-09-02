import Decimal from 'decimal.js';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { withTenantTransaction } from './tenantService';

export interface JournalLineInput {
  accountId: string;
  description?: string;
  debit: string;
  credit: string;
  taxCodeId?: string | null;
}

export async function createJournalDraft(
  pool: Db,
  tenantId: string,
  userId: string,
  input: {
    businessDate: string;
    description: string;
    currencyCode: string;
    sourceType?: string;
    lines: JournalLineInput[];
  },
): Promise<string> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const entry = await client.query(
      `INSERT INTO journal_entries
         (tenant_id, business_date, description, currency_code, source_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [tenantId, input.businessDate, input.description, input.currencyCode, input.sourceType ?? 'MANUAL', userId],
    );
    const entryId = String(entry.rows[0]!.id);
    let lineNumber = 1;
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, journal_entry_id, line_number, account_id, description, debit, credit, currency_code, tax_code_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tenantId, entryId, lineNumber, line.accountId, line.description ?? '', line.debit, line.credit, input.currencyCode, line.taxCodeId ?? null],
      );
      lineNumber += 1;
    }
    return entryId;
  });
}

export async function postJournal(pool: Db, tenantId: string, entryId: string, userId: string): Promise<string> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const periodResult = await client.query(
      `SELECT p.id, p.status, fy.id AS fiscal_year_id
       FROM accounting_periods p
       JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
       JOIN journal_entries je ON je.id = $2
       WHERE p.tenant_id = $1 AND je.business_date BETWEEN p.start_date AND p.end_date
       FOR UPDATE OF p`,
      [tenantId, entryId],
    );
    const period = periodResult.rows[0];
    if (!period) throw new AppError(ErrorCodes.periodNotFound, 'No accounting period for business date', 400);
    if (period.status !== 'OPEN') {
      throw new AppError(
        period.status === 'CLOSED' ? ErrorCodes.periodClosed : ErrorCodes.periodSoftClosed,
        'Accounting period is not open',
        409,
      );
    }

    const entryResult = await client.query(
      `SELECT id, status, currency_code FROM journal_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [entryId, tenantId],
    );
    const entry = entryResult.rows[0];
    if (!entry) throw new AppError(ErrorCodes.journalNotFound, 'Journal not found', 404);
    if (entry.status !== 'DRAFT') throw new AppError(ErrorCodes.journalNotDraft, 'Journal is not a draft', 409);

    const lines = await client.query(
      `SELECT l.debit, l.credit, a.is_active
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
       WHERE l.journal_entry_id = $1`,
      [entryId],
    );
    if (lines.rows.length < 2) throw new AppError(ErrorCodes.journalLineInvalid, 'Journal needs at least two lines', 400);
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const row of lines.rows) {
      if (!row.is_active) throw new AppError(ErrorCodes.accountInactive, 'Journal references an inactive account', 400);
      totalDebit = totalDebit.plus(new Decimal(String(row.debit)));
      totalCredit = totalCredit.plus(new Decimal(String(row.credit)));
    }
    if (!totalDebit.equals(totalCredit)) {
      throw new AppError(ErrorCodes.journalNotBalanced, 'Journal debit and credit totals differ', 422);
    }

    const seq = await client.query(
      `INSERT INTO journal_sequences (tenant_id, fiscal_year_id, next_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, fiscal_year_id)
       DO UPDATE SET next_number = journal_sequences.next_number + 1
       RETURNING next_number - 1 AS number`,
      [tenantId, period.fiscal_year_id],
    );
    const number = String(seq.rows[0]!.number).padStart(6, '0');
    const year = await client.query('SELECT to_char(start_date, \'YYYY\') AS year FROM fiscal_years WHERE id = $1', [
      period.fiscal_year_id,
    ]);
    const entryNumber = `${String(year.rows[0]!.year)}-${number}`;

    await client.query(
      `UPDATE journal_entries
       SET status = 'POSTED', entry_number = $2, posted_by = $3, posted_at = now(), posting_date = current_date
       WHERE id = $1`,
      [entryId, entryNumber, userId],
    );
    return entryNumber;
  });
}
