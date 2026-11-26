import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { importLogicalSnapshot, exportLogicalSnapshot, type LogicalSnapshot, type StorePort } from '../index';

async function expectRefusal(result: Promise<unknown>, reason: RegExp) {
  try { await result; } catch (error) { if (reason.test(String(error))) return; throw error; }
  throw new Error(`Import should have failed (${reason})`);
}

async function withCorrectDigest({ sha256: _digest, ...content }: LogicalSnapshot): Promise<LogicalSnapshot> {
  const normalized = JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return { ...content, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}

export async function verifyRestore(store: StorePort, snapshot: LogicalSnapshot): Promise<LogicalSnapshot> {
  await expectRefusal(importLogicalSnapshot(store, { ...snapshot, sha256: '0'.repeat(64) }), /digest/i);
  const invalid = structuredClone(snapshot);
  invalid.tables.find(table => table.name === 'refund_transactions')!.rows[0]!.allocation_id = snapshot.workspaceId;
  await expectRefusal(importLogicalSnapshot(store, await withCorrectDigest(invalid)), /foreign key/i);
  await expectRefusal(exportLogicalSnapshot(store, snapshot.workspaceId), /unknown/i);
  const mixed = structuredClone(snapshot);
  mixed.tables.find(table => table.name === 'audit_events')!.rows[0]!.workspace_id = '0192eaf2-cb03-7000-8000-999999999999';
  await expectRefusal(importLogicalSnapshot(store, await withCorrectDigest(mixed)), /workspace/i);
  const partial = structuredClone(snapshot);
  partial.pi[0]!.tables.pop();
  await expectRefusal(importLogicalSnapshot(store, await withCorrectDigest(partial)), /incomplete/i);
  const unsignedGroup = structuredClone(snapshot);
  unsignedGroup.tables.find(table => table.name === 'diagnosis_confirmations')!.rows.length = 0;
  await expectRefusal(importLogicalSnapshot(store, await withCorrectDigest(unsignedGroup)), /diagnosis/i);
  for (const [counter, invalidValue] of [['next_id', '2'], ['next_id', '9007199254740993'], ['next_seq', 1]] as const) {
    const collision = structuredClone(snapshot);
    collision.pi[0]!.tables.find(table => table.name === 'durable_metadata')!.rows[0]![counter] = invalidValue;
    await expectRefusal(importLogicalSnapshot(store, await withCorrectDigest(collision)), /counter/i);
    await expectRefusal(exportLogicalSnapshot(store, snapshot.workspaceId), /unknown/i);
  }
  const reordered = structuredClone(snapshot);
  const receipt = reordered.tables.find(table => table.name === 'command_receipts')!.rows[0]!;
  receipt.result = { note: { color: 'green', size: 1 }, accepted: true };
  await importLogicalSnapshot(store, reordered);
  const receipts = await store.read(reader => reader.list({ workspaceId: snapshot.workspaceId, epoch: String(receipt.epoch) }, 'command_receipts', { result: { accepted: true, note: { size: 1, color: 'green' } } }));
  if (receipts.length !== 1) throw new Error('Restored command receipt JSON equality changed');
  await expectRefusal(importLogicalSnapshot(store, snapshot), /empty/i);
  const image = snapshot.pi[0]!;
  const pi = await store.openPiStorage({ workspaceId: snapshot.workspaceId, epoch: image.epoch }, image.sessionId);
  const conversations = await pi.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
  const conversationId = conversations.items[0]!.id;
  const entries = await pi.scanEntries({ conversationId }, 10, undefined, BACKGROUND_CONTEXT);
  if (entries.items[0]?.data !== 'Retained turn') throw new Error('Restored pi-durable transcript is missing');
  if (!(await pi.submissionByRequest(conversationId, 'synthetic-request', BACKGROUND_CONTEXT))) throw new Error('Restored pi-durable request is missing');
  const final = snapshot.pi[1]!;
  const exhausted = await store.openPiStorage({ workspaceId: snapshot.workspaceId, epoch: final.epoch }, final.sessionId);
  const last = await exhausted.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
  if (last.items[0]?.id !== Number.MAX_SAFE_INTEGER) throw new Error('Last available pi-durable ID was lost');
  await expectRefusal(exhausted.mintId(), /exhausted/i);
  return exportLogicalSnapshot(store, snapshot.workspaceId);
}
