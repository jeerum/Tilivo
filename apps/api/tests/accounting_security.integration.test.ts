import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { ErrorCodes } from '../src/lib/errors';
import { withTenantTransaction } from '../src/services/tenantService';

const databaseUrl = process.env.TEST_DATABASE_URL;
const PASSWORD = 'correct horse battery staple';

interface HttpResult {
  status: number;
  body: any;
  cookie: string;
}

function cookieHeader(response: { cookies?: Array<{ name: string; value: string }> }): string {
  return (response.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
}

function parseToken(body: string): string {
  const match = body.match(/[?&]token=([^&\s]+)/);
  if (!match?.[1]) throw new Error(`No token in ${body}`);
  return decodeURIComponent(match[1]);
}

describe.skipIf(!databaseUrl)('accounting permissions and security', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  let counter = 0;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      LOG_LEVEL: 'silent',
      EMAIL_DRIVER: 'dev',
      EMAIL_DEV_OUTBOX: 'true',
      TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
      COOKIE_SECURE: 'false',
    });
    app = await buildApp({ config, db: pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function nextEmail(): string {
    counter += 1;
    return `accsec${counter}@example.com`;
  }

  async function request(options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: Record<string, unknown>;
    cookie?: string;
    csrf?: string;
    tenantId?: string;
    ip?: string;
  }): Promise<HttpResult> {
    const headers: Record<string, string> = {};
    if (options.body) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.csrf) headers['x-csrf-token'] = options.csrf;
    if (options.tenantId) headers['x-tilivo-tenant-id'] = options.tenantId;
    if (options.ip) headers['x-forwarded-for'] = options.ip;
    const response = await app.inject({
      method: options.method,
      url: options.url,
      headers,
      payload: options.body,
    });
    let parsed: any;
    try {
      parsed = response.json();
    } catch {
      parsed = null;
    }
    return { status: response.statusCode, body: parsed, cookie: cookieHeader(response) };
  }

  async function registerLogin(ip: string): Promise<{ cookie: string; csrf: string; email: string }> {
    const email = nextEmail();
    const register = await request({
      method: 'POST',
      url: '/api/v1/auth/register',
      body: { email, password: PASSWORD },
      ip,
    });
    expect(register.status).toBe(202);
    const mail = await pool.query(
      'SELECT body FROM dev_email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    const verify = await request({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      body: { token: parseToken(String(mail.rows[0]!.body)) },
      ip,
    });
    expect(verify.status).toBe(200);
    const login = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email, password: PASSWORD },
      ip,
    });
    expect(login.status).toBe(200);
    return { cookie: login.cookie, csrf: login.body.csrf_token as string, email };
  }

  async function createTenant(
    auth: { cookie: string; csrf: string },
    name: string,
    ip: string,
  ): Promise<{ tenantId: string }> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/tenants',
      body: { name, company: { legal_name: name, country_code: 'EE', base_currency: 'EUR' } },
      cookie: auth.cookie,
      csrf: auth.csrf,
      ip,
    });
    expect(result.status).toBe(201);
    return { tenantId: result.body.tenant.id as string };
  }

  async function addMember(
    owner: { cookie: string; csrf: string },
    tenantId: string,
    email: string,
    roleName: string,
    ip: string,
  ): Promise<void> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/members',
      body: { email, role_name: roleName },
      cookie: owner.cookie,
      csrf: owner.csrf,
      tenantId,
      ip,
    });
    expect(result.status).toBe(201);
  }

  async function createAccount(
    auth: { cookie: string; csrf: string; tenantId: string },
    code: string,
    name: string,
    type: string,
  ): Promise<string> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/accounts',
      body: { code, name, type },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.40.1',
    });
    expect(result.status).toBe(201);
    return result.body.account.id as string;
  }

  async function createYearPeriod(
    auth: { cookie: string; csrf: string; tenantId: string },
    year = 2026,
  ): Promise<string> {
    const yearResult = await request({
      method: 'POST',
      url: '/api/v1/fiscal-years',
      body: { name: `FY ${year}`, start_date: `${year}-01-01`, end_date: `${year}-12-31` },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.40.1',
    });
    expect(yearResult.status).toBe(201);
    const periodResult = await request({
      method: 'POST',
      url: '/api/v1/accounting-periods',
      body: {
        fiscal_year_id: yearResult.body.fiscal_year.id,
        name: `P ${year}`,
        start_date: `${year}-01-01`,
        end_date: `${year}-12-31`,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.40.1',
    });
    expect(periodResult.status).toBe(201);
    return periodResult.body.period.id as string;
  }

  async function createJournal(
    auth: { cookie: string; csrf: string; tenantId: string },
    lines: Array<{ account_id: string; debit?: string; credit?: string }>,
    description = 'Security journal',
    date = '2026-02-10',
  ): Promise<string> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: date,
        description,
        currency_code: 'EUR',
        lines: lines.map((l) => ({ account_id: l.account_id, debit: l.debit ?? '0', credit: l.credit ?? '0' })),
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.40.1',
    });
    expect(result.status).toBe(201);
    return result.body.journal_id as string;
  }

  it('enforces accounting role permissions', async () => {
    const owner = await registerLogin('10.0.40.10');
    const tenant = await createTenant(owner, 'Perm Matrix Oy', '10.0.40.10');
    const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, tenantId: tenant.tenantId };
    const periodId = await createYearPeriod(ownerAuth, 2026);
    const asset = await createAccount(ownerAuth, '1000', 'Cash', 'ASSET');
    const revenue = await createAccount(ownerAuth, '3000', 'Revenue', 'REVENUE');

    const accountant = await registerLogin('10.0.40.11');
    await addMember(owner, tenant.tenantId, accountant.email, 'Accountant', '10.0.40.10');
    const accountantAuth = { cookie: accountant.cookie, csrf: accountant.csrf, tenantId: tenant.tenantId };

    const read = await request({
      method: 'GET',
      url: '/api/v1/accounts',
      cookie: accountantAuth.cookie,
      tenantId: tenant.tenantId,
      ip: '10.0.40.11',
    });
    expect(read.status).toBe(200);

    const journalId = await createJournal(accountantAuth, [
      { account_id: asset, debit: '100' },
      { account_id: revenue, credit: '100' },
    ]);
    const post = await request({
      method: 'POST',
      url: `/api/v1/journals/${journalId}/post`,
      cookie: accountantAuth.cookie,
      csrf: accountantAuth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.11',
    });
    expect(post.status).toBe(200);

    const reverseDenied = await request({
      method: 'POST',
      url: `/api/v1/journals/${journalId}/reverse`,
      body: { reason: 'Accountants cannot reverse by policy' },
      cookie: accountantAuth.cookie,
      csrf: accountantAuth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.11',
    });
    expect(reverseDenied.status).toBe(403);
    expect(reverseDenied.body.error.code).toBe(ErrorCodes.memberPermissionDenied);

    const manageDenied = await request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${periodId}`,
      body: { status: 'CLOSED' },
      cookie: accountantAuth.cookie,
      csrf: accountantAuth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.11',
    });
    expect(manageDenied.status).toBe(403);

    for (const mutation of [
      ['POST', '/api/v1/accounts'],
      ['POST', '/api/v1/fiscal-years'],
      ['POST', '/api/v1/accounting-periods'],
      ['POST', '/api/v1/tax-codes'],
      ['POST', '/api/v1/fx-rates'],
    ] as const) {
      const denied = await request({
        method: mutation[0],
        url: mutation[1],
        body: mutation[1] === '/api/v1/accounts'
          ? { code: '9999', name: 'Nope', type: 'ASSET' }
          : mutation[1] === '/api/v1/fiscal-years'
            ? { name: 'FY 2099', start_date: '2099-01-01', end_date: '2099-12-31' }
            : mutation[1] === '/api/v1/accounting-periods'
              ? { fiscal_year_id: '00000000-0000-4000-8000-000000000000', name: 'Nope', start_date: '2099-01-01', end_date: '2099-01-31' }
              : mutation[1] === '/api/v1/tax-codes'
                ? { code: 'X', name: 'X', country_code: 'EE', rate: 20, effective_from: '2099-01-01' }
                : { base_currency: 'EUR', quote_currency: 'USD', rate: 1, rate_date: '2099-01-01' },
        cookie: accountantAuth.cookie,
        csrf: accountantAuth.csrf,
        tenantId: tenant.tenantId,
        ip: '10.0.40.11',
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe(ErrorCodes.memberPermissionDenied);
    }

    const ownerReverse = await request({
      method: 'POST',
      url: `/api/v1/journals/${journalId}/reverse`,
      body: { reason: 'Owner policy override' },
      cookie: ownerAuth.cookie,
      csrf: ownerAuth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.10',
    });
    expect(ownerReverse.status).toBe(200);

    const ownerClose = await request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${periodId}`,
      body: { status: 'CLOSED' },
      cookie: ownerAuth.cookie,
      csrf: ownerAuth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.10',
    });
    expect(ownerClose.status).toBe(200);

    for (const role of ['Viewer', 'Employee']) {
      const member = await registerLogin(`10.0.40.${role === 'Viewer' ? 12 : 13}`);
      await addMember(owner, tenant.tenantId, member.email, role, '10.0.40.10');
      for (const url of [
        '/api/v1/accounts',
        '/api/v1/journals',
        '/api/v1/ledger',
        '/api/v1/tax-codes',
        '/api/v1/fx-rates',
        '/api/v1/currencies',
        '/api/v1/reports/trial-balance',
      ]) {
        const denied = await request({
          method: 'GET',
          url,
          cookie: member.cookie,
          tenantId: tenant.tenantId,
          ip: `10.0.40.${role === 'Viewer' ? 12 : 13}`,
        });
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe(ErrorCodes.memberPermissionDenied);
      }
    }
  }, 60_000);

  it('isolates accounting data between tenants and enforces RLS', async () => {
    const ownerA = await registerLogin('10.0.40.20');
    const tenantA = await createTenant(ownerA, 'Tenant A Sec Oy', '10.0.40.20');
    const authA = { cookie: ownerA.cookie, csrf: ownerA.csrf, tenantId: tenantA.tenantId };
    await createYearPeriod(authA, 2026);
    const assetA = await createAccount(authA, '1000', 'Cash A', 'ASSET');
    const revenueA = await createAccount(authA, '3000', 'Revenue A', 'REVENUE');
    const journalA = await createJournal(authA, [
      { account_id: assetA, debit: '250' },
      { account_id: revenueA, credit: '250' },
    ]);
    const postedA = await request({
      method: 'POST',
      url: `/api/v1/journals/${journalA}/post`,
      cookie: authA.cookie,
      csrf: authA.csrf,
      tenantId: tenantA.tenantId,
      ip: '10.0.40.20',
    });
    expect(postedA.status).toBe(200);
    const taxA = await request({
      method: 'POST',
      url: '/api/v1/tax-codes',
      body: { code: 'A_TAX', name: 'A tax', country_code: 'EE', rate: 20, effective_from: '2026-01-01' },
      cookie: authA.cookie,
      csrf: authA.csrf,
      tenantId: tenantA.tenantId,
      ip: '10.0.40.20',
    });
    expect(taxA.status).toBe(201);
    const fxA = await request({
      method: 'POST',
      url: '/api/v1/fx-rates',
      body: { base_currency: 'EUR', quote_currency: 'USD', rate: 1.1, rate_date: '2026-03-01' },
      cookie: authA.cookie,
      csrf: authA.csrf,
      tenantId: tenantA.tenantId,
      ip: '10.0.40.20',
    });
    expect(fxA.status).toBe(201);

    const ownerB = await registerLogin('10.0.40.21');
    const tenantB = await createTenant(ownerB, 'Tenant B Sec Oy', '10.0.40.21');
    const authB = { cookie: ownerB.cookie, csrf: ownerB.csrf, tenantId: tenantB.tenantId };

    const bJournals = await request({
      method: 'GET',
      url: '/api/v1/journals',
      cookie: authB.cookie,
      tenantId: tenantB.tenantId,
      ip: '10.0.40.21',
    });
    expect(bJournals.status).toBe(200);
    expect(bJournals.body.total).toBe(0);

    for (const url of ['/api/v1/ledger', '/api/v1/tax-codes', '/api/v1/fx-rates']) {
      const bList = await request({
        method: 'GET',
        url,
        cookie: authB.cookie,
        tenantId: tenantB.tenantId,
        ip: '10.0.40.21',
      });
      expect(bList.status).toBe(200);
      const key = url === '/api/v1/ledger' ? 'ledger' : url === '/api/v1/tax-codes' ? 'tax_codes' : 'fx_rates';
      expect(Array.isArray(bList.body[key]) ? bList.body[key].length : bList.body.total).toBe(0);
    }

    const bJournalDetail = await request({
      method: 'GET',
      url: `/api/v1/journals/${journalA}`,
      cookie: authB.cookie,
      tenantId: tenantB.tenantId,
      ip: '10.0.40.21',
    });
    expect(bJournalDetail.status).toBe(404);
    expect(bJournalDetail.body.error.code).toBe(ErrorCodes.journalNotFound);

    const bAccountLedger = await request({
      method: 'GET',
      url: `/api/v1/accounts/${assetA}/ledger`,
      cookie: authB.cookie,
      tenantId: tenantB.tenantId,
      ip: '10.0.40.21',
    });
    expect(bAccountLedger.status).toBe(404);

    const taxId = taxA.body.tax_code.id as string;
    const bTaxPatch = await request({
      method: 'PATCH',
      url: `/api/v1/tax-codes/${taxId}`,
      body: { rate: 1 },
      cookie: authB.cookie,
      csrf: authB.csrf,
      tenantId: tenantB.tenantId,
      ip: '10.0.40.21',
    });
    expect(bTaxPatch.status).toBe(404);

    const crossTenantDraft = await request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: '2026-02-10',
        description: 'Cross tenant attempt',
        currency_code: 'EUR',
        lines: [
          { account_id: assetA, debit: '10' },
          { account_id: assetA, credit: '10' },
        ],
      },
      cookie: authB.cookie,
      csrf: authB.csrf,
      tenantId: tenantB.tenantId,
      ip: '10.0.40.21',
    });
    expect(crossTenantDraft.status).toBe(400);
    expect(crossTenantDraft.body.error.code).toBe(ErrorCodes.accountNotFound);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
      const aCount = await client.query(`SELECT count(*)::int AS count FROM journal_entries`);
      expect(aCount.rows[0]!.count).toBe(1);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB.tenantId]);
      const bCount = await client.query(`SELECT count(*)::int AS count FROM journal_entries`);
      expect(bCount.rows[0]!.count).toBe(0);
      await client.query('COMMIT');

      await client.query('BEGIN');
      const none = await client.query(`SELECT count(*)::int AS count FROM journal_entries`);
      expect(none.rows[0]!.count).toBe(0);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.tenantId]);
      await expect(
        client.query(
          `INSERT INTO journal_entries (tenant_id, business_date, description)
           VALUES ($1, '2026-05-05', 'Spoofed tenant insert')`,
          [tenantB.tenantId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 60_000);

  it('guards accounting routes with authentication, CSRF and input validation', async () => {
    const owner = await registerLogin('10.0.40.30');
    const tenant = await createTenant(owner, 'Auth Guards Oy', '10.0.40.30');
    const auth = { cookie: owner.cookie, csrf: owner.csrf, tenantId: tenant.tenantId };
    const periodId = await createYearPeriod(auth, 2026);
    const asset = await createAccount(auth, '1000', 'Cash', 'ASSET');
    const revenue = await createAccount(auth, '3000', 'Revenue', 'REVENUE');

    const unauth = await request({ method: 'GET', url: '/api/v1/journals', ip: '10.0.40.30' });
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe(ErrorCodes.authSessionInvalid);

    const badTenant = await request({
      method: 'GET',
      url: '/api/v1/journals',
      cookie: auth.cookie,
      tenantId: 'not-a-uuid',
      ip: '10.0.40.30',
    });
    expect(badTenant.status).toBe(400);
    expect(badTenant.body.error.code).toBe(ErrorCodes.tenantInvalid);

    const journalId = await createJournal(auth, [
      { account_id: asset, debit: '10' },
      { account_id: revenue, credit: '10' },
    ]);
    const noCsrf = await request({
      method: 'POST',
      url: `/api/v1/journals/${journalId}/post`,
      cookie: auth.cookie,
      tenantId: tenant.tenantId,
      ip: '10.0.40.30',
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe(ErrorCodes.authCsrfInvalid);

    const unbalancedDraft = await createJournal(auth, [
      { account_id: asset, debit: '10' },
      { account_id: revenue, credit: '5' },
    ]);
    const unbalanced = await request({
      method: 'POST',
      url: `/api/v1/journals/${unbalancedDraft}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.30',
    });
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.error.code).toBe(ErrorCodes.journalNotBalanced);

    const inactiveId = await createJournal(auth, [
      { account_id: asset, debit: '15' },
      { account_id: revenue, credit: '15' },
    ]);
    await withTenantTransaction(pool, tenant.tenantId, async (client) => {
      await client.query(`UPDATE accounts SET is_active = false WHERE id = $1`, [revenue]);
    });
    const inactivePost = await request({
      method: 'POST',
      url: `/api/v1/journals/${inactiveId}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.30',
    });
    expect(inactivePost.status).toBe(400);
    expect(inactivePost.body.error.code).toBe(ErrorCodes.accountInactive);
    await withTenantTransaction(pool, tenant.tenantId, async (client) => {
      await client.query(`UPDATE accounts SET is_active = true WHERE id = $1`, [revenue]);
    });

    const closeNoPermission = await request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${periodId}`,
      body: { status: 'BOGUS' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: tenant.tenantId,
      ip: '10.0.40.30',
    });
    expect(closeNoPermission.status).toBe(400);
    expect(closeNoPermission.body.error.code).toBe(ErrorCodes.invalidPeriodRange);
  }, 60_000);
});
