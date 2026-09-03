import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('../../api/node_modules/pg') as { Client: new (options: { connectionString: string }) => any };

export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
  const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('E2E_DATABASE_URL or TEST_DATABASE_URL is required for dynamic auth bootstrap');
  const email = `qa-banking-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'E2E-only banking password 2026!';
  const apiContext = await (await import('@playwright/test')).request.newContext({ baseURL });
  const register = await apiContext.post('/api/v1/auth/register', { data: { email, password } });
  if (register.status() !== 202) throw new Error(`E2E register failed: ${register.status()} ${await register.text()}`);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const mail = await db.query('SELECT body FROM dev_email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [email]);
  await db.end();
  const body = String(mail.rows[0]?.body ?? '');
  const token = body.match(/[?&]token=([^&\s]+)/)?.[1];
  if (!token) throw new Error('E2E verification token was not found in dev_email_outbox');
  const verify = await apiContext.post('/api/v1/auth/email/verify', { data: { token: decodeURIComponent(token) } });
  if (verify.status() !== 200) throw new Error(`E2E verification failed: ${verify.status()} ${await verify.text()}`);
  const login = await apiContext.post('/api/v1/auth/login', { data: { email, password } });
  if (login.status() !== 200) throw new Error(`E2E login failed: ${login.status()} ${await login.text()}`);
  const csrf = (await apiContext.storageState()).cookies.find((cookie) => cookie.name === 'tilivo_csrf')?.value ?? '';
  const suffix = Date.now().toString(36);
  const tenant = await apiContext.post('/api/v1/tenants', {
    headers: { 'x-csrf-token': csrf },
    data: { name: `Banking QA ${suffix}`, slug: `banking-qa-${suffix}`, company: { legal_name: `Banking QA ${suffix}`, country_code: 'FI', base_currency: 'EUR' } },
  });
  if (tenant.status() !== 201) throw new Error(`E2E tenant failed: ${tenant.status()} ${await tenant.text()}`);
  await apiContext.storageState({ path: './e2e/.auth.json' });
  await apiContext.dispose();
  void chromium;
}
