import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';
import billingBaseline from './fixtures/e3842543-v3.json';
import { patientBaseline } from './patient-baseline';
import patientDelta from './fixtures/61c01899-v4.delta.json';
import labDelta from './fixtures/4cd73c40-v5.delta.json';

const baselineV2 = { ...baseline, format: 'clinmesh.snapshot.v2', tables: [...baseline.tables, { name: 'encounter_triage', rows: [] }], sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };
it.each([baseline, baselineV2, billingBaseline, patientBaseline])('imports $format and emits the previous business facts intact', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const second = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const upgraded = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v7');
    expect(upgraded.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    expect(upgraded.tables.slice(previous.tables.length).filter(table => table.name !== 'inventory_lot_quarantines').every(table => !table.rows.length)).toBe(true);
    const quarantines = upgraded.tables.find(table => table.name === 'inventory_lot_quarantines')!.rows;
    if (previous === billingBaseline || previous === patientBaseline) expect(quarantines).toMatchObject([{ quantity_at_migration: -3, source_version: previous.format, source_sha256: previous.sha256 }]);
    else expect(quarantines).toEqual([]);
    expect(upgraded.pi).toEqual(previous.pi);
    expect(upgraded.sha256).not.toBe(previous.sha256);
    await second.importLogicalSnapshot(upgraded);
    expect(await second.exportLogicalSnapshot(previous.workspaceId)).toEqual(upgraded);
  } finally { await Promise.all([store.close(), second.close()]); }
});

const encoded = readFileSync(new URL('./fixtures/e3842543-v3.json.gz.b64', import.meta.url), 'utf8');
const completeBilling = z.object({ format: z.literal('clinmesh.snapshot.v3'), sha256: z.string(), workspaceId: z.uuidv7(),
  tables: z.array(z.object({ name: z.string(), rows: z.array(z.json()).nonempty() })).length(55), pi: z.array(z.json()).length(2) }).parse(JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')));
const completePatient = { ...completeBilling, format: 'clinmesh.snapshot.v4', sha256: patientDelta.sha256, tables: [
  ...completeBilling.tables.map(table => table.name === 'consultation_turns' ? { ...table, rows: [...table.rows, patientDelta.question] } : table), ...patientDelta.tables,
] };
const completeLab = { ...completePatient, format: 'clinmesh.snapshot.v5', sha256: labDelta.sha256, tables: [...completePatient.tables, ...labDelta.tables] };
const completePharmacy = { ...completeLab, format: 'clinmesh.snapshot.v6', sha256: 'f66d80a5b1f82410aae556bbc0007a6e69951817c401a9b71a846215141442f8', tables: [...completeLab.tables,
  ...['prescription_signatures', 'prescription_directions', 'prescription_withdrawals'].map(name => ({ name, rows: [] })),
  { name: 'inventory_lot_quarantines', rows: [{ workspace_id: '0192eaf2-cb03-7000-8000-000000000001', epoch: '0192eaf2-cb03-7000-8000-000000000002', id: '0192eaf2-cb03-7000-8000-000000000036', source_version: 'clinmesh.snapshot.v5', source_sha256: completeLab.sha256, quantity_at_migration: -3, ledger_fingerprint: '3a54be80-1b67-5634-ab6b-00b08e8cc70d' }] }] };

it.each([completeBilling, completePatient, completeLab, completePharmacy])('restores all previous facts and both Pi sessions from the published $format', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const current = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(current.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    const missing = completePharmacy.tables.slice(previous.tables.length).map(table => table.name);
    expect(current.tables.slice(previous.tables.length, completePharmacy.tables.length).map(table => table.name)).toEqual(missing);
    expect(current.tables.slice(previous.tables.length).filter(table => table.name !== 'inventory_lot_quarantines').every(table => !table.rows.length)).toBe(true);
    if (previous !== completePharmacy) expect(current.tables.find(table => table.name === 'inventory_lot_quarantines')?.rows).toMatchObject([{ source_sha256: previous.sha256, source_version: previous.format, quantity_at_migration: -3 }]);
    expect(current.pi).toEqual(previous.pi);
    expect(current.format).toBe('clinmesh.snapshot.v7');
  } finally { await store.close(); }
});
