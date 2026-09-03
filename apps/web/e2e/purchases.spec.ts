import { test, expect } from '@playwright/test';

test.describe('purchases desktop UI', () => {
  test('renders purchase workspace tabs', async ({ page }) => {
    await page.goto('/purchases');
    await expect(page.locator('[data-testid="purchases-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-purchases"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-suppliers"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-inbox"]')).toBeVisible();
    await page.locator('[data-testid="tab-suppliers"]').click();
    await expect(page.locator('[data-testid="suppliers-panel"]')).toBeVisible();
    await page.locator('[data-testid="tab-inbox"]').click();
    await expect(page.locator('[data-testid="purchase-inbox-panel"]')).toBeVisible();
  });

  test('mobile drawer opens purchases', async ({ page }) => {
    test.skip(test.info().project.name === 'desktop', 'drawer is mobile only');
    await page.goto('/');
    await page.locator('.hamburger').click();
    await page.locator('.drawer a[href="/purchases"]').click();
    await expect(page.locator('[data-testid="purchases-page"]')).toBeVisible();
  });
});
