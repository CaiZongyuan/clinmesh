import { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientMedicationSchema, inpatientOrderIssueInputSchema, inpatientServiceSchema } from '@clinmesh/contracts/inpatient-clinical'
import { resolveInpatientDose } from '@clinmesh/core/inpatient-dose'

export const orderDraftPrefix = 'clinmesh.inpatient-order-drafts:v1:'
export const orderBatchLimit = 20
export const orderPickSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('medication'), item: inpatientMedicationSchema }).strict(),
  z.object({ kind: z.literal('service'), item: inpatientServiceSchema }).strict(),
])
export const orderAttemptSchema = z.object({ idempotencyKey: z.uuid(), input: inpatientOrderIssueInputSchema }).strict()
export const orderDraftRowSchema = z.object({
  id: z.uuid(), pick: orderPickSchema, selected: z.boolean(), duration: z.enum(['long', 'temporary']),
  doseText: z.string().max(120), frequencyCode: z.enum(['QD', 'BID', 'PRN']).optional(), surgeryExecutionId: z.string().optional(),
  estimate: z.object({ generation: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), stale: z.boolean() }).strict().optional(),
  attempt: orderAttemptSchema.optional(), error: z.string().optional(),
}).strict().refine(row => row.attempt === undefined || (
  JSON.stringify(row.attempt.input.selection) === JSON.stringify(inpatientOrderIssueInputSchema.shape.selection.parse(orderSelection(row)))
  && row.attempt.input.duration === row.duration && row.attempt.input.surgeryExecutionId === row.surgeryExecutionId
  && row.attempt.input.expectedDrgFingerprint === row.estimate?.fingerprint))
export const orderDraftSchema = z.object({ rows: z.array(orderDraftRowSchema).max(orderBatchLimit),
  successes: z.array(z.object({ id: z.uuid(), display: z.string() }).strict()).max(orderBatchLimit),
}).strict()
export type OrderDraftRow = z.infer<typeof orderDraftRowSchema>
export type OrderDraft = z.infer<typeof orderDraftSchema>
export type OrderAttempt = z.infer<typeof orderAttemptSchema>

export function orderDose(row: { pick: z.infer<typeof orderPickSchema>; doseText: string }) {
  if (row.pick.kind !== 'medication') return undefined
  const item = row.pick.item
  return resolveInpatientDose({ unit: item.unit, doses: item.doses,
    ...(item.doseBasis ? { doseBasis: item.doseBasis } : {}),
    ...(item.maxDoseQuantity === undefined ? {} : { maxDoseQuantity: item.maxDoseQuantity }) }, row.doseText)
}

export function orderSelection(row: { pick: z.infer<typeof orderPickSchema>; doseText: string; frequencyCode?: 'QD' | 'BID' | 'PRN' | undefined }): z.infer<typeof inpatientOrderIssueInputSchema>['selection'] | undefined {
  if (row.pick.kind === 'service') return { kind: 'service', serviceId: row.pick.item.id, serviceVersion: row.pick.item.version, quantity: 1 }
  const item = row.pick.item, dose = orderDose(row)
  return dose && 'quantity' in dose && row.frequencyCode && item.frequencyCodes.includes(row.frequencyCode)
    ? { kind: 'medication', catalogItemId: item.id, catalogVersion: item.version, doseText: row.doseText, doseQuantity: dose.quantity, frequencyCode: row.frequencyCode } : undefined
}

export function orderDraftKey(session: SessionContext, admission: InpatientAdmission) {
  return orderDraftPrefix + encodeURIComponent(JSON.stringify([session.user.id, session.actor, admission.patientId, admission.id]))
}

export function clearOrderDrafts() {
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index)
    if (key?.startsWith(orderDraftPrefix)) sessionStorage.removeItem(key)
  }
}
