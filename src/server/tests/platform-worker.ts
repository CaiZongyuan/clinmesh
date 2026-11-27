import { z } from 'zod';
import type { LogicalSnapshot } from '../../packages/store';
import worker, { WorkspaceDurableObject as Workspace } from '../worker';
import { installScriptedBailian } from '../testing/scripted-worker-voice';

installScriptedBailian('browser');
export class WorkspaceDurableObject extends Workspace {
  capture(id: string) { return this.store.exportLogicalSnapshot(id); }
  async restore(snapshot: LogicalSnapshot) {
    await this.store.importLogicalSnapshot(snapshot);
    return this.capture(snapshot.workspaceId);
  }
}
export default { async fetch(request: Request, env: Parameters<typeof worker.fetch>[1] & { WORKSPACE_DO: DurableObjectNamespace<WorkspaceDurableObject> }) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/test-snapshot/')) {
    const id = z.uuidv7().parse(path.split('/').at(-1));
    const object = env.WORKSPACE_DO.getByName(id) as unknown as Pick<WorkspaceDurableObject, 'restore' | 'capture'>;
    const snapshot = request.method === 'POST' ? await object.restore(await request.json<LogicalSnapshot>()) : await object.capture(id);
    return Response.json(snapshot);
  }
  return worker.fetch(request, env);
} };
