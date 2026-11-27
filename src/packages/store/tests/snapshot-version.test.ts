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
import pharmacyDelta from './fixtures/cc914872-v6.delta.json';

const baselineV2 = { ...baseline, format: 'clinmesh.snapshot.v2', tables: [...baseline.tables, { name: 'encounter_triage', rows: [] }], sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };
it.each([baseline, baselineV2, billingBaseline, patientBaseline])('imports $format and emits the previous business facts intact', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const second = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const upgraded = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v8');
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

function publishedPharmacy() {
  const tables = new Map<string, z.core.util.JSONType[]>(completeLab.tables.map(table => [table.name, table.rows]));
  for (const { name, rows } of pharmacyDelta.tables) {
    const revised = new Set(rows.map(row => row.id));
    const retained = (tables.get(name) ?? []).filter(row => !revised.has(z.object({ id: z.string() }).parse(row).id));
    tables.set(name, [...retained, ...rows]);
  }
  return { ...completeLab, sha256: pharmacyDelta.sha256, format: 'clinmesh.snapshot.v6', tables: Array.from(tables, ([name, rows]) => ({ name, rows })) };
}
const pharmacy = publishedPharmacy();
const publishedStudies = { ...pharmacy, sha256: 'aeb858bcecb306ee0a74b86b47bc578d45cf84ce328cb4d9bb1244650baf4201', format: 'clinmesh.snapshot.v7', tables: [...pharmacy.tables, { name: 'study_requests', rows: [{ workspace_id: '0192eaf2-cb03-7000-8000-000000000001', epoch: '0192eaf2-cb03-7000-8000-000000000002', id: '0192eaf2-cb03-7000-8000-000000000104', order_id: '0192eaf2-cb03-7000-8000-000000000030', stages: ['initial'], prior_surgery_id: 'teaching-specimen' }] }] };
it.each([pharmacy, publishedStudies])('preserves all published $format facts, including both Pi sessions', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const current = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(current.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    expect(current.tables.slice(previous.tables.length).every(table => !table.rows.length)).toBe(true);
    expect(current.pi).toEqual(previous.pi);
  } finally { await store.close(); }
});

it.each([completeBilling, completePatient, completeLab])('restores all nonempty tables and both Pi sessions from the published $format', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const current = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(current.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    const missing = [...(previous.format === 'clinmesh.snapshot.v3' ? ['patient_reply_runs', 'agent_model_calls'] : []), ...(previous.format !== 'clinmesh.snapshot.v5' ? ['lab_drafts', 'lab_requests'] : []), 'prescription_signatures', 'prescription_directions', 'prescription_withdrawals', 'inventory_lot_quarantines', 'study_requests'];
    expect(current.tables.slice(previous.tables.length, previous.tables.length + missing.length).map(table => table.name)).toEqual(missing);
    expect(current.tables.slice(previous.tables.length).filter(table => table.name !== 'inventory_lot_quarantines').every(table => !table.rows.length)).toBe(true);
    expect(current.tables.find(table => table.name === 'inventory_lot_quarantines')?.rows).toMatchObject([{ source_sha256: previous.sha256, source_version: previous.format, quantity_at_migration: -3 }]);
    expect(current.pi).toEqual(previous.pi);
    expect(current.format).toBe('clinmesh.snapshot.v8');
  } finally { await store.close(); }
});
