import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  accountLedger,
  convertCurrency,
  createJournalDraft,
  createFxRate,
  createTaxCode,
  deleteFxRate,
  getJournal,
  ledgerLines,
  listCurrencies,
  listFxRates,
  listJournals,
  listTaxCodes,
  listTaxCodesActive,
  postOpeningBalances,
  postJournal,
  reopenPeriod,
  reverseJournal,
  setPeriodStatus,
  trialBalance,
  updateFxRate,
  updateTaxCode,
  vatSummary,
} from '../services/accountingService';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess, withTenantTransaction } from '../services/tenantService';
import { writeAuditEvent } from '../services/audit';

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
  direction: z.enum(['SALES', 'PURCHASE', 'BOTH']).default('BOTH'),
  treatment: z
    .enum([
      'STANDARD', 'REDUCED', 'ZERO_RATED', 'EXEMPT',
      'EU_GOODS_SUPPLY', 'EU_GOODS_ACQUISITION',
      'EU_SERVICE_SUPPLY', 'EU_SERVICE_ACQUISITION',
      'EXPORT', 'IMPORT', 'REVERSE_CHARGE',
      'CONSTRUCTION_REVERSE_CHARGE', 'OWN_USE',
    ])
    .optional(),
  reverse_charge: z.boolean().optional(),
  intra_eu: z.boolean().optional(),
  is_export: z.boolean().optional(),
  is_import: z.boolean().optional(),
  deductible_percent: rateNumber.min(0).max(100).optional(),
  legal_notes: z
    .record(z.string().trim().max(600))
    .refine((value) => Object.keys(value).length <= 5, 'Too many legal note languages')
    .optional(),
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
const openingBalanceSchema = z.object({
  business_date: dateString,
  description: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z
    .array(
      z.object({
        account_id: z.string().regex(UUID, 'Invalid account id'),
        debit: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid debit'),
        credit: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid credit'),
        description: z.string().trim().max(500).nullable().optional(),
        cost_center: z.string().trim().max(120).nullable().optional(),
        project_code: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .min(2)
    .max(500),
});

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
    await writeAuditEvent(db, 'ACCOUNT.CREATED', request, {
      userId,
      tenantId,
      objectType: 'account',
      objectId: String(result.rows[0]!.id),
      metadata: { code: String(body.code), name: String(body.name), type },
    });
    return reply.code(201).send({ account: result.rows[0] });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/accounts/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'chart.manage');
      const id = String(request.params.id).toLowerCase();
      if (!UUID.test(id)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid account id', 400);
      const body = request.body ?? {};
      const sets: string[] = [];
      const values: unknown[] = [id, tenantId];
      const setValue = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      const name = body.name;
      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) throw new AppError(ErrorCodes.invalidRequest, 'Account name is required', 400);
        setValue('name', trimmed);
      }
      const type = body.type;
      if (type !== undefined) {
        const accountType = String(type).toUpperCase();
        if (!['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].includes(accountType)) {
          throw new AppError(ErrorCodes.invalidRequest, 'Invalid account type', 400);
        }
        setValue('type', accountType);
        setValue('normal_balance', ['ASSET', 'EXPENSE'].includes(accountType) ? 'DEBIT' : 'CREDIT');
      }
      if (body.is_active !== undefined) {
        if (typeof body.is_active !== 'boolean') {
          throw new AppError(ErrorCodes.invalidRequest, 'is_active must be a boolean', 400);
        }
        setValue('is_active', body.is_active);
      }
      if (sets.length === 0) throw new AppError(ErrorCodes.invalidRequest, 'No account fields to update', 400);
      sets.push('updated_at = now()');
      const result = await withTenantTransaction(db, tenantId, (client) =>
        client.query(
          `UPDATE accounts SET ${sets.join(', ')}
           WHERE id = $1 AND tenant_id = $2
           RETURNING id, code, name, type, normal_balance, is_active`,
          values,
        ),
      );
      if (!result.rows[0]) throw new AppError(ErrorCodes.accountNotFound, 'Account not found', 404);
      await writeAuditEvent(db, 'ACCOUNT.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'account',
        objectId: id,
        metadata: { code: String(result.rows[0]!.code) },
      });
      return { account: result.rows[0] };
    },
  );

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
    const businessDate = String(body.business_date ?? '');
    if (!DATE_RE.test(businessDate)) throw new AppError(ErrorCodes.invalidRequest, 'Invalid business date', 400);
    if (
      body.document_date !== undefined &&
      body.document_date !== null &&
      !DATE_RE.test(String(body.document_date))
    ) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid document date', 400);
    }
    const lines = (body.lines ?? []) as Array<Record<string, unknown>>;
    const id = await createJournalDraft(db, tenantId, userId, {
      businessDate,
      documentDate: body.document_date === undefined || body.document_date === null
        ? null
        : String(body.document_date),
      description: String(body.description ?? ''),
      currencyCode: String(body.currency_code ?? 'EUR'),
      lines: lines.map((line) => ({
        accountId: String(line.account_id),
        description: line.description === undefined ? undefined : String(line.description),
        debit: String(line.debit ?? 0),
        credit: String(line.credit ?? 0),
        taxCodeId: line.tax_code_id === undefined || line.tax_code_id === null ? null : String(line.tax_code_id),
        costCenter: line.cost_center === undefined || line.cost_center === null ? null : String(line.cost_center),
        projectCode: line.project_code === undefined || line.project_code === null ? null : String(line.project_code),
      })),
    });
    await writeAuditEvent(db, 'JOURNAL.DRAFT_CREATED', request, {
      userId,
      tenantId,
      objectType: 'journal_entry',
      objectId: id,
      metadata: { business_date: String(body.business_date), description: String(body.description ?? '') },
    });
    return reply.code(201).send({ journal_id: id, status: 'DRAFT' });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/opening-balances', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'journal.create');
    await requirePermission(db, userId, tenantId, 'journal.post');
    const parsed = openingBalanceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid opening balance payload', 400, parsed.error.flatten());
    }
    const body = parsed.data;
    const result = await postOpeningBalances(db, tenantId, userId, {
      businessDate: body.business_date,
      description: body.description,
      note: body.note ?? undefined,
      lines: body.lines.map((line) => ({
        accountId: line.account_id,
        debit: line.debit,
        credit: line.credit,
        description: line.description ?? null,
        costCenter: line.cost_center ?? null,
        projectCode: line.project_code ?? null,
      })),
    });
    await writeAuditEvent(db, 'OPENING_BALANCE.POSTED', request, {
      userId,
      tenantId,
      objectType: 'journal_entry',
      objectId: result.entryId,
      metadata: {
        business_date: body.business_date,
        entry_number: result.entryNumber,
        note: body.note ?? '',
      },
    });
    return reply.code(201).send({ journal_id: result.entryId, entry_number: result.entryNumber });
  });

  app.get('/api/v1/journals', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const query = request.query as {
      status?: string;
      source_type?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };
    const status = query.status ? String(query.status).toUpperCase() : undefined;
    if (status && !['DRAFT', 'POSTED', 'REVERSED'].includes(status)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid journal status filter', 400);
    }
    const range = parseDateRange({ from: query.from, to: query.to });
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const result = await listJournals(db, tenantId, {
      status,
      sourceType: query.source_type ? String(query.source_type).toUpperCase() : undefined,
      from: range.from,
      to: range.to,
      limit,
      offset,
    });
    return { journals: result.journals, total: result.total };
  });

  app.get<{ Params: { id: string } }>('/api/v1/journals/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const journal = await getJournal(db, tenantId, request.params.id);
    return { journal };
  });

  app.get('/api/v1/currencies', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const currencies = await listCurrencies(db);
    return { currencies };
  });

  app.get('/api/v1/tax-codes', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'tax.read');
    const query = request.query as { current?: string; direction?: string };
    const direction = query.direction ? String(query.direction).toUpperCase() : undefined;
    const taxCodes =
      query.current === 'true'
        ? await listTaxCodesActive(db, tenantId, { direction })
        : await listTaxCodes(db, tenantId);
    return { tax_codes: taxCodes };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/tax-codes', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'chart.manage');
    await requirePermission(db, userId, tenantId, 'tax.manage');
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
      direction: body.direction,
      treatment: body.treatment,
      reverseCharge: body.reverse_charge,
      intraEu: body.intra_eu,
      isExport: body.is_export,
      isImport: body.is_import,
      deductiblePercent: body.deductible_percent === undefined ? undefined : String(body.deductible_percent),
      legalNotes: body.legal_notes,
      effectiveFrom: body.effective_from,
      effectiveTo: body.effective_to,
      reportingMapping: body.reporting_mapping,
      isActive: body.is_active,
    });
    await writeAuditEvent(db, 'TAX_CODE.CREATED', request, {
      userId,
      tenantId,
      objectType: 'tax_code',
      objectId: String(taxCode.id),
      metadata: { code: String(taxCode.code), rate: String(taxCode.rate) },
    });
    return reply.code(201).send({ tax_code: taxCode });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/tax-codes/:id',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'chart.manage');
      await requirePermission(db, userId, tenantId, 'tax.manage');
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
        direction: body.direction,
        treatment: body.treatment,
        reverseCharge: body.reverse_charge,
        intraEu: body.intra_eu,
        isExport: body.is_export,
        isImport: body.is_import,
        deductiblePercent: body.deductible_percent === undefined ? undefined : String(body.deductible_percent),
        legalNotes: body.legal_notes,
        effectiveFrom: body.effective_from,
        effectiveTo: body.effective_to,
        reportingMapping: body.reporting_mapping,
        isActive: body.is_active,
      });
      await writeAuditEvent(db, 'TAX_CODE.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'tax_code',
        objectId: String(taxCode.id),
        metadata: { code: String(taxCode.code) },
      });
      return reply.send({ tax_code: taxCode });
    },
  );

  app.get('/api/v1/vat-summary', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'tax.report.read');
    const query = request.query as Record<string, unknown>;
    const range = parseDateRange({
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
    });
    const summary = await vatSummary(db, tenantId, range);
    return { summary };
  });

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
    await writeAuditEvent(db, 'FX_RATE.CREATED', request, {
      userId,
      tenantId,
      objectType: 'fx_rate',
      objectId: String(fxRate.id),
      metadata: { base_currency: body.base_currency, quote_currency: body.quote_currency, rate: String(fxRate.rate) },
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
    await writeAuditEvent(db, 'JOURNAL.POSTED', request, {
      userId,
      tenantId,
      objectType: 'journal_entry',
      objectId: request.params.id,
      metadata: { entry_number: entryNumber },
    });
    return reply.send({ status: 'POSTED', entry_number: entryNumber });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/v1/journals/:id/reverse',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'journal.reverse');
      const number = await reverseJournal(db, tenantId, request.params.id, userId, String(request.body?.reason ?? ''));
      await writeAuditEvent(db, 'JOURNAL.REVERSED', request, {
        userId,
        tenantId,
        objectType: 'journal_entry',
        objectId: request.params.id,
        metadata: { reversal_entry_number: number },
      });
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
      await writeAuditEvent(db, status === 'CLOSED' ? 'PERIOD.CLOSED' : 'PERIOD.SOFT_CLOSED', request, {
        userId,
        tenantId,
        objectType: 'accounting_period',
        objectId: request.params.id,
      });
      return reply.send({ message: 'Period updated' });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/v1/accounting-periods/:id/reopen',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'period.reopen');
      await reopenPeriod(db, tenantId, request.params.id, userId, String(request.body?.reason ?? ''));
      await writeAuditEvent(db, 'PERIOD.REOPENED', request, {
        userId,
        tenantId,
        objectType: 'accounting_period',
        objectId: request.params.id,
        metadata: { reason: String(request.body?.reason ?? '') },
      });
      return reply.send({ message: 'Period reopened' });
    },
  );

  app.get('/api/v1/ledger', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const query = request.query as {
      from?: string;
      to?: string;
      account_id?: string;
      limit?: string;
      offset?: string;
    };
    const range = parseDateRange({ from: query.from, to: query.to });
    const accountId = query.account_id ? String(query.account_id).toLowerCase() : undefined;
    if (accountId && !UUID.test(accountId)) {
      throw new AppError(ErrorCodes.accountNotFound, 'Valid account id required', 400);
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 500);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const result = await ledgerLines(db, tenantId, {
      from: range.from,
      to: range.to,
      accountId,
      limit,
      offset,
    });
    return {
      ledger: result.rows,
      summary: { debit: result.debitTotal, credit: result.creditTotal },
      total: result.total,
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/accounts/:id/ledger', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const accountId = request.params.id.toLowerCase();
    if (!UUID.test(accountId)) throw new AppError(ErrorCodes.accountNotFound, 'Valid account id required', 400);
    const query = request.query as { from?: string; to?: string };
    const range = parseDateRange({ from: query.from, to: query.to });
    const result = await accountLedger(db, tenantId, accountId, { from: range.from, to: range.to });
    return result;
  });

  app.get('/api/v1/reports/trial-balance', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'accounting.read');
    const query = request.query as { as_of?: string };
    const asOf = query.as_of === undefined ? undefined : String(query.as_of);
    if (asOf !== undefined && !DATE_RE.test(asOf)) {
      throw new AppError(ErrorCodes.invalidRequest, 'Invalid as_of date', 400);
    }
    const report = await trialBalance(db, tenantId, asOf);
    return report;
  });
}
