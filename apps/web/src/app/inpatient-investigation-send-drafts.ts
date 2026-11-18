import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientInvestigationActionInputSchema, inpatientInvestigationResponseSchema, type inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { createDraftDiscard, hasUnknownDraftAttempt } from './draft-discard.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const prefix = 'clinmesh.investigation-send:v1:'
const changedEvent = 'clinmesh.investigation-send.changed'
const discard = createDraftDiscard(prefix, () => notify('*'), (key, raw) => {
  const record = recordSchema.parse(JSON.parse(raw))
  if (keyOf(record.scope) !== key) throw new Error('Draft scope changed')
  assertBinding(record)
  const unknown = record.items.find(item => item.status === 'unknown')
  return unknown ? JSON.stringify({ ...record, reviewRequired: true, rows: [unknown.row], items: [unknown] }) : null
})
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  patientId: z.string().min(1), admissionId: z.string().min(1), action: z.literal('send') }).strict()
type Scope = z.infer<typeof scopeSchema>
const snapshotSchema = z.object({ id: z.string().min(1), kind: z.enum(['laboratory', 'imaging', 'examination']), display: z.string().min(1),
  specimen: z.string().nullable(), indication: z.string(), input: inpatientInvestigationActionInputSchema }).strict()
export type InvestigationSendSnapshot = z.infer<typeof snapshotSchema>
export type InvestigationSendEntry = { snapshot: InvestigationSendSnapshot; status: string; sent: boolean; unavailable: 'sent' | 'state' | 'versions' | null }
const rowSchema = z.object({ revision: z.uuid(), selected: z.boolean(), snapshot: snapshotSchema }).strict()
const commandSchema = z.object({ operation: z.literal('inpatient.investigation.send'), input: inpatientInvestigationActionInputSchema }).strict()
const itemSchema = z.object({ row: rowSchema, command: commandSchema, idempotencyKey: z.uuid(),
  status: z.enum(['ready', 'unknown', 'success', 'failed']), error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, reviewRequired: z.boolean(), rows: z.array(rowSchema).max(20), items: z.array(itemSchema).max(20) }).strict().refine(record =>
  new Set(record.rows.map(row => row.snapshot.id)).size === record.rows.length
  && new Set(record.items.map(item => item.row.snapshot.id)).size === record.items.length
  && new Set(record.items.map(item => item.idempotencyKey)).size === record.items.length
  && record.items.filter(item => item.status === 'unknown').length <= 1)
