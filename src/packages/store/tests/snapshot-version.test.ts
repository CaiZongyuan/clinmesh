import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';

const throughTriage = [...baseline.tables, { name: 'encounter_triage', rows: [] }];
const previous = { ...baseline, format: 'clinmesh.snapshot.v2', tables: throughTriage, sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };

it.each([baseline, previous])('imports $format and preserves its business facts in v3', async input => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(input);
    const upgraded = await store.exportLogicalSnapshot(baseline.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v3');
    expect(upgraded.tables).toEqual([...throughTriage, { name: 'lab_drafts', rows: [] }, { name: 'lab_requests', rows: [] }]);
    expect(upgraded.pi).toEqual(baseline.pi);
    expect(upgraded.sha256).not.toBe(baseline.sha256);
  } finally { await store.close(); }
});
