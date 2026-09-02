import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';

type Tab = 'journals' | 'chart' | 'periods' | 'reports';

interface JournalLine {
  id: number;
  accountId: string;
  debit: string;
  credit: string;
}

interface JournalEntry {
  id: string;
  entry_number: string | null;
  business_date: string;
  description: string;
  status: string;
  currency_code: string;
  posted_at: string | null;
  lines?: Array<{ account_code: string; debit: string; credit: string }>;
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
  const { t } = useI18n();
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
    { id: 1, accountId: '', debit: '', credit: '' },
    { id: 2, accountId: '', debit: '', credit: '' },
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

  const loadReports = async () => {
    const query = asOf ? `?as_of=${asOf}` : '';
    const [trialResult, ledgerResult] = await Promise.all([
      api<any>(`/api/v1/reports/trial-balance${query}`, { headers }),
      api<any>('/api/v1/ledger?limit=100', { headers }),
    ]);
    setTrial(trialResult);
    setLedger({ rows: ledgerResult.ledger as LedgerRow[], summary: ledgerResult.summary });
  };

  useEffect(() => {
    void loadTenants().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    void run(async () => {
      if (tab === 'journals') await loadJournals();
      else if (tab === 'chart') await loadAccounts();
      else if (tab === 'periods') await loadPeriods();
      else await loadReports();
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
      { id: lineCounter + 1, accountId: '', debit: '', credit: '' },
    ]);
  };

  const updateLine = (id: number, patch: Partial<JournalLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const removeLine = (id: number) => {
    if (lines.length <= 2) return;
    setLines((current) => current.filter((line) => line.id !== id));
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
          })),
        },
      });
      setMessage(t('entryCreated'));
      await loadJournals();
    }, 'entryCreated');
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

  const closePeriod = (id: string, status: 'SOFT_CLOSED' | 'CLOSED') =>
    run(async () => {
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
    const debit = linesList.reduce((sum, line) => sum + Number(line.debit), 0);
    const credit = linesList.reduce((sum, line) => sum + Number(line.credit), 0);
    return { debit, credit };
  };

  const statusLabel = (status: string) => status.toLowerCase();

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
            ['chart', 'chartOfAccounts'],
            ['periods', 'periods'],
            ['reports', 'reports'],
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
              {lines.map((line) => (
                <div className="entry-line-row" key={line.id}>
                  <select
                    aria-label={`${t('account')} ${line.id}`}
                    value={line.accountId}
                    onChange={(event) => updateLine(line.id, { accountId: event.target.value })}
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
                  <button type="button" onClick={() => removeLine(line.id)}>
                    ×
                  </button>
                </div>
              ))}
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

          <table className="data-table" data-testid="journals-table">
            <thead>
              <tr>
                <th>{t('entryNumber')}</th>
                <th>{t('businessDate')}</th>
                <th>{t('description')}</th>
                <th>{t('status')}</th>
                <th>{t('debit')}</th>
                <th>{t('credit')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {journals.map((entry) => {
                const totals = journalTotals(entry);
                return (
                  <tr key={entry.id}>
                    <td className="mono">{entry.entry_number ?? '–'}</td>
                    <td>{entry.business_date}</td>
                    <td>{entry.description}</td>
                    <td>{t(statusLabel(entry.status) as any)}</td>
                    <td className="num">{totals.debit.toFixed(2)}</td>
                    <td className="num">{totals.credit.toFixed(2)}</td>
                    <td>
                      {entry.status === 'DRAFT' && (
                        <button type="button" className="primary" onClick={() => void postEntry(entry.id)}>
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
          {journals.length === 0 && <p data-testid="journals-empty" className="muted">{t('noJournals')}</p>}
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
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('accountCode')}</th>
                <th>{t('accountName')}</th>
                <th>{t('accountType')}</th>
                <th>{t('normalBalance')}</th>
                <th>{t('status')}</th>
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
                </tr>
              ))}
            </tbody>
          </table>
          {accounts.length === 0 && <p className="muted">{t('noAccounts')}</p>}
        </section>
      )}

      {tab === 'periods' && (
        <section data-testid="periods-panel">
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
    </div>
  );
}
