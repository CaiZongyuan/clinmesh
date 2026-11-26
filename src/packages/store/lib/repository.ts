import { z } from 'zod';
import { canonicalJson, type JsonValue } from './json';
import { editable, entityNames, epoch, scope, tables, uuid, workspace, type Changes, type Column, type EditableEntity, type Entity, type EntityRow, type PublicEntity, type StoreScope, type TableDefinition, type Workspace, type WorkspaceEpoch } from './schema';
import type { SqlConnection, SqlRow, SqlValue } from './sqlite';

export class StoreVersionConflictError extends Error {
  constructor() { super('Store version conflict'); this.name = 'StoreVersionConflictError'; }
}
export class StoreIdempotencyConflictError extends Error {
  constructor() { super('Command key already used for a different request'); this.name = 'StoreIdempotencyConflictError'; }
}
export class StorePrivateCaseTruthError extends Error {
  constructor() { super('Case Truth is locked'); this.name = 'StorePrivateCaseTruthError'; }
}

const privateAccess = z.strictObject({ purpose: z.enum(['simulation', 'completed-debrief']), encounterId: uuid });
type PrivateAccess = z.infer<typeof privateAccess>;
const removable = ['patients', 'clinical_record_drafts', 'diagnosis_drafts'] as const;
const dedicatedWrites = ['command_receipts', 'diagnosis_revisions', 'diagnosis_confirmations'] as const;
type InsertableEntity = Exclude<PublicEntity, (typeof dedicatedWrites)[number]>;
type DiagnosisMember = Omit<EntityRow<'diagnosis_confirmations'>, 'revision_id'>;

export interface StoreTx {
  createWorkspace(row: Workspace): void;
  getWorkspace(id: string): Workspace | undefined;
  createEpoch(at: StoreScope, row: WorkspaceEpoch): void;
  getEpoch(at: StoreScope): WorkspaceEpoch | undefined;
  listEpochs(workspaceId: string): (WorkspaceEpoch & { epoch: string })[];
  updateEpoch(at: StoreScope, expectedClockRevision: number, changes: Partial<Pick<WorkspaceEpoch, 'status' | 'virtual_time'>>): void;
  insert<Name extends InsertableEntity>(at: StoreScope, name: Name, row: EntityRow<NoInfer<Name>>): void;
  appendDiagnosisRevision(at: StoreScope, revision: EntityRow<'diagnosis_revisions'>, members: readonly DiagnosisMember[]): void;
  get<Name extends PublicEntity>(at: StoreScope, name: Name, id: string): EntityRow<Name> | undefined;
  list<Name extends PublicEntity>(at: StoreScope, name: Name, filter?: Partial<EntityRow<NoInfer<Name>>>): EntityRow<Name>[];
  update<Name extends EditableEntity>(at: StoreScope, name: Name, id: string, expectedVersion: number, changes: Changes<NoInfer<Name>>): void;
  remove(at: StoreScope, name: (typeof removable)[number], id: string, expectedVersion: number): void;
  findCommandReceipt(at: StoreScope, idempotencyKey: string): EntityRow<'command_receipts'> | undefined;
  recordCommandReceipt(at: StoreScope, receipt: EntityRow<'command_receipts'>): EntityRow<'command_receipts'>;
  writePrivateCaseTruth(at: StoreScope, row: EntityRow<'case_truths'>): void;
  readPrivateCaseTruth(at: StoreScope, access: PrivateAccess): EntityRow<'case_truths'> | undefined;
}

export type StoreReader = Pick<StoreTx, 'getWorkspace' | 'getEpoch' | 'listEpochs' | 'get' | 'list' | 'findCommandReceipt' | 'readPrivateCaseTruth'>;

const definitions: Record<Entity, TableDefinition> = tables;
const schemas = Object.fromEntries(entityNames.map(name => [name, z.strictObject(Object.fromEntries(
  Object.entries(definitions[name].fields).map(([key, field]) => [key, field.schema]),
))])) as Record<Entity, z.ZodObject<Record<string, z.ZodType>>>;
const diagnosisMembers = z.array(schemas.diagnosis_confirmations.omit({ revision_id: true })).min(1).max(8)
  .refine(members => members.filter(member => member.is_primary === true).length === 1, 'A revision requires one primary diagnosis');

