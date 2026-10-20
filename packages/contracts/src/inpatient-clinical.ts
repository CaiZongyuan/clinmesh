import { referenceConceptSnapshotSchema } from './reference-data.ts'
import { z } from 'zod'
import { commandResponseSchema } from './his.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version = z.string().regex(/^\d+$/)
const coding = referenceConceptSnapshotSchema.extend({ releaseId: z.string().min(1).optional() })
export const inpatientAdmissionConditionSchema = z.enum(['1','2','3','4'])
export const inpatientDiagnosisConfirmInputSchema = z.object({ admissionId: id, encounterVersion: version,
  expectedRevision: z.number().int().nonnegative(), entries: z.array(z.object({ catalogItemId: z.string().min(1).max(256),
    role: z.enum(['primary', 'secondary']), admissionCondition: inpatientAdmissionConditionSchema, note: z.string().trim().min(1).max(2000).optional() }).strict()).min(1).max(20),
}).strict().refine(value => value.entries.filter(entry => entry.role === 'primary').length === 1 && new Set(value.entries.map(entry => entry.catalogItemId)).size === value.entries.length,
  '住院诊断须包含一个主诊断且不能重复')
export const inpatientDiagnosisSchema = z.object({ revision: z.number().int().nonnegative(), entries: z.array(z.object({
  conditionId: id, role: z.enum(['primary', 'secondary']), admissionCondition: inpatientAdmissionConditionSchema, ordinal: z.number().int().positive(), coding, note: z.string().optional(),
}).strict()) }).strict()
const inpatientClinicalCatalogSchema = z.object({ diagnoses: z.array(coding) }).strict()
const inpatientClinicalSchema = z.object({ admissionId: id, encounterVersion: version, diagnosis: inpatientDiagnosisSchema }).strict()

export const inpatientOrderIssueInputSchema = z.object({ admissionId: id, encounterVersion: version,
  duration: z.enum(['long','temporary']), selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('medication'), catalogItemId: id, catalogVersion: z.number().int().positive(), doseText: z.string().trim().min(1).max(120),
      frequencyCode: z.enum(['QD','BID','PRN']), doseQuantity: z.number().int().positive().max(100) }).strict(),
    z.object({ kind: z.literal('service'), serviceId: id, serviceVersion: z.number().int().positive(), quantity: z.number().int().positive().max(100) }).strict(),
  ]),
}).strict()
export const inpatientOrderActionInputSchema = z.object({ admissionId: id, orderId: id, expectedOrderVersion: z.number().int().positive() }).strict()
export const inpatientOrderReasonInputSchema = inpatientOrderActionInputSchema.extend({ reason: z.string().trim().min(1).max(2000) })
export const inpatientExecutionActionInputSchema = z.object({ admissionId: id, executionId: id, expectedExecutionVersion: z.number().int().positive() }).strict()
export const inpatientDispenseInputSchema = inpatientExecutionActionInputSchema.extend({ lotSelections: z.array(z.object({
  lotId: id, expectedVersion: z.number().int().positive(), quantity: z.number().int().positive().max(100),
}).strict()).min(1).max(20) })
export const inpatientChargeReverseInputSchema = z.object({ admissionId: id, chargeId: id, expectedChargeVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict()
export const inpatientOrderSchema = z.object({ id, admissionId: id, kind: z.enum(['medication','service']), duration: z.enum(['long','temporary']),
  catalogItemId: id, catalogVersion: z.number().int().positive(), display: z.string(), doseText: z.string(), doseQuantity: z.number().int().positive(),
  unit: z.string(), frequencyCode: z.enum(['QD','BID','PRN']), state: z.enum(['signed','verified','stop-requested','stopped','completed']),
  version: z.number().int().positive(), requestVersion: version, signedAt: z.iso.datetime({ offset: true }), signedBy: z.string(),
  organizationId: id, verifiedAt: z.iso.datetime({ offset: true }).optional(), stoppedAt: z.iso.datetime({ offset: true }).optional(),
}).strict()
export const inpatientExecutionSchema = z.object({ id, orderId: id, scheduledFor: z.iso.datetime({ offset: true }),
  status: z.enum(['pending','dispensed','completed','cancelled']), version: z.number().int().positive(), administrationId: id.optional(),
  reason: z.string().optional(),
}).strict()
export const inpatientDispenseSchema = z.object({ id, executionId: id, lotId: id, quantity: z.number().int().positive(), dispensedAt: z.iso.datetime({ offset: true }), dispensedBy: z.string() }).strict()
export const inpatientChargeSchema = z.object({ id, kind: z.string(), sourceId: id, organizationId: id, serviceDate: z.string(), amountFen: z.number().int().safe(),
  virtualTime: z.iso.datetime({ offset: true }), version: z.number().int().positive(), reversalOf: id.optional(), reason: z.string().optional() }).strict()
export const inpatientMedicationSchema = z.object({ id, display: z.string(), version: z.number().int().positive(), priceFen: z.number().int().nonnegative(), unit: z.string(),
  doses: z.array(z.object({ doseText: z.string(), quantity: z.number().int().positive() }).strict()), frequencyCodes: z.array(z.enum(['QD','BID','PRN'])),
  lots: z.array(z.object({ id, version: z.number().int().positive(), quantityOnHand: z.number().int().nonnegative(), expiresOn: z.string() }).strict()),
}).strict()
export const inpatientServiceSchema = z.object({ id, display: z.string(), version: z.number().int().positive(), priceFen: z.number().int().nonnegative(), unit: z.string() }).strict()
export const inpatientFullCatalogSchema = inpatientClinicalCatalogSchema.extend({ medications: z.array(inpatientMedicationSchema), services: z.array(inpatientServiceSchema) })
export const inpatientFullClinicalSchema = inpatientClinicalSchema.extend({ orders: z.array(inpatientOrderSchema), executions: z.array(inpatientExecutionSchema),
  dispenses: z.array(inpatientDispenseSchema), charges: z.array(inpatientChargeSchema), chargesFen: z.number().int().nonnegative().safe() })
export const inpatientFullClinicalResponseSchema = commandResponseSchema(inpatientFullClinicalSchema)
export type InpatientOrder = z.infer<typeof inpatientOrderSchema>
