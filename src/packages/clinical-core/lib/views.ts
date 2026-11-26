import { z } from 'zod';
import { caseTruthSchema, catalogSchema, manifestSchema, publicCaseSchema } from '../../data-pack';
import { gateItem, practitionerRole, sessionSchema, workbenchTab } from '../../platform';
import { visitSchema } from '../../patient-visit';

export const workspaceSchema = sessionSchema.extend({ manifest: manifestSchema, roles: z.array(practitionerRole), cases: z.array(publicCaseSchema),
  diagnoses: catalogSchema.shape.diagnoses, packs: z.array(z.object({ id: z.string(), name: manifestSchema.shape.name })),
  virtualTime: z.iso.datetime(), clockRevision: z.int(), enabledModules: z.array(z.string()), tabs: z.array(workbenchTab),
  operations: z.array(z.object({ name: z.string(), method: z.enum(['GET', 'POST', 'PUT']), path: z.string() })) });
export type WorkspaceView = z.infer<typeof workspaceSchema>;

export const noteFields = z.record(z.string().min(1).max(100), z.string().max(16000));
export const diagnosisMember = z.strictObject({ codeSystem: z.url(), code: z.string().trim().min(1).max(128), primary: z.boolean() });
export const diagnosisMembers = z.array(diagnosisMember).min(1).max(8);
const revision = z.object({ id: z.uuidv7(), revision: z.int().positive(), previousId: z.uuidv7().nullable(), signedBy: z.string(), virtualAt: z.iso.datetime() });
export const recordRevision = revision.extend({ fields: noteFields });
export const diagnosisRevision = revision.extend({ diagnoses: diagnosisMembers });
export const completionSchema = z.object({ ready: z.boolean(), checks: z.array(gateItem) });
export const encounterViewSchema = visitSchema.extend({ age: z.int(), template: manifestSchema.shape.clinicalRecordTemplate,
  draftVersion: z.int().nonnegative(), fields: noteFields, diagnoses: z.array(diagnosisMember), recordRevisions: z.array(recordRevision), diagnosisRevisions: z.array(diagnosisRevision), completion: completionSchema });
export type EncounterView = z.infer<typeof encounterViewSchema>;
export const debriefSchema = z.object({ caseTruth: caseTruthSchema.extend({ tags: z.array(z.string()) }), recordRevisions: z.array(recordRevision), diagnosisRevisions: z.array(diagnosisRevision) });
