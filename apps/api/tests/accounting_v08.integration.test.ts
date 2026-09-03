import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { SalesFixture, expectStatus, type SalesAuth } from './salesTestSupport';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('v0.8 accounting core', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let fixture: SalesFixture;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool });
    fixture = new SalesFixture(app, pool, 'v08acc');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function setupAccounting(auth: SalesAuth) {
    const std = await fixture.standardAccountingSetup(auth);
    const bankAccountId = await fixture.createAccount(auth, '1010', 'Bank account', 'ASSET');
    const expenseAccountId = await fixture.createAccount(auth, '5000', 'Purchases expense', 'EXPENSE');
    const apAccountId = await fixture.createAccount(auth, '2400', 'Accounts payable', 'LIABILITY');
    const inputVatAccountId = await fixture.createAccount(auth, '1710', 'Input VAT', 'ASSET');
    const openingEquityId = await fixture.createAccount(auth, '2900', 'Opening equity', 'EQUITY');
    return { ...std, bankAccountId, expenseAccountId, apAccountId, inputVatAccountId, openingEquityId };
  }

  async function postOpening(
    auth: SalesAuth,
    businessDate: string,
    debitAccountId: string,
    creditAccountId: string,
    amount: string,
    note?: string,
  ) {
    return fixture.request({
      method: 'POST',
      url: '/api/v1/opening-balances',
      body: {
        business_date: businessDate,
        note,
        lines: [
          {
            account_id: debitAccountId,
            debit: amount,
            credit: '0',
            cost_center: 'HQ',
          },
          { account_id: creditAccountId, debit: '0', credit: amount },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
  }

  async function createSupplier(auth: SalesAuth, name: string) {
    const result = await fixture.request({
      method: 'POST',
      url: '/api/v1/suppliers',
      body: { name, business_id: 'FI12345678', vat_id: 'FI12345678', country_code: 'FI' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(result, 201, 'create supplier');
    return result.body.supplier as any;
  }

  async function purchaseLifecycle(
    auth: SalesAuth,
    accounts: Awaited<ReturnType<typeof setupAccounting>>,
  ) {
    const settings = await fixture.request({
      method: 'PATCH',
      url: '/api/v1/purchase-settings',
      body: {
        accounts_payable_account_id: accounts.apAccountId,
        default_expense_account_id: accounts.expenseAccountId,
        input_vat_account_id: accounts.inputVatAccountId,
        auto_post_on_approval: false,
        require_separate_approver: false,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(settings, 200, 'purchase settings');
    const supplier = await createSupplier(auth, 'V08 Supplier Oy');
    const created = await fixture.request({
      method: 'POST',
      url: '/api/v1/purchases',
      body: {
        supplier_id: supplier.id,
        supplier_invoice_number: `V08-${Date.now().toString(36)}`,
        invoice_date: '2026-09-10',
        due_date: '2026-10-10',
        lines: [
          {
            description: 'V08 materials',
            quantity: '1',
            unit_price: '100.00',
            tax_code_id: accounts.taxStandardId,
            expense_account_id: accounts.expenseAccountId,
          },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(created, 201, 'purchase draft');
    const purchaseId = String(created.body.purchase.id);
    for (const action of ['review', 'approve', 'post']) {
      const transition = await fixture.request({
        method: 'POST',
        url: `/api/v1/purchases/${purchaseId}/${action}`,
        cookie: auth.cookie,
        csrf: auth.csrf,
        tenantId: auth.tenantId,
      });
      expectStatus(transition, 200, `purchase ${action}`);
    }
    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/purchases/${purchaseId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(detail, 200, 'purchase detail');
    return { purchaseId, journalId: String(detail.body.purchase.accounting_journal_entry_id) };
  }

  it('posts balanced opening balances and blocks a duplicate on the same date', async () => {
    const auth = await fixture.setupOwner('V08 Opening Balances');
    const accounts = await setupAccounting(auth);

    const first = await postOpening(auth, '2026-09-05', accounts.bankAccountId, accounts.openingEquityId, '5000.00', 'migration from old software');
    expectStatus(first, 201, 'opening balance');
    expect(String(first.body.entry_number)).toMatch(/^2026-/);

    const duplicate = await postOpening(auth, '2026-09-05', accounts.bankAccountId, accounts.openingEquityId, '100.00');
    expectStatus(duplicate, 409, 'duplicate opening balance');
    expect(duplicate.body.error.code).toBe('ACC-004');

    const listed = await fixture.request({
      method: 'GET',
      url: '/api/v1/journals?source_type=OPENING_BALANCE',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(listed, 200, 'opening journal list');
    expect(listed.body.journals).toHaveLength(1);
    expect(listed.body.journals[0]!.source_type).toBe('OPENING_BALANCE');

    const detail = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${first.body.journal_id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(detail, 200, 'opening journal detail');
    expect(detail.body.journal.status).toBe('POSTED');
    expect(detail.body.journal.document_date).toBe('2026-09-05');
    const lines = detail.body.journal.lines as Array<{ cost_center: string | null }>;
    expect(lines.some((line) => line.cost_center === 'HQ')).toBe(true);
  });

  it('closed periods block opening balances and reopening restores posting', async () => {
    const auth = await fixture.setupOwner('V08 Period Lock');
    const accounts = await setupAccounting(auth);
    const closed = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${accounts.periodId}`,
      body: { status: 'CLOSED' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(closed, 200, 'close period');

    const blocked = await postOpening(auth, '2026-09-06', accounts.bankAccountId, accounts.openingEquityId, '100.00');
    expectStatus(blocked, 409, 'opening blocked in closed period');
    expect(blocked.body.error.code).toBe('PERIOD-002');

    const reopened = await fixture.request({
      method: 'POST',
      url: `/api/v1/accounting-periods/${accounts.periodId}/reopen`,
      body: { reason: 'reopen for v0.8 gate test' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(reopened, 200, 'reopen period');
    const allowed = await postOpening(auth, '2026-09-06', accounts.bankAccountId, accounts.openingEquityId, '100.00');
    expectStatus(allowed, 201, 'opening after reopen');
  });

  it('validates journal lines: exclusivity, zero lines and balance on posting', async () => {
    const auth = await fixture.setupOwner('V08 Validation');
    const accounts = await setupAccounting(auth);

    const bothSides = await fixture.request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-09-10',
        description: 'invalid both sides',
        lines: [
          { account_id: accounts.bankAccountId, debit: '10', credit: '10' },
          { account_id: accounts.openingEquityId, debit: '0', credit: '10' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(bothSides, 400, 'both sides rejected');

    const zeroDraft = await fixture.request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-09-10',
        description: 'zero draft',
        lines: [
          { account_id: accounts.bankAccountId, debit: '0', credit: '0' },
          { account_id: accounts.openingEquityId, debit: '0', credit: '0' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(zeroDraft, 201, 'zero draft allowed as draft');
    const zeroPost = await fixture.request({
      method: 'POST',
      url: `/api/v1/journals/${zeroDraft.body.journal_id}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(zeroPost, 400, 'zero lines cannot be posted');

    const unbalanced = await fixture.request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-09-10',
        description: 'unbalanced draft',
        lines: [
          { account_id: accounts.bankAccountId, debit: '100', credit: '0', cost_center: 'KULU' },
          { account_id: accounts.openingEquityId, debit: '0', credit: '90' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(unbalanced, 201, 'unbalanced draft allowed');
    const unbalancedPost = await fixture.request({
      method: 'POST',
      url: `/api/v1/journals/${unbalanced.body.journal_id}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(unbalancedPost, 422, 'unbalanced posting rejected');

    const balanced = await fixture.request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-09-10',
        description: 'balanced draft with dimension',
        lines: [
          { account_id: accounts.bankAccountId, debit: '100', credit: '0', cost_center: 'KULU' },
          { account_id: accounts.openingEquityId, debit: '0', credit: '100' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(balanced, 201, 'balanced draft');
    const balancedPost = await fixture.request({
      method: 'POST',
      url: `/api/v1/journals/${balanced.body.journal_id}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(balancedPost, 200, 'balanced posting');
  });

  it('reversal mirrors dimensions and links back to the original entry', async () => {
    const auth = await fixture.setupOwner('V08 Reversal Link');
    const accounts = await setupAccounting(auth);
    const draft = await fixture.request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-09-12',
        document_date: '2026-09-11',
        description: 'reversible with project code',
        lines: [
          { account_id: accounts.bankAccountId, debit: '250.00', credit: '0', project_code: 'OBJ-1' },
          { account_id: accounts.openingEquityId, debit: '0', credit: '250.00' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(draft, 201, 'draft');
    const originalId = String(draft.body.journal_id);
    const posted = await fixture.request({
      method: 'POST',
      url: `/api/v1/journals/${originalId}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(posted, 200, 'post');

    const reversed = await fixture.request({
      method: 'POST',
      url: `/api/v1/journals/${originalId}/reverse`,
      body: { reason: 'gate test reversal' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(reversed, 200, 'reverse');

    const listed = await fixture.request({
      method: 'GET',
      url: '/api/v1/journals?limit=100',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    const reversal = (listed.body.journals as any[]).find(
      (entry: any) => String(entry.reversal_of_entry_id) === originalId,
    );
    expect(reversal).toBeTruthy();
    expect(reversal.source_type).toBe('JOURNAL_REVERSAL');
    expect(reversal.document_date).toBe('2026-09-11');
    const reversalDetail = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${reversal.id}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(reversalDetail, 200, 'reversal detail');
    const reversalLines = reversalDetail.body.journal.lines as Array<{ project_code: string | null }>;
    expect(reversalLines.some((line) => line.project_code === 'OBJ-1')).toBe(true);
  });

  it('sales invoice posting is traceable and cannot create a second journal', async () => {
    const auth = await fixture.setupOwner('V08 Sales Trace');
    const accounts = await setupAccounting(auth);
    await fixture.configureSales(auth, {
      arAccountId: accounts.arAccountId,
      revenueAccountId: accounts.revenueAccountId,
      taxPayableAccountId: accounts.taxPayableAccountId,
    });
    const customerId = await fixture.createCustomer(auth, 'V08 Customer Oy');
    const invoice = await fixture.createDraft(auth, customerId, [
      { description: 'V08 goods', quantity: '1', unit_price: '500.00', tax_code_id: accounts.taxStandardId },
    ]);
    const issued = await fixture.issueInvoice(auth, String(invoice.id));
    const journalId = String(issued.journal_entry_id);

    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${journalId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(journal, 200, 'sales journal');
    expect(journal.body.journal.source_type).toBe('SALES_INVOICE');
    expect(String(journal.body.journal.source_id)).toBe(String(invoice.id));

    const secondIssue = await fixture.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoice.id}/issue`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(secondIssue, 409, 'duplicate issue blocked');
    const journalList = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals?source_type=SALES_INVOICE&limit=100`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(journalList, 200, 'sales journal list');
    expect(journalList.body.journals).toHaveLength(1);
  });

  it('purchase invoice posting is traceable and cannot create a second journal', async () => {
    const auth = await fixture.setupOwner('V08 Purchase Trace');
    const accounts = await setupAccounting(auth);
    const { purchaseId, journalId } = await purchaseLifecycle(auth, accounts);
    const journal = await fixture.request({
      method: 'GET',
      url: `/api/v1/journals/${journalId}`,
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(journal, 200, 'purchase journal');
    expect(journal.body.journal.source_type).toBe('PURCHASE_INVOICE');
    expect(String(journal.body.journal.source_id)).toBe(purchaseId);

    const secondPost = await fixture.request({
      method: 'POST',
      url: `/api/v1/purchases/${purchaseId}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(secondPost, 409, 'duplicate purchase post blocked');
  });

  it('records accounting audit events and inactive accounts block posting', async () => {
    const auth = await fixture.setupOwner('V08 Audit + Inactive');
    const accounts = await setupAccounting(auth);
    const opening = await postOpening(auth, '2026-09-15', accounts.bankAccountId, accounts.openingEquityId, '10.00');
    expectStatus(opening, 201, 'opening');

    const audit = await fixture.request({
      method: 'GET',
      url: '/api/v1/audit?limit=50',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
    });
    expectStatus(audit, 200, 'audit list');
    const actions = (audit.body.audit as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toContain('OPENING_BALANCE.POSTED');
    expect(actions).toContain('ACCOUNT.CREATED');

    const inactiveAccount = await fixture.createAccount(auth, '1999', 'Inactive bank', 'ASSET');
    const deactivated = await fixture.request({
      method: 'PATCH',
      url: `/api/v1/accounts/${inactiveAccount}`,
      body: { is_active: false },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(deactivated, 200, 'deactivate account');
    expect(deactivated.body.account.is_active).toBe(false);

    const draft = await fixture.request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-09-16',
        description: 'inactive account draft',
        lines: [
          { account_id: inactiveAccount, debit: '10', credit: '0' },
          { account_id: accounts.openingEquityId, debit: '0', credit: '10' },
        ],
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(draft, 201, 'draft with inactive account');
    const blockedPost = await fixture.request({
      method: 'POST',
      url: `/api/v1/journals/${draft.body.journal_id}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
    });
    expectStatus(blockedPost, 400, 'inactive account blocks posting');
    expect(blockedPost.body.error.code).toBe('ACC-002');
  });
});
