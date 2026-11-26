import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';

it('imports the baseline v1 artifact and emits the same business facts in v2', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(baseline);
    const upgraded = await store.exportLogicalSnapshot(baseline.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v2');
    expect(upgraded.tables).toEqual([...baseline.tables, { name: 'encounter_triage', rows: [] }]);
    expect(upgraded.pi).toEqual(baseline.pi);
    expect(upgraded.sha256).not.toBe(baseline.sha256);
  } finally { await store.close(); }
});
