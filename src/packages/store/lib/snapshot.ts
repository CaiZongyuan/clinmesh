import { z } from 'zod';
import { v5 } from 'uuid';
import { canonicalJson } from './json';
import { exportPiSession, piImage, restorePiSession, type PiImage } from './pi';
import { createReader, createRepository, readEntity, writeEntity } from './repository';
import { billingEntities, entityNames, epoch as epochFields, labEntities, pharmacyEntities, tables, uuid, workspace as workspaceFields, type EntityRow, type TableDefinition } from './schema';
import type { SqlConnection } from './sqlite';

const format = 'clinmesh.snapshot.v6';
const firstTableByVersion = { 'clinmesh.snapshot.v1': 'encounter_triage', 'clinmesh.snapshot.v2': billingEntities[0], 'clinmesh.snapshot.v3': 'patient_reply_runs', 'clinmesh.snapshot.v4': labEntities[0], 'clinmesh.snapshot.v5': pharmacyEntities[0] } as const;
const record = z.record(z.string(), z.json());
const snapshotSchema = z.strictObject({
  format: z.enum(['clinmesh.snapshot.v1', 'clinmesh.snapshot.v2', 'clinmesh.snapshot.v3', 'clinmesh.snapshot.v4', 'clinmesh.snapshot.v5', format]), workspaceId: uuid,
  tables: z.array(z.strictObject({ name: z.string(), rows: z.array(record) })),
  pi: z.array(piImage), sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type LogicalSnapshot = z.infer<typeof snapshotSchema>;
type SnapshotContent = Omit<LogicalSnapshot, 'sha256'>;
export class StoreSnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreSnapshotError'; }
}

export async function seal(content: SnapshotContent): Promise<LogicalSnapshot> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(content)));
  const sha256 = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...content, sha256 };
}

export async function verifySnapshot(input: unknown) {
  const { sha256, ...content } = snapshotSchema.parse(input);
  if ((await seal(content)).sha256 !== sha256) throw new StoreSnapshotError('Snapshot digest mismatch');
  const count = content.format === format ? entityNames.length : entityNames.indexOf(firstTableByVersion[content.format]);
  const expected = ['workspaces', 'workspace_epochs', ...entityNames.slice(0, count)];
  if (content.tables.length !== expected.length || content.tables.some((table, index) => table.name !== expected[index])) throw new StoreSnapshotError('Incomplete or unordered snapshot tables');
  const upgraded: SnapshotContent = { ...content, format, tables: [...content.tables, ...entityNames.slice(count).map(name => ({ name, rows: [] }))] };
  return { content: upgraded, sourceFormat: content.format, sourceDigest: sha256 };
}

type Quarantine = EntityRow<'inventory_lot_quarantines'>;
type InventoryProvenance = Pick<Quarantine, 'source_version' | 'source_sha256'>;

export function verifyInventoryLots(db: SqlConnection, provenance?: InventoryProvenance) {
  const reader = createReader(db, () => {});
  const added: SnapshotContent['tables'][number]['rows'] = [];
  const groups = db.all(`SELECT lot.workspace_id, lot.epoch, lot.id, COALESCE(SUM(movement.quantity_delta), 0) AS balance
    FROM inventory_lots lot LEFT JOIN inventory_movements movement ON movement.workspace_id = lot.workspace_id AND movement.epoch = lot.epoch AND movement.lot_id = lot.id
    GROUP BY lot.workspace_id, lot.epoch, lot.id HAVING COALESCE(SUM(movement.quantity_delta), 0) < 0 OR EXISTS
      (SELECT 1 FROM inventory_lot_quarantines held WHERE held.workspace_id = lot.workspace_id AND held.epoch = lot.epoch AND held.id = lot.id)
    ORDER BY lot.workspace_id, lot.epoch, lot.id`);
  for (const group of groups) {
    const at = { workspaceId: uuid.parse(group.workspace_id), epoch: uuid.parse(group.epoch) };
    const id = uuid.parse(group.id);
    const balance = z.int().parse(group.balance);
    const movements = reader.list(at, 'inventory_movements', { lot_id: id });
    const fingerprint = v5(canonicalJson({ ...at, id, movements }), v5.URL);
    const held = reader.get(at, 'inventory_lot_quarantines', id);
    if (held) {
      if (held.quantity_at_migration !== balance || held.ledger_fingerprint !== fingerprint || held.source_version.startsWith('clinmesh.snapshot.') !== Boolean(held.source_sha256)) throw new StoreSnapshotError(`Invalid inventory quarantine for lot ${id}`);
    } else {
      if (!provenance) throw new StoreSnapshotError(`Unverified negative inventory in lot ${id}`);
      const marker = { id, ...provenance, quantity_at_migration: balance, ledger_fingerprint: fingerprint };
      writeEntity(db, at, 'inventory_lot_quarantines', marker);
      added.push({ workspace_id: at.workspaceId, epoch: at.epoch, ...marker });
    }
  }
  return added;
}

