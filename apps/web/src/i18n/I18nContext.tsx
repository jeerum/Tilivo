import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { languages, translate, type Language, type TranslationKey } from './translations';

interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>('et');
  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      t: (key) => translate(language, key),
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

export { languages };

