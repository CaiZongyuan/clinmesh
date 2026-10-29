import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientDrgAgentAnalysisSchema, inpatientDrgAgentMaterialSchema } from './inpatient-drg-agent.ts'
import { inpatientMaterialItemSchema } from './inpatient-surgery.ts'
import { pciSelectionEvidenceSchema } from './inpatient-pci-selection.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version = z.number().int().positive()
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().trim().min(1).max(2000)
export const inpatientMaterialEstimateItemInputSchema = z.object({
  materialId: id, catalogVersion: version, quantity: z.number().int().positive().max(1000), reason: text,
}).strict()
const items = z.array(inpatientMaterialEstimateItemInputSchema).max(20)
  .refine(values => new Set(values.map(item => item.materialId)).size === values.length, '预计耗材不得重复')
export const inpatientMaterialEstimateCandidateSchema = z.object({
  materialId: id, catalogVersion: version, item: inpatientMaterialItemSchema.nullable(),
  evidence: pciSelectionEvidenceSchema, quantityBasis: text,
  expectedQuantity: z.number().int().positive().max(1000).nullable(),
  eligibility: z.enum(['valid', 'incomplete', 'inapplicable', 'unavailable']), missing: z.array(text),
}).strict()
export const inpatientMaterialEstimateDraftSchema = z.object({
  revision: version, basisFingerprint: fingerprint, analysisId: id.nullable(),
  items, note: z.string().trim().max(2000), edited: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }), updatedBy: text,
  confirmedRevision: version.nullable(), reservationIds: z.array(id).max(20),
}).strict()
export const inpatientMaterialEstimateSchema = z.object({
  id, admissionId: id, requestId: id, version, requestVersion: version,
  status: z.enum(['incomplete', 'queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed', 'cancelled']),
  basisFingerprint: fingerprint, failureCode: text.nullable(), missing: z.array(text),
  candidates: z.array(inpatientMaterialEstimateCandidateSchema).max(20),
  analysis: inpatientDrgAgentAnalysisSchema.nullable(), draft: inpatientMaterialEstimateDraftSchema.nullable(),
  candidateItems: z.array(inpatientDrgAgentMaterialSchema).max(20),
}).strict()
export const inpatientMaterialEstimatesSchema = z.object({
  admissionId: id, estimates: z.array(inpatientMaterialEstimateSchema),
  unprepared: z.array(z.object({ requestId: id, requestVersion: version, basisFingerprint: fingerprint }).strict()),
}).strict()
export const inpatientMaterialEstimateResponseSchema = commandResponseSchema(inpatientMaterialEstimateSchema)
export const inpatientMaterialEstimateRequestInputSchema = z.object({
  admissionId: id, requestId: id, expectedRequestVersion: version,
  expectedVersion: z.number().int().nonnegative(), expectedBasisFingerprint: fingerprint,
}).strict()
export const inpatientMaterialEstimateSaveInputSchema = z.object({
  admissionId: id, requestId: id, expectedVersion: version, expectedDraftRevision: z.number().int().nonnegative(),
  expectedBasisFingerprint: fingerprint, analysisId: id.nullable(), items,
  note: z.string().trim().max(2000),
}).strict()
export const inpatientMaterialEstimateConfirmInputSchema = z.object({
  admissionId: id, requestId: id, expectedVersion: version, expectedDraftRevision: version,
  expectedBasisFingerprint: fingerprint, expectedRequestVersion: version,
  encounterVersion: z.string().regex(/^\d+$/),
  expectedReservationFingerprint: fingerprint,
  reason: text,
}).strict()
export type InpatientMaterialEstimate = z.infer<typeof inpatientMaterialEstimateSchema>
