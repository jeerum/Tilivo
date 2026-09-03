import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

describe.skipIf(!adminUrl || !runtimeUrl)('v0.4 -> v0.5 upgrade migration', () => {
  let maintenance: pg.Client;
  let adminDb: pg.Client;
  let runtimePool: pg.Pool;
  let dbName = '';

  const migrationDir = path.resolve(process.cwd(), 'migrations');
  const V0_4_COUNT = 7;

  async function runMigrations(databaseUrl: string, count?: number, direction: 'up' | 'down' = 'up') {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await runner({
        dbClient: client,
        dir: migrationDir,
        direction,
        migrationsTable: 'pgmigrations',
        ...(count === undefined ? {} : { count }),
        log: () => undefined,
      });
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    dbName = `tilivo_upg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    maintenance = new pg.Client({ connectionString: maintenanceUrl(adminUrl!) });
    await maintenance.connect();
    const adminUser = new URL(adminUrl!).username;
    const runtimeUser = new URL(runtimeUrl!).username;
    await maintenance.query(`CREATE DATABASE "${dbName}" OWNER ${JSON.stringify(adminUser)}`);
    await maintenance.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${JSON.stringify(runtimeUser)}`);

    adminDb = new pg.Client({ connectionString: withDatabase(adminUrl!, dbName) });
    await adminDb.connect();
    runtimePool = new pg.Pool({ connectionString: withDatabase(runtimeUrl!, dbName) });

    // Apply the v0.4 migration set only.
    await runMigrations(withDatabase(adminUrl!, dbName), V0_4_COUNT);

    // Seed representative v0.4 data exactly the way the v0.4 application would.
    await adminDb.query(`SELECT set_config('app.tenant_id', $1, false)`, ['00000000-0000-4000-8000-000000000001']);
    const user = await adminDb.query(
      `INSERT INTO users (email, email_normalized, password_hash, email_verified_at)
       VALUES ('upgrade-owner@example.com', 'upgrade-owner@example.com', 'argon2-placeholder', now())
       RETURNING id`,
    );
    const userId = String(user.rows[0]!.id);
    await adminDb.query(
      `INSERT INTO tenants (id, name, slug, status)
       VALUES ('00000000-0000-4000-8000-000000000001', 'Upgrade Oy', 'upgrade-oy', 'ACTIVE')`,
    );
    await adminDb.query(
      `INSERT INTO companies (tenant_id, legal_name, business_id, country_code, base_currency)
       VALUES ('00000000-0000-4000-8000-000000000001', 'Upgrade Oy', 'EE10012345', 'EE', 'EUR')`,
    );
    const roles = await adminDb.query(
      `INSERT INTO roles (tenant_id, name, is_system)
       VALUES ('00000000-0000-4000-8000-000000000001', 'Owner', true),
              ('00000000-0000-4000-8000-000000000001', 'Admin', true),
              ('00000000-0000-4000-8000-000000000001', 'Accountant', true),
              ('00000000-0000-4000-8000-000000000001', 'Viewer', true)
       RETURNING id, name`,
    );
    const roleIds = new Map<string, string>();
    for (const row of roles.rows) roleIds.set(String(row.name), String(row.id));
    const membership = await adminDb.query(
      `INSERT INTO memberships (tenant_id, user_id, status)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, 'ACTIVE')
       RETURNING id`,
      [userId],
    );
    await adminDb.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, $2)`,
      [membership.rows[0]!.id, roleIds.get('Owner')],
    );
    const permissions = await adminDb.query('SELECT id, key FROM permissions');
    const permissionIds = new Map<string, string>();
    for (const row of permissions.rows) permissionIds.set(String(row.key), String(row.id));
    await adminDb.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
       VALUES ($1, $2, $3),
              ($1, $4, $3),
              ($1, $5, $3)`,
      [
        '00000000-0000-4000-8000-000000000001',
        roleIds.get('Owner'),
        permissionIds.get('company.read'),
        roleIds.get('Admin'),
        roleIds.get('Viewer'),
      ],
    );
    const document = await adminDb.query(
      `INSERT INTO documents (tenant_id, type, status)
       VALUES ('00000000-0000-4000-8000-000000000001', 'GENERAL', 'UPLOADED')
       RETURNING id`,
    );
    await adminDb.query(
      `INSERT INTO document_versions
         (tenant_id, document_id, version_number, storage_key, original_filename, mime_type, size_bytes, sha256)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, 1, 'upgrade/seed.pdf', 'seed.pdf', 'application/pdf', 12, '${'aa'.repeat(32)}')`,
      [document.rows[0]!.id],
    );
    await adminDb.query(
      `INSERT INTO audit_events (user_id, tenant_id, action, metadata, event_hash)
       VALUES ($1, '00000000-0000-4000-8000-000000000001', 'UPGRADE.SEED', '{"stage":"v0.4"}', '${'bb'.repeat(32)}')`,
      [userId],
    );
    await adminDb.query(`SELECT set_config('app.tenant_id', '', false)`);
  }, 120_000);

  afterAll(async () => {
    try {
      await adminDb?.end();
      await runtimePool?.end();
      if (maintenance && dbName) {
        try {
          await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        }
      }
    } finally {
      await maintenance?.end();
    }
  });

  it('upgrades an existing v0.4 database without data loss and enables accounting invariants', async () => {
    const before = await adminDb.query('SELECT count(*)::int AS count FROM pgmigrations');
    expect(before.rows[0]!.count).toBe(V0_4_COUNT);
    const oldTables = await adminDb.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('accounts','journal_entries')`,
    );
    expect(oldTables.rows[0]!.count).toBe(0);

    // Apply all remaining release migrations (v0.5 accounting, v0.6 sales,
    // v0.7 purchases, v0.7.5 business registry, v0.8 accounting core,
    // v0.9 VAT engine and v0.10 purchases/receipts).
    await runMigrations(withDatabase(adminUrl!, dbName));
    const after = await adminDb.query('SELECT count(*)::int AS count FROM pgmigrations');
    // Release migrations after v0.4: accounting core, hardening, tax
    // uniqueness, v0.6 sales core, v0.7 purchases core, v0.7.5 registry,
    // v0.8 accounting core, v0.9 VAT engine, v0.10 purchases/receipts and
    // v0.11 AI classification.
    expect(after.rows[0]!.count).toBe(V0_4_COUNT + 11);

    // v0.4 data survived.
    const tenant = await adminDb.query(
      `SELECT name, slug FROM tenants WHERE id = '00000000-0000-4000-8000-000000000001'`,
    );
    expect(tenant.rows[0]!.name).toBe('Upgrade Oy');
    const company = await adminDb.query('SELECT legal_name, business_id FROM companies');
    expect(company.rows[0]!.legal_name).toBe('Upgrade Oy');
    expect(String(company.rows[0]!.business_id)).toBe('EE10012345');
    const counts = await adminDb.query(
      `SELECT
         (SELECT count(*)::int FROM users) AS users,
         (SELECT count(*)::int FROM documents) AS documents,
         (SELECT count(*)::int FROM document_versions) AS document_versions,
         (SELECT count(*)::int FROM audit_events) AS audit_events`,
    );
    expect(counts.rows[0]!.users).toBe(1);
    expect(counts.rows[0]!.documents).toBe(1);
    expect(counts.rows[0]!.document_versions).toBe(1);
    expect(counts.rows[0]!.audit_events).toBe(1);

    // Accounting schema exists.
    const tables = await adminDb.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
         ('accounts','fiscal_years','accounting_periods','currencies','tax_codes','fx_rates',
          'journal_sequences','journal_entries','journal_lines','journal_reversals',
          'business_parties','business_registry_cache','invoice_number_series','sales_settings','sales_invoices',
          'sales_invoice_lines','sales_invoice_credit_links','sales_invoice_pdfs',
          'purchase_invoices','purchase_invoice_lines','purchase_invoice_documents',
          'purchase_invoice_approvals','purchase_invoice_extractions',
          'purchase_invoice_corrections','purchase_imports','purchase_settings')`,
    );
    const names = (tables.rows as Array<{ table_name: string }>).map((r) => r.table_name).sort();
    expect(names).toEqual([
      'accounting_periods',
      'accounts',
      'business_parties',
      'business_registry_cache',
      'currencies',
      'fiscal_years',
      'fx_rates',
      'invoice_number_series',
      'journal_entries',
      'journal_lines',
      'journal_reversals',
      'journal_sequences',
      'purchase_imports',
      'purchase_invoice_approvals',
      'purchase_invoice_corrections',
      'purchase_invoice_documents',
      'purchase_invoice_extractions',
      'purchase_invoice_lines',
      'purchase_invoices',
      'purchase_settings',
      'sales_invoice_credit_links',
      'sales_invoice_lines',
      'sales_invoice_pdfs',
      'sales_invoices',
      'sales_settings',
      'tax_codes',
    ]);

    // Seed data and permissions.
    const currencies = await adminDb.query(`SELECT count(*)::int AS count FROM currencies`);
    expect(currencies.rows[0]!.count).toBeGreaterThanOrEqual(6);
    const permissions = await adminDb.query(
      `SELECT key FROM permissions
       WHERE key IN ('accounting.read','journal.create','journal.post','journal.reverse',
                     'period.manage','period.reopen','chart.manage',
                     'sales.read','sales.customer.manage','invoice.create','invoice.issue',
                     'invoice.credit','invoice.pdf.retry','sales.settings.manage',
                     'purchase.read','purchase.create','purchase.edit','purchase.review',
                     'purchase.approve','purchase.post','purchase.reject','purchase.correct',
                     'supplier.manage','purchase.settings.manage','purchase.document.upload',
                     'registry.read','tax.read','tax.manage','tax.report.read')
       ORDER BY key`,
    );
    expect(permissions.rows).toHaveLength(29);
    const grants = await adminDb.query(
      `SELECT r.name, count(*)::int AS grant_count
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.key IN ('accounting.read','journal.create','journal.post','journal.reverse',
                       'period.manage','period.reopen','chart.manage',
                       'sales.read','sales.customer.manage','invoice.create','invoice.issue',
                       'invoice.credit','invoice.pdf.retry','sales.settings.manage',
                       'purchase.read','purchase.create','purchase.edit','purchase.review',
                       'purchase.approve','purchase.post','purchase.reject','purchase.correct',
                       'supplier.manage','purchase.settings.manage','purchase.document.upload',
                       'registry.read','tax.read','tax.manage','tax.report.read')
       GROUP BY r.name
       ORDER BY r.name`,
    );
    const grantMap = new Map<string, number>();
    for (const row of grants.rows) grantMap.set(String(row.name), Number(row.grant_count));
    expect(grantMap.get('Owner')).toBe(29);
    expect(grantMap.get('Admin')).toBe(29);
    expect(grantMap.get('Accountant')).toBe(22);
    expect(grantMap.get('Viewer')).toBe(4);

    // RLS is active and forced on accounting tables.
    const rls = await adminDb.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN
         ('accounts','fiscal_years','accounting_periods','tax_codes','fx_rates',
          'journal_entries','journal_lines','journal_reversals',
          'business_parties','invoice_number_series','sales_settings','sales_invoices',
          'sales_invoice_lines','sales_invoice_credit_links','sales_invoice_pdfs',
          'purchase_invoices','purchase_invoice_lines','purchase_invoice_documents',
          'purchase_invoice_approvals','purchase_invoice_extractions',
          'purchase_invoice_corrections','purchase_imports','purchase_settings')
       ORDER BY c.relname`,
    );
    expect(rls.rows).toHaveLength(23);
    for (const row of rls.rows) {
      expect(Boolean(row.relrowsecurity)).toBe(true);
      expect(Boolean(row.relforcerowsecurity)).toBe(true);
    }

    // Runtime privileges for the new tables.
    for (const table of ['accounts', 'journal_entries', 'journal_lines', 'journal_reversals']) {
      const priv = await adminDb.query(
        `SELECT has_table_privilege('tilivo_runtime', '${table}', 'SELECT') AS sel,
                has_table_privilege('tilivo_runtime', '${table}', 'INSERT') AS ins,
                has_table_privilege('tilivo_runtime', '${table}', 'UPDATE') AS upd,
                has_table_privilege('tilivo_runtime', '${table}', 'DELETE') AS del`,
      );
      expect(Boolean(priv.rows[0]!.sel)).toBe(true);
      expect(Boolean(priv.rows[0]!.ins)).toBe(true);
      expect(Boolean(priv.rows[0]!.upd)).toBe(true);
      expect(Boolean(priv.rows[0]!.del)).toBe(true);
    }

    // v0.7.5 business registry schema survived the upgrade.
    const registryColumns = await adminDb.query(
      `SELECT count(*)::int AS count FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'business_parties'
         AND column_name IN ('registry_source','registry_source_id',
                             'registry_fetched_at','registry_snapshot')`,
    );
    expect(registryColumns.rows[0]!.count).toBe(4);
    const cachePriv = await adminDb.query(
      `SELECT has_table_privilege('tilivo_runtime', 'business_registry_cache', 'SELECT') AS sel,
              has_table_privilege('tilivo_runtime', 'business_registry_cache', 'INSERT') AS ins,
              has_table_privilege('tilivo_runtime', 'business_registry_cache', 'UPDATE') AS upd`,
    );
    expect(Boolean(cachePriv.rows[0]!.sel)).toBe(true);
    expect(Boolean(cachePriv.rows[0]!.ins)).toBe(true);
    expect(Boolean(cachePriv.rows[0]!.upd)).toBe(true);

    // v0.8 accounting core additions survived the upgrade.
    const v08Columns = await adminDb.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'journal_entries' AND column_name = 'document_date')
           OR (table_name = 'journal_lines' AND column_name IN ('cost_center', 'project_code')))
       ORDER BY table_name, column_name`,
    );
    expect(v08Columns.rows).toHaveLength(3);
    const v09Columns = await adminDb.query(
      `SELECT table_name, count(*)::int AS count FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'tax_codes' AND column_name IN
             ('direction','treatment','reverse_charge','intra_eu','is_export',
              'is_import','deductible_percent','legal_notes','is_system'))
           OR (table_name = 'journal_lines' AND column_name IN
             ('tax_code_snapshot','tax_treatment_snapshot','taxable_base_snapshot',
              'tax_amount_snapshot','tax_deductible_snapshot',
              'tax_nondeductible_snapshot','tax_leg_type',
              'tax_reporting_classification','tax_legal_note'))
         )
       GROUP BY table_name ORDER BY table_name`,
    );
    const columnCounts = new Map<string, number>();
    for (const row of v09Columns.rows) {
      columnCounts.set(String(row.table_name), Number(row.count));
    }
    expect(columnCounts.get('tax_codes')).toBe(9);
    expect(columnCounts.get('journal_lines')).toBe(9);
    const v09Seed = await adminDb.query(
      `SELECT count(*)::int AS count FROM tax_codes
       WHERE tenant_id = '00000000-0000-4000-8000-000000000001' AND is_system`,
    );
    expect(Number(v09Seed.rows[0]!.count)).toBeGreaterThanOrEqual(22);
    const lineChecks = await adminDb.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'journal_lines'::regclass
         AND conname IN ('journal_lines_amounts_nonnegative',
                         'journal_lines_debit_credit_exclusive')
       ORDER BY conname`,
    );
    expect(lineChecks.rows).toHaveLength(2);

    // Triggers installed.
    const triggers = await adminDb.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgname IN ('tilivo_journal_entries_immutable','tilivo_journal_lines_immutable',
                        'tilivo_journal_lines_insert_immutable','tilivo_journal_reversal_validate',
                        'tilivo_sales_invoices_immutable','tilivo_sales_invoice_lines_immutable',
                        'tilivo_sales_credit_link_validate','tilivo_sales_invoice_pdfs_immutable',
                        'tilivo_purchase_invoices_immutable','tilivo_purchase_lines_immutable',
                        'tilivo_purchase_invoice_approvals_immutable',
                        'tilivo_purchase_invoice_extractions_immutable')
       ORDER BY tgname`,
    );
    const triggerNames = (triggers.rows as Array<{ tgname: string }>).map((r) => r.tgname);
    expect(triggerNames).toContain('tilivo_journal_entries_immutable');
    expect(triggerNames).toContain('tilivo_journal_lines_immutable');
    expect(triggerNames).toContain('tilivo_journal_lines_insert_immutable');
    expect(triggerNames).toContain('tilivo_journal_reversal_validate');
    expect(triggerNames).toContain('tilivo_sales_invoices_immutable');
    expect(triggerNames).toContain('tilivo_sales_invoice_lines_immutable');
    expect(triggerNames).toContain('tilivo_sales_credit_link_validate');
    expect(triggerNames).toContain('tilivo_sales_invoice_pdfs_immutable');
    expect(triggerNames).toContain('tilivo_purchase_invoices_immutable');
    expect(triggerNames).toContain('tilivo_purchase_lines_immutable');
    expect(triggerNames).toContain('tilivo_purchase_invoice_approvals_immutable');
    expect(triggerNames).toContain('tilivo_purchase_invoice_extractions_immutable');

    // v0.6 upgrade seeded one default series and settings for the old tenant.
    const salesSeed = await adminDb.query(
      `SELECT
         (SELECT count(*)::int FROM invoice_number_series WHERE tenant_id = '00000000-0000-4000-8000-000000000001') AS series,
         (SELECT count(*)::int FROM sales_settings WHERE tenant_id = '00000000-0000-4000-8000-000000000001') AS settings`,
    );
    expect(salesSeed.rows[0]!.series).toBeGreaterThanOrEqual(1);
    expect(salesSeed.rows[0]!.settings).toBe(1);

    const purchaseSeed = await adminDb.query(
      `SELECT count(*)::int AS settings FROM purchase_settings
       WHERE tenant_id = '00000000-0000-4000-8000-000000000001'`,
    );
    expect(purchaseSeed.rows[0]!.settings).toBe(1);

    // RLS visibility works for the runtime role on accounting data.
    await adminDb.query(
      `INSERT INTO accounts (tenant_id, code, name, type, normal_balance)
       VALUES ('00000000-0000-4000-8000-000000000001', '1000', 'Cash', 'ASSET', 'DEBIT')`,
    );
    const noContext = await runtimePool.query('SELECT count(*)::int AS count FROM accounts');
    expect(noContext.rows[0]!.count).toBe(0);

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true)`,
      );
      const visible = await client.query('SELECT count(*)::int AS count FROM accounts');
      expect(visible.rows[0]!.count).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }, 60_000);
});
