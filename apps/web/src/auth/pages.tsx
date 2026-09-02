import { useEffect, useState, type FormEvent } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from './AuthContext';
import { api, type PublicUser, type SessionInfo } from './api';
import { languages, useI18n } from '../i18n/I18nContext';

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="error-text">{error}</p>;
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { setSession, user, ready } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [challengeToken, setChallengeToken] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to="/" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        user?: PublicUser;
        csrf_token?: string;
        requires_two_factor?: boolean;
        challenge_token?: string;
      }>('/api/v1/auth/login', {
        method: 'POST',
        body: {
          email,
          password,
          remember_me: rememberMe,
          ...(challengeToken ? { challenge_token: challengeToken, totp_code: twoFactorCode } : {}),
        },
      });
      if (result.requires_two_factor && result.challenge_token) {
        setChallengeToken(result.challenge_token);
      } else if (result.user && result.csrf_token) {
        setSession(result.user, result.csrf_token);
        navigate('/', { replace: true });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={challengeToken ? t('twoFactorRequired') : t('loginTitle')}>
      <form onSubmit={submit}>
        {challengeToken ? (
          <Field
            label={t('twoFactorCode')}
            type="text"
            value={twoFactorCode}
            onChange={setTwoFactorCode}
            autoComplete="one-time-code"
          />
        ) : (
          <>
            <Field label={t('email')} type="email" value={email} onChange={setEmail} autoComplete="email" />
            <Field
              label={t('password')}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
            <label className="checkbox">
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              <span>{t('rememberMe')}</span>
            </label>
          </>
        )}
        <ErrorNote error={error} />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? t('loading') : challengeToken ? t('confirm') : t('login')}
        </button>
      </form>
      {!challengeToken && (
        <p className="muted">
          <Link to="/forgot-password">{t('forgotPassword')}</Link>
        </p>
      )}
      {!challengeToken && (
        <p className="muted">
          {t('noAccount')} <Link to="/register">{t('register')}</Link>
        </p>
      )}
    </AuthCard>
  );
}

