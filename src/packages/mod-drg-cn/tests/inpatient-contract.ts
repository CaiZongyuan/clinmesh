import { v7 } from 'uuid';
import type { StorePort } from '../../store';
import { createDrgModule, regionalPayer } from '../index';
import { billingFixture } from '../../../server/testing/billing-fixture';

export async function inpatientContract(store: StorePort) {
  const fixture = await billingFixture(store, 'cardiology', true, { payerBenefit: regionalPayer });
  const { at, instant, encounterId, admissionId, catalog, billing, order, command, read } = fixture;
  const region = createDrgModule(billing);
  catalog.contribute(region.id, region.registerOperations);
  const medication = await order('perindopril', 100);
  await order('aspirin', 10);
  const outside = await order('ezetimibe', 2);
  const deposit = await command('inpatient.deposit.preview', { amountMinor: 100, simulation: 'delayed-approval' });
  const payment = await command('inpatient.deposit.confirm', { commitToken: deposit.commitToken });
  const code = async (attempt: Promise<unknown>) => { try { await attempt; return 'accepted'; } catch (error) { return (error as { code?: string }).code ?? 'invalid'; } };
  const pending = await code(command('inpatient.settlement.preview'));
  await command('payment.recover', { paymentId: payment.paymentId, paymentVersion: 1 });
  await store.withTransaction(tx => tx.update(at, 'inpatient_admissions', admissionId, 1, { status: 'departed' }));
  const ids = (await read()).charges.map(line => line.id);
  const claim = await command('benefit.preview', { planId: 'employee-v1', chargeIds: ids });
  const original = await command('benefit.confirm', { planId: 'employee-v1', chargeIds: ids, fingerprint: claim.fingerprint });
  const liability = (await read()).balanceMinor;
  const topup = await command('inpatient.deposit.preview', { amountMinor: liability });
  await command('inpatient.deposit.confirm', { commitToken: topup.commitToken });
  const before = await command('inpatient.settlement.preview');
  await command('charge.adjust', { chargeId: outside.chargeId, amountMinor: 10, reason: 'Audited price correction' });
  const stale = await code(command('inpatient.discharge.settle', { commitToken: before.commitToken }));
  await command('benefit.cancel', { claimId: original.claimId, annualVersion: 1 });
  const reprice = async () => {
    const fields = { planId: 'employee-v1', chargeIds: ids };
    const quote = await command('benefit.preview', fields);
    const receipt = await command('benefit.confirm', { ...fields, fingerprint: quote.fingerprint });
    return { claimId: receipt.claimId, year: quote.year };
  };
  const replacement = await reprice();
  const refund = await command('inpatient.refund.preview', { paymentId: payment.paymentId, amountMinor: 10, reason: 'Overpayment' });
  await command('inpatient.refund.confirm', { commitToken: refund.commitToken });
  const latest = await command('inpatient.settlement.preview');
  await command('inpatient.discharge.settle', { commitToken: latest.commitToken });
  const lock = await code(order('aspirin'));
  await store.withTransaction(tx => tx.insert(at, 'medical_record_archives', { id: v7(), admission_id: admissionId, archive: { synthetic: true }, virtual_at: instant, recorded_at: instant }));
  await command('inpatient.correction', { chargeId: medication.chargeId, amountMinor: 25, reason: 'Post-settlement correction' });
  await store.withTransaction(tx => tx.updateEpoch(at, 0, { virtual_time: '2027-01-03T00:00:00Z' }));
  const pendingCorrection = await code(command('inpatient.deposit.preview', { amountMinor: 25 }));
  await command('benefit.cancel', { claimId: replacement.claimId, annualVersion: 3 });
  const corrected = await reprice();
  return { claim, liability, pending, stale, lock, corrected, pendingCorrection, account: await read(), review: await fixture.call('drg.summary'), encounterId };
}
