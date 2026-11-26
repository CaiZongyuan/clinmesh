import type { Storage } from '@earendil-works/pi-durable';
import { createPiSessions } from './pi';
import { initializeSchema, type StoreScope } from './schema';
import { createRepository, type StoreTx } from './repository';
import { SerialQueue, duringTransaction, type Schedule, type SqlConnection } from './sqlite';
import { capture, restore, seal, verifySnapshot, type LogicalSnapshot } from './snapshot';

export interface StorePort {
  withTransaction<T>(fn: (tx: StoreTx) => Promise<T> | T): Promise<T>;
  exportLogicalSnapshot(workspaceId: string): Promise<LogicalSnapshot>;
  importLogicalSnapshot(snapshot: unknown): Promise<void>;
  openPiStorage(at: StoreScope, sessionId: string): Promise<Storage>;
  close(): Promise<void>;
}

export function createStore(db: SqlConnection): StorePort {
  db.initialize(() => {
    db.exec('CREATE TABLE IF NOT EXISTS clinmesh_schema (version INTEGER NOT NULL PRIMARY KEY)');
    const versions = db.all('SELECT version FROM clinmesh_schema');
    if (versions.length === 1 && versions[0]!.version === 1) return;
    if (versions.length) throw new Error('Unsupported ClinMesh schema version');
    initializeSchema(db.exec);
    db.run('INSERT INTO clinmesh_schema (version) VALUES (1)');
  });
  const queue = new SerialQueue();
  let closing: Promise<void> | undefined;
  const schedule: Schedule = work => queue.run(work);
  const transact: Schedule = work => schedule(() => db.atomic(work));
  const pi = createPiSessions(db, schedule, transact);
  const whileOpen: Schedule = work => closing ? Promise.reject(new Error('Store is closed')) : transact(work);
  return {
    withTransaction(fn) { return whileOpen(() => duringTransaction(check => fn(createRepository(db, check)))); },
    async exportLogicalSnapshot(workspaceId) { return seal(await whileOpen(() => capture(db, workspaceId))); },
    async importLogicalSnapshot(input) {
      const content = await verifySnapshot(input);
      return whileOpen(() => restore(db, content));
    },
    openPiStorage(at, id) { return closing ? Promise.reject(new Error('Store is closed')) : pi.open(at, id); },
    close() { return closing ??= pi.close().then(() => queue.run(() => db.close())); },
  };
}

export const exportLogicalSnapshot = (store: StorePort, workspaceId: string) => store.exportLogicalSnapshot(workspaceId);
export const importLogicalSnapshot = (store: StorePort, snapshot: unknown) => store.importLogicalSnapshot(snapshot);
