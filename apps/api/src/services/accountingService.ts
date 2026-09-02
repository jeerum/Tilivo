import Decimal from 'decimal.js';
import type { Db } from '../db/pool';
import type { DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { withTenantTransaction } from './tenantService';

export interface JournalLineInput {
  accountId: string;
  description?: string;
  debit: string;
  credit: string;
  taxCodeId?: string | null;
}

async function postEntryInTransaction(
  client: DbClient,
  tenantId: string,
  entryId: string,
  userId: string,
): Promise<string> {
  const entryResult = await client.query(
    `SELECT id, status, business_date, currency_code FROM journal_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [entryId, tenantId],
  );
  const entry = entryResult.rows[0];
  if (!entry) throw new AppError(ErrorCodes.journalNotFound, 'Journal not found', 404);
  if (entry.status !== 'DRAFT') throw new AppError(ErrorCodes.journalNotDraft, 'Journal is not a draft', 409);

  const periodResult = await client.query(
    `SELECT p.id, p.status, fy.id AS fiscal_year_id
     FROM accounting_periods p
     JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
     WHERE p.tenant_id = $1 AND $2::date BETWEEN p.start_date AND p.end_date
     FOR UPDATE OF p`,
    [tenantId, entry.business_date],
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
     VALUES ($1, $2, 2)
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
    const accountIds = [...new Set(input.lines.map((line) => line.accountId))];
    if (accountIds.length > 0) {
      const accounts = await client.query(
        'SELECT id FROM accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tenantId, accountIds],
      );
      if (accounts.rows.length !== accountIds.length) {
        throw new AppError(ErrorCodes.accountNotFound, 'Journal references an account outside the tenant', 400);
      }
    }
    const taxCodeIds = [
      ...new Set(
        input.lines
          .map((line) => line.taxCodeId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (taxCodeIds.length > 0) {
      const taxCodes = await client.query(
        'SELECT id FROM tax_codes WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tenantId, taxCodeIds],
      );
      if (taxCodes.rows.length !== taxCodeIds.length) {
        throw new AppError(ErrorCodes.taxCodeNotFound, 'Journal references a tax code outside the tenant', 400);
      }
    }
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
    return postEntryInTransaction(client, tenantId, entryId, userId);
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
    // post via the same controlled flow (entry lock first, then period)
    const entryNumber = await postEntryInTransaction(client, tenantId, reversalId, userId);
    await client.query(
      `INSERT INTO journal_reversals (tenant_id, original_entry_id, reversal_entry_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, entryId, reversalId, reason, userId],
    );
    await client.query(
      `UPDATE journal_entries SET status = 'REVERSED', reversed_by_entry_id = $2 WHERE id = $1`,
      [entryId, reversalId],
    );
    return entryNumber;
  });
}

export interface TaxCodeInput {
  code: string;
  name: string;
  countryCode: string;
  rate: string;
  type: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  reportingMapping?: string | null;
  isActive?: boolean;
}

export type TaxCodePatch = Partial<Omit<TaxCodeInput, 'effectiveFrom'>> & { effectiveFrom?: string };

