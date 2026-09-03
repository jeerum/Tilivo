import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../auth/api';
import { useI18n } from '../i18n/I18nContext';
import {
  searchBusinessRegistry,
  type RegistryCompany,
  type RegistryCompanyStatus,
} from '../lib/businessRegistry';

interface BusinessRegistrySearchProps {
  csrf: string;
  headers?: Record<string, string>;
  onCompany: (company: RegistryCompany) => void;
}

const STATUS_KEYS: Record<RegistryCompanyStatus, string> = {
  ACTIVE: 'registryStatusActive',
  PENDING: 'registryStatusPending',
  CEASED: 'registryStatusCeased',
  DEREGISTERED: 'registryStatusDeregistered',
  INVALIDATED: 'registryStatusInvalidated',
  BANKRUPT: 'registryStatusBankrupt',
  LIQUIDATION: 'registryStatusLiquidation',
  REORGANISATION: 'registryStatusReorganisation',
  UNKNOWN: 'registryStatusUnknown',
};

const DEBOUNCE_MS = 500;

export function BusinessRegistrySearch({
  csrf,
  headers,
  onCompany,
}: BusinessRegistrySearchProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryCompany[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  const clearPendingSearch = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  const runSearch = async (raw?: string) => {
    const value = (raw ?? query).trim();
    if (!value) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = await searchBusinessRegistry({ csrf, headers, query: value });
      setResults(result.results);
      setNotice(result.results.length === 0 ? t('registryNoResults') : '');
    } catch (cause) {
      setResults([]);
      setError(registryErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    clearPendingSearch();
    void runSearch();
  };

  const onChange = (value: string) => {
    setQuery(value);
    clearPendingSearch();
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setError('');
      setNotice('');
      return;
    }
    timerRef.current = window.setTimeout(() => {
      void runSearch(trimmed);
    }, DEBOUNCE_MS);
  };

  const choose = (company: RegistryCompany) => {
    clearPendingSearch();
    setResults([]);
    setNotice('');
    setError('');
    onCompany(company);
  };

  return (
    <section className="card registry-search" data-testid="business-registry-search">
      <strong className="registry-title">{t('registrySearchTitle')}</strong>
      <p className="muted registry-hint">{t('registrySearchHint')}</p>
      <form className="form-row registry-search-form" onSubmit={submit}>
        <label className="field registry-query-field">
          <span>{t('search')}</span>
          <input
            data-testid="registry-query"
            value={query}
            onChange={(event) => onChange(event.target.value)}
            placeholder={t('registrySearchPlaceholder')}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy || !query.trim()} data-testid="registry-search-button">
          {busy ? t('loading') : t('search')}
        </button>
      </form>
      {error && (
        <p className="error-text" role="alert" data-testid="registry-error">
          {error}
        </p>
      )}
      {notice && <p className="muted registry-notice">{notice}</p>}
      {busy && <p className="muted">{t('loading')}</p>}
      {results.length > 0 && (
        <ul className="registry-results" data-testid="registry-results">
          {results.map((company) => (
            <li key={`${company.business_id}-${company.legal_name}`}>
              <button
                type="button"
                className="registry-result-button"
                data-testid="registry-result"
                onClick={() => choose(company)}
              >
                <span className="registry-result-name">{company.legal_name}</span>
                <span className="mono">{company.business_id}</span>
                {company.vat_id && <span className="mono">{company.vat_id}</span>}
                <span>{company.address?.city ?? ''}</span>
                <span
                  className={
                    company.status === 'ACTIVE' || company.status === 'PENDING'
                      ? 'registry-status registry-status-ok'
                      : 'registry-status registry-status-warning'
                  }
                >
                  {t(STATUS_KEYS[company.status] as any)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function registryErrorMessage(
  cause: unknown,
  t: (key: any) => string,
): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'REG-001') return t('registryInvalidBusinessId');
    if (cause.code === 'REG-002') return t('registryCompanyNotFound');
    if (cause.code === 'REG-003' || cause.code === 'REG-005') {
      return t('registryUnavailable');
    }
    if (cause.code === 'REG-004') return t('registryRateLimited');
  }
  return cause instanceof Error ? cause.message : String(cause);
}
