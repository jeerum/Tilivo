import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/pool';
import { AppError, ErrorCodes } from '../lib/errors';
import { requirePermission, resolveTenantAccess } from '../services/tenantService';
import { resolveSessionUser } from '../services/sessionContext';
import { writeAuditEvent } from '../services/audit';
import {
  confirmBankImport,
  createBankAccount,
  getBankingSettings,
  getBankTransaction,
  getBankTransactionSuggestions,
  listBankAccounts,
  listBankImports,
  listBankTransactions,
  previewBankStatement,
  updateBankingSettings,
  updateBankAccount,
} from '../services/bankingService';
import {
  bankingReconciliationSummary,
  createBankAllocation,
  deleteBankAllocation,
  reconcileBankTransaction,
  reviewBankTransactionNoPost,
} from '../services/bankingReconciliationService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function context(request: FastifyRequest, db: Db, config: AppConfig) {
  const { user } = await resolveSessionUser(db, request, config);
  const tenantId = String(request.headers['x-tilivo-tenant-id'] ?? '').toLowerCase();
  if (!UUID_RE.test(tenantId)) throw new AppError(ErrorCodes.tenantInvalid, 'Valid tenant id required', 400);
  await resolveTenantAccess(db, user.id, tenantId);
  return { userId: user.id, tenantId };
}

