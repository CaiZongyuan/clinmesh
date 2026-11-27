import { v7 } from 'uuid';
import { z } from 'zod';
import { manifestSchema, organizationSchema, readClinicalCase } from '../../data-pack';
import { editEncounter, requireEncounter } from '../../patient-visit';
import { checkVersion, CoreError, type CommandContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope } from '../../store';
import { diagnosisMember, noteFields, retiredReview } from './views';

export function ageOn(birthDate: string, date: string) {
  return Number(date.slice(0, 4)) - Number(birthDate.slice(0, 4)) - Number(date.slice(5, 10) < birthDate.slice(5));
}

export function patientPresentation(reader: StoreReader, at: StoreScope, encounterId: string) {
  const encounter = requireEncounter(reader, at, encounterId);
  const patientCase = readClinicalCase(reader, at, encounter.source_case_id)!;
  const pack = reader.list(at, 'data_pack_installations')[0]!;
  const manifest = manifestSchema.parse(pack.manifest);
  const practitioners = organizationSchema.parse(pack.organization).practitioners.filter(member => member.roleId === encounter.active_practitioner_role);
  const now = reader.getEpoch(at)!.virtual_time;
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: manifest.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const birthDate = reader.get(at, 'patients', encounter.patient_id)?.birth_date ?? patientCase.demographics.birthDate;
  const age = ageOn(birthDate, calendar.format(new Date(now)));
  const initialAge = ageOn(birthDate, calendar.format(new Date(encounter.virtual_at)));
  const applicable = manifest.clinicalRecordTemplate.filter(({ showWhen }) => !showWhen || (
    (!showWhen.departmentId || practitioners.some(member => member.departmentId === showWhen.departmentId)) &&
    (!showWhen.encounterClass || showWhen.encounterClass === encounter.encounter_class) && (!showWhen.sex || showWhen.sex === patientCase.demographics.sex) &&
    (showWhen.minAge === undefined || age >= showWhen.minAge) && (showWhen.maxAge === undefined || initialAge <= showWhen.maxAge)));
  const template = applicable.filter(({ showWhen }) => showWhen?.maxAge === undefined || age <= showWhen.maxAge);
  const retiredIds = new Set(applicable.filter(field => !template.includes(field)).map(field => field.id));
  return { age, template, retiredIds };
}

export function recordState(reader: StoreReader, at: StoreScope, encounterId: string) {
  const filter = { encounter_id: encounterId };
  const draft = reader.list(at, 'clinical_record_drafts', filter)[0];
  const revisions = reader.list(at, 'clinical_record_revisions', filter).sort((first, second) => first.revision - second.revision);
  return { draftVersion: draft?.version ?? 0, fields: noteFields.parse(draft?.fields ?? {}), recordRevisions: revisions.map(row => ({
    id: row.id, revision: row.revision, previousId: row.previous_revision_id, signedBy: row.signed_by, virtualAt: row.virtual_at, fields: noteFields.parse(row.fields),
  })) };
}

export function currentRecordFields(template: readonly { id: string }[], fields: Record<string, string>) {
  return Object.fromEntries(template.filter(field => Object.hasOwn(fields, field.id)).map(field => [field.id, fields[field.id]!]));
}

export function sameRecord(first: Record<string, string>, second: Record<string, string>) {
  return Object.keys(first).length === Object.keys(second).length && Object.entries(first).every(([id, value]) => second[id] === value);
}

export function retiredRecordFields(template: readonly { id: string }[], saved: Record<string, string>, signed: Record<string, string>) {
  const visible = new Set(template.map(field => field.id));
  const ids = new Set([...Object.keys(saved), ...Object.keys(signed)]);
  return Object.fromEntries([...ids].filter(id => !visible.has(id)).map(id => [id, { saved: Object.hasOwn(saved, id) ? saved[id]! : null, signed: Object.hasOwn(signed, id) ? signed[id]! : null }]));
}

export function saveRecord(context: CommandContext, fields: Record<string, string>, expectedDraftVersion: number) {
  const { tx, at, targetId } = context;
  const version = editEncounter(context);
  const { template: visible } = patientPresentation(tx, at, targetId);
  if (Object.keys(fields).some(id => !visible.some(field => field.id === id))) throw new CoreError(400, 'FIELD_NOT_IN_TEMPLATE');
  const draft = tx.list(at, 'clinical_record_drafts', { encounter_id: targetId })[0];
  checkVersion(draft?.version ?? 0, expectedDraftVersion);
  if (draft) {
    const retained = Object.fromEntries(Object.entries(draft.fields).filter(([id]) => !visible.some(field => field.id === id)));
    tx.update(at, 'clinical_record_drafts', draft.id, expectedDraftVersion, { fields: { ...retained, ...fields } });
  }
  else tx.insert(at, 'clinical_record_drafts', { id: v7(), encounter_id: targetId, version: 1, fields });
  return { version, draftVersion: expectedDraftVersion + 1 };
}

