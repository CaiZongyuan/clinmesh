import type { Attempt, BillingCharge, BillingAccount } from './contracts';
import { sumMinor } from './money';

export function correctionBalances(snapshot: BillingAccount['settlement'], charges: BillingCharge[], payments: Attempt[], coverage: ReadonlyMap<string, number> | undefined) {
  if (!snapshot) return [];
  const frozenIds = new Set(snapshot.charges.flatMap(line => line.adjustments.map(adjustment => adjustment.id)));
  const corrections = charges.flatMap(line => line.adjustments.filter(adjustment => !frozenIds.has(adjustment.id)).map(adjustment => ({ id: adjustment.id, chargeId: line.id, reason: adjustment.reason, amountMinor: adjustment.amountMinor, remainingMinor: adjustment.amountMinor }))).sort((first, second) => first.id.localeCompare(second.id));
  for (const correction of corrections) correction.remainingMinor = sumMinor([correction.amountMinor, -(coverage?.get(correction.id) ?? 0)]);
  for (const payment of payments) {
    if (!payment.correctionId || payment.status !== 'succeeded') continue;
    const correction = corrections.find(correction => correction.id === payment.correctionId);
    if (correction) correction.remainingMinor = sumMinor([correction.remainingMinor, payment.kind === 'deposit-refund' ? payment.amountMinor : -payment.amountMinor]);
  }
  const credits = corrections.filter(item => item.remainingMinor < 0);
  let creditIndex = 0;
  for (const debit of corrections.filter(item => item.remainingMinor > 0)) {
    while (debit.remainingMinor && credits[creditIndex]) {
      const credit = credits[creditIndex]!;
      const offset = Math.min(debit.remainingMinor, -credit.remainingMinor);
      debit.remainingMinor -= offset;
      credit.remainingMinor += offset;
      if (!credit.remainingMinor) creditIndex++;
    }
  }
  return corrections;
}
