import { test, expect, type Page } from '@playwright/test';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function jsonApi(page: Page, tenant: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: Record<string, unknown>) {
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

async function waitForPdf(page: Page, tenant: string, invoiceId: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await jsonApi(page, tenant, 'GET', `/api/v1/sales/invoices/${invoiceId}/pdf`);
    if (result.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`PDF did not become ready for ${invoiceId}`);
}

async function seed(page: Page, tenant: string): Promise<{
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerId: string;
  lineIds: string[];
  advanceId: string;
  templateId: string;
  taxCode: string;
}> {
  const seed = `U${Math.random().toString(36).slice(2, 8)}`;
  const year = 2026;
  const ar = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}0`, name: `AR ${suffix}`, type: 'ASSET' });
  const revenue = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}1`, name: `Revenue ${suffix}`, type: 'REVENUE' });
  const vat = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}2`, name: `VAT out ${suffix}`, type: 'LIABILITY' });
  const liability = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', { code: `${seed}3`, name: `Advances ${suffix}`, type: 'LIABILITY' });
  const fiscal = await jsonApi(page, tenant, 'POST', '/api/v1/fiscal-years', { name: `UI FY ${seed}`, start_date: `${year}-01-01`, end_date: `${year}-12-31` });
  if (fiscal.status !== 201) throw new Error(`fiscal failed ${JSON.stringify(fiscal.payload)}`);
  const period = await jsonApi(page, tenant, 'POST', '/api/v1/accounting-periods', { fiscal_year_id: String(fiscal.payload.fiscal_year.id), name: `UI P ${seed}`, start_date: `${year}-09-01`, end_date: `${year}-09-30` });
  if (period.status !== 201) throw new Error(`period failed ${JSON.stringify(period.payload)}`);
  const customer = await jsonApi(page, tenant, 'POST', '/api/v1/customers', {
    name: `UI Customer ${suffix}`,
    country_code: 'FI',
    business_id: 'FI12345678',
    vat_id: 'FI12345678',
    language: 'en',
    default_currency: 'EUR',
    email: `ui-${suffix}@example.com`,
    delivery_method: 'EMAIL',
    e_invoice_address: 'OPERATOOR:00371234567',
    e_invoice_operator: '00371234567',
    e_invoice_ovt: '00371234567',
  });
  const codes = await jsonApi(page, tenant, 'GET', '/api/v1/tax-codes?current=true&direction=SALES');
  const tax = codes.payload.tax_codes.find((row: any) => row.code === 'FI_SALES_STD');
  if (!tax) throw new Error('tax seed failed');
  await jsonApi(page, tenant, 'PATCH', '/api/v1/sales/settings', {
    accounts_receivable_account_id: String(ar.payload.account.id),
    default_sales_revenue_account_id: String(revenue.payload.account.id),
    tax_payable_account_id: String(vat.payload.account.id),
    advance_payments_received_account_id: String(liability.payload.account.id),
    bank_iban: 'FI21 1234 5600 0007 85',
    bank_bic: 'OKOYFIHH',
    bank_account_holder: 'QA Oy',
    reminder_fee_enabled: true,
    reminder_fee_amount: '5.00',
    late_interest_enabled: true,
    late_interest_rate: '9.5',
  });
  const customerId = String(customer.payload.customer.id);
  const date = `${year}-09-10`;
  const draft = await jsonApi(page, tenant, 'POST', '/api/v1/sales/invoices', {
    customer_id: customerId,
    issue_date: date,
    due_date: `${year}-10-10`,
    language: 'en',
    lines: [
      { description: 'UI item A', quantity: '1', unit_price: '500.00', discount_percent: '0', tax_code_id: String(tax.id) },
      { description: 'UI item B', quantity: '1', unit_price: '100.00', discount_percent: '0', tax_code_id: String(tax.id) },
    ],
  });
  if (draft.status !== 201) throw new Error(`draft failed ${JSON.stringify(draft.payload)}`);
  const issue = await jsonApi(page, tenant, 'POST', `/api/v1/sales/invoices/${draft.payload.invoice.id}/issue`);
  if (issue.status !== 200) throw new Error(`issue failed ${JSON.stringify(issue.payload)}`);
  const invoiceId = String(issue.payload.invoice.id);
  const invoiceNumber = String(issue.payload.invoice.invoice_number);

  const advanceDraft = await jsonApi(page, tenant, 'POST', '/api/v1/sales/invoices', {
    customer_id: customerId,
    issue_date: date,
    document_type: 'ADVANCE_INVOICE',
    lines: [{ description: 'Advance item', quantity: '1', unit_price: '200.00', discount_percent: '0', tax_code_id: String(tax.id) }],
  });
  const advanceIssue = await jsonApi(page, tenant, 'POST', `/api/v1/sales/invoices/${advanceDraft.payload.invoice.id}/issue`);
  if (advanceIssue.status !== 200) throw new Error(`advance failed ${JSON.stringify(advanceIssue.payload)}`);

  const template = await jsonApi(page, tenant, 'POST', '/api/v1/sales/recurring-templates', {
    customer_id: customerId,
    name: `Monthly ${suffix}`,
    frequency: 'MONTHLY',
    start_date: date,
    language: 'en',
    lines: [{ description: 'Monthly', quantity: '1', unit_price: '10.00', tax_code_id: String(tax.id) }],
  });
  const detail = await jsonApi(page, tenant, 'GET', `/api/v1/sales/invoices/${invoiceId}`);
  const lineIds = (detail.payload.invoice.lines as Array<{ id: string }>).map((line) => String(line.id));
  return {
    invoiceId,
    invoiceNumber,
    customerName: `UI Customer ${suffix}`,
    customerId,
    lineIds,
    advanceId: String(advanceDraft.payload.invoice.id),
    templateId: String(template.payload.template.id),
    taxCode: String(tax.id),
  };
}

test.describe('v0.12 browser UI flows', () => {
  test('records partial payment, partial credit, reminder, aging and statement through the UI', async ({ page }) => {
    const tenant = await tenantId(page);
    const seeded = await seed(page, tenant);

    await page.goto('/sales');
    await page.locator('[data-testid="tab-invoices"]').click();
    const row = page.locator('[data-testid="invoices-table"] tr').filter({ hasText: seeded.invoiceNumber });
    await row.getByRole('button').first().click();
    await expect(page.locator('[data-testid="invoice-detail"]')).toBeVisible();

    // Partial payment through the UI.
    await page.locator('[data-testid="open-payment"]').click();
    await page.locator('[data-testid="payment-panel"]').waitFor();
    await page.locator('[data-testid="payment-amount"]').fill('200.00');
    await page.locator('[data-testid="save-payment"]').click();
    await expect(page.locator('[data-testid="payment-panel"] .success-text')).toBeVisible();

    // Partial credit through the UI.
    await page.locator('[data-testid="open-credit"]').click();
    await page.locator('[data-testid="credit-panel"]').waitFor();
    await page.locator('[data-testid="credit-panel"] select').selectOption('partial');
    await page.locator('[data-testid="credit-reason"]').fill('E2E partial credit reason');
    await page.locator('[data-testid="credit-lines"] tbody tr').first().locator('input[type="checkbox"]').check();
    await page.locator('[data-testid="credit-lines"] tbody tr').first().locator('input[type="number"]').first().fill('0.5');
    await page.locator('[data-testid="create-credit"]').click();
    await expect(page.locator('[data-testid="credit-panel"] .success-text')).toBeVisible();

    // Reminder creation.
    await page.locator('[data-testid="open-reminder"]').click();
    await page.locator('[data-testid="reminder-panel"]').waitFor();
    await page.locator('[data-testid="create-reminder"]').click();
    await expect(page.locator('[data-testid="reminder-preview"]')).toBeVisible();
    await page.locator('[data-testid="send-reminder"]').click();
    await expect(page.locator('[data-testid="reminder-panel"] .success-text')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="reminder-panel"]')).toContainText('SENT');

    // Aging and statement views render from backend data.
    await page.locator('[data-testid="tab-aging"]').click();
    await expect(page.locator('[data-testid="aging-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="aging-table"] tbody tr').first()).toBeVisible();

    await page.locator('[data-testid="tab-statement"]').click();
    await page.locator('[data-testid="statement-panel"] select').selectOption({ label: seeded.customerName });
    await expect(page.locator('[data-testid="statement-table"] tbody tr').first()).toBeVisible();

    // Recurring view.
    await page.locator('[data-testid="tab-recurring"]').click();
    await expect(page.locator('[data-testid="recurring-table"]')).toBeVisible();
    await page.locator('[data-testid="generate-due"]').click();
    await expect(page.locator('[data-testid="recurring-panel"] .success-text')).toBeVisible();
    void seeded.lineIds;
    void seeded.advanceId;
    void seeded.templateId;
    void tenant;
  });

  test('advance allocation, email send, e-invoice export and EN PDF download through the UI', async ({ page }) => {
    const tenant = await tenantId(page);
    const seeded = await seed(page, tenant);

    const finalDraft = await jsonApi(page, tenant, 'POST', '/api/v1/sales/invoices', {
      customer_id: seeded.customerId,
      issue_date: '2026-09-10',
      due_date: '2026-10-10',
      language: 'en',
      lines: [{ description: 'Final delivery', quantity: '1', unit_price: '400.00', discount_percent: '0', tax_code_id: seeded.taxCode }],
    });
    if (finalDraft.status !== 201) throw new Error(`final draft failed ${JSON.stringify(finalDraft.payload)}`);

    await page.goto('/sales');
    await page.locator('[data-testid="tab-invoices"]').click();
    const draftRow = page.locator('[data-testid="invoices-table"] tr').filter({ hasText: seeded.customerName }).filter({ hasText: /Draft|Mustand/i }).last();
    await draftRow.getByRole('button', { name: /Open invoice|Ava arve/i }).click();
    await page.locator('[data-testid="advance-panel"]').waitFor();
    await page.locator('[data-testid="advance-panel"] input[type="number"]').first().fill('251.00');
    await page.locator('[data-testid="apply-advances"]').click();
    await page.locator('[data-testid="detail-issue"]').click();
    await expect(page.locator('[data-testid="advance-state"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="invoice-detail"]')).toContainText('251.00');
    await expect(page.locator('[data-testid="detail-issue"]')).toHaveCount(0);
    const finalNumber = (await page.locator('[data-testid="invoice-detail"] h3').innerText()).trim();
    await waitForPdf(page, tenant, String(finalDraft.payload.invoice.id));
    await page.reload();
    await page.locator('[data-testid="tab-invoices"]').click();
    const issuedRow = page.locator('[data-testid="invoices-table"] tr').filter({ hasText: finalNumber }).first();
    await issuedRow.getByRole('button', { name: /Open invoice|Ava arve/i }).click();
    await expect(page.locator('[data-testid="open-delivery"]')).toBeVisible();

    // Email + e-invoice export from the delivery panel.
    await page.locator('[data-testid="open-delivery"]').click();
    await page.locator('[data-testid="send-invoice"]').click();
    await expect(page.locator('[data-testid="delivery-panel"] .success-text')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="delivery-history"]')).toContainText('SENT');
    await page.locator('[data-testid="export-einvoice"]').click();
    await expect(page.locator('[data-testid="einvoice-result"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="einvoice-result"]')).toContainText(/QUEUED|ready|valmis/i);

    // EN PDF download path.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download PDF|Laadi PDF alla/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.pdf');
    void seeded.lineIds;
    void seeded.advanceId;
    void seeded.templateId;
    void finalDraft;
  });

  for (const language of ['fi', 'en', 'et'] as const) {
    test(`PDF download works for language ${language}`, async ({ page }) => {
      const tenant = await tenantId(page);
      const seeded = await seed(page, tenant);
      const pdfDraft = await jsonApi(page, tenant, 'POST', '/api/v1/sales/invoices', {
        customer_id: seeded.customerId,
        issue_date: '2026-09-10',
        due_date: '2026-10-10',
        language,
        lines: [{ description: `PDF ${language}`, quantity: '1', unit_price: '50.00', discount_percent: '0', tax_code_id: seeded.taxCode }],
      });
      await jsonApi(page, tenant, 'POST', `/api/v1/sales/invoices/${pdfDraft.payload.invoice.id}/issue`);
      await waitForPdf(page, tenant, String(pdfDraft.payload.invoice.id));
      await page.goto('/sales');
      await page.locator('[data-testid="tab-invoices"]').click();
      const invoiceRow = page.locator('[data-testid="invoices-table"] tr').filter({ hasText: seeded.customerName }).last();
      await invoiceRow.getByRole('button', { name: /Open invoice|Ava arve/i }).click();
      await expect(page.locator('[data-testid="invoice-detail"]')).toContainText(/Ready|Valmis/i, { timeout: 40_000 });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: /Download PDF|Laadi PDF alla/i }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toContain('.pdf');
    });
  }
});