type Row = z.infer<typeof rowSchema>
type Record = z.infer<typeof recordSchema>
type Facts = z.infer<typeof inpatientInvestigationsSchema>

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}
export const sameSendSnapshot = (left: InvestigationSendSnapshot, right: InvestigationSendSnapshot) => signature(left) === signature(right)
export function investigationSendEntries(facts: Facts): InvestigationSendEntry[] {
  const sent = new Set(facts.sent.map(item => item.requestId))
  return [...facts.laboratoryRequests.map(request => ({ kind: 'laboratory' as const, request })),
    ...facts.examinationRequests.map(request => ({ kind: 'examination' as const, request })),
    ...facts.imagingRequests.map(request => ({ kind: 'imaging' as const, request }))].map(({ kind, request }) => {
    const snapshot: InvestigationSendSnapshot = { id: request.id, kind,
      display: 'service' in request ? request.service.name : request.laboratoryService?.nameZh ?? request.referenceConcept?.display ?? request.catalogItemId,
      specimen: 'service' in request ? null : request.laboratoryService?.specimen.display ?? null,
      indication: 'service' in request ? request.indication : request.indicationCode,
      input: { admissionId: facts.admissionId, requestId: request.id, expectedRequestVersion: request.version,
        serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion ?? '0' } }
    return { snapshot, status: request.status, sent: sent.has(request.id),
      unavailable: sent.has(request.id) ? 'sent' : request.status !== 'issued' ? 'state'
        : !/^[1-9]\d*$/.test(snapshot.input.taskVersion) || !/^[1-9]\d*$/.test(snapshot.input.serviceRequestVersion) ? 'versions' : null }
  })
}
const keyOf = (scope: Scope) => `${prefix}${encodeURIComponent(signature(scope))}`
const notify = (key: string) => window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
export function investigationSendScope(session: SessionContext, patientId: string, admissionId: string): Scope {
  return scopeSchema.parse({ accountId: session.user.id, actor: session.actor, patientId, admissionId, action: 'send' })
}
function assertBinding(record: Record) {
  const matches = (row: Row) => row.snapshot.id === row.snapshot.input.requestId && row.snapshot.input.admissionId === record.scope.admissionId
  if (!record.rows.every(matches) || !record.items.every(item => matches(item.row) && item.row.selected
    && signature(item.command.input) === signature(item.row.snapshot.input))) throw new Error('Investigation send binding changed')
}
function readRecord(key: string, scope: Scope): Record | null {
  const raw = discard.read(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Investigation send scope changed')
  assertBinding(record)
  return record
}

/** 只保存人工选择、核对快照及原尝试，服务端事实仍由 Query 拥有。 */
export function useInvestigationSendDrafts({ scope, session, write }: { scope: Scope; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent> }) {
  const key = keyOf(scope)
  const bindingValid = session.actor.roleCode === 'ward-nurse' && scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
  const read = () => {
    const empty: Record = { version: 1, scope, reviewRequired: false, rows: [], items: [] }
    try {
      if (!bindingValid) throw new Error('Investigation send session changed')
      return { key, record: readRecord(key, scope) ?? empty, failed: false }
    } catch {
      let record = empty
      try {
        const candidate = recordSchema.safeParse(JSON.parse(discard.read(key) ?? 'null'))
        if (candidate.success && signature(candidate.data.scope) === signature(scope)) record = candidate.data
      } catch { /* 保留损坏的缓存，不覆盖原意图。 */ }
      return { key, record, failed: true }
    }
  }
  const [stored, setStored] = useState(read), [busy, setBusy] = useState(false)
  const latest = useRef(stored), readLatest = useRef(read), owner = useRef<string | null>(key), mounted = useRef(true), running = useRef(false), writer = useRef(write)
  readLatest.current = read; owner.current = bindingValid ? key : null; writer.current = write
  if (latest.current.key !== key) latest.current = read()
  const shown = stored.key === key ? stored : latest.current
  useEffect(() => {
    mounted.current = true
    const refresh = () => { if (owner.current === key) { const next = readLatest.current(); latest.current = next; setStored(next) } }
    const changed = (event: Event) => { if (event instanceof CustomEvent && (event.detail === key || event.detail === '*')) refresh() }
    refresh(); window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
  }, [key])
  const isOwner = () => mounted.current && owner.current === key && bindingValid
  const persist = (record: Record) => {
    if (!isOwner()) return false
    try {
      assertBinding(record)
      discard.ensureCleared(); sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record)))
      const next = { key, record, failed: false }; latest.current = next; setStored(next); notify(key); return true
    } catch {
      const next = { key, record: latest.current.record, failed: true }; latest.current = next; setStored(next); return false
    }
  }
  const changeRows = (rows: Row[]) => {
    if (!isOwner() || running.current || latest.current.failed || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
    return persist({ ...latest.current.record, rows, items: latest.current.record.items.filter(item => item.status !== 'ready') })
  }
  const run = async (recover: boolean, guard: () => boolean) => {
    const isCurrent = () => isOwner() && guard()
    if (!isCurrent() || running.current || latest.current.failed || writer.current.mutation.isPending || writer.current.storageFailure) return
    running.current = true; setBusy(true)
    try {
      while (isCurrent()) {
        const record = readRecord(key, scope)
        if (!record || !recover && record.reviewRequired) return
        const unknown = record.items.find(item => item.status === 'unknown')
        const item = recover ? unknown : unknown ? undefined : record.items.find(item => item.status === 'ready')
        if (!item || writer.current.pending && writer.current.pending.idempotencyKey !== item.idempotencyKey) return
        if (!recover && !record.rows.some(row => row.snapshot.id === item.row.snapshot.id && row.revision === item.row.revision && row.selected)) return
        if (!persist({ ...record, items: record.items.map(entry => entry.idempotencyKey === item.idempotencyKey ? { ...entry, status: 'unknown' } : entry) })) return
        try {
          await writer.current.mutation.mutateAsync({ ...item.command, idempotencyKey: item.idempotencyKey,
            ...(recover ? { recoverOriginal: true as const } : {}), isCurrent })
        } catch (error) {
          if (!(error instanceof Error) || !('commandRejected' in error) || error.commandRejected !== true) return
        }
        if (recover) return
      }
    } catch { if (isOwner()) { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next) } }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  return {
    rows: shown.record.rows, items: shown.record.items, failed: shown.failed, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    select(entries: InvestigationSendEntry[], selected: boolean) {
      const rows = [...latest.current.record.rows]
      for (const entry of entries) {
        if (entry.unavailable !== null || entry.snapshot.input.admissionId !== scope.admissionId) return false
        const index = rows.findIndex(row => row.snapshot.id === entry.snapshot.id)
        const row = { revision: crypto.randomUUID(), selected, snapshot: entry.snapshot }
        if (index < 0) { if (selected) rows.push(row) } else rows[index] = row
      }
      if (rows.length > 20) return false
      return changeRows(rows)
    },
    deselectAll: () => changeRows(latest.current.record.rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() }))),
    remove: (id: string) => changeRows(latest.current.record.rows.filter(row => row.snapshot.id !== id)),
    clear() {
      if (!isOwner() || running.current || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
      try { if (hasUnknownDraftAttempt(key)) return false; sessionStorage.removeItem(key); discard.ensureCleared(); const next = readLatest.current(); latest.current = next; setStored(next); notify(key); return true }
      catch { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next); return false }
    },
    prepare(entries: InvestigationSendEntry[]) {
      if (!isOwner() || running.current || latest.current.failed || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
      const rows = latest.current.record.rows.filter(row => row.selected)
      if (!rows.length || rows.length > 20 || rows.some(row => !entries.some(entry => entry.unavailable === null && sameSendSnapshot(entry.snapshot, row.snapshot)))) return false
      const items = rows.map(row => ({ row, command: commandSchema.parse({ operation: 'inpatient.investigation.send', input: row.snapshot.input }),
        idempotencyKey: crypto.randomUUID(), status: 'ready' as const }))
      return persist({ ...latest.current.record, items, reviewRequired: false })
    },
    start: (guard: () => boolean) => run(false, guard),
    recover: (guard: () => boolean) => run(true, guard),
  }
}

