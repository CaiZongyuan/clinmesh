import { WorkspaceDurableObject } from '../../../server/worker';
import { installHospitalDataPack, readHospitalDataPack } from '../index';

interface PackEnv { WORKSPACE: DurableObjectNamespace<PackWorkspace> }

export class PackWorkspace extends WorkspaceDurableObject<PackEnv> {
  async fetch() {
    const workspaceId = '0192eaf2-cb03-7000-8000-000000000588';
    let expectedEpoch: string | null = null;
    const views = [];
    for (const pack of Object.values(this.builtinDataPacks)) {
      const at = await this.store.withTransaction(tx => installHospitalDataPack(tx, { workspaceId, expectedEpoch, virtualTime: '2026-08-24T00:00:00Z' }, pack));
      views.push(await this.store.read(reader => readHospitalDataPack(reader, at)));
      expectedEpoch = at.epoch;
    }
    return Response.json(views);
  }
}

export default { fetch(request: Request, env: PackEnv) { return env.WORKSPACE.getByName('pack-swap').fetch(request); } };