export function capture(db: SqlConnection, workspaceId: string): SnapshotContent {
  const reader = createReader(db, () => {});
  const workspace = reader.getWorkspace(workspaceId);
  if (!workspace) throw new StoreSnapshotError('Unknown snapshot workspace');
  const epochs = reader.listEpochs(workspaceId);
  const data: SnapshotContent['tables'] = [
    { name: 'workspaces', rows: [workspace] },
    { name: 'workspace_epochs', rows: epochs.map(row => ({ workspace_id: workspaceId, ...row })) },
  ];
  const pi: PiImage[] = [];
  for (const name of entityNames) {
    const definition: TableDefinition = tables[name];
    const rows: SnapshotContent['tables'][number]['rows'] = [];
    for (const { epoch } of epochs) {
      const records = db.all(`SELECT * FROM ${name} WHERE workspace_id = ? AND epoch = ? ORDER BY ${definition.chain ? 'revision, id' : 'id'}`, workspaceId, epoch);
      for (const raw of records) {
        rows.push({ workspace_id: workspaceId, epoch, ...readEntity(name, raw) });
        if (name === 'pi_sessions') {
          const session = exportPiSession(db, { workspaceId, epoch }, uuid.parse(raw.id));
          if (session) pi.push(session);
        }
      }
    }
    data.push({ name, rows });
  }
  return { format, workspaceId, tables: data, pi };
}

export async function restore(db: SqlConnection, { content, sourceFormat, sourceDigest }: Awaited<ReturnType<typeof verifySnapshot>>): Promise<void> {
  if (db.all('SELECT id FROM workspaces LIMIT 1').length) throw new StoreSnapshotError('Snapshot target must be empty');
  const tx = createRepository(db, () => {});
  const { workspaceId } = content;
  const [workspaces, epochs, ...entities] = content.tables;
  if (workspaces!.rows.length !== 1 || workspaces!.rows[0]!.id !== workspaceId) throw new StoreSnapshotError('Snapshot workspace mismatch');
  const root = workspaces!.rows[0]!;
  tx.createWorkspace(workspaceFields.parse(root));
  function scoped(row: z.infer<typeof record>) {
    const { workspace_id, epoch, ...fields } = row;
    if (workspace_id !== workspaceId) throw new StoreSnapshotError('Unexpected workspace in snapshot row');
    return { at: { workspaceId, epoch: uuid.parse(epoch) }, fields };
  }
  for (const row of epochs!.rows) {
    const { at, fields } = scoped(row);
    tx.createEpoch(at, epochFields.parse(fields));
  }
  const recordsByTable = new Map(entities.map(table => [table.name, table.rows]));
  for (const name of entityNames) {
    for (const row of recordsByTable.get(name) ?? []) {
      const { at, fields } = scoped(row);
      writeEntity(db, at, name, fields);
    }
  }
  for (const row of epochs!.rows) {
    const { at } = scoped(row);
    const invalid = db.all(`SELECT revision.id FROM diagnosis_revisions revision LEFT JOIN diagnosis_confirmations member
      ON member.workspace_id = revision.workspace_id AND member.epoch = revision.epoch AND member.revision_id = revision.id
      WHERE revision.workspace_id = ? AND revision.epoch = ? GROUP BY revision.id
      HAVING COUNT(member.id) NOT BETWEEN 1 AND 8 OR SUM(member.is_primary) <> 1 LIMIT 1`, at.workspaceId, at.epoch);
    if (invalid.length) throw new StoreSnapshotError('Incomplete confirmed diagnosis revision');
    const [inconsistent] = db.all(`SELECT rx.id FROM prescriptions rx JOIN prescription_signatures signature
      ON signature.workspace_id = rx.workspace_id AND signature.epoch = rx.epoch AND signature.prescription_id = rx.id
      WHERE rx.workspace_id = ? AND rx.epoch = ? AND (
        (rx.status = 'withdrawn') <> EXISTS (SELECT 1 FROM prescription_withdrawals withdrawal WHERE withdrawal.workspace_id = rx.workspace_id AND withdrawal.epoch = rx.epoch AND withdrawal.prescription_id = rx.id)
        OR (rx.status = 'dispensed') <> EXISTS (SELECT 1 FROM prescription_orders line JOIN dispenses delivery ON delivery.workspace_id = line.workspace_id AND delivery.epoch = line.epoch AND delivery.prescription_order_id = line.id WHERE line.workspace_id = rx.workspace_id AND line.epoch = rx.epoch AND line.prescription_id = rx.id)
        OR rx.status NOT IN ('signed', 'withdrawn', 'dispensed') OR rx.version <> CASE WHEN rx.status = 'signed' THEN 1 ELSE 2 END) LIMIT 1`, at.workspaceId, at.epoch);
    if (inconsistent) throw new StoreSnapshotError(`Prescription state disagrees with its events: ${inconsistent.id}`);
  }
  const migrated = verifyInventoryLots(db, sourceFormat === format ? undefined : { source_version: sourceFormat, source_sha256: sourceDigest });
  if (migrated.length) recordsByTable.get('inventory_lot_quarantines')!.push(...migrated);
  for (const image of content.pi) await restorePiSession(db, workspaceId, image);
  if (canonicalJson(capture(db, workspaceId)) !== canonicalJson(content)) throw new StoreSnapshotError('Noncanonical snapshot content');
}
