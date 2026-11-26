import type { StorePort } from './store';

export interface StoreOwner { store: StorePort; leases: number }

interface Owners<Key> {
  get(key: Key): StoreOwner | undefined;
  set(key: Key, owner: StoreOwner): void;
  delete(key: Key): boolean;
}

export function leaseStore<Key>(owners: Owners<Key>, key: Key, open: () => StorePort): StorePort {
  const existing = owners.get(key);
  if (existing?.leases === 0) throw new Error('Store is closing');
  const owner = existing ?? { store: open(), leases: 0 };
  owners.set(key, owner);
  owner.leases++;
  let closed: Promise<void> | undefined;
  function use<Result>(work: (store: StorePort) => Promise<Result>): Promise<Result> {
    return closed ? Promise.reject(new Error('Store is closed')) : work(owner.store);
  }
  return {
    withTransaction: work => use(store => store.withTransaction(work)),
    exportLogicalSnapshot: id => use(store => store.exportLogicalSnapshot(id)),
    importLogicalSnapshot: image => use(store => store.importLogicalSnapshot(image)),
    openPiStorage: (at, id) => use(store => store.openPiStorage(at, id)),
    close() {
      if (!closed) {
        owner.leases--;
        closed = owner.leases ? Promise.resolve() : owner.store.close().finally(() => { owners.delete(key); });
      }
      return closed;
    },
  };
}
