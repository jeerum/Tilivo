import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';
import type { TaxCodeView } from '../lib/tax';
import { AiSuggestionPanel } from './AiSuggestionPanel';

const moneyText = (value: string | number): string => Number(value ?? 0).toFixed(2);

interface Receipt {
  id: string;
  document_type: string;
  merchant_name: string | null;
  supplier_id: string | null;
  supplier_name?: string | null;
  supplier_invoice_number: string | null;
  invoice_date: string | null;
  currency_code: string;
  subtotal: string;
  tax_total: string;
  total: string;
  status: string;
  payment_method: string;
  payment_status: string;
  ocr_status: string;
  duplicate_warning: string | null;
  description: string | null;
  accounting_journal_entry_id: string | null;
}

interface DraftLine {
  description: string;
  quantity: string;
  unit_price: string;
  tax_code_id: string;
  expense_account_id: string;
  deductible_percent: string;
}

export function ReceiptsPage({ tenantId, headers }: { tenantId: string; headers?: Record<string, string> }) {
  const { t } = useI18n();
  const { csrf } = useAuth();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCodeView[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('COMPANY_CARD');
  const [line, setLine] = useState<DraftLine>({
    description: 'Receipt expense',
    quantity: '1',
    unit_price: '',
    tax_code_id: '',
    expense_account_id: '',
    deductible_percent: '100',
  });
  const [active, setActive] = useState<Receipt | null>(null);
  const [uploadingId, setUploadingId] = useState('');
  const [ocrBusy, setOcrBusy] = useState('');

  const run = async (operation: () => Promise<void>, success = '') => {
    setError('');
    setMessage('');
    try {
      await operation();
      if (success) setMessage(t(success as any));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadAll = async () => {
    const [receiptsResult, suppliersResult, accountsResult, taxResult] = await Promise.all([
      api<{ purchases: Receipt[] }>('/api/v1/purchases?document_type=RECEIPT&limit=100', { headers }),
      api<{ suppliers: Array<{ id: string; name: string }> }>('/api/v1/suppliers', { headers }),
      api<{ accounts: Array<{ id: string; code: string; name: string }> }>('/api/v1/accounts', { headers }),
      api<{ tax_codes: TaxCodeView[] }>('/api/v1/tax-codes?current=true&direction=PURCHASE', { headers }),
    ]);
    setReceipts(receiptsResult.purchases);
    setSuppliers(suppliersResult.suppliers);
    setAccounts(accountsResult.accounts);
    setTaxCodes(taxResult.tax_codes);
    if (!line.tax_code_id && taxResult.tax_codes[0]) {
      setLine((current) => ({ ...current, tax_code_id: taxResult.tax_codes[0]!.id }));
    }
  };

  useEffect(() => {
    if (!tenantId) return;
    void run(loadAll);
  }, [tenantId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const result = await api<{ purchase: Receipt }>('/api/v1/purchases', {
        method: 'POST',
        csrf,
        headers,
        body: {
          supplier_id: supplierId || null,
          merchant_name: supplierId ? undefined : merchant,
          invoice_date: date,
          document_type: 'RECEIPT',
          payment_method: paymentMethod,
          payment_status: paymentMethod === 'BANK_TRANSFER' ? 'UNPAID' : 'PAID_AT_PURCHASE',
          description: description || undefined,
          lines: [
            {
              description: line.description || 'Receipt expense',
              quantity: line.quantity,
              unit_price: amount,
              tax_code_id: line.tax_code_id,
              deductible_percent: line.deductible_percent,
              expense_account_id: line.expense_account_id,
            },
          ],
        },
      });
      setActive(result.purchase);
      setFormOpen(false);
      setMerchant('');
      setSupplierId('');
      setAmount('');
      setDescription('');
      await loadAll();
    }, 'purchaseDraftCreated');
  };

  const transition = async (receipt: Receipt, action: string) => {
    await run(async () => {
      await api(`/api/v1/purchases/${receipt.id}/${action}`, { method: 'POST', csrf, headers });
      await loadAll();
      const result = await api<{ purchase: Receipt }>(`/api/v1/purchases/${receipt.id}`, { headers });
      setActive(result.purchase);
    });
  };

  const uploadFor = async (receipt: Receipt, file: File) => {
    if (!file) return;
    setUploadingId(receipt.id);
    await run(async () => {
      const form = new FormData();
      form.append('file', file, file.name);
      await api(`/api/v1/purchases/${receipt.id}/documents`, { method: 'POST', csrf, headers, body: form });
      const result = await api<{ purchase: Receipt }>(`/api/v1/purchases/${receipt.id}`, { headers });
      setActive(result.purchase);
    }, 'purchaseDocumentAttached');
    setUploadingId('');
  };

  const runOcr = async (receipt: Receipt) => {
    setOcrBusy(receipt.id);
    await run(async () => {
      const result = await api<{ purchase: Receipt }>(`/api/v1/purchases/${receipt.id}/ocr`, {
        method: 'POST',
        csrf,
        headers,
      });
      setActive(result.purchase);
      await loadAll();
    });
    setOcrBusy('');
  };

  const statusLabel = (value: string) => t(String(value).toLowerCase() as any) || value;

  return (
    <section data-testid="receipts-panel">
      <div className="card form-row">
        <button type="button" className="primary" data-testid="add-receipt" onClick={() => setFormOpen((open) => !open)}>
          {t('addReceipt')}
        </button>
        <button type="button" onClick={() => void run(loadAll)}>{t('refresh')}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}
      {formOpen && (
        <form className="card form-stack" data-testid="receipt-form" onSubmit={submit}>
          <div className="form-row">
            <label className="field"><span>{t('supplier')}</span>
              <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
                <option value="">{t('merchantManual')}</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </label>
            {!supplierId && (
              <label className="field"><span>{t('merchantName')}</span>
                <input value={merchant} onChange={(event) => setMerchant(event.target.value)} required />
              </label>
            )}
            <label className="field"><span>{t('invoiceDate')}</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
            </label>
            <label className="field"><span>{t('paymentMethod')}</span>
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                {['BANK_TRANSFER', 'COMPANY_CARD', 'CASH', 'PERSONAL_CARD', 'EMPLOYEE_PAID', 'OTHER'].map((method) => (
                  <option key={method} value={method}>{method}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="field"><span>{t('description')}</span>
              <input value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label className="field"><span>{t('total')}</span>
              <input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            </label>
            <label className="field"><span>{t('expenseAccount')}</span>
              <select value={line.expense_account_id} onChange={(event) => setLine({ ...line, expense_account_id: event.target.value })} required>
                <option value="">{t('selectAccount')}</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}
              </select>
            </label>
            <label className="field"><span>{t('taxCode')}</span>
              <select value={line.tax_code_id} onChange={(event) => setLine({ ...line, tax_code_id: event.target.value })}>
                {taxCodes.map((code) => <option key={code.id} value={code.id}>{code.code} {code.rate}%</option>)}
              </select>
            </label>
            <label className="field"><span>{t('deductibility')}</span>
              <select value={line.deductible_percent} onChange={(event) => setLine({ ...line, deductible_percent: event.target.value })}>
                {['100', '75', '50', '25', '0'].map((value) => <option key={value} value={value}>{value}%</option>)}
              </select>
            </label>
          </div>
          <button type="submit" className="primary" data-testid="save-receipt">{t('saveDraft')}</button>
        </form>
      )}

      <div className="table-scroll">
        <table className="data-table" data-testid="receipts-table">
          <thead>
            <tr>
              <th>{t('invoiceDate')}</th>
              <th>{t('supplier')}</th>
              <th>{t('total')}</th>
              <th>{t('paymentMethod')}</th>
              <th>{t('status')}</th>
              <th>OCR</th>
              <th>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.id}>
                <td>{receipt.invoice_date ?? '–'}</td>
                <td>{receipt.supplier_name ?? receipt.merchant_name ?? '–'}</td>
                <td className="num">{moneyText(receipt.total)}</td>
                <td>{receipt.payment_method}</td>
                <td>{statusLabel(receipt.status)} {receipt.duplicate_warning ? '⚠' : ''}</td>
                <td>{receipt.ocr_status}</td>
                <td>
                  <button type="button" onClick={() => { setActive(receipt); setError(''); setMessage(''); }}>{t('openPurchase')}</button>
                  <label className="field inline-upload">
                    {t('upload')}
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      data-testid={`receipt-file-${receipt.id}`}
                      disabled={Boolean(uploadingId)}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadFor(receipt, file);
                      }}
                    />
                  </label>
                  <button type="button" disabled={Boolean(ocrBusy)} onClick={() => void runOcr(receipt)}>OCR</button>
                  {receipt.status === 'DRAFT' && <button type="button" onClick={() => void transition(receipt, 'review')}>{t('review')}</button>}
                  {receipt.status === 'READY_FOR_APPROVAL' && <button type="button" className="primary" onClick={() => void transition(receipt, 'approve')}>{t('approve')}</button>}
                  {receipt.status === 'APPROVED' && <button type="button" className="primary" onClick={() => void transition(receipt, 'post')}>{t('post')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {receipts.length === 0 && <p className="muted">{t('noReceipts')}</p>}

      {active && (
        <div className="card" data-testid="receipt-detail">
          <h3>{active.merchant_name ?? active.supplier_name ?? active.id}</h3>
          <p>{active.document_type} · {active.payment_method} · {statusLabel(active.status)} · {active.ocr_status}</p>
          {active.duplicate_warning && <p className="error-text">{active.duplicate_warning}</p>}
          <p>{t('subtotal')}: {moneyText(active.subtotal)} · {t('taxTotal')}: {moneyText(active.tax_total)} · {t('total')}: <strong>{moneyText(active.total)}</strong></p>
          <AiSuggestionPanel documentId={active.id} tenantId={tenantId} onChanged={() => void loadAll()} />
          {active.accounting_journal_entry_id && <p className="muted">{t('journalLink')}: {active.accounting_journal_entry_id}</p>}
        </div>
      )}
    </section>
  );
}
