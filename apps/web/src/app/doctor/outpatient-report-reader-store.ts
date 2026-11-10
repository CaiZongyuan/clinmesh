import { apiConflictSchema, apiErrorSchema, sessionContextSchema, type DoctorCaseDetail } from '@clinmesh/contracts/his'
import { getHisOperation } from '@clinmesh/contracts/his-operations'
import { z } from 'zod'
import { createDraftDiscard } from '../draft-discard.ts'
import type { OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'

const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  caseId: z.string().min(1), patientId: z.string().min(1), encounterId: z.string().min(1) }).strict()
const snapshotSchema = z.object({ kind: z.enum(['laboratory', 'imaging', 'pathology']), requestId: z.string().min(1),
  requestVersion: z.number().int().positive(), reportId: z.string().min(1), reportVersion: z.string().regex(/^\d+$/),
  title: z.string().min(1), issuedAt: z.iso.datetime({ offset: true }), revisionNumber: z.number().int().positive() }).strict()
const rowSchema = z.object({ revision: z.uuid(), snapshot: snapshotSchema, selected: z.boolean() }).strict()
const commandSchema = z.object({ operation: z.enum(['laboratory-report.acknowledge', 'imaging-report.acknowledge', 'pathology-report.acknowledge']),
  input: z.object({ requestId: z.string().min(1), expectedRequestVersion: z.number().int().positive(), diagnosticReportId: z.string().min(1), diagnosticReportVersion: z.string().regex(/^\d+$/) }).strict(),
  body: z.object({ expectedVersions: z.record(z.string(), z.string()), input: z.object({ expectedRequestVersion: z.number().int().positive() }).strict() }).strict(),
}).strict().superRefine((command, ctx) => {
  const operation = getHisOperation(command.operation), parsed = operation.input.safeParse(command.input)
  if (!parsed.success || JSON.stringify(operation.http.encodeBody?.(parsed.data)) !== JSON.stringify(command.body)) ctx.addIssue({ code: 'custom', message: 'Invalid original acknowledgement' })
})
const intentSchema = z.object({ row: rowSchema, command: commandSchema, key: z.uuid(), settled: z.boolean() }).strict()
const failureSchema = z.object({ status: z.number().int().min(400).max(499), code: apiErrorSchema.shape.error.shape.code,
  conflict: apiConflictSchema.optional(), reason: apiErrorSchema.shape.error.shape.reason }).strict()
const resultSchema = z.object({ revision: z.uuid(), title: z.string(), kind: snapshotSchema.shape.kind, requestId: z.string().min(1),
  status: z.enum(['success', 'rejected', 'unknown', 'waiting']), failure: failureSchema.optional() }).strict()
const draftSchema = z.object({ version: z.literal(1), scope: scopeSchema, rows: z.array(rowSchema).max(20), results: z.array(resultSchema).max(20), intent: intentSchema.nullable() }).strict()
  .superRefine((draft, ctx) => {
    const intent = draft.intent, original = intent?.row.snapshot
    if (new Set(draft.rows.map(row => `${row.snapshot.kind}:${row.snapshot.requestId}`)).size !== draft.rows.length
      || (intent !== null && original !== undefined && (intent.command.operation !== `${original.kind}-report.acknowledge`
        || intent.command.input.requestId !== original.requestId || intent.command.input.expectedRequestVersion !== original.requestVersion
        || intent.command.input.diagnosticReportId !== original.reportId || intent.command.input.diagnosticReportVersion !== original.reportVersion
        || (!intent.settled && !draft.rows.some(row => row.revision === intent.row.revision))))) ctx.addIssue({ code: 'custom', message: 'Invalid report list' })
  })
