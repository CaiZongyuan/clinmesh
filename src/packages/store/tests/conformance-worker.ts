import { WorkspaceDurableObject } from '../../../server/worker';
import { runStoreConformanceSuite, type LogicalSnapshot } from '../index';
import { verifyRestore } from './conformance';

interface TestEnv { STORE: DurableObjectNamespace<ConformanceObject> }

export class ConformanceObject extends WorkspaceDurableObject<TestEnv> {
  async fetch(request: Request) {
    if (request.method === 'POST') return Response.json(await verifyRestore(this.store, await request.json<LogicalSnapshot>()));
    const snapshot = await runStoreConformanceSuite(this.store, async value => {
      const response = await this.env.STORE.getByName('target').fetch('https://store.test/restore', { method: 'POST', body: JSON.stringify(value) });
      return response.json<LogicalSnapshot>();
    });
    return Response.json(snapshot);
  }
}

export default { fetch(request: Request, env: TestEnv) { return env.STORE.getByName(new URL(request.url).pathname).fetch(request); } };
