import { expect, it } from 'vitest';
import { z } from 'zod';
import { v7 } from 'uuid';
import { BUILTIN_DATA_PACKS } from '../../../server/builtin-data-packs';
import { installHospitalDataPack } from '../../data-pack';
import { canonicalJson, createNodeSqliteStore, type LogicalSnapshot } from '../../store';
import { sha256 } from '../../platform';
import { createPharmacyModule, dispenseQueueSchema } from '../index';
import { configuredPharmacy, pharmacyClient } from './configured-pharmacy';

const dose = { codeSystem: 'urn:clinmesh:general:drug', code: 'amoxicillin', dose: 500, routeCode: 'PO', timesPerDay: 3, days: 30, quantity: 129 };
const receipt = z.object({ prescriptionId: z.uuidv7() });

it.each(['reviewed', 'FEFO'])('dispenses the exact 129 allocated batches in %s mode and restores the authoritative state', async mode => {
  const { store, session, at } = await configuredPharmacy(pack => {
    pack.knowledge!.pharmacy!.openingStock = Array.from({ length: 129 }, (_, index) => ({ codeSystem: dose.codeSystem, medicationCodes: [dose.code], lotNumber: `RX-${String(index + 1).padStart(3, '0')}`, expiryDate: '2030-01-01', quantity: 1, unit: 'unit' }));
  });
  const restored = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { get, command, applied, start, role } = session;
    const path = await start('Jordan Vale', 'J18.9');
    const { prescriptionId } = receipt.parse(await applied(command(`${path}/prescriptions`, 5, { lines: [dose] })));
    await applied(command(`${path}/complete`, 6));
    await role('pharmacist');
    const [ticket] = dispenseQueueSchema.parse(await get('/api/his/pharmacy/queue'));
    const line = ticket!.lines[0]!;
    const lots = line.lots.map(lot => ({ orderId: line.orderId, lotId: lot.lotId, quantity: 1 }));
    const result = await applied(command(`/api/his/prescriptions/${prescriptionId}/dispense`, 1, mode === 'reviewed' ? { lots } : {}));
    expect(z.object({ allocations: z.array(z.object({ lotNumber: z.string(), quantity: z.int() })) }).parse(result).allocations).toEqual(Array.from({ length: 129 }, (_, index) => ({ lotNumber: `RX-${String(index + 1).padStart(3, '0')}`, quantity: 1 })));
    const snapshot = await store.exportLogicalSnapshot(at.workspaceId);
    await restored.importLogicalSnapshot(snapshot);
    for (const source of [store, restored]) await source.read(reader => {
      expect(reader.get(at, 'prescriptions', prescriptionId)).toMatchObject({ status: 'dispensed', version: 2 });
      expect(reader.list(at, 'dispenses')).toHaveLength(129);
    });
  } finally { await Promise.all([store.close(), restored.close()]); }
});

async function rehash(snapshot: LogicalSnapshot) {
  const { format, workspaceId, tables, pi } = snapshot;
  return { ...snapshot, sha256: await sha256(canonicalJson({ format, workspaceId, tables, pi })) };
}

it('rejects an invalid lot, direction or prescription projection in a resealed current snapshot and leaves the target empty', async () => {
  const { store, session, at } = await configuredPharmacy(() => {});
  const target = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const path = await session.start('Jordan Vale', 'J18.9');
    const { prescriptionId } = receipt.parse(await session.applied(session.command(`${path}/prescriptions`, 5, { lines: [{ ...dose, quantity: 1 }] })));
    await session.applied(session.command(`/api/his/prescriptions/${prescriptionId}/withdraw`, 1, { reason: 'Reassessed' }));
    const snapshot = await store.exportLogicalSnapshot(at.workspaceId);
    expect(snapshot.tables.find(table => table.name === 'prescriptions')?.rows[0]).toMatchObject({ status: 'withdrawn', version: 2 });
    const original = await store.read(reader => reader.list(at, 'prescription_directions')[0]!);
    await expect(store.withTransaction(tx => tx.insert(at, 'prescription_directions', { ...original, directions: { ...original.directions, quantity: 0 } }))).rejects.toBeInstanceOf(z.ZodError);
    for (const [name, fields, failure] of [
      ['inventory_movements', { quantity_delta: -1 }, /negative inventory in lot/],
      ['prescription_directions', { directions: { quantity: 1 } }, /codeSystem/],
      ['prescriptions', { status: 'signed', version: 1 }, /disagrees with its events/],
    ] as const) {
      const changed = structuredClone(snapshot);
      Object.assign(changed.tables.find(table => table.name === name)!.rows[0]!, fields);
      await expect(target.importLogicalSnapshot(await rehash(changed))).rejects.toThrow(failure);
      expect(await target.read(reader => reader.getWorkspace(at.workspaceId))).toBeUndefined();
    }
    await target.importLogicalSnapshot(snapshot);
    expect(await target.exportLogicalSnapshot(at.workspaceId)).toEqual(snapshot);
  } finally { await Promise.all([store.close(), target.close()]); }
});

