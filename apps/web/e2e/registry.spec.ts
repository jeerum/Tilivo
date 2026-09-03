import { expect, test, type Page } from '@playwright/test';

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function openCustomerForm(page: Page): Promise<void> {
  await page.goto('/sales');
  const details = page.locator('[data-testid="customers-panel"] details').first();
  if (!(await page.locator('[data-testid="customer-form"]').isVisible().catch(() => false))) {
    await details.locator('summary').click();
  }
  await expect(page.locator('[data-testid="customer-form"]')).toBeVisible();
}

async function openSupplierForm(page: Page): Promise<void> {
  await page.goto('/purchases');
  await page.locator('[data-testid="tab-suppliers"]').click();
  const details = page.locator('[data-testid="suppliers-panel"] details').first();
  if (!(await page.locator('[data-testid="supplier-form"]').isVisible().catch(() => false))) {
    await details.locator('summary').click();
  }
  await expect(page.locator('[data-testid="supplier-form"]')).toBeVisible();
}

async function registryLookup(page: Page, query: string, expectedName: string): Promise<void> {
  await expect(page.locator('[data-testid="business-registry-search"]')).toBeVisible();
  await page.locator('[data-testid="registry-query"]').fill(query);
  await page.locator('[data-testid="registry-search-button"]').click();
  await expect(page.locator('[data-testid="registry-results"]')).toBeVisible();
  await page
    .locator('[data-testid="registry-result"]')
    .filter({ hasText: expectedName })
    .first()
    .click();
}

test.describe('v0.7.5 business registry browser flow', () => {
  test('customer registry search, autofill, edit preservation and overwrite confirmation', async ({ page }) => {
    await openCustomerForm(page);
    const form = page.locator('[data-testid="customer-form"]');

    // Deliberately type a conflicting value first; selecting registry data must confirm.
    await form.locator('input').first().fill(`Temporary Different Oy ${suffix}`);
    let dialogAccepted = false;
    page.on('dialog', async (dialog) => {
      dialogAccepted = true;
      await dialog.accept();
    });
    await registryLookup(page, '0112038-9', 'Nokia Oyj');
    expect(dialogAccepted).toBe(true);

    const inputs = form.locator('input');
    await expect(inputs.nth(0)).toHaveValue('Nokia Oyj');
    await expect(inputs.nth(1)).toHaveValue('0112038-9');
    await expect(inputs.nth(2)).toHaveValue('FI01120389');
    await expect(inputs.nth(5)).toHaveValue('Karakaari 7');
    await expect(inputs.nth(6)).toHaveValue(/ESPOO/i);
    await expect(inputs.nth(7)).toHaveValue('02610');

    const customerName = `Nokia Oyj QA ${suffix}`;
    await inputs.nth(0).fill(customerName);
    await page.locator('[data-testid="save-customer"]').click();
    await expect(
      page.locator('[data-testid="customers-table"] tr').filter({ hasText: customerName }),
    ).toHaveCount(1);

    // Reopen: previously saved unrelated fields must survive.
    const row = page.locator('[data-testid="customers-table"] tr').filter({ hasText: customerName });
    await row.getByRole('button', { name: /Muuda|Edit/i }).click();
    const editInputs = form.locator('input');
    await expect(editInputs.nth(0)).toHaveValue(customerName);
    await expect(editInputs.nth(1)).toHaveValue('0112038-9');
    await expect(editInputs.nth(2)).toHaveValue('FI01120389');
    await expect(editInputs.nth(5)).toHaveValue('Karakaari 7');
    await expect(editInputs.nth(6)).toHaveValue(/ESPOO/i);
    await expect(editInputs.nth(7)).toHaveValue('02610');

    // Registry refresh from the edit form.
    await registryLookup(page, '0112038-9', 'Nokia Oyj');
    await page.locator('[data-testid="save-customer"]').click();
    await expect(
      page.locator('[data-testid="customers-table"] tr').filter({ hasText: customerName }),
    ).toHaveCount(1);
  });

  test('supplier registry search, autofill and edit preservation', async ({ page }) => {
    await openSupplierForm(page);
    const form = page.locator('[data-testid="supplier-form"]');
    await registryLookup(page, '0112038-9', 'Nokia Oyj');

    const inputs = form.locator('input');
    await expect(inputs.nth(0)).toHaveValue('Nokia Oyj');
    await expect(inputs.nth(1)).toHaveValue('0112038-9');
    await expect(inputs.nth(2)).toHaveValue('FI01120389');
    await expect(inputs.nth(3)).toHaveValue('Karakaari 7');
    await expect(inputs.nth(4)).toHaveValue(/ESPOO/i);
    await expect(inputs.nth(5)).toHaveValue('02610');

    const supplierName = `Nokia Oyj Tarnija QA ${suffix}`;
    await inputs.nth(0).fill(supplierName);
    await inputs.nth(7).fill(`supplier-${suffix}@example.com`);
    await inputs.nth(8).fill('+358 50 123 4567');
    await page.locator('[data-testid="save-supplier"]').click();
    await expect(
      page.locator('[data-testid="suppliers-table"] tr').filter({ hasText: supplierName }),
    ).toHaveCount(1);

    const row = page.locator('[data-testid="suppliers-table"] tr').filter({ hasText: supplierName });
    await row.getByRole('button', { name: /Muuda|Edit/i }).click();
    const editInputs = form.locator('input');
    await expect(editInputs.nth(0)).toHaveValue(supplierName);
    await expect(editInputs.nth(3)).toHaveValue('Karakaari 7');
    await expect(editInputs.nth(4)).toHaveValue(/ESPOO/i);
    await expect(editInputs.nth(5)).toHaveValue('02610');
    await expect(editInputs.nth(7)).toHaveValue(`supplier-${suffix}@example.com`);
    await expect(editInputs.nth(8)).toHaveValue('+358 50 123 4567');
  });

  test('registry unavailable does not break manual customer entry', async ({ page }) => {
    await openCustomerForm(page);
    await page.route('**/api/v1/business-registry/search**', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'REG-003', message: 'Registry service is temporarily unavailable', trace_id: 'e2e' },
        }),
      });
    });
    await page.locator('[data-testid="registry-query"]').fill('Nokia Oyj');
    await page.locator('[data-testid="registry-search-button"]').click();
    await expect(page.locator('[data-testid="registry-error"]')).toContainText(/Registriteenus|Registry service/i);

    const manualName = `Manual Customer QA ${suffix}`;
    await page.locator('[data-testid="customer-form"] input').first().fill(manualName);
    await page.locator('[data-testid="save-customer"]').click();
    await expect(
      page.locator('[data-testid="customers-table"] tr').filter({ hasText: manualName }),
    ).toHaveCount(1);
    await page.unroute('**/api/v1/business-registry/search**');
  });
});
