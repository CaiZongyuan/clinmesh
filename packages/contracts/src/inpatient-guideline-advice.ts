import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { guidelineEvidenceSchema } from './doctor-recommendations.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().trim().min(1).max(4000)
export const inpatientGuidelineAdviceKindSchema = z.enum(['stent-category', 'imaging-guidance', 'measurement-requirements'])
export const inpatientGuidelineAdviceConclusionSchema = z.object({
  kind: inpatientGuidelineAdviceKindSchema, applicability: z.enum(['conditional', 'patient-specific']), text,
  citations: z.array(z.object({ evidenceId: z.string().min(1).max(256), quote: text }).strict()).min(1).max(7),
}).strict()
export const inpatientGuidelineAdviceGenerationSchema = z.object({
  conclusions: z.array(inpatientGuidelineAdviceConclusionSchema).length(3)
    .refine(items => new Set(items.map(item => item.kind)).size === items.length, '指南类别结论不得重复'),
}).strict()
export const inpatientGuidelineAdviceVerificationSchema = z.object({
  conclusions: z.array(z.object({ kind: inpatientGuidelineAdviceKindSchema, supported: z.boolean(),
    populationPreserved: z.boolean(), conditionsPreserved: z.boolean(), strengthPreserved: z.boolean(),
    noInventedMeasurements: z.boolean(), noProductOrQuantity: z.boolean(), reason: text }).strict()).length(3)
    .refine(items => new Set(items.map(item => item.kind)).size === items.length, '指南核验类别不得重复'),
}).strict()
export const inpatientGuidelineAdviceEvidenceSchema = guidelineEvidenceSchema.extend({ text: z.string().min(1).max(12000) })
export const inpatientGuidelineAdviceResultSchema = z.object({
  id, fingerprint, model: z.string().min(1).max(1024), createdAt: z.iso.datetime({ offset: true }),
  topic: z.object({ id: z.literal('pci-stent'), version: text, fingerprint }).strict(),
  guidelines: z.array(inpatientGuidelineAdviceEvidenceSchema).min(1).max(7),
  conclusions: z.array(inpatientGuidelineAdviceConclusionSchema).length(3), limitations: z.array(text).max(12),
}).strict()
export const inpatientGuidelineAdviceSchema = z.object({
  admissionId: id, requestId: id, taskId: id.nullable(), version: z.number().int().nonnegative(), fingerprint,
  status: z.enum(['idle', 'queued', 'running', 'succeeded', 'incomplete', 'no-evidence', 'blocked', 'unknown', 'rejected',
    'failed', 'cancelled', 'stale', 'frozen']),
  message: text, missing: z.array(text).max(24), failureCode: z.string().nullable(), result: inpatientGuidelineAdviceResultSchema.nullable(),
}).strict()
export const inpatientGuidelineAdviceListSchema = z.object({ admissionId: id, advice: z.array(inpatientGuidelineAdviceSchema) }).strict()
export const inpatientGuidelineAdviceRequestInputSchema = z.object({
  admissionId: id, requestId: id, expectedVersion: z.number().int().nonnegative(), expectedFingerprint: fingerprint,
}).strict()
export const inpatientGuidelineAdviceResponseSchema = commandResponseSchema(inpatientGuidelineAdviceSchema)
export type InpatientGuidelineAdvice = z.infer<typeof inpatientGuidelineAdviceSchema>
