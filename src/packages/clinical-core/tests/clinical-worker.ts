import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../../store';
import { clinicalContract } from './clinical-contract';

export class ClinicalWorkspace extends DurableObject {
  async fetch(request: Request) {
    const store = createDurableObjectSqliteStore(this.ctx.storage);
    try { return Response.json(await clinicalContract(store, new URL(request.url).pathname === '/change')); }
    finally { await store.close(); }
  }
}
export default { fetch(request: Request, env: { CLINIC: DurableObjectNamespace<ClinicalWorkspace> }) { return env.CLINIC.getByName('contract').fetch(request); } };
