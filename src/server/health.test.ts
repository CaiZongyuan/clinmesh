import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { createApp } from './app';

it('mounts the health route and each enabled module on the Node app', async () => {
  const app = createApp({
    runtime: 'node',
    modules: [{
      id: 'example', kind: 'extension', version: '1',
      registerRoutes(router) { router.get('/api/example', context => context.text('module ready')); },
    }],
  });
  const health = await app.request('/api/health');
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true, runtime: 'node', loadedModules: ['example'] });
  expect(await (await app.request('/api/example')).text()).toBe('module ready');
});

it('serves the same health contract through the workerd fetch entry', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const health = await worker.fetch('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, runtime: 'cloudflare-worker', loadedModules: [] });
    const storage = await worker.getDurableObjectStorage('WORKSPACE_DO', { name: 'health-check' });
    expect(await storage.exec('SELECT 1 AS ready')).toEqual([{ ready: 1 }]);
  } finally {
    await server.close();
  }
}, 30_000);
