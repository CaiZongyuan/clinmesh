import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { createApp } from './app';
import { createWorkspaceApp } from './workspace';
import { createNodeSqliteStore } from '../packages/store';
import type { ClinMeshModule, OperationCatalog } from '../packages/platform';
import { z } from 'zod';

it('mounts the health route and each enabled module on the Node app', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const modules: ClinMeshModule<OperationCatalog>[] = ['mod-lab', 'uninstalled'].map(id => ({ id, kind: 'extension', version: '1',
    registerRoutes(router) { router.get(`/api/his/${id}/about`, context => context.text('module ready')); },
    registerOperations(catalog) { catalog.query({ name: `${id}.read`, path: `/api/his/${id}/read`, access: {} }, z.literal('ready'), () => 'ready' as const); },
    workbenchTabs: [{ id, label: { en: id, zh: id } }],
  }));
  const settings = { localOpen: true, loadSigningSecret: () => store.visitorSigningSecret() };
  const workspace = createWorkspaceApp(store, settings, modules);
  const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }), modules);
  try {
    const health = await app.request('/api/health');
    expect(await health.json()).toEqual({ ok: true, runtime: 'node', loadedModules: ['mod-lab', 'uninstalled'] });
    expect((await app.request('/api/his/mod-lab/about')).status).toBe(401);
    const enter = await app.request('/api/auth/visitor/enter', { method: 'POST', body: '{}' });
    const headers = { cookie: enter.headers.get('set-cookie')!.split(';')[0]! };
    const get = (path: string) => app.request(path, { headers });
    expect(await (await get('/api/his/mod-lab/about')).text()).toBe('module ready');
    expect(await (await get('/api/his/mod-lab/read')).json()).toBe('ready');
    expect((await get('/api/his/uninstalled/about')).status).toBe(404);
    expect((await get('/api/his/uninstalled/read')).status).toBe(404);
    expect(await (await get('/api/workspace')).json()).toMatchObject({ enabledModules: ['mod-lab'], tabs: [{ id: 'mod-lab' }] });
  } finally { await store.close(); }
});

it('serves the same health contract through the workerd fetch entry', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const health = await worker.fetch('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, runtime: 'cloudflare-worker', loadedModules: ['mod-billing', 'mod-drg-cn', 'mod-lab', 'mod-pharmacy'] });
    const storage = await worker.getDurableObjectStorage('WORKSPACE_DO', { name: 'health-check' });
    expect(await storage.exec('SELECT 1 AS ready')).toEqual([{ ready: 1 }]);
  } finally {
    await server.close();
  }
}, 30_000);
