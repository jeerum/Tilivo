import { test, expect } from '@playwright/test';

test.describe('authenticated application shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shell layout and navigation', async ({ page }) => {
    const isDesktop = test.info().project.name === 'desktop';
    if (isDesktop) {
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator('.hamburger')).toBeHidden();
    } else {
      await expect(page.locator('.hamburger')).toBeVisible();
      await expect(page.locator('.sidebar')).toBeHidden();
    }
    await page.goto('/settings');
    await expect(page.locator('.settings-nav')).toBeVisible();
    await page.goto('/documents');
    await expect(page.locator('.data-table, input[type=file]').first()).toBeVisible();
    if (!isDesktop) {
      await page.goto('/');
      await page.locator('.hamburger').click();
      await expect(page.locator('.drawer-backdrop')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.drawer-backdrop')).toBeHidden();
      await page.locator('.hamburger').click();
      await page.locator('.drawer a[href="/documents"]').click();
      await expect(page.locator('.drawer-backdrop')).toBeHidden();
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('tenant switch does not leave stale company content', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'tenant switch desktop assertion');
    await page.goto('/');
    const csrf = await page.evaluate(() =>
      document.cookie
        .split('; ')
        .find((part) => part.startsWith('tilivo_csrf='))
        ?.split('=').slice(1).join('=') ?? '',
    );
    const created = await page.evaluate(async (token) => {
      const response = await fetch('/api/v1/tenants', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({
          name: 'E2E Switch Tenant',
          company: { legal_name: 'E2E Switch Tenant Oy' },
        }),
      });
      return response.json();
    }, csrf);
    const tenantId = created.tenant.id as string;
    await page.reload();
    await page.locator('select').first().selectOption(tenantId);
    await expect(page.locator('input[value="E2E Switch Tenant Oy"]')).toBeVisible();
    await expect(page.locator('input[value="Tilivo QA Tenant Oy"]')).toHaveCount(0);
  });
});
