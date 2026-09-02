import { useEffect, useState } from 'react';
import { fetchHealth, type HealthState } from './lib/health';
import { languages, translate, type Language } from './i18n/translations';
import './App.css';

const initialHealth: HealthState = {
  status: 'degraded',
  database: 'down',
  version: '',
  environment: '',
  time: '',
};

export default function App() {
  const [language, setLanguage] = useState<Language>('et');
  const [health, setHealth] = useState<HealthState>(initialHealth);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      setChecking(true);
      setError(null);
      try {
        const state = await fetchHealth();
        if (!cancelled) setHealth(state);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    void check();
    const interval = setInterval(() => void check(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const healthy = health.status === 'ok' && !error;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>{t('appName')}</h1>
          <p className="tagline">{t('tagline')}</p>
        </div>
        <label className="language-switch">
          <span>{t('language')}</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
            {languages.map((lang) => (
              <option key={lang} value={lang}>
                {lang.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main>
        <section className="card status-card" aria-live="polite">
          <div className={`status-icon ${healthy ? 'ok' : checking ? 'checking' : 'degraded'}`} aria-hidden="true" />
          <div>
            <h2>{t('status')}</h2>
            <p className="status-text">
              {checking
                ? t('checking')
                : healthy
                  ? t('healthy')
                  : t('degraded')}
            </p>
            {error && <p className="error-text">{error}</p>}
          </div>
        </section>

        <dl className="card details">
          <div>
            <dt>{t('database')}</dt>
            <dd className={health.database === 'up' ? 'ok-text' : 'bad-text'}>
              {health.database === 'up' ? t('up') : t('down')}
            </dd>
          </div>
          <div>
            <dt>{t('apiVersion')}</dt>
            <dd>{health.version || '–'}</dd>
          </div>
          <div>
            <dt>{t('environment')}</dt>
            <dd>{health.environment || '–'}</dd>
          </div>
          <div>
            <dt>{t('traceId')}</dt>
            <dd className="mono">{health.trace_id ?? '–'}</dd>
          </div>
          {health.error && (
            <div>
              <dt>{t('errorCode')}</dt>
              <dd className="mono">{health.error.code}</dd>
            </div>
          )}
          <div>
            <dt>{t('lastChecked')}</dt>
            <dd>{health.time ? new Date(health.time).toLocaleString(language === 'et' ? 'et-EE' : 'en-GB') : '–'}</dd>
          </div>
        </dl>
      </main>
    </div>
  );
}

