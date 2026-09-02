import { test, expect, type Page } from '@playwright/test';

async function jsonApi(
  page: Page,
  tenantId: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: Record<string, unknown>,
): Promise<any> {
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
          'content-type': 'application/json',
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
  return result;
}

async function findQaTenant(page: Page): Promise<{ id: string; name: string }> {
  const tenants = await jsonApi(page, '', 'GET', '/api/v1/tenants');
  const qa = tenants.payload?.tenants?.find((tenant: any) =>
    String(tenant.name).includes('E2E Accounting QA Tenant'),
  );
  if (!qa) throw new Error('E2E Accounting QA Tenant not found');
  return { id: String(qa.id), name: String(qa.name) };
}

async function seedAccounting(page: Page, tenantId: string): Promise<void> {
  const findOrCreate = async (
    listUrl: string,
    createBody: Record<string, unknown>,
    listKey: string,
    match: (item: any) => boolean,
  ): Promise<string> => {
    const list = await jsonApi(page, tenantId, 'GET', listUrl);
    const existing = list.payload?.[listKey]?.find(match);
    if (existing?.id) return String(existing.id);
    const created = await jsonApi(page, tenantId, 'POST', listUrl, createBody);
    if (created.status >= 400) throw new Error(`${listUrl} seed failed: ${JSON.stringify(created.payload)}`);
    return String(created.payload?.account?.id ?? created.payload?.fiscal_year?.id ?? created.payload?.period?.id ?? created.payload?.tax_code?.id);
  };

  const ar = await findOrCreate('/api/v1/accounts', { code: '1700', name: 'Accounts receivable', type: 'ASSET' }, 'accounts', (a) => a.code === '1700');
  const revenue = await findOrCreate('/api/v1/accounts', { code: '3000', name: 'Sales revenue', type: 'REVENUE' }, 'accounts', (a) => a.code === '3000');
  const vat = await findOrCreate('/api/v1/accounts', { code: '2930', name: 'VAT payable', type: 'LIABILITY' }, 'accounts', (a) => a.code === '2930');
  const fiscalYear = await findOrCreate(
    '/api/v1/fiscal-years',
    { name: '2026', start_date: '2026-01-01', end_date: '2026-12-31' },
    'fiscal_years',
    (fy) => String(fy.name) === '2026',
  );
  await findOrCreate(
    '/api/v1/accounting-periods',
    { fiscal_year_id: fiscalYear, name: '2026-09', start_date: '2026-09-01', end_date: '2026-09-30' },
    'periods',
    (period) => String(period.name) === '2026-09',
  );
  const tax = await findOrCreate(
    '/api/v1/tax-codes',
    {
      code: 'FI24',
      name: 'VAT 24',
      country_code: 'FI',
      rate: 24,
      type: 'VAT',
      effective_from: '2026-01-01',
      reporting_mapping: 'TAXABLE',
    },
    'tax_codes',
    (code) => String(code.code) === 'FI24',
  );
  const settings = await jsonApi(page, tenantId, 'GET', '/api/v1/sales/settings');
  const seriesId = String(settings.payload?.settings?.default_invoice_series_id ?? '');
  const patch = await jsonApi(page, tenantId, 'PATCH', '/api/v1/sales/settings', {
    accounts_receivable_account_id: ar,
    default_sales_revenue_account_id: revenue,
    tax_payable_account_id: vat,
    default_currency: 'EUR',
    payment_reference_type: 'FI_DOMESTIC',
    ...(seriesId ? { default_invoice_series_id: seriesId } : {}),
  });
  expect(patch.status).toBe(200);
  void tax;
}

test.describe('sales desktop UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sales');
    await expect(page.locator('[data-testid="sales-page"]')).toBeVisible();
  });

  test('creates a customer, drafts, issues, views PDF and credits the invoice', async ({ page }) => {
    const tenant = await findQaTenant(page);
    await page.locator('select').first().selectOption({ label: tenant.name });
    await seedAccounting(page, tenant.id);

    // Customer tab
    await page.locator('[data-testid="tab-customers"]').click();
    const customerName = `E2E Sales Customer ${Date.now()}`;
    await page.locator('[data-testid="customer-form"] input').first().fill(customerName);
    await page.getByRole('button', { name: /Save|Salvesta/i }).click();
    await expect(page.locator('[data-testid="customers-table"] tbody tr').first()).toBeVisible();
    await page.locator('[data-testid="customer-search"]').fill(customerName);
    await page.locator('[data-testid="search-customers"]').click();
    await expect(page.locator('[data-testid="customers-table"] tbody tr').first()).toContainText(customerName);

    // Invoice draft
    await page.locator('[data-testid="tab-invoices"]').click();
    await expect(page.locator('[data-testid="invoices-panel"]')).toBeVisible();
    const customerId = page.locator('[data-testid="invoice-draft-form"] select').first();
    await customerId.selectOption({ label: customerName });

    const descriptionInput = page.locator('[data-testid="invoice-draft-form"] input[aria-label*="description" i]').first();
    await descriptionInput.fill('E2E consulting');
    const priceInput = page.locator('[data-testid="invoice-draft-form"] input[aria-label*="unit price" i]').first();
    await priceInput.fill('100');
    const taxSelect = page.locator('[data-testid="invoice-draft-form"] select[aria-label*="tax code" i]').first();
    await taxSelect.selectOption({ label: /FI24/ });
    await expect(page.locator('[data-testid="totals-preview"]')).toContainText('100.00');

    await page.getByRole('button', { name: /Save draft|Salvesta mustand/i }).click();
    await page.locator('[data-testid="invoice-search"]').fill(customerName);
    await page.locator('[data-testid="invoice-refresh"]').click();
    await expect(page.locator('[data-testid="invoices-table"] tbody tr').first()).toContainText(customerName);

    // Issue via list row action
    const row = page.locator('[data-testid="invoices-table"] tbody tr').first();
    await row.getByRole('button', { name: /Issue|Esita/i }).click();
    await expect(page.locator('.success-text')).toContainText(/issued|esitatud/i, { timeout: 15_000 });

    // Open detail: read-only invoice with number, PDF and journal link
    await page.locator('[data-testid="invoices-table"] tbody tr').first().getByRole('button', { name: /Open invoice|Ava arve/i }).click();
    await expect(page.locator('[data-testid="invoice-detail"]')).toBeVisible();
    await expect(page.locator('[data-testid="invoice-detail"] h3')).not.toHaveText(/Draft|Mustand/i);
    await expect(page.locator('[data-testid="detail-totals"]')).toContainText(/124\.00|100\.00/);
    await expect(page.locator('[data-testid="pdf-status"]')).toContainText(/Ready|Valmis/i, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Download PDF|Laadi PDF alla/i })).toBeVisible();

    // Issue an edit attempt through the UI is impossible (read-only view)
    await expect(page.locator('[data-testid="invoice-detail"] input')).toHaveCount(0);

    // Credit flow marks the original credited
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: /Credit invoice|Kreeditarve/i }).click();
    await expect(page.locator('[data-testid="invoice-detail"]')).toContainText(/Credited|Krediteeritud/i, { timeout: 20_000 });
  });

  test('mobile drawer opens sales', async ({ page }) => {
    test.skip(test.info().project.name === 'desktop', 'drawer is mobile only');
    await page.goto('/');
    await page.locator('.hamburger').click();
    await page.locator('.drawer a[href="/sales"]').click();
    await expect(page.locator('[data-testid="sales-page"]')).toBeVisible();
  });
});
