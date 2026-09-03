import { useEffect, useState } from 'react';
import { api } from '../auth/api';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';

interface Suggestions {
  expenseAccountId: string | null;
  expenseAccountCode: string | null;
  taxCodeId: string | null;
  taxCodeCode: string | null;
  deductibilityPercent: number | null;
  paymentMethod: string | null;
  description: string | null;
  category: string | null;
  overallConfidence: number;
  fieldConfidences: Record<string, number>;
  reasons: Record<string, string>;
}

interface Run {
  id: string;
  provider: string;
  status: string;
  suggestions: Suggestions | null;
}

const conf = (value?: number | null): string =>
  value === undefined || value === null ? '—' : `${Math.round(Number(value) * 100)}%`;

export function AiSuggestionPanel({
  documentId,
  tenantId,
  onChanged,
}: {
  documentId: string;
  tenantId: string;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { csrf } = useAuth();
  const headers = { 'x-tilivo-tenant-id': tenantId };
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    try {
      const result = await api<{ classification: Run | null }>(
        `/api/v1/purchases/${documentId}/classification`,
        { headers },
      );
      setRun(result.classification);
    } catch {
      // no classification yet
    }
  };

  useEffect(() => {
    void load();
  }, [documentId]);

  const classify = async () => {
    setBusy('classify');
    setError('');
    try {
      const result = await api<{ classification: Run }>(
        `/api/v1/purchases/${documentId}/classification`,
        { method: 'POST', csrf, headers },
      );
      setRun(result.classification);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  const applyField = async (field: string, value: unknown) => {
    setBusy(field);
    setError('');
    try {
      await api(`/api/v1/purchases/${documentId}/classification/apply`, {
        method: 'POST',
        csrf,
        headers,
        body: { [field]: value },
      });
      setMessage('Applied');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  const applyAll = async () => {
    if (!run?.suggestions) return;
    setBusy('all');
    try {
      await api(`/api/v1/purchases/${documentId}/classification/apply`, {
        method: 'POST',
        csrf,
        headers,
        body: {
          expense_account_id: run.suggestions.expenseAccountId ?? undefined,
          tax_code_id: run.suggestions.taxCodeId ?? undefined,
          deductibility_percent:
            run.suggestions.deductibilityPercent == null
              ? undefined
              : String(run.suggestions.deductibilityPercent),
          payment_method: run.suggestions.paymentMethod ?? undefined,
          description: run.suggestions.description ?? undefined,
          category: run.suggestions.category ?? undefined,
        },
      });
      setMessage('AI suggestions applied');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  const suggestions = run?.suggestions;
  const fieldLabel = (key: string) => t(key as any) || key;

  return (
    <div className="card ai-panel" data-testid="ai-panel">
      <h3>AI {t('suggestions')}</h3>
      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}
      {!suggestions && (
        <button type="button" className="primary" data-testid="ai-classify" disabled={Boolean(busy)} onClick={() => void classify()}>
          {t('aiClassify')}
        </button>
      )}
      {suggestions && (
        <>
          <p>
            {t('overallConfidence')}: {conf(suggestions.overallConfidence)} · {run?.provider}
          </p>
          {suggestions.expenseAccountId && (
            <div className="ai-suggestion">
              <span>{fieldLabel('expenseAccount')}: <strong>{suggestions.expenseAccountCode}</strong></span>
              <span>{t('confidence')}: {conf(suggestions.fieldConfidences.expenseAccount)}</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void applyField('expense_account_id', suggestions.expenseAccountId)}>
                {t('accept')}
              </button>
            </div>
          )}
          {suggestions.taxCodeId && (
            <div className="ai-suggestion">
              <span>VAT: <strong>{suggestions.taxCodeCode}</strong></span>
              <span>{t('confidence')}: {conf(suggestions.fieldConfidences.taxCode)}</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void applyField('tax_code_id', suggestions.taxCodeId)}>
                {t('accept')}
              </button>
            </div>
          )}
          {suggestions.deductibilityPercent != null && (
            <div className="ai-suggestion">
              <span>{t('deductibility')}: <strong>{suggestions.deductibilityPercent}%</strong></span>
              <span>{t('confidence')}: {conf(suggestions.fieldConfidences.deductibility)}</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void applyField('deductibility_percent', String(suggestions.deductibilityPercent))}>
                {t('accept')}
              </button>
            </div>
          )}
          {suggestions.paymentMethod && (
            <div className="ai-suggestion">
              <span>{t('paymentMethod')}: <strong>{suggestions.paymentMethod}</strong></span>
              <span>{t('confidence')}: {conf(suggestions.fieldConfidences.paymentMethod)}</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void applyField('payment_method', suggestions.paymentMethod)}>
                {t('accept')}
              </button>
            </div>
          )}
          <button type="button" className="primary" data-testid="ai-apply-all" disabled={Boolean(busy)} onClick={() => void applyAll()}>
            {t('applyAll')}
          </button>
          <button type="button" onClick={() => void classify()}>{t('rerun')}</button>
        </>
      )}
    </div>
  );
}