export async function listTaxCodes(pool: Db, tenantId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, code, name, country_code, rate, type, effective_from, effective_to,
              reporting_mapping, is_active
       FROM tax_codes
       ORDER BY code, effective_from DESC`,
    );
    return result.rows;
  });
}

export async function createTaxCode(pool: Db, tenantId: string, input: TaxCodeInput): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    try {
      const result = await client.query(
        `INSERT INTO tax_codes
           (tenant_id, code, name, country_code, rate, type, effective_from, effective_to,
            reporting_mapping, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, code, name, country_code, rate, type, effective_from, effective_to,
                   reporting_mapping, is_active`,
        [
          tenantId,
          input.code,
          input.name,
          input.countryCode,
          input.rate,
          input.type,
          input.effectiveFrom,
          input.effectiveTo ?? null,
          input.reportingMapping ?? null,
          input.isActive ?? true,
        ],
      );
      return result.rows[0];
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        throw new AppError(ErrorCodes.taxCodeDuplicate, 'Tax code already exists for effective date', 409);
      }
      throw error;
    }
  });
}

export async function updateTaxCode(
  pool: Db,
  tenantId: string,
  taxCodeId: string,
  patch: TaxCodePatch,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const updates: string[] = [];
    const values: unknown[] = [tenantId, taxCodeId];
    const columns: Array<[string, unknown]> = [
      ['code', patch.code],
      ['name', patch.name],
      ['country_code', patch.countryCode],
      ['rate', patch.rate],
      ['type', patch.type],
      ['effective_from', patch.effectiveFrom],
      ['effective_to', patch.effectiveTo],
      ['reporting_mapping', patch.reportingMapping],
      ['is_active', patch.isActive],
    ];
    for (const [column, value] of columns) {
      if (value !== undefined) {
        updates.push(`${column} = $${values.length + 1}`);
        values.push(value);
      }
    }
    if (updates.length === 0) {
      throw new AppError(ErrorCodes.taxCodeInvalid, 'No tax code fields to update', 400);
    }
    try {
      const result = await client.query(
        `UPDATE tax_codes
         SET ${updates.join(', ')}
         WHERE id = $2 AND tenant_id = $1
         RETURNING id, code, name, country_code, rate, type, effective_from, effective_to,
                   reporting_mapping, is_active`,
        values,
      );
      if (!result.rows[0]) throw new AppError(ErrorCodes.taxCodeNotFound, 'Tax code not found', 404);
      return result.rows[0];
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        throw new AppError(ErrorCodes.taxCodeDuplicate, 'Tax code already exists for effective date', 409);
      }
      throw error;
    }
  });
}

export async function listFxRates(
  pool: Db,
  tenantId: string,
  filters: { baseCurrency?: string; quoteCurrency?: string; from?: string; to?: string } = {},
): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.baseCurrency) {
      values.push(filters.baseCurrency);
      clauses.push(`base_currency = $${values.length}`);
    }
    if (filters.quoteCurrency) {
      values.push(filters.quoteCurrency);
      clauses.push(`quote_currency = $${values.length}`);
    }
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`rate_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`rate_date <= $${values.length}::date`);
    }
    const where = clauses.length ? `WHERE tenant_id = $1 AND ${clauses.join(' AND ')}` : 'WHERE tenant_id = $1';
    const result = await client.query(
      `SELECT id, base_currency, quote_currency, rate, rate_date, source, created_at
       FROM fx_rates
       ${where}
       ORDER BY rate_date DESC, created_at DESC
       LIMIT 500`,
      values,
    );
    return result.rows;
  });
}

export async function createFxRate(
  pool: Db,
  tenantId: string,
  input: { baseCurrency: string; quoteCurrency: string; rate: string; rateDate: string; source?: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    try {
      const result = await client.query(
        `INSERT INTO fx_rates (tenant_id, base_currency, quote_currency, rate, rate_date, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, base_currency, quote_currency, rate, rate_date, source, created_at`,
        [tenantId, input.baseCurrency, input.quoteCurrency, input.rate, input.rateDate, input.source ?? 'MANUAL'],
      );
      return result.rows[0];
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        throw new AppError(ErrorCodes.fxRateDuplicate, 'FX rate already exists for date and source', 409);
      }
      if (pgError.code === '23503') {
        throw new AppError(ErrorCodes.fxRateInvalid, 'Currency does not exist', 400);
      }
      throw error;
    }
  });
}

export async function updateFxRate(
  pool: Db,
  tenantId: string,
  fxRateId: string,
  patch: { rate?: string; rateDate?: string; source?: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const updates: string[] = [];
    const values: unknown[] = [tenantId, fxRateId];
    for (const [column, value] of [
      ['rate', patch.rate],
      ['rate_date', patch.rateDate],
      ['source', patch.source],
    ] as Array<[string, unknown]>) {
      if (value !== undefined) {
        updates.push(`${column} = $${values.length + 1}`);
        values.push(value);
      }
    }
    if (updates.length === 0) throw new AppError(ErrorCodes.fxRateInvalid, 'No FX rate fields to update', 400);
    try {
      const result = await client.query(
        `UPDATE fx_rates
         SET ${updates.join(', ')}
         WHERE id = $2 AND tenant_id = $1
         RETURNING id, base_currency, quote_currency, rate, rate_date, source, created_at`,
        values,
      );
      if (!result.rows[0]) throw new AppError(ErrorCodes.fxRateNotFound, 'FX rate not found', 404);
      return result.rows[0];
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        throw new AppError(ErrorCodes.fxRateDuplicate, 'FX rate already exists for date and source', 409);
      }
      if (pgError.code === '23503') {
        throw new AppError(ErrorCodes.fxRateInvalid, 'Currency does not exist', 400);
      }
      throw error;
    }
  });
}

