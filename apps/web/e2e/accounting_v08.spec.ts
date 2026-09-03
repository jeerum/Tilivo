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
}

async function tenantId(page: Page): Promise<string> {
  const tenants = await jsonApi(page, '', 'GET', '/api/v1/tenants');
  const tenant = tenants.payload?.tenants?.[0];
  if (!tenant?.id) throw new Error('No tenant found for e2e user');
  return String(tenant.id);
}

async function seedAccounting(page: Page, tenantId: string, month = '09', year = 2026) {
  const codeSeed = `V${Math.random().toString(36).slice(2, 8)}`;
  const bankCode = `${codeSeed}0`;
  const equityCode = `${codeSeed}1`;
  const bank = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: bankCode,
    name: `Gate Bank ${suffix}`,
    type: 'ASSET',
  });
  const equity = await jsonApi(page, tenantId, 'POST', '/api/v1/accounts', {
    code: equityCode,
    name: `Gate Equity ${suffix}`,
    type: 'EQUITY',
  });
  const fiscal = await jsonApi(page, tenantId, 'POST', '/api/v1/fiscal-years', {
    name: `V08 FY ${suffix}-${codeSeed}-${year}`,
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
  });
  const fiscalYearId = String(fiscal.payload.fiscal_year.id);
  const period = await jsonApi(page, tenantId, 'POST', '/api/v1/accounting-periods', {
    fiscal_year_id: fiscalYearId,
    name: `V08 P ${suffix}-${codeSeed}`,
    start_date: `${year}-${month}-01`,
    end_date: `${year}-${month}-30`,
  });
  if (bank.status >= 400 || equity.status >= 400 || period.status >= 400) {
    throw new Error(`seed failed ${JSON.stringify({ bank, equity, period })}`);
  }
  return {
    bankId: String(bank.payload.account.id),
    equityId: String(equity.payload.account.id),
    bankCode,
    equityCode,
    periodId: String(period.payload.period.id),
    periodName: `V08 P ${suffix}-${codeSeed}`,
    businessDate: `${year}-${month}-15`,
  };
}

async function pickAccount(row: ReturnType<Page['locator']>, accountId: string) {
  await row.locator('select').selectOption(accountId);
}

