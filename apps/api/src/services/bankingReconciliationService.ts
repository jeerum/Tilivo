import Decimal from 'decimal.js';
import type { Db, DbClient } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { withTenantTransaction } from './tenantService';
import { createJournalDraftInTransaction, postJournalEntryInTransaction } from './accountingService';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

type AllocationType = 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'BANK_FEE' | 'INTEREST_INCOME'
  | 'INTEREST_EXPENSE' | 'EXPENSE' | 'TRANSFER' | 'CARD_CLEARING' | 'CUSTOMER_CREDIT'
  | 'SUPPLIER_PREPAYMENT' | 'OTHER';

async function ensureBankingSettings(client: DbClient, tenantId: string): Promise<any> {
  await client.query(
    `INSERT INTO banking_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
  const row = await client.query('SELECT * FROM banking_settings WHERE tenant_id = $1', [tenantId]);
  return row.rows[0];
}

async function loadTransaction(client: DbClient, tenantId: string, transactionId: string, lock = false): Promise<any> {
  const rows = await client.query(
    `SELECT * FROM bank_transactions WHERE id = $1 AND tenant_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [transactionId, tenantId],
  );
  if (!rows.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Bank transaction not found', 404);
  return rows.rows[0];
}

async function loadAllocations(client: DbClient, tenantId: string, transactionId: string): Promise<any[]> {
  const rows = await client.query(
    `SELECT * FROM bank_transaction_allocations
     WHERE tenant_id = $1 AND bank_transaction_id = $2
     ORDER BY created_at, id`,
    [tenantId, transactionId],
  );
  return rows.rows;
}

function money(value: Decimal | string): string {
  return new Decimal(value).toFixed(2);
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value ?? '').slice(0, 10);
}