export async function deleteFxRate(pool: Db, tenantId: string, fxRateId: string): Promise<void> {
  await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query('DELETE FROM fx_rates WHERE id = $1 AND tenant_id = $2', [
      fxRateId,
      tenantId,
    ]);
    if (!result.rowCount) throw new AppError(ErrorCodes.fxRateNotFound, 'FX rate not found', 404);
  });
}

export async function convertCurrency(
  pool: Db,
  tenantId: string,
  input: { from: string; to: string; date: string; amount: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    if (input.from === input.to) {
      return {
        from: input.from,
        to: input.to,
        date: input.date,
        rate: '1',
        amount: input.amount,
        converted_amount: input.amount,
      };
    }
    const direct = await client.query(
      `SELECT rate FROM fx_rates
       WHERE tenant_id = $1 AND base_currency = $2 AND quote_currency = $3 AND rate_date <= $4::date
       ORDER BY rate_date DESC, created_at DESC
       LIMIT 1`,
      [tenantId, input.from, input.to, input.date],
    );
    let rate: string;
    if (direct.rows[0]) {
      rate = String(direct.rows[0]!.rate);
    } else {
      const inverse = await client.query(
        `SELECT rate FROM fx_rates
         WHERE tenant_id = $1 AND base_currency = $2 AND quote_currency = $3 AND rate_date <= $4::date
         ORDER BY rate_date DESC, created_at DESC
         LIMIT 1`,
        [tenantId, input.to, input.from, input.date],
      );
      if (!inverse.rows[0]) {
        throw new AppError(ErrorCodes.fxRateNotFound, 'No FX rate available for date', 404);
      }
      rate = new Decimal(1).div(new Decimal(String(inverse.rows[0]!.rate))).toString();
    }
    const amount = new Decimal(input.amount);
    const converted = amount.mul(new Decimal(rate));
    return {
      from: input.from,
      to: input.to,
      date: input.date,
      rate,
      amount: input.amount,
      converted_amount: converted.toString(),
    };
  });
}

export async function listCurrencies(pool: Db): Promise<any[]> {
  const result = await pool.query(
    `SELECT code, name, minor_units, is_active FROM currencies WHERE is_active ORDER BY code`,
  );
  return result.rows;
}

