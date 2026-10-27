import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { pciSelectionEvidenceSchema } from './inpatient-pci-selection.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().trim().min(1).max(2000)
const quantity = z.number().int().positive().max(1000)
const amount = z.number().int().nonnegative().safe()
export const inpatientDrgAgentStageSchema = z.enum(['preoperative', 'intraoperative', 'postoperative'])
export const inpatientDrgAgentSourcesSchema = z.object({
  selectionConfirmationId: id, selectionVersion: z.number().int().positive(),
  evidencePackageId: id, evidencePackageVersion: text, materialEvidence: z.array(pciSelectionEvidenceSchema),
}).strict()
export const inpatientDrgAgentMaterialSchema = z.object({
  materialId: id, catalogVersion: z.number().int().positive(), display: text, unit: text,
  quantity, unitPriceFen: amount, estimatedFen: amount,
  reason: text, quantityBasis: text, evidenceIds: z.array(id).min(1).max(20),
}).strict()
export const inpatientDrgAgentObservationSchema = z.object({ key: z.string().min(1).max(256), explanation: text,
  evidenceIds: z.array(z.string().min(1).max(512)).min(1).max(100) }).strict()
export const inpatientDrgAgentAnalysisSchema = z.object({
  id, revision: z.number().int().positive(), basisFingerprint: fingerprint,
  stage: inpatientDrgAgentStageSchema, createdAt: z.iso.datetime({ offset: true }), model: text,
  items: z.array(inpatientDrgAgentMaterialSchema).max(20),
  observations: z.array(inpatientDrgAgentObservationSchema).default([]),
  sources: inpatientDrgAgentSourcesSchema,
}).strict()
export const inpatientDrgAgentPlanSchema = z.object({
  revision: z.number().int().positive(), analysisId: id, basisFingerprint: fingerprint,
  items: z.array(inpatientDrgAgentMaterialSchema).max(20),
  confirmedBy: text, confirmedAt: z.iso.datetime({ offset: true }), note: text,
  stage: inpatientDrgAgentStageSchema, sources: inpatientDrgAgentSourcesSchema,
}).strict()
export const inpatientDrgAgentConfirmInputSchema = z.object({
  admissionId: id, analysisId: id, expectedBasisFingerprint: fingerprint,
  expectedRevision: z.number().int().nonnegative(), note: text,
  items: z.array(z.object({ materialId: id, catalogVersion: z.number().int().positive(), quantity, reason: text }).strict())
    .min(1).max(20).refine(items => new Set(items.map(item => item.materialId)).size === items.length, '计划耗材不得重复'),
}).strict()

export const inpatientDrgAgentSchema = z.object({
  admissionId: id, taskId: id.nullable(),
  status: z.enum(['inactive', 'incomplete', 'queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed']),
  basisFingerprint: fingerprint.nullable(), stage: inpatientDrgAgentStageSchema.nullable(),
  missing: z.array(text), failureCode: text.nullable(),
  lastAnalysis: inpatientDrgAgentAnalysisSchema.nullable().default(null),
  lastStatus: z.enum(['queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed']).nullable().default(null),
  analysis: inpatientDrgAgentAnalysisSchema.nullable(), confirmedPlan: inpatientDrgAgentPlanSchema.nullable(),
  planHistory: z.array(inpatientDrgAgentPlanSchema),
}).strict()
export const inpatientDrgAgentResponseSchema = commandResponseSchema(inpatientDrgAgentSchema)

export const inpatientDrgAgentGenerationSchema = z.object({ items: z.array(z.object({
  materialId: id, catalogVersion: z.number().int().positive(), quantity, reason: text,
  evidenceIds: z.array(id).min(1).max(20),
}).strict()).max(20).refine(items => new Set(items.map(item => item.materialId)).size === items.length, '耗材不得重复') }).strict()
export const inpatientDrgAgentVerificationSchema = z.object({ items: z.array(z.object({
  materialId: id, applicable: z.boolean(), compatible: z.boolean(), quantitySupported: z.boolean(), evidenceSupported: z.boolean(), reason: text,
}).strict()).max(20).refine(items => new Set(items.map(item => item.materialId)).size === items.length, '核验不得重复') }).strict()

export const inpatientDrgAgentPostGenerationSchema = inpatientDrgAgentGenerationSchema.extend({
  observations: z.array(inpatientDrgAgentObservationSchema).max(500).refine(items => new Set(items.map(item => item.key)).size === items.length, '术后核查不得重复'),
}).strict()
export const inpatientDrgAgentPostVerificationSchema = inpatientDrgAgentVerificationSchema.extend({
  observations: z.array(z.object({ key: z.string().min(1).max(256), supported: z.boolean(), reason: text }).strict()).max(500)
    .refine(items => new Set(items.map(item => item.key)).size === items.length, '核验不得重复'),
}).strict()