/** 在原 write-intent 清除之前结算；晚到成功只消费原行修订。 */
export function settleInvestigationSendAttempt(raw: unknown, idempotencyKey: string, session: SessionContext, error?: { code: string; message: string }, recovered = false, response?: unknown): void {
  const command = commandSchema.safeParse(raw)
  if (!command.success) return
  discard.ensureCleared()
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let decoded: unknown
    try { decoded = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
    const scope = scopeSchema.safeParse(decoded)
    if (!scope.success || scope.data.accountId !== session.user.id || signature(scope.data.actor) !== signature(session.actor)
      || scope.data.admissionId !== command.data.input.admissionId) continue
    const record = readRecord(key, scope.data)
    const item = record?.items.find(item => item.idempotencyKey === idempotencyKey && signature(item.command) === signature(command.data))
    if (!record || !item) continue
    if (!error) {
      const result = inpatientInvestigationResponseSchema.parse(response).data
      const request = [...result.laboratoryRequests, ...result.imagingRequests, ...result.examinationRequests].find(request => request.id === item.row.snapshot.id)
      if (result.admissionId !== scope.data.admissionId || !request || !result.sent.some(sent => sent.requestId === item.row.snapshot.id)) {
        throw new Error('Investigation send response does not match its original request')
      }
    }
    const next = { ...record, reviewRequired: record.reviewRequired || recovered,
      rows: error ? record.rows : record.rows.filter(row => row.snapshot.id !== item.row.snapshot.id || row.revision !== item.row.revision),
      items: record.items.map(entry => entry.idempotencyKey === idempotencyKey ? { ...entry, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : entry) }
    discard.ensureCleared(); sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(next))); notify(key)
  }
}
export function clearInvestigationSendDrafts(): void {
  discard.clear()
}
