import { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientMedicationSchema, inpatientOrderIssueInputSchema, inpatientServiceSchema } from '@clinmesh/contracts/inpatient-clinical'
import { resolveInpatientDose } from '@clinmesh/core/inpatient-dose'
import { createDraftDiscard } from './draft-discard.ts'
import { issueDraftFailureSchema, issueDraftKeys, notifyIssueDraftSettled, readIssueDraftForSettlement, type IssueDraftOutcome } from './inpatient-issue-draft-settlement.ts'

export const orderDraftPrefix = 'clinmesh.inpatient-order-drafts:v1:'
const discard = createDraftDiscard(orderDraftPrefix)
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
  attempt: orderAttemptSchema.optional(),
  error: z.union([z.string(), issueDraftFailureSchema]).optional(),
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

export function readOrderDraft(session: SessionContext, admission: InpatientAdmission): OrderDraft {
  const raw = discard.read(orderDraftKey(session, admission))
  const draft = raw === null ? { rows: [], successes: [] } : orderDraftSchema.parse(JSON.parse(raw))
  if (draft.rows.some(row => row.attempt && row.attempt.input.admissionId !== admission.id)) throw new Error('Draft admission mismatch')
  return draft
}

export function clearOrderDrafts() {
  discard.clear()
}

export function saveOrderDraft(session: SessionContext, admission: InpatientAdmission, draft: OrderDraft): void {
  discard.ensureCleared()
  sessionStorage.setItem(orderDraftKey(session, admission), JSON.stringify(draft))
}

/** 先持久消费原行，再由共享 writer 解除原意图；同键重读可安全重复。 */
export function settleIssuedOrder(input: unknown, idempotencyKey: string, session: SessionContext, outcome: IssueDraftOutcome): void {
  const attempt = orderAttemptSchema.parse({ input, idempotencyKey })
  const admissionId = attempt.input.admissionId
  if ('response' in outcome && inpatientFullClinicalResponseSchema.parse(outcome.response).data.admissionId !== admissionId) throw new Error('Issue response admission changed')
  discard.ensureCleared()
  const keys = issueDraftKeys(orderDraftPrefix, session, admissionId)
  for (const key of keys) {
    const draft = readIssueDraftForSettlement(keys, key, outcome, () => {
      const raw = discard.read(key)
      const draft = raw === null ? { rows: [], successes: [] } : orderDraftSchema.parse(JSON.parse(raw))
      if (draft.rows.some(row => row.attempt && row.attempt.input.admissionId !== admissionId)) throw new Error('Draft admission mismatch')
      return draft
    })
    if (!draft) continue
    const row = draft.rows.find(row => row.attempt?.idempotencyKey === idempotencyKey)
    if (!row) continue
    if (JSON.stringify(row.attempt) !== JSON.stringify(attempt)) throw new Error('Issue draft does not match the original command')
    const next = orderDraftSchema.parse('failure' in outcome ? { ...draft,
      rows: draft.rows.map(item => item.id === row.id ? { ...item, attempt: undefined, error: outcome.failure, ...(item.estimate ? { estimate: { ...item.estimate, stale: true } } : {}) } : item),
    } : {
      rows: draft.rows.filter(item => item.id !== row.id)
        .map(item => item.estimate ? { ...item, estimate: { ...item.estimate, generation: crypto.randomUUID(), stale: true } } : item),
      successes: [...draft.successes, { id: row.id, display: row.pick.item.display }].slice(-orderBatchLimit),
    })
    discard.ensureCleared()
    sessionStorage.setItem(key, JSON.stringify(next))
    notifyIssueDraftSettled(key)
    return
  }
}
