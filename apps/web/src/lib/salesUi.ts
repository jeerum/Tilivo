export type AgingBucketKey = 'NOT_DUE' | '1_7' | '8_30' | '31_60' | '61_90' | 'OVER_90';

export function moneyFixed(value: string | number | null | undefined): string {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return '0.00';
  return parsed.toFixed(2);
}

export function openBalance(total: string | number, advanceApplied: string | number, credited: string | number, paid: string | number): string {
  const balance = Number(total) - Number(advanceApplied) - Number(credited) - Number(paid);
  return moneyFixed(balance > 0 ? balance : 0);
}

export function remainingCreditable(total: string | number, advanceApplied: string | number, credited: string | number): string {
  const remaining = Number(total) - Number(advanceApplied) - Number(credited);
  return moneyFixed(remaining > 0 ? remaining : 0);
}

export function bucketTranslationKey(bucket: AgingBucketKey | string): string {
  switch (bucket) {
    case 'NOT_DUE': return 'bucketNotDue';
    case '1_7': return 'bucket1_7';
    case '8_30': return 'bucket8_30';
    case '31_60': return 'bucket31_60';
    case '61_90': return 'bucket61_90';
    case 'OVER_90': return 'bucketOver90';
    default: return 'bucketNotDue';
  }
}