export type ReportScope = z.infer<typeof scopeSchema>
export type ReportSnapshot = z.infer<typeof snapshotSchema>
export type ReportRow = z.infer<typeof rowSchema>
export type ReportDraft = z.infer<typeof draftSchema>
export type ReportFailure = z.infer<typeof failureSchema>
export const reportReaderChanged = 'clinmesh.outpatient-report-reader.changed'
const prefix = 'clinmesh.outpatient-report-reader:v1:'
const discard = createDraftDiscard(prefix, () => window.dispatchEvent(new CustomEvent(reportReaderChanged)), (key, raw) => {
  const draft = draftSchema.parse(JSON.parse(raw))
  if (reportDraftKey(draft.scope) !== key) throw new Error('Report scope mismatch')
  const intent = draft.intent
  return intent === null || intent.settled ? null : JSON.stringify({ ...draft, rows: [intent.row],
    results: draft.results.filter(result => result.revision === intent.row.revision) })
})
export class ReportStorageError extends Error {}
export class ReportSelectionLimit extends Error {}
export function reportScope(context: OutpatientInvestigationActionContext): ReportScope {
  return scopeSchema.parse({ accountId: context.session.user.id, actor: context.session.actor, caseId: context.caseId, patientId: context.patientId, encounterId: context.encounterId })
}
export function reportDraftKey(scope: ReportScope) { return `${prefix}${encodeURIComponent(JSON.stringify(scope))}` }
export function loadReportDraft(scope: ReportScope): ReportDraft {
  try {
    const stored = discard.read(reportDraftKey(scope))
    if (stored === null) return { version: 1, scope, rows: [], results: [], intent: null }
    const checked = draftSchema.parse(JSON.parse(stored))
    if (JSON.stringify(checked.scope) !== JSON.stringify(scope)) throw new Error('Report scope mismatch')
    return checked
  } catch { throw new ReportStorageError() }
}
export function saveReportDraft(value: ReportDraft) {
  try { discard.ensureCleared(); const checked = draftSchema.parse(value); sessionStorage.setItem(reportDraftKey(checked.scope), JSON.stringify(checked)) }
  catch { throw new ReportStorageError() }
  window.dispatchEvent(new CustomEvent(reportReaderChanged))
}
export function clearOutpatientReportDrafts() {
  discard.clear()
}
export function reportCommand(row: ReportRow) {
  const { snapshot } = row, operation = getHisOperation(`${snapshot.kind}-report.acknowledge`)
  const input = operation.input.parse({ requestId: snapshot.requestId, expectedRequestVersion: snapshot.requestVersion,
    diagnosticReportId: snapshot.reportId, diagnosticReportVersion: snapshot.reportVersion })
  return commandSchema.parse({ operation: operation.id, input, body: operation.http.encodeBody?.(input) })
}
export type ReportRecord = { kind: ReportSnapshot['kind']; title: string; request: NonNullable<DoctorCaseDetail['laboratoryRequests']>['requests'][number]
  | NonNullable<DoctorCaseDetail['imagingRequests']>['requests'][number] | NonNullable<DoctorCaseDetail['pathologyRequests']>['requests'][number] }
export function reportRecords(detail: DoctorCaseDetail, locale: string): ReportRecord[] {
  return [
    ...(detail.laboratoryRequests?.requests ?? []).map(request => ({ kind: 'laboratory' as const, request,
      title: (locale === 'zh-CN' ? request.laboratoryService?.nameZh : request.laboratoryService?.nameEn ?? request.laboratoryService?.nameZh) ?? request.referenceConcept?.display ?? request.catalogItemId })),
    ...(detail.imagingRequests?.requests ?? []).map(request => ({ kind: 'imaging' as const, request, title: request.service.name })),
    ...(detail.pathologyRequests?.requests ?? []).map(request => ({ kind: 'pathology' as const, request, title: request.service.name })),
  ]
}
export function reportSnapshot(record: ReportRecord): ReportSnapshot | undefined {
  const report = record.request.report
  if (!report) return undefined
  return { kind: record.kind, requestId: record.request.id, requestVersion: record.request.version, title: record.title,
    reportId: report.diagnosticReportId, reportVersion: report.diagnosticReportVersion, issuedAt: report.issuedAt, revisionNumber: report.revisionNumber }
}
// Titles can translate without changing the clinical revision the user reviewed.
export function reportIdentity(snapshot: ReportSnapshot) { return JSON.stringify([snapshot.kind, snapshot.requestId, snapshot.requestVersion, snapshot.reportId, snapshot.reportVersion, snapshot.issuedAt, snapshot.revisionNumber]) }
export function sameReport(row: ReportRow, record: ReportRecord | undefined) {
  const snapshot = record === undefined ? undefined : reportSnapshot(record)
  return snapshot !== undefined && reportIdentity(snapshot) === reportIdentity(row.snapshot)
}
