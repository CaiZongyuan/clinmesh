import { z } from 'zod'

const boundedCode = z.string().trim().min(1).max(128)
const boundedDisplay = z.string().trim().min(1).max(500)
const boundedVersion = z.string().trim().min(1).max(64)

export const conceptLayerSchema = z.enum(['public', 'disease-pack', 'hospital'])
export type ConceptLayer = z.infer<typeof conceptLayerSchema>

export const conceptDomainSchema = z.enum([
  'laboratory',
  'diagnosis',
  'medication-class',
  'vital-sign',
  'procedure',
  'examination',
  'symptom-or-questionnaire',
  'phenotype',
])
export type ConceptDomain = z.infer<typeof conceptDomainSchema>

export const conceptNodeSchema = z.object({
  code: boundedCode,
  displayEn: boundedDisplay.optional(),
  displayZh: boundedDisplay,
  domain: conceptDomainSchema,
  hospitalId: boundedCode.optional(),
  layer: conceptLayerSchema,
  packId: z.string().trim().min(1).max(64).optional(),
  parentCode: boundedCode.nullable(),
  synonyms: z.array(z.string().trim().min(1).max(200)).max(64).default([]),
}).strict()
export type ConceptNode = z.infer<typeof conceptNodeSchema>

export const skosMappingRelationSchema = z.enum(['exact', 'close', 'broader', 'narrower'])
export type SkosMappingRelation = z.infer<typeof skosMappingRelationSchema>

export const conceptMappingReviewStatusSchema = z.enum(['proposed', 'reviewed', 'approved', 'deprecated'])
export type ConceptMappingReviewStatus = z.infer<typeof conceptMappingReviewStatusSchema>

export const conceptMappingSchema = z.object({
  effectiveDate: z.iso.date(),
  hospitalId: boundedCode.optional(),
  id: boundedCode,
  notesZh: z.string().trim().min(1).max(1000).optional(),
  relation: skosMappingRelationSchema,
  reviewStatus: conceptMappingReviewStatusSchema,
  reviewerId: boundedCode.nullable(),
  sourceCode: boundedCode,
  sourceDisplay: boundedDisplay,
  sourceSystem: boundedCode,
  targetConceptCode: boundedCode,
  version: boundedVersion,
}).strict().superRefine((mapping, ctx) => {
  if (
    (mapping.reviewStatus === 'reviewed' || mapping.reviewStatus === 'approved')
    && (mapping.reviewerId === null || mapping.reviewerId.trim().length === 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: `Concept mapping ${mapping.id} with reviewStatus '${mapping.reviewStatus}' requires a non-empty reviewerId`,
      path: ['reviewerId'],
    })
  }
})
export type ConceptMapping = z.infer<typeof conceptMappingSchema>

export const conceptVocabularySchema = z.object({
  mappings: z.array(conceptMappingSchema),
  nodes: z.array(conceptNodeSchema),
  version: boundedVersion,
}).strict()
export type ConceptVocabulary = z.infer<typeof conceptVocabularySchema>

export const conceptMappingEligibilityReasonCodeSchema = z.enum([
  'ELIGIBLE_EXACT',
  'MAPPING_CLOSE_HINT_ONLY',
  'MAPPING_BROADER_NOT_ELIGIBLE',
  'MAPPING_NARROWER_NOT_ELIGIBLE',
  'MAPPING_NOT_APPROVED',
  'MAPPING_DEPRECATED',
  'MAPPING_NOT_EFFECTIVE',
])
export type ConceptMappingEligibilityReasonCode = z.infer<typeof conceptMappingEligibilityReasonCodeSchema>

export const conceptMappingEligibilitySchema = z.object({
  effectiveDate: z.iso.date(),
  eligibleForScoreAndRedLine: z.boolean(),
  explanationZh: z.string().min(1),
  mappingId: boundedCode,
  reasonCode: conceptMappingEligibilityReasonCodeSchema,
  relation: skosMappingRelationSchema,
  reviewStatus: conceptMappingReviewStatusSchema,
  sourceCode: boundedCode,
  targetConceptCode: boundedCode,
  usableForHint: z.boolean(),
}).strict()
export type ConceptMappingEligibility = z.infer<typeof conceptMappingEligibilitySchema>

export const conceptVocabularyCatalogQuerySchema = z.object({
  asOf: z.string().trim().superRefine((value, ctx) => {
    if (!z.iso.date().safeParse(value).success && !z.iso.datetime({ offset: true }).safeParse(value).success) {
      ctx.addIssue({
        code: 'custom',
        message: 'asOf 必须为 YYYY-MM-DD 日期或带时区偏移的 ISO 8601 时间戳',
      })
    }
  }).optional(),
  hospitalId: boundedCode.optional(),
  packId: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict()
export type ConceptVocabularyCatalogQuery = z.infer<typeof conceptVocabularyCatalogQuerySchema>

export const conceptVocabularyCatalogResponseSchema = z.object({
  asOfDate: z.iso.date(),
  expandedQueryTerms: z.array(z.string().min(1)).optional(),
  hospitalId: boundedCode.optional(),
  mappingEligibility: z.array(conceptMappingEligibilitySchema),
  packIds: z.array(z.string().min(1)),
  vocabulary: conceptVocabularySchema,
}).strict()
export type ConceptVocabularyCatalogResponse = z.infer<typeof conceptVocabularyCatalogResponseSchema>
