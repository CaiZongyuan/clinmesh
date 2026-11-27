import { DurableObject } from 'cloudflare:workers';
import type { AgentEnvironment } from '../packages/agent-runtime';
import { createDurableObjectSqliteStore } from '../packages/store';
import { createVisitorGate, type Credential, type GateSettings } from '../packages/platform';
import { createApp } from './app';
import { createWorkspaceApp } from './workspace';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';
import { workerGatePolicy } from './host-policy';
import { builtinModules } from './builtin-modules';

declare const CLINMESH_LOOPBACK_WRANGLER: boolean;

export class WorkspaceDurableObject<Env = unknown> extends DurableObject<Env> {
  protected readonly store = createDurableObjectSqliteStore(this.ctx.storage);
  protected readonly builtinDataPacks = BUILTIN_DATA_PACKS;
  private readonly workspace = createWorkspaceApp(this.store, gateSettings(this.env as WorkerEnvironment), builtinModules, this.env as WorkerEnvironment, task => this.ctx.waitUntil(task), (_, connect) => {
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.accept();
    const connection = connect(socket);
    socket.addEventListener('message', event => connection.receive(event.data));
    socket.addEventListener('close', connection.close);
    socket.addEventListener('error', connection.close);
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
  async signingSecret(): Promise<string> { return this.store.visitorSigningSecret(); }
  async handle(request: Request, credential: Credential, entering: boolean): Promise<Response> { return this.workspace.fetch(request, { credential, entering }); }
  async fetch(request: Request): Promise<Response> {
    const env = this.env as WorkerEnvironment;
    const credential = await createVisitorGate(gateSettings(env)).authenticate(request.headers.get('cookie') ?? undefined);
    if (!this.ctx.id.equals(env.WORKSPACE_DO.idFromName(credential.ticket.workspaceId))) return new Response(null, { status: 403 });
    return this.handle(request, credential, false);
  }
}

interface WorkerEnvironment extends GateSettings, AgentEnvironment {
  CLINMESH_LOCAL_DEV_OPEN?: string;
  WORKSPACE_DO: { idFromName(name: string): DurableObjectId; getByName(name: string): Pick<WorkspaceDurableObject, 'fetch' | 'handle' | 'signingSecret'> };
}
function gateSettings(env: WorkerEnvironment): GateSettings {
  return { CLINMESH_VISITOR_PASSCODE: env.CLINMESH_VISITOR_PASSCODE, CLINMESH_SESSION_SECRET: env.CLINMESH_SESSION_SECRET,
    ...workerGatePolicy(typeof CLINMESH_LOOPBACK_WRANGLER !== 'undefined' && CLINMESH_LOOPBACK_WRANGLER === true, env.CLINMESH_LOCAL_DEV_OPEN),
    loadSigningSecret: () => env.WORKSPACE_DO.getByName('visitor-gate-authority').signingSecret() };
}
export default { fetch(request: Request, env: WorkerEnvironment) {
  return createApp('cloudflare-worker', gateSettings(env), (incoming, credential, entering) => {
    const workspace = env.WORKSPACE_DO.getByName(credential.ticket.workspaceId);
    return incoming.headers.get('upgrade')?.toLowerCase() === 'websocket' ? workspace.fetch(incoming) : workspace.handle(incoming, credential, entering);
  }, builtinModules).fetch(request);
} };
