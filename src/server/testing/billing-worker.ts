import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../../packages/store';
import { outpatientContract } from './outpatient-billing';
import { inpatientContract } from './inpatient-contract';
import { projectionContract, unpostedInvestigationContract } from './projection-contract';
import { legacyCurrencyConflict, restoreLegacyBilling } from './legacy-billing';
import { firstSettlementContract, freeDischargeContract } from './first-settlement';

export class BillingWorkspace extends DurableObject {
  async fetch(request: Request) {
    const store = createDurableObjectSqliteStore(this.ctx.storage);
    try {
      const path = new URL(request.url).pathname;
      if (path === '/outpatient') return Response.json(await outpatientContract(store));
      if (path === '/inpatient') return Response.json(await inpatientContract(store));
      if (path === '/legacy') return Response.json(await restoreLegacyBilling(store));
      if (path === '/first-settlement') return Response.json(await firstSettlementContract(store));
      if (path === '/free-discharge') return Response.json(await freeDischargeContract(store));
      if (path === '/currency') return Response.json(await legacyCurrencyConflict(store, 'charge_items', 'JPY', 0));
      if (path === '/investigation') return Response.json(await unpostedInvestigationContract(store));
      return Response.json(await projectionContract(store));
    } finally { await store.close(); }
  }
}
export default { fetch(request: Request, env: { BILLING: DurableObjectNamespace<BillingWorkspace> }) { return env.BILLING.getByName(new URL(request.url).pathname).fetch(request); } };
