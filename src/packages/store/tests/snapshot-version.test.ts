import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';

const v2 = { ...baseline, format: 'clinmesh.snapshot.v2', tables: [...baseline.tables, { name: 'encounter_triage', rows: [] }], sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };

it.each([baseline, v2])('imports $format business facts in v3', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const upgraded = await store.exportLogicalSnapshot(baseline.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v3');
    expect(upgraded.tables).toEqual([...v2.tables, ...['prescription_signatures', 'prescription_directions', 'prescription_withdrawals'].map(name => ({ name, rows: [] }))]);
    expect(upgraded.pi).toEqual(baseline.pi);
    expect(upgraded.sha256).not.toBe(baseline.sha256);
  } finally { await store.close(); }
});
