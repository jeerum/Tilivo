import { test, expect } from '@playwright/test';

test.describe('authenticated application shell', () => {
  test('desktop shell has persistent sidebar and settings navigation', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop-only assertion');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.hamburger')).toBeHidden();
    await page.goto('/settings');
    await expect(page.locator('.settings-nav')).toBeVisible();
    await page.goto('/documents');
    await expect(page.locator('.data-table, input[type=file]').first()).toBeVisible();
  });

  test('mobile drawer opens, closes with Escape and has no horizontal overflow', async ({ page }) => {
    test.skip(test.info().project.name === 'desktop', 'mobile drawer assertion');
    await expect(page.locator('.hamburger')).toBeVisible();
    await expect(page.locator('.drawer-backdrop')).toBeHidden();
    await page.locator('.hamburger').click();
    await expect(page.locator('.drawer-backdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer-backdrop')).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
