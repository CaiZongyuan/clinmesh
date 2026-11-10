import { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationIssueInputSchema } from '@clinmesh/contracts/inpatient-investigations'

export const investigationDraftPrefix = 'clinmesh.inpatient-investigation-drafts:v1:'
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
  try {
    const storage = sessionStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(investigationDraftPrefix)) storage.removeItem(key)
    }
  } catch {
    // 浏览器存储策略不能阻断已经成功的服务端退出及界面清理。
  }
}
