import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../packages/store';
import { createApp } from './app';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';

export class WorkspaceDurableObject<Env = unknown> extends DurableObject<Env> {
  protected readonly store = createDurableObjectSqliteStore(this.ctx.storage);
  protected readonly builtinDataPacks = BUILTIN_DATA_PACKS;
}

const app = createApp({ runtime: 'cloudflare-worker', modules: [] });
export default { fetch: app.fetch };