export async function listJournals(
  pool: Db,
  tenantId: string,
  filters: { status?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
): Promise<{ journals: any[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`status = $${values.length}`);
    }
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`business_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`business_date <= $${values.length}::date`);
    }
    const where = `WHERE tenant_id = $1${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;
    const totalResult = await client.query(`SELECT count(*)::int AS total FROM journal_entries ${where}`, values);
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const pageValues = [...values, limit, offset];
    const entries = await client.query(
      `SELECT id, entry_number, business_date, posting_date, description, status, currency_code,
              source_type, source_id, reversal_of_entry_id, reversed_by_entry_id,
              created_by, posted_by, created_at, posted_at
       FROM journal_entries
       ${where}
       ORDER BY business_date DESC, entry_number DESC NULLS LAST, created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      pageValues,
    );
    if (entries.rows.length === 0) {
      return { journals: [], total: Number(totalResult.rows[0]!.total) };
    }
    const entryIds = entries.rows.map((row: any) => String(row.id));
    const lines = await client.query(
      `SELECT l.journal_entry_id, l.line_number, l.account_id, a.code AS account_code,
              a.name AS account_name, l.description, l.debit, l.credit, l.currency_code,
              l.tax_code_id, l.applied_tax_rate, l.tax_snapshot
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
       WHERE l.journal_entry_id = ANY($1::uuid[])
       ORDER BY l.line_number`,
      [entryIds],
    );
    const linesByEntry = new Map<string, any[]>();
    for (const row of lines.rows) {
      const key = String(row.journal_entry_id);
      const list = linesByEntry.get(key) ?? [];
      list.push(row);
      linesByEntry.set(key, list);
    }
    const journals = entries.rows.map((row: any) => ({
      ...row,
      id: String(row.id),
      lines: linesByEntry.get(String(row.id)) ?? [],
    }));
    return { journals, total: Number(totalResult.rows[0]!.total) };
  });
}

export async function getJournal(pool: Db, tenantId: string, journalId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const entry = await client.query(
      `SELECT id, entry_number, business_date, posting_date, description, status, currency_code,
              source_type, source_id, reversal_of_entry_id, reversed_by_entry_id,
              created_by, posted_by, created_at, posted_at
       FROM journal_entries
       WHERE id = $1 AND tenant_id = $2`,
      [journalId, tenantId],
    );
    if (!entry.rows[0]) throw new AppError(ErrorCodes.journalNotFound, 'Journal not found', 404);
    const lines = await client.query(
      `SELECT l.line_number, l.account_id, a.code AS account_code, a.name AS account_name,
              l.description, l.debit, l.credit, l.currency_code, l.tax_code_id,
              l.applied_tax_rate, l.tax_snapshot
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
       WHERE l.journal_entry_id = $1
       ORDER BY l.line_number`,
      [journalId],
    );
    return { ...entry.rows[0], id: String(entry.rows[0]!.id), lines: lines.rows };
  });
}

export async function ledgerLines(
  pool: Db,
  tenantId: string,
  filters: { from?: string; to?: string; accountId?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: any[]; debitTotal: string; creditTotal: string; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = [];
    const values: unknown[] = [tenantId];
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`je.business_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`je.business_date <= $${values.length}::date`);
    }
    if (filters.accountId) {
      values.push(filters.accountId);
      clauses.push(`l.account_id = $${values.length}`);
    }
    const where = `WHERE je.tenant_id = $1 AND je.status = 'POSTED'${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;

    const totals = await client.query(
      `SELECT COALESCE(sum(l.debit), 0)::text AS debit_total,
              COALESCE(sum(l.credit), 0)::text AS credit_total
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       ${where}`,
      values,
    );
    const totalResult = await client.query(
      `SELECT count(*)::int AS total FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       ${where}`,
      values,
    );
    const limit = filters.limit ?? 200;
    const offset = filters.offset ?? 0;
    const pageValues = [...values, limit, offset];
    const rows = await client.query(
      `SELECT l.id, l.journal_entry_id AS entry_id, je.entry_number, je.business_date,
              je.posting_date, je.description, l.line_number, l.account_id,
              a.code AS account_code, a.name AS account_name,
              l.debit, l.credit, l.currency_code
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
       ${where}
       ORDER BY je.business_date, je.entry_number, l.line_number
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      pageValues,
    );
    return {
      rows: rows.rows,
      debitTotal: String(totals.rows[0]!.debit_total),
      creditTotal: String(totals.rows[0]!.credit_total),
      total: Number(totalResult.rows[0]!.total),
    };
  });
}

