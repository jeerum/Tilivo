import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  convertCurrency,
  createJournalDraft,
  createFxRate,
  createTaxCode,
  deleteFxRate,
  listCurrencies,
  listFxRates,
  listTaxCodes,
  postJournal,
  reopenPeriod,
  reverseJournal,
  setPeriodStatus,
  updateFxRate,
  updateTaxCode,
} from '../services/accountingService';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess, withTenantTransaction } from '../services/tenantService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const up = (value: string) => value.toUpperCase();
const currencyCode = z.string().trim().length(3).transform(up);
const rateNumber = z.coerce.number().finite();
const dateString = z.string().regex(DATE_RE, 'Invalid date');

const taxCodeCreateSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  country_code: z.string().trim().length(2).transform(up),
  rate: rateNumber.min(0).max(9999.9999),
  type: z.string().trim().min(1).max(40).default('VAT'),
  effective_from: dateString,
  effective_to: dateString.nullable().optional(),
  reporting_mapping: z.string().trim().max(200).nullable().optional(),
  is_active: z.boolean().optional(),
});
const taxCodePatchSchema = taxCodeCreateSchema.partial();

const fxRateSchema = z.object({
  base_currency: currencyCode,
  quote_currency: currencyCode,
  rate: rateNumber.positive().max(99999999),
  rate_date: dateString,
  source: z.string().trim().min(1).max(20).default('MANUAL'),
});
const fxRatePatchSchema = fxRateSchema.partial();

interface AccountingRouteOptions {
  db: Db;
  config: AppConfig;
}

async function context(request: FastifyRequest, db: Db, config: AppConfig) {
  const { user } = await resolveSessionUser(db, request, config);
  const value = request.headers['x-tilivo-tenant-id'];
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(ErrorCodes.tenantInvalid, 'Valid tenant id required', 400);
  const tenantId = value.toLowerCase();
  await resolveTenantAccess(db, user.id, tenantId);
  return { userId: user.id, tenantId };
}

