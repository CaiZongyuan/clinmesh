import { prescriptionDraftItemSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { ensureInvestigationDraftsCleared, investigationDraftPrefix, useStoredInvestigationValue } from './investigation-draft-storage.ts'

const fieldsSchema = prescriptionDraftItemSchema.pick({ courseDays: true, doseText: true, frequencyCode: true, quantity: true }).extend({
  courseDays: z.number().finite().nullable(), doseText: z.string().max(120), frequencyCode: z.string().max(32), quantity: z.number().finite().nullable(),
})
const lineSchema = prescriptionDraftItemSchema.extend({ ...fieldsSchema.shape, key: z.string().min(1) })
const draftSchema = z.object({ version: z.literal(1), items: z.array(lineSchema).max(8), dirty: z.boolean(),
  mode: z.enum(['prescription', 'no-medication']),
}).strict().refine(value => new Set(value.items.map(item => item.catalogItemId)).size === value.items.length)
export type PrescriptionDraftLine = z.infer<typeof lineSchema>

export function usePrescriptionDraft(scope: string, initialItems: PrescriptionDraftLine[], initialMode: 'prescription' | 'no-medication') {
  return useStoredInvestigationValue(`${investigationDraftPrefix}prescription:v1:${scope}`, draftSchema,
    { version: 1, items: initialItems, dirty: false, mode: initialMode })
}

const composerSchema = z.object({
  catalogItemId: z.string().min(1), referenceProduct: prescriptionDraftItemSchema.shape.referenceProduct,
  fields: fieldsSchema, editingId: z.string().min(1).optional(),
}).strict()
export type MedicationComposerDraft = z.infer<typeof composerSchema>
const composerStateSchema = z.object({ version: z.literal(2), adding: composerSchema.nullable(), editors: z.record(z.string(), composerSchema) }).strict()
  .refine(value => Object.keys(value.editors).length <= 8)
const emptyComposer = (): z.infer<typeof composerStateSchema> => ({ version: 2, adding: null, editors: {} })
function composerStorageSchema(items: PrescriptionDraftLine[]) {
  // Keep the existing key readable: older records contain one add/edit draft keyed by catalog identity.
  return z.union([composerStateSchema, composerSchema.nullable()]).transform(value => {
    if (value === null) return emptyComposer()
    if ('version' in value) return value
    if (value.editingId === undefined) return { ...emptyComposer(), adding: value }
    const item = items.find(item => item.catalogItemId === value.editingId)
    if (item === undefined) throw new Error('The original medicine editor has no matching draft row')
    return { ...emptyComposer(), editors: { [item.key]: value } }
  })
}
export function prescriptionEditorsChanged(items: PrescriptionDraftLine[], editors: Record<string, MedicationComposerDraft>) {
  return Object.entries(editors).some(([key, editor]) => {
    const item = items.find(item => item.key === key)
    return item !== undefined && JSON.stringify([item.catalogItemId, item.doseText.trim(), item.frequencyCode.trim(), item.courseDays, item.quantity, item.referenceProduct ?? null])
      !== JSON.stringify([editor.catalogItemId, editor.fields.doseText.trim(), editor.fields.frequencyCode.trim(), editor.fields.courseDays, editor.fields.quantity, editor.referenceProduct ?? null])
  })
}
export function hasPendingPrescriptionEdits(scope: string, fallbackItems: PrescriptionDraftLine[]) {
  try {
    ensureInvestigationDraftsCleared()
    const rawDraft = sessionStorage.getItem(`${investigationDraftPrefix}prescription:v1:${scope}`)
    const rawComposer = sessionStorage.getItem(`${investigationDraftPrefix}prescription-composer:v1:${scope}`)
    const items = rawDraft === null ? fallbackItems : draftSchema.parse(JSON.parse(rawDraft)).items
    return rawComposer !== null && prescriptionEditorsChanged(items, composerStorageSchema(items).parse(JSON.parse(rawComposer)).editors)
  } catch { return true }
}
export function usePrescriptionComposerDraft(scope: string, items: PrescriptionDraftLine[], editingId?: string) {
  const stored = useStoredInvestigationValue(`${investigationDraftPrefix}prescription-composer:v1:${scope}`, composerStorageSchema(items), emptyComposer())
  return { failed: stored.failed, editors: stored.value.editors, value: editingId === undefined ? stored.value.adding : stored.value.editors[editingId] ?? null,
    save: (update: (previous: MedicationComposerDraft | null) => MedicationComposerDraft | null) => stored.save(previous => {
      if (editingId === undefined) return { ...previous, adding: update(previous.adding) }
      const next = update(previous.editors[editingId] ?? null), editors = { ...previous.editors }
      if (next === null) delete editors[editingId]
      else editors[editingId] = next
      return { ...previous, editors }
    }),
    rebaseEditors: (after: PrescriptionDraftLine[]) => stored.save(previous => ({ ...previous,
      editors: Object.fromEntries(Object.entries(previous.editors).filter(([key, editor]) =>
        after.some(item => item.key === key) && prescriptionEditorsChanged(after, { [key]: editor }))),
    })),
    clear: () => stored.save(emptyComposer),
  }
}

export function clearPrescriptionPrivateDraftForHydration(scope: string) {
  ensureInvestigationDraftsCleared()
  sessionStorage.removeItem(`${investigationDraftPrefix}prescription:v1:${scope}`)
  sessionStorage.removeItem(`${investigationDraftPrefix}prescription-composer:v1:${scope}`)
}
