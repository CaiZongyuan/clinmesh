import { z } from 'zod';
import { canonicalJson } from './json';
import { exportPiSession, piImage, restorePiSession, type PiImage } from './pi';
import { createReader, createRepository, readEntity, writeEntity } from './repository';
import { entityNames, epoch as epochFields, tables, uuid, workspace as workspaceFields, type TableDefinition } from './schema';
import type { SqlConnection } from './sqlite';

const format = 'clinmesh.snapshot.v3';
const firstTableByVersion = { 'clinmesh.snapshot.v1': 'encounter_triage', 'clinmesh.snapshot.v2': 'patient_reply_runs' } as const;
const record = z.record(z.string(), z.json());
const snapshotSchema = z.strictObject({
  format: z.enum(['clinmesh.snapshot.v1', 'clinmesh.snapshot.v2', format]), workspaceId: uuid,
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

export async function verifySnapshot(input: unknown): Promise<SnapshotContent> {
  const { sha256, ...content } = snapshotSchema.parse(input);
  if ((await seal(content)).sha256 !== sha256) throw new StoreSnapshotError('Snapshot digest mismatch');
  const count = content.format === format ? entityNames.length : entityNames.indexOf(firstTableByVersion[content.format]);
  const expected = ['workspaces', 'workspace_epochs', ...entityNames.slice(0, count)];
  if (content.tables.length !== expected.length || content.tables.some((table, index) => table.name !== expected[index])) throw new StoreSnapshotError('Incomplete or unordered snapshot tables');
  return { ...content, format, tables: [...content.tables, ...entityNames.slice(count).map(name => ({ name, rows: [] }))] };
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

export async function restore(db: SqlConnection, content: SnapshotContent): Promise<void> {
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
  }
  for (const image of content.pi) await restorePiSession(db, workspaceId, image);
  if (canonicalJson(capture(db, workspaceId)) !== canonicalJson(content)) throw new StoreSnapshotError('Noncanonical snapshot content');
}
