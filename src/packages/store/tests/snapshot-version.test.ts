import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';
import billingBaseline from './fixtures/e3842543-v3.json';

const baselineV2 = { ...baseline, format: 'clinmesh.snapshot.v2', tables: [...baseline.tables, { name: 'encounter_triage', rows: [] }], sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };
it.each([baseline, baselineV2, billingBaseline])('imports $format and emits the previous business facts intact', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const upgraded = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v4');
    expect(upgraded.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    expect(upgraded.tables.slice(previous.tables.length).every(table => !table.rows.length)).toBe(true);
    expect(upgraded.pi).toEqual(previous.pi);
    expect(upgraded.sha256).not.toBe(previous.sha256);
  } finally { await store.close(); }
});
