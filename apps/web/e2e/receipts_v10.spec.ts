import { test, expect, type Page } from '@playwright/test';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function jsonApi(
  page: Page,
  tenantId: string,
  method: 'GET' | 'POST' | 'PATCH',
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
  const tenant = tenants.payload?.tenants?.find((entry: any) => String(entry.name).includes('Receipts QA Tenant'));
  return String(tenant?.id ?? tenants.payload?.tenants?.[0]?.id);
}

async function seed(page: Page, tenant: string, year: number): Promise<{
  receiptId: string;
  merchant: string;
  date: string;
}> {
  const seed = `R${Math.random().toString(36).slice(2, 8)}`;
  const account = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: `${seed}0`, name: `Receipt Expense ${suffix}`, type: 'EXPENSE',
  });
  const cash = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: `${seed}1`, name: `Receipt Cash ${suffix}`, type: 'ASSET',
  });
  const inputVat = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: `${seed}2`, name: `Receipt Input VAT ${suffix}`, type: 'ASSET',
  });
  const card = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: `${seed}3`, name: `Receipt Card ${suffix}`, type: 'LIABILITY',
  });
  const employee = await jsonApi(page, tenant, 'POST', '/api/v1/accounts', {
    code: `${seed}4`, name: `Receipt Employee ${suffix}`, type: 'LIABILITY',
  });
  const fiscal = await jsonApi(page, tenant, 'POST', '/api/v1/fiscal-years', {
    name: `R10 FY ${suffix} ${year}`, start_date: `${year}-01-01`, end_date: `${year}-12-31`,
  });
  const period = await jsonApi(page, tenant, 'POST', '/api/v1/accounting-periods', {
    fiscal_year_id: String(fiscal.payload.fiscal_year.id),
    name: `R10 P ${suffix}`, start_date: `${year}-09-01`, end_date: `${year}-09-30`,
  });
  await jsonApi(page, tenant, 'PATCH', '/api/v1/purchase-settings', {
    default_expense_account_id: String(account.payload.account.id),
    input_vat_account_id: String(inputVat.payload.account.id),
    cash_account_id: String(cash.payload.account.id),
    company_card_account_id: String(card.payload.account.id),
    employee_payable_account_id: String(employee.payload.account.id),
    accounts_payable_account_id: String(account.payload.account.id),
  });
  const codes = await jsonApi(page, tenant, 'GET', '/api/v1/tax-codes?current=true&direction=PURCHASE');
  const taxCode = codes.payload.tax_codes.find((row: any) => row.code === 'FI_PURCHASE_STD');
  if (!taxCode || period.status !== 201) throw new Error('receipt seed failed');
  const date = `${year}-09-10`;
  const merchant = `E2E Receipt ${suffix}`;
  const draft = await jsonApi(page, tenant, 'POST', '/api/v1/purchases', {
    merchant_name: merchant,
    invoice_date: date,
    document_type: 'RECEIPT',
    payment_method: 'CASH',
    payment_status: 'PAID_AT_PURCHASE',
    lines: [{ description: 'Coffee', quantity: '1', unit_price: '25.50', tax_code_id: String(taxCode.id) }],
  });
  if (draft.status !== 201) throw new Error(`receipt create failed ${JSON.stringify(draft.payload)}`);
  const receiptId = String(draft.payload.purchase.id);
  const file = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
  const boundary = '----receipts-v10';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt-fi.jpg"\r\nContent-Type: application/pdf\r\n\r\n`, 'latin1'),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
  ]);
  const bodyBase64 = body.toString('base64');
  const upload = await page.evaluate(
    async ({ url, boundary, bodyB64, tenant }) => {
      const csrf = document.cookie.split('; ').find((part) => part.startsWith('tilivo_csrf='))?.split('=').slice(1).join('=') ?? '';
      const bytes = Uint8Array.from(atob(bodyB64), (char) => char.charCodeAt(0));
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'x-csrf-token': csrf,
          'x-tilivo-tenant-id': tenant,
        },
        body: bytes,
      });
      return { status: response.status, body: await response.text() };
    },
    { url: `/api/v1/purchases/${receiptId}/documents`, boundary, bodyB64: bodyBase64, tenant },
  );
  if (upload.status !== 201) throw new Error(`upload failed ${upload.status}: ${String(upload.body).slice(0, 500)}`);
  const ocr = await jsonApi(page, tenant, 'POST', `/api/v1/purchases/${receiptId}/ocr`);
  if (ocr.status !== 200) throw new Error(`ocr failed ${JSON.stringify(ocr.payload)}`);
  for (const action of ['review', 'approve', 'post'] as const) {
    const transition = await jsonApi(page, tenant, 'POST', `/api/v1/purchases/${receiptId}/${action}`);
    if (transition.status !== 200) throw new Error(`receipt ${action} failed ${JSON.stringify(transition.payload)}`);
  }
  return { receiptId, merchant, date };
}

test.describe('v0.10 receipts browser flow', () => {
  test('receipt tab, merchant row, posted status and document linkage are visible', async ({ page }) => {
    const tenant = await tenantId(page);
    const year = { desktop: 2026, tablet: 2036, mobile: 2046 }[test.info().project.name] ?? 2026;
    const seeded = await seed(page, tenant, year);

    await page.goto('/purchases');
    await page.locator('[data-testid="tab-receipts"]').click();
    await expect(page.locator('[data-testid="receipts-panel"]')).toBeVisible();
    await page.locator('[data-testid="add-receipt"]').click();
    await expect(page.locator('[data-testid="receipt-form"]')).toBeVisible();
    await page.locator('[data-testid="receipt-form"] input[type=number]').fill('25.50');
    await page.locator('[data-testid="receipt-form"] input[type=date]').fill(seeded.date);
    await page.getByLabel(/^(Merchant|Kaupmees)$/i).fill(seeded.merchant);
    await page.locator('[data-testid="save-receipt"]').click();

    const row = page.locator('[data-testid="receipts-table"] tr').filter({ hasText: seeded.merchant });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/(POSTED|Posted|Postitatud)/i);
    await row.getByRole('button', { name: /(Open|Ava)/i }).first().click();
    await expect(page.locator('[data-testid="receipt-detail"]')).toContainText('RECEIPT');
    await expect(page.locator('[data-testid="receipt-detail"]')).toContainText(seeded.merchant);
  });
});
