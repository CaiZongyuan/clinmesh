import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createNodeSqliteStore } from '../index';
import baseline from './fixtures/c4a83b8-v1.json';

const baselineV2 = { ...baseline, format: 'clinmesh.snapshot.v2', tables: [...baseline.tables, { name: 'encounter_triage', rows: [] }], sha256: 'da0e04ceb63d8912c5a11d4ebabb1be1f10497bd42e1c88d96f1d21043c6971f' };
it.each([baseline, baselineV2])('imports $format and emits the previous business facts intact', async previous => {
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

it('imports the complete published v3 billing and Pi snapshot from e3842543', async () => {
  const encoded = readFileSync(new URL('./fixtures/e3842543-v3.json.gz.b64', import.meta.url), 'utf8');
  const raw: unknown = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
  const previous = z.object({ workspaceId: z.uuidv7(), tables: z.array(z.object({ name: z.string(), rows: z.array(z.json()).nonempty() })).length(55), pi: z.array(z.json()).length(2) }).parse(raw);
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    await store.importLogicalSnapshot(raw);
    const current = await store.exportLogicalSnapshot(previous.workspaceId);
    expect(current.tables).toEqual([...previous.tables, { name: 'lab_drafts', rows: [] }, { name: 'lab_requests', rows: [] }]);
    expect(current.pi).toEqual(previous.pi);
    expect(current.format).toBe('clinmesh.snapshot.v4');
  } finally { await store.close(); }
});