export function RegisterPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/register', { method: 'POST', body: { email, password } });
      setMessage(t('accountCreated'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('registerTitle')}>
      {message ? (
        <p className="success-text">{message}</p>
      ) : (
        <form onSubmit={submit}>
          <Field label={t('email')} type="email" value={email} onChange={setEmail} autoComplete="email" />
          <Field
            label={t('password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <ErrorNote error={error} />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? t('loading') : t('register')}
          </button>
        </form>
      )}
      <p className="muted">
        {t('haveAccount')} <Link to="/login">{t('login')}</Link>
      </p>
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setState('failed');
      return;
    }
    api('/api/v1/auth/email/verify', { method: 'POST', body: { token } })
      .then(() => setState('ok'))
      .catch(() => setState('failed'));
  }, [params]);

  return (
    <AuthCard title={t('verifyEmailTitle')}>
      {state === 'loading' && <p>{t('verifying')}</p>}
      {state === 'ok' && <p className="success-text">{t('verified')}</p>}
      {state === 'failed' && <p className="error-text">{t('verificationFailed')}</p>}
      <Link to="/login">{t('goToLogin')}</Link>
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/password/forgot', { method: 'POST', body: { email } });
      setMessage(t('resetLinkSent'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('passwordResetTitle')}>
      {message ? (
        <p className="success-text">{message}</p>
      ) : (
        <form onSubmit={submit}>
          <Field label={t('email')} type="email" value={email} onChange={setEmail} autoComplete="email" />
          <ErrorNote error={error} />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? t('loading') : t('sendResetLink')}
          </button>
        </form>
      )}
      <p className="muted">
        <Link to="/login">{t('back')}</Link>
      </p>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/password/reset', {
        method: 'POST',
        body: { token: params.get('token') ?? '', new_password: password },
      });
      setMessage(t('resetLinkSent'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('passwordResetTitle')}>
      {message ? (
        <p className="success-text">{message}</p>
      ) : (
        <form onSubmit={submit}>
          <Field
            label={t('newPassword')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <ErrorNote error={error} />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? t('loading') : t('resetPassword')}
          </button>
        </form>
      )}
      <p className="muted">
        <Link to="/login">{t('back')}</Link>
      </p>
    </AuthCard>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const { user, csrf, clearSession, refresh } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const loadSessions = async () => {
    const result = await api<{ sessions: SessionInfo[] }>('/api/v1/auth/sessions', { csrf });
    setSessions(result.sessions);
  };

  useEffect(() => {
    void loadSessions().catch(() => undefined);
  }, []);

  if (!user) return <Navigate to="/login" replace />;

  const logout = async () => {
    try {
      await api('/api/v1/auth/logout', { method: 'POST', csrf });
    } finally {
      clearSession();
      navigate('/login', { replace: true });
    }
  };

  const start2fa = async () => {
    setError(null);
    try {
      const result = await api<{ secret: string; otpauth_uri: string }>('/api/v1/auth/2fa/setup', {
        method: 'POST',
        csrf,
      });
      setSetup(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const confirm2fa = async () => {
    setError(null);
    try {
      const result = await api<{ recovery_codes: string[] }>('/api/v1/auth/2fa/confirm', {
        method: 'POST',
        body: { code },
        csrf,
      });
      setCodes(result.recovery_codes);
      setSetup(null);
      setCode('');
      setMessage(t('twoFactorEnable'));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const disable2fa = async () => {
    setError(null);
    try {
      await api('/api/v1/auth/2fa/disable', { method: 'POST', body: { code }, csrf });
      setCode('');
      setMessage(t('twoFactorDisable'));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const regenerateCodes = async () => {
    setError(null);
    try {
      const result = await api<{ recovery_codes: string[] }>('/api/v1/auth/2fa/recovery-codes', {
        method: 'POST',
        body: { code },
        csrf,
      });
      setCodes(result.recovery_codes);
      setCode('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const changePassword = async () => {
    setError(null);
    try {
      await api('/api/v1/auth/password/change', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
        csrf,
      });
      setCurrentPassword('');
      setNewPassword('');
      setMessage(t('passwordChanged'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revoke = async (id: string) => {
    await api(`/api/v1/auth/sessions/${id}/revoke`, { method: 'POST', csrf });
    await loadSessions();
  };

  const revokeOthers = async () => {
    await api('/api/v1/auth/sessions/revoke-others', { method: 'POST', csrf });
    await loadSessions();
  };

  return (
    <AuthCard title={t('welcomeBack')}>
      <p className="muted">
        {user.email} · {user.totp_enabled ? t('twoFactorTitle') : t('account')}
      </p>
      {message && <p className="success-text">{message}</p>}
      <ErrorNote error={error} />

      <section className="card">
        <h2>{t('sessionsTitle')}</h2>
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <span>
                <strong>{session.user_agent || '—'}</strong> {session.current && `(${t('currentSession')})`}
                <br />
                <small>
                  {t('createdAt')}: {new Date(session.created_at).toLocaleString()} · {t('expiresAt')}:{' '}
                  {new Date(session.expires_at).toLocaleString()}
                </small>
              </span>
              {!session.current && (
                <button type="button" onClick={() => void revoke(session.id)}>
                  {t('revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void revokeOthers()}>
          {t('revokeOthers')}
        </button>
      </section>

      <section className="card">
        <h2>{t('twoFactorSetup')}</h2>
        {!user.totp_enabled && !setup && (
          <button type="button" className="primary" onClick={() => void start2fa()}>
            {t('twoFactorEnable')}
          </button>
        )}
        {setup && (
          <div className="setup-box">
            <p>{t('scanQr')}</p>
            <QRCodeSVG value={setup.otpauth_uri} size={180} />
            <p className="mono">{setup.secret}</p>
            <div className="field">
              <span>{t('enterTotp')}</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <button type="button" className="primary" onClick={() => void confirm2fa()}>
              {t('confirm')}
            </button>
          </div>
        )}
        {user.totp_enabled && !codes && (
          <div className="field">
            <span>{t('twoFactorCode')}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="button" onClick={() => void disable2fa()}>
              {t('twoFactorDisable')}
            </button>
            <button type="button" onClick={() => void regenerateCodes()}>
              {t('regenerateRecoveryCodes')}
            </button>
          </div>
        )}
        {codes && (
          <div>
            <p className="muted">{t('recoveryCodesNotice')}</p>
            <ul className="codes">
              {codes.map((item) => (
                <li key={item} className="mono">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t('changePassword')}</h2>
        <Field
          label={t('currentPassword')}
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
        />
        <Field
          label={t('newPassword')}
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
        />
        <button type="button" className="primary" onClick={() => void changePassword()}>
          {t('changePassword')}
        </button>
      </section>

      <button type="button" onClick={() => void logout()}>
        {t('logout')}
      </button>
    </AuthCard>
  );
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const { t, language, setLanguage } = useI18n();
  return (
    <main className="auth-shell">
      <header className="auth-topbar">
        <span>{t('appName')}</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
          {languages.map((lang) => (
            <option key={lang} value={lang}>
              {lang.toUpperCase()}
            </option>
          ))}
        </select>
      </header>
      <div className="auth-card card">
        <h2>{title}</h2>
        {children}
      </div>
    </main>
  );
}
