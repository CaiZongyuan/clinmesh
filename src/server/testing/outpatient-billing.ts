import type { StorePort } from '../../packages/store';
import { billingFixture } from './billing-fixture';

export async function outpatientContract(store: StorePort) {
  const releases: string[] = [];
  const { order, command, read } = await billingFixture(store, 'general', false, { onRelease(_tx, _at, fact) { releases.push(fact.chargeId); } });
  const first = await order(), second = await order();
  const ids = [first.chargeId, second.chargeId];
  const collect = (fields: Record<string, unknown>) => command('payment.preview', { chargeIds: ids, ...fields });
  const confirm = (commitToken: unknown) => command('payment.confirm', { commitToken });
  const code = async (task: Promise<unknown>) => { try { await task; return 'accepted'; } catch (error) { return (error as { code?: string }).code ?? 'invalid'; } };
  const short = await code(collect({ tenders: [{ method: 'cash', amountMinor: first.amount }] }));
  const partial = await collect({ chargeIds: [first.chargeId], tenders: [{ method: 'cash', amountMinor: 10 }] });
  await confirm(partial.commitToken);
  const total = first.amount + second.amount - 10;
  const preview = await collect({ tenders: [{ method: 'cash', amountMinor: total - 35 }, { method: 'card', amountMinor: 35 }], simulation: 'delayed-approval' });
  const attempt = await confirm(preview.commitToken);
  const blocked = await code(collect({}));
  await command('payment.recover', { paymentId: attempt.paymentId, paymentVersion: 1 });
  const replay = await code(command('payment.recover', { paymentId: attempt.paymentId, paymentVersion: 1 }));
  await command('charge.adjust', { chargeId: first.chargeId, amountMinor: 50, reason: 'Duplicate supply' });
  const refundFields = { paymentId: attempt.paymentId, chargeId: second.chargeId, amountMinor: 40, reason: 'Return original allocation', simulation: 'delayed-approval' };
  const cashOnly = await command('refund.allocation.preview', { ...refundFields, chargeId: first.chargeId });
  await command('charge.adjust', { chargeId: second.chargeId, amountMinor: 50, reason: 'Duplicate supply' });
  const refund = await command('refund.allocation.preview', refundFields);
  const concurrent = await command('refund.allocation.preview', refundFields);
  const raced = await Promise.all([refund, concurrent].map(async preview => code(command('refund.allocation.confirm', { commitToken: preview.commitToken }))));
  const pending = (await read()).payments.find(payment => payment.kind === 'refund')!;
  const blockedRefund = await code(command('refund.allocation.preview', { ...refundFields, chargeId: first.chargeId }));
  await command('payment.recover', { paymentId: pending.id, paymentVersion: 1 });
  const excess = await code(command('refund.allocation.preview', { ...refundFields, amountMinor: 11 }));
  return { short, attempt, blocked, replay, raced, blockedRefund, excess, releases, pending, cashOnly, bill: await read(), first: first.amount, second: second.amount };
}
