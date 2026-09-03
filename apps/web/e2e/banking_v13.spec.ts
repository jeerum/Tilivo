import { test, expect } from '@playwright/test';

test.describe('v0.13 Banking workspace', () => {
  test('navigation and responsive critical controls are usable', async ({ page }) => {
    await page.goto('/banking');
    await expect(page.getByTestId('banking-page')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Transactions' })).toBeVisible();
    await page.getByRole('button', { name: 'Bank accounts' }).click();
    await expect(page.getByRole('heading', { name: 'Bank accounts' })).toBeVisible();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Import bank statement' })).toBeVisible();
    await page.getByRole('button', { name: 'Reconciliation' }).click();
    await expect(page.locator('.summary').getByText('Unmatched', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Banking settings' }).click();
    await expect(page.getByRole('heading', { name: 'Banking settings mappings' })).toBeVisible();
  });
});
