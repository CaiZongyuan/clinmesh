import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientMaterialItemSchema } from './inpatient-surgery.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const text = z.string().trim().min(1).max(2000)
export const pciMaterialCategorySchema = z.enum(['guidewire', 'guiding-catheter', 'balloon', 'stent'])
export const pciMeasurementSchema = z.object({
  kind: z.enum(['lesion-length', 'proximal-reference-diameter', 'distal-reference-diameter']),
  object: z.enum(['lesion', 'reference-lumen', 'external-elastic-membrane', 'unknown']),
  site: text, value: z.number().positive().finite().max(1000).nullable(), unit: text.nullable(), method: text,
  source: z.object({ reference: text, version: text, note: text, synthetic: z.boolean() }).strict(),
}).strict()
export const inpatientPciSelectionParametersSchema = z.object({
  requestId: id.optional(), treatmentPlan: text, targetSite: text,
  measurements: z.array(pciMeasurementSchema).max(3).refine(items => new Set(items.map(item => item.kind)).size === items.length, '同类测量不得重复'),
  plannedQuantities: z.array(z.object({ category: pciMaterialCategorySchema, quantity: z.number().int().positive().max(1000).nullable(), basis: text }).strict())
    .max(4).refine(items => new Set(items.map(item => item.category)).size === items.length, '同类数量依据不得重复'),
  approvedMaterialIds: z.array(id).max(20).refine(items => new Set(items).size === items.length, '认可的候选不得重复'),
}).strict()
export const inpatientPciSelectionConfirmInputSchema = z.object({
  admissionId: id, expectedVersion: z.number().int().nonnegative(), parameters: inpatientPciSelectionParametersSchema,
}).strict()
export const inpatientPciSelectionConfirmationSchema = z.object({
  id, version: z.number().int().positive(), parameters: inpatientPciSelectionParametersSchema,
  confirmedBy: text, practitionerRoleId: id, confirmedAt: z.iso.datetime({ offset: true }),
}).strict()
export const pciSelectionEvidenceSchema = z.object({
  id, version: text, synthetic: z.literal(true), scope: text, applicability: text, compatibility: text,
  specification: text, quantityBasis: text, sourceLocator: text,
}).strict()
export const pciSelectionCandidateSchema = z.object({
  materialId: id, materialVersion: z.number().int().positive(), category: pciMaterialCategorySchema,
  item: inpatientMaterialItemSchema.nullable(), evidence: pciSelectionEvidenceSchema,
  eligibility: z.enum(['valid', 'incomplete', 'inapplicable', 'unavailable']), missing: z.array(text),
  expectedQuantity: z.number().int().positive().max(1000).nullable(), expectedAmountFen: z.number().int().nonnegative().safe().nullable(),
}).strict()
export const inpatientPciSelectionSchema = z.object({
  admissionId: id, confirmation: inpatientPciSelectionConfirmationSchema.nullable(),
  history: z.array(inpatientPciSelectionConfirmationSchema),
  evidencePackage: z.object({ id, version: text, synthetic: z.literal(true), limitation: text }).strict(),
  candidates: z.array(pciSelectionCandidateSchema),
}).strict()
export const inpatientPciSelectionResponseSchema = commandResponseSchema(inpatientPciSelectionSchema)
export type InpatientPciSelection = z.infer<typeof inpatientPciSelectionSchema>
export type InpatientPciSelectionParameters = z.infer<typeof inpatientPciSelectionParametersSchema>
