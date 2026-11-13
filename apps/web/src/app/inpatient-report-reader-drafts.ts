import { apiConflictSchema, apiErrorSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientInvestigationAcknowledgeInputSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { createDraftDiscard, hasUnknownDraftAttempt } from './draft-discard.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(), patientId: z.string().min(1), admissionId: z.string().min(1) }).strict()
const snapshotSchema = z.object({ kind: z.enum(['laboratory', 'imaging', 'examination']), input: inpatientInvestigationAcknowledgeInputSchema,
  serviceRequestId: z.string().min(1), taskId: z.string().min(1), title: z.string().min(1), issuedAt: z.iso.datetime({ offset: true }), revisionNumber: z.number().int().positive() }).strict()
const rowSchema = z.object({ revision: z.uuid(), snapshot: snapshotSchema, selected: z.boolean() }).strict()
const commandSchema = z.object({ operation: z.literal('inpatient.investigation.acknowledge'), input: inpatientInvestigationAcknowledgeInputSchema }).strict()
const failureSchema = z.object({ status: z.number().int().min(400).max(499), code: apiErrorSchema.shape.error.shape.code,
  conflict: apiConflictSchema.optional(), reason: apiErrorSchema.shape.error.shape.reason }).strict()
const itemSchema = z.object({ row: rowSchema, status: z.enum(['waiting', 'unknown', 'success', 'rejected']), command: commandSchema.optional(),
  key: z.uuid().optional(), failure: failureSchema.optional() }).strict()
const draftSchema = z.object({ version: z.literal(1), scope: scopeSchema, rows: z.array(rowSchema).max(20), items: z.array(itemSchema).max(20) }).strict().superRefine((draft, ctx) => {
  if (new Set(draft.rows.map(row => row.snapshot.input.requestId)).size !== draft.rows.length || new Set(draft.items.map(item => item.row.revision)).size !== draft.items.length
    || new Set(draft.items.flatMap(item => item.key ? [item.key] : [])).size !== draft.items.filter(item => item.key).length
    || draft.items.filter(item => item.status === 'unknown').length > 1 || draft.items.some(item => item.command
      ? !item.key || signature(item.command.input) !== signature(item.row.snapshot.input) : item.key !== undefined || item.status === 'unknown' || item.status === 'success')
    || [...draft.rows, ...draft.items.map(item => item.row)].some(row => row.snapshot.input.admissionId !== draft.scope.admissionId)) ctx.addIssue({ code: 'custom', message: 'Invalid inpatient acknowledgement binding' })
})
type Scope = z.infer<typeof scopeSchema>
type Draft = z.infer<typeof draftSchema>
export type ReportRow = z.infer<typeof rowSchema>
export type ReportSnapshot = z.infer<typeof snapshotSchema>
export type ReportFailure = z.infer<typeof failureSchema>
type Facts = z.infer<typeof inpatientInvestigationsSchema>
export type ReportRecord = { kind: 'laboratory' | 'imaging' | 'examination'; title: string; request: Facts['laboratoryRequests'][number] | Facts['imagingRequests'][number] | Facts['examinationRequests'][number] }
const prefix = 'clinmesh.inpatient-report-reader:v1:', changedEvent = 'clinmesh.inpatient-report-reader.changed'
const discard = createDraftDiscard(prefix, () => window.dispatchEvent(new CustomEvent(changedEvent)), (key, raw) => {
  const draft = draftSchema.parse(JSON.parse(raw))
  if (reportDraftKey(draft.scope) !== key) throw new Error('Report context mismatch')
  const unknown = draft.items.find(item => item.status === 'unknown')
  return unknown ? JSON.stringify({ ...draft, rows: [unknown.row], items: [unknown] }) : null
})
const active = new Set<string>()
export class ReportSelectionLimit extends Error {}
function signature(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
}
export function reportScope(session: SessionContext, patientId: string, admissionId: string): Scope { return { accountId: session.user.id, actor: session.actor, patientId, admissionId } }
export function reportDraftKey(scope: Scope) { return `${prefix}${encodeURIComponent(JSON.stringify(scopeSchema.parse(scope)))}` }
export function reportRecords(facts: Facts, locale: string): ReportRecord[] {
  return [...facts.laboratoryRequests.map(request => ({ kind: 'laboratory' as const, request,
    title: (locale === 'zh-CN' ? request.laboratoryService?.nameZh : request.laboratoryService?.nameEn ?? request.laboratoryService?.nameZh) ?? request.referenceConcept?.display ?? request.catalogItemId })),
  ...facts.examinationRequests.map(request => ({ kind: 'examination' as const, request, title: request.service.name })),
  ...facts.imagingRequests.map(request => ({ kind: 'imaging' as const, request, title: request.service.name }))]
}
export function reportSnapshot(record: ReportRecord, admissionId: string): ReportSnapshot | undefined {
  const { request } = record, report = request.report
  if (!report || !request.taskId || !request.taskVersion) return undefined
  return { kind: record.kind, title: record.title, serviceRequestId: request.serviceRequestId, taskId: request.taskId, issuedAt: report.issuedAt, revisionNumber: report.revisionNumber,
    input: { admissionId, requestId: request.id, expectedRequestVersion: request.version, serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion,
      diagnosticReportId: report.diagnosticReportId, diagnosticReportVersion: report.diagnosticReportVersion } }
}
export function reportIdentity(snapshot: ReportSnapshot) {
  const input = snapshot.input
  return JSON.stringify([snapshot.kind, input.admissionId, input.requestId, input.expectedRequestVersion, snapshot.serviceRequestId, input.serviceRequestVersion,
    snapshot.taskId, input.taskVersion, input.diagnosticReportId, input.diagnosticReportVersion, snapshot.issuedAt, snapshot.revisionNumber])
}
export function sameReport(row: ReportRow, record: ReportRecord | undefined) {
  const snapshot = record && reportSnapshot(record, row.snapshot.input.admissionId)
  return snapshot !== undefined && reportIdentity(snapshot) === reportIdentity(row.snapshot)
}
function load(scope: Scope): Draft {
  const value = discard.read(reportDraftKey(scope))
  if (value === null) return { version: 1, scope, rows: [], items: [] }
  const checked = draftSchema.parse(JSON.parse(value))
  if (signature(checked.scope) !== signature(scope)) throw new Error('Report context mismatch')
  return checked
}
function save(draft: Draft) {
  discard.ensureCleared()
  const checked = draftSchema.parse(draft), key = reportDraftKey(checked.scope)
  sessionStorage.setItem(key, JSON.stringify(checked)); window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
}
function changedFailure(row: ReportRow, record: ReportRecord | undefined): ReportFailure {
  const original = row.snapshot.input, report = record?.request.report
  const revised = report !== undefined && (report.diagnosticReportId !== original.diagnosticReportId || report.diagnosticReportVersion !== original.diagnosticReportVersion)
  return { status: 409, code: 'WORKFLOW_CONFLICT', conflict: revised
    ? { owner: `${row.snapshot.kind}-report`, resource: `DiagnosticReport/${original.diagnosticReportId}`, currentStatus: 'superseded', currentVersion: report.diagnosticReportVersion, expectedVersion: original.diagnosticReportVersion }
    : { owner: `${row.snapshot.kind}-request`, resource: `ServiceRequest/${row.snapshot.serviceRequestId}`, currentStatus: record?.request.status ?? 'missing',
      ...(record ? { currentVersion: String(record.request.version) } : {}), expectedVersion: String(original.expectedRequestVersion) } }
}

/** Only the existing inpatient writer sends commands and resolves original receipts. */
export function useInpatientReportDrafts({ scope, session, write, refresh, readOnly }: { scope: Scope; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent>; refresh: () => Promise<Facts | undefined>; readOnly: boolean }) {
  const key = reportDraftKey(scope), valid = session.actor.roleCode === 'inpatient-doctor' && scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
  const read = () => { try { if (!valid) throw new Error('Invalid reader session'); return { draft: load(scope), error: false } } catch { return { draft: null, error: true } } }
  const [state, setState] = useState(read), [busy, setBusy] = useState(false), [message, setMessage] = useState<'' | 'limit' | 'storage' | 'unknown' | 'resolved' | 'changed' | 'stopped'>('')
  const mounted = useRef(true), failed = useRef(false), writer = useRef(write), refreshLatest = useRef(refresh)
  const currentReadOnly = useRef(readOnly)
  currentReadOnly.current = readOnly
  writer.current = write; refreshLatest.current = refresh
  useEffect(() => {
    mounted.current = true
    const update = () => { const next = read(); setState({ ...next, error: next.error || failed.current }) }
    update(); window.addEventListener(changedEvent, update)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, update) }
  // Parent remounts on the complete account, actor, patient and admission binding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const failStorage = () => { failed.current = true; if (mounted.current) { setState({ ...read(), error: true }); setMessage('storage') } }
  const notify = (value: typeof message) => { if (mounted.current) setMessage(value) }
  const change = (update: (draft: Draft) => Draft) => {
    if (failed.current || active.has(key) || writer.current.blocked || !valid) return
    try { const value = load(scope); if (value.items.some(item => item.status === 'unknown')) return; save(update(value)); notify('') }
    catch (error) { if (error instanceof ReportSelectionLimit) notify('limit'); else failStorage() }
  }
  const run = async (plan: ReportRow[] | null, guard: (row?: ReportRow) => boolean) => {
    const isCurrent = (row?: ReportRow) => mounted.current && valid && guard(row)
    if (!isCurrent() || active.has(key) || failed.current || writer.current.storageFailure || writer.current.mutation.isPending || plan !== null && currentReadOnly.current) return
    active.add(key); setBusy(true)
    try {
      let value = load(scope)
      if (plan !== null) {
        if (writer.current.blocked || value.items.some(item => item.status === 'unknown') || !plan.length) return
        if (plan.some(row => !isCurrent(row) || !value.rows.some(item => item.selected && item.revision === row.revision && reportIdentity(item.snapshot) === reportIdentity(row.snapshot)))) { notify('changed'); return }
        value = { ...value, items: plan.map(row => ({ row, status: 'waiting' })) }; save(value)
      }
      const rows = plan ?? value.items.filter(item => item.status === 'unknown' || item.key === writer.current.pending?.idempotencyKey).map(item => item.row)
      for (const row of rows) {
        if (!isCurrent(plan === null ? undefined : row)) { notify('changed'); return }
        let current = load(scope), item = current.items.find(item => item.row.revision === row.revision)
        if (!item || plan === null && item.status !== 'unknown' && item.key !== writer.current.pending?.idempotencyKey) return
        if (plan !== null) {
          const facts = await refreshLatest.current()
          if (!isCurrent(row) || currentReadOnly.current) { notify('changed'); return }
          current = load(scope)
          if (!current.rows.some(item => item.revision === row.revision && item.selected)) { notify('changed'); return }
          if (!facts || facts.admissionId !== scope.admissionId) { notify('changed'); return }
          const record = reportRecords(facts, 'zh-CN').find(record => record.kind === row.snapshot.kind && record.request.id === row.snapshot.input.requestId)
          if (!sameReport(row, record) || record?.request.status !== 'reported') {
            save({ ...current, items: current.items.map(item => item.row.revision === row.revision ? { ...item, status: 'rejected', failure: changedFailure(row, record) } : item) }); continue
          }
          item = { ...item, status: 'unknown', command: { operation: 'inpatient.investigation.acknowledge', input: row.snapshot.input }, key: crypto.randomUUID() }
          save({ ...current, items: current.items.map(entry => entry.row.revision === row.revision ? item! : entry) })
        }
        if (!item.command || !item.key) return
        try { await writer.current.mutation.mutateAsync({ ...item.command, idempotencyKey: item.key, ...(plan === null ? { recoverOriginal: true as const } : {}),
          isCurrent: () => isCurrent(plan === null ? undefined : row), canSend: () => !currentReadOnly.current }) }
        catch (error) {
          if (plan !== null && error instanceof Error && 'commandNotSent' in error && error.commandNotSent === true) {
            const value = load(scope)
            save({ ...value, items: value.items.map(entry => entry.key === item.key ? { ...entry, status: 'rejected' } : entry) })
            notify('changed'); return
          }
          if (!(error instanceof Error && 'commandRejected' in error && error.commandRejected === true)) { notify('unknown'); return }
        }
        if (plan === null) { notify('resolved'); return }
      }
    } catch { failStorage() }
    finally { active.delete(key); if (mounted.current) setBusy(false); window.dispatchEvent(new CustomEvent(changedEvent)) }
  }
  const discardCurrent = () => {
    if (!mounted.current || !valid || active.has(key) || writer.current.mutation.isPending || writer.current.pending !== null) return false
    try {
      if (hasUnknownDraftAttempt(key)) { notify('unknown'); return false }
      sessionStorage.removeItem(key); discard.ensureCleared()
      failed.current = false; setState(read()); notify('')
      window.dispatchEvent(new CustomEvent(changedEvent))
      return true
    } catch { failStorage(); return false }
  }
  const draft = state.draft && { rows: state.draft.rows, intent: state.draft.items.find(item => item.status === 'unknown' || item.key !== undefined && item.key === write.pending?.idempotencyKey),
    results: state.draft.items.map(item => ({ revision: item.row.revision, title: item.row.snapshot.title, kind: item.row.snapshot.kind,
      requestId: item.row.snapshot.input.requestId, status: item.status, failure: item.failure })) }
  return { draft, error: state.error, busy: busy || active.has(key), message, change, run, discard: discardCurrent,
    reload: () => { const next = read(); if (!next.error) failed.current = false; setState(next) } }
}

/** Persist only the original row's settlement before the shared writer clears its immutable intent. */
export function settleInpatientReportAttempt(raw: unknown, key: string, session: SessionContext, failure?: ReportFailure, response?: unknown) {
  const command = commandSchema.safeParse(raw)
  if (!command.success) return
  discard.ensureCleared()
  for (const storageKey of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let decoded: unknown
    try { decoded = JSON.parse(decodeURIComponent(storageKey.slice(prefix.length))) } catch { continue }
    const scope = scopeSchema.safeParse(decoded)
    if (!scope.success || scope.data.accountId !== session.user.id || signature(scope.data.actor) !== signature(session.actor) || scope.data.admissionId !== command.data.input.admissionId) continue
    const value = load(scope.data), item = value.items.find(item => item.key === key && signature(item.command) === signature(command.data))
    if (!item || item.status === 'rejected') continue
    if (!failure) {
      const result = inpatientInvestigationResponseSchema.parse(response), original = item.row.snapshot
      const current = (original.kind === 'laboratory' ? result.data.laboratoryRequests : original.kind === 'examination' ? result.data.examinationRequests : result.data.imagingRequests).find(request => request.id === command.data.input.requestId)
      const report = current?.report, acknowledgement = report?.acknowledgement
      if (result.data.admissionId !== scope.data.admissionId || current?.status !== 'acknowledged' || current.version !== original.input.expectedRequestVersion + 1
        || current.serviceRequestId !== original.serviceRequestId || current.serviceRequestVersion !== original.input.serviceRequestVersion || current.taskId !== original.taskId || current.taskVersion !== original.input.taskVersion
        || report?.diagnosticReportId !== original.input.diagnosticReportId || report.diagnosticReportVersion !== original.input.diagnosticReportVersion
        || !acknowledgement || acknowledgement.acknowledgedBy !== scope.data.actor.practitionerId) throw new Error('Original inpatient acknowledgement proof mismatch')
    }
    if (item.status === 'success') continue
    save({ ...value, rows: failure ? value.rows : value.rows.filter(row => row.revision !== item.row.revision),
      items: value.items.map(entry => entry.row.revision === item.row.revision ? { ...entry, status: failure ? 'rejected' : 'success', ...(failure ? { failure } : {}) } : entry) })
  }
}
export function clearInpatientReportDrafts() {
  discard.clear()
}
