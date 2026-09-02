import { chromium } from '@playwright/test';

export default async function globalSetup(): Promise<void> {
  const email = process.env.E2E_USER;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) return;
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? 'https://tilivo.mrjaak.com' });
  await page.goto('/login');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: /Sign in|Logi sisse/i }).click();
  await page.waitForURL('**/');
  await page.context().storageState({ path: './e2e/.auth.json' });
  await browser.close();
}
