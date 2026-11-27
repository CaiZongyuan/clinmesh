import { upgradeWebSocket } from '@hono/node-server';
import type { BailianConnect } from '../packages/mod-voice';
import type { GateSettings } from '../packages/platform';
import type { StorePort } from '../packages/store';
import { createApp } from './app';
import { hostModules } from './builtin-modules';
import type { EvaluationHost } from './evaluation-host';
import { connectNodeVoice } from './node-voice';
import { createWorkspaceApp } from './workspace';

export function createNodeApp(store: StorePort, settings: GateSettings, environment: Record<string, string | undefined>, evaluations?: EvaluationHost, connectVoice: BailianConnect = connectNodeVoice) {
  const modules = hostModules(environment.CLINMESH_VOICE_ENABLED);
  const workspace = createWorkspaceApp(store, settings, modules, environment, undefined, undefined, evaluations, connectVoice);
  return createApp('node', settings, (request, credential, entering, host) => workspace.fetch(request, { credential, entering,
    upgrade: async (_, connect) => {
      let connection: ReturnType<typeof connect> | undefined;
      const response = await upgradeWebSocket(() => ({ onOpen: (_, socket) => { connection = connect(socket); }, onMessage: event => connection?.receive(event.data), onClose: () => connection?.close() }))(host, async () => {});
      return response ?? host.res;
    } }), modules);
}
