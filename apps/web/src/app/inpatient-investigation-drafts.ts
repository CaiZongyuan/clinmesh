import { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationIssueInputSchema } from '@clinmesh/contracts/inpatient-investigations'
import { createDraftDiscard } from './draft-discard.ts'

export const investigationDraftPrefix = 'clinmesh.inpatient-investigation-drafts:v1:'
const discard = createDraftDiscard(investigationDraftPrefix)
export const investigationBatchLimit = 20
export const investigationAttemptSchema = z.object({ idempotencyKey: z.uuid(), input: inpatientInvestigationIssueInputSchema }).strict()
export const investigationDraftRowSchema = z.object({
  id: z.uuid(), item: inpatientInvestigationCatalogSchema.shape.items.element,
  indicationCode: z.string().max(64), indication: z.string().max(500), selected: z.boolean(),
  attempt: investigationAttemptSchema.optional(), error: z.string().optional(),
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
