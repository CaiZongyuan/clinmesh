import { z } from 'zod'

export const diseasePackSlugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/)
export type DiseasePackSlug = z.infer<typeof diseasePackSlugSchema>

export const packSourceSummarySchema = z.object({
  packId: diseasePackSlugSchema,
  packVersion: z.string().trim().min(1).max(64),
  titleZh: z.string().trim().min(1).max(240),
}).strict()
export type PackSourceSummary = z.infer<typeof packSourceSummarySchema>
