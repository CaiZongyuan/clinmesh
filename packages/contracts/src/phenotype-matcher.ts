import { z } from 'zod'
import {
  clinicalFactCategorySchema,
  clinicalFactInstitutionScopeSchema,
  clinicalFactLedgerSchema,
  clinicalFactPresenceSchema,
} from './clinical-fact-ledger.ts'
import { clinicalPromptCardSchema, clinicalPromptTimingSchema } from './clinical-prompt-cards.ts'
import { conceptVocabularySchema } from './concept-vocabulary.ts'
import { diseasePackRegexPatternSchema, diseasePackSlugSchema } from './disease-pack-triggers.ts'

const boundedCode = z.string().trim().min(1).max(256)
const boundedId = z.string().trim().min(1).max(512)
const nonEmptyText = z.string().trim().min(1).max(1000)
const dt = z.iso.datetime({ offset: true })

export const phenotypeDomainSchema = z.enum([
  'lipid',
  'cardiovascular',
  'renal',
  'pancreatic',
  'genetic-family',
  'physical-sign',
  'neurologic-sensory',
  'other',
])
export type PhenotypeDomain = z.infer<typeof phenotypeDomainSchema>

export const phenotypeAgeThresholdBySexSchema = z.object({
  defaultYears: z.number().positive().max(130),
  femaleYears: z.number().positive().max(130).optional(),
  maleYears: z.number().positive().max(130).optional(),
}).strict()
export type PhenotypeAgeThresholdBySex = z.infer<typeof phenotypeAgeThresholdBySexSchema>

export const phenotypeFactMatcherSchema = z.object({
  categories: z.array(clinicalFactCategorySchema).min(1).max(8).optional(),
  codePatterns: z.array(diseasePackRegexPatternSchema).min(1).max(16).optional(),
  conceptCodes: z.array(boundedCode).min(1).max(32).optional(),
  maxAgeAtFactYears: phenotypeAgeThresholdBySexSchema.optional(),
  maxAgeFallbackTextPattern: diseasePackRegexPatternSchema.optional(),
  maxValue: z.number().finite().optional(),
  minValue: z.number().finite().optional(),
  presence: clinicalFactPresenceSchema.default('present'),
  textPattern: diseasePackRegexPatternSchema.optional(),
  unit: z.string().trim().min(1).max(64).optional(),
  unitMultipliers: z.record(z.string().trim().min(1).max(64), z.number().positive().finite()).optional(),
}).strict().superRefine((matcher, ctx) => {
  if (
    matcher.conceptCodes === undefined
    && matcher.codePatterns === undefined
    && matcher.textPattern === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Phenotype fact matcher must declare conceptCodes, codePatterns, or textPattern',
    })
  }
  if (matcher.minValue !== undefined && matcher.maxValue !== undefined && matcher.minValue > matcher.maxValue) {
    ctx.addIssue({
      code: 'custom',
      message: 'Phenotype fact matcher minValue cannot exceed maxValue',
      path: ['minValue'],
    })
  }
})
export type PhenotypeFactMatcher = z.infer<typeof phenotypeFactMatcherSchema>

export const phenotypeObservationRuleSchema = z.object({
  alternativeMatchers: z.array(phenotypeFactMatcherSchema).min(1).max(8).optional(),
  domain: phenotypeDomainSchema,
  evaluationKind: z.enum(['single-fact', 'cross-time-persistence']).default('single-fact'),
  labelEn: z.string().trim().min(1).max(200),
  labelZh: z.string().trim().min(1).max(200),
  matcher: phenotypeFactMatcherSchema,
  minDistinctEncounters: z.number().int().min(2).max(32).optional(),
  minSpanDays: z.number().nonnegative().max(36500).optional(),
  phenotypeCode: boundedCode,
}).strict().superRefine((rule, ctx) => {
  if (rule.evaluationKind !== 'cross-time-persistence' && (rule.minDistinctEncounters !== undefined || rule.minSpanDays !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'minDistinctEncounters and minSpanDays are only valid for cross-time-persistence rules',
      path: ['evaluationKind'],
    })
  }
})
export type PhenotypeObservationRule = z.infer<typeof phenotypeObservationRuleSchema>

