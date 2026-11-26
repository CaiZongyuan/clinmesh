import { expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

it('rechecks allocation recovery, frozen ward settlement and surgical projections on real Durable Object SQLite', async () => {
  const harness = createTestHarness({ workers: [{ config: { name: 'billing-contract', main: 'src/packages/mod-drg-cn/tests/billing-worker.ts', compatibility_date: '2026-11-19', compatibility_flags: ['nodejs_compat'], durable_objects: { bindings: [{ name: 'BILLING', class_name: 'BillingWorkspace' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['BillingWorkspace'] }] } }] });
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const run = async (path: string) => { const response = await worker.fetch(path); expect(response.status).toBe(200); return response.json(); };
    expect(await run('/outpatient')).toMatchObject({ blocked: 'FUNDS_PENDING', replay: 'PAYMENT_ALREADY_RESOLVED', excess: 'REFUND_LIMIT', bill: { pending: false, balanceMinor: -10 }, pending: { tenders: [{ method: 'card', amountMinor: 35 }, { method: 'cash', amountMinor: 5 }] } });
    expect(await run('/inpatient')).toMatchObject({ lock: 'BILLING_LOCKED', corrected: { year: 2026 }, account: { balanceMinor: 5, settlement: { cashMinor: 3930, coverageMinor: 4760 } }, review: { archive: { reconciled: true } } });
    expect(await run('/projection')).toMatchObject({ planned: { group: { group: 'FM39', referenceMinor: 1200000 }, costs: { projectedMinor: 240830 } } });
  } finally { await harness.close(); }
}, 45_000);
