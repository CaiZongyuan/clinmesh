import { v7 } from 'uuid';
import type { StorePort } from '../../packages/store';
import { billingFixture } from './billing-fixture';

export async function firstSettlementContract(store: StorePort) {
  const { at, admissionId, encounterId, instant, pack, billing, catalog, command, read } = await billingFixture(store, 'cardiology', true);
  const times = { virtual_at: instant, recorded_at: instant };
  const orderId = v7(), surgeryId = v7(), reservationId = v7(), lotId = v7(), useId = v7();
  await store.withTransaction(tx => {
    const procedure = tx.list(at, 'catalog_items', { code: '36.0700' })[0]!;
    const wire = tx.list(at, 'catalog_items', { code: 'wire-014' })[0]!;
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: encounterId, catalog_item_id: procedure.id, kind: 'surgery', status: 'signed', version: 1, ...times });
    tx.insert(at, 'surgery_requests', { id: surgeryId, order_id: orderId, procedure_item_id: procedure.id, status: 'completed', version: 1 });
    tx.insert(at, 'surgery_executions', { id: v7(), surgery_request_id: surgeryId, outcome: 'completed', ...times });
    billing.freezeCharge(tx, at, { encounterId, orderId, catalogItemId: procedure.id, catalogVersion: pack.manifest.version, quantity: 1, unitPriceMinor: procedure.amount_minor!, currencyCode: 'CNY', currencyExponent: 2, recordedAt: instant, virtualAt: instant });
    tx.insert(at, 'inventory_lots', { id: lotId, catalog_item_id: wire.id, lot_number: 'teaching', expiry_date: '2028-01-01', unit: 'each' });
    tx.insert(at, 'inventory_movements', { id: v7(), lot_id: lotId, quantity_delta: 1, reason: 'opening-stock', ...times });
    tx.insert(at, 'material_reservations', { id: reservationId, surgery_request_id: surgeryId, lot_id: lotId, quantity: 1, status: 'reserved', version: 1 });
    tx.update(at, 'inpatient_admissions', admissionId, 1, { status: 'departed' });
  });
  const pay = async (amountMinor: number) => {
    const frozen = await command('inpatient.deposit.preview', { amountMinor });
    await command('inpatient.deposit.confirm', { commitToken: frozen.commitToken });
  };
  const resultOf = async (task: Promise<unknown>) => { try { await task; return 'settled'; } catch (error) { return (error as Error).message; } };
  const clear = () => store.read(reader => billing.readAdmissionFunds(reader, at, encounterId));
  await pay(180000);
  const original = await command('inpatient.settlement.preview');
  await store.withTransaction(tx => {
    const movementId = v7();
    tx.insert(at, 'inventory_movements', { id: movementId, lot_id: lotId, quantity_delta: -1, reason: 'used', ...times });
    tx.insert(at, 'material_uses', { id: useId, movement_id: movementId, reservation_id: reservationId, quantity: 1, ...times });
  });
  const old = await resultOf(command('inpatient.discharge.settle', { commitToken: original.commitToken }));
  const pending = await clear();
  if (old === 'settled') return { old, pending };
  const preview = await resultOf(command('inpatient.settlement.preview'));
  await store.withTransaction(tx => billing.freezeMaterialUse(tx, at, useId));
  const due = await resultOf(command('inpatient.settlement.preview'));
  await pay(20000);
  const replay = await resultOf(command('inpatient.discharge.settle', { commitToken: original.commitToken }));
  const revised = await command('inpatient.settlement.preview');
  await command('inpatient.discharge.settle', { commitToken: revised.commitToken });
  return { old, pending, preview, due, replay, cleared: await clear(), snapshot: (await read()).settlement, regional: catalog.entries.some(entry => entry.name === 'drg.summary') };
}

export async function freeDischargeContract(store: StorePort) {
  const { at, admissionId, encounterId, instant, billing, catalog, order, read } = await billingFixture(store, 'free', true);
  const signed = await order();
  const funds = await store.withTransaction(tx => {
    tx.insert(at, 'diagnostic_reports', { id: v7(), order_id: signed.orderId, revision: 1, previous_revision_id: null, signed_by: 'clinical', findings: {}, virtual_at: instant, recorded_at: instant });
    tx.update(at, 'inpatient_admissions', admissionId, 1, { status: 'departed' });
    return billing.readAdmissionFunds(tx, at, encounterId);
  });
  const account = await read();
  return { funds, regional: catalog.entries.some(entry => entry.name === 'drg.summary'), charges: account.charges.length, payments: account.payments.length };
}
