import { z } from 'zod'
import { commandResponseSchema } from './his.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version = z.number().int().positive()
const note = z.string().trim().min(1).max(2000)
export const inpatientProcedureCodingSchema = z.object({ system: z.literal('urn:clinmesh:classification:icd-9-cm-3-clinical'),
  version: z.literal('3.0'), code: z.string().min(1), display: z.string().min(1), category: z.enum(['手术','介入治疗','诊断性操作']),
  releaseId: z.literal('clinmesh-surgery-subset-2026-10-20'), sourceUrl: z.url(), sourceSha256: z.string().length(64), sourceLocator: z.string().min(1),
}).strict()
const charge = z.object({ id, priceFen: z.number().int().nonnegative().safe(), unit: z.string().min(1),
  synthetic: z.literal(true), trigger: z.literal('execution') }).strict()
export const inpatientProcedureItemSchema = z.object({ id, version, coding: inpatientProcedureCodingSchema, chargeDefinition: charge }).strict()
export const inpatientMaterialItemSchema = z.object({ id, version, display: z.string().min(1), chargeDefinition: charge }).strict()
export const inpatientSurgeryCatalogSchema = z.object({ procedures: z.array(inpatientProcedureItemSchema), materials: z.array(inpatientMaterialItemSchema) }).strict()
export const inpatientSurgeryRequestInputSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  procedureId: id, catalogVersion: version, plannedFor: z.iso.datetime({ offset: true }), reason: note }).strict()
export const inpatientSurgeryActionInputSchema = z.object({ admissionId: id, requestId: id, expectedRequestVersion: version, note }).strict()
export const inpatientSurgeryExecuteInputSchema = inpatientSurgeryActionInputSchema.omit({ note: true }).extend({ procedureId: id, catalogVersion: version, note,
  materials: z.array(z.object({ materialId: id, catalogVersion: version, quantity: z.number().int().positive().max(1000) }).strict()).max(20)
    .refine(items => new Set(items.map(item => item.materialId)).size === items.length, '耗材不得重复'),
})
const preparation = z.object({ actorId: z.string().min(1), practitionerRoleId: id, recordedAt: z.iso.datetime({ offset: true }), note }).strict()
export const inpatientSurgeryRequestSchema = z.object({ id, admissionId: id, version, status: z.enum(['requested','ready','completed','cancelled']),
  plannedProcedure: inpatientProcedureItemSchema, plannedFor: z.iso.datetime({ offset: true }), reason: note,
  requestedAt: z.iso.datetime({ offset: true }), requestedBy: z.string().min(1), organizationId: id,
  preopCheck: preparation.optional(), consentConfirmation: preparation.optional(), cancellation: preparation.optional(),
}).strict()
export const inpatientSurgeryExecutionSchema = z.object({ id, admissionId: id, requestId: id, actualProcedure: inpatientProcedureItemSchema,
  performedAt: z.iso.datetime({ offset: true }), performedBy: z.string().min(1), practitionerRoleId: id, organizationId: id, note,
  materials: z.array(z.object({ id, item: inpatientMaterialItemSchema, quantity: z.number().int().positive().max(1000), amountFen: z.number().int().nonnegative().safe() }).strict()),
}).strict()
export const inpatientSurgerySchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/), virtualTime: z.iso.datetime({ offset: true }),
  requests: z.array(inpatientSurgeryRequestSchema), executions: z.array(inpatientSurgeryExecutionSchema) }).strict()
export const inpatientSurgeryResponseSchema = commandResponseSchema(inpatientSurgerySchema)