it('quarantines a legacy lot deficit, dispenses from healthy stock and rejects altered quarantine evidence on restore', async () => {
  const { store, at, ticket } = await configuredPharmacy(() => {});
  const restored = createNodeSqliteStore({ dbPath: ':memory:' });
  const target = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const legacy = await store.exportLogicalSnapshot(at.workspaceId);
    legacy.format = 'clinmesh.snapshot.v4';
    legacy.tables = legacy.tables.slice(0, legacy.tables.findIndex(table => table.name === 'prescription_signatures'));
    const amoxicillin = legacy.tables.find(table => table.name === 'catalog_items')!.rows.find(row => row.code === 'amoxicillin')!;
    const held = legacy.tables.find(table => table.name === 'inventory_lots')!.rows.find(row => row.catalog_item_id === amoxicillin.id && row.lot_number === 'GEN-A')!;
    legacy.tables.find(table => table.name === 'inventory_movements')!.rows.find(row => row.lot_id === held.id)!.quantity_delta = -3;
    await restored.importLogicalSnapshot(await rehash(legacy));
    const lotId = z.uuidv7().parse(held.id);
    await expect(restored.withTransaction(tx => tx.insert(at, 'inventory_movements', { id: v7(), lot_id: lotId, quantity_delta: 4, reason: 'Synthetic receipt', virtual_at: '2026-11-20T00:00:00Z', recorded_at: '2026-11-20T00:00:00Z' }))).rejects.toThrow('quarantined');
    const { session } = await pharmacyClient(restored, ticket);
    const path = await session.start('Jordan Vale', 'J18.9');
    const { prescriptionId } = receipt.parse(await session.applied(session.command(`${path}/prescriptions`, 5, { lines: [{ ...dose, quantity: 5 }] })));
    await session.applied(session.command(`${path}/complete`, 6));
    await session.role('pharmacist');
    const line = dispenseQueueSchema.parse(await session.get('/api/his/pharmacy/queue'))[0]!.lines[0]!;
    expect(line.lots.map(lot => lot.lotNumber)).toEqual(['GEN-B']);
    const dispense = `/api/his/prescriptions/${prescriptionId}/dispense`;
    expect(await (await session.command(dispense, 1, { lots: [{ orderId: line.orderId, lotId, quantity: 5 }] })).json()).toEqual({ code: 'PHARMACY_LOT_MISMATCH' });
    expect(await session.applied(session.command(dispense, 1))).toMatchObject({ allocations: [{ lotNumber: 'GEN-B', quantity: 5 }] });
    const altered = await restored.exportLogicalSnapshot(at.workspaceId);
    altered.tables.find(table => table.name === 'inventory_movements')!.rows.find(row => row.lot_id === held.id)!.reason = 'Changed after migration';
    await expect(target.importLogicalSnapshot(await rehash(altered))).rejects.toThrow('Invalid inventory quarantine');
    expect(await target.read(reader => reader.getWorkspace(at.workspaceId))).toBeUndefined();
  } finally { await Promise.all([store.close(), restored.close(), target.close()]); }
});

it.each(['global-general', 'cn-cardiology'] as const)('restores the frozen medication gate of an existing %s 1.0.0 Epoch', async packId => {
  const source = createNodeSqliteStore({ dbPath: ':memory:' });
  const restored = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const pack = structuredClone(BUILTIN_DATA_PACKS[packId]);
    pack.manifest.version = '1.0.0';
    const encounterId = v7();
    const time = '2026-11-01T00:00:00Z';
    const at = await source.withTransaction(tx => {
      const scope = installHospitalDataPack(tx, { workspaceId: v7(), expectedEpoch: null, virtualTime: time }, pack);
      const patient = tx.list(scope, 'clinical_cases', { encounter_class: 'outpatient' })[0]!;
      const patientId = v7();
      tx.insert(scope, 'patients', { id: patientId, display_name: 'Teaching patient', birth_date: null, version: 1 });
      tx.insert(scope, 'encounters', { id: encounterId, patient_id: patientId, source_case_id: patient.id, encounter_class: 'outpatient', status: 'active', active_practitioner_role: pack.organization.practitionerRoles[0]!.id, version: 1, virtual_at: time, recorded_at: time });
      return scope;
    });
    const snapshot = await source.exportLogicalSnapshot(at.workspaceId);
    const installed = snapshot.tables.find(table => table.name === 'data_pack_installations')!.rows[0]!;
    const knowledge = z.record(z.string(), z.json()).parse(installed.knowledge);
    delete knowledge.pharmacy;
    installed.knowledge = knowledge;
    snapshot.format = 'clinmesh.snapshot.v2';
    snapshot.tables = snapshot.tables.slice(0, snapshot.tables.findIndex(table => table.name === 'charge_sources'));
    await restored.importLogicalSnapshot(await rehash(snapshot));
    const module = createPharmacyModule();
    expect(await restored.read(reader => module.completion!(reader, at, encounterId))).toEqual([]);
  } finally { await Promise.all([source.close(), restored.close()]); }
});
