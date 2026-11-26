import { expect, it, vi } from 'vitest';
import { createNodeSqliteStore } from '../../packages/store';
import { billingFixture } from './billing-fixture';
import { outpatientContract } from './outpatient-billing';
import { legacyCurrencyConflict, restoreLegacyBilling } from './legacy-billing';
import { firstSettlementContract, freeDischargeContract } from './first-settlement';

it('freezes only a fully posted and balanced admission after a material use appears between review and confirmation', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    expect(await firstSettlementContract(store)).toMatchObject({ regional: false, old: 'INPATIENT_CHARGES_UNPOSTED', pending: { outstandingMinor: null, canClearBed: false, locked: false }, preview: 'INPATIENT_CHARGES_UNPOSTED', due: 'SETTLEMENT_UNBALANCED', replay: 'PREVIEW_STALE', cleared: { outstandingMinor: 0, canClearBed: true, locked: true }, snapshot: { netMinor: 200000, cashMinor: 200000 } });
  } finally { await store.close(); }
});

it('permits the free ward to clear a bed after a reported investigation without payment attempts', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try { expect(await freeDischargeContract(store)).toEqual({ regional: false, funds: { outstandingMinor: 0, canClearBed: true, locked: false }, charges: 0, payments: 0 }); }
  finally { await store.close(); }
});

it.each([
  ['charge_items', 'JPY', 0], ['charge_adjustments', 'USD', 0], ['payment_transactions', 'JPY', 0],
  ['payment_tenders', 'USD', 0], ['payment_allocations', 'JPY', 0], ['refund_transactions', 'USD', 0],
] as const)('blocks collections when a restored %s has a foreign currency or precision, preserving its original units', async (table, code, exponent) => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const result = await legacyCurrencyConflict(store, table, code, exponent);
    const expected = { status: 409, data: { code: 'BILLING_CURRENCY_MISMATCH', details: { amountMinor: 1000, currencyCode: code, minorUnitExponent: exponent } } };
    expect(result).toMatchObject({ read: expected, collect: expected, preserved: { amount_minor: 1000, currency_code: code, currency_exponent: exponent }, previews: 0 });
  } finally { await store.close(); }
});

it('uses the hospital business date for a registration made after midnight in Shanghai', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { billing, at, encounterId, read } = await billingFixture(store, 'cardiology');
    await store.withTransaction(tx => billing.encounterStarted(tx, at, encounterId, '2026-11-26T16:00:00.000Z', '2026-11-26T16:00:00.000Z'));
    expect((await read()).charges[0]).toMatchObject({ businessDay: '2026-11-27' });
  } finally { await store.close(); }
});

it('restores the 2f49e201 v2 ledger including its original refund and discharges the restored admission through production cashier routes', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    expect(await restoreLegacyBilling(store)).toMatchObject({ restoredPaid: 90, refundedBefore: 10, excessive: 'REFUND_LIMIT', finalPaid: 50, tenders: [{ method: 'card', amountMinor: 40 }], overCorrection: 'CORRECTION_LIMIT', remaining: [0, -30], linked: true, clearance: { canClearBed: false }, originalRules: { status: 409, data: { code: 'REGIONAL_RULES_UNAVAILABLE' } }, frozenMinor: 100 });
  } finally { await store.close(); }
});

it('settles unchanged selected charges under an unrelated edit and refuses a withdrawn source at the point of collection', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { at, order, read, call, command } = await billingFixture(store);
    const selected = await order(), unrelated = await order();
    const preview = await command('payment.preview', { chargeIds: [selected.chargeId] });
    const version = (await read()).version;
    const withdrawn = await command('payment.preview', { chargeIds: [unrelated.chargeId] });
    await store.withTransaction(tx => tx.update(at, 'clinical_orders', unrelated.orderId, 1, { status: 'withdrawn' }));
    await expect(call('payment.confirm', { commitToken: preview.commitToken }, version)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(command('payment.confirm', { commitToken: withdrawn.commitToken })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    await expect(command('payment.preview', { chargeIds: [unrelated.chargeId] })).rejects.toMatchObject({ code: 'CHARGE_UNAVAILABLE' });
    expect((await read()).charges.find(line => line.id === unrelated.chargeId)).toMatchObject({ cancelled: true, released: false, netMinor: 0 });
  } finally { await store.close(); }
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
    expect(result.cashOnly.tenders).toEqual([{ method: 'cash', amountMinor: 40 }]);
    expect(result.bill).toMatchObject({ currency: { code: 'USD', minorUnitExponent: 2 }, pending: false, balanceMinor: -60 });
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
