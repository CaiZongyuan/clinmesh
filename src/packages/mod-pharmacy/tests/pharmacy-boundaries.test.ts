import { expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalJson, createNodeSqliteStore, type LogicalSnapshot } from '../../store';
import { sha256 } from '../../platform';
import { dispenseQueueSchema } from '../index';
import { configuredPharmacy } from './configured-pharmacy';

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

it('rejects an invalid lot, direction or prescription projection in a correctly signed v3 snapshot and leaves the target empty', async () => {
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

it('keeps the completion contract of an Epoch with no installed pharmacy rules', async () => {
  const { store, session } = await configuredPharmacy(pack => { delete pack.knowledge!.pharmacy; pack.manifest.version = '1.0.0'; });
  try {
    const path = await session.start('Riley Dale', 'J06.9');
    expect(await session.get(`${path}/completion`)).toMatchObject({ ready: true });
    await session.applied(session.command(`${path}/complete`, 5));
    expect(await session.get(path)).toMatchObject({ status: 'completed', completion: { ready: true } });
  } finally { await store.close(); }
});