function encoded(field: Column, value: unknown): SqlValue {
  if (value === null && field.nullable) return null;
  if (field.kind === 'json') return canonicalJson(value as JsonValue);
  if (field.kind === 'boolean') return value ? 1 : 0;
  return value as SqlValue;
}

export function readEntity<Name extends Entity>(name: Name, raw: SqlRow): EntityRow<Name> {
  const decoded = Object.fromEntries(Object.entries(definitions[name].fields).map(([key, field]) => {
    const value = raw[key];
    if (field.kind === 'json') return [key, JSON.parse(z.string().parse(value))];
    if (field.kind === 'boolean') return [key, z.union([z.literal(0), z.literal(1)]).parse(value) === 1];
    return [key, value];
  }));
  return schemas[name].parse(decoded) as EntityRow<Name>;
}

export function writeEntity(db: SqlConnection, location: StoreScope, name: Entity, input: unknown): void {
  const at = scope.parse(location);
  const row = schemas[name].parse(input);
  const { fields, chain } = definitions[name];
  const keys = ['workspace_id', 'epoch', ...Object.keys(fields)];
  const values = [at.workspaceId, at.epoch, ...Object.entries(fields).map(([key, field]) => encoded(field, row[key]))];
  if (chain) {
    keys.push('previous_revision');
    values.push(row.previous_revision_id === null ? null : Number(row.revision) - 1);
  }
  db.run(`INSERT INTO ${name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...values);
}

const isolation = 'workspace_id = ? AND epoch = ?';

function publicEntity(name: Entity): void {
  if (typeof name !== 'string' || !Object.hasOwn(tables, name) || name === 'case_truths') throw new Error('Unavailable clinical repository');
}

export function createRepository(db: SqlConnection, checkOpen: () => void): StoreTx {
  function keys(at: StoreScope): [string, string] {
    checkOpen();
    const { workspaceId, epoch } = scope.parse(at);
    return [workspaceId, epoch];
  }
  function list<Name extends Entity>(at: StoreScope, name: Name, filter: unknown): EntityRow<Name>[] {
    const params: SqlValue[] = keys(at);
    const fields = definitions[name].fields;
    const clauses = [isolation];
    const jsonFilters: [string, string][] = [];
    for (const [key, value] of Object.entries(schemas[name].partial().parse(filter))) {
      if (value === undefined) throw new Error('Undefined filter value');
      if (fields[key]!.kind === 'json') jsonFilters.push([key, canonicalJson(value as JsonValue)]);
      else if (value === null && fields[key]!.nullable) clauses.push(`${key} IS NULL`);
      else {
        clauses.push(`${key} = ?`);
        params.push(encoded(fields[key]!, value));
      }
    }
    return db.all(`SELECT * FROM ${name} WHERE ${clauses.join(' AND ')} ORDER BY id`, ...params)
      .map(row => readEntity(name, row))
      .filter(row => jsonFilters.every(([key, value]) => canonicalJson(row[key as keyof typeof row] as JsonValue) === value));
  }
  function cas(sql: string, params: SqlValue[]): void {
    if (!db.all(`${sql} RETURNING 1 AS applied`, ...params).length) throw new StoreVersionConflictError();
  }
  function applyPatch(name: string, identity: string, params: SqlValue[], version: string, expected: number, values: [string, SqlValue][]) {
    const where = `${identity} AND ${version} = ?`;
    if (!values.length) {
      if (!db.all(`SELECT 1 FROM ${name} WHERE ${where}`, ...params, expected).length) throw new StoreVersionConflictError();
      return;
    }
    const assignments = values.map(([key]) => `${key} = ?`);
    assignments.push(`${version} = ${version} + 1`);
    cas(`UPDATE ${name} SET ${assignments.join(', ')} WHERE ${where} AND ${version} < ?`, [...values.map(([, value]) => value), ...params, expected, Number.MAX_SAFE_INTEGER]);
  }
  const tx: StoreTx = {
    createWorkspace(input) {
      checkOpen();
      const { id, recorded_at } = workspace.parse(input);
      db.run('INSERT INTO workspaces (id, recorded_at) VALUES (?, ?)', id, recorded_at);
    },
    getWorkspace(id) {
      checkOpen();
      const [row] = db.all('SELECT * FROM workspaces WHERE id = ?', uuid.parse(id));
      return row && workspace.parse(row);
    },
    createEpoch(at, input) {
      const { status, virtual_time, clock_revision } = epoch.parse(input);
      db.run('INSERT INTO workspace_epochs (workspace_id, epoch, status, virtual_time, clock_revision) VALUES (?, ?, ?, ?, ?)', ...keys(at), status, virtual_time, clock_revision);
    },
    getEpoch(at) {
      const [row] = db.all(`SELECT status, virtual_time, clock_revision FROM workspace_epochs WHERE ${isolation}`, ...keys(at));
      return row && epoch.parse(row);
    },
    listEpochs(workspaceId) {
      checkOpen();
      return db.all('SELECT epoch, status, virtual_time, clock_revision FROM workspace_epochs WHERE workspace_id = ? ORDER BY epoch', uuid.parse(workspaceId)).map(row => epoch.extend({ epoch: uuid }).parse(row));
    },
    updateEpoch(at, expected, changes) {
      const patch = epoch.omit({ clock_revision: true }).partial().parse(changes);
      const values = Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== undefined);
      applyPatch('workspace_epochs', isolation, keys(at), 'clock_revision', z.int().nonnegative().parse(expected), values);
    },
    insert(at, name, row) {
      publicEntity(name);
      if ((dedicatedWrites as readonly string[]).includes(name)) throw new Error('Use the aggregate repository operation');
      keys(at);
      writeEntity(db, at, name, row);
    },
    appendDiagnosisRevision(location, revision, members) {
      checkOpen();
      const at = scope.parse(location);
      const header = schemas.diagnosis_revisions.parse(revision);
      const diagnoses = diagnosisMembers.parse(members);
      db.atomicSync(() => {
        writeEntity(db, at, 'diagnosis_revisions', header);
        for (const member of diagnoses) writeEntity(db, at, 'diagnosis_confirmations', { ...member, revision_id: header.id });
      });
    },
    get(at, name, id) { publicEntity(name); return list(at, name, { id })[0]; },
    list(at, name, filter = {}) { publicEntity(name); return list(at, name, filter); },
    update(at, name, id, expected, input) {
      if (typeof name !== 'string' || !Object.hasOwn(editable, name)) throw new Error('Immutable fact');
      const patch = Object.entries(schemas[name].partial().parse(input));
      const allowed: readonly string[] = editable[name];
      if (patch.some(([key]) => !allowed.includes(key))) throw new Error('Invalid update fields');
      const fields = definitions[name].fields;
      const values: [string, SqlValue][] = patch.filter(([, value]) => value !== undefined).map(([key, value]) => [key, encoded(fields[key]!, value)]);
      applyPatch(name, `${isolation} AND id = ?`, [...keys(at), uuid.parse(id)], 'version', z.int().positive().parse(expected), values);
    },
    remove(at, name, id, expected) {
      if (!removable.includes(name)) throw new Error('Deletion is restricted');
      cas(`DELETE FROM ${name} WHERE ${isolation} AND id = ? AND version = ?`, [...keys(at), uuid.parse(id), z.int().positive().parse(expected)]);
    },
    findCommandReceipt(at, key) { return list(at, 'command_receipts', { idempotency_key: key })[0]; },
    recordCommandReceipt(at, input) {
      const receipt = schemas.command_receipts.parse(input) as EntityRow<'command_receipts'>;
      const prior = tx.findCommandReceipt(at, receipt.idempotency_key);
      if (!prior) { writeEntity(db, at, 'command_receipts', receipt); return receipt; }
      if (prior.operation !== receipt.operation || prior.request_hash !== receipt.request_hash) throw new StoreIdempotencyConflictError();
      return prior;
    },
    writePrivateCaseTruth(at, row) { keys(at); writeEntity(db, at, 'case_truths', row); },
    readPrivateCaseTruth(at, input) {
      const { encounterId, purpose } = privateAccess.parse(input);
      const encounter = tx.get(at, 'encounters', encounterId);
      if (!encounter || (purpose === 'completed-debrief' && encounter.status !== 'completed')) throw new StorePrivateCaseTruthError();
      return list(at, 'case_truths', { case_id: encounter.source_case_id })[0];
    },
  };
  return Object.freeze(tx);
}

export function createReader(db: SqlConnection, checkOpen: () => void): StoreReader {
  const { getWorkspace, getEpoch, listEpochs, get, list, findCommandReceipt, readPrivateCaseTruth } = createRepository(db, checkOpen);
  return Object.freeze({ getWorkspace, getEpoch, listEpochs, get, list, findCommandReceipt, readPrivateCaseTruth });
}
