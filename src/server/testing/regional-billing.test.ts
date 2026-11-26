import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../../packages/store';
import { inpatientContract } from './inpatient-contract';
import { projectionContract, unpostedInvestigationContract } from './projection-contract';
import { billingFixture } from './billing-fixture';
import { createDrgModule, regionalPayer } from '../../packages/mod-drg-cn';

it('keeps the original release fact while reversing eligibility when a prepaid claim is cancelled', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { at, encounterId, catalog, billing, order, command, read } = await billingFixture(store, 'cardiology', false, { payerBenefit: regionalPayer });
    const region = createDrgModule(billing);
    catalog.contribute(region.id, region.registerOperations);
    const first = await order('perindopril');
    await store.withTransaction(tx => tx.update(at, 'encounters', encounterId, 1, { status: 'completed' }));
    const selection = { planId: 'employee-v1', chargeIds: [first.chargeId] };
    const quoted = await command('benefit.preview', selection);
    const claim = await command('benefit.confirm', { ...selection, fingerprint: quoted.fingerprint });
    expect((await read()).charges[0]).toMatchObject({ released: true, releaseRecorded: true });
    await command('benefit.cancel', { claimId: claim.claimId, annualVersion: 1 });
    expect((await read()).charges[0]).toMatchObject({ released: false, releaseRecorded: true });
    expect(await store.read(reader => billing.readOrderFunds(reader, at, first.orderId))).toMatchObject({ state: 'unpaid', released: false, releaseRecorded: true });
  } finally { await store.close(); }
});

it('uses the synthetic group reference and counts incurred work, commitments, unused reservations and planned surgery once', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const result = await projectionContract(store);
    expect(result.reserved.costs).toMatchObject({ incurredMinor: 780, reservedMinor: 40000, projectedMinor: 220830 });
    expect(result.awaitingMaterial.costs).toMatchObject({ incurredMinor: 780, reservedMinor: 20000, projectedMinor: null, missing: [expect.stringMatching(/^unposted-material-use:/)] });
    expect(result.planned).toMatchObject({ group: { group: 'FM39', referenceMinor: 1200000 }, basis: 'planned', costs: { incurredMinor: 20780, committedMinor: 50, reservedMinor: 20000, plannedMinor: 180000, projectedMinor: 220830 } });
    expect(result.performed).toMatchObject({ basis: 'performed', costs: { plannedMinor: 0, projectedMinor: null, missing: [expect.stringMatching(/^unposted-procedure:/)] } });
    expect(result.ambiguous).toMatchObject({ group: null, progress: 'unavailable', archive: { determination: { group: 'FM39', referenceMinor: 1200000, approvedMinor: 1080000 } } });
  } finally { await store.close(); }
});

it('marks a reported investigation as pending financial posting until its original charge is recorded once', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    expect(await unpostedInvestigationContract(store)).toMatchObject({ before: { incurredMinor: 0, committedMinor: 800, projectedMinor: 800 }, awaiting: { incurredMinor: 0, committedMinor: 0, projectedMinor: null, missing: [expect.stringMatching(/^unposted-order:/)] }, after: { incurredMinor: 800, committedMinor: 0, projectedMinor: 800, missing: [] } });
  } finally { await store.close(); }
});

it('keeps ward deposits local, freezes the reviewed itemized settlement and appends a correction after archival', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const result = await inpatientContract(store);
    expect(result).toMatchObject({ claim: { allocations: { eligibleMinor: 8450, fundMinor: 2760, accountMinor: 2000, cashMinor: 3940 } }, liability: 3840, pending: 'FUNDS_PENDING', stale: 'PAYER_REVIEW_REQUIRED', lock: 'BILLING_LOCKED', corrected: { year: 2026 }, pendingCorrection: 'PAYER_REVIEW_REQUIRED', account: { netMinor: 8715, balanceMinor: 5, coverageMinor: 4780, settlement: { netMinor: 8690, cashMinor: 3930, coverageMinor: 4760 } }, review: { archive: { archived: true, reconciled: true, determination: null } } });
  } finally { await store.close(); }
});
