import { v7 } from 'uuid';
import { z } from 'zod';
import { publicCaseSchema, readClinicalCase } from '../../data-pack';
import { checkVersion, CoreError, localizedName, type CommandContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope } from '../../store';

export function requireEncounter(reader: StoreReader, at: StoreScope, id: string) {
  const encounter = reader.get(at, 'encounters', id);
  if (!encounter) throw new CoreError(404, 'ENCOUNTER_NOT_FOUND');
  return encounter;
}

export function editEncounter(context: CommandContext, status: 'active' | 'completed' = 'active', beforeUpdate?: () => void) {
  const { tx, at, actor, targetId, expectedVersion } = context;
  const encounter = requireEncounter(tx, at, targetId);
  if (encounter.status === 'completed') throw new CoreError(409, 'ENCOUNTER_COMPLETED');
  if (encounter.active_practitioner_role !== actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  checkVersion(encounter.version, expectedVersion);
  beforeUpdate?.();
  tx.update(at, 'encounters', targetId, expectedVersion, { status });
  return expectedVersion + 1;
}

export function startEncounter(context: CommandContext, language?: 'en' | 'zh') {
  const { tx, at, targetId, actor, virtualAt, recordedAt } = context;
  checkVersion(0, context.expectedVersion);
  const patientCase = readClinicalCase(tx, at, targetId);
  if (!patientCase) throw new CoreError(404, 'CASE_NOT_FOUND');
  if (tx.list(at, 'encounters', { source_case_id: targetId, status: 'active' }).length) throw new CoreError(409, 'CASE_ALREADY_ACTIVE');
  const { demographics } = patientCase;
  const identifiers = demographics.identifiers.map(identifier => ({ identifier, existing: tx.list(at, 'patient_identifiers', identifier)[0] }));
  const matches = new Set(identifiers.flatMap(({ existing }) => existing ? [existing.patient_id] : []));
  if (matches.size > 1) throw new CoreError(409, 'PATIENT_IDENTITY_CONFLICT');
  const patientId = matches.values().next().value ?? v7();
  if (!matches.size) tx.insert(at, 'patients', { id: patientId, display_name: demographics.name, birth_date: demographics.birthDate, version: 1 });
  for (const { identifier, existing } of identifiers) if (!existing) tx.insert(at, 'patient_identifiers', { id: v7(), patient_id: patientId, ...identifier });
  const role = actor.role.capabilities.includes('assess') ? actor.role : actor.roles.find(candidate => candidate.capabilities.includes('assess'));
  if (!role) throw new CoreError(409, 'RESPONSIBLE_ROLE_UNAVAILABLE');
  const encounterId = v7();
  const consultationId = v7();
  const times = { virtual_at: virtualAt, recorded_at: recordedAt };
  tx.insert(at, 'encounters', { id: encounterId, patient_id: patientId, source_case_id: targetId, encounter_class: patientCase.encounterClass,
    active_practitioner_role: role.id, version: 1, status: 'active', ...times });
  tx.insert(at, 'encounter_triage', { id: v7(), encounter_id: encounterId, vitals: patientCase.triageVitals, ...times });
  tx.insert(at, 'consultations', { id: consultationId, encounter_id: encounterId, reply_pending: false, version: 1 });
  const opening = z.object({ openingStatement: localizedName }).parse(tx.list(at, 'case_personas', { case_id: targetId })[0]?.persona);
  const manifest = tx.list(at, 'data_pack_installations')[0]!.manifest;
  const locale = language ?? (String(manifest.defaultLocale).startsWith('zh') ? 'zh' : 'en');
  tx.insert(at, 'consultation_turns', { id: v7(), consultation_id: consultationId, ordinal: 1, speaker: 'patient', channel: 'text', content: opening.openingStatement[locale], ...times });
  return { encounterId, version: 1 };
}

export const summarySchema = z.object({ id: z.uuidv7(), patientId: z.uuidv7(), name: z.string(), status: z.enum(['active', 'completed']), version: z.int().positive(), responsibleRole: z.string(), startedAt: z.iso.datetime() });
export const visitSchema = summarySchema.extend({
  patient: publicCaseSchema.shape.demographics, encounterClass: publicCaseSchema.shape.encounterClass,
  priorHistory: publicCaseSchema.shape.priorHistory, triageVitals: publicCaseSchema.shape.triageVitals,
  replyPending: z.boolean(), turns: z.array(z.object({ id: z.uuidv7(), ordinal: z.int().positive(), speaker: z.enum(['clinician', 'patient']), channel: z.enum(['text', 'voice']), content: z.string(), virtualAt: z.iso.datetime() })),
});

function summary(encounter: EntityRow<'encounters'>, name: string) {
  return summarySchema.parse({ id: encounter.id, patientId: encounter.patient_id, name, status: encounter.status, version: encounter.version,
    responsibleRole: encounter.active_practitioner_role, startedAt: encounter.virtual_at });
}

export function listEncounters(reader: StoreReader, at: StoreScope) {
  const names = new Map(reader.list(at, 'patients').map(patient => [patient.id, patient.display_name]));
  return reader.list(at, 'encounters').map(encounter => summary(encounter, names.get(encounter.patient_id)!));
}

export function readVisit(reader: StoreReader, at: StoreScope, id: string) {
  const encounter = requireEncounter(reader, at, id);
  const patientCase = readClinicalCase(reader, at, encounter.source_case_id)!;
  const identity = reader.get(at, 'patients', encounter.patient_id)!;
  const identifiers = reader.list(at, 'patient_identifiers', { patient_id: identity.id }).map(({ issuer, value }) => ({ issuer, value }));
  const patient = { ...patientCase.demographics, name: identity.display_name, birthDate: identity.birth_date ?? patientCase.demographics.birthDate, identifiers };
  const triage = reader.list(at, 'encounter_triage', { encounter_id: id })[0];
  const consultation = reader.list(at, 'consultations', { encounter_id: id })[0]!;
  const turns = reader.list(at, 'consultation_turns', { consultation_id: consultation.id }).sort((first, second) => first.ordinal - second.ordinal);
  return visitSchema.parse({ ...summary(encounter, patient.name), patient, encounterClass: patientCase.encounterClass,
    priorHistory: patientCase.priorHistory, triageVitals: triage?.vitals ?? patientCase.triageVitals, replyPending: consultation.reply_pending,
    turns: turns.map(turn => ({ id: turn.id, ordinal: turn.ordinal, speaker: turn.speaker, channel: turn.channel, content: turn.content, virtualAt: turn.virtual_at })) });
}
