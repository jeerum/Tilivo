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

export async function setPeriodStatus(
  pool: Db,
  tenantId: string,
  periodId: string,
  status: 'SOFT_CLOSED' | 'CLOSED',
  userId: string,
): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `UPDATE accounting_periods
       SET status = $3, closed_at = now(), closed_by = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status IN ('OPEN','SOFT_CLOSED')
       RETURNING id`,
      [periodId, tenantId, status, userId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.periodNotFound, 'Period not found or already closed', 404);
  });
}

export async function reopenPeriod(
  pool: Db,
  tenantId: string,
  periodId: string,
  userId: string,
  reason: string,
): Promise<void> {
  if (!reason || reason.trim().length < 5) {
    throw new AppError(ErrorCodes.invalidPeriodRange, 'Reopen reason is required', 400);
  }
  await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `UPDATE accounting_periods
       SET status = 'OPEN', reopened_at = now(), reopened_by = $3, reopen_reason = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status <> 'OPEN'
       RETURNING id`,
      [periodId, tenantId, userId, reason.trim()],
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.periodNotFound, 'Period not found or already open', 404);
  });
}

export async function reverseJournal(pool: Db, tenantId: string, entryId: string, userId: string, reason: string): Promise<string> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const original = await client.query(
      `SELECT id, status, currency_code, business_date, description
       FROM journal_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [entryId, tenantId],
    );
    const row = original.rows[0];
    if (!row) throw new AppError(ErrorCodes.journalNotFound, 'Journal not found', 404);
    if (row.status !== 'POSTED') throw new AppError(ErrorCodes.journalNotDraft, 'Only posted journals can be reversed', 409);
    const existing = await client.query(
      'SELECT id FROM journal_reversals WHERE original_entry_id = $1',
      [entryId],
    );
    if (existing.rows[0]) throw new AppError(ErrorCodes.journalAlreadyReversed, 'Journal already reversed', 409);

    const lines = await client.query(
      `SELECT line_number, account_id, description, debit, credit, tax_code_id
       FROM journal_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [entryId],
    );
    const reversalEntry = await client.query(
      `INSERT INTO journal_entries
         (tenant_id, business_date, description, currency_code, source_type, created_by)
       VALUES ($1, $2, $3, $4, 'MANUAL', $5)
       RETURNING id`,
      [tenantId, row.business_date, `Reversal: ${String(row.description)}`, row.currency_code, userId],
    );
    const reversalId = String(reversalEntry.rows[0]!.id);
    let n = 1;
    for (const line of lines.rows) {
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, journal_entry_id, line_number, account_id, description, debit, credit, currency_code, tax_code_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tenantId, reversalId, n, line.account_id, line.description ?? '', String(line.credit), String(line.debit), row.currency_code, line.tax_code_id],
      );
      n += 1;
    }
    // post via the same controlled flow
    const entryNumber = await (async () => {
      const periodResult = await client.query(
        `SELECT p.id, p.status, fy.id AS fiscal_year_id
         FROM accounting_periods p JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
         WHERE p.tenant_id = $1 AND $2::date BETWEEN p.start_date AND p.end_date FOR UPDATE OF p`,
        [tenantId, row.business_date],
      );
      const period = periodResult.rows[0];
      if (!period) throw new AppError(ErrorCodes.periodNotFound, 'No accounting period for reversal', 400);
      if (period.status !== 'OPEN') throw new AppError(ErrorCodes.periodClosed, 'Accounting period is not open', 409);
      const seq = await client.query(
        `INSERT INTO journal_sequences (tenant_id, fiscal_year_id, next_number)
         VALUES ($1,$2,1)
         ON CONFLICT (tenant_id, fiscal_year_id) DO UPDATE SET next_number = journal_sequences.next_number + 1
         RETURNING next_number - 1 AS number`,
        [tenantId, period.fiscal_year_id],
      );
      const year = await client.query(`SELECT to_char(start_date,'YYYY') AS year FROM fiscal_years WHERE id = $1`, [period.fiscal_year_id]);
      const number = `${String(year.rows[0]!.year)}-${String(seq.rows[0]!.number).padStart(6, '0')}`;
      await client.query(
        `UPDATE journal_entries SET status='POSTED', entry_number=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
        [reversalId, number, userId],
      );
      return number;
    })();
    await client.query(
      `INSERT INTO journal_reversals (tenant_id, original_entry_id, reversal_entry_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, entryId, reversalId, reason, userId],
    );
    await client.query(
      `UPDATE journal_entries SET reversed_by_entry_id = $2 WHERE id = $1`,
      [entryId, reversalId],
    );
    return entryNumber;
  });
}
