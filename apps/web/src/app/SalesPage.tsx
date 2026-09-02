import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';

type SalesView = 'customers' | 'invoices';
type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CREDITED' | 'CANCELLED_DRAFT';

interface TenantOption {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  name: string;
  business_id: string | null;
  vat_id: string | null;
  email: string | null;
  country_code: string;
  city: string | null;
  is_active: boolean;
}

interface TaxCode {
  id: string;
  code: string;
  rate: string;
  type: string;
}

interface LineDraft {
  key: number;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  discount_percent: string;
  tax_code_id: string;
}

interface SalesLine {
  id: string;
  line_number: number;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  discount_percent: string;
  net_amount: string;
  tax_code_id: string | null;
  tax_rate_snapshot: string | null;
  tax_amount: string;
  gross_amount: string;
}

interface SalesInvoice {
  id: string;
  customer_id: string;
  customer_name: string;
  status: InvoiceStatus;
  invoice_number: string | null;
  issue_date: string | null;
  due_date: string;
  currency_code: string;
  language: string;
  payment_reference: string | null;
  customer_snapshot: Record<string, unknown>;
  subtotal: string;
  tax_total: string;
  total: string;
  accounting_journal_entry_id: string | null;
  credit_of_invoice_id: string | null;
  credited_by_invoice_id: string | null;
  pdf_status: 'GENERATING' | 'READY' | 'FAILED' | null;
  pdf_failure_reason?: string | null;
  lines?: SalesLine[];
}

const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const money = (value: string | number): string => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '0.00';
  return parsed.toFixed(2);
};

function lineNet(line: LineDraft): number {
  const quantity = Number(line.quantity || '0');
  const unitPrice = Number(line.unit_price || '0');
  const base = quantity * unitPrice;
  const discount = (base * Number(line.discount_percent || '0')) / 100;
  return Math.round((base - discount) * 100) / 100;
}

function taxRate(taxCodes: TaxCode[], taxCodeId: string): number {
  return Number(taxCodes.find((code) => code.id === taxCodeId)?.rate ?? 0);
}

