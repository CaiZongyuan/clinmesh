import { expect, it } from 'vitest';
import { teachingGate } from '../../scripts/testing/node-workspace';
import { createNodeSqliteStore } from '../packages/store';
import { sessionSchema, type ClinMeshModule, type OperationCatalog } from '../packages/platform';
import { createApp } from './app';
import { createWorkspaceApp } from './workspace';

it('awaits module initialization in order and rolls back a rejected enter or reset including its Epoch and session', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const settings = { ...teachingGate, loadSigningSecret: () => store.visitorSigningSecret() };
  let reject = true;
  let attemptedWorkspace = '';
  const hooks: string[] = [];
  const modules: ClinMeshModule<OperationCatalog>[] = ['mod-lab', 'mod-pharmacy'].map(id => ({ id, version: '1', kind: 'clinical', async initializeEpoch(tx, at) {
    attemptedWorkspace = at.workspaceId;
    await Promise.resolve();
    expect(tx.getEpoch(at)?.status).toBe('active');
    hooks.push(id);
    if (reject && id === 'mod-pharmacy') throw Error('Synthetic initialization failure');
  } }));
  const workspace = createWorkspaceApp(store, settings, modules);
  const app = createApp('node', settings, (incoming, credential, entering) => workspace.fetch(incoming, { credential, entering }), modules);
  const enter = () => app.request('/api/auth/visitor/enter', { method: 'POST', body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  try {
    expect((await enter()).status).toBe(500);
    expect(await store.read(reader => reader.getWorkspace(attemptedWorkspace))).toBeUndefined();
    expect(hooks).toEqual(['mod-lab', 'mod-pharmacy']);
    reject = false;
    const response = await enter();
    const session = sessionSchema.parse(await response.json());
    const headers = { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json' };
    const post = (path: string, expectedVersion: number, fields: object = {}) => app.request(path, { method: 'POST', headers, body: JSON.stringify({ ...fields, epoch: session.epoch, expectedVersion, idempotencyKey: crypto.randomUUID() }) });
    expect((await post('/api/workspace/role', 1, { roleId: 'coordinator' })).status).toBe(200);
    const before = await store.exportLogicalSnapshot(session.workspaceId);
    reject = true;
    expect((await post('/api/workspace/reset', 0)).status).toBe(500);
    expect(await store.exportLogicalSnapshot(session.workspaceId)).toEqual(before);
    expect(hooks).toEqual(['mod-lab', 'mod-pharmacy', 'mod-lab', 'mod-pharmacy', 'mod-lab', 'mod-pharmacy']);
  } finally { await store.close(); }
});