async function validateTarget(
  client: DbClient,
  tenantId: string,
  transaction: any,
  type: AllocationType,
  targetId: string | null,
  amount: Decimal,
): Promise<{ invoiceRow?: any; accountId?: string }> {
  const settings = await ensureBankingSettings(client, tenantId);
  if (type === 'SALES_INVOICE') {
    if (transaction.direction !== 'IN') throw new AppError(ErrorCodes.invalidRequest, 'Sales payments must be incoming', 400);
    const invoice = await client.query(
      `SELECT * FROM sales_invoices WHERE id = $1 AND tenant_id = $2 AND status IN ('ISSUED','PARTIALLY_PAID')`,
      [targetId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Sales invoice not found or not open', 400);
    const row = invoice.rows[0];
    const open = new Decimal(row.total).minus(new Decimal(row.advance_applied ?? 0))
      .minus(new Decimal(row.credited_amount ?? 0)).minus(new Decimal(row.amount_paid ?? 0));
    if (amount.greaterThan(open.plus(0.001))) throw new AppError(ErrorCodes.invalidRequest, 'Allocation exceeds invoice open balance', 400);
    return { invoiceRow: row };
  }
  if (type === 'PURCHASE_INVOICE') {
    if (transaction.direction !== 'OUT') throw new AppError(ErrorCodes.invalidRequest, 'Purchase payments must be outgoing', 400);
    const invoice = await client.query(
      `SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2 AND status = 'POSTED'`,
      [targetId, tenantId],
    );
    if (!invoice.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Purchase invoice not found or not posted', 400);
    const row = invoice.rows[0];
    const open = new Decimal(row.total).minus(new Decimal(row.amount_paid ?? 0));
    if (amount.greaterThan(open.plus(0.001))) throw new AppError(ErrorCodes.invalidRequest, 'Allocation exceeds purchase open balance', 400);
    return { invoiceRow: row };
  }
  if (type === 'BANK_FEE' || type === 'INTEREST_INCOME' || type === 'INTEREST_EXPENSE'
      || type === 'CARD_CLEARING' || type === 'TRANSFER' || type === 'CUSTOMER_CREDIT' || type === 'SUPPLIER_PREPAYMENT') {
    const columns: Record<string, string> = {
      BANK_FEE: 'bank_fee_expense_account_id',
      INTEREST_INCOME: 'interest_income_account_id',
      INTEREST_EXPENSE: 'interest_expense_account_id',
      CARD_CLEARING: 'card_clearing_account_id',
      TRANSFER: 'transfer_clearing_account_id',
      CUSTOMER_CREDIT: 'customer_unallocated_account_id',
      SUPPLIER_PREPAYMENT: 'supplier_unallocated_account_id',
    };
    const accountId = settings[columns[type]!];
    if (!accountId) throw new AppError(ErrorCodes.invalidRequest, `Missing bank mapping for ${type}`, 400);
    return { accountId: String(accountId) };
  }
  if (!targetId) throw new AppError(ErrorCodes.invalidRequest, 'Ledger account is required', 400);
  const account = await client.query(
    'SELECT id, is_active FROM accounts WHERE id = $1 AND tenant_id = $2',
    [targetId, tenantId],
  );
  if (!account.rows[0] || !account.rows[0].is_active) throw new AppError(ErrorCodes.accountInactive, 'Ledger account must exist and be active', 400);
  return { accountId: String(targetId) };
}

export async function createBankAllocation(
  pool: Db,
  tenantId: string,
  userId: string,
  transactionId: string,
  input: { allocationType: AllocationType; targetId?: string | null; accountId?: string | null; amount: string; description?: string | null; projectCode?: string | null; costCenter?: string | null },
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const transaction = await loadTransaction(client, tenantId, transactionId, true);
    if (transaction.reconciliation_status === 'POSTED') {
      throw new AppError(ErrorCodes.invalidRequest, 'Transaction is already posted', 409);
    }
    const amount = new Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) throw new AppError(ErrorCodes.invalidRequest, 'Allocation amount must be positive', 400);
    const allocated = await loadAllocations(client, tenantId, transactionId);
    const allocatedTotal = allocated.reduce((sum, row) => sum.plus(new Decimal(row.amount)), new Decimal(0));
    if (allocatedTotal.plus(amount).greaterThan(new Decimal(transaction.amount).plus(0.001))) {
      throw new AppError(ErrorCodes.invalidRequest, 'Allocations exceed transaction amount', 400);
    }
    const effectiveType = input.allocationType === 'OTHER' || input.allocationType === 'EXPENSE' ? 'EXPENSE' : input.allocationType;
    const rawTarget = input.accountId ?? input.targetId;
    const validation = await validateTarget(client, tenantId, transaction, effectiveType, rawTarget ? String(rawTarget) : null, amount);
    const isInvoiceAllocation = effectiveType === 'SALES_INVOICE' || effectiveType === 'PURCHASE_INVOICE';
    const storedAccountId = validation.accountId ?? (isInvoiceAllocation ? null : rawTarget ? String(rawTarget) : null);
    const result = await client.query(
      `INSERT INTO bank_transaction_allocations
         (tenant_id, bank_transaction_id, allocation_type, target_id, account_id, amount,
          project_code, cost_center, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        tenantId,
        transactionId,
        effectiveType,
        isInvoiceAllocation ? rawTarget : null,
        storedAccountId,
        money(amount),
        input.projectCode ?? null,
        input.costCenter ?? null,
        input.description ?? null,
        userId,
      ],
    );
    const nextTotal = allocatedTotal.plus(amount);
    const status = nextTotal.greaterThanOrEqualTo(new Decimal(transaction.amount).minus(0.001))
      ? 'MATCHED'
      : nextTotal.greaterThan(0) ? 'PARTIALLY_MATCHED' : 'UNMATCHED';
    await client.query(
      `UPDATE bank_transactions SET reconciliation_status = $3 WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId, status],
    );
    return result.rows[0];
  });
}

