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
    expect(upgraded.format).toBe('clinmesh.snapshot.v6');
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

it.each([completeBilling, completePatient, completeLab])('restores all nonempty tables and both Pi sessions from the published $format', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const current = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(current.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    const missing = [...(previous.format === 'clinmesh.snapshot.v3' ? ['patient_reply_runs', 'agent_model_calls'] : []), ...(previous.format !== 'clinmesh.snapshot.v5' ? ['lab_drafts', 'lab_requests'] : []), 'prescription_signatures', 'prescription_directions', 'prescription_withdrawals', 'inventory_lot_quarantines'];
    expect(current.tables.slice(previous.tables.length).map(table => table.name)).toEqual(missing);
    expect(current.tables.slice(previous.tables.length, -1).every(table => !table.rows.length)).toBe(true);
    expect(current.tables.at(-1)?.rows).toMatchObject([{ source_sha256: previous.sha256, source_version: previous.format, quantity_at_migration: -3 }]);
    expect(current.pi).toEqual(previous.pi);
    expect(current.format).toBe('clinmesh.snapshot.v6');
  } finally { await store.close(); }
});
