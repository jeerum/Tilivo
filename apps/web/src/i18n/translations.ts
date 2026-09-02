export const languages = ['et', 'en'] as const;
export type Language = (typeof languages)[number];

export const translations = {
  et: {
    appName: 'MRJKP Accounting',
    tagline: 'Raamatupidamise SaaS-i v0.1 vundament',
    status: 'Süsteemi olek',
    checking: 'Kontrollin...',
    healthy: 'Süsteem töötab',
    degraded: 'Süsteem vajab tähelepanu',
    database: 'Andmebaas',
    up: 'töötab',
    down: 'ei vasta',
    apiVersion: 'API versioon',
    environment: 'Keskkond',
    traceId: 'Trace ID',
    errorCode: 'Error ID',
    lastChecked: 'Viimane kontroll',
    language: 'Keel',
  },
  en: {
    appName: 'MRJKP Accounting',
    tagline: 'Accounting SaaS v0.1 foundation',
    status: 'System status',
    checking: 'Checking...',
    healthy: 'System is healthy',
    degraded: 'System needs attention',
    database: 'Database',
    up: 'up',
    down: 'down',
    apiVersion: 'API version',
    environment: 'Environment',
    traceId: 'Trace ID',
    errorCode: 'Error ID',
    lastChecked: 'Last checked',
    language: 'Language',
  },
} as const;

export type TranslationKey = keyof (typeof translations)['et'];

export function translate(language: Language, key: TranslationKey): string {
  return translations[language][key];
}

