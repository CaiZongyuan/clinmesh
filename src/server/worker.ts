import { DurableObject } from 'cloudflare:workers';
import { createApp } from './app';

export class WorkspaceDurableObject extends DurableObject {
  protected readonly sql = this.ctx.storage.sql;
}

const app = createApp({ runtime: 'cloudflare-worker', modules: [] });
export default { fetch: app.fetch };
