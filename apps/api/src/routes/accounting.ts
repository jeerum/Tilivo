import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import {
  createJournalDraft,
  postJournal,
  reopenPeriod,
  reverseJournal,
  setPeriodStatus,
} from '../services/accountingService';
import { resolveSessionUser } from '../services/sessionContext';
import { requirePermission, resolveTenantAccess, withTenantTransaction } from '../services/tenantService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      })),
    });
    return reply.code(201).send({ journal_id: id, status: 'DRAFT' });
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
