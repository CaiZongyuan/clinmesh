import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { teachingGate } from '../../../scripts/testing/node-workspace';
import { createNodeSqliteStore, type LogicalSnapshot } from '../../packages/store';
import { createNodeApp } from '../node-app';
import { nodeEvaluations } from '../node-evaluations';
import { hostKey, scriptedBailian } from '../testing/voice-provider';

const gate = { ...teachingGate, CLINMESH_SESSION_SECRET: 'synthetic-shared-gate-for-snapshot-recovery' };
export type PlatformHost = { origin: string; recoveryOrigin: string; objects?(): Promise<string[]>; capture(id: string, evaluation?: boolean): Promise<LogicalSnapshot>; restore(snapshot: LogicalSnapshot, evaluation: boolean): Promise<LogicalSnapshot>; close(): Promise<void> };
export async function nodePlatform(): Promise<PlatformHost> {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-platform-'));
  const store = createNodeSqliteStore({ dbPath: join(directory, 'workspace.sqlite') });
  const evaluations = join(directory, 'evaluations');
  const recovery = createNodeSqliteStore({ dbPath: join(directory, 'restored.sqlite') });
  const recoveredRuns = join(directory, 'restored-evaluations');
  await mkdir(recoveredRuns);
  const app = createNodeApp(store, gate, { BAILIAN_TOKEN: hostKey }, nodeEvaluations(evaluations, {}), async (_url, headers) => {
    const events = new EventTarget();
    const reply = scriptedBailian(headers.Authorization, data => queueMicrotask(() => events.dispatchEvent(new MessageEvent('message', { data }))), 'browser');
    return Object.assign(events, { send: reply, close: () => {} });
  });
  app.use(serveStatic({ root: './dist/client' }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, websocket: { server: new WebSocketServer({ noServer: true }) } });
  await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing HTTP listener');
  const reopened = serve({ fetch: createNodeApp(recovery, gate, {}, nodeEvaluations(recoveredRuns, {})).fetch, hostname: '127.0.0.1', port: 0 });
  await once(reopened, 'listening');
  const bound = reopened.address(); if (!bound || typeof bound === 'string') throw Error('Missing recovery listener');
  return { origin: `http://127.0.0.1:${address.port}`, recoveryOrigin: `http://127.0.0.1:${bound.port}`,
    async capture(id, evaluation) {
      if (!evaluation) return store.exportLogicalSnapshot(id);
      const run = createNodeSqliteStore({ dbPath: join(evaluations, `${id}.sqlite`) });
      try { return await run.exportLogicalSnapshot(id); } finally { await run.close(); }
    },
    async restore(snapshot, evaluation) {
      const target = evaluation ? createNodeSqliteStore({ dbPath: join(recoveredRuns, `${snapshot.workspaceId}.sqlite`) }) : recovery;
      try { await target.importLogicalSnapshot(snapshot); return await target.exportLogicalSnapshot(snapshot.workspaceId); } finally { if (evaluation) await target.close(); }
    },
    async close() { await Promise.all([server, reopened].map(host => new Promise<void>(done => host.close(() => done())))); await store.close(); await recovery.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

export async function workerPlatform(): Promise<PlatformHost> {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const host = createTestHarness({ workers: [{ config: { ...rawConfig, main: './src/server/tests/platform-worker.ts', vars: { ...gate, BAILIAN_TOKEN: hostKey } } }] });
  const { url } = await host.listen();
  async function snapshot(id: string, payload?: LogicalSnapshot) {
    const response = await fetch(`${url.origin}/api/test-snapshot/${id}`, payload && { method: 'POST', body: JSON.stringify(payload) });
    if (!response.ok) throw Error(`Snapshot ${response.status}: ${await response.text()}`);
    return await response.json() as LogicalSnapshot;
  }
  return { origin: url.origin, recoveryOrigin: url.origin, objects: () => host.getWorker().listDurableObjectIds('WORKSPACE_DO'), capture: id => snapshot(id), restore: image => snapshot(image.workspaceId, image), close: () => host.close() };
}