export async function accountLedger(
  pool: Db,
  tenantId: string,
  accountId: string,
  filters: { from?: string; to?: string } = {},
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const account = await client.query(
      `SELECT id, code, name, type, normal_balance
       FROM accounts WHERE id = $1 AND tenant_id = $2`,
      [accountId, tenantId],
    );
    if (!account.rows[0]) throw new AppError(ErrorCodes.accountNotFound, 'Account not found', 404);

    const beforeValues: unknown[] = [tenantId, accountId];
    let beforeClause = '';
    if (filters.from) {
      beforeValues.push(filters.from);
      beforeClause = ` AND je.business_date < $3::date`;
    }
    const before = await client.query(
      `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.tenant_id = $1 AND l.account_id = $2 AND je.status = 'POSTED'${beforeClause}`,
      beforeValues,
    );
    const balanceBefore = new Decimal(String(before.rows[0]!.balance));

    const rangeValues: unknown[] = [tenantId, accountId];
    const rangeClauses: string[] = [];
    if (filters.from) {
      rangeValues.push(filters.from);
      rangeClauses.push(`je.business_date >= $${rangeValues.length}::date`);
    }
    if (filters.to) {
      rangeValues.push(filters.to);
      rangeClauses.push(`je.business_date <= $${rangeValues.length}::date`);
    }
    const rangeWhere = rangeClauses.length ? ` AND ${rangeClauses.join(' AND ')}` : '';
    const rows = await client.query(
      `SELECT l.id, je.entry_number, je.business_date, je.posting_date, je.description,
              l.line_number, l.debit, l.credit
       FROM journal_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.tenant_id = $1 AND l.account_id = $2 AND je.status = 'POSTED'${rangeWhere}
       ORDER BY je.business_date, je.entry_number, l.line_number`,
      rangeValues,
    );

    let running = balanceBefore;
    let debitTotal = new Decimal(0);
    let creditTotal = new Decimal(0);
    const items = rows.rows.map((row: any) => {
      const debit = new Decimal(String(row.debit));
      const credit = new Decimal(String(row.credit));
      debitTotal = debitTotal.plus(debit);
      creditTotal = creditTotal.plus(credit);
      running = running.plus(debit).minus(credit);
      return { ...row, running_balance: running.toString() };
    });
    const closing = balanceBefore.plus(debitTotal).minus(creditTotal);
    return {
      account: account.rows[0],
      balance_before: balanceBefore.toString(),
      total_debit: debitTotal.toString(),
      total_credit: creditTotal.toString(),
      closing_balance: closing.toString(),
      rows: items,
    };
  });
}

export async function trialBalance(
  pool: Db,
  tenantId: string,
  asOf?: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT a.id AS account_id, a.code, a.name, a.type, a.normal_balance,
              COALESCE(sum(l.debit), 0)::text AS debit_total,
              COALESCE(sum(l.credit), 0)::text AS credit_total
       FROM accounts a
       JOIN journal_lines l ON l.account_id = a.id AND l.tenant_id = a.tenant_id
       JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE a.tenant_id = $1 AND je.status = 'POSTED'
         AND ($2::date IS NULL OR je.business_date <= $2::date)
       GROUP BY a.id
       ORDER BY a.code`,
      [tenantId, asOf ?? null],
    );
    let totalDebitColumn = new Decimal(0);
    let totalCreditColumn = new Decimal(0);
    const rows = result.rows.map((row: any) => {
      const debit = new Decimal(String(row.debit_total));
      const credit = new Decimal(String(row.credit_total));
      const normalIsDebit = String(row.normal_balance) === 'DEBIT';
      // Positive signed balance belongs to the account's normal side; a
      // negative one is shown on the opposite side as an abnormal balance.
      const signed = normalIsDebit ? debit.minus(credit) : credit.minus(debit);
      const ownBalance = signed.greaterThan(0) ? signed : new Decimal(0);
      const oppositeBalance = signed.lessThan(0) ? signed.negated() : new Decimal(0);
      const debitBalance = normalIsDebit ? ownBalance : oppositeBalance;
      const creditBalance = normalIsDebit ? oppositeBalance : ownBalance;
      totalDebitColumn = totalDebitColumn.plus(debitBalance);
      totalCreditColumn = totalCreditColumn.plus(creditBalance);
      return {
        ...row,
        debit_total: debit.toString(),
        credit_total: credit.toString(),
        debit_balance: debitBalance.toString(),
        credit_balance: creditBalance.toString(),
      };
    });
    const debitTotal = totalDebitColumn.toString();
    const creditTotal = totalCreditColumn.toString();
    return {
      as_of: asOf ?? null,
      rows,
      totals: { debit: debitTotal, credit: creditTotal },
      balanced: totalDebitColumn.equals(totalCreditColumn),
    };
  });
}