export function SalesPage() {
  const { t } = useI18n();
  const { csrf } = useAuth();
  const [tenantId, setTenantId] = useState('');
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [view, setView] = useState<SalesView>('customers');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerDraft, setCustomerDraft] = useState({
    name: '',
    business_id: '',
    vat_id: '',
    email: '',
    country_code: 'FI',
    city: '',
    address_line1: '',
    postal_code: '',
    phone: '',
    payment_terms_days: '14',
    default_currency: 'EUR',
    language: 'fi',
  });
  const [editingCustomerId, setEditingCustomerId] = useState('');

  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<SalesInvoice | null>(null);

  const [invoiceCustomerId, setInvoiceCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [lineCounter, setLineCounter] = useState(1);
  const [lines, setLines] = useState<LineDraft[]>([
    { key: 1, description: '', quantity: '1', unit: '', unit_price: '', discount_percent: '0', tax_code_id: '' },
  ]);

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
    const result = await api<{ tenants: TenantOption[] }>('/api/v1/tenants', { csrf });
    setTenants(result.tenants);
    if (!tenantId && result.tenants[0]) setTenantId(result.tenants[0]!.id);
  };

  const loadCustomers = async () => {
    const query = customerSearch ? `?search=${encodeURIComponent(customerSearch)}` : '';
    const result = await api<{ customers: Customer[] }>(`/api/v1/customers${query}`, { headers });
    setCustomers(result.customers);
  };

  const loadTaxCodes = async () => {
    const result = await api<{ tax_codes: TaxCode[] }>('/api/v1/tax-codes', { headers });
    setTaxCodes(result.tax_codes);
  };

  const loadInvoices = async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (statusFilter) params.set('status', statusFilter);
    if (invoiceSearch) params.set('search', invoiceSearch);
    const result = await api<{ invoices: SalesInvoice[] }>(`/api/v1/sales/invoices?${params.toString()}`, {
      headers,
    });
    setInvoices(result.invoices);
  };

  useEffect(() => {
    void loadTenants().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    void run(async () => {
      await loadCustomers();
      if (view === 'invoices') {
        await Promise.all([loadInvoices(), loadTaxCodes()]);
      }
    });
  }, [tenantId, view, statusFilter, customerSearch]);

  const resetCustomerDraft = () => {
    setEditingCustomerId('');
    setCustomerDraft({
      name: '',
      business_id: '',
      vat_id: '',
      email: '',
      country_code: 'FI',
      city: '',
      address_line1: '',
      postal_code: '',
      phone: '',
      payment_terms_days: '14',
      default_currency: 'EUR',
      language: 'fi',
    });
  };

  const submitCustomer = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const body: Record<string, unknown> = { ...customerDraft, payment_terms_days: Number(customerDraft.payment_terms_days) };
      if (editingCustomerId) {
        await api(`/api/v1/customers/${editingCustomerId}`, { method: 'PATCH', csrf, headers, body });
      } else {
        await api('/api/v1/customers', { method: 'POST', csrf, headers, body });
      }
      resetCustomerDraft();
      await loadCustomers();
    }, editingCustomerId ? 'customerUpdated' : 'customerCreated');
  };

  const editCustomer = (customer: Customer) => {
    setEditingCustomerId(customer.id);
    setCustomerDraft({
      name: customer.name,
      business_id: customer.business_id ?? '',
      vat_id: customer.vat_id ?? '',
      email: customer.email ?? '',
      country_code: customer.country_code,
      city: customer.city ?? '',
      address_line1: '',
      postal_code: '',
      phone: '',
      payment_terms_days: '14',
      default_currency: 'EUR',
      language: 'fi',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleCustomer = async (customer: Customer) => {
    await run(async () => {
      const action = customer.is_active ? 'deactivate' : 'activate';
      await api(`/api/v1/customers/${customer.id}/${action}`, { method: 'POST', csrf, headers });
      await loadCustomers();
    }, customer.is_active ? 'customerDeactivated' : 'customerActivated');
  };

  const addLine = () => {
    setLineCounter((value) => value + 1);
    setLines((current) => [
      ...current,
      {
        key: lineCounter + 1,
        description: '',
        quantity: '1',
        unit: '',
        unit_price: '',
        discount_percent: '0',
        tax_code_id: taxCodes[0]?.id ?? '',
      },
    ]);
  };

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const removeLine = (key: number) => {
    if (lines.length <= 1) return;
    setLines((current) => current.filter((line) => line.key !== key));
  };

  const previewTotals = () => {
    let subtotal = 0;
    let tax = 0;
    for (const line of lines) {
      const net = lineNet(line);
      subtotal += net;
      tax += (net * taxRate(taxCodes, line.tax_code_id)) / 100;
    }
    return { subtotal: money(subtotal), tax: money(tax), total: money(subtotal + tax) };
  };

  const saveDraft = async () => {
    await run(async () => {
      const body = {
        customer_id: invoiceCustomerId,
        issue_date: issueDate,
        due_date: dueDate || undefined,
        currency_code: currencyCode,
        lines: lines
          .filter((line) => line.description.trim())
          .map((line) => ({
            description: line.description,
            quantity: line.quantity || '1',
            unit: line.unit,
            unit_price: line.unit_price || '0',
            discount_percent: line.discount_percent || '0',
            tax_code_id: line.tax_code_id,
          })),
      };
      await api('/api/v1/sales/invoices', { method: 'POST', csrf, headers, body });
      setInvoiceCustomerId('');
      setIssueDate(today());
      setDueDate('');
      setLines([{ key: lineCounter + 1, description: '', quantity: '1', unit: '', unit_price: '', discount_percent: '0', tax_code_id: taxCodes[0]?.id ?? '' }]);
      await loadInvoices();
    }, 'draftCreated');
  };

  const openInvoice = async (invoiceId: string) => {
    await run(async () => {
      const result = await api<{ invoice: SalesInvoice }>(`/api/v1/sales/invoices/${invoiceId}`, { headers });
      setSelectedInvoice(result.invoice);
    });
  };

  const issueSelected = async (invoiceId: string) => {
    await run(async () => {
      await api(`/api/v1/sales/invoices/${invoiceId}/issue`, { method: 'POST', csrf, headers });
      await openInvoice(invoiceId);
      await loadInvoices();
    }, 'invoiceIssued');
  };

  const cancelDraft = async (invoiceId: string) => {
    await run(async () => {
      await api(`/api/v1/sales/invoices/${invoiceId}/cancel-draft`, { method: 'POST', csrf, headers });
      await loadInvoices();
    }, 'draftCancelled');
  };

  const creditSelected = async (invoiceId: string) => {
    if (!window.confirm(t('creditConfirm'))) return;
    await run(async () => {
      await api(`/api/v1/sales/invoices/${invoiceId}/credit`, {
        method: 'POST',
        csrf,
        headers,
        body: { reason: 'Credit note from UI' },
      });
      await openInvoice(invoiceId);
      await loadInvoices();
    }, 'creditCreated');
  };

  const retryPdf = async (invoiceId: string) => {
    await run(async () => {
      await api(`/api/v1/sales/invoices/${invoiceId}/pdf/retry`, { method: 'POST', csrf, headers });
      await openInvoice(invoiceId);
    }, 'pdfRetryScheduled');
  };

  const downloadPdf = async (invoiceId: string) => {
    setError('');
    try {
      const response = await fetch(`/api/v1/sales/invoices/${invoiceId}/pdf`, { headers });
      if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `invoice-${invoiceId}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!tenantId) {
    return (
      <div className="workspace-page" data-testid="sales-page">
        <h2 className="page-title">{t('sales')}</h2>
        <p className="muted">{t('loading')}</p>
      </div>
    );
  }

  const totals = previewTotals();
  const detail = selectedInvoice;

  return (
    <div className="workspace-page" data-testid="sales-page">
      <h2 className="page-title">{t('sales')}</h2>
      <label className="field">
        <span>{t('tenantSwitcher')}</span>
        <select
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
            setSelectedInvoice(null);
            setError('');
            setMessage('');
          }}
        >
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}

      <nav className="tab-bar" aria-label={t('sales')}>
        <button
          type="button"
          data-testid="tab-customers"
          className={view === 'customers' ? 'tab-button active' : 'tab-button'}
          onClick={() => setView('customers')}
        >
          {t('customers')}
        </button>
        <button
          type="button"
          data-testid="tab-invoices"
          className={view === 'invoices' ? 'tab-button active' : 'tab-button'}
          onClick={() => setView('invoices')}
        >
          {t('invoices')}
        </button>
      </nav>

      {view === 'customers' && (
        <section data-testid="customers-panel">
          <details>
            <summary>{editingCustomerId ? t('editCustomer') : t('addCustomer')}</summary>
            <form className="card form-stack" data-testid="customer-form" onSubmit={submitCustomer}>
              <label className="field">
                <span>{t('name')}</span>
                <input
                  value={customerDraft.name}
                  onChange={(event) => setCustomerDraft({ ...customerDraft, name: event.target.value })}
                  required
                />
              </label>
              <div className="form-row">
                <label className="field">
                  <span>{t('businessId')}</span>
                  <input
                    value={customerDraft.business_id}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, business_id: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>VAT ID</span>
                  <input
                    value={customerDraft.vat_id}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, vat_id: event.target.value })}
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="field">
                  <span>{t('email')}</span>
                  <input
                    type="email"
                    value={customerDraft.email}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, email: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('phone')}</span>
                  <input
                    value={customerDraft.phone}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, phone: event.target.value })}
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="field">
                  <span>{t('address')}</span>
                  <input
                    value={customerDraft.address_line1}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, address_line1: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('city')}</span>
                  <input
                    value={customerDraft.city}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, city: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('postalCode')}</span>
                  <input
                    value={customerDraft.postal_code}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, postal_code: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('country')}</span>
                  <input
                    maxLength={2}
                    value={customerDraft.country_code}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, country_code: event.target.value.toUpperCase() })}
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="field">
                  <span>{t('paymentTermsDays')}</span>
                  <input
                    type="number"
                    min={0}
                    value={customerDraft.payment_terms_days}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, payment_terms_days: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('currency')}</span>
                  <input
                    maxLength={3}
                    value={customerDraft.default_currency}
                    onChange={(event) => setCustomerDraft({ ...customerDraft, default_currency: event.target.value.toUpperCase() })}
                  />
                </label>
              </div>
              <div>
                <button type="submit" className="primary">{t('save')}</button>
                {editingCustomerId && (
                  <button type="button" onClick={resetCustomerDraft}>{t('cancel')}</button>
                )}
              </div>
            </form>
          </details>

          <form className="card form-row" onSubmit={(event) => { event.preventDefault(); void run(loadCustomers); }}>
            <label className="field">
              <span>{t('search')}</span>
              <input
                data-testid="customer-search"
                value={customerSearch}
                onChange={(event) => setCustomerSearch(event.target.value)}
              />
            </label>
            <button type="submit" data-testid="search-customers">{t('search')}</button>
          </form>

          <table className="data-table" data-testid="customers-table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('businessId')}</th>
                <th>VAT ID</th>
                <th>{t('email')}</th>
                <th>{t('country')}</th>
                <th>{t('status')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <td>{customer.name}</td>
                  <td className="mono">{customer.business_id ?? '–'}</td>
                  <td className="mono">{customer.vat_id ?? '–'}</td>
                  <td>{customer.email ?? '–'}</td>
                  <td>{customer.country_code}</td>
                  <td>{customer.is_active ? t('active') : t('inactive')}</td>
                  <td>
                    <button type="button" onClick={() => editCustomer(customer)}>{t('edit')}</button>
                    <button type="button" onClick={() => void toggleCustomer(customer)}>
                      {customer.is_active ? t('deactivate') : t('activate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {customers.length === 0 && <p className="muted">{t('noCustomers')}</p>}
        </section>
      )}

      {view === 'invoices' && (
        <section data-testid="invoices-panel">
          <details>
            <summary>{t('newInvoice')}</summary>
            <form className="card form-stack" data-testid="invoice-draft-form">
              <div className="form-row">
                <label className="field">
                  <span>{t('customer')}</span>
                  <select value={invoiceCustomerId} onChange={(event) => setInvoiceCustomerId(event.target.value)} required>
                    <option value="">{t('selectCustomer')}</option>
                    {customers.filter((customer) => customer.is_active).map((customer) => (
                      <option key={customer.id} value={customer.id}>{customer.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t('invoiceDate')}</span>
                  <input type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
                </label>
                <label className="field">
                  <span>{t('dueDate')}</span>
                  <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
                </label>
                <label className="field">
                  <span>{t('currency')}</span>
                  <input maxLength={3} value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} />
                </label>
              </div>
              {lines.map((line) => (
                <div className="entry-line-row" key={line.key}>
                  <input
                    aria-label={`${t('description')} ${line.key}`}
                    placeholder={t('description')}
                    value={line.description}
                    onChange={(event) => updateLine(line.key, { description: event.target.value })}
                  />
                  <input
                    type="number"
                    min="0"
                    step="any"
                    aria-label={`${t('quantity')} ${line.key}`}
                    value={line.quantity}
                    onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                  />
                  <input
                    aria-label={`${t('unit')} ${line.key}`}
                    value={line.unit}
                    onChange={(event) => updateLine(line.key, { unit: event.target.value })}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    aria-label={`${t('unitPrice')} ${line.key}`}
                    value={line.unit_price}
                    onChange={(event) => updateLine(line.key, { unit_price: event.target.value })}
                  />
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    aria-label={`${t('discountPercent')} ${line.key}`}
                    value={line.discount_percent}
                    onChange={(event) => updateLine(line.key, { discount_percent: event.target.value })}
                  />
                  <select
                    aria-label={`${t('taxCode')} ${line.key}`}
                    value={line.tax_code_id}
                    onChange={(event) => updateLine(line.key, { tax_code_id: event.target.value })}
                  >
                    <option value="">{t('selectTax')}</option>
                    {taxCodes.map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.code} {Number(code.rate)}%
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeLine(line.key)}>×</button>
                </div>
              ))}
              <div>
                <button type="button" onClick={addLine}>+</button>
                <button type="button" className="primary" onClick={() => void saveDraft()}>{t('saveDraft')}</button>
              </div>
              <p data-testid="totals-preview">
                {t('subtotal')}: {totals.subtotal} | {t('taxTotal')}: {totals.tax} | {t('total')}: {totals.total}
              </p>
            </form>
          </details>

          <div className="card form-row">
            <label className="field">
              <span>{t('status')}</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">{t('all')}</option>
                <option value="DRAFT">{t('draft')}</option>
                <option value="ISSUED">{t('issued')}</option>
                <option value="CREDITED">{t('credited')}</option>
                <option value="CANCELLED_DRAFT">{t('cancelledDraft')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('search')}</span>
              <input
                data-testid="invoice-search"
                value={invoiceSearch}
                onChange={(event) => setInvoiceSearch(event.target.value)}
              />
            </label>
            <button type="button" data-testid="invoice-refresh" onClick={() => void run(loadInvoices)}>{t('refresh')}</button>
          </div>

          <table className="data-table" data-testid="invoices-table">
            <thead>
              <tr>
                <th>{t('invoice')}</th>
                <th>{t('customer')}</th>
                <th>{t('issueDate')}</th>
                <th>{t('dueDate')}</th>
                <th>{t('total')}</th>
                <th>{t('status')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="mono">{invoice.invoice_number ?? t('draft')}</td>
                  <td>{invoice.customer_name}</td>
                  <td>{invoice.issue_date ?? '–'}</td>
                  <td>{invoice.due_date}</td>
                  <td className="num">{money(invoice.total)}</td>
                  <td>{t(String(invoice.status).toLowerCase() as any)}</td>
                  <td>
                    <button type="button" onClick={() => void openInvoice(invoice.id)}>{t('openInvoice')}</button>
                    {invoice.status === 'DRAFT' && (
                      <>
                        <button type="button" className="primary" onClick={() => void issueSelected(invoice.id)}>
                          {t('issue')}
                        </button>
                        <button type="button" onClick={() => void cancelDraft(invoice.id)}>{t('cancelDraft')}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {invoices.length === 0 && <p className="muted">{t('noInvoices')}</p>}

          {detail && (
            <div className="card" data-testid="invoice-detail">
              <h3>{detail.invoice_number ?? t('draft')}</h3>
              <p>
                {t('status')}: {t(String(detail.status).toLowerCase() as any)}
              </p>
              <p className="muted">
                {t('customer')}: {detail.customer_name} · {t('issueDate')}: {detail.issue_date ?? '–'} ·{' '}
                {t('dueDate')}: {detail.due_date} · {detail.currency_code}
              </p>
              {detail.payment_reference && <p className="mono">{t('paymentReference')}: {detail.payment_reference}</p>}
              {detail.customer_snapshot && (
                <p>
                  {String(detail.customer_snapshot.name ?? detail.customer_name)} ·{' '}
                  {String(detail.customer_snapshot.business_id ?? '')}
                </p>
              )}
              <table className="data-table" data-testid="invoice-lines-table">
                <thead>
                  <tr>
                    <th>{t('description')}</th>
                    <th>{t('quantity')}</th>
                    <th>{t('unitPrice')}</th>
                    <th>{t('taxRate')}</th>
                    <th>{t('netAmount')}</th>
                    <th>{t('taxAmount')}</th>
                    <th>{t('grossAmount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.lines ?? []).map((line) => (
                    <tr key={line.id}>
                      <td>{line.description}</td>
                      <td>{line.quantity}{line.unit ? ` ${line.unit}` : ''}</td>
                      <td className="num">{money(line.unit_price)}</td>
                      <td className="num">{Number(line.tax_rate_snapshot ?? 0)}%</td>
                      <td className="num">{money(line.net_amount)}</td>
                      <td className="num">{money(line.tax_amount)}</td>
                      <td className="num">{money(line.gross_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p data-testid="detail-totals">
                {t('subtotal')}: {money(detail.subtotal)} · {t('taxTotal')}: {money(detail.tax_total)} ·{' '}
                {t('total')}: <strong>{money(detail.total)}</strong>
              </p>
              {detail.pdf_status && (
                <p data-testid="pdf-status">
                  {t('pdf')}: {detail.pdf_status === 'READY' ? t('ready') : detail.pdf_status === 'FAILED' ? t('pdfFailed') : t('generatingPdf')}
                </p>
              )}
              {detail.pdf_status === 'READY' && (
                <button type="button" onClick={() => void downloadPdf(detail.id)}>{t('downloadPdf')}</button>
              )}
              {detail.pdf_status === 'FAILED' && (
                <button type="button" onClick={() => void retryPdf(detail.id)}>{t('retryPdf')}</button>
              )}
              {detail.status === 'ISSUED' && (
                <button type="button" onClick={() => void creditSelected(detail.id)}>{t('creditInvoice')}</button>
              )}
              {detail.accounting_journal_entry_id && (
                <p className="muted">
                  {t('journalLink')}: {detail.accounting_journal_entry_id.slice(0, 8)}
                </p>
              )}
              {detail.pdf_failure_reason && <p className="error-text">{detail.pdf_failure_reason}</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
