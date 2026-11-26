import { z } from 'zod';
import { CoreError } from '../../platform';

export const currencySchema = z.object({ code: z.string().regex(/^[A-Z]{3}$/), minorUnitExponent: z.int().min(0).max(9) });
export type Currency = z.infer<typeof currencySchema>;

export function requireDenomination(row: { id: string; amount_minor: number; currency_code: string; currency_exponent: number }, currency: Currency) {
  if (row.currency_code !== currency.code || row.currency_exponent !== currency.minorUnitExponent) {
    throw new CoreError(409, 'BILLING_CURRENCY_MISMATCH', { factId: row.id, amountMinor: row.amount_minor, currencyCode: row.currency_code, minorUnitExponent: row.currency_exponent });
  }
}

export function formatMinor(amount: number, currency: Currency) {
  const digits = currencySchema.parse(currency).minorUnitExponent;
  const value = BigInt(z.int().parse(amount));
  const magnitude = (value < 0n ? -value : value).toString().padStart(digits + 1, '0');
  return `${currency.code} ${value < 0n ? '-' : ''}${digits ? `${magnitude.slice(0, -digits)}.${magnitude.slice(-digits)}` : magnitude}`;
}

export function parseMinor(text: string, currency: Currency) {
  const digits = currencySchema.parse(currency).minorUnitExponent;
  const [, units, fraction = ''] = /^(\d+)(?:\.(\d+))?$/.exec(text.trim()) ?? [];
  if (!units || fraction.length > digits) throw Error('INVALID_AMOUNT');
  return z.int().nonnegative().parse(Number(BigInt(units + fraction.padEnd(digits, '0'))));
}

export function sumMinor(values: readonly number[]) {
  return z.int().parse(Number(values.reduce((sum, amount) => sum + BigInt(amount), 0n)));
}
