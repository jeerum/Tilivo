import { createHash } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { bankTransactionFingerprint, isValidIban, normalizeIban, normalizePaymentReference } from '../lib/bankNormalization';
import { withTenantTransaction } from './tenantService';
import { parseBankCsv, parseCamt053, type NormalizedBankTransaction } from './bankStatementParsers';
import { suggestPurchaseMatches, suggestSalesMatches } from './bankingMatching';

function normalizeDate(value: unknown): string | null {
  if (!value) return null;
  return String(value).slice(0, 10);
}

export interface BankAccountInput {
  name: string;
  iban: string;
  bic?: string | null;
  currency?: string;
  bankName?: string | null;
  ledgerAccountId: string;
  isDefault?: boolean;
}

export async function listBankAccounts(pool: Db, tenantId: string): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const rows = await client.query(
      `SELECT ba.*, a.code AS ledger_account_code, a.name AS ledger_account_name
       FROM bank_accounts ba
       JOIN accounts a ON a.id = ba.ledger_account_id AND a.tenant_id = ba.tenant_id
       WHERE ba.tenant_id = $1
       ORDER BY ba.is_default DESC, ba.created_at`,
      [tenantId],
    );
    return rows.rows;
  });
}

export async function createBankAccount(
  pool: Db,
  tenantId: string,
  userId: string,
  input: BankAccountInput,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const iban = normalizeIban(input.iban);
    if (!isValidIban(iban)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid IBAN checksum', 400);
    const account = await client.query(
      'SELECT id, is_active FROM accounts WHERE id = $1 AND tenant_id = $2',
      [input.ledgerAccountId, tenantId],
    );
    if (!account.rows[0] || !account.rows[0].is_active) {
      throw new AppError(ErrorCodes.accountInactive, 'Ledger account must exist and be active', 400);
    }
    if (input.isDefault) {
      await client.query('UPDATE bank_accounts SET is_default = false WHERE tenant_id = $1', [tenantId]);
    }
    const result = await client.query(
      `INSERT INTO bank_accounts
         (tenant_id, name, iban, bic, currency, bank_name, ledger_account_id, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [tenantId, input.name.trim(), iban, input.bic ?? null, input.currency ?? 'EUR', input.bankName ?? null, input.ledgerAccountId, Boolean(input.isDefault), userId],
    );
    return result.rows[0];
  });
}

export async function updateBankAccount(
  pool: Db,
  tenantId: string,
  accountId: string,
  patch: Partial<BankAccountInput> & { isActive?: boolean },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const sets: string[] = [];
    const values: unknown[] = [tenantId, accountId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) add('name', patch.name.trim());
    if (patch.iban !== undefined) {
      const iban = normalizeIban(patch.iban);
      if (!isValidIban(iban)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid IBAN checksum', 400);
      add('iban', iban);
    }
    if (patch.bic !== undefined) add('bic', patch.bic || null);
    if (patch.currency !== undefined) add('currency', patch.currency);
    if (patch.bankName !== undefined) add('bank_name', patch.bankName || null);
    if (patch.ledgerAccountId !== undefined) {
      const account = await client.query(
        'SELECT id, is_active FROM accounts WHERE id = $1 AND tenant_id = $2',
        [patch.ledgerAccountId, tenantId],
      );
      if (!account.rows[0] || !account.rows[0].is_active) {
        throw new AppError(ErrorCodes.accountInactive, 'Ledger account must exist and be active', 400);
      }
      add('ledger_account_id', patch.ledgerAccountId);
    }
    if (patch.isActive !== undefined) add('is_active', patch.isActive);
    if (patch.isDefault === true) {
      await client.query('UPDATE bank_accounts SET is_default = false WHERE tenant_id = $1', [tenantId]);
      add('is_default', true);
    } else if (patch.isDefault === false) {
      add('is_default', false);
    }
    if (sets.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'Nothing to update', 400);
    sets.push('updated_at = now()');
    const result = await client.query(
      `UPDATE bank_accounts SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Bank account not found', 404);
    return result.rows[0];
  });
}

