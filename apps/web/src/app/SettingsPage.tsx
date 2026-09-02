import { HomePage } from '../auth/pages';
import { useI18n } from '../i18n/I18nContext';

const sections = [
  'profile',
  'security',
  'sessions',
  'twoFactor',
  'password',
  'company',
  'members',
  'roles',
  'audit',
] as const;

export function SettingsPage() {
  const { t } = useI18n();
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings">
        {sections.map((section) => (
          <a key={section} href={`#${section}`}>
            {t('settings')} · {section}
          </a>
        ))}
      </nav>
      <div className="settings-content">
        <HomePage />
      </div>
    </div>
  );
}
