import { test, expect } from '@playwright/test';

test.describe('v0.15 Time Tracking', () => {
  test('add work and absence, create and submit timesheet', async ({ page }) => {
    const suffix = Date.now().toString(36);
    await page.goto('/employees');
    await expect(page.getByTestId('employees-page')).toBeVisible();
    await page.getByLabel('First name').fill('Time');
    await page.getByLabel('Last name').fill(`QA ${suffix}`);
    await page.getByLabel('Email').fill(`time-${suffix}@example.com`);
    await page.getByRole('button', { name: 'Create employee' }).click();
    await expect(page.getByText('Employee created.')).toBeVisible();
    await page.goto('/time-tracking');
    await expect(page.getByTestId('time-tracking-page')).toBeVisible();
    await page.getByLabel('Employee').selectOption({ label: `Time QA ${suffix}` });
    await page.getByLabel('Minutes').fill('480');
    await page.getByLabel('Break').fill('30');
    await page.getByRole('button', { name: 'Save entry' }).click();
    await expect(page.getByText('Time entry saved.')).toBeVisible();
    await page.getByLabel('Entry kind').selectOption('ABSENCE');
    await page.getByLabel('Work / absence type').selectOption('SICK_LEAVE');
    await page.getByLabel('Minutes').fill('60');
    await page.getByLabel('Break').fill('0');
    await page.getByRole('button', { name: 'Save entry' }).click();
    await page.getByRole('button', { name: 'Timesheets' }).click();
    await page.getByRole('button', { name: 'Create current timesheet' }).click();
    await expect(page.getByText('Timesheet created.')).toBeVisible();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('tbody tr').filter({ hasText: `Time QA ${suffix}` }).getByText('SUBMITTED')).toBeVisible();
  });
});
