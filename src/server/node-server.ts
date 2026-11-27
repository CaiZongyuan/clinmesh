import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNodeSqliteStore } from '../packages/store';
import { createNodeApp } from './node-app';
import { nodeListener } from './host-policy';
import { nodeEvaluations } from './node-evaluations';

const { hostname, port, localOpen } = nodeListener(process.env);

const dbPath = process.env.CLINMESH_DATABASE_PATH || '.data/clinmesh.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const store = createNodeSqliteStore({ dbPath });
const settings = { CLINMESH_VISITOR_PASSCODE: process.env.CLINMESH_VISITOR_PASSCODE, CLINMESH_SESSION_SECRET: process.env.CLINMESH_SESSION_SECRET, localOpen, loadSigningSecret: () => store.visitorSigningSecret() };
const app = createNodeApp(store, settings, process.env, nodeEvaluations(`${dbPath}.evaluations`, { ...process.env }));
app.all('/api', context => context.notFound());
app.all('/api/*', context => context.notFound());
app.use(serveStatic({ root: './dist/client' }));
const serveIndex = serveStatic({ path: './dist/client/index.html' });
app.use((context, next) => context.req.header('Accept')?.includes('text/html') ? serveIndex(context, next) : next());

serve({ fetch: app.fetch, hostname, port, websocket: { server: new WebSocketServer({ noServer: true, maxPayload: 65536 }) } }, address => {
  console.log(`ClinMesh listening on ${address.address}:${address.port}`);
});
