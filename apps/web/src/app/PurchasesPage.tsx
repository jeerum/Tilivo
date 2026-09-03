import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';
import {
  conflictingRegistryFields,
  registryFormPatch,
  registryPartyFields,
  type RegistryCompany,
} from '../lib/businessRegistry';
import { centsToMoney } from '../lib/money';
import {
  deductibleTaxCents,
  invoiceTaxCents,
  lineNetCents,
  selfAssessedTaxCents,
  taxRateLabel,
  type TaxCodeView,
} from '../lib/tax';
import { BusinessRegistrySearch } from './BusinessRegistrySearch';

type PurchaseView = 'suppliers' | 'purchases' | 'inbox';
type PurchaseStatus = 'DRAFT' | 'NEEDS_REVIEW' | 'READY_FOR_APPROVAL' | 'APPROVED' | 'POSTED' | 'REJECTED' | 'CORRECTED';

interface Supplier {
  id: string;
  name: string;
  business_id: string | null;
  vat_id: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  country_code: string;
  city: string | null;
  language: string | null;
  payment_terms_days: number | null;
  default_currency: string | null;
  is_active: boolean;
}

interface PurchaseLine {
  id: string;
  description: string;
  quantity: string;
  unit_price: string;
  net_amount: string;
  tax_code_id: string | null;
  tax_code_snapshot: string | null;
  tax_rate_snapshot: string | null;
  tax_treatment_snapshot: string | null;
  tax_amount: string;
  gross_amount: string;
  deductible_percent_snapshot: string | null;
  tax_legal_note: string | null;
}

interface Purchase {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency_code: string;
  status: PurchaseStatus;
  source_type: string;
  subtotal: string;
  tax_total: string;
  total: string;
  accounting_journal_entry_id: string | null;
  supplier_snapshot: Record<string, unknown>;
  created_by: string | null;
  approved_by: string | null;
  posted_by: string | null;
  lines?: PurchaseLine[];
  approvals?: Array<{ action: string; actor_email: string | null; reason: string; created_at: string }>;
}

interface ImportRow {
  id: string;
  source_type: string;
  source_external_id: string;
  supplier_name: string | null;
  supplier_invoice_number: string | null;
  total: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

interface TaxLineDraft {
  key: number;
  description: string;
  quantity: string;
  unit_price: string;
  tax_code_id: string;
  deductible_percent: string;
  expense_account_id: string;
}

function taxLabel(code: TaxCodeView): string {
  const rate = taxRateLabel(code);
  return `${code.code}${rate ? ` · ${rate}` : ''}`;
}

function taxCodeById(codes: TaxCodeView[], id: string): TaxCodeView | undefined {
  return codes.find((code) => code.id === id);
}

function lineTaxPreview(line: TaxLineDraft, code: TaxCodeView | undefined) {
  const net = lineNetCents({ quantity: line.quantity, unitPrice: line.unit_price });
  const invoiceTax = invoiceTaxCents(net, code);
  const selfAssessed = selfAssessedTaxCents(net, code);
  const deductible = deductibleTaxCents(net, code, code?.direction === 'PURCHASE' ? line.deductible_percent : '100');
  return {
    net: centsToMoney(net),
    invoiceTax: centsToMoney(invoiceTax),
    selfAssessed: centsToMoney(selfAssessed),
    deductible: centsToMoney(deductible),
    gross: centsToMoney(net + invoiceTax),
  };
}

function breakdownFor(lines: TaxLineDraft[], codes: TaxCodeView[]) {
  const groups = new Map<string, { code: TaxCodeView; net: number; invoiceTax: number; selfAssessed: number; deductible: number }>();
  for (const line of lines) {
    const code = taxCodeById(codes, line.tax_code_id);
    if (!code || !line.description.trim()) continue;
    const net = lineNetCents({ quantity: line.quantity, unitPrice: line.unit_price });
    const invoiceTax = invoiceTaxCents(net, code);
    const selfAssessed = selfAssessedTaxCents(net, code);
    const deductible = deductibleTaxCents(net, code, line.deductible_percent);
    const existing = groups.get(code.id);
    if (existing) {
      existing.net += net;
      existing.invoiceTax += invoiceTax;
      existing.selfAssessed += selfAssessed;
      existing.deductible += deductible;
    } else {
      groups.set(code.id, { code, net, invoiceTax, selfAssessed, deductible });
    }
  }
  return [...groups.values()].map((group) => ({
    label: taxLabel(group.code),
    net: centsToMoney(group.net),
    invoiceTax: centsToMoney(group.invoiceTax),
    selfAssessed: centsToMoney(group.selfAssessed),
    deductible: centsToMoney(group.deductible),
  }));
}

const emptySupplierDraft = () => ({
  name: '',
  business_id: '',
  vat_id: '',
  email: '',
  phone: '',
  address_line1: '',
  address_line2: '',
  postal_code: '',
  city: '',
  country_code: 'FI',
  language: 'fi',
  payment_terms_days: '14',
  default_currency: 'EUR',
});

export function PurchasesPage() {
  const { t } = useI18n();
  const { csrf } = useAuth();
  const [tenantId, setTenantId] = useState('');
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [view, setView] = useState<PurchaseView>('purchases');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierDraft, setSupplierDraft] = useState(emptySupplierDraft);
  const [editingSupplierId, setEditingSupplierId] = useState('');
  const [registrySelection, setRegistrySelection] = useState<RegistryCompany | null>(null);

