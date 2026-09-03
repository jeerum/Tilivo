import { test, expect, type Page } from '@playwright/test';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function jsonApi(
  page: Page,
  tenantId: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; payload: any }> {
  const attempt = async (retried: boolean): Promise<{ status: number; payload: any }> => {
    const result = await page.evaluate(
      async ({ apiUrl, apiMethod, apiBody, apiTenant }) => {
      const csrf = document.cookie
        .split('; ')
        .find((part) => part.startsWith('tilivo_csrf='))
        ?.split('=').slice(1).join('=') ?? '';
      const response = await fetch(apiUrl, {
        method: apiMethod,
        headers: {
          accept: 'application/json',
          ...(apiBody ? { 'content-type': 'application/json' } : {}),
          'x-csrf-token': csrf,
          'x-tilivo-tenant-id': apiTenant,
        },
        body: apiBody ? JSON.stringify(apiBody) : undefined,
      });
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, payload };
      },
      { apiUrl: url, apiMethod: method, apiBody: body ?? null, apiTenant: tenantId },
    );
    const rateLimited =
      result.status === 429 &&
      result.payload?.error?.message &&
      String(result.payload.error.message).includes('Rate limit');
    if (rateLimited && !retried) {
      await page.waitForTimeout(22_000);
      return attempt(true);
    }
    return result;
  };
  return attempt(false);
}

async function tenantId(page: Page): Promise<string> {
  const tenants = await jsonApi(page, '', 'GET', '/api/v1/tenants');
  const tenant = tenants.payload?.tenants?.[0];
  if (!tenant?.id) throw new Error('No tenant found for e2e user');
  return String(tenant.id);
}

