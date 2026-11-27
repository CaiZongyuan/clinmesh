import type { Storage } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { createPiSessions } from './pi';
import { billingEntities, decisionEntities, initializeEntity, initializeSchema, initializeWardIndexes, labEntities, pharmacyEntities, wardEntities, type StoreScope } from './schema';
import { createReader, createRepository, type StoreReader, type StoreTx } from './repository';
import { SerialQueue, duringTransaction, type Schedule, type SqlConnection } from './sqlite';
import { capture, restore, seal, verifyInventoryLots, verifySnapshot, type LogicalSnapshot } from './snapshot';

export interface StorePort {
  visitorSigningSecret(): Promise<string>;
  read<T>(fn: (reader: StoreReader) => Promise<T> | T): Promise<T>;
  withTransaction<T>(fn: (tx: StoreTx) => Promise<T> | T): Promise<T>;
  exportLogicalSnapshot(workspaceId: string): Promise<LogicalSnapshot>;
  importLogicalSnapshot(snapshot: unknown): Promise<void>;
  openPiStorage(at: StoreScope, sessionId: string): Promise<Storage>;
  close(): Promise<void>;
}

export function createStore(db: SqlConnection): StorePort {
  db.atomicSync(() => {
    db.exec('CREATE TABLE IF NOT EXISTS clinmesh_schema (version INTEGER NOT NULL PRIMARY KEY)');
    const versions = db.all('SELECT version FROM clinmesh_schema');
    const installed = versions.length === 1 ? versions[0]!.version : null;
    if (installed === 8) return;
    if (installed === 1 || installed === 2 || installed === 3 || installed === 4 || installed === 5 || installed === 6 || installed === 7) {
      if (installed === 1) for (const name of ['encounter_triage', ...billingEntities] as const) initializeEntity(db.exec, name);
      if (installed <= 2) for (const name of ['patient_reply_runs', 'agent_model_calls'] as const) initializeEntity(db.exec, name);
      if (installed <= 3) for (const name of labEntities) initializeEntity(db.exec, name);
      if (installed === 1 || installed === 2 || installed === 3 || installed === 4) {
        for (const name of pharmacyEntities) initializeEntity(db.exec, name);
        verifyInventoryLots(db, { source_version: `sqlite.schema.v${installed}`, source_sha256: null });
      }
      if (installed < 6) initializeEntity(db.exec, 'study_requests');
      if (installed < 7) for (const name of wardEntities) initializeEntity(db.exec, name);
      initializeWardIndexes(db.exec);
      for (const name of decisionEntities) initializeEntity(db.exec, name);
      db.run('UPDATE clinmesh_schema SET version = 8 WHERE version = ?', installed);
      return;
    }
    if (versions.length) throw new Error('Unsupported ClinMesh schema version');
    initializeSchema(db.exec);
    db.run('INSERT INTO clinmesh_schema (version) VALUES (8)');
  });
  const queue = new SerialQueue();
  let closing: Promise<void> | undefined;
  const schedule: Schedule = work => queue.run(work);
  const transact: Schedule = work => schedule(() => db.atomic('write', work));
  const pi = createPiSessions(db, schedule, transact);
  const whileOpen = <Result>(mode: 'read' | 'write', work: () => Result | Promise<Result>): Promise<Result> => closing ? Promise.reject(new Error('Store is closed')) : schedule(() => db.atomic(mode, work));
  let signingSecret: Promise<string> | undefined;
  return {
    visitorSigningSecret() {
      if (closing) return Promise.reject(new Error('Store is closed'));
      return signingSecret ??= whileOpen('write', () => {
        db.exec('CREATE TABLE IF NOT EXISTS visitor_gate_authority (id INTEGER PRIMARY KEY, secret TEXT NOT NULL)');
        const stored = db.all('SELECT secret FROM visitor_gate_authority WHERE id = 1')[0];
        if (stored) return z.string().regex(/^[a-f0-9]{64}$/).parse(stored.secret);
        const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
        db.run('INSERT INTO visitor_gate_authority (id, secret) VALUES (1, ?)', secret);
        return secret;
      }).catch(error => { signingSecret = undefined; throw error; });
    },
    read(fn) { return whileOpen('read', () => duringTransaction(check => fn(createReader(db, check)))); },
    withTransaction(fn) { return whileOpen('write', () => duringTransaction(check => fn(createRepository(db, check)))); },
    async exportLogicalSnapshot(workspaceId) { return seal(await whileOpen('read', () => capture(db, workspaceId))); },
    async importLogicalSnapshot(input) {
      const content = await verifySnapshot(input);
      return whileOpen('write', () => restore(db, content));
    },
    openPiStorage(at, id) { return closing ? Promise.reject(new Error('Store is closed')) : pi.open(at, id); },
    close() { return closing ??= pi.close().then(() => queue.run(() => db.close())); },
  };
}

export const exportLogicalSnapshot = (store: StorePort, workspaceId: string) => store.exportLogicalSnapshot(workspaceId);
export const importLogicalSnapshot = (store: StorePort, snapshot: unknown) => store.importLogicalSnapshot(snapshot);
