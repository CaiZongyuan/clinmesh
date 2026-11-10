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
export function usePrescriptionComposerDraft(scope: string) {
  return useStoredInvestigationValue(`${investigationDraftPrefix}prescription-composer:v1:${scope}`, composerSchema.nullable(), null)
}

export function clearPrescriptionPrivateDraftForHydration(scope: string) {
  ensureInvestigationDraftsCleared()
  sessionStorage.removeItem(`${investigationDraftPrefix}prescription:v1:${scope}`)
  sessionStorage.removeItem(`${investigationDraftPrefix}prescription-composer:v1:${scope}`)
}
