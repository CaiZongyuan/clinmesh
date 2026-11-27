import { z } from 'zod';
import { editEncounter, readVisit, requireEncounter } from '../../patient-visit';
import { catalogSchema } from '../../data-pack';
import { CoreError, type Actor, type ModuleRegistry, type OperationCatalog } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';
import { confirmDiagnoses, currentRecordFields, diagnosisState, patientPresentation, recordState, retiredRecordFields, reviewedDiagnosisDraft, sameRecord, saveDiagnoses, saveRecord, signRecord } from './records';
import { completionSchema, debriefSchema, diagnosisMembers, encounterViewSchema, noteFields, retiredReview } from './views';

type Registry = ModuleRegistry<OperationCatalog>;
type CoreState = ReturnType<typeof clinicalState>;
const base = '/api/his/encounters/:id';
const assess = { capabilities: ['assess'] };
const sign = { capabilities: ['sign'] };
const version = z.object({ version: z.int().positive() });
const revision = version.extend({ revision: z.int().positive() });

function clinicalState(reader: StoreReader, at: StoreScope, id: string) {
  const presentation = patientPresentation(reader, at, id);
  const record = recordState(reader, at, id);
  const signed = record.recordRevisions.at(-1);
  return { age: presentation.age, template: presentation.template, ...record, fields: currentRecordFields(presentation.template, record.fields),
    retiredFields: retiredRecordFields(presentation.template, record.fields, signed?.fields ?? {}),
    recordReviewed: signed ? sameRecord(record.fields, signed.fields) : !record.draftVersion, ...diagnosisState(reader, at, id) };
}

function completion(reader: StoreReader, at: StoreScope, id: string, state: CoreState, registry: Registry, enabled: string[]) {
  const record = state.recordRevisions.at(-1);
  const confirmation = state.diagnosisRevisions.at(-1);
  const checks = [
    { id: 'signed-record', label: { en: 'Signed clinical record', zh: '病历已签署' }, passed: Boolean(record) },
    { id: 'primary-diagnosis', label: { en: 'Confirmed primary diagnosis', zh: '主诊断已确认' }, passed: Boolean(confirmation?.diagnoses.some(item => item.primary)) },
    { id: 'drafts-reviewed', label: { en: 'All drafts reviewed', zh: '草稿已核对' }, passed: state.recordReviewed && reviewedDiagnosisDraft(state) },
    ...registry.enabled(enabled, reader, at).flatMap(module => module.completion?.(reader, at, id) ?? []),
  ];
  return { ready: checks.every(check => check.passed), checks };
}

export function registerClinicalOperations(catalog: OperationCatalog, registry: Registry) {
  catalog.query({ name: 'catalog.diagnoses', path: `${base}/diagnosis-catalog`, access: assess, assistantRead: 'encounter' }, catalogSchema.shape.diagnoses, ({ reader, actor, targetId }) => {
    requireEncounter(reader, actor.at, targetId);
    return reader.list(actor.at, 'catalog_items', { kind: 'diagnoses' }).map(row => catalogSchema.shape.diagnoses.element.parse(row.definition));
  });
  catalog.query({ name: 'encounter.read', path: base, access: {}, assistantRead: 'encounter' }, encounterViewSchema, ({ reader, actor, targetId }) => {
    const visit = readVisit(reader, actor.at, targetId);
    const state = clinicalState(reader, actor.at, targetId);
    return { ...visit, ...state, completion: completion(reader, actor.at, targetId, state, registry, actor.enabledModules) };
  });
  catalog.command({ name: 'record.draft', method: 'PUT', path: `${base}/clinical-record/draft`, access: assess, risk: 'write' }, { expectedDraftVersion: z.int().nonnegative(), fields: noteFields },
    version.extend({ draftVersion: z.int() }), (context, input) => saveRecord(context, input.fields, input.expectedDraftVersion));
  catalog.command({ name: 'record.sign', method: 'POST', path: `${base}/clinical-record/sign`, access: sign }, { expectedDraftVersion: z.int().nonnegative().optional(), retiredReview: retiredReview.optional() },
    revision.extend({ draftVersion: z.int().positive().optional(), reviewed: retiredReview.shape.decision.optional() }), (context, input) => signRecord(context, input.expectedDraftVersion, input.retiredReview));
  catalog.command({ name: 'diagnosis.draft', method: 'PUT', path: `${base}/diagnosis/draft`, access: assess, risk: 'write' }, { diagnoses: diagnosisMembers }, version, (context, input) => saveDiagnoses(context, input.diagnoses));
  catalog.command({ name: 'diagnosis.confirm', method: 'POST', path: `${base}/diagnosis/confirm`, access: sign }, {}, revision, confirmDiagnoses);
  catalog.query({ name: 'encounter.completion', path: `${base}/completion`, access: {} }, completionSchema, ({ reader, actor, targetId }) => {
    requireEncounter(reader, actor.at, targetId);
    return completion(reader, actor.at, targetId, clinicalState(reader, actor.at, targetId), registry, actor.enabledModules);
  });
  catalog.command({ name: 'encounter.complete', method: 'POST', path: `${base}/complete`, access: sign }, { clinicalOverride: z.unknown().optional() }, version, (context, input) => {
    const { tx, at, targetId, actor } = context;
    const nextVersion = editEncounter(context, 'completed', () => {
      if (!completion(tx, at, targetId, clinicalState(tx, at, targetId), registry, actor.enabledModules).ready) throw new CoreError(409, 'COMPLETION_BLOCKED');
      context.checkClinicalQuality?.({ kind: 'complete', encounterId: targetId }, input.clinicalOverride);
    });
    return { version: nextVersion };
  });
}

export function readCompletedDebrief(reader: StoreReader, actor: Actor, encounterId: string) {
  if (actor.kind !== 'visitor') throw new CoreError(403, 'ROLE_FORBIDDEN');
  const encounter = requireEncounter(reader, actor.at, encounterId);
  if (encounter.status !== 'completed') throw new CoreError(403, 'CASE_TRUTH_LOCKED');
  if (actor.role.id !== encounter.active_practitioner_role) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  const row = reader.readPrivateCaseTruth(actor.at, { purpose: 'completed-debrief', encounterId });
  if (!row) throw new CoreError(404, 'DEBRIEF_UNAVAILABLE');
  const { recordRevisions, diagnosisRevisions } = clinicalState(reader, actor.at, encounterId);
  return debriefSchema.parse({ caseTruth: row.truth, recordRevisions, diagnosisRevisions });
}
