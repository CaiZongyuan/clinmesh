import { z } from 'zod';
import { editEncounter, readVisit, requireEncounter } from '../../patient-visit';
import { CoreError, type ModuleRegistry, type OperationCatalog } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';
import { confirmDiagnoses, currentRecordFields, diagnosisState, patientPresentation, recordState, retiredRecordFields, sameRecord, saveDiagnoses, saveRecord, signRecord } from './records';
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
  const diagnosesClean = confirmation ? confirmation.diagnoses.length === state.diagnoses.length && confirmation.diagnoses.every((item, index) => {
    const draft = state.diagnoses[index];
    return draft && item.code === draft.code && item.codeSystem === draft.codeSystem && item.primary === draft.primary;
  }) : !state.diagnoses.length;
  const checks = [
    { id: 'signed-record', label: { en: 'Signed clinical record', zh: '病历已签署' }, passed: Boolean(record) },
    { id: 'primary-diagnosis', label: { en: 'Confirmed primary diagnosis', zh: '主诊断已确认' }, passed: Boolean(confirmation?.diagnoses.some(item => item.primary)) },
    { id: 'drafts-reviewed', label: { en: 'All drafts reviewed', zh: '草稿已核对' }, passed: state.recordReviewed && diagnosesClean },
    ...registry.enabled(enabled).flatMap(module => module.completion?.(reader, at, id) ?? []),
  ];
  return { ready: checks.every(check => check.passed), checks };
}

export function registerClinicalOperations(catalog: OperationCatalog, registry: Registry) {
  catalog.query({ name: 'encounter.read', path: base, access: {} }, encounterViewSchema, ({ reader, actor, targetId }) => {
    const visit = readVisit(reader, actor.at, targetId);
    const state = clinicalState(reader, actor.at, targetId);
    return { ...visit, ...state, completion: completion(reader, actor.at, targetId, state, registry, actor.enabledModules) };
  });
  catalog.command({ name: 'record.draft', method: 'PUT', path: `${base}/clinical-record/draft`, access: assess }, { expectedDraftVersion: z.int().nonnegative(), fields: noteFields },
    version.extend({ draftVersion: z.int() }), (context, input) => saveRecord(context, input.fields, input.expectedDraftVersion));
  catalog.command({ name: 'record.sign', method: 'POST', path: `${base}/clinical-record/sign`, access: sign }, { expectedDraftVersion: z.int().nonnegative().optional(), retiredReview: retiredReview.optional() },
    revision.extend({ draftVersion: z.int().positive().optional(), reviewed: retiredReview.shape.decision.optional() }), (context, input) => signRecord(context, input.expectedDraftVersion, input.retiredReview));
  catalog.command({ name: 'diagnosis.draft', method: 'PUT', path: `${base}/diagnosis/draft`, access: assess }, { diagnoses: diagnosisMembers }, version, (context, input) => saveDiagnoses(context, input.diagnoses));
  catalog.command({ name: 'diagnosis.confirm', method: 'POST', path: `${base}/diagnosis/confirm`, access: sign }, {}, revision, confirmDiagnoses);
  catalog.query({ name: 'encounter.completion', path: `${base}/completion`, access: {} }, completionSchema, ({ reader, actor, targetId }) => {
    requireEncounter(reader, actor.at, targetId);
    return completion(reader, actor.at, targetId, clinicalState(reader, actor.at, targetId), registry, actor.enabledModules);
  });
  catalog.command({ name: 'encounter.complete', method: 'POST', path: `${base}/complete`, access: sign }, {}, version, context => {
    const { tx, at, targetId, actor } = context;
    const nextVersion = editEncounter(context, 'completed', () => {
      if (!completion(tx, at, targetId, clinicalState(tx, at, targetId), registry, actor.enabledModules).ready) throw new CoreError(409, 'COMPLETION_BLOCKED');
    });
    return { version: nextVersion };
  });
  catalog.query({ name: 'encounter.debrief', path: `${base}/debrief`, access: {} }, debriefSchema, ({ reader, actor, targetId }) => {
    if (requireEncounter(reader, actor.at, targetId).status !== 'completed') throw new CoreError(403, 'CASE_TRUTH_LOCKED');
    const row = reader.readPrivateCaseTruth(actor.at, { purpose: 'completed-debrief', encounterId: targetId });
    if (!row) throw new CoreError(404, 'DEBRIEF_UNAVAILABLE');
    const { recordRevisions, diagnosisRevisions } = clinicalState(reader, actor.at, targetId);
    return { caseTruth: debriefSchema.shape.caseTruth.parse(row.truth), recordRevisions, diagnosisRevisions };
  });
}