export async function bankingRoutes(app: FastifyInstance, options: { db: Db; config: AppConfig }): Promise<void> {
  const { db, config } = options;

  app.get('/api/v1/banking/accounts', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.read');
    return { accounts: await listBankAccounts(db, tenantId) };
  });

  app.get('/api/v1/banking/settings', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.read');
    return { settings: await getBankingSettings(db, tenantId) };
  });

  app.patch<{ Body: Record<string, unknown> }>('/api/v1/banking/settings', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.accounts.manage');
    const body = request.body ?? {};
    const settings = await updateBankingSettings(db, tenantId, {
      bank_fee_expense_account_id: body.bank_fee_expense_account_id === null ? null : typeof body.bank_fee_expense_account_id === 'string' ? body.bank_fee_expense_account_id : undefined,
      interest_income_account_id: body.interest_income_account_id === null ? null : typeof body.interest_income_account_id === 'string' ? body.interest_income_account_id : undefined,
      interest_expense_account_id: body.interest_expense_account_id === null ? null : typeof body.interest_expense_account_id === 'string' ? body.interest_expense_account_id : undefined,
      card_clearing_account_id: body.card_clearing_account_id === null ? null : typeof body.card_clearing_account_id === 'string' ? body.card_clearing_account_id : undefined,
      transfer_clearing_account_id: body.transfer_clearing_account_id === null ? null : typeof body.transfer_clearing_account_id === 'string' ? body.transfer_clearing_account_id : undefined,
      customer_unallocated_account_id: body.customer_unallocated_account_id === null ? null : typeof body.customer_unallocated_account_id === 'string' ? body.customer_unallocated_account_id : undefined,
      supplier_unallocated_account_id: body.supplier_unallocated_account_id === null ? null : typeof body.supplier_unallocated_account_id === 'string' ? body.supplier_unallocated_account_id : undefined,
    } as any);
    return { settings };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/banking/accounts', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.accounts.manage');
    const body = request.body ?? {};
    const account = await createBankAccount(db, tenantId, userId, {
      name: String(body.name),
      iban: String(body.iban),
      bic: typeof body.bic === 'string' ? body.bic : null,
      currency: typeof body.currency === 'string' ? body.currency : 'EUR',
      bankName: typeof body.bank_name === 'string' ? body.bank_name : null,
      ledgerAccountId: String(body.ledger_account_id),
      isDefault: body.is_default === true,
    });
    await writeAuditEvent(db, 'BANK_ACCOUNT.CREATED', request, {
      userId,
      tenantId,
      objectType: 'bank_account',
      objectId: String(account.id),
      metadata: { name: String(account.name), iban: String(account.iban) },
    });
    return reply.code(201).send({ account });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/banking/accounts/:id',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'banking.accounts.manage');
      const body = request.body ?? {};
      const account = await updateBankAccount(db, tenantId, String(request.params.id).toLowerCase(), {
        name: typeof body.name === 'string' ? body.name : undefined,
        iban: typeof body.iban === 'string' ? body.iban : undefined,
        bic: body.bic === null ? null : typeof body.bic === 'string' ? body.bic : undefined,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        bankName: body.bank_name === null ? null : typeof body.bank_name === 'string' ? body.bank_name : undefined,
        ledgerAccountId: typeof body.ledger_account_id === 'string' ? body.ledger_account_id : undefined,
        isActive: typeof body.is_active === 'boolean' ? body.is_active : undefined,
        isDefault: typeof body.is_default === 'boolean' ? body.is_default : undefined,
      });
      await writeAuditEvent(db, 'BANK_ACCOUNT.UPDATED', request, {
        userId,
        tenantId,
        objectType: 'bank_account',
        objectId: String(account.id),
        metadata: { name: String(account.name) },
      });
      return { account };
    },
  );

  app.post<{ Body: Record<string, unknown> }>('/api/v1/banking/imports/preview', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.import');
    const body = request.body ?? {};
    const preview = await previewBankStatement(db, tenantId, {
      bankAccountId: String(body.bank_account_id),
      filename: String(body.filename),
      content: String(body.content),
    });
    return { preview };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/banking/imports', async (request, reply) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.import');
    const body = request.body ?? {};
    const result = await confirmBankImport(db, tenantId, userId, {
      bankAccountId: String(body.bank_account_id),
      filename: String(body.filename),
      content: String(body.content),
    });
    await writeAuditEvent(db, 'BANK_IMPORT.CREATED', request, {
      userId,
      tenantId,
      objectType: 'bank_import_batch',
      objectId: String(result.batch.id),
      metadata: { filename: String(body.filename), imported: result.imported },
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/banking/imports', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.read');
    const query = request.query as Record<string, unknown>;
    const imports = await listBankImports(db, tenantId, Number(query.limit ?? 100), Number(query.offset ?? 0));
    return { imports };
  });

  app.get('/api/v1/banking/transactions', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.read');
    const query = request.query as Record<string, unknown>;
    const result = await listBankTransactions(db, tenantId, {
      bankAccountId: typeof query.bank_account_id === 'string' ? query.bank_account_id : undefined,
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
      direction: typeof query.direction === 'string' ? query.direction.toUpperCase() : undefined,
      status: typeof query.status === 'string' ? query.status.toUpperCase() : undefined,
      unmatched: query.unmatched === 'true',
      search: typeof query.search === 'string' ? query.search : undefined,
      limit: Number(query.limit ?? 100),
      offset: Number(query.offset ?? 0),
    });
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/v1/banking/transactions/:id', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.read');
    const detail = await getBankTransaction(db, tenantId, String(request.params.id).toLowerCase());
    return detail;
  });

  app.get<{ Params: { id: string } }>('/api/v1/banking/transactions/:id/suggestions', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.match');
    return getBankTransactionSuggestions(db, tenantId, String(request.params.id).toLowerCase());
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/banking/transactions/:id/allocations',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'banking.match');
      const body = request.body ?? {};
      const allocation = await createBankAllocation(db, tenantId, userId, String(request.params.id).toLowerCase(), {
        allocationType: String(body.allocation_type) as any,
        targetId: typeof body.target_id === 'string' ? body.target_id : null,
        accountId: typeof body.account_id === 'string' ? body.account_id : null,
        amount: String(body.amount),
        description: typeof body.description === 'string' ? body.description : null,
        projectCode: typeof body.project_code === 'string' ? body.project_code : null,
        costCenter: typeof body.cost_center === 'string' ? body.cost_center : null,
      });
      return reply.code(201).send({ allocation });
    },
  );

  app.delete<{ Params: { id: string; allocationId: string } }>(
    '/api/v1/banking/transactions/:id/allocations/:allocationId',
    async (request, reply) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'banking.match');
      await deleteBankAllocation(db, tenantId, String(request.params.id).toLowerCase(), String(request.params.allocationId).toLowerCase());
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/banking/transactions/:id/reconcile', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.post');
    const transactionId = String(request.params.id).toLowerCase();
    const result = await reconcileBankTransaction(db, tenantId, userId, transactionId);
    await writeAuditEvent(db, 'BANK_TRANSACTION.POSTED', request, {
      userId,
      tenantId,
      objectType: 'bank_transaction',
      objectId: transactionId,
      metadata: { bank_transaction_id: transactionId, journal_entry_id: String(result.journal_entry_id ?? '') },
    });
    return result;
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/v1/banking/transactions/:id/review-no-post',
    async (request) => {
      const { userId, tenantId } = await context(request, db, config);
      await requirePermission(db, userId, tenantId, 'banking.post');
      const body = request.body ?? {};
      return reviewBankTransactionNoPost(db, tenantId, String(request.params.id).toLowerCase(), String(body.reason ?? ''));
    },
  );

  app.get('/api/v1/banking/reconciliation-summary', async (request) => {
    const { userId, tenantId } = await context(request, db, config);
    await requirePermission(db, userId, tenantId, 'banking.read');
    const query = request.query as Record<string, unknown>;
    return {
      summary: await bankingReconciliationSummary(db, tenantId, {
        bankAccountId: typeof query.bank_account_id === 'string' ? query.bank_account_id : undefined,
        from: typeof query.from === 'string' ? query.from : undefined,
        to: typeof query.to === 'string' ? query.to : undefined,
      }),
    };
  });
}
