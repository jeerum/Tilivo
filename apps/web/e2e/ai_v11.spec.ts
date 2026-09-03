import { test, expect, type Page } from '@playwright/test';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function jsonApi(
  page: Page,
  tenantId: string,
  method: 'GET' | 'POST',
  url: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; payload: any }> {
  return page.evaluate(
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
}

async function tenantId(page: Page): Promise<string> {
  await page.goto('/');
  const tenants = await jsonApi(page, '', 'GET', '/api/v1/tenants');
  return String(tenants.payload.tenants[0].id);
}

async function seed(page: Page, tenant: string, year: number): Promise<{ documentId: string; merchant: string; officeCode: string }> {
  const seed = `A${Math.random().toString(36).slice(2, 8)}`;
  const officeCode = `${seed}1`;
  const office = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: officeCode, name: 'Office supplies', type: 'EXPENSE',
  });
  const inputVat = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: `${seed}0`, name: `AI input VAT ${suffix}`, type: 'ASSET',
  });
  const fiscal = await jsonApi(page, tenant, 'POST', '/api/v1/fiscal-years', {
    name: `AI FY ${suffix} ${year}`, start_date: `${year}-01-01`, end_date: `${year}-12-31`,
  });
  const period = await jsonApi(page, tenant, 'POST', '/api/v1/accounting-periods', {
    fiscal_year_id: String(fiscal.payload.fiscal_year.id),
    name: `AI P ${suffix}`, start_date: `${year}-09-01`, end_date: `${year}-09-30`,
  });
  const codes = await jsonApi(page, tenant, 'GET', '/api/v1/tax-codes?current=true&direction=PURCHASE');
  const tax = codes.payload.tax_codes.find((row: any) => row.code === 'FI_PURCHASE_STD');
  const merchant = `Office Merchant ${suffix}`;
  if (!tax || period.status !== 201) throw new Error('ai seed failed');
  await jsonApi(page, tenant, 'PATCH', '/api/v1/purchase-settings', {
    default_expense_account_id: String(office.payload.account.id),
    input_vat_account_id: String(inputVat.payload.account.id),
    accounts_payable_account_id: String(office.payload.account.id),
    cash_account_id: String(office.payload.account.id),
    company_card_account_id: String(office.payload.account.id),
    employee_payable_account_id: String(office.payload.account.id),
  });
  const date = `${year}-09-10`;
  const draft = await jsonApi(page, tenant, 'POST', '/api/v1/purchases', {
    merchant_name: merchant,
    invoice_date: date,
    document_type: 'RECEIPT',
    payment_method: 'COMPANY_CARD',
    payment_status: 'PAID_AT_PURCHASE',
    description: 'Office supplies',
    lines: [{ description: 'Printer paper', quantity: '1', unit_price: '25.50', tax_code_id: String(tax.id) }],
  });
  if (draft.status !== 201) throw new Error(`draft failed ${JSON.stringify(draft.payload)}`);
  return { documentId: String(draft.payload.purchase.id), merchant, officeCode };
}

test.describe('v0.11 AI classification browser flow', () => {
  test('classify receipt, show suggestion, apply and post', async ({ page }) => {
    const tenant = await tenantId(page);
    const year = { desktop: 2026, tablet: 2036, mobile: 2046 }[test.info().project.name] ?? 2026;
    const seeded = await seed(page, tenant, year);

    await page.goto('/purchases');
    await page.locator('[data-testid="tab-receipts"]').click();
    const row = page.locator('[data-testid="receipts-table"] tr').filter({ hasText: seeded.merchant });
    await row.getByRole('button', { name: /(Open|Ava)/i }).first().click();
    await expect(page.locator('[data-testid="receipt-detail"]')).toBeVisible();
    await page.locator('[data-testid="ai-classify"]').click();
    await expect(page.locator('[data-testid="ai-panel"]')).toContainText(/(Kulukonto|Expense account)/);
    await expect(page.locator('[data-testid="ai-panel"]')).toContainText(/(94%|96%)/);
    await page.locator('[data-testid="ai-apply-all"]').click();

    for (const action of ['review', 'approve', 'post'] as const) {
      const result = await jsonApi(page, tenant, 'POST', `/api/v1/purchases/${seeded.documentId}/${action}`);
      if (result.status !== 200) throw new Error(`post step ${action} failed ${JSON.stringify(result.payload)}`);
    }
    const detail = await jsonApi(page, tenant, 'GET', `/api/v1/purchases/${seeded.documentId}`);
    expect(String(detail.payload.purchase.accounting_journal_entry_id)).toBeTruthy();
  });
});