export const phenotypeWeightedTermSchema = z.object({
  phenotypeCode: boundedCode,
  rationaleZh: z.string().trim().min(1).max(500),
  weight: z.number().positive().max(1),
}).strict()
export type PhenotypeWeightedTerm = z.infer<typeof phenotypeWeightedTermSchema>

export const phenotypeDiseaseCandidateSpecSchema = z.object({
  diseaseId: diseasePackSlugSchema,
  exclusionDiagnosisPatterns: z.array(diseasePackRegexPatternSchema).max(16).default([]),
  minMatchedTerms: z.number().int().positive().max(32),
  minScoreThreshold: z.number().positive().max(1),
  packId: diseasePackSlugSchema.nullable().default(null),
  packVersion: z.string().trim().min(1).max(64).nullable().default(null),
  recommendedWorkupZh: z.array(nonEmptyText).min(1).max(16),
  referralSuggestionZh: nonEmptyText,
  requiredAnyPhenotypeCodes: z.array(boundedCode).max(16).default([]),
  scoreNormalizationBase: z.number().positive().max(10).default(1),
  specialty: diseasePackSlugSchema,
  suggestedWorkupItemCodes: z.array(boundedCode).max(16).default([]),
  titleEn: z.string().trim().min(1).max(240),
  titleZh: z.string().trim().min(1).max(240),
  weightedTerms: z.array(phenotypeWeightedTermSchema).min(1).max(32),
}).strict()
export type PhenotypeDiseaseCandidateSpec = z.infer<typeof phenotypeDiseaseCandidateSpecSchema>

