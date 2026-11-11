import { laboratoryRequestStatusSchema, sessionContextSchema, type ImagingRequest, type LaboratoryRequest, type PathologyRequest, type SessionContext } from '@clinmesh/contracts/his'
import { getHisOperation } from '@clinmesh/contracts/his-operations'
import { z } from 'zod'
import { createDraftDiscard } from '../draft-discard.ts'

export type InvestigationKind = 'laboratory' | 'imaging' | 'pathology'
export type InvestigationAction = 'cancel' | 'retry'
export type InvestigationRequest = ImagingRequest | LaboratoryRequest | PathologyRequest
export interface OutpatientInvestigationActionContext {
  session: SessionContext
  caseId: string
  patientId: string
  encounterId: string
  patientName: string
  onChanged: () => Promise<unknown> | void
}
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  caseId: z.string().min(1), patientId: z.string().min(1), encounterId: z.string().min(1),
  kind: z.enum(['laboratory', 'imaging', 'pathology']), action: z.enum(['cancel', 'retry']) }).strict()
const snapshotSchema = z.object({ id: z.string().min(1), title: z.string().min(1), status: laboratoryRequestStatusSchema,
  version: z.number().int().positive(), serviceRequestId: z.string().min(1), serviceRequestVersion: z.string().min(1),
  taskId: z.string().min(1), taskVersion: z.string().min(1), financial: z.string() }).strict()
const rowSchema = z.object({ revision: z.uuid(), snapshot: snapshotSchema, selected: z.boolean() }).strict()
const commandSchema = z.object({ operation: z.enum(['laboratory-request.cancel', 'laboratory-request.retry-generation',
  'imaging-request.cancel', 'imaging-request.retry', 'pathology-request.cancel', 'pathology-request.retry']),
  input: z.object({ requestId: z.string().min(1), expectedRequestVersion: z.number().int().positive(), taskId: z.string().min(1), taskVersion: z.string().min(1),
    serviceRequestId: z.string().min(1).optional(), serviceRequestVersion: z.string().min(1).optional(), reasonCode: z.literal('no-longer-needed').optional() }).strict(),
  body: z.object({ expectedVersions: z.record(z.string(), z.string()), input: z.object({ expectedRequestVersion: z.number().int().positive(), reasonCode: z.literal('no-longer-needed').optional() }).strict() }).strict(),
}).strict().superRefine((command, ctx) => {
  const operation = getHisOperation(command.operation)
  const input = operation.input.safeParse(command.input)
  if (!input.success || JSON.stringify(operation.http.encodeBody?.(input.data)) !== JSON.stringify(command.body)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid original command' })
  }
})
const resultSchema = z.object({ revision: z.uuid(), title: z.string(), status: z.enum(['success', 'rejected', 'unknown', 'waiting']), message: z.string() }).strict()
const intentSchema = z.object({ row: rowSchema, command: commandSchema, key: z.uuid(), settled: z.boolean() }).strict()
const draftSchema = z.object({ version: z.literal(1), scope: scopeSchema, rows: z.array(rowSchema).max(20),
  results: z.array(resultSchema).max(20), intent: intentSchema.nullable() }).strict().superRefine((draft, ctx) => {
  const intent = draft.intent
  if (new Set(draft.rows.map(row => row.snapshot.id)).size !== draft.rows.length
    || (intent !== null && (intent.command.operation !== operationId(draft.scope.kind, draft.scope.action)
      || intent.command.input.requestId !== intent.row.snapshot.id
      || intent.command.input.expectedRequestVersion !== intent.row.snapshot.version
      || intent.command.input.taskId !== intent.row.snapshot.taskId || intent.command.input.taskVersion !== intent.row.snapshot.taskVersion
      || (draft.scope.action === 'cancel' && (intent.command.input.serviceRequestId !== intent.row.snapshot.serviceRequestId
        || intent.command.input.serviceRequestVersion !== intent.row.snapshot.serviceRequestVersion))
      || (!intent.settled && !draft.rows.some(row => row.revision === intent.row.revision))))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid action list' })
  }
})
export type ActionDraft = z.infer<typeof draftSchema>
export type ActionRow = z.infer<typeof rowSchema>
export type ActionScope = z.infer<typeof scopeSchema>
export const investigationActionChanged = 'clinmesh.outpatient-investigation-actions.changed'
const prefix = 'clinmesh.outpatient-investigation-actions:v1:'
const discard = createDraftDiscard(prefix, () => window.dispatchEvent(new CustomEvent(investigationActionChanged)), (key, raw) => {
  const draft = draftSchema.parse(JSON.parse(raw))
  if (actionKey(draft.scope) !== key) throw new Error('Action context mismatch')
  const intent = draft.intent
  return intent === null || intent.settled ? null : JSON.stringify({ ...draft, rows: [intent.row],
    results: draft.results.filter(result => result.revision === intent.row.revision) })
})
export class ActionDraftStorageError extends Error {}

