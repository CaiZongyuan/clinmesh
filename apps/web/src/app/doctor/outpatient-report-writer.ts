import { commandReceiptLookupSchema, getHisOperation } from '@clinmesh/contracts/his-operations'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { ApiClientError, apiGet, apiMutation, getDoctorCase, getSession, newIdempotencyKey } from '../api-client.ts'
import type { OutpatientInvestigationActionContext } from './outpatient-investigation-action-store.ts'
import { loadReportDraft, reportCommand, reportDraftKey, reportReaderChanged, reportRecords, reportScope, ReportSelectionLimit, ReportStorageError,
  sameReport, saveReportDraft, type ReportDraft, type ReportFailure, type ReportRecord, type ReportRow, type ReportScope } from './outpatient-report-reader-store.ts'

const active = new Set<string>()
const proofSchema = z.object({ data: z.object({ acknowledgementId: z.string().min(1), acknowledgedAt: z.iso.datetime({ offset: true }),
  acknowledgedBy: z.string().min(1), diagnosticReportId: z.string().min(1), requestId: z.string().min(1), requestVersion: z.number().int().positive(), status: z.literal('acknowledged') }).strict() }).loose()
function read(scope: ReportScope) { try { return { draft: loadReportDraft(scope), error: false } } catch { return { draft: null, error: true } } }
function definiteRejection(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status >= 400 && error.status < 500 && !['UNEXPECTED_RESPONSE', 'IDEMPOTENCY_KEY_REUSED'].includes(error.code)
}
function rejectedFailure(error: ApiClientError): ReportFailure {
  // Keep validated machine-readable details, never the raw server message or idempotency key.
  return { status: error.status, code: error.code, ...(error.conflict === undefined ? {} : { conflict: error.conflict }),
    ...(error.reason === undefined ? {} : { reason: error.reason }) }
}
function changedFailure(row: ReportRow, record: ReportRecord | undefined): ReportFailure {
  const original = row.snapshot, report = record?.request.report
  const reportChanged = report !== undefined && (report.diagnosticReportId !== original.reportId || report.diagnosticReportVersion !== original.reportVersion)
  return { status: 409, code: 'WORKFLOW_CONFLICT', conflict: reportChanged
    ? { owner: `${original.kind}-report`, resource: `DiagnosticReport/${original.reportId}`, currentStatus: 'superseded',
      currentVersion: report.diagnosticReportVersion, expectedVersion: original.reportVersion }
    : { owner: `${original.kind}-request`, resource: `ServiceRequest/${record?.request.serviceRequestId ?? original.requestId}`,
      currentStatus: record?.request.status ?? 'missing', ...(record === undefined ? {} : { currentVersion: String(record.request.version) }), expectedVersion: String(original.requestVersion) } }
}
type Message = '' | 'limit' | 'storage' | 'unknown' | 'resolved' | 'changed' | 'stopped'
export function useOutpatientReportWriter(context: OutpatientInvestigationActionContext) {
  const scope = reportScope(context), key = reportDraftKey(scope)
  const [state, setState] = useState(() => read(scope)), [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>('')
  const mounted = useRef(true), storageFailed = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const refresh = () => { const latest = read(scope); setState({ ...latest, error: latest.error || storageFailed.current }) }
    refresh(); window.addEventListener(reportReaderChanged, refresh)
    return () => window.removeEventListener(reportReaderChanged, refresh)
  // The parent keys this hook by the entire serialized scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const notify = (value: Message) => { if (mounted.current) setMessage(value) }
  const failStorage = () => { storageFailed.current = true; if (mounted.current) setState({ ...read(scope), error: true }); notify('storage') }
  const change = (update: (value: ReportDraft) => ReportDraft) => {
    if (storageFailed.current) return
    try { const value = loadReportDraft(scope); if (active.has(key) || value.intent !== null) return; saveReportDraft(update(value)); notify('') }
    catch (error) { if (error instanceof ReportSelectionLimit) notify('limit'); else failStorage() }
  }
  const result = (value: ReportDraft, row: ReportRow, status: ReportDraft['results'][number]['status'], failure?: ReportFailure): ReportDraft => ({ ...value,
    results: value.results.map(item => item.revision === row.revision ? { ...item, status, failure } : item) })
  const settle = (intent: NonNullable<ReportDraft['intent']>) => {
    const value = loadReportDraft(scope)
    if (value.intent?.key !== intent.key) throw new Error('Original acknowledgement changed')
    const settled = result({ ...value, rows: value.rows.filter(row => row.revision !== intent.row.revision), intent: { ...intent, settled: true } }, intent.row, 'success')
    saveReportDraft(settled)
    saveReportDraft({ ...settled, intent: null })
  }
  const assertSession = async (guard: () => boolean) => {
    const session = await getSession()
    if (session.user.id !== scope.accountId || JSON.stringify(session.actor) !== JSON.stringify(scope.actor) || !mounted.current || !guard()) throw new Error('Report context changed')
  }
  const verify = (intent: NonNullable<ReportDraft['intent']>, response: unknown) => {
    const proof = proofSchema.parse(getHisOperation(intent.command.operation).output.parse(response)), original = intent.command.input
    if (proof.data.requestId !== original.requestId || proof.data.diagnosticReportId !== original.diagnosticReportId
      || proof.data.requestVersion !== original.expectedRequestVersion + 1 || proof.data.acknowledgedBy !== scope.actor.practitionerId) throw new Error('Original acknowledgement proof mismatch')
  }
  const send = async (intent: NonNullable<ReportDraft['intent']>) => {
    const operation = getHisOperation(intent.command.operation)
    const path = operation.http.path.replace(':requestId', encodeURIComponent(intent.command.input.requestId))
      .replace(':diagnosticReportId', encodeURIComponent(intent.command.input.diagnosticReportId))
    verify(intent, await apiMutation(path, operation.output, intent.command.body, { idempotencyKey: intent.key }))
  }
  const run = async (plan: ReportRow[] | null, guard: (row?: ReportRow) => boolean) => {
    if (active.has(key) || storageFailed.current) return
    active.add(key); setBusy(true)
    try {
      let value = loadReportDraft(scope)
      await assertSession(() => guard())
      if (plan === null) {
        const intent = value.intent
        if (!intent) return
        if (intent.settled) { settle(intent); await context.onChanged(); notify('resolved'); return }
        let receipt
        try { receipt = await apiGet(`/api/his/v1/command-receipts?${new URLSearchParams({ operationId: intent.command.operation, idempotencyKey: intent.key })}`, commandReceiptLookupSchema) }
        catch (error) { if (!(error instanceof ApiClientError && error.status === 404 && error.code === 'COMMAND_RECEIPT_NOT_FOUND')) { notify('unknown'); return } }
        if (receipt) {
          if (receipt.operationId !== intent.command.operation || receipt.idempotencyKey !== intent.key || receipt.status !== 'completed') { notify('unknown'); return }
          verify(intent, receipt.response)
        } else {
          await assertSession(() => guard())
          try { await send(intent) }
          catch (error) {
            if (definiteRejection(error)) { saveReportDraft(result({ ...loadReportDraft(scope), intent: null }, intent.row, 'rejected', rejectedFailure(error))); await context.onChanged(); return }
            throw error
          }
        }
        settle(intent); await context.onChanged(); notify('resolved'); return
      }
      if (value.intent !== null || plan.length === 0) return
      if (plan.some(row => !guard(row) || !value.rows.some(item => item.revision === row.revision && item.selected && JSON.stringify(item.snapshot) === JSON.stringify(row.snapshot)))) { notify('changed'); return }
      value = { ...value, results: plan.map(row => ({ revision: row.revision, title: row.snapshot.title, kind: row.snapshot.kind, requestId: row.snapshot.requestId, status: 'waiting' as const })) }
      saveReportDraft(value)
      for (const row of plan) {
        await assertSession(() => guard(row))
        const detail = await getDoctorCase(scope.caseId)
        if (!guard(row) || detail.patient.id !== scope.patientId || detail.encounter.id !== scope.encounterId || detail.encounter.status !== 'in-progress') { notify('changed'); break }
        const record = reportRecords(detail, 'zh-CN').find(item => item.kind === row.snapshot.kind && item.request.id === row.snapshot.requestId)
        if (!sameReport(row, record) || record?.request.status !== 'reported') {
          saveReportDraft(result(loadReportDraft(scope), row, 'rejected', changedFailure(row, record))); await context.onChanged(); continue
        }
        const intent = { row, command: reportCommand(row), key: newIdempotencyKey(), settled: false }
        saveReportDraft({ ...loadReportDraft(scope), intent })
        try { await assertSession(() => guard(row)); await send(intent) }
        catch (error) {
          if (definiteRejection(error)) { saveReportDraft(result({ ...loadReportDraft(scope), intent: null }, row, 'rejected', rejectedFailure(error))); await context.onChanged(); continue }
          saveReportDraft(result(loadReportDraft(scope), row, 'unknown')); notify('unknown'); break
        }
        // A late result belongs to its original scope and row revision, even after the window closes.
        settle(intent); await context.onChanged()
      }
    } catch (error) {
      if (error instanceof ReportStorageError) failStorage()
      else notify('stopped')
    } finally { active.delete(key); if (mounted.current) setBusy(false); window.dispatchEvent(new CustomEvent(reportReaderChanged)) }
  }
  return { ...state, busy: busy || active.has(key), message, change, run,
    reload: () => { const latest = read(scope); if (!latest.error) storageFailed.current = false; setState(latest) } }
}
