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
const composerStateSchema = z.object({ adding: composerSchema.nullable(), editors: z.record(z.string(), composerSchema) }).strict()
  .refine(value => Object.keys(value.editors).length <= 8)
type ComposerDraft = z.infer<typeof composerSchema>
export function diagnosisEditorsChanged(entries: DiagnosisDraftLine[], editors: Record<string, ComposerDraft>) {
  const clinicalValue = (entry: Pick<DiagnosisDraftLine, 'catalogItemId' | 'note' | 'referenceConcept' | 'role'>) =>
    JSON.stringify([entry.catalogItemId, entry.role, entry.note.trim(), entry.referenceConcept ?? null])
  return Object.entries(editors).some(([key, editor]) => {
    const entry = entries.find(entry => entry.key === key)
    return entry !== undefined && clinicalValue(entry) !== clinicalValue(editor)
  })
}

export function hasPendingDiagnosisEdits(scope: string, fallbackEntries: DiagnosisDraftLine[]) {
  try {
    const rawDraft = sessionStorage.getItem(`${investigationDraftPrefix}diagnosis:v1:${scope}`)
    const rawComposer = sessionStorage.getItem(`${investigationDraftPrefix}diagnosis-composer:v2:${scope}`)
    const entries = rawDraft === null ? fallbackEntries : draftSchema.parse(JSON.parse(rawDraft)).entries
    return rawComposer !== null && diagnosisEditorsChanged(entries, composerStateSchema.parse(JSON.parse(rawComposer)).editors)
  } catch { return true }
}

export function useDiagnosisComposerDraft(scope: string, editingId?: string) {
  const stored = useStoredInvestigationValue(`${investigationDraftPrefix}diagnosis-composer:v2:${scope}`, composerStateSchema, { adding: null, editors: {} })
  return { failed: stored.failed, editors: stored.value.editors, value: editingId === undefined ? stored.value.adding : stored.value.editors[editingId] ?? null,
    save: (update: (previous: ComposerDraft | null) => ComposerDraft | null) => stored.save(previous => {
      if (editingId === undefined) return { ...previous, adding: update(previous.adding) }
      const next = update(previous.editors[editingId] ?? null), editors = { ...previous.editors }
      if (next === null) delete editors[editingId]
      else editors[editingId] = next
      return { ...previous, editors }
    }),
    removeEditor: (id: string) => stored.save(previous => {
      const { [id]: _removed, ...editors } = previous.editors
      return { ...previous, editors }
    }),
    retainEditors: (ids: string[]) => stored.save(previous => ({ ...previous,
      editors: Object.fromEntries(Object.entries(previous.editors).filter(([id]) => ids.includes(id))),
    })),
    clear: () => stored.save(() => ({ adding: null, editors: {} })),
  }
}

export function clearDiagnosisPrivateDraftForHydration(scope: string) {
  sessionStorage.removeItem(`${investigationDraftPrefix}diagnosis:v1:${scope}`)
  sessionStorage.removeItem(`${investigationDraftPrefix}diagnosis-composer:v2:${scope}`)
}
