import { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationResponseSchema, inpatientInvestigationCatalogSchema, inpatientInvestigationIssueInputSchema } from '@clinmesh/contracts/inpatient-investigations'
import { createDraftDiscard } from './draft-discard.ts'
import { issueDraftFailureSchema, issueDraftKeys, notifyIssueDraftSettled, readIssueDraftForSettlement, type IssueDraftOutcome } from './inpatient-issue-draft-settlement.ts'

export const investigationDraftPrefix = 'clinmesh.inpatient-investigation-drafts:v1:'
const discard = createDraftDiscard(investigationDraftPrefix)
export const investigationBatchLimit = 20
export const investigationAttemptSchema = z.object({ idempotencyKey: z.uuid(), input: inpatientInvestigationIssueInputSchema }).strict()
export const investigationDraftRowSchema = z.object({
  id: z.uuid(), item: inpatientInvestigationCatalogSchema.shape.items.element,
  indicationCode: z.string().max(64), indication: z.string().max(500), selected: z.boolean(),
  attempt: investigationAttemptSchema.optional(), error: z.union([z.string(), issueDraftFailureSchema]).optional(),
}).strict().refine(row => row.attempt === undefined || (row.attempt.input.catalogVersion === row.item.version && row.attempt.input.selection.kind === row.item.kind
  && (row.attempt.input.selection.kind === 'imaging' ? row.attempt.input.selection.serviceId : row.attempt.input.selection.catalogItemId) === row.item.id))
export const investigationDraftSchema = z.object({
  rows: z.array(investigationDraftRowSchema).max(investigationBatchLimit),
  successes: z.array(z.object({ id: z.uuid(), display: z.string() }).strict()).max(investigationBatchLimit),
}).strict()
export type InvestigationDraft = z.infer<typeof investigationDraftSchema>
export type InvestigationDraftRow = z.infer<typeof investigationDraftRowSchema>
export type InvestigationAttempt = z.infer<typeof investigationAttemptSchema>

export function investigationDraftKey(session: SessionContext, admission: InpatientAdmission) {
  return investigationDraftPrefix + encodeURIComponent(JSON.stringify([session.user.id, session.actor, admission.patientId, admission.id]))
}

export function clearInvestigationDrafts() {
  discard.clear()
}

export function readInvestigationDraft(key: string): InvestigationDraft {
  const raw = discard.read(key)
  return raw === null ? { rows: [], successes: [] } : investigationDraftSchema.parse(JSON.parse(raw))
}

export function saveInvestigationDraft(key: string, draft: InvestigationDraft) {
  discard.ensureCleared()
  sessionStorage.setItem(key, JSON.stringify(draft))
}

/** 先持久消费原行，再由共享 writer 解除原意图；同键重读可安全重复。 */
export function settleIssuedInvestigation(input: unknown, idempotencyKey: string, session: SessionContext, outcome: IssueDraftOutcome): void {
  const attempt = investigationAttemptSchema.parse({ input, idempotencyKey })
  const admissionId = attempt.input.admissionId
  if ('response' in outcome && inpatientInvestigationResponseSchema.parse(outcome.response).data.admissionId !== admissionId) throw new Error('Issue response admission changed')
  discard.ensureCleared()
  const keys = issueDraftKeys(investigationDraftPrefix, session, admissionId)
  for (const key of keys) {
    const draft = readIssueDraftForSettlement(keys, key, outcome, () => {
      const draft = readInvestigationDraft(key)
      if (draft.rows.some(row => row.attempt && row.attempt.input.admissionId !== admissionId)) throw new Error('Draft admission mismatch')
      return draft
    })
    if (!draft) continue
    const row = draft.rows.find(row => row.attempt?.idempotencyKey === idempotencyKey)
    if (!row) continue
    if (JSON.stringify(row.attempt) !== JSON.stringify(attempt)) throw new Error('Issue draft does not match the original command')
    const next = investigationDraftSchema.parse('failure' in outcome ? { ...draft,
      rows: draft.rows.map(item => item.id === row.id ? { ...item, attempt: undefined, error: outcome.failure } : item),
    } : {
      rows: draft.rows.filter(item => item.id !== row.id),
      successes: [...draft.successes, { id: row.id, display: row.item.display }].slice(-investigationBatchLimit),
    })
    discard.ensureCleared()
    sessionStorage.setItem(key, JSON.stringify(next))
    notifyIssueDraftSettled(key)
    return
  }
}