export async function previewBankStatement(
  pool: Db,
  tenantId: string,
  input: { bankAccountId: string; filename: string; content: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const account = await client.query(
      'SELECT id, iban FROM bank_accounts WHERE id = $1 AND tenant_id = $2 AND is_active',
      [input.bankAccountId, tenantId],
    );
    if (!account.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Bank account not found or inactive', 400);
    const fileHash = createHash('sha256').update(input.content).digest('hex');
    const existing = await client.query(
      'SELECT id FROM bank_import_batches WHERE tenant_id = $1 AND file_hash_sha256 = $2',
      [tenantId, fileHash],
    );
    if (existing.rows[0]) {
      throw new AppError(ErrorCodes.invalidRequest, 'This file was already imported', 409);
    }
    const lower = input.filename.toLowerCase();
    const parserType = lower.endsWith('.xml') || lower.endsWith('.camt') ? 'CAMT053' : 'GENERIC_CSV';
    const parsed = parserType === 'CAMT053'
      ? parseCamt053(input.content)
      : parseBankCsv(input.content);
    const normalizedRows = parsed.rows.map((row) => ({
      ...row,
      fingerprint: bankTransactionFingerprint({
        bankAccountIban: account.rows[0].iban,
        bookingDate: row.bookingDate,
        amount: row.amount,
        reference: row.reference,
        counterparty: row.counterpartyName,
      }),
    }));
    const existingFingerprints = await client.query(
      `SELECT source_fingerprint FROM bank_transactions
       WHERE tenant_id = $1 AND bank_account_id = $2`,
      [tenantId, input.bankAccountId],
    );
    const existingSet = new Set(existingFingerprints.rows.map((row: any) => String(row.source_fingerprint)));
    const duplicates = normalizedRows.filter((row) => existingSet.has(row.fingerprint));
    const inflow = parsed.rows.filter((row) => row.direction === 'IN').reduce((sum, row) => sum + Number(row.amount), 0);
    const outflow = parsed.rows.filter((row) => row.direction === 'OUT').reduce((sum, row) => sum + Number(row.amount), 0);
    const dates = parsed.rows.map((row) => row.bookingDate).filter(Boolean);
    return {
      bank_account_id: input.bankAccountId,
      filename: input.filename,
      file_sha256: fileHash,
      parser_type: parserType,
      rows: normalizedRows,
      row_count: parsed.rows.length,
      duplicate_count: duplicates.length,
      warnings: parsed.warnings,
      errors: parsed.errors,
      inflow: inflow.toFixed(2),
      outflow: outflow.toFixed(2),
      statement_from: dates.length ? dates.sort()[0] : null,
      statement_to: dates.length ? dates.sort().at(-1) : null,
      opening_balance: parsed.openingBalance ?? null,
      closing_balance: parsed.closingBalance ?? null,
    };
  });
}

