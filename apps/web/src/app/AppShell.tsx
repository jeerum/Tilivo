import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n/I18nContext';

const navItems = [
  { key: 'home', labelKey: 'home', href: '/' },
  { key: 'documents', labelKey: 'documents', href: '/documents' },
  { key: 'settings', labelKey: 'settings', href: '/settings' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { t } = useI18n();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">{t('appName')}</div>
        <nav aria-label="Main navigation">
          {navItems.map((item) => (
            <a key={item.key} href={item.href}>
              {t(item.labelKey)}
            </a>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar-wide">
          <span className="topbar-title">{t('appName')}</span>
          <span className="topbar-user">{user?.email ?? ''}</span>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
