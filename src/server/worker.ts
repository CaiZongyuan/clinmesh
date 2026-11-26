import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../packages/store';
import type { Credential, GateSettings } from '../packages/platform';
import { createApp } from './app';
import { createWorkspaceApp } from './workspace';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';
import { workerGatePolicy } from './host-policy';
import { builtinModules } from './builtin-modules';

declare const CLINMESH_LOOPBACK_WRANGLER: boolean;

export class WorkspaceDurableObject<Env = unknown> extends DurableObject<Env> {
  protected readonly store = createDurableObjectSqliteStore(this.ctx.storage);
  protected readonly builtinDataPacks = BUILTIN_DATA_PACKS;
  private readonly workspace = createWorkspaceApp(this.store, gateSettings(this.env as WorkerEnvironment), builtinModules);
  async signingSecret(): Promise<string> { return this.store.visitorSigningSecret(); }
  async handle(request: Request, credential: Credential, entering: boolean) { return this.workspace.fetch(request, { credential, entering }); }
}

interface WorkerEnvironment extends GateSettings { CLINMESH_LOCAL_DEV_OPEN?: string; WORKSPACE_DO: DurableObjectNamespace<WorkspaceDurableObject> }
function gateSettings(env: WorkerEnvironment): GateSettings {
  return { CLINMESH_VISITOR_PASSCODE: env.CLINMESH_VISITOR_PASSCODE, CLINMESH_SESSION_SECRET: env.CLINMESH_SESSION_SECRET,
    ...workerGatePolicy(typeof CLINMESH_LOOPBACK_WRANGLER !== 'undefined' && CLINMESH_LOOPBACK_WRANGLER === true, env.CLINMESH_LOCAL_DEV_OPEN),
    loadSigningSecret: () => env.WORKSPACE_DO.getByName('visitor-gate-authority').signingSecret() };
}
export default { fetch(request: Request, env: WorkerEnvironment) {
  return createApp('cloudflare-worker', gateSettings(env), (incoming, credential, entering) => env.WORKSPACE_DO.getByName(credential.ticket.workspaceId).handle(incoming, credential, entering), builtinModules).fetch(request);
} };