test.describe('v0.8 accounting desktop/mobile flows', () => {
  test('manual journal: balance, post, view detail and reversal', async ({ page }) => {
    page.on('dialog', async (dialog) => dialog.accept());
    await page.goto('/accounting');
    const tenant = await tenantId(page);
    const projectYear = { desktop: 2026, tablet: 2036, mobile: 2046 }[test.info().project.name] ?? 2026;
    const seeded = await seedAccounting(page, tenant, '09', projectYear);
    await page.reload();
    const journalDesc = `V08 manual ${suffix}`;

    const details = page.locator('[data-testid="journals-panel"] details').first();
    if (!(await page.locator('[data-testid="journals-panel"] form').isVisible().catch(() => false))) {
      await details.locator('summary').click();
    }
    const form = details.locator('form');
    await form.locator('input[type=date]').fill(seeded.businessDate);
    await form.locator('input').nth(1).fill(journalDesc);
    const rows = form.locator('.entry-line-row');
    await form.locator('input').nth(2).fill(`Gate Bank ${suffix}`);
    await pickAccount(rows.nth(0), seeded.bankId);
    await rows.nth(0).locator('input').nth(0).fill('500.00');
    await form.locator('input').nth(2).fill(`Gate Equity ${suffix}`);
    await pickAccount(rows.nth(1), seeded.equityId);
    await rows.nth(1).locator('input').nth(1).fill('500.00');
    await form.getByRole('button', { name: /Create|Loo/i }).click();

    const row = page.locator('[data-testid="journals-table"] tr').filter({ hasText: journalDesc });
    await expect(row).toHaveCount(1);
    const post = row.getByRole('button', { name: /Post|Postita/i });
    await expect(post).toBeEnabled();
    await post.click();
    await expect(row).toContainText(/\d{4}-/);

    await row.getByRole('button', { name: /View|Vaata/i }).click();
    const detail = page.locator('[data-testid="journal-detail"]');
    await expect(detail).toContainText(seeded.bankCode);
    await expect(detail).toContainText('500.00');

    await row.getByRole('button', { name: /Reverse|Tühista/i }).click();
    const reasonInput = row.locator('input[placeholder]');
    await reasonInput.fill('e2e reversal');
    await row.getByRole('button', { name: /Confirm|Kinnita/i }).click();
    const originalRow = page
      .locator('[data-testid="journals-table"] tr')
      .filter({ hasText: journalDesc })
      .filter({ hasNotText: 'Reversal:' });
    await expect(originalRow).toContainText(/Reversed|Tühistatud/i);
  });

  test('opening balances post and appear in the journal list', async ({ page }) => {
    page.on('dialog', async (dialog) => dialog.accept());
    await page.goto('/accounting');
    const tenant = await tenantId(page);
    const projectYear = { desktop: 2027, tablet: 2037, mobile: 2047 }[test.info().project.name] ?? 2027;
    const seeded = await seedAccounting(page, tenant, '10', projectYear);
    await page.locator('[data-testid="tab-opening"]').click();
    await expect(page.locator('[data-testid="opening-panel"]')).toBeVisible();

    const details = page.locator('[data-testid="opening-panel"] details').first();
    if (!(await page.locator('[data-testid="opening-form"]').isVisible().catch(() => false))) {
      await details.locator('summary').click();
    }
    const form = page.locator('[data-testid="opening-form"]');
    await form.locator('input[type=date]').fill(seeded.businessDate);
    await form.locator('input').nth(1).fill(`Migrated from ${suffix}`);
    const rows = form.locator('.entry-line-row');
    await pickAccount(rows.nth(0), seeded.bankId);
    await rows.nth(0).locator('input').nth(0).fill('1250.00');
    await pickAccount(rows.nth(1), seeded.equityId);
    await rows.nth(1).locator('input').nth(1).fill('1250.00');
    await page.locator('[data-testid="save-opening-balances"]').click();

    const openingRow = page.locator('[data-testid="opening-table"] tr').filter({
      hasText: `Migrated from ${suffix}`,
    });
    await expect(openingRow).toHaveCount(1);
    await expect(openingRow).toContainText(/\d{4}-/);
  });

  test('period close blocks posting and reopen restores it', async ({ page }) => {
    page.on('dialog', async (dialog) => dialog.accept());
    await page.goto('/accounting');
    const tenant = await tenantId(page);
    const projectYear = { desktop: 2028, tablet: 2038, mobile: 2048 }[test.info().project.name] ?? 2028;
    const seeded = await seedAccounting(page, tenant, '11', projectYear);
    await page.reload();
    const journalDesc = `V08 locked ${suffix}`;

    await page.locator('[data-testid="tab-periods"]').click();
    const periodRow = page.locator('[data-testid="periods-panel"] tr').filter({
      hasText: seeded.periodName,
    });
    await expect(periodRow).toHaveCount(1);
    await periodRow.getByRole('button', { name: /^Close$|^Sulge$/ }).click();
    await expect(periodRow).toContainText(/Closed|Suletud/i);

    await page.locator('[data-testid="tab-journals"]').click();
    const details = page.locator('[data-testid="journals-panel"] details').first();
    if (!(await page.locator('[data-testid="journals-panel"] form').isVisible().catch(() => false))) {
      await details.locator('summary').click();
    }
    const form = details.locator('form');
    await form.locator('input[type=date]').fill(seeded.businessDate);
    await form.locator('input').nth(1).fill(journalDesc);
    const rows = form.locator('.entry-line-row');
    await pickAccount(rows.nth(0), seeded.bankId);
    await rows.nth(0).locator('input').nth(0).fill('10.00');
    await pickAccount(rows.nth(1), seeded.equityId);
    await rows.nth(1).locator('input').nth(1).fill('10.00');
    await form.getByRole('button', { name: /Create|Loo/i }).click();

    const row = page.locator('[data-testid="journals-table"] tr').filter({ hasText: journalDesc });
    await row.getByRole('button', { name: /Post|Postita/i }).click();
    await expect(page.locator('.error-text')).toContainText('Accounting period is not open');

    await page.locator('[data-testid="tab-periods"]').click();
    await periodRow.getByRole('button', { name: /Reopen|Ava uuesti/i }).click();
    await periodRow.locator('input').fill('v0.8 gate test');
    await periodRow.getByRole('button', { name: /Confirm|Kinnita/i }).click();

    await page.locator('[data-testid="tab-journals"]').click();
    await row.getByRole('button', { name: /Post|Postita/i }).click();
    await expect(row).toContainText(/\d{4}-/);
  });
});
