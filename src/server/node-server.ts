import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNodeSqliteStore } from '../packages/store';
import { createApp } from './app';
import { createWorkspaceApp } from './workspace';

const { CLINMESH_HOST: hostname, CLINMESH_PORT: port } = z.object({
  CLINMESH_HOST: z.string().trim().min(1).default('127.0.0.1'),
  CLINMESH_PORT: z.coerce.number().int().min(0).max(65535).default(51868),
}).parse(process.env);

const dbPath = process.env.CLINMESH_DATABASE_PATH || '.data/clinmesh.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const store = createNodeSqliteStore({ dbPath });
const settings = { CLINMESH_VISITOR_PASSCODE: process.env.CLINMESH_VISITOR_PASSCODE, CLINMESH_SESSION_SECRET: process.env.CLINMESH_SESSION_SECRET, CLINMESH_LOCAL_DEV_OPEN: process.env.CLINMESH_LOCAL_DEV_OPEN, loadSigningSecret: () => store.visitorSigningSecret() };
const workspace = createWorkspaceApp(store, settings);
const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }));
app.all('/api', context => context.notFound());
app.all('/api/*', context => context.notFound());
app.use(serveStatic({ root: './dist/client' }));
const serveIndex = serveStatic({ path: './dist/client/index.html' });
app.use((context, next) => context.req.header('Accept')?.includes('text/html') ? serveIndex(context, next) : next());

serve({ fetch: app.fetch, hostname, port }, address => {
  console.log(`ClinMesh listening on ${address.address}:${address.port}`);
});
