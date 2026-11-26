import { v7 } from 'uuid';
import { z } from 'zod';
import general from '../../../../data/packs/global-general/pack.json';
import { installHospitalDataPack, readHospitalDataPack } from '../../data-pack';
import { appendPatientReply, startEncounter } from '../../patient-visit';
import { ModuleRegistry, OperationCatalog, registerPlatformOperations, type ClinMeshModule, type Credential } from '../../platform';
import type { StorePort } from '../../store';
import { encounterViewSchema, registerClinicalOperations } from '../index';

export async function clinicalContract(store: StorePort, changeAfterRead: boolean) {
  const id = v7();
  const workspaceId = v7();
  const teachingPack = { ...general, manifest: { ...general.manifest, timezone: 'Asia/Shanghai', clinicalRecordTemplate: [...general.manifest.clinicalRecordTemplate, { id: 'adult', title: { en: 'Adult assessment', zh: '成人评估' }, required: false, showWhen: { minAge: 18 } }] },
    cases: general.cases.map(item => item.demographics.name === 'Avery Reed' ? { ...item, demographics: { ...item.demographics, birthDate: '2010-04-17' } } : item) };
  const at = await store.withTransaction(tx => {
    const at = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-04-16T15:59:59Z' }, teachingPack);
    tx.insert(at, 'visitor_sessions', { id, practitioner_role: 'family-clinician', expires_at: '2099-01-01T00:00:00Z', version: 1, revoked: false });
    return at;
  });
  const credential: Credential = { ticket: { workspaceId, kind: 'visitor', id, expiresAt: '2099-01-01T00:00:00Z' } };
  const pack = await store.read(reader => readHospitalDataPack(reader, at)!);
  const module: ClinMeshModule<OperationCatalog> = { kind: 'clinical', version: '1', id: 'mod-lab', completion(reader, scope, encounterId) {
    const current = reader.get(scope, 'encounters', encounterId)!;
    return [{ id: 'review', label: { en: 'Review', zh: '复核' }, passed: current.status === 'active' && reader.getEpoch(scope)!.clock_revision === 0 }];
  } };
  const registry = new ModuleRegistry([module, { ...module, id: 'inactive', completion() { throw Error('Disabled gate invoked'); } }]);
  const catalog = new OperationCatalog();
  registerClinicalOperations(catalog, registry);
  registerPlatformOperations(catalog, { modules: registry, sign: async () => '' });
  catalog.command({ name: 'encounter.start', method: 'POST', path: '/start/:id', access: { capabilities: ['assess'] } }, {}, z.object({ encounterId: z.uuidv7(), version: z.int() }), context => startEncounter(context));
  const caseId = pack.cases.find(patient => patient.demographics.name === 'Avery Reed')!.id;
  let targetId = caseId;
  const call = (name: string, version: number, fields: Record<string, unknown> = {}, key = v7()) => catalog.require(name).invoke({ store, credential, targetId, body: async () => ({ epoch: at.epoch, expectedVersion: version, idempotencyKey: key, ...fields }) });
  const failed = (result: Promise<unknown>) => result.then(() => 'committed', (error: Error) => error.message);
  targetId = z.object({ encounterId: z.string() }).parse(await call('encounter.start', 0)).encounterId;
  const { turnId } = z.object({ turnId: z.uuidv7() }).parse(await call('consultation.question', 1, { content: 'First question', channel: 'voice' }));
  await store.withTransaction(tx => appendPatientReply(tx, at, targetId, turnId, { content: 'Synthetic patient answer', channel: 'text' }));
  const fields = Object.fromEntries(pack.manifest.clinicalRecordTemplate.filter(field => field.required).map(field => [field.id, field.id]));
  await call('record.draft', 3, { fields: { concern: 'First version' }, expectedDraftVersion: 0 });
  const incomplete = await failed(call('record.sign', 4));
  const staleDraft = await failed(call('record.draft', 4, { fields, expectedDraftVersion: 0 }));
  await call('record.draft', 4, { fields, expectedDraftVersion: 1 });
  await call('record.sign', 5);
  await call('record.draft', 6, { fields: { ...fields, concern: 'Amended' }, expectedDraftVersion: 2 });
  const dirty = await call('encounter.completion', 7);
  await call('record.sign', 7);
  const diagnosis = { codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', primary: true };
  const second = { ...diagnosis, code: 'I10' };
  const invalidCoding = await failed(call('diagnosis.draft', 8, { diagnoses: [{ ...diagnosis, codeSystem: 'urn:invalid' }] }));
  await call('diagnosis.draft', 8, { diagnoses: [diagnosis, second] });
  const twoPrimary = await failed(call('diagnosis.confirm', 9));
  await call('diagnosis.draft', 9, { diagnoses: [diagnosis, { ...second, primary: false }] });
  await call('diagnosis.confirm', 10);
  await call('diagnosis.draft', 11, { diagnoses: [second] });
  await call('diagnosis.confirm', 12);
  const before = encounterViewSchema.parse(await call('encounter.read', 13));
  if (changeAfterRead) {
    targetId = workspaceId;
    await call('workspace.role', 1, { roleId: 'coordinator' });
    await call('workspace.advance-time', 0, { to: '2028-04-16T16:00:00Z' });
    await call('workspace.role', 2, { roleId: 'family-clinician' });
    targetId = before.id;
  }
  const key = v7();
  const atDecision = encounterViewSchema.parse(await call('encounter.read', 13));
  const complete = () => call('encounter.complete', 13, {}, key);
  const outcomes = [await failed(complete()), await failed(complete())];
  const after = await store.read(reader => ({ encounter: reader.get(at, 'encounters', targetId), audits: reader.list(at, 'audit_events', { operation: 'encounter.complete' }).length,
    receipts: reader.list(at, 'command_receipts', { operation: 'encounter.complete' }).length }));
  return { incomplete, staleDraft, dirty, invalidCoding, twoPrimary, before, atDecision, outcomes, after };
}