function parseDateRange(values: { from?: string; to?: string }) {
  const from = values.from;
  const to = values.to;
  if (from !== undefined && !DATE_RE.test(from)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid from date', 400);
  if (to !== undefined && !DATE_RE.test(to)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid to date', 400);
  if (from && to && from > to) throw new AppError(ErrorCodes.invalidRequest, 'from must not be after to', 400);
  return { from, to };
}

export async function accountingRoutes(app: FastifyInstance, options: AccountingRouteOptions): Promise<void> {
  const { db, config } = options;

  app.get('/api/v1/accounts', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query('SELECT id, code, name, type, normal_balance, is_active FROM accounts ORDER BY code'),
    );
    return { accounts: result.rows };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/accounts', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'chart.manage');
    const body = request.body ?? {};
    const type = String(body.type ?? '');
    if (!['ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'].includes(type)) throw new AppError(ErrorCodes.tenantInvalid, 'Invalid account type', 400);
    const normal = ['ASSET','EXPENSE'].includes(type) ? 'DEBIT' : 'CREDIT';
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query(
        `INSERT INTO accounts (tenant_id, code, name, type, normal_balance) VALUES ($1,$2,$3,$4,$5) RETURNING id, code, name, type, normal_balance`,
        [tenantId, String(body.code), String(body.name), type, normal],
      ),
    );
    return reply.code(201).send({ account: result.rows[0] });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/fiscal-years', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'chart.manage');
    const body = request.body ?? {};
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query(
        `INSERT INTO fiscal_years (tenant_id, name, start_date, end_date) VALUES ($1,$2,$3,$4) RETURNING id, name, start_date, end_date, status`,
        [tenantId, String(body.name), String(body.start_date), String(body.end_date)],
      ),
    );
    return reply.code(201).send({ fiscal_year: result.rows[0] });
  });

  app.get('/api/v1/fiscal-years', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query('SELECT id, name, start_date, end_date, status FROM fiscal_years ORDER BY start_date'),
    );
    return { fiscal_years: result.rows };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/accounting-periods', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'period.manage');
    const body = request.body ?? {};
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query(
        `INSERT INTO accounting_periods (tenant_id, fiscal_year_id, name, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, name, start_date, end_date, status`,
        [tenantId, String(body.fiscal_year_id), String(body.name), String(body.start_date), String(body.end_date)],
      ),
    );
    return reply.code(201).send({ period: result.rows[0] });
  });

  app.get('/api/v1/accounting-periods', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query('SELECT id, fiscal_year_id, name, start_date, end_date, status FROM accounting_periods ORDER BY start_date'),
    );
    return { periods: result.rows };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/journals', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'journal.create');
    const body = request.body ?? {};
    const lines = (body.lines ?? []) as Array<Record<string, unknown>>;
    const id = await createJournalDraft(db, tenantId, userId, {
      businessDate: String(body.business_date),
      description: String(body.description ?? ''),
      currencyCode: String(body.currency_code ?? 'EUR'),
      lines: lines.map((line) => ({
        accountId: String(line.account_id),
        description: line.description === undefined ? undefined : String(line.description),
        debit: String(line.debit ?? 0),
        credit: String(line.credit ?? 0),
        taxCodeId: line.tax_code_id === undefined || line.tax_code_id === null ? null : String(line.tax_code_id),
      })),
    });
    return reply.code(201).send({ journal_id: id, status: 'DRAFT' });
  });

  app.get('/api/v1/currencies', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const currencies = await listCurrencies(db);
    return { currencies };
  });

  app.get('/api/v1/tax-codes', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const taxCodes = await listTaxCodes(db, tenantId);
    return { tax_codes: taxCodes };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/tax-codes', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'chart.manage');
    const parsed = taxCodeCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.taxCodeInvalid, 'Invalid tax code payload', 400, parsed.error.flatten());
    }
    const body = parsed.data;
    if (body.effective_to && body.effective_from > body.effective_to) {
      throw new AppError(ErrorCodes.taxCodeInvalid, 'effective_to must be after effective_from', 400);
    }
    const taxCode = await createTaxCode(db, tenantId, {
      code: body.code,
      name: body.name,
      countryCode: body.country_code,
      rate: String(body.rate),
      type: body.type,
      effectiveFrom: body.effective_from,
      effectiveTo: body.effective_to,
      reportingMapping: body.reporting_mapping,
      isActive: body.is_active,
    });
    return reply.code(201).send({ tax_code: taxCode });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/tax-codes/:id',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'chart.manage');
      const parsed = taxCodePatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.taxCodeInvalid, 'Invalid tax code payload', 400, parsed.error.flatten());
      }
      const body = parsed.data;
      if (body.effective_from && body.effective_to && body.effective_from > body.effective_to) {
        throw new AppError(ErrorCodes.taxCodeInvalid, 'effective_to must be after effective_from', 400);
      }
      const taxCode = await updateTaxCode(db, tenantId, request.params.id, {
        code: body.code,
        name: body.name,
        countryCode: body.country_code,
        rate: body.rate === undefined ? undefined : String(body.rate),
        type: body.type,
        effectiveFrom: body.effective_from,
        effectiveTo: body.effective_to,
        reportingMapping: body.reporting_mapping,
        isActive: body.is_active,
      });
      return reply.send({ tax_code: taxCode });
    },
  );

  app.get('/api/v1/fx-rates', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const query = request.query as { base_currency?: string; quote_currency?: string; from?: string; to?: string };
    const range = parseDateRange({ from: query.from, to: query.to });
    const fxRates = await listFxRates(db, tenantId, {
      baseCurrency: query.base_currency ? String(query.base_currency).toUpperCase() : undefined,
      quoteCurrency: query.quote_currency ? String(query.quote_currency).toUpperCase() : undefined,
      from: range.from,
      to: range.to,
    });
    return { fx_rates: fxRates };
  });

  app.get('/api/v1/fx-rates/convert', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const query = request.query as { from?: string; to?: string; date?: string; amount?: string };
    const from = String(query.from ?? '').toUpperCase();
    const to = String(query.to ?? '').toUpperCase();
    const date = String(query.date ?? '');
    const amount = Number(query.amount);
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
      throw new AppError(ErrorCodes.fxRateInvalid, 'from and to must be ISO currency codes', 400);
    }
    if (!DATE_RE.test(date)) throw new AppError(ErrorCodes.fxRateInvalid, 'date is required (YYYY-MM-DD)', 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError(ErrorCodes.fxRateInvalid, 'amount must be a positive number', 400);
    }
    const conversion = await convertCurrency(db, tenantId, {
      from,
      to,
      date,
      amount: String(amount),
    });
    return { conversion };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/fx-rates', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'chart.manage');
    const parsed = fxRateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.fxRateInvalid, 'Invalid FX rate payload', 400, parsed.error.flatten());
    }
    const body = parsed.data;
    if (body.base_currency === body.quote_currency) {
      throw new AppError(ErrorCodes.fxRateInvalid, 'base and quote currency must differ', 400);
    }
    const fxRate = await createFxRate(db, tenantId, {
      baseCurrency: body.base_currency,
      quoteCurrency: body.quote_currency,
      rate: String(body.rate),
      rateDate: body.rate_date,
      source: body.source,
    });
    return reply.code(201).send({ fx_rate: fxRate });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/fx-rates/:id',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'chart.manage');
      const parsed = fxRatePatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.fxRateInvalid, 'Invalid FX rate payload', 400, parsed.error.flatten());
      }
      const body = parsed.data;
      if (body.base_currency !== undefined || body.quote_currency !== undefined) {
        throw new AppError(ErrorCodes.fxRateInvalid, 'base and quote currency cannot be changed', 400);
      }
      const fxRate = await updateFxRate(db, tenantId, request.params.id, {
        rate: body.rate === undefined ? undefined : String(body.rate),
        rateDate: body.rate_date,
        source: body.source,
      });
      return reply.send({ fx_rate: fxRate });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/v1/fx-rates/:id', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'chart.manage');
    await deleteFxRate(db, tenantId, request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/v1/journals/:id/post', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'journal.post');
    const entryNumber = await postJournal(db, tenantId, request.params.id, userId);
    return reply.send({ status: 'POSTED', entry_number: entryNumber });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/v1/journals/:id/reverse',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'journal.reverse');
      const number = await reverseJournal(db, tenantId, request.params.id, userId, String(request.body?.reason ?? ''));
      return reply.send({ status: 'REVERSED', reversal_entry_number: number });
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: string } }>(
    '/api/v1/accounting-periods/:id',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'period.manage');
      const status = String(request.body?.status ?? '');
      if (status !== 'SOFT_CLOSED' && status !== 'CLOSED') throw new AppError(ErrorCodes.invalidPeriodRange, 'Invalid period status', 400);
      await setPeriodStatus(db, tenantId, request.params.id, status, userId);
      return reply.send({ message: 'Period updated' });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/v1/accounting-periods/:id/reopen',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'period.reopen');
      await reopenPeriod(db, tenantId, request.params.id, userId, String(request.body?.reason ?? ''));
      return reply.send({ message: 'Period reopened' });
    },
  );

  app.get('/api/v1/ledger', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 100), 500);
    const result = await withTenantTransaction(db, tenantId, (client) =>
      client.query(
        `SELECT je.id, je.entry_number, je.business_date, je.description, l.line_number,
                a.code AS account_code, l.debit, l.credit
         FROM journal_entries je
         JOIN journal_lines l ON l.journal_entry_id = je.id
         JOIN accounts a ON a.id = l.account_id
         WHERE je.status = 'POSTED'
         ORDER BY je.business_date DESC, je.entry_number DESC
         LIMIT $1`,
        [limit],
      ),
    );
    return { ledger: result.rows };
  });
}
