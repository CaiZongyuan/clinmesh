import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { z } from 'zod';
import { scope, uuid, type StoreScope } from './schema';
import { duringTransaction, type Schedule, type SqlConnection, type SqlRow, type SqlValue } from './sqlite';

const direct: Schedule = async work => work();

function binding(value: SqliteValue): SqlValue {
  if (typeof value === 'bigint') return z.int().parse(Number(value));
  if (value instanceof Uint8Array) throw new Error('Unexpected binary value in pi-durable schema');
  return value;
}

function piDatabase(db: SqlConnection, schedule: Schedule, transact: Schedule, release: () => void): SqliteDatabase {
  function executor(admit: Schedule): SqliteExecutor {
    return {
      exec: sql => admit(() => db.exec(sql)),
      run: (sql, ...params) => admit(() => db.run(sql, ...params.map(binding))),
      runCounted: (sql, ...params) => admit(() => {
        db.run(sql, ...params.map(binding));
        return Number(db.all('SELECT changes() AS count')[0]!.count);
      }),
      get: <Row extends object>(sql: string, ...params: SqliteValue[]) => admit(() => db.all(sql, ...params.map(binding))[0] as Row | undefined),
      all: <Row extends object>(sql: string, ...params: SqliteValue[]) => admit(() => db.all(sql, ...params.map(binding)) as Row[]),
    };
  }
  return {
    ...executor(schedule),
    transaction: fn => transact(() => duringTransaction(check => fn(executor(async work => { check(); return work(); })))),
    async close() { release(); },
  };
}

function prefix(at: StoreScope, sessionId: string): string {
  const { workspaceId, epoch } = scope.parse(at);
  return `pi_${[workspaceId, epoch, uuid.parse(sessionId)].map(id => id.replaceAll('-', '')).join('_')}_`;
}

export function createPiSessions(db: SqlConnection, schedule: Schedule, transact: Schedule) {
  const open = new Map<string, Promise<SqliteStorage>>();
  return {
    open(location: StoreScope, sessionId: string): Promise<SqliteStorage> {
      const at = scope.parse(location);
      const namespace = prefix(at, sessionId);
      const existing = open.get(namespace);
      if (existing) return existing;
      const release = () => { if (open.get(namespace) === storage) open.delete(namespace); };
      const storage = schedule(() => {
        if (!db.all('SELECT id FROM pi_sessions WHERE workspace_id = ? AND epoch = ? AND id = ?', at.workspaceId, at.epoch, sessionId).length) throw new Error('Unknown pi-durable session');
      }).then(() => SqliteStorage.open(piDatabase(db, schedule, transact, release), { prefix: namespace }));
      open.set(namespace, storage);
      storage.catch(release);
      return storage;
    },
    async close() {
      await Promise.all([...open.values()].map(storage => storage.then(value => value.close(BACKGROUND_CONTEXT), () => {})));
    },
  };
}

const int = z.int();
const nullableInt = int.nullable();
const text = z.string();
const json = text.refine(value => { try { JSON.parse(value); return true; } catch { return false; } });
const exhaustedId = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
const nextId = text.regex(/^[1-9]\d{0,15}$/).pipe(text.refine(value => BigInt(value) >= 2n && BigInt(value) <= exhaustedId, 'Invalid pi-durable ID counter'));
const shapes = {
  durable_schema: { singleton: z.literal(1), version: z.literal(CURRENT_SQLITE_SCHEMA_VERSION) },
  durable_metadata: { singleton: z.literal(1), next_id: nextId, next_seq: int.positive() },
  record_ids: { id: int, record_type: text },
  conversations: { id: int, owner_conversation_id: nullableInt, owner_task_id: nullableInt, record: json },
  entries: { id: int, conversation_id: int, head: nullableInt, commit_seq: int, record: json },
  tasks: { id: int, conversation_id: int, kind: text, status: text, abort_requested: int, background: int, record: json },
  submissions: { id: int, conversation_id: int, request_id: text.nullable(), status: text, record: json },
  documents: { id: int, kind: text, family: int, key_value: text, scope_kind: text, owner_id: int, created_at: int, retired_at: nullableInt, record: json },
  document_revisions: { document_id: int, seq: int, kind: text, version: int, content: json },
};
const piTables = Object.entries(shapes).map(([name, shape]) => ({ name, columns: Object.keys(shape), schema: z.strictObject(shape) }));
export const piImage = z.strictObject({ epoch: uuid, sessionId: uuid, tables: z.array(z.strictObject({
  name: z.string(), rows: z.array(z.record(z.string(), z.union([text, int, z.null()]))),
})) });
export type PiImage = z.infer<typeof piImage>;

function checkHighWaterMarks(image: PiImage) {
  const metadata = image.tables.find(table => table.name === 'durable_metadata')!.rows[0]!;
  const nextIdentifier = BigInt(String(metadata.next_id));
  const nextSequence = Number(metadata.next_seq);
  const identifiers = ['id', 'document_id', 'conversation_id', 'owner_conversation_id', 'owner_task_id', 'owner_id', 'head'];
  const sequences = ['commit_seq', 'seq', 'created_at', 'retired_at'];
  for (const table of image.tables) {
    for (const row of table.rows) {
      for (const key of identifiers) {
        const id = row[key];
        if (typeof id === 'number' && BigInt(id) >= nextIdentifier) throw new Error('Invalid pi-durable ID counter');
      }
      for (const key of sequences) {
        const sequence = row[key];
        if (typeof sequence === 'number' && sequence >= nextSequence) throw new Error('Invalid pi-durable sequence counter');
      }
    }
  }
}

export function exportPiSession(db: SqlConnection, at: StoreScope, sessionId: string): PiImage | undefined {
  const namespace = prefix(at, sessionId);
  if (!db.all('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?', 'table', `${namespace}durable_schema`).length) return;
  const tables = piTables.map(({ name, columns, schema }) => ({ name, rows: db.all(
    `SELECT ${columns.join(', ')} FROM ${namespace}${name} ORDER BY ${name === 'document_revisions' ? 'document_id, seq' : columns[0]}`,
  ).map(row => schema.parse(row) as SqlRow) }));
  return { epoch: at.epoch, sessionId, tables };
}

export async function restorePiSession(db: SqlConnection, workspaceId: string, image: PiImage): Promise<void> {
  const namespace = prefix({ workspaceId, epoch: image.epoch }, image.sessionId);
  if (!db.all('SELECT id FROM pi_sessions WHERE workspace_id = ? AND epoch = ? AND id = ?', workspaceId, image.epoch, image.sessionId).length) throw new Error('Unknown pi-durable snapshot session');
  if (image.tables.length !== piTables.length) throw new Error('Incomplete pi-durable snapshot');
  const storage = await SqliteStorage.open(piDatabase(db, direct, direct, () => {}), { prefix: namespace });
  await storage.close(BACKGROUND_CONTEXT);
  for (const [index, { name, columns, schema }] of piTables.entries()) {
    const table = image.tables[index]!;
    if (table.name !== name || (columns[0] === 'singleton' && table.rows.length !== 1)) throw new Error('Invalid pi-durable snapshot table');
    if (columns[0] === 'singleton') db.run(`DELETE FROM ${namespace}${name}`);
    for (const raw of table.rows) {
      const row: SqlRow = schema.parse(raw);
      db.run(`INSERT INTO ${namespace}${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map(key => row[key]!));
    }
  }
  checkHighWaterMarks(image);
}
