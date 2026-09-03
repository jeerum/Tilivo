import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { SalesFixture, expectStatus } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.13 banking', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      DOCUMENT_STORAGE_DIR: 'banking-test',
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool });
    // Keep reruns isolated from users left by an earlier local verification run.
    fixture = new SalesFixture(app, pool, `bank13-${Date.now().toString(36)}`);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function setupTenant(name: string, extraMappings = true) {
    const auth = await fixture.setupOwner(name);
    const accounts = await fixture.standardAccountingSetup(auth);
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    const bankLedger = await fixture.createAccount(auth, '1010', 'Bank account EUR', 'ASSET');
    const feeAccount = await fixture.createAccount(auth, '6310', 'Bank fees', 'EXPENSE');
    const interestAccount = await fixture.createAccount(auth, '7510', 'Interest income', 'REVENUE');
    const clearingAccount = await fixture.createAccount(auth, '1390', 'Card clearing', 'ASSET');
    const unallocatedAccount = await fixture.createAccount(auth, '2980', 'Customer unallocated', 'LIABILITY');
    const bankAccount = await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/accounts',
      body: { name: 'Operating account', iban: 'FI21 1234 5600 0007 85', bic: 'OKOYFIHH', currency: 'EUR', ledger_account_id: bankLedger, is_default: true },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(bankAccount, 201, 'create bank account');
    if (extraMappings) {
      const mapped = await fixture.request({
        method: 'PATCH',
        url: '/api/v1/banking/settings',
        body: {
          bank_fee_expense_account_id: feeAccount,
          interest_income_account_id: interestAccount,
          card_clearing_account_id: clearingAccount,
          customer_unallocated_account_id: unallocatedAccount,
        },
        cookie: auth.cookie,
        csrf: auth.csrf,
        tenantId: auth.tenantId,
      });
      expectStatus(mapped, 200, 'map banking settings');
    }
    const customerId = await fixture.createCustomer(auth, `${name} Customer`);
    return { auth, accounts, bankLedger, bankAccountId: String(bankAccount.body.account.id), customerId };
  }

  function csv(rows: Array<[string, string, string, string, string]>): string {
    return `Booking date;Reference;Counterparty;Amount;Message\n${rows.map((row) => row.join(';')).join('\n')}`;
  }

  it('creates and defaults a bank account and rejects invalid IBANs', async () => {
    const { auth, bankLedger, bankAccountId } = await setupTenant('Bank Account Oy', false);
    const invalid = await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/accounts',
      body: { name: 'Bad', iban: 'FI00 0000 0000 0000 00', ledger_account_id: bankLedger },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(invalid.status).toBe(400);
    const list = await fixture.request({
      method: 'GET',
      url: '/api/v1/banking/accounts',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const account = list.body.accounts.find((row: any) => row.id === bankAccountId);
    expect(account.is_default).toBe(true);
  });

  it('imports a CSV statement once and rejects duplicate files', async () => {
    const { auth, bankAccountId } = await setupTenant('Import Oy');
    const content = csv([['2026-09-10', '12345672', 'Import Customer', '400,00', 'Invoice 1']]);
    const preview = await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/imports/preview',
      body: { bank_account_id: bankAccountId, filename: 'statement.csv', content },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(preview, 200, 'preview');
    expect(preview.body.preview.row_count).toBe(1);
    const imported = await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/imports',
      body: { bank_account_id: bankAccountId, filename: 'statement.csv', content },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(imported, 201, 'import');
    expect(imported.body.imported).toBe(1);
    const duplicate = await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/imports',
      body: { bank_account_id: bankAccountId, filename: 'statement.csv', content },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(duplicate.status).toBe(409);
  });

  it('matches an exact sales reference, allocates partially and reconciles through Accounting Core', async () => {
    const { auth, accounts, customerId, bankAccountId } = await setupTenant('Sales Match Oy');
    const draft = await fixture.createDraft(
      auth,
      customerId,
      [{ description: 'Consulting', quantity: '1', unit_price: '400.00', tax_code_id: accounts.taxStandardId }],
      { issue_date: '2026-09-10' },
    );
    const issued = await fixture.issueInvoice(auth, draft.id);
    const invoice = issued.invoice;
    const reference = String(invoice.payment_reference);
    const content = csv([[String(invoice.issue_date), reference, 'Sales Match Oy Customer', '496,00', 'Payment']]);
    await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/imports',
      body: { bank_account_id: bankAccountId, filename: 'payment.csv', content },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    const transactions = await fixture.request({
      method: 'GET',
      url: `/api/v1/banking/transactions?unmatched=true`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const tx = transactions.body.transactions.find((row: any) => row.reference === reference);
    expect(tx).toBeTruthy();
    const suggestions = await fixture.request({
      method: 'GET',
      url: `/api/v1/banking/transactions/${tx.id}/suggestions`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(suggestions.body.suggestions[0]?.confidence).toBe(1);
    const allocation = await fixture.request({
      method: 'POST',
      url: `/api/v1/banking/transactions/${tx.id}/allocations`,
      body: { allocation_type: 'SALES_INVOICE', target_id: invoice.id, amount: '496.00' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(allocation, 201, 'create allocation');
    const reconciled = await fixture.request({
      method: 'POST',
      url: `/api/v1/banking/transactions/${tx.id}/reconcile`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(reconciled, 200, 'reconcile');
    expect(reconciled.body.journal_entry_id).toBeTruthy();
    const after = await fixture.request({
      method: 'GET',
      url: `/api/v1/sales/invoices/${invoice.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(after.body.invoice.payment_status).toBe('PAID');
    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${reconciled.body.journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expect(String(journal.body.journal.source_type)).toBe('BANK_TRANSACTION');
    const retry = await fixture.request({
      method: 'POST',
      url: `/api/v1/banking/transactions/${tx.id}/reconcile`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expect(retry.body.idempotent).toBe(true);
  });

  it('reconciles a bank fee allocation with the mapped expense account', async () => {
    const { auth, bankAccountId } = await setupTenant('Fee Oy');
    const content = csv([['2026-09-10', '', 'Bank Oy', '-12,50', 'Monthly fee']]);
    await fixture.request({
      method: 'POST',
      url: '/api/v1/banking/imports',
      body: { bank_account_id: bankAccountId, filename: 'fee.csv', content },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    const transactions = await fixture.request({
      method: 'GET',
      url: '/api/v1/banking/transactions',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const tx = transactions.body.transactions.find((row: any) => row.message === 'Monthly fee');
    const allocation = await fixture.request({
      method: 'POST',
      url: `/api/v1/banking/transactions/${tx.id}/allocations`,
      body: { allocation_type: 'BANK_FEE', amount: '12.50' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(allocation, 201, 'fee allocation');
    const reconciled = await fixture.request({
      method: 'POST',
      url: `/api/v1/banking/transactions/${tx.id}/reconcile`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(reconciled, 200, 'fee reconcile');
    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${reconciled.body.journal_entry_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const lines = journal.body.journal.lines as Array<{ account_code: string; debit: string; credit: string }>;
    if (!lines.some((line) => line.account_code === '6310' && Number(line.debit) > 0)) {
      throw new Error(`expected fee line: ${JSON.stringify(lines)}`);
    }
  });
});
