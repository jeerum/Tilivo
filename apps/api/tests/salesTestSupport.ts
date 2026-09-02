import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/pool';

export const PASSWORD = 'correct horse battery staple';

export interface HttpResult {
  status: number;
  body: any;
  cookie: string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: Record<string, unknown>;
  cookie?: string;
  csrf?: string;
  tenantId?: string;
  ip?: string;
}

export function cookieHeader(response: { cookies?: Array<{ name: string; value: string }> }): string {
  return (response.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
}

export function expectStatus(result: HttpResult, expected: number, label: string): void {
  if (result.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

function parseToken(body: string): string {
  const match = body.match(/[?&]token=([^&\s]+)/);
  if (!match?.[1]) throw new Error(`No token in ${body}`);
  return decodeURIComponent(match[1]);
}

export interface SalesAuth {
  cookie: string;
  csrf: string;
  userId: string;
  tenantId: string;
  companyId: string;
}

export class SalesFixture {
  private counter = 0;
  private ipCounter = 0;

  constructor(
    private readonly app: FastifyInstance,
    private readonly pool: Db,
    private readonly prefix: string,
  ) {}

  async request(options: RequestOptions): Promise<HttpResult> {
    const headers: Record<string, string> = {};
    if (options.body) headers['content-type'] = 'application/json';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.csrf) headers['x-csrf-token'] = options.csrf;
    if (options.tenantId) headers['x-tilivo-tenant-id'] = options.tenantId;
    if (options.ip) headers['x-forwarded-for'] = options.ip;
    const response = await this.app.inject({
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

  nextEmail(): string {
    this.counter += 1;
    return `${this.prefix}${this.counter}@example.com`;
  }

  private nextIp(): string {
    this.ipCounter += 1;
    const octet = 1 + (this.ipCounter % 250);
    const third = 1 + Math.floor((this.ipCounter % 25000) / 250);
    return `10.0.${third}.${octet}`;
  }

  async registerUser(
    ip?: string,
  ): Promise<{ cookie: string; csrf: string; userId: string; email: string; ip: string }> {
    const usedIp = ip ?? this.nextIp();
    const email = this.nextEmail();
    const register = await this.request({
      method: 'POST',
      url: '/api/v1/auth/register',
      body: { email, password: PASSWORD },
      ip: usedIp,
    });
    expectStatus(register, 202, 'register');
    const mail = await this.pool.query(
      'SELECT body FROM dev_email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    const verify = await this.request({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      body: { token: parseToken(String(mail.rows[0]!.body)) },
      ip: usedIp,
    });
    expectStatus(verify, 200, 'verify email');
    const login = await this.request({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email, password: PASSWORD },
      ip: usedIp,
    });
    expectStatus(login, 200, 'login');
    const me = await this.request({ method: 'GET', url: '/api/v1/auth/me', cookie: login.cookie, ip: usedIp });
    expectStatus(me, 200, 'me');
    return {
      cookie: login.cookie,
      csrf: login.body.csrf_token as string,
      userId: me.body.user.id as string,
      email,
      ip: usedIp,
    };
  }

  async createTenant(cookie: string, csrf: string, name: string, ip?: string): Promise<SalesAuth> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/tenants',
      body: { name, company: { legal_name: `${name} Oy`, country_code: 'FI', base_currency: 'EUR' } },
      cookie,
      csrf,
      ip: ip ?? '10.0.50.1',
    });
    expectStatus(result, 201, 'create tenant');
    return {
      cookie,
      csrf,
      userId: '',
      tenantId: result.body.tenant.id as string,
      companyId: result.body.company_id as string,
    };
  }

  async setupOwner(name: string, ip?: string): Promise<SalesAuth> {
    const user = await this.registerUser(ip);
    const uniqueName = `${name} ${this.counter}-${Date.now().toString(36)}`;
    const tenant = await this.createTenant(user.cookie, user.csrf, uniqueName, user.ip);
    return { ...tenant, userId: user.userId };
  }

  async createAccount(
    auth: SalesAuth,
    code: string,
    name: string,
    type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE',
  ): Promise<string> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/accounts',
      body: { code, name, type },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 201, `create account ${code}`);
    return result.body.account.id as string;
  }

  async createFiscalYear(auth: SalesAuth, name: string, start: string, end: string): Promise<string> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/fiscal-years',
      body: { name, start_date: start, end_date: end },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 201, `create fiscal year ${name}`);
    return result.body.fiscal_year.id as string;
  }

  async createPeriod(auth: SalesAuth, fiscalYearId: string, name: string, start: string, end: string): Promise<string> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/accounting-periods',
      body: { fiscal_year_id: fiscalYearId, name, start_date: start, end_date: end },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 201, `create period ${name}`);
    return result.body.period.id as string;
  }

  async createTaxCode(
    auth: SalesAuth,
    code: string,
    rate: number,
    type = 'VAT',
    reporting = 'TAXABLE',
  ): Promise<string> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/tax-codes',
      body: {
        code,
        name: code,
        country_code: 'FI',
        rate,
        type,
        effective_from: '2026-01-01',
        reporting_mapping: reporting,
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 201, `create tax code ${code}`);
    return result.body.tax_code.id as string;
  }

  async configureSales(
    auth: SalesAuth,
    options: { arAccountId: string; revenueAccountId: string; taxPayableAccountId: string; referenceType?: string },
  ): Promise<{ seriesId: string; settings: any }> {
    const current = await this.request({
      method: 'GET',
      url: '/api/v1/sales/settings',
      cookie: auth.cookie,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(current, 200, 'get sales settings');
    const seriesId = String(current.body.settings.default_invoice_series_id);
    const patched = await this.request({
      method: 'PATCH',
      url: '/api/v1/sales/settings',
      body: {
        accounts_receivable_account_id: options.arAccountId,
        default_sales_revenue_account_id: options.revenueAccountId,
        tax_payable_account_id: options.taxPayableAccountId,
        default_currency: 'EUR',
        payment_reference_type: options.referenceType ?? 'FI_DOMESTIC',
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(patched, 200, 'patch sales settings');
    return { seriesId, settings: patched.body.settings };
  }

  async createCustomer(auth: SalesAuth, name = 'Acme Customer Oy'): Promise<string> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/customers',
      body: {
        name,
        business_id: 'FI12345678',
        vat_id: 'FI12345678',
        email: 'customer@example.com',
        country_code: 'FI',
        language: 'fi',
        default_currency: 'EUR',
        payment_terms_days: 14,
        city: 'Helsinki',
        address_line1: 'Testikatu 1',
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 201, 'create customer');
    return result.body.customer.id as string;
  }

  async createDraft(
    auth: SalesAuth,
    customerId: string,
    lines: Array<{ description: string; quantity: string; unit_price: string; discount_percent?: string; tax_code_id: string }>,
    options: { issue_date?: string } = {},
  ): Promise<any> {
    const result = await this.request({
      method: 'POST',
      url: '/api/v1/sales/invoices',
      body: {
        customer_id: customerId,
        issue_date: options.issue_date ?? '2026-09-10',
        lines: lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price,
          discount_percent: line.discount_percent ?? '0',
          tax_code_id: line.tax_code_id,
        })),
      },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 201, 'create draft');
    return result.body.invoice;
  }

  async issueInvoice(auth: SalesAuth, invoiceId: string): Promise<any> {
    const result = await this.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/issue`,
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 200, 'issue invoice');
    return result.body;
  }

  async creditInvoice(auth: SalesAuth, invoiceId: string, reason = 'Full credit for test'): Promise<any> {
    const result = await this.request({
      method: 'POST',
      url: `/api/v1/sales/invoices/${invoiceId}/credit`,
      body: { reason },
      cookie: auth.cookie,
      csrf: auth.csrf,
      tenantId: auth.tenantId,
      ip: '10.0.50.1',
    });
    expectStatus(result, 200, 'credit invoice');
    return result.body;
  }

  async standardAccountingSetup(auth: SalesAuth, year = '2026'): Promise<{
    arAccountId: string;
    revenueAccountId: string;
    taxPayableAccountId: string;
    taxStandardId: string;
    taxZeroId: string;
    taxReducedId: string;
    fiscalYearId: string;
    periodId: string;
  }> {
    const arAccountId = await this.createAccount(auth, '1700', 'Accounts receivable', 'ASSET');
    const revenueAccountId = await this.createAccount(auth, '3000', 'Sales revenue', 'REVENUE');
    const taxPayableAccountId = await this.createAccount(auth, '2930', 'VAT payable', 'LIABILITY');
    const fiscalYearId = await this.createFiscalYear(auth, year, `${year}-01-01`, `${year}-12-31`);
    const periodId = await this.createPeriod(auth, fiscalYearId, `${year}-09`, `${year}-09-01`, `${year}-09-30`);
    const taxStandardId = await this.createTaxCode(auth, 'FI24', 24, 'VAT', 'TAXABLE');
    const taxZeroId = await this.createTaxCode(auth, 'FI0', 0, 'ZERO', 'ZERO');
    const taxReducedId = await this.createTaxCode(auth, 'FI14', 14, 'VAT', 'TAXABLE');
    void periodId;
    return {
      arAccountId,
      revenueAccountId,
      taxPayableAccountId,
      taxStandardId,
      taxZeroId,
      taxReducedId,
      fiscalYearId,
      periodId,
    };
  }
}
