import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';
import { translations } from '../i18n/translations';
import { sumMoney } from '../lib/money';
import type { TaxCodeView } from '../lib/tax';

type Tab = 'journals' | 'opening' | 'chart' | 'periods' | 'reports' | 'vat';

interface JournalLine {
  id: number;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

interface JournalEntry {
  id: string;
  entry_number: string | null;
  business_date: string;
  document_date: string | null;
  description: string;
  status: string;
  currency_code: string;
  source_type: string;
  source_id: string | null;
  reversal_of_entry_id: string | null;
  reversed_by_entry_id: string | null;
  posted_at: string | null;
  lines?: Array<{
    account_code: string;
    account_name: string;
    description: string | null;
    debit: string;
    credit: string;
    cost_center: string | null;
    project_code: string | null;
  }>;
}

interface AccountItem {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
  is_active: boolean;
}

interface PeriodItem {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  reopen_reason?: string | null;
}

interface TrialRow {
  code: string;
  name: string;
  debit_balance: string;
  credit_balance: string;
}

interface LedgerRow {
  entry_number: string | null;
  business_date: string;
  description: string;
  account_code: string;
  debit: string;
  credit: string;
}

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;

export function AccountingPage() {
  const { t, language } = useI18n();
  const { csrf } = useAuth();
  const [tenantId, setTenantId] = useState('');
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [tab, setTab] = useState<Tab>('journals');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [periods, setPeriods] = useState<PeriodItem[]>([]);
  const [trial, setTrial] = useState<{ rows: TrialRow[]; totals: { debit: string; credit: string }; balanced: boolean } | null>(null);
  const [ledger, setLedger] = useState<{ rows: LedgerRow[]; summary: { debit: string; credit: string } } | null>(null);

  const [lineCounter, setLineCounter] = useState(2);
  const [lines, setLines] = useState<JournalLine[]>([
    { id: 1, accountId: '', debit: '', credit: '', description: '' },
    { id: 2, accountId: '', debit: '', credit: '', description: '' },
  ]);
  const [journalDetail, setJournalDetail] = useState<JournalEntry | null>(null);
  const [accountFilter, setAccountFilter] = useState('');
  const [openingEntries, setOpeningEntries] = useState<JournalEntry[]>([]);
  const [openingDate, setOpeningDate] = useState('');
  const [openingNote, setOpeningNote] = useState('');
  const [openingCounter, setOpeningCounter] = useState(2);
  const [openingLines, setOpeningLines] = useState<JournalLine[]>([
    { id: 1, accountId: '', debit: '', credit: '', description: '' },
    { id: 2, accountId: '', debit: '', credit: '', description: '' },
  ]);
  const [businessDate, setBusinessDate] = useState('');
  const [description, setDescription] = useState('');
  const [reverseFor, setReverseFor] = useState('');
  const [reverseReason, setReverseReason] = useState('');
  const [reopenFor, setReopenFor] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<string>('ASSET');
  const [asOf, setAsOf] = useState('');
  const [vatPeriodId, setVatPeriodId] = useState('');
  const [vatSummaryData, setVatSummaryData] = useState<any>(null);
  const [taxCodeRows, setTaxCodeRows] = useState<TaxCodeView[]>([]);

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

  const loadJournals = async () => {
    const result = await api<{ journals: JournalEntry[] }>('/api/v1/journals?limit=100', { headers });
    setJournals(result.journals);
  };

  const loadAccounts = async () => {
    const result = await api<{ accounts: AccountItem[] }>('/api/v1/accounts', { headers });
    setAccounts(result.accounts);
  };

  const loadPeriods = async () => {
    const result = await api<{ periods: PeriodItem[] }>('/api/v1/accounting-periods', { headers });
    setPeriods(result.periods);
  };

  const loadOpeningBalances = async () => {
    const result = await api<{ journals: JournalEntry[] }>(
      '/api/v1/journals?source_type=OPENING_BALANCE&limit=100',
      { headers },
    );
    setOpeningEntries(result.journals);
  };

  const openJournalDetail = async (journalId: string) => {
    await run(async () => {
      const result = await api<{ journal: JournalEntry }>(`/api/v1/journals/${journalId}`, { headers });
      setJournalDetail(result.journal);
    });
  };

  const loadReports = async () => {
    const query = asOf ? `?as_of=${asOf}` : '';
    const [trialResult, ledgerResult] = await Promise.all([
      api<any>(`/api/v1/reports/trial-balance${query}`, { headers }),
      api<any>('/api/v1/ledger?limit=100', { headers }),
    ]);
    setTrial(trialResult);
    setLedger({ rows: ledgerResult.ledger as LedgerRow[], summary: ledgerResult.summary });
  };

  const loadVatPanel = async () => {
    let available = periods;
    if (available.length === 0) {
      const periodResult = await api<{ periods: PeriodItem[] }>('/api/v1/accounting-periods', { headers });
      available = periodResult.periods;
      setPeriods(available);
    }
    const period = available.find((item) => item.id === vatPeriodId) ?? available[0];
    const [taxResult, summaryResult] = await Promise.all([
      api<{ tax_codes: TaxCodeView[] }>('/api/v1/tax-codes', { headers }),
      period
        ? api<any>(
            `/api/v1/vat-summary?from=${String(period.start_date).slice(0, 10)}&to=${String(period.end_date).slice(0, 10)}`,
            { headers },
          )
        : Promise.resolve({ summary: null }),
    ]);
    setTaxCodeRows(taxResult.tax_codes);
    setVatSummaryData(summaryResult.summary);
  };

  useEffect(() => {
    void loadTenants().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    void run(async () => {
      if (tab === 'journals') {
        await Promise.all([loadJournals(), loadAccounts()]);
      }
      else if (tab === 'opening') {
        await Promise.all([loadAccounts(), loadOpeningBalances()]);
      }
      else if (tab === 'chart') await loadAccounts();
      else if (tab === 'periods') await loadPeriods();
      else if (tab === 'reports') await loadReports();
      else await loadVatPanel();
    });
  }, [tenantId, tab]);

  if (!tenantId) {
    return (
      <div className="workspace-page accounting-page" data-testid="accounting-page">
        <h2 className="page-title">{t('accounting')}</h2>
        <p className="muted">{t('loading')}</p>
      </div>
    );
  }

  const addLine = () => {
    setLineCounter((value) => value + 1);
    setLines((current) => [
      ...current,
      { id: lineCounter + 1, accountId: '', debit: '', credit: '', description: '' },
    ]);
  };

  const updateLine = (id: number, patch: Partial<JournalLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const removeLine = (id: number) => {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((line) => line.id !== id));
  };

  const addOpeningLine = () => {
    setOpeningCounter((value) => value + 1);
    setOpeningLines((current) => [
      ...current,
      { id: openingCounter + 1, accountId: '', debit: '', credit: '', description: '' },
    ]);
  };

  const updateOpeningLine = (id: number, patch: Partial<JournalLine>) => {
    setOpeningLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  };

  const removeOpeningLine = (id: number) => {
    if (openingLines.length <= 2) return;
    setOpeningLines((current) => current.filter((line) => line.id !== id));
  };

  const createEntry = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await api('/api/v1/journals', {
        method: 'POST',
        csrf,
        headers,
        body: {
          business_date: businessDate,
          description,
          currency_code: 'EUR',
          lines: lines.map((line) => ({
            account_id: line.accountId,
            debit: line.debit || '0',
            credit: line.credit || '0',
            description: line.description || undefined,
          })),
        },
      });
      setMessage(t('entryCreated'));
      await loadJournals();
    }, 'entryCreated');
  };

  const submitOpeningBalances = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.confirm(t('openingBalanceConfirm'))) return;
    await run(async () => {
      await api('/api/v1/opening-balances', {
        method: 'POST',
        csrf,
        headers,
        body: {
          business_date: openingDate,
          note: openingNote || undefined,
          lines: openingLines.map((line) => ({
            account_id: line.accountId,
            debit: line.debit || '0',
            credit: line.credit || '0',
            description: line.description || undefined,
          })),
        },
      });
      setOpeningDate('');
      setOpeningNote('');
      setOpeningLines([
        { id: 1, accountId: '', debit: '', credit: '', description: '' },
        { id: 2, accountId: '', debit: '', credit: '', description: '' },
      ]);
      await loadOpeningBalances();
    }, 'openingBalanceCreated');
  };

  const postEntry = (id: string) =>
    run(async () => {
      await api(`/api/v1/journals/${id}/post`, { method: 'POST', csrf, headers });
      await loadJournals();
    }, 'entryPosted');

  const reverseEntry = (id: string) =>
    run(async () => {
      await api(`/api/v1/journals/${id}/reverse`, {
        method: 'POST',
        csrf,
        headers,
        body: { reason: reverseReason },
      });
      setReverseFor('');
      setReverseReason('');
      await loadJournals();
    }, 'entryReversed');

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await api('/api/v1/accounts', {
        method: 'POST',
        csrf,
        headers,
        body: { code: newCode, name: newName, type: newType },
      });
      setNewCode('');
      setNewName('');
      await loadAccounts();
    }, 'accountCreated');
  };

  const toggleAccount = (account: AccountItem) =>
    run(async () => {
      await api(`/api/v1/accounts/${account.id}`, {
        method: 'PATCH',
        csrf,
        headers,
        body: { is_active: !account.is_active },
      });
      await loadAccounts();
    });

  const closePeriod = (id: string, status: 'SOFT_CLOSED' | 'CLOSED') =>
    run(async () => {
      if (!window.confirm(t(status === 'CLOSED' ? 'periodCloseConfirm' : 'periodCloseConfirm'))) return;
      await api(`/api/v1/accounting-periods/${id}`, {
        method: 'PATCH',
        csrf,
        headers,
        body: { status },
      });
      await loadPeriods();
    }, 'periodClosed');

  const reopenPeriod = (id: string) =>
    run(async () => {
      if (!window.confirm(t('periodReopenConfirm'))) return;
      await api(`/api/v1/accounting-periods/${id}/reopen`, {
        method: 'POST',
        csrf,
        headers,
        body: { reason: reopenReason },
      });
      setReopenFor('');
      setReopenReason('');
      await loadPeriods();
    }, 'periodReopened');

  const runReports = () => run(loadReports);

  const journalTotals = (entry: JournalEntry) => {
    const linesList = entry.lines ?? [];
    const debit = sumMoney(linesList.map((line) => line.debit));
    const credit = sumMoney(linesList.map((line) => line.credit));
    return { debit, credit };
  };

  const draftTotals = () => {
    const debit = sumMoney(lines.map((line) => line.debit || '0'));
    const credit = sumMoney(lines.map((line) => line.credit || '0'));
    return { debit, credit };
  };

  const openingTotals = () => {
    const debit = sumMoney(openingLines.map((line) => line.debit || '0'));
    const credit = sumMoney(openingLines.map((line) => line.credit || '0'));
    return { debit, credit };
  };

  const statusLabel = (status: string) => status.toLowerCase();
  const vatTreatmentLabels: Record<string, string> = translations[language].vatTreatment as unknown as Record<string, string>;
  const vatClassLabels: Record<string, string> = translations[language].vatClass as unknown as Record<string, string>;

  const sourceLabel = (sourceType: string) => {
    const keys: Record<string, string> = {
      MANUAL: 'sourceManual',
      SALES_INVOICE: 'sourceSalesInvoice',
      SALES_CREDIT_NOTE: 'sourceSalesCreditNote',
      PURCHASE_INVOICE: 'sourcePurchaseInvoice',
      PURCHASE_CORRECTION: 'sourcePurchaseCorrection',
      JOURNAL_REVERSAL: 'sourceJournalReversal',
      OPENING_BALANCE: 'sourceOpeningBalance',
    };
    const key = keys[sourceType];
    return key ? t(key as any) : sourceType;
  };

  const difference = (debit: string, credit: string) => {
    const debitCents = Math.round(Number(debit) * 100);
    const creditCents = Math.round(Number(credit) * 100);
    return ((debitCents - creditCents) / 100).toFixed(2);
  };

  const visibleAccounts = accounts.filter(
    (account) =>
      !accountFilter ||
      `${account.code} ${account.name}`.toLowerCase().includes(accountFilter.toLowerCase()),
  );

  return (
    <div className="workspace-page accounting-page" data-testid="accounting-page">
      <h2 className="page-title">{t('accounting')}</h2>
      <label className="field">
        <span>{t('tenantSwitcher')}</span>
        <select
          value={tenantId}
          onChange={(event) => {
            setTenantId(event.target.value);
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

      <nav className="tab-bar" aria-label={t('accounting')}>
        {(
          [
            ['journals', 'journalEntries'],
            ['opening', 'openingBalances'],
            ['chart', 'chartOfAccounts'],
            ['periods', 'periods'],
            ['reports', 'reports'],
            ['vat', 'vatSummary'],
          ] as Array<[Tab, string]>
        ).map(([key, labelKey]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'tab-button active' : 'tab-button'}
            data-testid={`tab-${key}`}
            onClick={() => setTab(key)}
          >
            {t(labelKey as any)}
          </button>
        ))}
      </nav>

      {tab === 'journals' && (
        <section data-testid="journals-panel">
          <details>
            <summary>{t('newEntry')}</summary>
            <form className="card form-stack" onSubmit={createEntry}>
              <label className="field">
                <span>{t('businessDate')}</span>
                <input
                  type="date"
                  value={businessDate}
                  onChange={(event) => setBusinessDate(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>{t('description')}</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>
              <label className="field">
                <span>{t('accountSearch')}</span>
                <input
                  value={accountFilter}
                  onChange={(event) => setAccountFilter(event.target.value)}
                  placeholder={t('accountSearch')}
                />
              </label>
              {lines.map((line) => (
                <div className="entry-line-row" key={line.id}>
                  <select
                    aria-label={`${t('account')} ${line.id}`}
                    value={line.accountId}
                    onChange={(event) => updateLine(line.id, { accountId: event.target.value })}
                  >
                    <option value="">{t('accountCode')}</option>
                    {visibleAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={t('debit')}
                    value={line.debit}
                    onChange={(event) => updateLine(line.id, { debit: event.target.value })}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={t('credit')}
                    value={line.credit}
                    onChange={(event) => updateLine(line.id, { credit: event.target.value })}
                  />
                  <input
                    placeholder={t('description')}
                    value={line.description}
                    onChange={(event) => updateLine(line.id, { description: event.target.value })}
                  />
                  <button type="button" onClick={() => removeLine(line.id)}>
                    ×
                  </button>
                </div>
              ))}
              <div className="form-row">
                <span>
                  {t('debitTotal')}: {draftTotals().debit}
                </span>
                <span>
                  {t('creditTotal')}: {draftTotals().credit}
                </span>
                <span>
                  {t('difference')}: {difference(draftTotals().debit, draftTotals().credit)}
                </span>
              </div>
              <div>
                <button type="button" onClick={addLine}>
                  +
                </button>
                <button type="submit" className="primary">
                  {t('create')}
                </button>
              </div>
            </form>
          </details>

          <div className="table-scroll">
            <table className="data-table" data-testid="journals-table">
              <thead>
                <tr>
                  <th>{t('entryNumber')}</th>
                  <th>{t('businessDate')}</th>
                  <th>{t('description')}</th>
                  <th>{t('source')}</th>
                  <th>{t('status')}</th>
                  <th>{t('debit')}</th>
                  <th>{t('credit')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {journals.map((entry) => {
                  const totals = journalTotals(entry);
                  const balanced = totals.debit === totals.credit;
                  return (
                    <tr key={entry.id}>
                      <td className="mono">{entry.entry_number ?? '–'}</td>
                      <td>{entry.business_date}</td>
                      <td>{entry.description}</td>
                      <td>{sourceLabel(entry.source_type)}</td>
                      <td>{t(statusLabel(entry.status) as any)}</td>
                      <td className="num">{totals.debit}</td>
                      <td className="num">{totals.credit}</td>
                      <td>
                        <button type="button" onClick={() => void openJournalDetail(entry.id)}>
                          {t('viewDetail')}
                        </button>
                        {entry.status === 'DRAFT' && (
                          <button
                            type="button"
                            className="primary"
                            disabled={!balanced}
                            onClick={() => void postEntry(entry.id)}
                          >
                            {t('post')}
                          </button>
                        )}
                        {entry.status === 'POSTED' && (
                          <>
                            <button type="button" onClick={() => setReverseFor(entry.id)}>
                              {t('reverse')}
                            </button>
                            {reverseFor === entry.id && (
                              <span className="inline-actions">
                                <input
                                  value={reverseReason}
                                  placeholder={t('reason')}
                                  onChange={(event) => setReverseReason(event.target.value)}
                                />
                                <button type="button" onClick={() => void reverseEntry(entry.id)}>
                                  {t('confirm')}
                                </button>
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {journals.length === 0 && <p data-testid="journals-empty" className="muted">{t('noJournals')}</p>}
          {journalDetail && (
            <details className="card form-stack" open data-testid="journal-detail">
              <summary>{t('journalDetailTitle')}</summary>
              <p>
                {t('entryNumber')}: <span className="mono">{journalDetail.entry_number ?? '–'}</span> ·{' '}
                {t('businessDate')}: {journalDetail.business_date} · {t('status')}:{' '}
                {t(statusLabel(journalDetail.status) as any)}
              </p>
              <p>
                {t('source')}: {sourceLabel(journalDetail.source_type)}
                {journalDetail.source_id ? ` · ${journalDetail.source_id}` : ''}
                {journalDetail.reversal_of_entry_id
                  ? ` · ${t('sourceJournalReversal')}: ${journalDetail.reversal_of_entry_id}`
                  : ''}
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('accountCode')}</th>
                      <th>{t('accountName')}</th>
                      <th>{t('description')}</th>
                      <th>{t('debit')}</th>
                      <th>{t('credit')}</th>
                      <th>{t('costCenter')}</th>
                      <th>{t('projectCode')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(journalDetail.lines ?? []).map((line, index) => (
                      <tr key={index}>
                        <td className="mono">{line.account_code}</td>
                        <td>{line.account_name}</td>
                        <td>{line.description ?? ''}</td>
                        <td className="num">{line.debit}</td>
                        <td className="num">{line.credit}</td>
                        <td>{line.cost_center ?? ''}</td>
                        <td>{line.project_code ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      )}

      {tab === 'opening' && (
        <section data-testid="opening-panel">
          <details>
            <summary>{t('openingBalances')}</summary>
            <form className="card form-stack" data-testid="opening-form" onSubmit={submitOpeningBalances}>
              <div className="form-row">
                <label className="field">
                  <span>{t('businessDate')}</span>
                  <input
                    type="date"
                    value={openingDate}
                    onChange={(event) => setOpeningDate(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>{t('openingNote')}</span>
                  <input
                    value={openingNote}
                    onChange={(event) => setOpeningNote(event.target.value)}
                    placeholder={t('openingNote')}
                  />
                </label>
              </div>
              {openingLines.map((line) => (
                <div className="entry-line-row" key={line.id}>
                  <select
                    aria-label={`${t('account')} ${line.id}`}
                    value={line.accountId}
                    onChange={(event) => updateOpeningLine(line.id, { accountId: event.target.value })}
                  >
                    <option value="">{t('accountCode')}</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={t('debit')}
                    value={line.debit}
                    onChange={(event) => updateOpeningLine(line.id, { debit: event.target.value })}
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={t('credit')}
                    value={line.credit}
                    onChange={(event) => updateOpeningLine(line.id, { credit: event.target.value })}
                  />
                  <input
                    placeholder={t('description')}
                    value={line.description}
                    onChange={(event) => updateOpeningLine(line.id, { description: event.target.value })}
                  />
                  <button type="button" onClick={() => removeOpeningLine(line.id)}>
                    ×
                  </button>
                </div>
              ))}
              <div className="form-row">
                <span>
                  {t('debitTotal')}: {openingTotals().debit}
                </span>
                <span>
                  {t('creditTotal')}: {openingTotals().credit}
                </span>
                <span>
                  {t('difference')}: {difference(openingTotals().debit, openingTotals().credit)}
                </span>
              </div>
              <div>
                <button type="button" onClick={addOpeningLine}>
                  +
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={openingTotals().debit !== openingTotals().credit}
                  data-testid="save-opening-balances"
                >
                  {t('openingBalances')}
                </button>
              </div>
            </form>
          </details>
          <div className="table-scroll">
            <table className="data-table" data-testid="opening-table">
              <thead>
                <tr>
                  <th>{t('entryNumber')}</th>
                  <th>{t('businessDate')}</th>
                  <th>{t('description')}</th>
                  <th>{t('status')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {openingEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.entry_number ?? '–'}</td>
                    <td>{entry.business_date}</td>
                    <td>{entry.description}</td>
                    <td>{t(statusLabel(entry.status) as any)}</td>
                    <td>
                      <button type="button" onClick={() => void openJournalDetail(entry.id)}>
                        {t('viewDetail')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {openingEntries.length === 0 && <p className="muted">{t('noJournals')}</p>}
        </section>
      )}

      {tab === 'chart' && (
        <section data-testid="chart-panel">
          <form className="card form-row" onSubmit={createAccount}>
            <label className="field">
              <span>{t('accountCode')}</span>
              <input value={newCode} onChange={(event) => setNewCode(event.target.value)} required />
            </label>
            <label className="field">
              <span>{t('accountName')}</span>
              <input value={newName} onChange={(event) => setNewName(event.target.value)} required />
            </label>
            <label className="field">
              <span>{t('accountType')}</span>
              <select value={newType} onChange={(event) => setNewType(event.target.value)}>
                {ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary">
              {t('newAccount')}
            </button>
          </form>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('accountCode')}</th>
                  <th>{t('accountName')}</th>
                  <th>{t('accountType')}</th>
                  <th>{t('normalBalance')}</th>
                  <th>{t('status')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td className="mono">{account.code}</td>
                    <td>{account.name}</td>
                    <td>{account.type}</td>
                    <td>{account.normal_balance}</td>
                    <td>{account.is_active ? t('active') : t('inactive')}</td>
                    <td>
                      <button type="button" onClick={() => void toggleAccount(account)}>
                        {account.is_active ? t('deactivate') : t('activate')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {accounts.length === 0 && <p className="muted">{t('noAccounts')}</p>}
        </section>
      )}

      {tab === 'periods' && (
        <section data-testid="periods-panel">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('periodName')}</th>
                  <th>{t('startDate')}</th>
                  <th>{t('endDate')}</th>
                  <th>{t('status')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.id}>
                    <td>{period.name}</td>
                    <td>{period.start_date}</td>
                    <td>{period.end_date}</td>
                    <td>{t(statusLabel(period.status) as any)}</td>
                    <td>
                      {period.status === 'OPEN' && (
                        <>
                          <button type="button" onClick={() => void closePeriod(period.id, 'SOFT_CLOSED')}>
                            {t('softClose')}
                          </button>
                          <button type="button" onClick={() => void closePeriod(period.id, 'CLOSED')}>
                            {t('close')}
                          </button>
                        </>
                      )}
                      {period.status !== 'OPEN' && (
                        <>
                          <button type="button" onClick={() => setReopenFor(period.id)}>
                            {t('reopen')}
                          </button>
                          {reopenFor === period.id && (
                            <span className="inline-actions">
                              <input
                                value={reopenReason}
                                placeholder={t('reason')}
                                onChange={(event) => setReopenReason(event.target.value)}
                              />
                              <button type="button" onClick={() => void reopenPeriod(period.id)}>
                                {t('confirm')}
                              </button>
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {periods.length === 0 && <p className="muted">{t('noPeriods')}</p>}
        </section>
      )}

      {tab === 'reports' && (
        <section data-testid="reports-panel">
          <div className="form-row">
            <label className="field">
              <span>{t('asOf')}</span>
              <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
            </label>
            <button type="button" className="primary" onClick={() => void runReports()}>
              {t('refresh')}
            </button>
          </div>
          <h3>{t('trialBalance')}</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('accountCode')}</th>
                <th>{t('accountName')}</th>
                <th>{t('debit')}</th>
                <th>{t('credit')}</th>
              </tr>
            </thead>
            <tbody>
              {(trial?.rows ?? []).map((row) => (
                <tr key={row.code}>
                  <td className="mono">{row.code}</td>
                  <td>{row.name}</td>
                  <td className="num">{Number(row.debit_balance).toFixed(2)}</td>
                  <td className="num">{Number(row.credit_balance).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{t('totals')}</td>
                <td className="num">{trial ? Number(trial.totals.debit).toFixed(2) : ''}</td>
                <td className="num">{trial ? Number(trial.totals.credit).toFixed(2) : ''}</td>
              </tr>
            </tfoot>
          </table>
          {trial && (
            <p className={trial.balanced ? 'ok-text' : 'error-text'}>
              {trial.balanced ? t('balanced') : t('unbalanced')}
            </p>
          )}
          <h3>{t('ledger')}</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('entryNumber')}</th>
                <th>{t('businessDate')}</th>
                <th>{t('description')}</th>
                <th>{t('accountCode')}</th>
                <th>{t('debit')}</th>
                <th>{t('credit')}</th>
              </tr>
            </thead>
            <tbody>
              {(ledger?.rows ?? []).map((row, index) => (
                <tr key={`${row.entry_number}-${index}`}>
                  <td className="mono">{row.entry_number ?? ''}</td>
                  <td>{row.business_date}</td>
                  <td>{row.description}</td>
                  <td className="mono">{row.account_code}</td>
                  <td className="num">{Number(row.debit).toFixed(2)}</td>
                  <td className="num">{Number(row.credit).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'vat' && (
        <section data-testid="vat-panel">
          <div className="form-row">
            <label className="field">
              <span>{t('period')}</span>
              <select
                data-testid="vat-period-select"
                value={vatPeriodId}
                onChange={(event) => setVatPeriodId(event.target.value)}
              >
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.name} ({period.start_date} – {period.end_date})
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="primary" data-testid="vat-refresh" onClick={() => void run(loadVatPanel)}>
              {t('refresh')}
            </button>
          </div>

          <h3>{t('vatSummary')}</h3>
          <div className="table-scroll">
            <table className="data-table" data-testid="vat-summary-table">
              <thead>
                <tr>
                  <th>{t('classification')}</th>
                  <th>{t('salesAmount')}</th>
                  <th>{t('purchaseAmount')}</th>
                  <th>{t('outputVat')}</th>
                  <th>{t('inputVat')}</th>
                  <th>{t('netVat')}</th>
                </tr>
              </thead>
              <tbody>
                {(vatSummaryData?.rows ?? []).map((row: any) => (
                  <tr key={row.classification}>
                    <td>{vatClassLabels[row.classification] ?? row.classification}</td>
                    <td className="num">{Number(row.sales_amount).toFixed(2)}</td>
                    <td className="num">{Number(row.purchase_amount).toFixed(2)}</td>
                    <td className="num">{Number(row.output_amount).toFixed(2)}</td>
                    <td className="num">{Number(row.input_amount).toFixed(2)}</td>
                    <td className="num">{Number(row.vat_amount).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {vatSummaryData && (
            <p data-testid="vat-summary-totals">
              {t('outputVat')}: {Number(vatSummaryData.totals.output_amount).toFixed(2)} · {t('inputVat')}:{' '}
              {Number(vatSummaryData.totals.input_amount).toFixed(2)} · {t('netVat')}:{' '}
              <strong>{Number(vatSummaryData.totals.vat_amount).toFixed(2)}</strong>
            </p>
          )}

          <h3>{t('taxCodes')}</h3>
          <div className="table-scroll">
            <table className="data-table" data-testid="tax-codes-table">
              <thead>
                <tr>
                  <th>{t('taxCode')}</th>
                  <th>{t('taxName')}</th>
                  <th>{t('taxRate')}</th>
                  <th>{t('taxTreatment')}</th>
                  <th>{t('direction')}</th>
                  <th>{t('validFrom')}</th>
                  <th>{t('validTo')}</th>
                  <th>{t('deductibility')}</th>
                  <th>{t('status')}</th>
                  <th>{t('systemCode')}</th>
                </tr>
              </thead>
              <tbody>
                {taxCodeRows.map((code) => (
                  <tr key={code.id}>
                    <td className="mono">{code.code}</td>
                    <td>{code.name}</td>
                    <td className="num">{Number(code.rate)}%</td>
                    <td>{vatTreatmentLabels[code.treatment] ?? code.treatment}</td>
                    <td>{code.direction}</td>
                    <td>{code.effective_from}</td>
                    <td>{code.effective_to ?? '–'}</td>
                    <td className="num">{Number(code.deductible_percent ?? 100)}%</td>
                    <td>{code.is_active ? t('active') : t('inactive')}</td>
                    <td>{code.is_system ? t('yes') : t('no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
