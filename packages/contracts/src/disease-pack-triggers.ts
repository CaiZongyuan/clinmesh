import { z } from 'zod'
import {
  clinicalFactCategorySchema,
  clinicalFactVerificationStatusSchema,
} from './clinical-fact-ledger.ts'
import {
  diseasePackSlugSchema,
  packSourceSummarySchema,
  type DiseasePackSlug,
  type PackSourceSummary,
} from './pack-source.ts'

export {
  diseasePackSlugSchema,
  packSourceSummarySchema,
  type DiseasePackSlug,
  type PackSourceSummary,
}

export const diseasePackSha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const diseasePackTimestampFieldSchema = z.enum(['effectiveAt', 'reportedAt', 'ingestedAt'])
export type DiseasePackTimestampField = z.infer<typeof diseasePackTimestampFieldSchema>

const boundedCode = z.string().trim().min(1).max(128)

export const diseasePackRegexPatternSchema = z.string().trim().min(1).max(200).superRefine((pattern, ctx) => {
  try {
    new RegExp(pattern)
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'Must be a valid regular expression',
    })
  }
})

export interface DiseasePackFactTriggerNode {
  kind: 'fact'
  category?: z.infer<typeof clinicalFactCategorySchema> | undefined
  itemCodes?: string[] | undefined
  itemCodePattern?: string | undefined
  presence: 'present' | 'absent'
  requireEligible: boolean
  verificationStatus?: z.infer<typeof clinicalFactVerificationStatusSchema> | undefined
  minValue?: number | undefined
  maxValue?: number | undefined
  unit?: string | undefined
  textPattern?: string | undefined
  withinDays?: number | undefined
  timestampField?: DiseasePackTimestampField | undefined
}

export interface DiseasePackSequenceTriggerNode {
  kind: 'sequence'
  first: DiseasePackTriggerNode
  then: DiseasePackTriggerNode
  maxGapDays?: number | undefined
  requireDistinctEncounters?: boolean | undefined
  timestampField: DiseasePackTimestampField
}

export interface DiseasePackAllOfTriggerNode {
  kind: 'allOf'
  nodes: DiseasePackTriggerNode[]
}

export interface DiseasePackAnyOfTriggerNode {
  kind: 'anyOf'
  nodes: DiseasePackTriggerNode[]
}

export interface DiseasePackNotTriggerNode {
  kind: 'not'
  node: DiseasePackTriggerNode
}

export type DiseasePackTriggerNode =
  | DiseasePackFactTriggerNode
  | DiseasePackSequenceTriggerNode
  | DiseasePackAllOfTriggerNode
  | DiseasePackAnyOfTriggerNode
  | DiseasePackNotTriggerNode

export const diseasePackTriggerNodeSchema: z.ZodType<DiseasePackTriggerNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('fact'),
      category: clinicalFactCategorySchema.optional(),
      itemCodes: z.array(boundedCode).min(1).max(64).optional(),
      itemCodePattern: diseasePackRegexPatternSchema.optional(),
      presence: z.enum(['present', 'absent']).default('present'),
      requireEligible: z.boolean().default(true),
      verificationStatus: clinicalFactVerificationStatusSchema.optional(),
      minValue: z.number().finite().optional(),
      maxValue: z.number().finite().optional(),
      unit: z.string().trim().min(1).max(64).optional(),
      textPattern: diseasePackRegexPatternSchema.optional(),
      withinDays: z.number().positive().max(36500).optional(),
      timestampField: diseasePackTimestampFieldSchema.optional(),
    }).strict().superRefine((node, ctx) => {
      if (node.category === undefined && node.itemCodes === undefined && node.itemCodePattern === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Fact trigger must declare category, itemCodes, or itemCodePattern',
        })
      }
      if (node.withinDays !== undefined && node.timestampField === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Fact trigger with withinDays must explicitly specify timestampField',
          path: ['timestampField'],
        })
      }
    }),
    z.object({
      kind: z.literal('sequence'),
      first: diseasePackTriggerNodeSchema,
      // oxlint-disable-next-line unicorn/no-thenable -- Schema preserves DSAP TriggerNode AST contract ('first' -> 'then').
      then: diseasePackTriggerNodeSchema,
      maxGapDays: z.number().positive().max(36500).optional(),
      requireDistinctEncounters: z.boolean().optional(),
      timestampField: diseasePackTimestampFieldSchema,
    }).strict(),
    z.object({
      kind: z.literal('allOf'),
      nodes: z.array(diseasePackTriggerNodeSchema).min(1).max(32),
    }).strict(),
    z.object({
      kind: z.literal('anyOf'),
      nodes: z.array(diseasePackTriggerNodeSchema).min(1).max(32),
    }).strict(),
    z.object({
      kind: z.literal('not'),
      node: diseasePackTriggerNodeSchema,
    }).strict(),
  ]),
)
