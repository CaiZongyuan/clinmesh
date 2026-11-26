import { expect, it } from 'vitest';
import { v7 } from 'uuid';
import cardiology from '../../../../data/packs/cn-cardiology/pack.json';
import { allocateBenefits, parseRegionalRules } from '../index';
import { createNodeSqliteStore } from '../../store';
import { inpatientContract } from './inpatient-contract';
import { projectionContract } from './projection-contract';
import { billingFixture } from '../../../server/testing/billing-fixture';
import { createDrgModule, regionalPayer } from '../index';

it('prices mixed product specifications individually, then spends the annual deductible, fund cap and shared personal account', () => {
  const rules = parseRegionalRules(cardiology.knowledge.regionalRules['mod-drg-cn']);
  const plan = rules.plans.find(plan => plan.id === 'employee-v1')!;
  const items = [{ chargeId: v7(), tier: '甲', netMinor: 1000 }, { chargeId: v7(), tier: '乙', netMinor: 1001 }, { chargeId: v7(), tier: '丙', netMinor: 500 }];
  const result = allocateBenefits(rules, plan, 'outpatient', { eligibleMinor: 500, fundMinor: 99700, accountUsedMinor: 1950 }, items);
  expect(result.items.map(item => [item.outsideMinor, item.priorSelfPayMinor, item.eligibleMinor])).toEqual([[0, 0, 1000], [0, 100, 901], [500, 0, 0]]);
  expect(result).toMatchObject({ eligibleMinor: 1901, deductibleMinor: 500, fundMinor: 300, accountMinor: 50, cashMinor: 2151 });
  const resident = rules.plans.find(plan => plan.id === 'resident-v1')!;
  expect(allocateBenefits(rules, resident, 'outpatient', { eligibleMinor: 0, fundMinor: 0, accountUsedMinor: 0 }, items)).toMatchObject({ fundMinor: 0, accountMinor: 0, cashMinor: 2501 });
});

it('rounds the approved amount per prescription after calculating the product tiers', () => {
  const rules = parseRegionalRules(cardiology.knowledge.regionalRules['mod-drg-cn']);
  const plan = rules.plans.find(plan => plan.id === 'employee-v1')!;
  const prescriptionId = v7();
  const calculate = (tiers: string[], grouped: boolean) => allocateBenefits(rules, plan, 'outpatient', { eligibleMinor: 1000, fundMinor: 0, accountUsedMinor: 2000 }, tiers.map(tier => ({ chargeId: v7(), tier, netMinor: 1, ...(grouped && { prescriptionId }) })));
  expect(calculate(['甲', '乙', '丙'], true)).toMatchObject({ eligibleMinor: 2, fundMinor: 1, cashMinor: 2 });
  expect(calculate(['甲', '乙', '甲'], true)).toMatchObject({ eligibleMinor: 3, fundMinor: 2, cashMinor: 1 });
  expect(calculate(['甲', '乙', '甲'], false)).toMatchObject({ fundMinor: 0 });
});

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
    expect(result.planned).toMatchObject({ group: { group: 'FM39', referenceMinor: 1200000 }, basis: 'planned', costs: { incurredMinor: 20780, committedMinor: 50, reservedMinor: 40000, plannedMinor: 180000, projectedMinor: 240830 } });
    expect(result.performed).toMatchObject({ basis: 'performed', costs: { plannedMinor: 0, projectedMinor: null, missing: [expect.stringMatching(/^unposted-procedure:/)] } });
    expect(result.ambiguous).toMatchObject({ group: null, progress: 'unavailable', archive: { determination: { group: 'FM39', referenceMinor: 1200000, approvedMinor: 1080000 } } });
  } finally { await store.close(); }
});

it('keeps ward deposits local, freezes the reviewed itemized settlement and appends a correction after archival', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const result = await inpatientContract(store);
    expect(result).toMatchObject({ claim: { allocations: { eligibleMinor: 8450, fundMinor: 2760, accountMinor: 2000, cashMinor: 3940 } }, liability: 3840, pending: 'FUNDS_PENDING', stale: 'PAYER_REVIEW_REQUIRED', lock: 'BILLING_LOCKED', corrected: { year: 2026 }, pendingCorrection: 'PAYER_REVIEW_REQUIRED', account: { netMinor: 8715, balanceMinor: 5, coverageMinor: 4780, settlement: { netMinor: 8690, cashMinor: 3930, coverageMinor: 4760 } }, review: { archive: { archived: true, reconciled: true, determination: null } } });
  } finally { await store.close(); }
});
