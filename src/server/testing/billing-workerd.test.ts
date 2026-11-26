import { expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

it('rechecks allocation recovery, frozen ward settlement and surgical projections on real Durable Object SQLite', async () => {
  const harness = createTestHarness({ workers: [{ config: { name: 'billing-contract', main: 'src/server/testing/billing-worker.ts', compatibility_date: '2026-11-19', compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'BILLING', class_name: 'BillingWorkspace' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['BillingWorkspace'] }] } }] });
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const run = async (path: string) => { const response = await worker.fetch(path); expect(response.status).toBe(200); return response.json(); };
    expect(await run('/outpatient')).toMatchObject({ blocked: 'FUNDS_PENDING', replay: 'PAYMENT_ALREADY_RESOLVED', excess: 'REFUND_LIMIT', bill: { pending: false, balanceMinor: -60 }, cashOnly: { tenders: [{ method: 'cash', amountMinor: 40 }] }, pending: { tenders: [{ method: 'card', amountMinor: 35 }, { method: 'cash', amountMinor: 5 }] } });
    expect(await run('/inpatient')).toMatchObject({ lock: 'BILLING_LOCKED', corrected: { year: 2026 }, account: { balanceMinor: 5, settlement: { cashMinor: 3930, coverageMinor: 4760 } }, review: { archive: { reconciled: true } } });
    expect(await run('/projection')).toMatchObject({ reserved: { costs: { reservedMinor: 40000, projectedMinor: 220830 } }, awaitingMaterial: { costs: { reservedMinor: 20000, projectedMinor: null } }, planned: { group: { group: 'FM39', referenceMinor: 1200000 }, costs: { projectedMinor: 220830 } } });
    expect(await run('/investigation')).toMatchObject({ before: { projectedMinor: 800 }, awaiting: { projectedMinor: null }, after: { projectedMinor: 800, committedMinor: 0 } });
    expect(await run('/legacy')).toMatchObject({ restoredPaid: 90, refundedBefore: 10, excessive: 'REFUND_LIMIT', finalPaid: 50, overCorrection: 'CORRECTION_LIMIT', remaining: [0, -30], linked: true, originalRules: { status: 409 }, frozenMinor: 100 });
    expect(await run('/currency')).toMatchObject({ collect: { status: 409, data: { code: 'BILLING_CURRENCY_MISMATCH', details: { amountMinor: 1000, currencyCode: 'JPY', minorUnitExponent: 0 } } }, previews: 0 });
  } finally { await harness.close(); }
}, 45_000);
