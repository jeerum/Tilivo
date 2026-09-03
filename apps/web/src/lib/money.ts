/**
 * Display-safe money summing for the UI. Accounting remains authoritative on
 * the backend (NUMERIC + decimal.js); this helper only prevents float drift
 * in visible totals by summing integer cents.
 */
export function moneyToCents(value: string): number {
  const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2] ?? '0');
  const fraction = Number((match[3] ?? '').padEnd(2, '0') || '0');
  return sign * (whole * 100 + fraction);
}

export function centsToMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

export function sumMoney(values: Array<string | number>): string {
  const total = values.reduce<number>((sum, value) => sum + moneyToCents(String(value)), 0);
  return centsToMoney(total);
}
