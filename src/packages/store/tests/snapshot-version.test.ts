import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';

const baselineV2 = { ...baseline, format: 'clinmesh.snapshot.v2', tables: [...baseline.tables, { name: 'encounter_triage', rows: [] }], sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };
const accounts = ['charge_sources', 'billing_previews', 'billing_attempts', 'billing_recoveries', 'billing_releases', 'billing_settlements'];
const baselineV3 = { ...baselineV2, format: 'clinmesh.snapshot.v3', tables: [...baselineV2.tables, ...accounts.map(name => ({ name, rows: [] }))], sha256: '7234ad6603c4b14451e97faa6ef4e1f701e7fd3f6ebcfc2a4de739e350708e96' };
it.each([baseline, baselineV2, baselineV3])('imports $format and emits the previous business facts intact', async previous => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(previous);
    const upgraded = await store.exportLogicalSnapshot(baseline.workspaceId);
    expect(upgraded.format).toBe('clinmesh.snapshot.v4');
    expect(upgraded.tables.slice(0, previous.tables.length)).toEqual(previous.tables);
    expect(upgraded.tables.slice(previous.tables.length).every(table => !table.rows.length)).toBe(true);
    expect(upgraded.pi).toEqual(baseline.pi);
    expect(upgraded.sha256).not.toBe(baseline.sha256);
  } finally { await store.close(); }
});