export function operationId(kind: InvestigationKind, action: InvestigationAction) {
  return `${kind}-request.${action === 'retry' && kind === 'laboratory' ? 'retry-generation' : action}` as z.infer<typeof commandSchema>['operation']
}
export function actionScope(context: OutpatientInvestigationActionContext, kind: InvestigationKind, action: InvestigationAction): ActionScope {
  return scopeSchema.parse({ accountId: context.session.user.id, actor: context.session.actor, caseId: context.caseId,
    patientId: context.patientId, encounterId: context.encounterId, kind, action })
}
export function actionKey(scope: ActionScope) { return `${prefix}${encodeURIComponent(JSON.stringify(scope))}` }
export function loadActionDraft(scope: ActionScope): ActionDraft {
  try {
    const stored = discard.read(actionKey(scope))
    if (stored === null) return { version: 1, scope, rows: [], results: [], intent: null }
    const draft = draftSchema.parse(JSON.parse(stored))
    if (JSON.stringify(draft.scope) !== JSON.stringify(scope)) throw new Error('Action context mismatch')
    return draft
  } catch { throw new ActionDraftStorageError() }
}
export function saveActionDraft(draft: ActionDraft) {
  try {
    discard.ensureCleared()
    const checked = draftSchema.parse(draft)
    sessionStorage.setItem(actionKey(checked.scope), JSON.stringify(checked))
  } catch { throw new ActionDraftStorageError() }
  window.dispatchEvent(new CustomEvent(investigationActionChanged))
}
export function discardActionDraft(scope: ActionScope): boolean {
  try {
    const key = actionKey(scope), raw = sessionStorage.getItem(key)
    let record: unknown
    try { record = JSON.parse(raw ?? 'null') } catch { /* 明确确认后可丢弃无法解析的当前草稿。 */ }
    if (record !== null && typeof record === 'object' && 'intent' in record && record.intent !== null) return false
    sessionStorage.removeItem(key)
    discard.ensureCleared()
  } catch { throw new ActionDraftStorageError() }
  window.dispatchEvent(new CustomEvent(investigationActionChanged))
  return true
}
export function clearOutpatientInvestigationActionDrafts() {
  discard.clear()
}
export function requestSnapshot(request: InvestigationRequest, title: string): ActionRow['snapshot'] {
  return snapshotSchema.parse({ id: request.id, title, status: request.status, version: request.version,
    serviceRequestId: request.serviceRequestId, serviceRequestVersion: request.serviceRequestVersion,
    taskId: request.taskId, taskVersion: request.taskVersion, financial: JSON.stringify(request.billing ?? null) })
}
export function actionCommand(scope: ActionScope, row: ActionRow) {
  const { snapshot } = row
  const operation = getHisOperation(operationId(scope.kind, scope.action))
  const input = operation.input.parse({ requestId: snapshot.id, expectedRequestVersion: snapshot.version,
    taskId: snapshot.taskId, taskVersion: snapshot.taskVersion,
    ...(scope.action === 'cancel' ? { serviceRequestId: snapshot.serviceRequestId, serviceRequestVersion: snapshot.serviceRequestVersion, reasonCode: 'no-longer-needed' } : {}) })
  return commandSchema.parse({ operation: operation.id, input, body: operation.http.encodeBody?.(input) })
}
export function unavailableAction(request: InvestigationRequest, action: InvestigationAction): string | undefined {
  if (action === 'retry') {
    if (request.status !== 'generation-failed') return '仅未取得结果的申请可重试'
    if (request.generationError?.code === 'INVESTIGATION_UNSUPPORTED' || request.generationError?.code === 'INVESTIGATION_TRUTH_INCOMPATIBLE') return '当前项目不支持重试，请调整申请'
    return undefined
  }
  if (request.status !== 'issued' && request.status !== 'generation-failed') return '仅未受理的申请可取消'
  const billing = request.billing
  if (billing?.status === 'ambiguous') return '费用结果待查明，请先恢复原资金操作'
  if (billing !== undefined && billing.insuranceFen > 0) return '请先撤销关联检查的有效医保待遇'
  return undefined
}
