import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNodeSqliteStore } from '../packages/store';
import { createApp } from './app';
import { createWorkspaceApp } from './workspace';
import { nodeListener } from './host-policy';
import { builtinModules } from './builtin-modules';

const { hostname, port, localOpen } = nodeListener(process.env);

const dbPath = process.env.CLINMESH_DATABASE_PATH || '.data/clinmesh.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const store = createNodeSqliteStore({ dbPath });
const settings = { CLINMESH_VISITOR_PASSCODE: process.env.CLINMESH_VISITOR_PASSCODE, CLINMESH_SESSION_SECRET: process.env.CLINMESH_SESSION_SECRET, localOpen, loadSigningSecret: () => store.visitorSigningSecret() };
const workspace = createWorkspaceApp(store, settings, builtinModules, { ...process.env });
const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }), builtinModules);
app.all('/api', context => context.notFound());
app.all('/api/*', context => context.notFound());
app.use(serveStatic({ root: './dist/client' }));
const serveIndex = serveStatic({ path: './dist/client/index.html' });
app.use((context, next) => context.req.header('Accept')?.includes('text/html') ? serveIndex(context, next) : next());

serve({ fetch: app.fetch, hostname, port }, address => {
  console.log(`ClinMesh listening on ${address.address}:${address.port}`);
});
