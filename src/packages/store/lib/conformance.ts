import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, DocumentId, EntryId, Storage, SubmissionId, TaskId } from '@earendil-works/pi-durable';
import { at, fixtureId, otherEpoch, otherWorkspace, receipt, recorded_at, seedConformance } from './conformance-fixture';
import { StoreIdempotencyConflictError, StorePrivateCaseTruthError, StoreVersionConflictError, type StoreTx } from './repository';
import type { LogicalSnapshot } from './snapshot';
import type { StorePort } from './store';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Store conformance: ${message}`);
}

function fails(work: () => unknown, expected?: (new () => Error) | RegExp): void {
  try { work(); } catch (error) {
    check(!expected || (expected instanceof RegExp ? expected.test(String(error)) : error instanceof expected), `unexpected refusal: ${String(error)}`);
    return;
  }
  throw new Error('Store conformance: operation should have been refused');
}

async function rejects(work: Promise<unknown>, expected: RegExp): Promise<void> {
  try { await work; } catch (error) { check(expected.test(String(error)), `unexpected rejection: ${String(error)}`); return; }
  throw new Error('Store conformance: expected rejection');
}

function verifyFacts(tx: StoreTx) {
  const patientId = fixtureId(18);
  const encounterId = fixtureId(20);
  check(tx.get(at, 'patients', patientId)?.display_name === 'Synthetic One', 'read own patient');
  check(tx.get(otherWorkspace, 'patients', patientId)?.display_name === 'Other Workspace', 'workspace isolation');
  check(tx.get(otherEpoch, 'patients', patientId) === undefined, 'epoch isolation');
  check(tx.list(otherEpoch, 'audit_events')[0]?.operation === 'older-audit', 'prior epoch audit retention');
  check(tx.list(at, 'audit_events')[0]?.operation === 'synthetic.sign', 'active epoch audit isolation');
  check(tx.list(at, 'catalog_items', { kind: 'service', code_system: 'urn:example:catalog', code: 'S1' }).length === 1, 'coded catalog lookup');
  check(tx.list(at, 'capability_tokens', { revoked: false })[0]?.revoked === false, 'typed boolean');
  const charge = tx.get(at, 'charge_items', fixtureId(49));
  check(charge?.amount_minor === 12345 && charge.currency_code === 'KWD' && charge.currency_exponent === 3, 'integer minor units');
  for (const [index, currency_code, currency_exponent] of [[80, 'JPY', 0], [81, 'USD', 2]] as const) {
    tx.insert(at, 'charge_items', { ...charge, id: fixtureId(index), currency_code, currency_exponent });
    check(tx.get(at, 'charge_items', fixtureId(index))?.currency_exponent === currency_exponent, 'currency precision');
  }
  fails(() => tx.insert(at, 'charge_items', { ...charge, id: fixtureId(82), amount_minor: 1.25 }));
  fails(() => tx.remove(at, 'patients', patientId, 1), /foreign key/i);
  const identifier = tx.get(at, 'patient_identifiers', fixtureId(19))!;
  fails(() => tx.insert(otherEpoch, 'patient_identifiers', identifier), /foreign key/i);
  fails(() => tx.insert({ ...at, workspaceId: fixtureId(89) }, 'patient_identifiers', identifier), /foreign key/i);
  const patient = tx.get(at, 'patients', patientId)!;
  fails(() => tx.insert(at, 'patients', { ...patient, id: '0192eaf2-cb03-4000-8000-000000000001' }));
  fails(() => tx.insert(at, 'capability_tokens', { ...tx.list(at, 'capability_tokens')[0]!, token_hash: 'raw-token' }));
  fails(() => tx.createEpoch({ ...at, epoch: fixtureId(88) }, { status: 'active', virtual_time: recorded_at, clock_revision: 0 }));
  tx.updateEpoch(at, 0, { virtual_time: recorded_at });
  fails(() => tx.updateEpoch(at, 0, { status: 'closed' }), StoreVersionConflictError);
  tx.update(at, 'clinical_record_drafts', fixtureId(23), 1, { fields: { summary: 'Doctor edit' } });
  fails(() => tx.update(at, 'clinical_record_drafts', fixtureId(23), 1, { fields: { summary: 'Stale edit' } }), StoreVersionConflictError);
  check(tx.get(at, 'clinical_record_drafts', fixtureId(23))?.fields.summary === 'Doctor edit', 'draft CAS');
  tx.insert(at, 'patients', { ...patient, id: fixtureId(83) });
  tx.remove(at, 'patients', fixtureId(83), 1);
  check(!tx.get(at, 'patients', fixtureId(83)), 'delete unreferenced entity');
  check(tx.recordCommandReceipt(at, { ...receipt, id: fixtureId(84), result: null }).id === receipt.id, 'replay original result');
  fails(() => tx.recordCommandReceipt(at, { ...receipt, request_hash: 'c'.repeat(64) }), StoreIdempotencyConflictError);
  check(tx.list(at, 'command_receipts').length === 1 && !tx.findCommandReceipt(otherEpoch, receipt.idempotency_key), 'scope receipts');
  const signed = tx.get(at, 'clinical_record_revisions', fixtureId(24))!;
  fails(() => tx.insert(at, 'clinical_record_revisions', { ...signed, id: fixtureId(85), revision: 4, previous_revision_id: signed.id }), /foreign key/i);
  fails(() => tx.insert(at, 'clinical_record_revisions', { ...signed, id: fixtureId(85) }), /unique/i);
  const diagnosis = tx.get(at, 'diagnosis_confirmations', fixtureId(28))!;
  fails(() => tx.insert(at, 'diagnosis_confirmations', { ...diagnosis, id: fixtureId(86), ordinal: 2 }), /unique/i);
  check(!tx.list(at, 'report_acknowledgements', { report_id: fixtureId(31) }).length, 'old acknowledgement cannot cover a corrected report');
  for (const name of ['audit_events', 'consultation_turns', 'clinical_record_revisions', 'diagnosis_confirmations', 'diagnostic_reports']) {
    fails(() => Reflect.apply(tx.update, tx, [at, name, signed.id, 1, {}]), /immutable/i);
    fails(() => Reflect.apply(tx.remove, tx, [at, name, signed.id, 1]), /restricted/i);
  }
  for (const method of [tx.get, tx.list]) fails(() => Reflect.apply(method, tx, [at, 'case_truths', fixtureId(10)]), /unavailable/i);
  fails(() => tx.readPrivateCaseTruth(at, { purpose: 'completed-debrief', encounterId }), StorePrivateCaseTruthError);
  check(tx.readPrivateCaseTruth(at, { purpose: 'simulation', encounterId })?.truth.finding === 'private-synthetic-sentinel', 'scoped simulation');
  tx.update(at, 'encounters', encounterId, 1, { status: 'completed' });
  check(tx.readPrivateCaseTruth(at, { purpose: 'completed-debrief', encounterId })?.truth.finding === 'private-synthetic-sentinel', 'completed debrief');
  fails(() => tx.readPrivateCaseTruth(otherEpoch, { purpose: 'completed-debrief', encounterId }), StorePrivateCaseTruthError);
}

async function verifyTransactions(store: StorePort) {
  const transient = { id: fixtureId(90), display_name: 'Rolled back', birth_date: null, version: 1 };
  await rejects(store.withTransaction(tx => { tx.insert(at, 'patients', transient); throw new Error('sync abort'); }), /sync abort/);
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const failed = store.withTransaction(tx => {
    tx.insert(at, 'patients', transient);
    enter();
    return paused.then(() => {
      tx.insert(at, 'patients', { ...transient, id: fixtureId(91) });
      throw new Error('async abort');
    });
  });
  await entered;
  const queued = store.withTransaction(tx => [tx.get(at, 'patients', transient.id), tx.get(at, 'patients', fixtureId(91))]);
  resume();
  await rejects(failed, /async abort/);
  check((await queued).every(row => row === undefined), 'queued reader observed uncommitted rows');
  const escaped = await store.withTransaction(async tx => { await Promise.resolve(); return tx; });
  fails(() => escaped.getEpoch(at), /closed/i);
  check(await store.withTransaction(() => 7) === 7 && await store.withTransaction(() => Promise.resolve(8)) === 8, 'transaction returns');
}

async function writePi(storage: Storage) {
  const conversationId = await storage.mintId<ConversationId>();
  const entryId = await storage.mintId<EntryId>();
  const taskId = await storage.mintId<TaskId<null>>();
  const submissionId = await storage.mintId<SubmissionId>();
  const documentId = await storage.mintId<DocumentId>();
  const result = await storage.commit([[
    { type: 'conversation', value: { id: conversationId } },
    { type: 'entry', value: { id: entryId, conversationId, kind: 'synthetic', data: 'Retained turn' } },
    { type: 'task', value: { id: taskId, conversationId, kind: 'synthetic', version: 1, input: null, background: false, abortRequested: false, state: { status: 'pending', checkpoint: 'resume' } } },
    { type: 'submission', value: { id: submissionId, conversationId, type: 'input', status: 'queued', requestId: 'synthetic-request' } },
    { type: 'document.create', record: { id: documentId, kind: 'synthetic', scope: { kind: 'session' } }, content: { version: 1, kind: 'base', value: { result: 42 } } },
  ]], () => {}, BACKGROUND_CONTEXT);
  check(result.stored === 1, `pi-durable commit: ${String(result.refused)}`);
  return { conversationId, entryId };
}

export async function runStoreConformanceSuite(store: StorePort, restoreIntoEmpty: (snapshot: LogicalSnapshot) => Promise<LogicalSnapshot>): Promise<LogicalSnapshot> {
  const expectedTables = await store.withTransaction(seedConformance);
  await store.withTransaction(verifyFacts);
  await verifyTransactions(store);
  const patient = await store.openPiStorage(at, fixtureId(70));
  const { conversationId, entryId } = await writePi(patient);
  const assistant = await store.openPiStorage(at, fixtureId(71));
  check(!await assistant.conversation(conversationId, BACKGROUND_CONTEXT), 'pi-durable agent isolation');
  await patient.close(BACKGROUND_CONTEXT);
  const reopened = await store.openPiStorage(at, fixtureId(70));
  check((await reopened.entry(entryId, BACKGROUND_CONTEXT))?.entry.data === 'Retained turn', 'durable transcript after reopen');
  await rejects(store.openPiStorage(otherEpoch, fixtureId(70)), /unknown/i);
  const snapshot = await store.exportLogicalSnapshot(at.workspaceId);
  for (const name of expectedTables) check(snapshot.tables.find(table => table.name === name)?.rows.length, `missing ${name}`);
  check(snapshot.tables.length === expectedTables.length, 'unexpected snapshot table');
  check(!JSON.stringify(snapshot).includes('Other Workspace'), 'workspace snapshot leaked a second workspace');
  check(snapshot.pi[0]?.tables.length === 9 && snapshot.pi[0].tables.every(table => table.rows.length > 0), 'pi-durable migration data');
  const restored = await restoreIntoEmpty(snapshot);
  check(snapshot.sha256 === restored.sha256 && restored.workspaceId === at.workspaceId && restored.format === 'clinmesh.snapshot.v1', 'lossless canonical round trip');
  return snapshot;
}
