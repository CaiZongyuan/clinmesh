import { createStore } from './store';
import type { SqlRow } from './sqlite';
import { leaseStore, type StoreOwner } from './leases';

type WorkspaceStorage = Pick<DurableObjectStorage, 'sql' | 'transaction' | 'transactionSync'>;
const owners = new WeakMap<WorkspaceStorage, StoreOwner>();

export function createDurableObjectSqliteStore(storage: WorkspaceStorage) {
  return leaseStore(owners, storage, () => createStore({
    exec(sql) { storage.sql.exec(sql); },
    run(sql, ...params) { storage.sql.exec(sql, ...params); },
    all(sql, ...params) { return storage.sql.exec<SqlRow>(sql, ...params).toArray(); },
    initialize: work => storage.transactionSync(work),
    atomic(work) {
      return storage.transaction(async () => {
        let completion!: ReturnType<typeof work>;
        storage.transactionSync(() => { completion = work(); });
        return await completion;
      });
    },
    close() {},
  }));
}
