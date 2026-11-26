import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { createApp } from './app';

const { CLINMESH_HOST: hostname, CLINMESH_PORT: port } = z.object({
  CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  CLINMESH_PORT: z.coerce.number().int().min(1).max(65535).default(51868),
}).parse(process.env);

const app = createApp({ runtime: 'node', modules: [] });
app.all('/api', context => context.notFound());
app.all('/api/*', context => context.notFound());
app.use(serveStatic({ root: './dist/client' }));
const serveIndex = serveStatic({ path: './dist/client/index.html' });
app.use((context, next) => context.req.header('Accept')?.includes('text/html') ? serveIndex(context, next) : next());

serve({ fetch: app.fetch, hostname, port }, address => {
  console.log(`ClinMesh listening on ${address.address}:${address.port}`);
});