export async function deleteBankAllocation(
  pool: Db,
  tenantId: string,
  transactionId: string,
  allocationId: string,
): Promise<void> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const transaction = await loadTransaction(client, tenantId, transactionId, true);
    if (transaction.reconciliation_status === 'POSTED') throw new AppError(ErrorCodes.invalidRequest, 'Posted transactions are immutable', 409);
    const result = await client.query(
      `DELETE FROM bank_transaction_allocations WHERE id = $1 AND tenant_id = $2 AND bank_transaction_id = $3`,
      [allocationId, tenantId, transactionId],
    );
    if (result.rowCount === 0) throw new AppError(ErrorCodes.invalidRequest, 'Allocation not found', 404);
    const remaining = await loadAllocations(client, tenantId, transactionId);
    const status = remaining.length === 0 ? 'UNMATCHED' : 'PARTIALLY_MATCHED';
    await client.query(
      `UPDATE bank_transactions SET reconciliation_status = $3 WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId, status],
    );
  });
}

export async function reconcileBankTransaction(
  pool: Db,
  tenantId: string,
  userId: string,
  transactionId: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const transaction = await loadTransaction(client, tenantId, transactionId, true);
    if (transaction.reconciliation_status === 'POSTED') {
      const existing = await loadAllocations(client, tenantId, transactionId);
      return { transaction: { ...transaction, reconciliation_status: 'POSTED' }, allocations: existing, idempotent: true };
    }
    const allocations = await loadAllocations(client, tenantId, transactionId);
    if (allocations.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'No allocations to reconcile', 400);
    const txAmount = new Decimal(transaction.amount);
    const allocatedTotal = allocations.reduce((sum, row) => sum.plus(new Decimal(row.amount)), new Decimal(0));
    if (Math.abs(Number(allocatedTotal.minus(txAmount))) > 0.001) {
      throw new AppError(ErrorCodes.invalidRequest, 'Allocations must equal the transaction amount', 400);
    }
    const bankAccount = await client.query(
      'SELECT ledger_account_id FROM bank_accounts WHERE id = $1 AND tenant_id = $2',
      [transaction.bank_account_id, tenantId],
    );
    if (!bankAccount.rows[0]) throw new AppError(ErrorCodes.invalidRequest, 'Bank account missing ledger mapping', 400);
    const bankLedger = String(bankAccount.rows[0].ledger_account_id);
    const salesSettings = await client.query('SELECT * FROM sales_settings WHERE tenant_id = $1', [tenantId]);
    const purchaseSettings = await client.query('SELECT * FROM purchase_settings WHERE tenant_id = $1', [tenantId]);
    const arAccount = salesSettings.rows[0]?.accounts_receivable_account_id;
    const apAccount = purchaseSettings.rows[0]?.accounts_payable_account_id;

    interface JournalLine { accountId: string; debit: string; credit: string; }
    const lines: JournalLine[] = [];
    for (const allocation of allocations) {
      const amount = money(new Decimal(allocation.amount));
      const type = String(allocation.allocation_type);
      let debit = '0';
      let credit = '0';
      let accountId: string | null;
      if (transaction.direction === 'IN') {
        if (type === 'SALES_INVOICE') {
          if (!arAccount) throw new AppError(ErrorCodes.accountMappingMissing, 'AR account is not configured', 409);
          accountId = String(arAccount);
        } else {
          accountId = allocation.account_id ? String(allocation.account_id) : null;
        }
        credit = amount;
      } else {
        debit = amount;
        if (type === 'PURCHASE_INVOICE') {
          if (!apAccount) throw new AppError(ErrorCodes.accountMappingMissing, 'AP account is not configured', 409);
          accountId = String(apAccount);
        } else {
          accountId = allocation.account_id ? String(allocation.account_id) : null;
        }
      }
      if (!accountId) throw new AppError(ErrorCodes.accountMappingMissing, 'Missing counter account for allocation', 409);
      lines.push({ accountId, debit, credit });
    }
    const bankDebit = transaction.direction === 'IN' ? money(txAmount) : '0';
    const bankCredit = transaction.direction === 'OUT' ? money(txAmount) : '0';
    lines.push({ accountId: bankLedger, debit: bankDebit, credit: bankCredit });
    const businessDate = dateOnly(transaction.accounting_date ?? transaction.booking_date);
    const journalLines = lines.map((line) => ({
      accountId: line.accountId,
      description: `Bank transaction ${String(transaction.id).slice(0, 8)}`,
      debit: line.debit,
      credit: line.credit,
    }));
    const entryId = await createJournalDraftInTransaction(client, tenantId, userId, {
      businessDate,
      description: `Bank transaction ${String(transaction.id).slice(0, 8)}`,
      currencyCode: transaction.currency ?? 'EUR',
      sourceType: 'BANK_TRANSACTION',
      sourceId: transactionId,
      lines: journalLines,
    });
    const entryNumber = await postJournalEntryInTransaction(client, tenantId, entryId, userId);

    for (const allocation of allocations) {
      const type = String(allocation.allocation_type);
      const amount = new Decimal(allocation.amount);
      if (type === 'SALES_INVOICE') {
        const invoice = await client.query(
          `SELECT * FROM sales_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [allocation.target_id, tenantId],
        );
        const row = invoice.rows[0];
        const paid = new Decimal(row.amount_paid ?? 0).plus(amount);
        const open = new Decimal(row.total).minus(new Decimal(row.advance_applied ?? 0))
          .minus(new Decimal(row.credited_amount ?? 0)).minus(paid);
        const status = open.lessThanOrEqualTo(0) ? 'PAID' : paid.greaterThan(0) ? 'PARTIALLY_PAID' : 'UNPAID';
        await client.query(
          `INSERT INTO sales_invoice_payments
             (tenant_id, invoice_id, amount, payment_date, method, reference, note, is_manual, source, bank_transaction_id, created_by)
           VALUES ($1,$2,$3,$4::date,'BANK_TRANSFER',$5,$6,false,'BANK_IMPORT',$7,$8)`,
          [tenantId, allocation.target_id, money(amount), businessDate, transaction.reference ?? null, 'Bank import payment', transactionId, userId],
        );
        await client.query(
          `UPDATE sales_invoices
           SET amount_paid = $3, payment_status = $4,
               paid_at = CASE WHEN $4 = 'PAID' THEN now() ELSE paid_at END
           WHERE id = $1 AND tenant_id = $2`,
          [allocation.target_id, tenantId, money(paid), status],
        );
      }
      if (type === 'PURCHASE_INVOICE') {
        const invoice = await client.query(
          `SELECT * FROM purchase_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [allocation.target_id, tenantId],
        );
        const row = invoice.rows[0];
        const paid = new Decimal(row.amount_paid ?? 0).plus(amount);
        const open = new Decimal(row.total).minus(paid);
        const status = open.lessThanOrEqualTo(0) ? 'PAID' : 'PARTIALLY_PAID';
        await client.query(
          `INSERT INTO purchase_invoice_payments
             (tenant_id, purchase_invoice_id, bank_transaction_id, payment_date, amount, source, reference, created_by)
           VALUES ($1,$2,$3,$4::date,$5,'BANK_IMPORT',$6,$7)`,
          [tenantId, allocation.target_id, transactionId, businessDate, money(amount), transaction.reference ?? null, userId],
        );
        await client.query(
          `UPDATE purchase_invoices
           SET amount_paid = $3, payment_status = $4
           WHERE id = $1 AND tenant_id = $2`,
          [allocation.target_id, tenantId, money(paid), status],
        );
      }
      await client.query(
        `UPDATE bank_transaction_allocations SET posted_journal_entry_id = $3
         WHERE id = $1 AND tenant_id = $2`,
        [allocation.id, tenantId, entryId],
      );
    }
    await client.query(
      `UPDATE bank_transactions SET reconciliation_status = 'POSTED' WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId],
    );
    return {
      transaction: { ...transaction, reconciliation_status: 'POSTED' },
      journal_entry_id: entryId,
      journal_entry_number: entryNumber,
      allocated_total: money(allocatedTotal),
      idempotent: false,
    };
  });
}