  const [taxCodes, setTaxCodes] = useState<TaxCodeView[]>([]);
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Purchase | null>(null);

  const [imports, setImports] = useState<ImportRow[]>([]);
  const [importFormat, setImportFormat] = useState('FINVOICE');
  const [importXml, setImportXml] = useState('');

  const [lineCounter, setLineCounter] = useState(1);
  const [lines, setLines] = useState<TaxLineDraft[]>([
    { key: 1, description: '', quantity: '1', unit_price: '', tax_code_id: '', deductible_percent: '100', expense_account_id: '' },
  ]);
  const [draftSupplierId, setDraftSupplierId] = useState('');
  const [draftNumber, setDraftNumber] = useState('');
  const [draftDate, setDraftDate] = useState(today());

  const headers = tenantId ? { 'x-tilivo-tenant-id': tenantId } : undefined;

  const run = async (operation: () => Promise<void>, successMessage = '') => {
    setError('');
    setMessage('');
    try {
      await operation();
      if (successMessage) setMessage(t(successMessage as any));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadTenants = async () => {
    const result = await api<{ tenants: Array<{ id: string; name: string }> }>('/api/v1/tenants', { csrf });
    setTenants(result.tenants);
    if (!tenantId && result.tenants[0]) setTenantId(result.tenants[0]!.id);
  };

  const loadSuppliers = async () => {
    const query = supplierSearch ? `?search=${encodeURIComponent(supplierSearch)}` : '';
    const result = await api<{ suppliers: Supplier[] }>(`/api/v1/suppliers${query}`, { headers });
    setSuppliers(result.suppliers);
  };

  const loadPurchases = async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (statusFilter) params.set('status', statusFilter);
    const result = await api<{ purchases: Purchase[] }>(`/api/v1/purchases?${params.toString()}`, { headers });
    setPurchases(result.purchases);
  };

  const loadTaxAccounts = async () => {
    try {
      const [taxResult, accountsResult] = await Promise.all([
        api<{ tax_codes: TaxCodeView[] }>('/api/v1/tax-codes?current=true&direction=PURCHASE', { headers }),
        api<{ accounts: Array<{ id: string; code: string; name: string }> }>('/api/v1/accounts', { headers }),
      ]);
      setTaxCodes(taxResult.tax_codes);
      setAccounts(accountsResult.accounts);
    } catch {
      // Read-only roles still see purchase data; editing controls will deny server-side.
    }
  };

  const loadImports = async () => {
    const result = await api<{ imports: ImportRow[] }>('/api/v1/purchases/inbox', { headers });
    setImports(result.imports);
  };

  useEffect(() => {
    void loadTenants().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    void run(async () => {
      await Promise.all([loadSuppliers(), loadPurchases(), loadTaxAccounts()]);
      if (view === 'inbox') await loadImports();
    });
  }, [tenantId, view, statusFilter]);

  const submitSupplier = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const body: Record<string, unknown> = {
        ...supplierDraft,
        email: supplierDraft.email || null,
        phone: supplierDraft.phone || null,
        address_line1: supplierDraft.address_line1 || null,
        address_line2: supplierDraft.address_line2 || null,
        postal_code: supplierDraft.postal_code || null,
        payment_terms_days: Number(supplierDraft.payment_terms_days),
      };
      if (registrySelection && supplierDraft.business_id === registrySelection.business_id) {
        Object.assign(body, registryPartyFields(registrySelection));
      }
      if (editingSupplierId) {
        await api(`/api/v1/suppliers/${editingSupplierId}`, { method: 'PATCH', csrf, headers, body });
      } else {
        await api('/api/v1/suppliers', { method: 'POST', csrf, headers, body });
      }
      setSupplierDraft(emptySupplierDraft());
      setEditingSupplierId('');
      setRegistrySelection(null);
      await loadSuppliers();
    }, editingSupplierId ? 'supplierUpdated' : 'supplierCreated');
  };

  const editSupplier = (supplier: Supplier) => {
    setEditingSupplierId(supplier.id);
    setRegistrySelection(null);
    setSupplierDraft({
      name: supplier.name,
      business_id: supplier.business_id ?? '',
      vat_id: supplier.vat_id ?? '',
      email: supplier.email ?? '',
      phone: supplier.phone ?? '',
      address_line1: supplier.address_line1 ?? '',
      address_line2: supplier.address_line2 ?? '',
      postal_code: supplier.postal_code ?? '',
      city: supplier.city ?? '',
      country_code: supplier.country_code,
      language: supplier.language ?? 'fi',
      payment_terms_days: String(supplier.payment_terms_days ?? 14),
      default_currency: supplier.default_currency ?? 'EUR',
    });
  };

  const applyRegistryCompany = (company: RegistryCompany) => {
    const incoming = registryFormPatch(company);
    const conflicts = conflictingRegistryFields(supplierDraft, incoming);
    if (conflicts.length > 0 && !window.confirm(t('registryOverwriteConfirm'))) return;
    setSupplierDraft((current) => ({ ...current, ...incoming }));
    setRegistrySelection(company);
    setMessage(t('registryApplied'));
  };

  const toggleSupplier = async (supplier: Supplier) => {
    await run(async () => {
      const action = supplier.is_active ? 'deactivate' : 'activate';
      await api(`/api/v1/suppliers/${supplier.id}/${action}`, { method: 'POST', csrf, headers });
      await loadSuppliers();
    });
  };

  const saveDraft = async () => {
    await run(async () => {
      const body = {
        supplier_id: draftSupplierId,
        supplier_invoice_number: draftNumber,
        invoice_date: draftDate,
        lines: lines
          .filter((line) => line.description.trim())
          .map((line) => ({
            description: line.description,
            quantity: line.quantity || '1',
            unit_price: line.unit_price || '0',
            tax_code_id: line.tax_code_id,
            deductible_percent: line.deductible_percent,
            expense_account_id: line.expense_account_id,
          })),
      };
      await api('/api/v1/purchases', { method: 'POST', csrf, headers, body });
      setDraftSupplierId('');
      setDraftNumber('');
      setLines([{ key: lineCounter + 1, description: '', quantity: '1', unit_price: '', tax_code_id: '', deductible_percent: '100', expense_account_id: '' }]);
      await loadPurchases();
    }, 'purchaseDraftCreated');
  };

  const openPurchase = async (id: string) => {
    await run(async () => {
      const result = await api<{ purchase: Purchase }>(`/api/v1/purchases/${id}`, { headers });
      setSelected(result.purchase);
    });
  };

  const transition = async (id: string, action: string, body?: Record<string, unknown>, success?: string) => {
    await run(async () => {
      const result = await api<{ purchase?: Purchase; invoice?: Purchase }>(
        `/api/v1/purchases/${id}/${action}`,
        { method: 'POST', csrf, headers, body },
      );
      const purchase = result.purchase ?? result.invoice;
      if (purchase) setSelected(purchase);
      await loadPurchases();
    }, success ?? '');
  };

  const importXmlFile = async () => {
    await run(async () => {
      const result = await api<{ purchase: Purchase; duplicate: boolean }>('/api/v1/purchases/import', {
        method: 'POST',
        csrf,
        headers,
        body: { format: importFormat, content: importXml },
      });
      setImportXml('');
      setSelected(result.purchase);
      await Promise.all([loadPurchases(), loadImports()]);
      setMessage(t(result.duplicate ? 'purchaseDuplicate' : 'purchaseIngested'));
    });
  };

  const addLine = () => {
    setLineCounter((value) => value + 1);
    setLines((current) => [...current, { key: lineCounter + 1, description: '', quantity: '1', unit_price: '', tax_code_id: '', deductible_percent: '100', expense_account_id: '' }]);
  };

  const updateLine = (key: number, patch: Partial<TaxLineDraft>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const changeLineTaxCode = (key: number, taxCodeId: string) => {
    const code = taxCodeById(taxCodes, taxCodeId);
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? { ...line, tax_code_id: taxCodeId, deductible_percent: code?.deductible_percent ?? '100' }
          : line,
      ),
    );
  };

  if (!tenantId) {
    return (
      <div className="workspace-page" data-testid="purchases-page">
        <h2 className="page-title">{t('purchases')}</h2>
        <p className="muted">{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="workspace-page" data-testid="purchases-page">
      <h2 className="page-title">{t('purchases')}</h2>
      <label className="field">
        <span>{t('tenantSwitcher')}</span>
        <select value={tenantId} onChange={(event) => { setTenantId(event.target.value); setSelected(null); }}>
          {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}
      <nav className="tab-bar" aria-label={t('purchases')}>
        {(
          [
            ['purchases', 'purchaseInvoices'],
            ['suppliers', 'suppliers'],
            ['inbox', 'purchaseInbox'],
          ] as Array<[PurchaseView, string]>
        ).map(([key, label]) => (
          <button key={key} type="button" data-testid={`tab-${key}`} className={view === key ? 'tab-button active' : 'tab-button'} onClick={() => setView(key)}>
            {t(label as any)}
          </button>
        ))}
      </nav>

      {view === 'suppliers' && (
        <section data-testid="suppliers-panel">
          <details>
            <summary>{editingSupplierId ? t('editSupplier') : t('addSupplier')}</summary>
            <BusinessRegistrySearch
              csrf={csrf}
              headers={headers}
              onCompany={applyRegistryCompany}
            />
            <form className="card form-stack" data-testid="supplier-form" onSubmit={submitSupplier}>
              <label className="field"><span>{t('name')}</span><input value={supplierDraft.name} onChange={(event) => setSupplierDraft({ ...supplierDraft, name: event.target.value })} required /></label>
              <div className="form-row">
                <label className="field"><span>{t('businessId')}</span><input value={supplierDraft.business_id} onChange={(event) => setSupplierDraft({ ...supplierDraft, business_id: event.target.value })} /></label>
                <label className="field"><span>VAT ID</span><input value={supplierDraft.vat_id} onChange={(event) => setSupplierDraft({ ...supplierDraft, vat_id: event.target.value })} /></label>
              </div>
              <div className="form-row">
                <label className="field"><span>{t('address')}</span><input value={supplierDraft.address_line1} onChange={(event) => setSupplierDraft({ ...supplierDraft, address_line1: event.target.value })} /></label>
                <label className="field"><span>{t('city')}</span><input value={supplierDraft.city} onChange={(event) => setSupplierDraft({ ...supplierDraft, city: event.target.value })} /></label>
                <label className="field"><span>{t('postalCode')}</span><input value={supplierDraft.postal_code} onChange={(event) => setSupplierDraft({ ...supplierDraft, postal_code: event.target.value })} /></label>
                <label className="field"><span>{t('country')}</span><input maxLength={2} value={supplierDraft.country_code} onChange={(event) => setSupplierDraft({ ...supplierDraft, country_code: event.target.value.toUpperCase() })} /></label>
              </div>
              <div className="form-row">
                <label className="field"><span>{t('email')}</span><input type="email" value={supplierDraft.email} onChange={(event) => setSupplierDraft({ ...supplierDraft, email: event.target.value })} /></label>
                <label className="field"><span>{t('phone')}</span><input value={supplierDraft.phone} onChange={(event) => setSupplierDraft({ ...supplierDraft, phone: event.target.value })} /></label>
                <label className="field"><span>{t('paymentTermsDays')}</span><input type="number" min={0} value={supplierDraft.payment_terms_days} onChange={(event) => setSupplierDraft({ ...supplierDraft, payment_terms_days: event.target.value })} /></label>
                <label className="field"><span>{t('currency')}</span><input maxLength={3} value={supplierDraft.default_currency} onChange={(event) => setSupplierDraft({ ...supplierDraft, default_currency: event.target.value.toUpperCase() })} /></label>
              </div>
              <button type="submit" className="primary" data-testid="save-supplier">{t('save')}</button>
              {editingSupplierId && (
                <button type="button" onClick={() => { setEditingSupplierId(''); setRegistrySelection(null); setSupplierDraft(emptySupplierDraft()); }}>{t('cancel')}</button>
              )}
            </form>
          </details>
          <div className="card form-row">
            <input data-testid="supplier-search" value={supplierSearch} placeholder={t('search')} onChange={(event) => setSupplierSearch(event.target.value)} />
            <button type="button" onClick={() => void run(loadSuppliers)}>{t('refresh')}</button>
          </div>
          <table className="data-table" data-testid="suppliers-table">
            <thead><tr><th>{t('name')}</th><th>{t('businessId')}</th><th>VAT ID</th><th>{t('email')}</th><th>{t('country')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr key={supplier.id}>
                  <td>{supplier.name}</td><td className="mono">{supplier.business_id ?? '–'}</td><td className="mono">{supplier.vat_id ?? '–'}</td>
                  <td>{supplier.email ?? '–'}</td><td>{supplier.country_code}</td>
                  <td>{supplier.is_active ? t('active') : t('inactive')}</td>
                  <td>
                    <button type="button" onClick={() => editSupplier(supplier)}>{t('edit')}</button>
                    <button type="button" onClick={() => void toggleSupplier(supplier)}>{supplier.is_active ? t('deactivate') : t('activate')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {suppliers.length === 0 && <p className="muted">{t('noSuppliers')}</p>}
        </section>
      )}

      {view === 'purchases' && (
        <section data-testid="purchases-panel">
          <details>
            <summary>{t('newPurchase')}</summary>
            <form className="card form-stack" data-testid="purchase-draft-form">
              <div className="form-row">
                <label className="field"><span>{t('supplier')}</span>
                  <select value={draftSupplierId} onChange={(event) => setDraftSupplierId(event.target.value)}>
                    <option value="">{t('selectSupplier')}</option>
                    {suppliers.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="field"><span>{t('invoiceNumber')}</span><input value={draftNumber} onChange={(event) => setDraftNumber(event.target.value)} /></label>
                <label className="field"><span>{t('invoiceDate')}</span><input type="date" value={draftDate} onChange={(event) => setDraftDate(event.target.value)} /></label>
              </div>
              {lines.map((line) => (
                <div className="entry-line-row" key={line.key}>
                  <input data-testid={`purchase-line-description-${line.key}`} placeholder={t('description')} value={line.description} onChange={(event) => updateLine(line.key, { description: event.target.value })} />
                  <input type="number" min="0" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} />
                  <input type="number" min="0" step="0.01" value={line.unit_price} onChange={(event) => updateLine(line.key, { unit_price: event.target.value })} />
                  <select value={line.tax_code_id} onChange={(event) => changeLineTaxCode(line.key, event.target.value)}>
                    <option value="">{t('selectTax')}</option>
                    {taxCodes.map((code) => <option key={code.id} value={code.id}>{taxLabel(code)}</option>)}
                  </select>
                  <select
                    aria-label={`${t('deductibility')} ${line.key}`}
                    value={line.deductible_percent}
                    onChange={(event) => updateLine(line.key, { deductible_percent: event.target.value })}
                    disabled={!line.tax_code_id}
                  >
                    {['100', '75', '50', '25', '0'].map((percent) => (
                      <option key={percent} value={percent}>{percent}%</option>
                    ))}
                  </select>
                  <span className="tax-preview" data-testid={`purchase-line-tax-preview-${line.key}`}>
                    {(() => {
                      const preview = lineTaxPreview(line, taxCodeById(taxCodes, line.tax_code_id));
                      return `Net ${preview.net} · VAT ${preview.invoiceTax}${preview.selfAssessed !== '0.00' ? ` · self-assessed ${preview.selfAssessed}` : ''} · Gross ${preview.gross}`;
                    })()}
                  </span>
                  <select value={line.expense_account_id} onChange={(event) => updateLine(line.key, { expense_account_id: event.target.value })}>
                    <option value="">{t('expenseAccount')}</option>
                    {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
                  </select>
                  <button type="button" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>×</button>
                </div>
              ))}
              <div>
                <button type="button" onClick={addLine}>+</button>
                <button type="button" className="primary" data-testid="save-purchase-draft" onClick={() => void saveDraft()}>{t('saveDraft')}</button>
              </div>
              {(() => {
                const subtotal = lines.reduce((sum, line) => sum + lineNetCents({ quantity: line.quantity, unitPrice: line.unit_price }), 0);
                const invoiceTax = lines.reduce((sum, line) => sum + invoiceTaxCents(lineNetCents({ quantity: line.quantity, unitPrice: line.unit_price }), taxCodeById(taxCodes, line.tax_code_id)), 0);
                const selfAssessed = lines.reduce((sum, line) => sum + selfAssessedTaxCents(lineNetCents({ quantity: line.quantity, unitPrice: line.unit_price }), taxCodeById(taxCodes, line.tax_code_id)), 0);
                const deductible = lines.reduce((sum, line) => sum + deductibleTaxCents(lineNetCents({ quantity: line.quantity, unitPrice: line.unit_price }), taxCodeById(taxCodes, line.tax_code_id), line.deductible_percent), 0);
                const breakdown = breakdownFor(lines, taxCodes);
                return (
                  <>
                    <p data-testid="purchase-totals-preview">
                      {t('subtotal')}: {centsToMoney(subtotal)} | {t('taxTotal')}: {centsToMoney(invoiceTax)} | {t('total')}: {centsToMoney(subtotal + invoiceTax)}
                      {selfAssessed > 0 ? ` | ${t('selfAssessedVat')}: ${centsToMoney(selfAssessed)} · ${t('inputVat')}: ${centsToMoney(deductible)}` : ''}
                    </p>
                    {breakdown.length > 0 && (
                      <div className="tax-breakdown" data-testid="purchase-tax-breakdown">
                        <strong>{t('vatBreakdown')}</strong>
                        <ul>
                          {breakdown.map((item, index) => (
                            <li key={index}>
                              {item.label}: {item.net} → {item.invoiceTax}
                              {item.selfAssessed !== '0.00' ? ` · self-assessed ${item.selfAssessed} (deductible ${item.deductible})` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                );
              })()}
            </form>
          </details>
          <div className="card form-row">
            <label className="field"><span>{t('status')}</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">{t('all')}</option>
                <option value="DRAFT">{t('draft')}</option>
                <option value="NEEDS_REVIEW">{t('needsReview')}</option>
                <option value="READY_FOR_APPROVAL">{t('readyForApproval')}</option>
                <option value="APPROVED">{t('approved')}</option>
                <option value="POSTED">{t('posted')}</option>
              </select>
            </label>
            <button type="button" onClick={() => void run(loadPurchases)}>{t('refresh')}</button>
          </div>
          <table className="data-table" data-testid="purchases-table">
            <thead><tr><th>{t('supplier')}</th><th>{t('invoiceNumber')}</th><th>{t('invoiceDate')}</th><th>{t('dueDate')}</th><th>{t('total')}</th><th>{t('status')}</th><th>{t('sourceType')}</th><th>{t('actions')}</th></tr></thead>
            <tbody>
              {purchases.map((purchase) => (
                <tr key={purchase.id}>
                  <td>{purchase.supplier_name ?? '–'}</td><td className="mono">{purchase.supplier_invoice_number ?? '–'}</td>
                  <td>{purchase.invoice_date ?? '–'}</td><td>{purchase.due_date ?? '–'}</td><td className="num">{Number(purchase.total).toFixed(2)}</td>
                  <td>{t(String(purchase.status).toLowerCase() as any)}</td><td>{purchase.source_type}</td>
                  <td>
                    <button type="button" onClick={() => void openPurchase(purchase.id)}>{t('openPurchase')}</button>
                    {purchase.status === 'NEEDS_REVIEW' && <button type="button" onClick={() => void transition(purchase.id, 'review', undefined, 'purchaseReviewed')}>{t('review')}</button>}
                    {purchase.status === 'READY_FOR_APPROVAL' && <button type="button" className="primary" onClick={() => void transition(purchase.id, 'approve', undefined, 'purchaseApproved')}>{t('approve')}</button>}
                    {purchase.status === 'APPROVED' && <button type="button" className="primary" onClick={() => void transition(purchase.id, 'post', undefined, 'purchasePosted')}>{t('post')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {purchases.length === 0 && <p className="muted">{t('noPurchases')}</p>}

          {selected && (
            <div className="card" data-testid="purchase-detail">
              <h3>{selected.supplier_invoice_number ?? t('draft')}</h3>
              <p>{t('status')}: {t(String(selected.status).toLowerCase() as any)} · {t('supplier')}: {selected.supplier_name ?? '–'} · {selected.currency_code}</p>
              <table className="data-table"><thead><tr><th>{t('description')}</th><th>{t('quantity')}</th><th>{t('unitPrice')}</th><th>{t('taxRate')}</th><th>{t('netAmount')}</th><th>{t('taxAmount')}</th><th>{t('grossAmount')}</th></tr></thead>
                <tbody>{(selected.lines ?? []).map((line) => (
                  <tr key={line.id}>
                    <td>{line.description}</td>
                    <td>{line.quantity}</td>
                    <td className="num">{Number(line.unit_price).toFixed(2)}</td>
                    <td className="num">
                      {Number(line.tax_rate_snapshot ?? 0)}%
                      {line.tax_treatment_snapshot ? ` · ${line.tax_treatment_snapshot}` : ''}
                      {line.deductible_percent_snapshot ? ` · ${line.deductible_percent_snapshot}%` : ''}
                    </td>
                    <td className="num">{Number(line.net_amount).toFixed(2)}</td>
                    <td className="num">{Number(line.tax_amount).toFixed(2)}</td>
                    <td className="num">{Number(line.gross_amount).toFixed(2)}</td>
                  </tr>
                ))}</tbody>
              </table>
              <p>{t('subtotal')}: {Number(selected.subtotal).toFixed(2)} · {t('taxTotal')}: {Number(selected.tax_total).toFixed(2)} · {t('total')}: <strong>{Number(selected.total).toFixed(2)}</strong></p>
              {selected.status === 'NEEDS_REVIEW' && <button type="button" onClick={() => void transition(selected.id, 'review', undefined, 'purchaseReviewed')}>{t('review')}</button>}
              {selected.status === 'READY_FOR_APPROVAL' && <button type="button" className="primary" onClick={() => void transition(selected.id, 'approve', undefined, 'purchaseApproved')}>{t('approve')}</button>}
              {selected.status === 'APPROVED' && <button type="button" className="primary" onClick={() => void transition(selected.id, 'post', undefined, 'purchasePosted')}>{t('post')}</button>}
              {['NEEDS_REVIEW', 'READY_FOR_APPROVAL'].includes(selected.status) && (
                <button type="button" onClick={() => { if (window.confirm(t('rejectConfirm'))) void transition(selected.id, 'reject', { reason: 'Rejected in UI' }, 'purchaseRejected'); }}>{t('reject')}</button>
              )}
              {selected.status === 'POSTED' && (
                <button type="button" onClick={() => { if (window.confirm(t('correctConfirm'))) void transition(selected.id, 'correct', { reason: 'Correction from UI' }, 'purchaseCorrected'); }}>{t('correct')}</button>
              )}
              {selected.accounting_journal_entry_id && <p className="muted">{t('journalLink')}: {selected.accounting_journal_entry_id.slice(0, 8)}</p>}
              {(selected.approvals ?? []).map((approval, index) => (
                <p key={index} className="muted">{approval.action}: {approval.actor_email ?? '–'} {approval.created_at}</p>
              ))}
            </div>
          )}
        </section>
      )}

      {view === 'inbox' && (
        <section data-testid="purchase-inbox-panel">
          <details>
            <summary>{t('importEinvoice')}</summary>
            <div className="card form-stack">
              <label className="field"><span>{t('format')}</span>
                <select value={importFormat} onChange={(event) => setImportFormat(event.target.value)}>
                  <option value="FINVOICE">Finvoice</option><option value="PEPPOL">PEPPOL BIS</option><option value="TEAPPSXML">TEAPPSXML</option>
                </select>
              </label>
              <label className="field"><span>XML</span>
                <textarea rows={12} value={importXml} onChange={(event) => setImportXml(event.target.value)} data-testid="import-xml" />
              </label>
              <button type="button" className="primary" data-testid="import-button" onClick={() => void importXmlFile()}>{t('import')}</button>
            </div>
          </details>
          <table className="data-table" data-testid="purchase-inbox-table">
            <thead><tr><th>{t('received')}</th><th>{t('sourceType')}</th><th>{t('supplier')}</th><th>{t('invoiceNumber')}</th><th>{t('total')}</th><th>{t('status')}</th></tr></thead>
            <tbody>
              {imports.map((row) => (
                <tr key={row.id}><td>{row.created_at}</td><td>{row.source_type}</td><td>{row.supplier_name ?? '–'}</td><td className="mono">{row.supplier_invoice_number ?? '–'}</td><td className="num">{row.total === null ? '–' : Number(row.total).toFixed(2)}</td><td>{row.status}</td></tr>
              ))}
            </tbody>
          </table>
          {imports.length === 0 && <p className="muted">{t('noImports')}</p>}
        </section>
      )}
    </div>
  );
}
