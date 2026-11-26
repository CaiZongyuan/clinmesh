import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../../store';
import { clockContract } from './clock-contract';

export class ClockWorkspace extends DurableObject {
  async fetch(request: Request) {
    const store = createDurableObjectSqliteStore(this.ctx.storage);
    try { return Response.json(await clockContract(store, new URL(request.url).searchParams.get('timezone')!)); }
    finally { await store.close(); }
  }
}
export default { fetch(request: Request, env: { CLOCK: DurableObjectNamespace<ClockWorkspace> }) { return env.CLOCK.getByName('clock').fetch(request); } };
