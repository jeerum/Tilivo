import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../auth/api';
import { useI18n } from '../i18n/I18nContext';
import { moneyFixed, openBalance, remainingCreditable } from '../lib/salesUi';

export type ApiHeaders = Record<string, string>;

interface PanelProps {
  tenantId: string;
  csrf: string;
  headers: ApiHeaders;
  onChanged?: () => void | Promise<void>;
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function Notice({ error, success }: { error: string; success: string }) {
  return (
    <>
      {error && <p className="error-text">{error}</p>}
      {success && <p className="success-text">{success}</p>}
    </>
  );
}

export function SummaryCards(props: PanelProps & { refreshKey: number }) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<Record<string, string>>({});
  const load = async () => {
    const result = await api<{ summary: Record<string, string> }>('/api/v1/sales/ledger?limit=1', {
      headers: props.headers,
    });
    setSummary(result.summary);
  };
  useEffect(() => {
    void load().catch(() => undefined);
  }, [props.tenantId, props.refreshKey]);
  const cards: Array<[string, string]> = [
    [t('outstanding'), summary.outstanding ?? '0.00'],
    [t('overdueLabel'), summary.overdue ?? '0.00'],
    [t('dueSoon'), summary.dueSoon ?? '0.00'],
    [t('paidThisPeriod'), summary.paidThisPeriod ?? '0.00'],
  ];
  return (
    <div className="summary-cards" data-testid="ar-summary-cards">
      {cards.map(([label, value]) => (
        <div className="card summary-card" key={label}>
          <strong>{label}</strong>
          <span>{moneyFixed(value)}</span>
        </div>
      ))}
    </div>
  );
}

