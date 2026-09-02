import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
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
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav = (
    <nav aria-label="Main navigation">
      {navItems.map((item) => (
        <NavLink key={item.key} to={item.href} onClick={() => setDrawerOpen(false)}>
          {t(item.labelKey)}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="app-shell">
      <button
        className="hamburger"
        aria-label="Open navigation"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen((open) => !open)}
      >
        ☰
      </button>
      <aside className="sidebar">{nav}</aside>
      {drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="brand">{t('appName')}</div>
            {nav}
          </aside>
        </div>
      )}
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
