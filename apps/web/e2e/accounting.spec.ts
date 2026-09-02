import { test, expect } from '@playwright/test';

test.describe('accounting desktop UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/accounting');
  });

  test('renders accounting workspace with journals, reports, periods and chart tabs', async ({ page }) => {
    const isDesktop = test.info().project.name === 'desktop';
    await expect(page.locator('[data-testid="accounting-page"]')).toBeVisible();
    if (isDesktop) {
      await expect(page.locator('.sidebar a[href="/accounting"]')).toBeVisible();
    }
    await expect(page.locator('select').first()).toBeVisible();
    await expect(page.locator('[data-testid="journals-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="journals-table"], [data-testid="journals-empty"]').first()).toBeVisible();

    await page.locator('[data-testid="tab-reports"]').click();
    await expect(page.locator('[data-testid="reports-panel"]')).toBeVisible();
    await expect(page.locator('text=Trial balance').or(page.locator('text=Bilansi proov')).first()).toBeVisible();

    await page.locator('[data-testid="tab-periods"]').click();
    await expect(page.locator('[data-testid="periods-panel"]')).toBeVisible();

    await page.locator('[data-testid="tab-chart"]').click();
    await expect(page.locator('[data-testid="chart-panel"]')).toBeVisible();
  });

  test('mobile drawer navigates to accounting', async ({ page }) => {
    test.skip(test.info().project.name === 'desktop', 'drawer is mobile only');
    await page.goto('/');
    await page.locator('.hamburger').click();
    await page.locator('.drawer a[href="/accounting"]').click();
    await expect(page.locator('[data-testid="accounting-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="journals-panel"]')).toBeVisible();
  });
});
