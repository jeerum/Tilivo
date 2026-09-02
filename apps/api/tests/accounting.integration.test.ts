import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';
import { AppError, ErrorCodes } from '../src/lib/errors';
import {
  createJournalDraft,
  postJournal,
  reverseJournal,
  setPeriodStatus,
} from '../src/services/accountingService';
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

function expectStatus(result: HttpResult, expected: number, label: string): void {
  if (result.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

describe.skipIf(!databaseUrl)('v0.5 accounting core', () => {
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
    return `acc${counter}@example.com`;
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

  async function registerUser(ip: string): Promise<{ cookie: string; csrf: string; email: string }> {
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
    cookie: string,
    csrf: string,
    name: string,
    ip: string,
  ): Promise<{ tenantId: string; companyId: string }> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/tenants',
      body: { name, company: { legal_name: name, country_code: 'EE', base_currency: 'EUR' } },
      cookie,
      csrf,
      ip,
    });
    expect(result.status).toBe(201);
    return {
      tenantId: result.body.tenant.id as string,
      companyId: result.body.company_id as string,
    };
  }

  async function setupTenant(ip: string, name: string) {
    const login = await registerUser(ip);
    const { cookie, csrf } = login;
    const me = await request({ method: 'GET', url: '/api/v1/auth/me', cookie: login.cookie, ip });
    const userId = me.body.user.id as string;
    const tenant = await createTenant(cookie, csrf, name, ip);
    return { cookie, csrf, userId, ...tenant };
  }

  async function createAccount(
    auth: { cookie: string; csrf: string; tenantId: string },
    code: string,
    name: string,
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE',
  ): Promise<string> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/accounts',
      body: { code, name, type },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.1',
    });
    expect(result.status).toBe(201);
    return result.body.account.id as string;
  }

  async function createFiscalYear(
    auth: { cookie: string; csrf: string; tenantId: string },
    name: string,
    start: string,
    end: string,
  ): Promise<string> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/fiscal-years',
      body: { name, start_date: start, end_date: end },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.1',
    });
    expect(result.status).toBe(201);
    return result.body.fiscal_year.id as string;
  }

  async function createPeriod(
    auth: { cookie: string; csrf: string; tenantId: string },
    fiscalYearId: string,
    name: string,
    start: string,
    end: string,
  ): Promise<string> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/accounting-periods',
      body: { fiscal_year_id: fiscalYearId, name, start_date: start, end_date: end },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.1',
    });
    expect(result.status).toBe(201);
    return result.body.period.id as string;
  }

  async function createDraft(
    auth: { cookie: string; csrf: string; tenantId: string },
    businessDate: string,
    description: string,
    lines: Array<{ account_id: string; debit?: string; credit?: string }>,
  ): Promise<string> {
    const result = await request({
      method: 'POST',
      url: '/api/v1/journals',
      body: {
        business_date: businessDate,
        description,
        currency_code: 'EUR',
        lines: lines.map((line) => ({
          account_id: line.account_id,
          debit: line.debit ?? '0',
          credit: line.credit ?? '0',
        })),
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.1',
    });
    expect(result.status).toBe(201);
    return result.body.journal_id as string;
  }

  async function standardAccounts(auth: { cookie: string; csrf: string; tenantId: string }) {
    const asset = await createAccount(auth, '1000', 'Cash', 'ASSET');
    const bank = await createAccount(auth, '1100', 'Bank', 'ASSET');
    const liability = await createAccount(auth, '2000', 'Payables', 'LIABILITY');
    const revenue = await createAccount(auth, '3000', 'Revenue', 'REVENUE');
    const expense = await createAccount(auth, '4000', 'Expenses', 'EXPENSE');
    return { asset, bank, liability, revenue, expense };
  }

  async function createOpenYearPeriod(
    auth: { cookie: string; csrf: string; tenantId: string },
    year = 2026,
  ): Promise<{ fiscalYearId: string; periodId: string }> {
    const fiscalYearId = await createFiscalYear(
      auth,
      `FY ${year}`,
      `${year}-01-01`,
      `${year}-12-31`,
    );
    const periodId = await createPeriod(
      auth,
      fiscalYearId,
      `P ${year}`,
      `${year}-01-01`,
      `${year}-12-31`,
    );
    return { fiscalYearId, periodId };
  }

  it('accounting lifecycle: draft, post, reverse and period close/reopen', async () => {
    const auth = await setupTenant('10.0.30.10', 'Lifecycle Oy');
    const accounts = await standardAccounts(auth);
    const { periodId } = await createOpenYearPeriod(auth, 2026);

    const draftId = await createDraft(
      auth,
      '2026-02-10',
      'Opening entry',
      [
        { account_id: accounts.asset, debit: '1250.00' },
        { account_id: accounts.revenue, credit: '1250.00' },
      ],
    );

    const post = await request({
      method: 'POST',
      url: `/api/v1/journals/${draftId}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(post.status).toBe(200);
    expect(post.body.status).toBe('POSTED');
    expect(String(post.body.entry_number)).toMatch(/^2026-\d{6}$/);

    const duplicate = await request({
      method: 'POST',
      url: `/api/v1/journals/${draftId}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe(ErrorCodes.journalNotDraft);

    const reversal = await request({
      method: 'POST',
      url: `/api/v1/journals/${draftId}/reverse`,
      body: { reason: 'Entered twice by mistake' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expectStatus(reversal, 200, 'reverse journal');
    expect(String(reversal.body.reversal_entry_number)).toMatch(/^2026-\d{6}$/);

    const doubleReverse = await request({
      method: 'POST',
      url: `/api/v1/journals/${draftId}/reverse`,
      body: { reason: 'Second attempt' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(doubleReverse.status).toBe(409);
    expect([ErrorCodes.journalNotDraft, ErrorCodes.journalAlreadyReversed]).toContain(
      doubleReverse.body.error.code,
    );

    const dbState = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const entry = await client.query(
        'SELECT status, reversed_by_entry_id, entry_number FROM journal_entries WHERE id = $1',
        [draftId],
      );
      const reversalCount = await client.query(
        'SELECT count(*)::int AS count FROM journal_reversals WHERE original_entry_id = $1',
        [draftId],
      );
      const reversalEntry = await client.query(
        `SELECT je.id, je.status FROM journal_entries je
         JOIN journal_reversals jr ON jr.reversal_entry_id = je.id
         WHERE jr.original_entry_id = $1`,
        [draftId],
      );
      return { entry: entry.rows[0], reversalCount: reversalCount.rows[0]!.count, reversalEntry: reversalEntry.rows[0] };
    });
    expect(dbState.entry.status).toBe('REVERSED');
    expect(dbState.entry.reversed_by_entry_id).toBeTruthy();
    expect(dbState.reversalCount).toBe(1);
    expect(dbState.reversalEntry.status).toBe('POSTED');

    const draftAfterReversal = await createDraft(
      auth,
      '2026-03-01',
      'Second entry',
      [
        { account_id: accounts.expense, debit: '50' },
        { account_id: accounts.bank, credit: '50' },
      ],
    );
    const close = await request({
      method: 'PATCH',
      url: `/api/v1/accounting-periods/${periodId}`,
      body: { status: 'CLOSED' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(close.status).toBe(200);

    const postInClosed = await request({
      method: 'POST',
      url: `/api/v1/journals/${draftAfterReversal}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(postInClosed.status).toBe(409);
    expect(postInClosed.body.error.code).toBe(ErrorCodes.periodClosed);

    const reopen = await request({
      method: 'POST',
      url: `/api/v1/accounting-periods/${periodId}/reopen`,
      body: { reason: 'Need to post March accrual' },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(reopen.status).toBe(200);

    const postAfterReopen = await request({
      method: 'POST',
      url: `/api/v1/journals/${draftAfterReversal}/post`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.30.10',
    });
    expect(postAfterReopen.status).toBe(200);
  });

  it('posted entries are immutable at the DB level (direct runtime access)', async () => {
    const auth = await setupTenant('10.0.30.20', 'Immutable Oy');
    const accounts = await standardAccounts(auth);
    await createOpenYearPeriod(auth, 2026);
    const draftId = await createDraft(
      auth,
      '2026-02-10',
      'Immutable check',
      [
        { account_id: accounts.asset, debit: '777.00' },
        { account_id: accounts.revenue, credit: '777.00' },
      ],
    );
    await postJournal(pool, auth.tenantId, draftId, auth.userId);

    const expectImmutable = async (operation: (client: any) => Promise<unknown>, match: string | RegExp) => {
      await expect(
        withTenantTransaction(pool, auth.tenantId, async (client) => {
          await operation(client);
        }),
      ).rejects.toMatchObject({ message: expect.stringMatching(match) });
    };

    await expectImmutable(
      (client) => client.query(`UPDATE journal_entries SET description = 'hacked' WHERE id = $1`, [draftId]),
      /immutable/,
    );
    await expectImmutable(
      (client) => client.query(`UPDATE journal_entries SET status = 'REVERSED' WHERE id = $1`, [draftId]),
      /reversal requires reversal entry linkage/,
    );
    await expectImmutable(
      (client) => client.query(`DELETE FROM journal_entries WHERE id = $1`, [draftId]),
      /immutable/,
    );
    await expectImmutable(
      (client) =>
        client.query(
          `INSERT INTO journal_entries (tenant_id, business_date, description, status)
           VALUES ($1, '2026-02-10', 'fake posted', 'POSTED')`,
          [auth.tenantId],
        ),
      /inserted with status DRAFT/,
    );
    await expectImmutable(
      (client) => client.query(`UPDATE journal_lines SET debit = '999' WHERE journal_entry_id = $1`, [draftId]),
      /immutable/,
    );
    await expectImmutable(
      (client) =>
        client.query(
          `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_number, account_id, debit, credit)
           VALUES ($1, $2, 99, $3, 1, 0)`,
          [auth.tenantId, draftId, accounts.revenue],
        ),
      /immutable/,
    );
    await expectImmutable(
      (client) => client.query(`DELETE FROM journal_lines WHERE journal_entry_id = $1`, [draftId]),
      /immutable/,
    );

    const after = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const entry = await client.query(
        'SELECT description, status, entry_number, posted_by, posted_at FROM journal_entries WHERE id = $1',
        [draftId],
      );
      const lines = await client.query(
        'SELECT debit, credit FROM journal_lines WHERE journal_entry_id = $1 ORDER BY line_number',
        [draftId],
      );
      return { entry: entry.rows[0], lines: lines.rows };
    });
    expect(after.entry.description).toBe('Immutable check');
    expect(after.entry.status).toBe('POSTED');
    expect(String(after.entry.entry_number)).toMatch(/^\d{4}-\d{6}$/);
    expect(after.entry.posted_by).toBe(auth.userId);
    expect(after.entry.posted_at).toBeTruthy();
    expect(Number(after.lines[0]!.debit)).toBe(777);
    expect(Number(after.lines[1]!.credit)).toBe(777);

    // A posted journal can only be marked reversed through a mirrored, linked reversal.
    const mirrorDraft = await createDraft(
      auth,
      '2026-02-10',
      'not a service reversal',
      [
        { account_id: accounts.revenue, debit: '777.00' },
        { account_id: accounts.asset, credit: '777.00' },
      ],
    );
    await expectImmutable(
      (client) =>
        client.query(
          `UPDATE journal_entries SET status = 'REVERSED', reversed_by_entry_id = $2 WHERE id = $1`,
          [draftId, mirrorDraft],
        ),
      /matching reversal record/,
    );
  });

  it('rejects double posting under concurrency', async () => {
    const auth = await setupTenant('10.0.30.30', 'Double Post Oy');
    const accounts = await standardAccounts(auth);
    await createOpenYearPeriod(auth, 2026);
    const draftId = await createDraft(
      auth,
      '2026-02-10',
      'Double post race',
      [
        { account_id: accounts.asset, debit: '10' },
        { account_id: accounts.revenue, credit: '10' },
      ],
    );
    const results = await Promise.allSettled([
      postJournal(pool, auth.tenantId, draftId, auth.userId),
      postJournal(pool, auth.tenantId, draftId, auth.userId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    expect((reason as AppError).code).toBe(ErrorCodes.journalNotDraft);

    const posted = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS count FROM journal_entries WHERE id = $1 AND status = 'POSTED'`,
        [draftId],
      );
      return result.rows[0]!.count;
    });
    expect(posted).toBe(1);
  });

  it('assigns unique sequential numbers under 100 parallel posts', async () => {
    const auth = await setupTenant('10.0.30.40', 'Parallel 100 Oy');
    const accounts = await standardAccounts(auth);
    await createOpenYearPeriod(auth, 2027);

    const draftIds: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      draftIds.push(
        await createJournalDraft(pool, auth.tenantId, auth.userId, {
          businessDate: '2027-03-15',
          description: `Parallel draft ${i}`,
          currencyCode: 'EUR',
          lines: [
            { accountId: accounts.asset, debit: '1.00', credit: '0' },
            { accountId: accounts.revenue, credit: '1.00', debit: '0' },
          ],
        }),
      );
    }

    const results = await Promise.allSettled(
      draftIds.map((id) => postJournal(pool, auth.tenantId, id, auth.userId)),
    );
    const numbers = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value);
    expect(numbers).toHaveLength(100);
    expect(new Set(numbers).size).toBe(100);
    numbers.sort();
    expect(numbers[0]).toBe('2027-000001');
    expect(numbers[99]).toBe('2027-000100');

    const stored = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS count, count(DISTINCT entry_number)::int AS distinct_count,
                min(entry_number) AS min_number, max(entry_number) AS max_number
         FROM journal_entries
         WHERE tenant_id = $1 AND status = 'POSTED'`,
        [auth.tenantId],
      );
      return result.rows[0];
    });
    expect(stored.count).toBe(100);
    expect(stored.distinct_count).toBe(100);
    expect(String(stored.min_number)).toBe('2027-000001');
    expect(String(stored.max_number)).toBe('2027-000100');
  });

  it('allows only one concurrent reversal per journal', async () => {
    const auth = await setupTenant('10.0.30.50', 'Reversal Race Oy');
    const accounts = await standardAccounts(auth);
    await createOpenYearPeriod(auth, 2026);
    const draftId = await createDraft(
      auth,
      '2026-02-10',
      'Reversal race',
      [
        { account_id: accounts.asset, debit: '88.00' },
        { account_id: accounts.revenue, credit: '88.00' },
      ],
    );
    await postJournal(pool, auth.tenantId, draftId, auth.userId);

    const results = await Promise.allSettled([
      reverseJournal(pool, auth.tenantId, draftId, auth.userId, 'First reversal attempt'),
      reverseJournal(pool, auth.tenantId, draftId, auth.userId, 'Second reversal attempt'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    // The loser can observe either the reversed status (JRN-002) or the
    // already-registered reversal (JRN-006); both must be denied.
    expect([ErrorCodes.journalNotDraft, ErrorCodes.journalAlreadyReversed]).toContain(
      (reason as AppError).code,
    );

    const state = await withTenantTransaction(pool, auth.tenantId, async (client) => {
      const original = await client.query(
        `SELECT status, reversed_by_entry_id FROM journal_entries WHERE id = $1`,
        [draftId],
      );
      const reversals = await client.query(
        `SELECT count(*)::int AS count FROM journal_reversals WHERE original_entry_id = $1`,
        [draftId],
      );
      return { original: original.rows[0], count: reversals.rows[0]!.count };
    });
    expect(state.original.status).toBe('REVERSED');
    expect(state.original.reversed_by_entry_id).toBeTruthy();
    expect(state.count).toBe(1);
  });

  it('period close vs post race always ends consistent', async () => {
    const auth = await setupTenant('10.0.30.60', 'Period Race Oy');
    const accounts = await standardAccounts(auth);
    const year = 2028;
    const fiscalYearId = await createFiscalYear(
      auth,
      `FY ${year}`,
      `${year}-01-01`,
      `${year}-12-31`,
    );

    const months = ['01', '02', '03', '04', '05', '06', '07', '08'];
    const drafts: Array<{ draftId: string; periodId: string; date: string }> = [];
    for (const month of months) {
      const start = `${year}-${month}-01`;
      const end = `${year}-${month}-28`;
      const periodId = await createPeriod(
        auth,
        fiscalYearId,
        `Race P ${month}`,
        start,
        end,
      );
      const draftId = await createDraft(
        auth,
        `${year}-${month}-10`,
        `Race draft ${month}`,
        [
          { account_id: accounts.expense, debit: '5.00' },
          { account_id: accounts.bank, credit: '5.00' },
        ],
      );
      drafts.push({ draftId, periodId, date: `${year}-${month}-10` });
    }

    for (const item of drafts) {
      const results = await Promise.allSettled([
        postJournal(pool, auth.tenantId, item.draftId, auth.userId),
        setPeriodStatus(pool, auth.tenantId, item.periodId, 'CLOSED', auth.userId),
      ]);
      const postResult = results[0]!;
      const closeResult = results[1]!;
      expect(closeResult.status).toBe('fulfilled');
      if (postResult.status === 'fulfilled') {
        expect((postResult as PromiseFulfilledResult<string>).value).toMatch(/^2028-\d{6}$/);
      } else {
        const reason = (postResult as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(AppError);
        expect([ErrorCodes.periodClosed, ErrorCodes.periodSoftClosed]).toContain(
          (reason as AppError).code,
        );
      }
      const state = await withTenantTransaction(pool, auth.tenantId, async (client) => {
        const period = await client.query('SELECT status FROM accounting_periods WHERE id = $1', [item.periodId]);
        const entry = await client.query('SELECT status FROM journal_entries WHERE id = $1', [item.draftId]);
        return { period: String(period.rows[0]!.status), entry: String(entry.rows[0]!.status) };
      });
      expect(state.period).toBe('CLOSED');
      if (postResult.status === 'fulfilled') {
        expect(state.entry).toBe('POSTED');
      } else {
        expect(state.entry).toBe('DRAFT');
      }
    }
  });
});