export function signRecord(context: CommandContext, expectedDraftVersion?: number, review?: z.infer<typeof retiredReview>) {
  const { tx, at, targetId, actor } = context;
  const version = editEncounter(context);
  const state = recordState(tx, at, targetId);
  if (expectedDraftVersion !== undefined) checkVersion(state.draftVersion, expectedDraftVersion);
  const { template, retiredIds } = patientPresentation(tx, at, targetId);
  const previous = state.recordRevisions.at(-1);
  const retired = retiredRecordFields(template, state.fields, previous?.fields ?? {});
  if (review && (expectedDraftVersion === undefined || Object.keys(review.localFields).some(id => !retiredIds.has(id)))) throw new CoreError(400, 'INVALID_RETIRED_FIELD_REVIEW');
  const changed = Object.values(retired).some(field => field.saved !== field.signed);
  if (changed && !review) throw new CoreError(409, 'RETIRED_FIELDS_REQUIRE_REVIEW');
  if (review && !changed && !Object.keys(review.localFields).length) throw new CoreError(409, 'NO_RETIRED_FIELD_CHANGES');
  const fields = review?.decision === 'include' ? { ...state.fields, ...review.localFields } : currentRecordFields(template, state.fields);
  if (!state.draftVersion || template.some(field => field.required && !fields[field.id]?.trim())) throw new CoreError(409, 'REQUIRED_FIELDS_MISSING');
  const revision = (previous?.revision ?? 0) + 1;
  tx.insert(at, 'clinical_record_revisions', { id: v7(), encounter_id: targetId, fields, revision, previous_revision_id: previous?.id ?? null,
    signed_by: actor.role.id, virtual_at: context.virtualAt, recorded_at: context.recordedAt });
  const changedDraft = !sameRecord(fields, state.fields);
  if (changedDraft) {
    const draft = tx.list(at, 'clinical_record_drafts', { encounter_id: targetId })[0]!;
    tx.update(at, 'clinical_record_drafts', draft.id, state.draftVersion, { fields });
  }
  const receipt = { version, revision, draftVersion: state.draftVersion + Number(changedDraft) };
  return review ? { ...receipt, reviewed: review.decision } : receipt;
}

type Diagnosis = z.infer<typeof diagnosisMember>;
type MemberRow = Pick<EntityRow<'diagnosis_drafts'>, 'code_system' | 'code' | 'is_primary' | 'ordinal'>;
const byOrdinal = (first: MemberRow, second: MemberRow) => first.ordinal - second.ordinal;
const member = (row: MemberRow): Diagnosis => ({ codeSystem: row.code_system, code: row.code, primary: row.is_primary });

export function diagnosisState(reader: StoreReader, at: StoreScope, encounterId: string) {
  const filter = { encounter_id: encounterId };
  const diagnoses = reader.list(at, 'diagnosis_drafts', filter).sort(byOrdinal).map(member);
  const revisions = reader.list(at, 'diagnosis_revisions', filter).sort((first, second) => first.revision - second.revision);
  return { diagnoses, diagnosisRevisions: revisions.map(row => ({ id: row.id, revision: row.revision, previousId: row.previous_revision_id, signedBy: row.confirmed_by, virtualAt: row.virtual_at,
    diagnoses: reader.list(at, 'diagnosis_confirmations', { revision_id: row.id }).sort(byOrdinal).map(member) })) };
}

export function saveDiagnoses(context: CommandContext, diagnoses: Diagnosis[]) {
  const { tx, at, targetId } = context;
  const version = editEncounter(context);
  const seen = new Set<string>();
  for (const item of diagnoses) {
    const key = JSON.stringify([item.codeSystem, item.code]);
    if (seen.has(key)) throw new CoreError(400, 'DUPLICATE_DIAGNOSIS');
    if (!tx.list(at, 'catalog_items', { kind: 'diagnoses', code_system: item.codeSystem, code: item.code }).length) throw new CoreError(400, 'DIAGNOSIS_NOT_IN_CATALOG');
    seen.add(key);
  }
  for (const old of tx.list(at, 'diagnosis_drafts', { encounter_id: targetId })) tx.remove(at, 'diagnosis_drafts', old.id, old.version);
  diagnoses.forEach((item, index) => tx.insert(at, 'diagnosis_drafts', { id: v7(), encounter_id: targetId, version: 1, ordinal: index + 1,
    code: item.code, code_system: item.codeSystem, is_primary: item.primary, poa_code: null }));
  return { version };
}

export function confirmDiagnoses(context: CommandContext) {
  const { tx, at, targetId } = context;
  context.guardEncounter?.({ encounterId: targetId, kind: 'diagnose' });
  const version = editEncounter(context);
  const { diagnoses, diagnosisRevisions } = diagnosisState(tx, at, targetId);
  if (diagnoses.filter(item => item.primary).length !== 1) throw new CoreError(409, 'ONE_PRIMARY_DIAGNOSIS_REQUIRED');
  const previous = diagnosisRevisions.at(-1);
  const revision = (previous?.revision ?? 0) + 1;
  tx.appendDiagnosisRevision(at, { id: v7(), encounter_id: targetId, revision, previous_revision_id: previous?.id ?? null, confirmed_by: context.actor.role.id,
    virtual_at: context.virtualAt, recorded_at: context.recordedAt }, diagnoses.map((item, index) => ({ id: v7(), code: item.code, code_system: item.codeSystem, ordinal: index + 1, is_primary: item.primary, poa_code: null })));
  return { version, revision };
}
