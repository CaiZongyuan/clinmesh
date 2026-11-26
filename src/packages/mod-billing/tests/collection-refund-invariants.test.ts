import { v7 } from 'uuid';
import { expect, it } from 'vitest';
import { z } from 'zod';
import general from '../../../../data/packs/global-general/pack.json';
import { installHospitalDataPack } from '../../data-pack';
import { OperationCatalog, type Credential } from '../../platform';
import { createNodeSqliteStore } from '../../store';
import { createBillingModule, formatMinor, parseMinor } from '../index';

it('preserves integer minor units for both JPY and USD up to the safe integer limit', () => {
  const yen = { code: 'JPY', minorUnitExponent: 0 }, dollar = { code: 'USD', minorUnitExponent: 2 };
  expect(formatMinor(1234, yen)).toBe('JPY 1234');
  expect(formatMinor(Number.MAX_SAFE_INTEGER, dollar)).toBe('USD 90071992547409.91');
  expect(parseMinor('90071992547409.91', dollar)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => parseMinor('1.1', yen)).toThrow();
  expect(() => parseMinor('90071992547409.92', dollar)).toThrow();
});

it('recovers one shared collection for two charges and reserves each original allocation against concurrent refunds', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const billing = createBillingModule();
  const catalog = new OperationCatalog();
  catalog.contribute(billing.id, billing.registerOperations);
  const encounterId = v7(), patientId = v7(), sessionId = v7();
  const now = '2026-11-26T00:00:00Z', expiresAt = '2099-01-01T00:00:00Z';
  const chargeIds = [v7(), v7()];
  try {
    const at = await store.withTransaction(tx => {
      const at = installHospitalDataPack(tx, { workspaceId: v7(), virtualTime: now, expectedEpoch: null }, general);
      tx.insert(at, 'visitor_sessions', { id: sessionId, practitioner_role: 'cashier', version: 1, expires_at: expiresAt, revoked: false });
      tx.insert(at, 'patients', { id: patientId, display_name: 'Synthetic account', birth_date: null, version: 1 });
      tx.insert(at, 'encounters', { id: encounterId, patient_id: patientId, source_case_id: tx.list(at, 'clinical_cases')[0]!.id, encounter_class: 'outpatient', status: 'active', active_practitioner_role: 'cashier', virtual_at: now, recorded_at: now, version: 1 });
      for (const chargeId of chargeIds) tx.insert(at, 'charge_items', { id: chargeId, encounter_id: encounterId, order_id: null, description: 'Teaching service', amount_minor: 50, currency_code: 'USD', currency_exponent: 2, virtual_at: now, recorded_at: now });
      return at;
    });
    const credential: Credential = { ticket: { kind: 'visitor', workspaceId: at.workspaceId, id: sessionId, expiresAt } };
    const run = async (name: string, fields: Record<string, unknown>) => {
      const version = await store.read(reader => billing.readAccount(reader, at, encounterId).version);
      return z.record(z.string(), z.json()).parse(await catalog.require(name).invoke({ store, credential, targetId: encounterId, body: async () => ({ ...fields, expectedVersion: version, epoch: at.epoch, idempotencyKey: v7() }) }));
    };
    const selected = { chargeIds, tenders: [{ method: 'cash', amountMinor: 50 }, { method: 'card', amountMinor: 50 }], simulation: 'delayed-approval' };
    const frozen = await run('payment.preview', selected);
    const payment = await run('payment.confirm', { commitToken: frozen.commitToken });
    await expect(run('payment.preview', selected)).rejects.toMatchObject({ code: 'FUNDS_PENDING' });
    await run('payment.recover', { paymentId: payment.paymentId, paymentVersion: 1 });
    const adjustment = { chargeId: chargeIds[0], reason: 'Duplicate service', amountMinor: 20 };
    await run('charge.adjust', adjustment);
    const refund = await run('refund.allocation.preview', { ...adjustment, paymentId: payment.paymentId });
    expect(refund.tenders).toEqual([{ method: 'cash', amountMinor: 20 }]);
    const attempts = await Promise.allSettled([0, 1].map(() => run('refund.allocation.confirm', { commitToken: refund.commitToken })));
    expect(attempts.filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
    expect(await store.read(reader => billing.readAccount(reader, at, encounterId))).toMatchObject({ netMinor: 80, cashMinor: 80, balanceMinor: 0 });
  } finally { await store.close(); }
});
