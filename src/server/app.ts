import { Hono } from 'hono';
import { ModuleRegistry, type ClinMeshModule, type RuntimeHealth } from '../packages/platform';

export function createApp({ runtime, modules }: {
  runtime: RuntimeHealth['runtime'];
  modules: readonly ClinMeshModule[];
}) {
  const app = new Hono();
  const registry = new ModuleRegistry(modules);
  app.get('/api/health', context => context.json(registry.health(runtime)));
  registry.registerRoutes(app);
  return app;
}
