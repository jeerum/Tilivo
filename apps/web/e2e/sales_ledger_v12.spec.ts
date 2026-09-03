import { test, expect, type Page } from '@playwright/test';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function jsonApi(page: Page, tenant: string, method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) {
  return page.evaluate(
    async ({ apiUrl, method, body, tenant }) => {
      const csrf = document.cookie.split('; ').find((part) => part.startsWith('tilivo_csrf='))?.split('=').slice(1).join('=') ?? '';
      const response = await fetch(apiUrl, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          'x-csrf-token': csrf,
          'x-tilivo-tenant-id': tenant,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let payload: any;
      try { payload = await response.json(); } catch { payload = null; }
      return { status: response.status, payload };
    },
    { apiUrl: url, method, body: body ?? null, tenant },
  );
}

async function tenantId(page: Page): Promise<string> {
  await page.goto('/');
  const result = await jsonApi(page, '', 'GET', '/api/v1/tenants');
  const tenant = result.payload?.tenants?.find((entry: any) => String(entry.name).includes('Sales QA Tenant'));
  return String(tenant?.id ?? result.payload?.tenants?.[0]?.id);
}

async function seed(page: Page, tenant: string, year: number): Promise<{ invoiceId: string; customerName: string; templateId: string }> {
  const seed = `L${Math.random().toString(36).slice(2, 8)}`;
  const ar = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}0`, name: `AR ${suffix}`, type: 'ASSET' });
  const revenue = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}1`, name: `Revenue ${suffix}`, type: 'REVENUE' });
  const vat = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}2`, name: `VAT out ${suffix}`, type: 'LIABILITY' });
  const fiscal = await jsonApi(page, tenant, 'POST', '/api/v1/fiscal-years', { name: `L12 FY ${suffix} ${year}`, start_date: `${year}-01-01`, end_date: `${year}-12-31` });
  const period = await jsonApi(page, tenant, 'POST', '/api/v1/accounting-periods', { fiscal_year_id: String(fiscal.payload.fiscal_year.id), name: `L12 P ${suffix}`, start_date: `${year}-09-01`, end_date: `${year}-09-30` });
  const customer = await jsonApi(page, tenant, 'POST', '/api/v1/customers', { name: `Ledger Customer ${suffix}`, country_code: 'FI', business_id: 'FI12345678', vat_id: 'FI12345678', language: 'fi', default_currency: 'EUR' });
  const codes = await jsonApi(page, tenant, 'GET', '/api/v1/tax-codes?current=true&direction=SALES');
  const tax = codes.payload.tax_codes.find((row: any) => row.code === 'FI_SALES_STD');
  if (!tax || period.status !== 201) throw new Error('seed failed');
  await jsonApi(page, tenant, 'PATCH', '/api/v1/sales/settings', {
    accounts_receivable_account_id: String(ar.payload.account.id),
    default_sales_revenue_account_id: String(revenue.payload.account.id),
    tax_payable_account_id: String(vat.payload.account.id),
  });
  const date = `${year}-09-10`;
  const draft = await jsonApi(page, tenant, 'POST', '/api/v1/sales/invoices', {
    customer_id: String(customer.payload.customer.id),
    issue_date: date,
    due_date: `${year}-10-10`,
    lines: [{ description: 'Ledger sale', quantity: '1', unit_price: '500.00', discount_percent: '0', tax_code_id: String(tax.id) }],
  });
  if (draft.status !== 201) throw new Error(`draft failed ${JSON.stringify(draft.payload)}`);
  const issue = await jsonApi(page, tenant, 'POST', `/api/v1/sales/invoices/${draft.payload.invoice.id}/issue`);
  if (issue.status !== 200) throw new Error(`issue failed ${JSON.stringify(issue.payload)}`);
  const invoiceId = String(issue.payload.invoice.id);
  const template = await jsonApi(page, tenant, 'POST', '/api/v1/sales/recurring-templates', {
    customer_id: String(customer.payload.customer.id),
    name: `Monthly ${suffix}`,
    frequency: 'MONTHLY',
    start_date: date,
    lines: [{ description: 'Monthly', quantity: '1', unit_price: '10.00', tax_code_id: String(tax.id) }],
  });
  return { invoiceId, customerName: `Ledger Customer ${suffix}`, templateId: String(template.payload.template.id) };
}

test.describe('v0.12 sales ledger browser flow', () => {
  test('invoice, payment, reminder and recurring lifecycle visible', async ({ page }) => {
    const tenant = await tenantId(page);
    const year = { desktop: 2029, tablet: 2039, mobile: 2049 }[test.info().project.name] ?? 2029;
    const seeded = await seed(page, tenant, year);

    const partial = await jsonApi(page, tenant, 'POST', `/api/v1/sales/invoices/${seeded.invoiceId}/payments`, {
      amount: '200.00', payment_date: `${year}-09-15`,
    });
    if (partial.status !== 200) throw new Error(`payment failed ${JSON.stringify(partial.payload)}`);
    const reminder = await jsonApi(page, tenant, 'POST', `/api/v1/sales/invoices/${seeded.invoiceId}/reminders`, { note: 'due' });
    if (reminder.status !== 200) throw new Error(`reminder failed ${JSON.stringify(reminder.payload)}`);
    const generate = await jsonApi(page, tenant, 'POST', '/api/v1/sales/recurring-templates/generate');
    if (generate.status !== 200) throw new Error(`generate failed ${JSON.stringify(generate.payload)}`);

    await page.goto('/sales');
    await page.locator('[data-testid="tab-invoices"]').click();
    const row = page.locator('[data-testid="invoices-table"] tr').filter({ hasText: seeded.customerName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('200.00');
    await expect(row).toContainText('427.50');
    void seeded.templateId;
  });
});