export function PaymentPanel({ invoice, csrf, headers, onChanged }: PanelProps & { invoice: any }) {
  const { t } = useI18n();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('MANUAL');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const open = openBalance(invoice.total, invoice.advance_applied, invoice.credited_amount, invoice.amount_paid);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Amount must be greater than zero');
      return;
    }
    if (value > Number(open) + 0.001) {
      setError(`Amount exceeds the open balance (${moneyFixed(open)})`);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/v1/sales/invoices/${invoice.id}/payments`, {
        method: 'POST',
        csrf,
        headers,
        body: { amount, payment_date: date, method, note },
      });
      setAmount('');
      setSuccess(t('paymentSaved'));
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack" data-testid="payment-panel">
      <Notice error={error} success={success} />
      <p>
        {t('total')}: {moneyFixed(invoice.total)} · {t('advanceApplied')}: {moneyFixed(invoice.advance_applied)} ·{' '}
        {t('credited')}: {moneyFixed(invoice.credited_amount)} · {t('paid')}: {moneyFixed(invoice.amount_paid)} ·{' '}
        {t('openBalance')}: <strong>{moneyFixed(open)}</strong>
      </p>
      <form className="form-row" onSubmit={submit}>
        <Field label={t('paymentDate')}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </Field>
        <Field label={t('amount')}>
          <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required data-testid="payment-amount" />
        </Field>
        <Field label={t('method')}>
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="MANUAL">Manual</option>
            <option value="BANK">Bank</option>
            <option value="CARD">Card</option>
          </select>
        </Field>
        <Field label={t('note')}>
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <button type="submit" className="primary" disabled={busy} data-testid="save-payment">
          {busy ? t('saving') : t('recordPayment')}
        </button>
      </form>
    </div>
  );
}

export function PaymentHistory({ invoiceId, tenantId, headers }: { invoiceId: string; tenantId: string; headers: ApiHeaders }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<any[]>([]);
  const load = async () => {
    const result = await api<{ payments: any[] }>(`/api/v1/sales/invoices/${invoiceId}/payments`, { headers });
    setRows(result.payments);
  };
  useEffect(() => {
    void load().catch(() => undefined);
  }, [invoiceId, tenantId]);
  return (
    <div data-testid="payment-history">
      <strong>{t('history') ?? 'Payments'}</strong>
      {rows.length === 0 && <p className="muted">{t('historyEmpty')}</p>}
      {rows.map((row) => (
        <p key={row.id}>
          {row.payment_date} · {moneyFixed(row.amount)} · {row.method} · {row.note ?? ''} · {row.reference ?? ''}
        </p>
      ))}
    </div>
  );
}

export function AdvanceStateSection({ invoiceId, tenantId, headers }: { invoiceId: string; tenantId: string; headers: ApiHeaders }) {
  const { t } = useI18n();
  const [state, setState] = useState<any>(null);
  useEffect(() => {
    const load = async () => {
      const result = await api<{ advance_state: any }>(`/api/v1/sales/invoices/${invoiceId}/advances`, { headers });
      setState(result.advance_state);
    };
    void load().catch(() => undefined);
  }, [invoiceId, tenantId]);
  if (!state) return null;
  const allocations = state.allocations ?? [];
  const isAdvance = state.document_type === 'ADVANCE_INVOICE';
  return (
    <div className="card" data-testid="advance-state">
      <strong>{t('advanceApplied')}</strong>
      {isAdvance && (
        <p>
          {t('invoice')}: {state.invoice_number ?? ''} · {t('total')}: {moneyFixed(state.total)} · {t('advanceApplied')}: {moneyFixed(state.applied_total)} · {t('remainingAvailable')}: {moneyFixed(state.remaining)}
        </p>
      )}
      {!isAdvance && allocations.length === 0 && <p className="muted">{t('historyEmpty')}</p>}
      {!isAdvance &&
        allocations.map((allocation: any) => (
          <p key={allocation.advance_invoice_id}>
            {t('advanceInvoice')}: {allocation.advance_number} · {t('advanceApplied')}: {moneyFixed(allocation.applied_amount)}
          </p>
        ))}
    </div>
  );
}

export function CreditPanel({ invoice, tenantId, csrf, headers, onChanged }: PanelProps & { invoice: any }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [reason, setReason] = useState('');
  const [edits, setEdits] = useState<Record<string, { quantity: string; unit_price: string }>>({});
  const [notes, setNotes] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const creditable = remainingCreditable(invoice.total, invoice.advance_applied, invoice.credited_amount);
  const lines: any[] = invoice.lines ?? [];

  const loadNotes = async () => {
    const result = await api<{ credit_notes: any[] }>(`/api/v1/sales/invoices/${invoice.id}/credit-notes`, { headers });
    setNotes(result.credit_notes);
  };
  useEffect(() => {
    void loadNotes().catch(() => undefined);
  }, [invoice.id, tenantId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason || reason.trim().length < 3) {
      setError('Credit reason is required');
      return;
    }
    if (mode === 'full' && Number(creditable) <= 0) {
      setError(t('remainingCreditable') + ' = 0');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { reason };
      if (mode === 'partial') {
        const selected = lines
          .filter((line) => edits[line.id])
          .map((line) => ({
            sales_invoice_line_id: line.id,
            quantity: edits[line.id]!.quantity,
            unit_price: edits[line.id]!.unit_price,
          }));
        if (selected.length === 0) {
          setError('Select at least one line to credit');
          setBusy(false);
          return;
        }
        body.lines = selected;
      }
      await api(`/api/v1/sales/invoices/${invoice.id}/credit-note`, { method: 'POST', csrf, headers, body });
      setSuccess(t('creditCreated'));
      setReason('');
      await Promise.all([loadNotes(), onChanged?.()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectedTotal = lines.reduce((sum: number, line: any) => {
    const edit = edits[line.id];
    if (!edit) return sum;
    const net = Number(edit.quantity) * Number(edit.unit_price);
    const tax = net * (Number(line.tax_rate_snapshot ?? 0) / 100);
    return sum + net + tax;
  }, 0);

  return (
    <div className="card form-stack" data-testid="credit-panel">
      <Notice error={error} success={success} />
      <p>
        {t('openBalance')}: {moneyFixed(invoice.open_balance ?? openBalance(invoice.total, invoice.advance_applied, invoice.credited_amount, invoice.amount_paid))} ·{' '}
        {t('remainingCreditable')}: <strong>{moneyFixed(creditable)}</strong>
      </p>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label={t('creditNote')}>
            <select value={mode} onChange={(event) => setMode(event.target.value as 'full' | 'partial')}>
              <option value="full">{t('fullCredit')}</option>
              <option value="partial">{t('partialCredit')}</option>
            </select>
          </Field>
          <Field label={t('note')}>
            <input value={reason} onChange={(event) => setReason(event.target.value)} required data-testid="credit-reason" />
          </Field>
        </div>
        {mode === 'partial' && (
          <table className="data-table" data-testid="credit-lines">
            <thead>
              <tr>
                <th />
                <th>{t('description')}</th>
                <th>{t('quantity')}</th>
                <th>{t('unitPrice')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line: any) => {
                const edit = edits[line.id] ?? { quantity: String(line.quantity), unit_price: String(line.unit_price) };
                return (
                  <tr key={line.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={Boolean(edits[line.id])}
                        onChange={(event) => {
                          const next = { ...edits };
                          if (event.target.checked) next[line.id] = edit;
                          else delete next[line.id];
                          setEdits(next);
                        }}
                      />
                    </td>
                    <td>{line.description}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max={line.quantity}
                        step="0.000001"
                        value={edits[line.id]?.quantity ?? ''}
                        onChange={(event) => setEdits({ ...edits, [line.id]: { ...edit, quantity: event.target.value } })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max={line.unit_price}
                        step="0.01"
                        value={edits[line.id]?.unit_price ?? ''}
                        onChange={(event) => setEdits({ ...edits, [line.id]: { ...edit, unit_price: event.target.value } })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <button type="submit" className="primary" disabled={busy} data-testid="create-credit">
          {busy ? t('creating') : t('createCredit')}
        </button>
      </form>
      <p>
        {t('creditTotal')}: {moneyFixed(selectedTotal)}
      </p>
      {notes.length > 0 && (
        <div data-testid="credit-history">
          <strong>{t('creditNote')}</strong>
          {notes.map((note) => (
            <p key={note.id}>
              {note.invoice_number} · {note.issue_date} · {moneyFixed(note.total)} · {note.status}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReminderPanel({ invoice, tenantId, csrf, headers, onChanged }: PanelProps & { invoice: any }) {
  const { t } = useI18n();
  const [level, setLevel] = useState('1');
  const [note, setNote] = useState('');
  const [applyFee, setApplyFee] = useState(false);
  const [current, setCurrent] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const open = openBalance(invoice.total, invoice.advance_applied, invoice.credited_amount, invoice.amount_paid);

  const loadHistory = async () => {
    const result = await api<{ reminders: any[] }>(`/api/v1/sales/invoices/${invoice.id}/reminders`, { headers });
    setHistory(result.reminders);
  };
  useEffect(() => {
    void loadHistory().catch(() => undefined);
  }, [invoice.id, tenantId]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (Number(open) <= 0) {
      setError('Invoice has no open balance');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<{ reminder: any }>(`/api/v1/sales/invoices/${invoice.id}/reminders`, {
        method: 'POST',
        csrf,
        headers,
        body: { level: Number(level), note, apply_reminder_fee: applyFee },
      });
      setCurrent(result.reminder);
      setSuccess(t('reminderCreated'));
      await loadHistory();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!current) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await api(`/api/v1/sales/reminders/${current.id}/pdf`, { method: 'POST', csrf, headers });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const state = await api<{ reminder: any }>(`/api/v1/sales/reminders/${current.id}`, { headers });
        if (String(state.reminder.pdf_status) === 'READY') break;
        if (attempt === 19) throw new Error('Reminder PDF did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const sent = await api<{ sent: boolean; status: string; error?: string }>(`/api/v1/sales/reminders/${current.id}/send`, {
        method: 'POST',
        csrf,
        headers,
        body: { recipient: invoice.customer_snapshot?.email ?? '' },
      });
      if (!sent.sent) throw new Error(sent.error ?? 'Send failed');
      setSuccess(t('reminderSent'));
      await loadHistory();
      await onChanged?.();
      setCurrent(null);
    } catch (cause) {
      setError(t('sendFailed') + ': ' + (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack" data-testid="reminder-panel">
      <Notice error={error} success={success} />
      <form className="form-row" onSubmit={create}>
        <Field label={t('reminderLevel')}>
          <input type="number" min="1" max="5" value={level} onChange={(event) => setLevel(event.target.value)} />
        </Field>
        <Field label={t('message')}>
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <label className="field">
          <span>{t('applyFee')}</span>
          <input type="checkbox" checked={applyFee} onChange={(event) => setApplyFee(event.target.checked)} />
        </label>
        <button type="submit" className="primary" disabled={busy} data-testid="create-reminder">
          {busy ? t('creating') : t('createReminder')}
        </button>
      </form>
      {current && (
        <div data-testid="reminder-preview">
          <strong>{t('preview')}</strong>
          <p>
            {t('invoice')}: {invoice.invoice_number} · {t('openBalance')}: {moneyFixed(current.amount_due)} ·{' '}
            {t('reminderFee')}: {moneyFixed(current.fee_amount)} · {t('lateInterest')}: {moneyFixed(current.interest_amount)}
          </p>
          <button type="button" className="primary" onClick={() => void send()} disabled={busy} data-testid="send-reminder">
            {busy ? t('sending') : t('sendReminder')}
          </button>
        </div>
      )}
      {history.length > 0 && (
        <div data-testid="reminder-history">
          <strong>{t('history') ?? 'Reminders'}</strong>
          {history.map((row) => (
            <p key={row.id}>
              {row.reminder_number ?? row.level} · {row.created_at} · {row.recipient ?? ''} · {row.status} · fee {moneyFixed(row.fee_amount)} · interest {moneyFixed(row.interest_amount)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function DeliveryPanel({ invoice, tenantId, csrf, headers, onChanged }: PanelProps & { invoice: any }) {
  const { t } = useI18n();
  const [recipient, setRecipient] = useState(String(invoice.customer_snapshot?.email ?? ''));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [einvoice, setEinvoice] = useState<any>(null);

  const loadHistory = async () => {
    const result = await api<{ history: any[] }>(
      `/api/v1/sales/send-history?document_type=${encodeURIComponent(invoice.document_type ?? 'SALES_INVOICE')}&document_id=${invoice.id}`,
      { headers },
    );
    setHistory(result.history);
  };
  useEffect(() => {
    void loadHistory().catch(() => undefined);
  }, [invoice.id, tenantId]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await api<{ sent: boolean; error?: string }>(`/api/v1/sales/invoices/${invoice.id}/send`, {
        method: 'POST',
        csrf,
        headers,
        body: { recipient, message },
      });
      if (!result.sent) throw new Error(result.error ?? 'Send failed');
      setSuccess(t('invoiceSent'));
      await Promise.all([loadHistory(), onChanged?.()]);
    } catch (cause) {
      setError(t('sendFailed') + ': ' + (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  };

  const exportEinvoice = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ payload: any; history: any; limitation: string }>(
        `/api/v1/sales/invoices/${invoice.id}/e-invoice/export`,
        { method: 'POST', csrf, headers },
      );
      setEinvoice(result);
      setSuccess(result.limitation);
      await loadHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack" data-testid="delivery-panel">
      <Notice error={error} success={success} />
      <form className="form-row" onSubmit={send}>
        <Field label={t('recipient')}>
          <input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} required />
        </Field>
        <Field label={t('subject')}>
          <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t('message')} />
        </Field>
        <button type="submit" className="primary" disabled={busy || invoice.pdf_status !== 'READY'} data-testid="send-invoice">
          {busy ? t('sending') : t('sendInvoice')}
        </button>
        <button type="button" onClick={() => void exportEinvoice()} disabled={busy} data-testid="export-einvoice">
          {t('eInvoiceExport')}
        </button>
      </form>
      {einvoice && (
        <p className="success-text" data-testid="einvoice-result">
          {t('exportReady')}: {einvoice.history.status}
        </p>
      )}
      <div data-testid="delivery-history">
        <strong>{t('deliveryHistory')}</strong>
        {history.length === 0 && <p className="muted">{t('historyEmpty')}</p>}
        {history.map((row) => (
          <p key={row.id}>
            {row.channel} · {row.recipient ?? ''} · {row.status} · {row.created_at} · {row.error ?? ''}
          </p>
        ))}
      </div>
    </div>
  );
}

export function AdvanceAllocationPanel({ invoice, tenantId, headers, onAllocations }: PanelProps & { invoice: any; onAllocations: (rows: Array<{ advance_invoice_id: string; amount: string }>) => void }) {
  const { t } = useI18n();
  const [advances, setAdvances] = useState<any[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  useEffect(() => {
    const load = async () => {
      const list = await api<{ invoices: any[] }>(
        `/api/v1/sales/ledger?document_type=ADVANCE_INVOICE&customer_id=${encodeURIComponent(invoice.customer_id)}&limit=200`,
        { headers },
      );
      const withRemaining = await Promise.all(
        list.invoices.map(async (advance: any) => {
          const state = await api<{ advance_state: any }>(`/api/v1/sales/invoices/${advance.id}/advances`, { headers });
          return { ...advance, ...state.advance_state };
        }),
      );
      setAdvances(withRemaining.filter((advance: any) => Number(advance.remaining ?? 0) > 0));
    };
    void load().catch(() => undefined);
  }, [invoice.id, tenantId]);

  const pushSelections = () => {
    const rows = advances
      .filter((advance) => Number(selections[advance.id] ?? 0) > 0)
      .map((advance) => ({ advance_invoice_id: advance.id, amount: selections[advance.id]! }));
    onAllocations(rows);
  };

  return (
    <div className="card form-stack" data-testid="advance-panel">
      <strong>{t('availableAdvances')}</strong>
      {advances.length === 0 && <p className="muted">{t('historyEmpty')}</p>}
      {advances.map((advance) => (
        <div className="form-row" key={advance.id}>
          <span>{advance.invoice_number} · available {moneyFixed(advance.remaining)}</span>
          <Field label={t('applyAmount')}>
            <input
              type="number"
              min="0"
              max={advance.remaining}
              step="0.01"
              value={selections[advance.id] ?? ''}
              onChange={(event) => setSelections({ ...selections, [advance.id]: event.target.value })}
            />
          </Field>
        </div>
      ))}
      <button type="button" className="primary" onClick={pushSelections} data-testid="apply-advances">
        {t('advanceApplied')}
      </button>
    </div>
  );
}

export function RecurringView(props: PanelProps & { customers: any[] }) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<any[]>([]);
  const [editor, setEditor] = useState<any | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const { tenantId, csrf, headers } = props;

  const load = async () => {
    const result = await api<{ templates: any[] }>('/api/v1/sales/recurring-templates', { headers });
    setTemplates(result.templates);
  };
  useEffect(() => {
    void load().catch(() => undefined);
  }, [tenantId]);

  const generate = async () => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await api<{ generated: any[] }>('/api/v1/sales/recurring-templates/generate', { method: 'POST', csrf, headers });
      setSuccess(`${t('generateDue')}: ${result.generated.length}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (template: any) => {
    try {
      await api(`/api/v1/sales/recurring-templates/${template.id}/${template.is_active ? 'disable' : 'activate'}`, {
        method: 'POST',
        csrf,
        headers,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section data-testid="recurring-panel">
      <Notice error={error} success={success} />
      <button type="button" className="primary" onClick={() => void generate()} disabled={busy} data-testid="generate-due">
        {busy ? t('generating') : t('generateDue')}
      </button>
      <button type="button" onClick={() => setEditor({ name: '', frequency: 'MONTHLY', start_date: new Date().toISOString().slice(0, 10), language: 'fi', payment_terms_days: 14 })}>
        +
      </button>
      {editor && (
        <RecurringEditor
          template={editor}
          tenantId={tenantId}
          csrf={csrf}
          headers={headers}
          customers={props.customers}
          onDone={async () => {
            setEditor(null);
            await load();
          }}
          onError={setError}
        />
      )}
      <table className="data-table" data-testid="recurring-table">
        <thead>
          <tr>
            <th>{t('name')}</th>
            <th>{t('customer')}</th>
            <th>{t('frequency')}</th>
            <th>{t('nextRun')}</th>
            <th>{t('status')}</th>
            <th>{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => (
            <tr key={template.id}>
              <td>{template.name}</td>
              <td>{template.customer_name}</td>
              <td>{template.frequency}</td>
              <td>{template.next_run_date}</td>
              <td>{template.is_active ? t('active') : t('inactive')}</td>
              <td>
                <button type="button" onClick={() => setEditor(template)}>{t('edit')}</button>
                <button type="button" onClick={() => void toggle(template)}>{template.is_active ? t('inactive') : t('active')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {templates.length === 0 && <p className="muted">{t('noRecurring')}</p>}
    </section>
  );
}

function RecurringEditor(props: {
  template: any;
  tenantId: string;
  csrf: string;
  headers: ApiHeaders;
  customers: any[];
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<any>(props.template);
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        customer_id: form.customer_id,
        name: form.name,
        frequency: form.frequency,
        start_date: form.start_date,
        end_date: form.end_date || null,
        language: form.language,
        payment_terms_days: Number(form.payment_terms_days),
        lines: (form.lines ?? []).length
          ? form.lines
          : [{ description: 'Monthly service', quantity: '1', unit_price: '0', tax_code_id: '', discount_percent: '0' }],
      };
      if (props.template.id) {
        await api(`/api/v1/sales/recurring-templates/${props.template.id}`, { method: 'PATCH', csrf: props.csrf, headers: props.headers, body });
      } else {
        await api('/api/v1/sales/recurring-templates', { method: 'POST', csrf: props.csrf, headers: props.headers, body });
      }
      await props.onDone();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card form-stack" onSubmit={save} data-testid="recurring-editor">
      <Field label={t('name')}>
        <input value={form.name ?? ''} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
      </Field>
      <Field label={t('customer')}>
        <select value={form.customer_id ?? ''} onChange={(event) => setForm({ ...form, customer_id: event.target.value })} required>
          <option value="">{t('selectCustomer')}</option>
          {props.customers.map((customer) => (
            <option key={customer.id} value={customer.id}>{customer.name}</option>
          ))}
        </select>
      </Field>
      <Field label={t('frequency')}>
        <select value={form.frequency ?? 'MONTHLY'} onChange={(event) => setForm({ ...form, frequency: event.target.value })}>
          <option value="MONTHLY">MONTHLY</option>
          <option value="QUARTERLY">QUARTERLY</option>
          <option value="YEARLY">YEARLY</option>
        </select>
      </Field>
      <Field label={t('startDate')}>
        <input type="date" value={form.start_date ?? ''} onChange={(event) => setForm({ ...form, start_date: event.target.value })} required />
      </Field>
      <Field label={t('invoiceLanguage')}>
        <select value={form.language ?? 'fi'} onChange={(event) => setForm({ ...form, language: event.target.value })}>
          <option value="fi">FI</option>
          <option value="en">EN</option>
          <option value="et">ET</option>
        </select>
      </Field>
      <button type="submit" className="primary" disabled={busy}>{busy ? t('saving') : t('save')}</button>
    </form>
  );
}

export function AgingView(props: PanelProps & { customers: any[] }) {
  const { t } = useI18n();
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState('');
  const [data, setData] = useState<any>(null);
  const load = async () => {
    const query = new URLSearchParams({ as_of: asOf });
    if (customerId) query.set('customer_id', customerId);
    const result = await api<{ buckets: any[] }>(`/api/v1/sales/aging?${query.toString()}`, { headers: props.headers });
    setData(result);
  };
  useEffect(() => {
    void load().catch(() => undefined);
  }, [asOf, customerId, props.tenantId]);
  return (
    <section data-testid="aging-panel">
      <div className="card form-row">
        <Field label={t('asOfDate')}>
          <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
        </Field>
        <Field label={t('customer')}>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">{t('all')}</option>
            {props.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <table className="data-table" data-testid="aging-table">
        <thead>
          <tr>
            <th>{t('total')}</th>
            <th>{t('status')}</th>
          </tr>
        </thead>
        <tbody>
          {(data?.buckets ?? []).map((bucket: any) => (
            <tr key={bucket.bucket}>
              <td className="num">{moneyFixed(bucket.amount)}</td>
              <td>{t(bucketLabelKey(bucket.bucket) as any)} ({bucket.count})</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function bucketLabelKey(bucket: string): string {
  switch (bucket) {
    case 'NOT_DUE': return 'bucketNotDue';
    case '1_7': return 'bucket1_7';
    case '8_30': return 'bucket8_30';
    case '31_60': return 'bucket31_60';
    case '61_90': return 'bucket61_90';
    case 'OVER_90': return 'bucketOver90';
    default: return 'bucketNotDue';
  }
}

export function StatementView(props: PanelProps & { customers: any[] }) {
  const { t } = useI18n();
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<any>(null);
  const load = async () => {
    if (!customerId) return;
    const query = new URLSearchParams();
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const result = await api<{ statement: any }>(`/api/v1/sales/customers/${customerId}/statement?${query.toString()}`, { headers: props.headers });
    setData(result.statement);
  };
  useEffect(() => {
    if (customerId) void load().catch(() => undefined);
  }, [customerId, from, to, props.tenantId]);
  return (
    <section data-testid="statement-panel">
      <div className="card form-row">
        <Field label={t('customer')}>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">{t('selectCustomer')}</option>
            {props.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('dateFrom')}>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label={t('dateTo')}>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
      </div>
      {data && (
        <>
          <table className="data-table" data-testid="statement-table">
            <thead>
              <tr>
                <th>{t('date')}</th>
                <th>{t('description')}</th>
                <th>{t('debit') ?? 'Debit'}</th>
                <th>{t('credit')}</th>
                <th>{t('runningBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {(data.lines ?? []).map((line: any, index: number) => (
                <tr key={`${line.date}-${index}`}>
                  <td>{line.date}</td>
                  <td>{line.description}</td>
                  <td className="num">{moneyFixed(line.debit)}</td>
                  <td className="num">{moneyFixed(line.credit)}</td>
                  <td className="num">{moneyFixed(line.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {t('openBalance')}: <strong>{moneyFixed(data.open_balance)}</strong>
          </p>
        </>
      )}
    </section>
  );
}

export function OverdueView(props: PanelProps & { onOpenInvoice: (id: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const load = async () => {
      const result = await api<{ invoices: any[] }>('/api/v1/sales/ledger?overdue=true&limit=200', { headers: props.headers });
      setRows(result.invoices);
    };
    void load().catch(() => undefined);
  }, [props.tenantId]);
  return (
    <section data-testid="overdue-panel">
      <table className="data-table" data-testid="overdue-table">
        <thead>
          <tr>
            <th>{t('invoice')}</th>
            <th>{t('customer')}</th>
            <th>{t('dueDate')}</th>
            <th>{t('openBalance')}</th>
            <th>{t('status')}</th>
            <th>{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="mono">{row.invoice_number}</td>
              <td>{row.customer_name}</td>
              <td>{row.due_date}</td>
              <td className="num">{moneyFixed(row.open_balance)}</td>
              <td>{row.payment_status}</td>
              <td>
                <button type="button" onClick={() => props.onOpenInvoice(row.id)}>{t('openInvoice')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">{t('noOverdue')}</p>}
    </section>
  );
}
