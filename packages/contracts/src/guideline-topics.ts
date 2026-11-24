import { z } from 'zod'
import { guidelineEvidenceSchema } from './doctor-recommendations.ts'

/**
 * Legacy built-in cardiology/endocrinology topic ID list retained temporarily for
 * cardiology test iteration until S5 removes it; schemas accept open slugs.
 */
export const guidelineTopicIds = [
  'acute-chest-pain-acs',
  'coronary-revascularization-indication',
  'pci-stent',
  'contrast-kidney-hydration',
  'cad-dapt-and-secondary-prevention',
  't2dm-renal-medication',
] as const

export const guidelineTopicIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/)
export type GuidelineTopicId = z.infer<typeof guidelineTopicIdSchema>

export const guidelineTopicEvidenceSchema = guidelineEvidenceSchema.extend({
  text: z.string().min(1).max(12000),
})
export type GuidelineTopicEvidence = z.infer<typeof guidelineTopicEvidenceSchema>

export const guidelineTopicSummarySchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  id: guidelineTopicIdSchema,
  specialty: z.string().regex(/^[a-z0-9-]{1,64}$/),
  titleEn: z.string().trim().min(1).max(240),
  titleZh: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(64),
}).strict()
export type GuidelineTopicSummary = z.infer<typeof guidelineTopicSummarySchema>

export const guidelineTopicPatientIndicatorSchema = z.object({
  code: z.string().trim().min(1).max(64),
  labelEn: z.string().trim().min(1).max(160),
  labelZh: z.string().trim().min(1).max(160),
  sourceReference: z.string().trim().min(1).max(128).nullable(),
  status: z.enum(['present', 'missing']),
  valueText: z.string().trim().min(1).max(240).nullable(),
  versionId: z.string().trim().min(1).max(64).nullable(),
}).strict()
export type GuidelineTopicPatientIndicator = z.infer<typeof guidelineTopicPatientIndicatorSchema>

export const guidelineTopicReadSchema = z.object({
  degradedReason: z.string().trim().min(1).max(4000).nullable(),
  guidelines: z.array(guidelineTopicEvidenceSchema).max(7),
  limitations: z.array(z.string().trim().min(1).max(4000)).min(1).max(12),
  missingPatientInputs: z.array(z.string().trim().min(1).max(4000)).max(24),
  missingSources: z.array(z.string().trim().min(1).max(4000)).max(24),
  navigation: z.string().trim().min(1).max(4000),
  patientIndicators: z.array(guidelineTopicPatientIndicatorSchema).max(24),
  population: z.enum(['adult', 'pediatric', 'all-only']),
  status: z.enum(['available', 'unavailable']),
  topic: guidelineTopicSummarySchema,
}).strict()
export type GuidelineTopicRead = z.infer<typeof guidelineTopicReadSchema>

export const guidelineTopicBundleSchema = z.object({
  encounterId: z.string().min(1).max(64),
  evaluatedAt: z.iso.datetime({ offset: true }),
  items: z.array(guidelineTopicReadSchema).min(1).max(64),
}).strict()
export type GuidelineTopicBundle = z.infer<typeof guidelineTopicBundleSchema>

export const guidelineTopicQuerySchema = z.object({
  topicId: guidelineTopicIdSchema.optional(),
}).strict()

export const outpatientGuidelineTopicsInputSchema = z.object({
  caseId: z.string().min(1).max(64),
  topicId: guidelineTopicIdSchema.optional(),
}).strict()

export const inpatientGuidelineTopicsInputSchema = z.object({
  admissionId: z.string().min(1).max(64),
  topicId: guidelineTopicIdSchema.optional(),
}).strict()
