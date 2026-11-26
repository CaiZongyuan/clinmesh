import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../../store';
import { outpatientContract } from '../../../server/testing/outpatient-billing';
import { inpatientContract } from './inpatient-contract';
import { projectionContract } from './projection-contract';
import { restoreLegacyBilling } from '../../../server/testing/legacy-billing';

export class BillingWorkspace extends DurableObject {
  async fetch(request: Request) {
    const store = createDurableObjectSqliteStore(this.ctx.storage);
    try {
      const path = new URL(request.url).pathname;
      if (path === '/outpatient') return Response.json(await outpatientContract(store));
      if (path === '/inpatient') return Response.json(await inpatientContract(store));
      if (path === '/legacy') return Response.json(await restoreLegacyBilling(store));
      return Response.json(await projectionContract(store));
    } finally { await store.close(); }
  }
}
export default { fetch(request: Request, env: { BILLING: DurableObjectNamespace<BillingWorkspace> }) { return env.BILLING.getByName(new URL(request.url).pathname).fetch(request); } };
