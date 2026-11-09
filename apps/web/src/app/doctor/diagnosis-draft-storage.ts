import { diagnosisDraftEntrySchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { investigationDraftPrefix, useStoredInvestigationValue } from './investigation-draft-storage.ts'

const lineSchema = diagnosisDraftEntrySchema.extend({
  key: z.string().min(1), note: z.string().max(500),
  snapshotCode: z.string().optional(), snapshotDisplay: z.string().optional(),
})
const draftSchema = z.object({ version: z.literal(1), entries: z.array(lineSchema).max(8), dirty: z.boolean() }).strict()
  .refine(value => new Set(value.entries.map(entry => entry.catalogItemId)).size === value.entries.length)
export type DiagnosisDraftLine = z.infer<typeof lineSchema>

export function useDiagnosisDraft(scope: string, entries: DiagnosisDraftLine[]) {
  return useStoredInvestigationValue(`${investigationDraftPrefix}diagnosis:v1:${scope}`, draftSchema,
    { version: 1, entries, dirty: false })
}

const composerSchema = diagnosisDraftEntrySchema.extend({
  code: z.string().min(1), display: z.string().min(1), note: z.string().max(500), editingId: z.string().optional(),
}).strict()
export function useDiagnosisComposerDraft(scope: string) {
  return useStoredInvestigationValue(`${investigationDraftPrefix}diagnosis-composer:v1:${scope}`, composerSchema.nullable(), null)
}

export function clearDiagnosisPrivateDraftForHydration(scope: string) {
  sessionStorage.removeItem(`${investigationDraftPrefix}diagnosis:v1:${scope}`)
  sessionStorage.removeItem(`${investigationDraftPrefix}diagnosis-composer:v1:${scope}`)
}