async function seedVatBase(page: Page, tenantId: string, year: number): Promise<{
  periodId: string;
  date: string;
  customerId: string;
  customerName: string;
  supplierId: string;
  saleRcCodeId: string;
  purchaseStdCodeId: string;
  expenseAccountId: string;
}> {
  const seed = `V${Math.random().toString(36).slice(2, 8)}`;
  const runId = `${suffix}-${Math.random().toString(36).slice(2, 6)}`;
  const revenue = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}0`, name: `VAT Revenue ${suffix}`, type: 'REVENUE',
  });
  const ar = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}1`, name: `VAT AR ${suffix}`, type: 'ASSET',
  });
  const outputVat = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}2`, name: `VAT output ${suffix}`, type: 'LIABILITY',
  });
  const expense = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}3`, name: `VAT expense ${suffix}`, type: 'EXPENSE',
  });
  const ap = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}4`, name: `VAT AP ${suffix}`, type: 'LIABILITY',
  });
  const inputVat = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}5`, name: `VAT input ${suffix}`, type: 'ASSET',
  });
  const rcInput = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}6`, name: `VAT RC input ${suffix}`, type: 'ASSET',
  });
  const rcOutput = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: `${seed}7`, name: `VAT RC output ${suffix}`, type: 'LIABILITY',
  });
  const fiscal = await jsonApi(page, tenantId, 'POST', '/api/v1/fiscal-years', {
    name: `V09 FY ${suffix} ${year}`,
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
  });
  if (fiscal.status !== 201) {
    throw new Error(`fiscal year seed failed: ${JSON.stringify(fiscal.payload)}`);
  }
  const fiscalYearId = String(fiscal.payload.fiscal_year.id);
  const period = await jsonApi(page, tenantId, 'POST', '/api/v1/accounting-periods', {
    fiscal_year_id: fiscalYearId,
    name: `V09 P ${runId}`,
    start_date: `${year}-09-01`,
    end_date: `${year}-09-30`,
  });
  if (period.status !== 201) {
    throw new Error(`period seed failed: ${JSON.stringify(period.payload)}`);
  }
  const settings = await jsonApi(page, tenantId, 'GET', '/api/v1/sales/settings');
  await jsonApi(page, tenantId, 'PATCH', '/api/v1/sales/settings', {
    accounts_receivable_account_id: String(ar.payload.account.id),
    default_sales_revenue_account_id: String(revenue.payload.account.id),
    tax_payable_account_id: String(outputVat.payload.account.id),
    default_currency: 'EUR',
    payment_reference_type: 'FI_DOMESTIC',
  });
  await jsonApi(page, tenantId, 'PATCH', '/api/v1/purchase-settings', {
    accounts_payable_account_id: String(ap.payload.account.id),
    default_expense_account_id: String(expense.payload.account.id),
    input_vat_account_id: String(inputVat.payload.account.id),
    reverse_charge_input_account_id: String(rcInput.payload.account.id),
    reverse_charge_output_account_id: String(rcOutput.payload.account.id),
    auto_post_on_approval: false,
    require_separate_approver: false,
  });
  const codes = await jsonApi(page, tenantId, 'GET', '/api/v1/tax-codes?current=true');
  const list = codes.payload.tax_codes as Array<{ id: string; code: string; direction: string }>;
  const saleRc = list.find((row) => row.code === 'FI_CONSTRUCTION_RC_SALE');
  const purchaseStd = list.find((row) => row.code === 'FI_PURCHASE_STD');
  const customer = await jsonApi(page, tenantId, 'POST', '/api/v1/customers', {
    name: `VAT RC customer ${runId}`,
    country_code: 'FI',
    business_id: 'FI12345678',
    vat_id: 'FI12345678',
    language: 'fi',
    default_currency: 'EUR',
  });
  const supplier = await jsonApi(page, tenantId, 'POST', '/api/v1/suppliers', {
    name: `VAT supplier ${suffix}`,
    country_code: 'FI',
    default_currency: 'EUR',
  });
  if (!saleRc || !purchaseStd || settings.status >= 400) {
    throw new Error(`VAT seed failed ${JSON.stringify({ saleRc, purchaseStd, settings })}`);
  }
  return {
    periodId: String(period.payload.period.id),
    customerName: `VAT RC customer ${runId}`,
    date: `${year}-09-10`,
    customerId: String(customer.payload.customer.id),
    supplierId: String(supplier.payload.supplier.id),
    saleRcCodeId: String(saleRc.id),
    purchaseStdCodeId: String(purchaseStd.id),
    expenseAccountId: String(expense.payload.account.id),
  };
}

test.describe('v0.9 VAT browser flows', () => {
  test('construction reverse-charge sale: tax selector, zero VAT preview, legal note and VAT summary', async ({ page }) => {
    page.on('dialog', async (dialog) => dialog.accept());
    await page.goto('/');
    const tenant = await tenantId(page);
    const year = { desktop: 2026, tablet: 2036, mobile: 2046 }[test.info().project.name] ?? 2026;
    const seeded = await seedVatBase(page, tenant, year);

    await page.goto('/sales');
    await page.locator('[data-testid="tab-invoices"]').click();
    const draftDetails = page.locator('[data-testid="invoices-panel"] details').first();
    if (!(await page.locator('[data-testid="invoice-draft-form"]').isVisible().catch(() => false))) {
      await draftDetails.locator('summary').click();
    }
    const form = page.locator('[data-testid="invoice-draft-form"]');
    await form.locator('select').first().selectOption(seeded.customerId);
    await form.locator('input[type=date]').first().fill(seeded.date);
    await form.getByLabel(/(Description|Kirjeldus) 1/).fill(`E2E construction RC ${suffix}`);
    await form.getByLabel(/(Unit price|Ühiku hind) 1/).fill('1000.00');
    await form.getByLabel(/(Tax code|Maksukood) 1/).selectOption(seeded.saleRcCodeId);

    await expect(page.locator('[data-testid="line-tax-preview-1"]')).toContainText('VAT 0.00');
    await expect(page.locator('[data-testid="totals-preview"]')).toContainText('1000.00');
    await page.locator('[data-testid="save-draft"]').click();
    await expect(page.locator('[data-testid="totals-preview"]')).toContainText('1000.00');

    const row = page.locator('[data-testid="invoices-table"] tr').filter({ hasText: seeded.customerName });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: /(Issue|Esita)/i }).click();
    await expect(row).toContainText(/\d{4}-/);
    await row.getByRole('button', { name: /(Open invoice|Ava arve)/i }).click();
    await expect(page.locator('[data-testid="invoice-detail"]')).toContainText('1000.00');
    const notes = page.locator('[data-testid="invoice-legal-notes"]');
    await expect(notes).toContainText('8 c');

    await page.goto('/accounting');
    await page.locator('[data-testid="tab-vat"]').click();
    const vatPanel = page.locator('[data-testid="vat-panel"]');
    await expect(vatPanel).toBeVisible();
    await vatPanel.locator('[data-testid="vat-period-select"]').selectOption(seeded.periodId);
    await expect(vatPanel.locator('[data-testid="vat-period-select"]')).toHaveValue(seeded.periodId);
    await page.locator('[data-testid="vat-refresh"]').click();
    const summaryRow = vatPanel.locator('[data-testid="vat-summary-table"] tr').filter({ hasText: /Construction|Ehitussektori/ });
    await expect(summaryRow).toContainText('1000.00');
    await expect(page.locator('[data-testid="vat-summary-totals"]')).toContainText('0.00');
  });

  test('partial-deductibility purchase posts input VAT and journal is inspectable', async ({ page }) => {
    await page.goto('/');
    const tenant = await tenantId(page);
    const year = { desktop: 2027, tablet: 2037, mobile: 2047 }[test.info().project.name] ?? 2027;
    const seeded = await seedVatBase(page, tenant, year);

    const draft = await jsonApi(page, tenant, 'POST', '/api/v1/purchases', {
      supplier_id: seeded.supplierId,
      supplier_invoice_number: `E2E-P-${suffix}`,
      invoice_date: seeded.date,
      due_date: `${year}-10-10`,
      lines: [
        {
          description: `E2E partial VAT ${suffix}`,
          quantity: '1',
          unit_price: '100.00',
          tax_code_id: seeded.purchaseStdCodeId,
          deductible_percent: '50',
          expense_account_id: seeded.expenseAccountId,
        },
      ],
    });
    expect(draft.status).toBe(201);
    const purchaseId = String(draft.payload.purchase.id);
    for (const action of ['review', 'approve', 'post'] as const) {
      const transition = await jsonApi(page, tenant, 'POST', `/api/v1/purchases/${purchaseId}/${action}`);
      if (transition.status !== 200) {
        throw new Error(`purchase transition ${action} failed: ${JSON.stringify(transition.payload)}`);
      }
    }
    const posted = await jsonApi(page, tenant, 'GET', `/api/v1/purchases/${purchaseId}`);
    const journalId = String(posted.payload.purchase.accounting_journal_entry_id);

    await page.goto('/accounting');
    const journalRow = page.locator('[data-testid="journals-table"] tr').filter({
      hasText: `E2E-P-${suffix}`,
    });
    await expect(journalRow).toHaveCount(1);
    await journalRow.getByRole('button', { name: /(View|Vaata)/i }).click();
    await expect(page.locator('[data-testid="journal-detail"]')).toContainText(/(Purchase invoice|Ostuarve)/);
    await expect(page.locator('[data-testid="journal-detail"]')).toContainText('12.75');
    await expect(page.locator('[data-testid="journal-detail"]')).toContainText('112.75');

    await page.locator('[data-testid="tab-vat"]').click();
    await page.locator('[data-testid="vat-period-select"]').selectOption(seeded.periodId);
    await expect(page.locator('[data-testid="vat-period-select"]')).toHaveValue(seeded.periodId);
    await page.locator('[data-testid="vat-refresh"]').click();
    const summary = page.locator('[data-testid="vat-summary-table"] tr').filter({ hasText: /Domestic purchase|Soome ost/ });
    await expect(summary).toContainText('12.75');
    void journalId;
  });
});
