import { expect, it, vi } from 'vitest';
import { formatMinor, parseMinor } from '../index';
import { createNodeSqliteStore } from '../../store';
import { billingFixture } from '../../../server/testing/billing-fixture';
import { outpatientContract } from '../../../server/testing/outpatient-billing';

it('round trips the exact smallest units of a zero-decimal and a two-decimal hospital', () => {
  const yen = { code: 'JPY', minorUnitExponent: 0 };
  const dollar = { code: 'USD', minorUnitExponent: 2 };
  expect(formatMinor(1234, yen)).toBe('JPY 1234');
  expect(formatMinor(Number.MAX_SAFE_INTEGER, dollar)).toBe('USD 90071992547409.91');
  expect(parseMinor('90071992547409.91', dollar)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => parseMinor('1.1', yen)).toThrow();
  expect(() => parseMinor('90071992547409.92', dollar)).toThrow();
});

it('expires previews on the real clock, enforces single-use and rejects a cancelled clinical source at confirmation', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { at, order, read, command, call } = await billingFixture(store);
    const line = await order();
    const fields = { chargeIds: [line.chargeId] };
    const quote = await command('payment.preview', fields);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(quote.expiresAt as string));
    await expect(command('payment.confirm', { commitToken: quote.commitToken })).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
    const fresh = await command('payment.preview', fields);
    const version = (await read()).version;
    const key = 'stable-confirm';
    const payload = { commitToken: fresh.commitToken };
    const first = await call('payment.confirm', payload, version, key);
    expect(await call('payment.confirm', payload, version, key)).toEqual(first);
    await expect(command('payment.confirm', payload)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    const second = await order();
    const stale = await command('payment.preview', { chargeIds: [second.chargeId] });
    await store.withTransaction(tx => tx.update(at, 'clinical_orders', second.orderId, 1, { status: 'cancelled' }));
    await expect(command('payment.confirm', { commitToken: stale.commitToken })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect((await read()).charges.at(-1)).toMatchObject({ cancelled: true, netMinor: 0 });
  } finally { vi.useRealTimers(); await store.close(); }
});

it('requires all allocations to belong to this encounter and caps the specified allocation, original transaction, shared reduction and single refund', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { order, command } = await billingFixture(store, 'yen');
    const large = await order(undefined, 2_000_000), small = await order();
    const fields = { chargeIds: [large.chargeId, small.chargeId] };
    await expect(command('payment.preview', { chargeIds: [large.chargeId, large.chargeId] })).rejects.toThrow();
    await expect(command('payment.preview', { chargeIds: Array(21).fill(large.chargeId) })).rejects.toThrow();
    const other = await billingFixture(store);
    await expect(command('payment.preview', { chargeIds: [large.chargeId, (await other.order()).chargeId] })).rejects.toMatchObject({ code: 'CHARGE_NOT_IN_ACCOUNT' });
    const partial = await command('payment.preview', { chargeIds: [small.chargeId], amountMinor: 20 });
    const first = await command('payment.confirm', { commitToken: partial.commitToken });
    const rest = await command('payment.preview', fields);
    const shared = await command('payment.confirm', { commitToken: rest.commitToken });
    await command('charge.adjust', { chargeId: small.chargeId, amountMinor: small.amount, reason: 'Waived' });
    const refund = { chargeId: small.chargeId, reason: 'Return by allocation' };
    await expect(command('refund.allocation.preview', { ...refund, paymentId: first.paymentId, amountMinor: 21 })).rejects.toMatchObject({ code: 'REFUND_LIMIT' });
    await expect(command('refund.allocation.preview', { ...refund, paymentId: shared.paymentId, amountMinor: small.amount })).rejects.toMatchObject({ code: 'REFUND_LIMIT' });
    await command('charge.adjust', { chargeId: large.chargeId, amountMinor: 1_000_000_010, reason: 'Reversal' });
    await expect(command('refund.allocation.preview', { ...refund, chargeId: large.chargeId, paymentId: shared.paymentId, amountMinor: 1_000_000_001 })).rejects.toMatchObject({ code: 'REFUND_LIMIT' });
  } finally { await store.close(); }
});

it('recovers the frozen shared payment, then refunds its explicit allocation in reverse tender order exactly once', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const result = await outpatientContract(store);
    expect(result).toMatchObject({ short: 'TENDER_TOTAL_MISMATCH', attempt: { status: 'unknown' }, blocked: 'FUNDS_PENDING', replay: 'PAYMENT_ALREADY_RESOLVED', blockedRefund: 'FUNDS_PENDING', excess: 'REFUND_LIMIT', pending: { tenders: [{ method: 'card', amountMinor: 35 }, { method: 'cash', amountMinor: 5 }] } });
    expect(result.raced.filter(outcome => outcome === 'accepted')).toHaveLength(1);
    expect(new Set(result.releases).size).toBe(2);
    expect(result.releases).toHaveLength(2);
    expect(result.bill).toMatchObject({ currency: { code: 'USD', minorUnitExponent: 2 }, pending: false, balanceMinor: -10 });
    expect(result.bill.payments).toHaveLength(3);
  } finally { await store.close(); }
});

it.each(['general', 'cardiology', 'yen', 'free', 'disabled'] as const)('freezes each signed catalog line exactly once in %s and honours clinical policy', async facility => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { at, order, billing } = await billingFixture(store, facility);
    const line = await order();
    expect(await store.withTransaction(tx => billing.freezeCharge(tx, at, line.source))).toBe(line.chargeId);
    const free = facility === 'free' || facility === 'disabled';
    expect(await store.read(reader => billing.readOrderFunds(reader, at, line.orderId))).toMatchObject({ chargeId: line.chargeId, state: free ? 'free' : 'unpaid', released: facility !== 'cardiology', locked: false, netPaidMinor: 0 });
    expect(line.chargeId === null).toBe(free);
    expect(await store.read(reader => reader.list(at, 'payment_transactions'))).toHaveLength(0);
  } finally { await store.close(); }
});
