import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getCookie, type PublicUser } from './api';

interface AuthValue {
  user: PublicUser | null;
  csrf: string;
  ready: boolean;
  setSession: (user: PublicUser, csrfToken: string) => void;
  clearSession: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);
const CSRF_COOKIE = 'mrjkp_csrf';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [csrf, setCsrf] = useState('');
  const [ready, setReady] = useState(false);

  const refresh = async () => {
    try {
      const result = await api<{ user: PublicUser }>('/api/v1/auth/me');
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setCsrf(getCookie(CSRF_COOKIE));
      setReady(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      csrf,
      ready,
      setSession: (nextUser, csrfToken) => {
        setUser(nextUser);
        setCsrf(csrfToken);
      },
      clearSession: () => {
        setUser(null);
        setCsrf('');
      },
      refresh,
    }),
    [user, csrf, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