export async function confirmBankImport(
  pool: Db,
  tenantId: string,
  userId: string,
  input: { bankAccountId: string; filename: string; content: string },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const preview = await previewBankStatement(pool, tenantId, input);
    if (preview.errors.length > 0) throw new AppError(ErrorCodes.invalidRequest, preview.errors[0], 400);
    const batch = await client.query(
      `INSERT INTO bank_import_batches
         (tenant_id, bank_account_id, filename, file_hash_sha256, parser_type, status,
          statement_from, statement_to, opening_balance, closing_balance,
          row_count, imported_count, duplicate_count, error_count, warnings, imported_by)
       VALUES ($1,$2,$3,$4,$5,'IMPORTED',$6,$7,$8,$9,$10,0,$11,0,$12,$13)
       RETURNING *`,
      [
        tenantId,
        input.bankAccountId,
        input.filename,
        preview.file_sha256,
        preview.parser_type,
        preview.statement_from,
        preview.statement_to,
        preview.opening_balance,
        preview.closing_balance,
        preview.row_count,
        preview.duplicate_count,
        JSON.stringify(preview.warnings),
        userId,
      ],
    );
    const batchId = String(batch.rows[0].id);
    let imported = 0;
    for (const row of preview.rows as Array<NormalizedBankTransaction & { fingerprint: string }>) {
      const exists = await client.query(
        `SELECT id FROM bank_transactions
         WHERE tenant_id = $1 AND source_fingerprint = $2`,
        [tenantId, row.fingerprint],
      );
      if (exists.rows[0]) continue;
      await client.query(
        `INSERT INTO bank_transactions
           (tenant_id, bank_account_id, import_batch_id, external_transaction_id,
            booking_date, value_date, amount, currency, direction, counterparty_name,
            counterparty_iban, reference, message, bank_archive_id, source_type,
            source_fingerprint, reconciliation_status, accounting_date, raw_metadata)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,'FILE_IMPORT',$15,'UNMATCHED',$5::date,$16)`,
        [
          tenantId,
          input.bankAccountId,
          batchId,
          row.externalTransactionId ?? null,
          row.bookingDate,
          row.valueDate ?? null,
          row.amount,
          row.currency ?? 'EUR',
          row.direction,
          row.counterpartyName ?? null,
          row.counterpartyIban ?? null,
          normalizePaymentReference(row.reference ?? '') || null,
          row.message ?? null,
          row.bankArchiveId ?? null,
          row.fingerprint,
          JSON.stringify(row),
        ],
      );
      imported += 1;
    }
    await client.query(
      `UPDATE bank_import_batches
       SET imported_count = $3, duplicate_count = duplicate_count + $4
       WHERE id = $1 AND tenant_id = $2`,
      [batchId, tenantId, imported, preview.duplicate_count],
    );
    return {
      batch: batch.rows[0],
      imported,
      duplicates: preview.duplicate_count,
      row_count: preview.row_count,
    };
  });
}

export async function listBankImports(pool: Db, tenantId: string, limit = 100, offset = 0): Promise<any[]> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const rows = await client.query(
      `SELECT * FROM bank_import_batches WHERE tenant_id = $1
       ORDER BY imported_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    return rows.rows;
  });
}

export async function listBankTransactions(
  pool: Db,
  tenantId: string,
  filters: { bankAccountId?: string; from?: string; to?: string; direction?: string; status?: string; unmatched?: boolean; search?: string; limit?: number; offset?: number } = {},
): Promise<{ transactions: any[]; total: number }> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const clauses: string[] = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filters.bankAccountId) {
      values.push(filters.bankAccountId);
      clauses.push(`bank_account_id = $${values.length}`);
    }
    if (filters.from) {
      values.push(filters.from);
      clauses.push(`booking_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      clauses.push(`booking_date <= $${values.length}::date`);
    }
    if (filters.direction) {
      values.push(filters.direction);
      clauses.push(`direction = $${values.length}`);
    }
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`reconciliation_status = $${values.length}`);
    }
    if (filters.unmatched) clauses.push(`reconciliation_status IN ('UNMATCHED','SUGGESTED')`);
    if (filters.search) {
      values.push(`%${filters.search}%`);
      clauses.push(`(counterparty_name ILIKE $${values.length} OR message ILIKE $${values.length} OR reference ILIKE $${values.length})`);
    }
    const where = clauses.join(' AND ');
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);
    const total = await client.query(`SELECT count(*)::int AS total FROM bank_transactions WHERE ${where}`, values);
    const rows = await client.query(
      `SELECT * FROM bank_transactions WHERE ${where}
       ORDER BY booking_date DESC, created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    return { transactions: rows.rows, total: Number(total.rows[0]?.total ?? 0) };
  });
}

export async function getBankTransaction(pool: Db, tenantId: string, transactionId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const transaction = await client.query(
      `SELECT * FROM bank_transactions WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId],
    );
    if (!transaction.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Bank transaction not found', 404);
    const allocations = await client.query(
      `SELECT * FROM bank_transaction_allocations
       WHERE tenant_id = $1 AND bank_transaction_id = $2 ORDER BY created_at`,
      [tenantId, transactionId],
    );
    return { transaction: transaction.rows[0], allocations: allocations.rows };
  });
}

