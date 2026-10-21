import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientDiagnosisSchema } from './inpatient-clinical.ts'
import { inpatientSurgeryExecutionSchema } from './inpatient-surgery.ts'
import { inpatientSettlementPreviewSchema, inpatientDischargeEventsSchema } from './inpatient-discharge.ts'
const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const stamp = z.iso.datetime({ offset: true })
const actor = { actorId: z.string().min(1), practitionerRoleId: id, recordedAt: stamp }
export const inpatientRecordSnapshotSchema = z.object({
  patient: z.object({ patientId: id, patientVersion: z.string(), identifier: z.string(), name: z.string(), gender: z.string(), birthDate: z.string(), recordNumber: z.string().nullable(), admissionCount: z.number().int().positive() }).strict(),
  stay: z.object({ admissionId: id, inpatientNumber: z.string(), admissionRoute: z.string(), registeredAt: stamp, admittedAt: stamp.optional(), initialWardId: id.optional(), initialOrganizationId: id.optional(), dischargeWardId: id, dischargeOrganizationId: id,
    transfers: z.array(z.object({ id, sourceWardId: id, targetWardId: id, receivedAt: stamp }).strict()), events: inpatientDischargeEventsSchema.shape.events, departedAt: stamp.optional(), departureMethod: z.string().optional() }).strict(),
  clinical: z.object({ diagnosis: inpatientDiagnosisSchema, operations: z.array(inpatientSurgeryExecutionSchema.extend({ procedureVersion: z.string(), primary: z.boolean() })), mainProcedureExecutionId: id.nullable() }).strict(),
  fees: inpatientSettlementPreviewSchema.extend({ categoryNetFen: z.record(z.string(), z.number().int().safe()) }),
}).strict()
export const inpatientRecordRevisionSchema = z.object({ revision: z.number().int().positive(), sourcesHash: hash, snapshot: inpatientRecordSnapshotSchema, ...actor }).strict()
export const inpatientRecordReviewSchema = z.object({ id, revision: z.number().int().positive(), sourcesHash: hash, outcome: z.enum(['approved', 'returned']), reason: z.string().optional(), ...actor }).strict()
export const inpatientRecordArchiveSchema = z.object({ id, revision: z.number().int().positive(), reviewId: id, sourcesHash: hash, snapshot: inpatientRecordSnapshotSchema, ...actor }).strict()
export const inpatientRecordSchema = z.object({ admissionId: id, recordNumber: z.string().nullable(), sourcesHash: hash, snapshot: inpatientRecordSnapshotSchema,
  revision: inpatientRecordRevisionSchema.optional(), reviews: z.array(inpatientRecordReviewSchema), archive: inpatientRecordArchiveSchema.optional(), reviewCurrent: z.boolean() }).strict()
export const inpatientRecordSubmitInputSchema = z.object({ admissionId: id, expectedRevision: z.number().int().nonnegative(), expectedSourcesHash: hash, mainProcedureExecutionId: id.nullable() }).strict()
export const inpatientRecordReviewInputSchema = z.object({ admissionId: id, expectedRevision: z.number().int().positive(), expectedSourcesHash: hash, outcome: z.enum(['approved', 'returned']), reason: z.string().trim().min(1).max(2000).optional() }).strict().refine(value => value.outcome !== 'returned' || value.reason !== undefined, '退回需要原因')
export const inpatientRecordArchiveInputSchema = z.object({ admissionId: id, expectedRevision: z.number().int().positive(), expectedSourcesHash: hash }).strict()
export const inpatientRecordResponseSchema = commandResponseSchema(inpatientRecordSchema)
