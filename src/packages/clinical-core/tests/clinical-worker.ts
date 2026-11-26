import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../../store';
import { clinicalContract } from './clinical-contract';
import { templateFixture } from './template-fixture';

export class ClinicalWorkspace extends DurableObject {
  async fetch(request: Request) {
    const store = createDurableObjectSqliteStore(this.ctx.storage);
    try {
      const route = new URL(request.url).pathname;
      if (route === '/retired-fields') {
        const { path, command, read, birthday } = await templateFixture(store);
        const draft = (version: number, draftVersion: number, minor: string) => command(`${path}/clinical-record/draft`, 'PUT', version, { expectedDraftVersion: draftVersion, fields: { concern: 'Initial', minor } });
        await draft(1, 0, 'Signed value');
        await command(`${path}/clinical-record/sign`, 'POST', 2);
        await command(`${path}/diagnosis/draft`, 'PUT', 3, { diagnoses: [{ codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', primary: true }] });
        await command(`${path}/diagnosis/confirm`, 'POST', 4);
        const clean = (await read()).completion.ready;
        await draft(5, 1, 'Unreviewed correction');
        await birthday();
        const blocked = await command(`${path}/complete`, 'POST', 6);
        const blockedSign = await command(`${path}/clinical-record/sign`, 'POST', 6);
        const before = await read();
        const reviewed = await command(`${path}/clinical-record/sign`, 'POST', 6, { expectedDraftVersion: 2, retiredReview: { decision: 'include', localFields: {} } });
        const after = await read();
        return Response.json({ clean, blocked: blocked.status, blockedSign: blockedSign.status, before: before.completion.ready, reviewed: await reviewed.json(), after: after.completion.ready, retained: after.recordRevisions.map(item => item.fields.minor) });
      }
      return Response.json(await clinicalContract(store, route === '/change'));
    }
    finally { await store.close(); }
  }
}
export default { fetch(request: Request, env: { CLINIC: DurableObjectNamespace<ClinicalWorkspace> }) { return env.CLINIC.getByName('contract').fetch(request); } };
