import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/db/pool';

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

describe.skipIf(!databaseUrl)('multi-tenant integration and RLS', () => {
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
    return `tenant${counter}@example.com`;
  }

  function emailOfLastRegistered(): string {
    return `tenant${counter}@example.com`;
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

  async function registerUser(ip: string): Promise<string> {
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
    return login.cookie;
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
      body: {
        name,
        company: {
          legal_name: name,
          country_code: 'FI',
          base_currency: 'EUR',
        },
      },
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

  it('lets an authenticated user create a tenant and become Owner', async () => {
    const cookie = await registerUser('10.0.10.10');
    const login = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.10',
    });
    const csrf = login.body.csrf_token as string;
    const created = await createTenant(login.cookie, csrf, 'Owner Test Oy', '10.0.10.10');

    const members = await request({
      method: 'GET',
      url: '/api/v1/members',
      cookie,
      tenantId: created.tenantId,
      ip: '10.0.10.10',
    });
    expect(members.status).toBe(200);
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].roles).toContain('Owner');

    const company = await request({
      method: 'GET',
      url: '/api/v1/companies/current',
      cookie,
      tenantId: created.tenantId,
      ip: '10.0.10.10',
    });
    expect(company.status).toBe(200);
    expect(company.body.company.legal_name).toBe('Owner Test Oy');

    const tenants = await request({
      method: 'GET',
      url: '/api/v1/tenants',
      cookie,
      ip: '10.0.10.10',
    });
    expect(tenants.body.tenants.length).toBeGreaterThanOrEqual(1);
  });

  it('denies access to a user without membership', async () => {
    await registerUser('10.0.10.20');
    const loginA = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.20',
    });
    const tenant = await createTenant(loginA.cookie, loginA.body.csrf_token, 'Deny Tenant Oy', '10.0.10.20');
    const outsider = await registerUser('10.0.10.21');
    const attempt = await request({
      method: 'GET',
      url: '/api/v1/companies/current',
      cookie: outsider,
      tenantId: tenant.tenantId,
      ip: '10.0.10.21',
    });
    expect(attempt.status).toBe(404);
    expect(attempt.body.error.code).toBe('TENANT-002');
  });

  it('enforces permissions: Viewer can read but not manage', async () => {
    await registerUser('10.0.10.30');
    const ownerLogin = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.30',
    });
    const tenant = await createTenant(ownerLogin.cookie, ownerLogin.body.csrf_token, 'Permission Oy', '10.0.10.30');

    const viewerCookie = await registerUser('10.0.10.31');
    const viewerEmail = `tenant${counter}@example.com`;
    const userRow = await pool.query('SELECT id FROM users WHERE email_normalized = $1', [viewerEmail]);
    const add = await request({
      method: 'POST',
      url: '/api/v1/members',
      body: { email: viewerEmail, role_name: 'Viewer' },
      cookie: ownerLogin.cookie,
      csrf: ownerLogin.body.csrf_token,
      tenantId: tenant.tenantId,
      ip: '10.0.10.30',
    });
    expect(add.status).toBe(201);

    const viewerLogin = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: viewerEmail, password: PASSWORD },
      ip: '10.0.10.31',
    });
    const read = await request({
      method: 'GET',
      url: '/api/v1/companies/current',
      cookie: viewerCookie,
      tenantId: tenant.tenantId,
      ip: '10.0.10.31',
    });
    expect(read.status).toBe(200);

    const manage = await request({
      method: 'PATCH',
      url: '/api/v1/companies/current',
      body: { legal_name: 'Should Not Work' },
      cookie: viewerCookie,
      csrf: viewerLogin.body.csrf_token,
      tenantId: tenant.tenantId,
      ip: '10.0.10.31',
    });
    expect(manage.status).toBe(403);

    const escalation = await request({
      method: 'POST',
      url: `/api/v1/members/${userRow.rows[0]!.id}/roles`,
      body: { role_id: '00000000-0000-4000-8000-000000000000' },
      cookie: viewerCookie,
      csrf: viewerLogin.body.csrf_token,
      tenantId: tenant.tenantId,
      ip: '10.0.10.31',
    });
    expect(escalation.status).toBe(403);
  });

  it('protects the last Owner and allows removal when another Owner exists', async () => {
    await registerUser('10.0.10.40');
    const ownerEmail = emailOfLastRegistered();
    const ownerLogin = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.40',
    });
    const tenant = await createTenant(ownerLogin.cookie, ownerLogin.body.csrf_token, 'Owners Oy', '10.0.10.40');

    await registerUser('10.0.10.41');
    const secondOwnerEmail = emailOfLastRegistered();
    const add = await request({
      method: 'POST',
      url: '/api/v1/members',
      body: { email: secondOwnerEmail, role_name: 'Owner' },
      cookie: ownerLogin.cookie,
      csrf: ownerLogin.body.csrf_token,
      tenantId: tenant.tenantId,
      ip: '10.0.10.40',
    });
    expect(add.status).toBe(201);
    const membersAfterAdd = await request({
      method: 'GET',
      url: '/api/v1/members',
      cookie: ownerLogin.cookie,
      tenantId: tenant.tenantId,
      ip: '10.0.10.40',
    });
    const secondMembership = membersAfterAdd.body.members.find(
      (m: { email: string }) => m.email === secondOwnerEmail,
    );
    const memberId = secondMembership.id as string;

    const removeSecond = await request({
      method: 'DELETE',
      url: `/api/v1/members/${memberId}`,
      cookie: ownerLogin.cookie,
      csrf: ownerLogin.body.csrf_token,
      tenantId: tenant.tenantId,
      ip: '10.0.10.40',
    });
    expect(removeSecond.status).toBe(204);

    const members = await request({
      method: 'GET',
      url: '/api/v1/members',
      cookie: ownerLogin.cookie,
      tenantId: tenant.tenantId,
      ip: '10.0.10.40',
    });
    const ownerMembership = members.body.members.find(
      (m: { email: string }) => m.email === ownerEmail,
    );
    const removeLast = await request({
      method: 'DELETE',
      url: `/api/v1/members/${ownerMembership.id}`,
      cookie: ownerLogin.cookie,
      csrf: ownerLogin.body.csrf_token,
      tenantId: tenant.tenantId,
      ip: '10.0.10.40',
    });
    expect(removeLast.status).toBe(409);
    expect(removeLast.body.error.code).toBe('MEMBER-002');
  });

  it('RLS direct: runtime role sees only its tenant and nothing without context', async () => {
    await registerUser('10.0.10.50');
    const loginA = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.50',
    });
    const tenantA = await createTenant(loginA.cookie, loginA.body.csrf_token, 'RLS A Oy', '10.0.10.50');
    await registerUser('10.0.10.51');
    const loginB = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.51',
    });
    const tenantB = await createTenant(loginB.cookie, loginB.body.csrf_token, 'RLS B Oy', '10.0.10.51');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantA.tenantId]);
      const a = await client.query('SELECT id, tenant_id FROM companies');
      expect(a.rows).toHaveLength(1);
      expect(String(a.rows[0]!.tenant_id)).toBe(tenantA.tenantId);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantB.tenantId]);
      const b = await client.query('SELECT id, tenant_id FROM companies');
      expect(b.rows).toHaveLength(1);
      expect(String(b.rows[0]!.tenant_id)).toBe(tenantB.tenantId);
      await client.query('COMMIT');

      await client.query('BEGIN');
      const none = await client.query('SELECT id FROM companies');
      expect(none.rows).toHaveLength(0);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantA.tenantId]);
      await expect(
        client.query(
          `INSERT INTO companies (tenant_id, legal_name, country_code, base_currency)
           VALUES ($1, 'B fake', 'FI', 'EUR')`,
          [tenantB.tenantId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('keeps tenant context isolated under concurrent API use', async () => {
    const ownerA = await registerUser('10.0.10.60');
    const loginA = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.60',
    });
    const tenantA = await createTenant(loginA.cookie, loginA.body.csrf_token, 'Pool A Oy', '10.0.10.60');
    const ownerB = await registerUser('10.0.10.61');
    const loginB = await request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: `tenant${counter}@example.com`, password: PASSWORD },
      ip: '10.0.10.61',
    });
    const tenantB = await createTenant(loginB.cookie, loginB.body.csrf_token, 'Pool B Oy', '10.0.10.61');

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const isA = i % 2 === 0;
        const options = isA
          ? { cookie: ownerA, tenantId: tenantA.tenantId, ip: `10.0.11.${i}` }
          : { cookie: ownerB, tenantId: tenantB.tenantId, ip: `10.0.12.${i}` };
        return request({
          method: 'GET',
          url: '/api/v1/companies/current',
          ...options,
        });
      }),
    );
    for (const result of results) {
      expect(result.status).toBe(200);
      const tenantId = result.body.company.tenant_id as string;
      expect([tenantA.tenantId, tenantB.tenantId]).toContain(tenantId);
    }
  });
});
