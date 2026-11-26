import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { teachingGate, withNodeDatabase } from '../../scripts/testing/node-workspace';
import { createNodeSqliteStore } from '../packages/store';
import { sessionSchema, sha256 } from '../packages/platform';
import { z } from 'zod';

it('retains an authenticated workspace across Node process restarts and keeps its host authority outside logical snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-session-reopen-'));
  const dbPath = join(directory, 'teaching.sqlite');
  let cookie = '';
  let workspaceId = '';
  let epoch = '';
  let token = '';
  try {
    await withNodeDatabase(dbPath, async origin => {
      const response = await fetch(`${origin}/api/auth/visitor/enter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
      const session = sessionSchema.parse(await response.json());
      workspaceId = session.workspaceId;
      epoch = session.epoch;
      cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      const post = (path: string, expectedVersion: number, fields: Record<string, unknown>) => fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ epoch, idempotencyKey: crypto.randomUUID(), expectedVersion, ...fields }) });
      expect((await post('/api/workspace/role', 1, { roleId: 'coordinator' })).status).toBe(200);
      token = z.object({ token: z.string() }).parse(await (await post('/api/workspace/capabilities', 0, { roleId: 'family-clinician', allowedOperations: ['encounter.list'], ttlSeconds: 300 })).json()).token;
    });
    await withNodeDatabase(dbPath, async origin => {
      const response = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(sessionSchema.parse(await response.json()).workspaceId).toBe(workspaceId);
      expect((await fetch(`${origin}/api/his/encounters`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    });
    const store = createNodeSqliteStore({ dbPath });
    const restored = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const snapshot = await store.exportLogicalSnapshot(workspaceId);
      const tableNames = snapshot.tables.map(table => table.name);
      expect(tableNames).toContain('visitor_sessions');
      expect(tableNames).not.toContain('visitor_gate_authority');
      expect(tableNames).not.toContain('encounter_triage');
      expect(JSON.stringify(snapshot).includes(await store.visitorSigningSecret())).toBe(false);
      expect(JSON.stringify(snapshot).includes(token)).toBe(false);
      const grants = await store.read(reader => reader.list({ workspaceId, epoch }, 'capability_tokens'));
      expect(grants.length === 1 && grants[0]!.token_hash === await sha256(token)).toBe(true);
      await restored.importLogicalSnapshot(snapshot);
      expect((await restored.exportLogicalSnapshot(workspaceId)).sha256).toBe(snapshot.sha256);
    } finally { await Promise.all([store.close(), restored.close()]); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