export async function getBankTransactionSuggestions(pool: Db, tenantId: string, transactionId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const transaction = await client.query(
      'SELECT * FROM bank_transactions WHERE id = $1 AND tenant_id = $2',
      [transactionId, tenantId],
    );
    if (!transaction.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Bank transaction not found', 404);
    const tx = transaction.rows[0];
    if (tx.direction === 'IN') {
      const invoices = await client.query(
        `SELECT i.id, i.invoice_number, i.payment_reference, i.total, i.advance_applied,
                i.credited_amount, i.amount_paid, i.customer_snapshot, bp.name AS customer_name
         FROM sales_invoices i
         JOIN business_parties bp ON bp.id = i.customer_id AND bp.tenant_id = i.tenant_id
         WHERE i.tenant_id = $1 AND i.status IN ('ISSUED','PARTIALLY_PAID')
         ORDER BY i.issue_date`,
        [tenantId],
      );
      const suggestions = suggestSalesMatches(
        {
          direction: tx.direction,
          reference: tx.reference,
          message: tx.message,
          amount: tx.amount,
          counterpartyName: tx.counterparty_name,
          counterpartyIban: tx.counterparty_iban,
        },
        invoices.rows,
      );
      return { suggestions };
    }
    const invoices = await client.query(
      `SELECT pi.id, pi.invoice_number, pi.payment_reference, pi.total, pi.amount_paid,
              bp.name AS supplier_name
       FROM purchase_invoices pi
       JOIN business_parties bp ON bp.id = pi.supplier_id AND bp.tenant_id = pi.tenant_id
       WHERE pi.tenant_id = $1 AND pi.status = 'POSTED'
       ORDER BY pi.invoice_date`,
      [tenantId],
    );
    const suggestions = suggestPurchaseMatches(
      { direction: tx.direction, reference: tx.reference, message: tx.message, amount: tx.amount, counterpartyName: tx.counterparty_name },
      invoices.rows,
    );
    return { suggestions };
  });
}

export function bankBalanceDisplay(imports: Array<{ opening_balance: string | null; closing_balance: string | null }>): any {
  return imports;
}

export async function getBankingSettings(pool: Db, tenantId: string): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO banking_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
    void result;
    const row = await client.query('SELECT * FROM banking_settings WHERE tenant_id = $1', [tenantId]);
    return row.rows[0];
  });
}

export async function updateBankingSettings(
  pool: Db,
  tenantId: string,
  patch: Record<string, string | null>,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO banking_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
    const allowed: Record<string, string> = {
      bank_fee_expense_account_id: 'bank_fee_expense_account_id',
      interest_income_account_id: 'interest_income_account_id',
      interest_expense_account_id: 'interest_expense_account_id',
      card_clearing_account_id: 'card_clearing_account_id',
      transfer_clearing_account_id: 'transfer_clearing_account_id',
      customer_unallocated_account_id: 'customer_unallocated_account_id',
      supplier_unallocated_account_id: 'supplier_unallocated_account_id',
    };
    const sets: string[] = [];
    const values: unknown[] = [tenantId];
    for (const [key, column] of Object.entries(allowed)) {
      if (patch[key] === undefined) continue;
      const value = patch[key];
      if (value) {
        const account = await client.query(
          'SELECT id FROM accounts WHERE id = $1 AND tenant_id = $2 AND is_active',
          [value, tenantId],
        );
        if (!account.rows[0]) throw new AppError(ErrorCodes.accountInactive, 'Mapping account must exist and be active', 400);
      }
      values.push(value || null);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'Nothing to update', 400);
    const result = await client.query(
      `UPDATE banking_settings SET ${sets.join(', ')} WHERE tenant_id = $1 RETURNING *`,
      values,
    );
    return result.rows[0];
  });
}

export { normalizeDate };
