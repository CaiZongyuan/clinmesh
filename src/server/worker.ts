import { DurableObject } from 'cloudflare:workers';
import { createDurableObjectSqliteStore } from '../packages/store';
import { createApp } from './app';

export class WorkspaceDurableObject<Env = unknown> extends DurableObject<Env> {
  protected readonly store = createDurableObjectSqliteStore(this.ctx.storage);
}

const app = createApp({ runtime: 'cloudflare-worker', modules: [] });
export default { fetch: app.fetch };
