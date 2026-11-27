import { v7 } from 'uuid';
import type { StorePort } from '../../packages/store';
import { billingFixture } from './billing-fixture';
import { createDrgModule, projectionSchema, regionalPayer } from '../../packages/mod-drg-cn';

export async function projectionContract(store: StorePort) {
  const { at, instant, encounterId, catalog, billing, order, command, call } = await billingFixture(store, 'cardiology', true, { payerBenefit: regionalPayer });
  const region = createDrgModule(billing);
  catalog.contribute(region.id, region.registerOperations);
  const service = await order('renal');
  await command('charge.adjust', { chargeId: service.chargeId, amountMinor: 20, reason: 'Price correction' });
  const useId = v7(), lotId = v7(), reservationId = v7();
  const surgeryId = await store.withTransaction(tx => {
    const times = { recorded_at: instant, virtual_at: instant };
    const diagnosis = tx.list(at, 'catalog_items', { code: 'I25.103' })[0]!;
    tx.appendDiagnosisRevision(at, { id: v7(), encounter_id: encounterId, revision: 1, previous_revision_id: null, confirmed_by: 'clinical', ...times }, [{ id: v7(), code_system: diagnosis.code_system, code: diagnosis.code, is_primary: true, poa_code: null, ordinal: 1 }]);
    const drug = tx.list(at, 'catalog_items', { code: 'aspirin' })[0]!;
    tx.insert(at, 'clinical_orders', { id: v7(), encounter_id: encounterId, catalog_item_id: drug.id, version: 1, kind: 'medication', status: 'signed', ...times });
    const procedure = tx.list(at, 'catalog_items', { code: '36.0700' })[0]!;
    const orderId = v7(), surgeryId = v7();
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: encounterId, catalog_item_id: procedure.id, version: 1, kind: 'surgery', status: 'signed', ...times });
    tx.insert(at, 'surgery_requests', { id: surgeryId, order_id: orderId, procedure_item_id: procedure.id, status: 'planned', version: 1 });
    const wire = tx.list(at, 'catalog_items', { code: 'wire-014' })[0]!;
    tx.insert(at, 'inventory_lots', { id: lotId, catalog_item_id: wire.id, lot_number: 'synthetic', expiry_date: '2027-01-01', unit: 'each' });
    tx.insert(at, 'material_reservations', { id: reservationId, surgery_request_id: surgeryId, lot_id: lotId, quantity: 2, status: 'reserved', version: 1 });
    return surgeryId;
  });
  const reserved = projectionSchema.parse(await call('drg.summary'));
  await store.withTransaction(tx => {
    const movementId = v7(), times = { recorded_at: instant, virtual_at: instant };
    tx.insert(at, 'inventory_movements', { id: movementId, lot_id: lotId, quantity_delta: -1, reason: 'used', ...times });
    tx.insert(at, 'material_uses', { id: useId, movement_id: movementId, reservation_id: reservationId, quantity: 1, ...times });
  });
  const awaitingMaterial = projectionSchema.parse(await call('drg.summary'));
  await store.withTransaction(tx => { billing.freezeMaterialUse(tx, at, useId); billing.freezeMaterialUse(tx, at, useId); });
  const planned = projectionSchema.parse(await call('drg.summary'));
  await store.withTransaction(tx => tx.insert(at, 'surgery_executions', { id: v7(), surgery_request_id: surgeryId, outcome: 'completed', recorded_at: instant, virtual_at: instant }));
  const performed = projectionSchema.parse(await call('drg.summary'));
  await store.withTransaction(tx => {
    const procedure = tx.list(at, 'catalog_items', { code: '88.5500' })[0]!;
    const orderId = v7();
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: encounterId, catalog_item_id: procedure.id, version: 1, kind: 'surgery', status: 'signed', recorded_at: instant, virtual_at: instant });
    tx.insert(at, 'surgery_requests', { id: v7(), order_id: orderId, procedure_item_id: procedure.id, status: 'planned', version: 1 });
    const admission = tx.list(at, 'inpatient_admissions', { encounter_id: encounterId })[0]!;
    tx.insert(at, 'medical_record_archives', { id: v7(), admission_id: admission.id, archive: { payerDetermination: { group: 'FM39', referenceMinor: 1200000, approvedMinor: 1080000 } }, recorded_at: instant, virtual_at: instant });
  });
  return { reserved, awaitingMaterial, planned, performed, ambiguous: projectionSchema.parse(await call('drg.summary')) };
}

export async function unpostedInvestigationContract(store: StorePort) {
  const { at, instant, encounterId, catalog, billing, call, pack } = await billingFixture(store, 'cardiology', true);
  const module = createDrgModule(billing);
  catalog.contribute(module.id, module.registerOperations);
  const orderId = v7();
  const now = { recorded_at: instant, virtual_at: instant };
  const item = await store.withTransaction(tx => {
    const item = tx.list(at, 'catalog_items', { code: 'renal' })[0]!;
    tx.insert(at, 'clinical_orders', { id: orderId, encounter_id: encounterId, catalog_item_id: item.id, version: 1, kind: 'lab', status: 'signed', ...now });
    return item;
  });
  const read = async () => projectionSchema.parse(await call('drg.summary')).costs;
  const before = await read();
  await store.withTransaction(tx => tx.insert(at, 'diagnostic_reports', { id: v7(), order_id: orderId, revision: 1, previous_revision_id: null, signed_by: 'clinical', findings: {}, ...now }));
  const awaiting = await read();
  await store.withTransaction(tx => billing.freezeCharge(tx, at, { encounterId, orderId, catalogItemId: item.id, catalogVersion: pack.manifest.version, quantity: 1, unitPriceMinor: 800, currencyCode: 'CNY', currencyExponent: 2, virtualAt: instant, recordedAt: instant }));
  return { before, awaiting, after: await read() };
}