export const phenotypeKnowledgeBaseSchema = z.object({
  candidates: z.array(phenotypeDiseaseCandidateSpecSchema).min(1).max(128),
  phenotypeRules: z.array(phenotypeObservationRuleSchema).min(1).max(256),
  version: z.string().trim().min(1).max(64),
}).strict().superRefine((kb, ctx) => {
  const ruleCodes = new Set<string>()
  for (const rule of kb.phenotypeRules) {
    if (ruleCodes.has(rule.phenotypeCode)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate phenotypeCode in phenotypeRules: ${rule.phenotypeCode}`,
        path: ['phenotypeRules'],
      })
    }
    ruleCodes.add(rule.phenotypeCode)
  }
  for (const candidate of kb.candidates) {
    for (const term of candidate.weightedTerms) {
      if (!ruleCodes.has(term.phenotypeCode)) {
        ctx.addIssue({
          code: 'custom',
          message: `Candidate ${candidate.diseaseId} references unknown phenotypeCode ${term.phenotypeCode}`,
          path: ['candidates'],
        })
      }
    }
    for (const req of candidate.requiredAnyPhenotypeCodes) {
      if (!ruleCodes.has(req)) {
        ctx.addIssue({
          code: 'custom',
          message: `Candidate ${candidate.diseaseId} requiredAnyPhenotypeCodes references unknown phenotypeCode ${req}`,
          path: ['candidates'],
        })
      }
    }
  }
})
export type PhenotypeKnowledgeBase = z.infer<typeof phenotypeKnowledgeBaseSchema>

export const phenotypeFactEvidenceSchema = z.object({
  category: clinicalFactCategorySchema,
  encounterKey: boundedId,
  encounterLabel: nonEmptyText,
  factId: boundedId,
  institutionScope: clinicalFactInstitutionScopeSchema,
  itemCode: boundedCode,
  itemDisplay: nonEmptyText,
  normalizedNumericValue: z.number().finite().nullable(),
  observedAt: dt,
  recordId: boundedId,
  recordType: boundedId,
  recordVersion: z.string().trim().min(1).max(64),
  unit: z.string().trim().min(1).max(64).nullable(),
  valueText: z.string().max(1000),
  verified: z.boolean(),
}).strict()
export type PhenotypeFactEvidence = z.infer<typeof phenotypeFactEvidenceSchema>

export const phenotypeTermMatchSchema = z.object({
  distinctEncounterCount: z.number().int().nonnegative(),
  domain: phenotypeDomainSchema,
  earliestAt: dt,
  evidences: z.array(phenotypeFactEvidenceSchema).min(1),
  labelEn: z.string().trim().min(1).max(200),
  labelZh: z.string().trim().min(1).max(200),
  latestAt: dt,
  matchCount: z.number().int().positive(),
  phenotypeCode: boundedCode,
  spanDays: z.number().nonnegative(),
}).strict()
export type PhenotypeTermMatch = z.infer<typeof phenotypeTermMatchSchema>

export const phenotypeCandidateTermMatchSchema = phenotypeTermMatchSchema.extend({
  rationaleZh: z.string().trim().min(1).max(500),
  weight: z.number().positive().max(1),
}).strict()
export type PhenotypeCandidateTermMatch = z.infer<typeof phenotypeCandidateTermMatchSchema>

export const phenotypeTimelineEntrySchema = z.object({
  encounterLabel: nonEmptyText,
  factId: boundedId,
  institutionScope: clinicalFactInstitutionScopeSchema,
  itemCode: boundedCode,
  itemDisplay: nonEmptyText,
  observedAt: dt,
  phenotypeCode: boundedCode,
  phenotypeLabelZh: z.string().trim().min(1).max(200),
  valueText: z.string().max(1000),
  verified: z.boolean(),
}).strict()
export type PhenotypeTimelineEntry = z.infer<typeof phenotypeTimelineEntrySchema>

export const phenotypeCandidateMatchSchema = z.object({
  confidenceScore: z.number().min(0).max(1),
  crossTimeTimeline: z.array(phenotypeTimelineEntrySchema).min(1),
  diseaseId: diseasePackSlugSchema,
  matchedPhenotypeCount: z.number().int().positive(),
  matchedPhenotypes: z.array(phenotypeCandidateTermMatchSchema).min(1),
  packId: diseasePackSlugSchema.nullable(),
  packVersion: z.string().trim().min(1).max(64).nullable(),
  rawWeightedScore: z.number().nonnegative(),
  recommendedWorkupZh: z.array(nonEmptyText).min(1),
  referralSuggestionZh: nonEmptyText,
  specialty: diseasePackSlugSchema,
  titleEn: z.string().trim().min(1).max(240),
  titleZh: z.string().trim().min(1).max(240),
}).strict()
export type PhenotypeCandidateMatch = z.infer<typeof phenotypeCandidateMatchSchema>

export const phenotypeExcludedFactSummarySchema = z.object({
  conflictCount: z.number().int().nonnegative(),
  externalUnverifiedCount: z.number().int().nonnegative(),
  notAskedOrErrorCount: z.number().int().nonnegative(),
  supersededCount: z.number().int().nonnegative(),
  suspiciousCount: z.number().int().nonnegative(),
}).strict()
export type PhenotypeExcludedFactSummary = z.infer<typeof phenotypeExcludedFactSummarySchema>

export const phenotypeMatchResultSchema = z.object({
  candidates: z.array(phenotypeCandidateMatchSchema),
  eligibleFactCount: z.number().int().nonnegative(),
  evaluatedAsOf: dt,
  excludedFactSummary: phenotypeExcludedFactSummarySchema,
  knowledgeBaseVersion: z.string().trim().min(1).max(64),
  llmInvocationCount: z.literal(0),
  matchedPhenotypeTerms: z.array(phenotypeTermMatchSchema),
  promptCards: z.array(clinicalPromptCardSchema),
}).strict()
export type PhenotypeMatchResult = z.infer<typeof phenotypeMatchResultSchema>

export const phenotypeMatcherInputSchema = z.object({
  asOf: dt.optional(),
  encounterIdByFactId: z.record(z.string(), z.string()).optional(),
  encounterIdByRecordId: z.record(z.string(), z.string()).optional(),
  encounterLabelByFactId: z.record(z.string(), z.string()).optional(),
  encounterLabelByRecordId: z.record(z.string(), z.string()).optional(),
  knowledgeBase: phenotypeKnowledgeBaseSchema.optional(),
  ledger: clinicalFactLedgerSchema,
  patientBirthDate: z.iso.date().optional(),
  patientSex: z.enum(['male', 'female', 'other', 'unknown']).optional(),
  timing: clinicalPromptTimingSchema.optional(),
  vocabulary: conceptVocabularySchema.optional(),
}).strict()
export type PhenotypeMatcherInput = z.infer<typeof phenotypeMatcherInputSchema>
