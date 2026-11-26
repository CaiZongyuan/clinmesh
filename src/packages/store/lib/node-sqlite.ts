import type Database from 'better-sqlite3';
import { leaseStore, type StoreOwner } from './leases';
import type { SqlRow } from './sqlite';
import { createStore } from './store';

const files = new Map<string, StoreOwner>();

export function createNodeSqliteStore({ dbPath }: { dbPath: string }) {
  if (dbPath === ':memory:') return openDatabase(dbPath);
  const path = process.getBuiltinModule('node:path');
  const fs = process.getBuiltinModule('node:fs');
  const realPath = fs.existsSync(dbPath) ? fs.realpathSync.native(dbPath) : path.join(fs.realpathSync.native(path.dirname(dbPath)), path.basename(dbPath));
  return leaseStore(files, process.platform === 'win32' ? realPath.toLowerCase() : realPath, () => openDatabase(realPath));
}

function openDatabase(dbPath: string) {
  const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
  const NativeDatabase: typeof Database = load('better-sqlite3');
  const database = new NativeDatabase(dbPath);
  try {
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    return createStore({
      exec(sql) { database.exec(sql); },
      run(sql, ...params) { database.prepare(sql).run(...params); },
      all(sql, ...params) { return database.prepare<unknown[], SqlRow>(sql).all(...params); },
      atomicSync: work => database.transaction(work).immediate(),
      async atomic(mode, work) {
        database.exec(mode === 'read' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
        try {
          const result = await work();
          database.exec('COMMIT');
          return result;
        } catch (error) {
          if (database.inTransaction) database.exec('ROLLBACK');
          throw error;
        }
      },
      close() { database.close(); },
    });
  } catch (error) {
    database.close();
    throw error;
  }
}