export async function reviewBankTransactionNoPost(
  pool: Db,
  tenantId: string,
  transactionId: string,
  reason: string,
): Promise<any> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    const transaction = await loadTransaction(client, tenantId, transactionId, true);
    if (transaction.reconciliation_status === 'POSTED') throw new AppError(ErrorCodes.invalidRequest, 'Transaction is already posted', 409);
    if (!reason || reason.trim().length < 3) throw new AppError(ErrorCodes.invalidRequest, 'Reason is required', 400);
    await client.query(
      `UPDATE bank_transactions SET reconciliation_status = 'REVIEWED_NO_POST' WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId],
    );
    return { transaction_id: transactionId, status: 'REVIEWED_NO_POST' };
  });
}

export async function bankingReconciliationSummary(
  pool: Db,
  tenantId: string,
  filters: { bankAccountId?: string; from?: string; to?: string } = {},
): Promise<any> {
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
    const where = clauses.join(' AND ');
    const result = await client.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE reconciliation_status = 'UNMATCHED')::int AS unmatched,
         count(*) FILTER (WHERE reconciliation_status = 'SUGGESTED')::int AS suggested,
         count(*) FILTER (WHERE reconciliation_status = 'PARTIALLY_MATCHED')::int AS partial,
         count(*) FILTER (WHERE reconciliation_status = 'MATCHED')::int AS matched,
         count(*) FILTER (WHERE reconciliation_status = 'POSTED')::int AS posted,
         count(*) FILTER (WHERE reconciliation_status = 'REVIEWED_NO_POST')::int AS reviewed,
         COALESCE(sum(amount) FILTER (WHERE direction = 'IN'), 0)::text AS inflow,
         COALESCE(sum(amount) FILTER (WHERE direction = 'OUT'), 0)::text AS outflow
       FROM bank_transactions WHERE ${where}`,
      values,
    );
    return result.rows[0] ?? {};
  });
}
