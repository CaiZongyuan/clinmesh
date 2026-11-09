import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientFullClinicalResponseSchema, inpatientOrderActionInputSchema, inpatientOrderReasonInputSchema, inpatientOrderSchema, type InpatientOrder } from '@clinmesh/contracts/inpatient-clinical'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

// 沿用新医嘱校对的缓存键，action 在完整 scope 中隔离三个原医嘱动作。
const prefix = 'clinmesh.verification-batch:v1:'
const changedEvent = 'clinmesh.verification-batch.changed'
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  patientId: z.string().min(1), admissionId: z.string().min(1), action: z.enum(['verify', 'request-stop', 'verify-stop']) }).strict()
type Scope = z.infer<typeof scopeSchema>
const rowSchema = z.object({ id: z.string().min(1), revision: z.uuid(), selected: z.boolean(), order: inpatientOrderSchema, reasonOverride: z.string().max(2000).optional() }).strict()
type Row = z.infer<typeof rowSchema>
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inpatient.order.verify'), input: inpatientOrderActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.order.request-stop'), input: inpatientOrderReasonInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.order.verify-stop'), input: inpatientOrderActionInputSchema }).strict(),
])
const itemSchema = z.object({ row: rowSchema, command: commandSchema, idempotencyKey: z.uuid(),
  status: z.enum(['ready', 'unknown', 'success', 'failed']), error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, commonReason: z.string().max(2000).default(''), reviewRequired: z.boolean(), rows: z.array(rowSchema).max(20),
  items: z.array(itemSchema).max(20) }).strict().refine(record =>
  new Set(record.rows.map(row => row.id)).size === record.rows.length
  && new Set(record.items.map(item => item.row.id)).size === record.items.length
  && new Set(record.items.map(item => item.idempotencyKey)).size === record.items.length
  && record.items.filter(item => item.status === 'unknown').length <= 1)
type BatchRecord = z.infer<typeof recordSchema>

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}
function storageKey(scope: Scope) { return `${prefix}${encodeURIComponent(signature(scope))}` }
function notify(key: string) { window.dispatchEvent(new CustomEvent(changedEvent, { detail: key })) }
export function orderBatchEligible(order: InpatientOrder, action: Scope['action']): boolean {
  return action === 'verify' ? order.state === 'signed' : action === 'request-stop' ? order.state === 'signed' || order.state === 'verified' : order.state === 'stop-requested'
}
function assertBinding(record: BatchRecord) {
  const rowMatches = (row: Row) => row.id === row.order.id && row.order.admissionId === record.scope.admissionId && orderBatchEligible(row.order, record.scope.action)
  if (!record.rows.every(rowMatches) || !record.items.every(item => rowMatches(item.row)
    && item.command.input.admissionId === record.scope.admissionId && item.command.input.orderId === item.row.id
    && item.command.operation === `inpatient.order.${record.scope.action}`
    && item.command.input.expectedOrderVersion === item.row.order.version
    && (item.command.operation !== 'inpatient.order.request-stop' || item.command.input.reason === item.row.reasonOverride?.trim()))) throw new Error('Order batch binding changed')
}
function readRecord(key: string, scope: Scope): BatchRecord | null {
  const raw = sessionStorage.getItem(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Verification scope changed')
  assertBinding(record)
  return record
}
export function inpatientOrderBatchScope(session: SessionContext, patientId: string, admissionId: string, action: Scope['action'] = 'verify'): Scope {
  return scopeSchema.parse({ accountId: session.user.id, actor: session.actor, patientId, admissionId, action })
}

/** 只拥有人工选择和原尝试；临床事实始终由 Query 与单项 Command 拥有。 */
export function useInpatientOrderBatch({ scope, session, write }: { scope: Scope; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent> }) {
  const key = storageKey(scope)
  const bindingValid = scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
    && session.actor.roleCode === (scope.action === 'request-stop' ? 'inpatient-doctor' : 'ward-nurse')
  const read = () => {
    const empty: BatchRecord = { version: 1, scope, commonReason: '', reviewRequired: false, rows: [], items: [] }
    try {
      if (!bindingValid) throw new Error('Verification session changed')
      return { key, record: readRecord(key, scope) ?? empty, failed: false }
    } catch {
      // 结构仍合法时保留原输入供展示，错绑的命令始终禁止发送。
      let record = empty
      try {
        const parsed = recordSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'))
        if (parsed.success && signature(parsed.data.scope) === signature(scope)
          && parsed.data.rows.every(row => row.id === row.order.id && row.order.admissionId === scope.admissionId)) record = parsed.data
      } catch { /* 不覆写损坏的缓存。 */ }
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
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === key) refresh() }
    refresh(); window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
  }, [key])
  const isOwner = () => mounted.current && owner.current === key && bindingValid
  const persist = (record: BatchRecord, keepOnFailure = false) => {
    if (!isOwner()) return false
    try {
      assertBinding(record)
      sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record)))
      const next = { key, record, failed: false }; latest.current = next; setStored(next); notify(key); return true
    } catch {
      const next = { key, record: keepOnFailure ? latest.current.record : record, failed: true }
      latest.current = next; setStored(next); return false
    }
  }
  const run = async (recover: boolean, guard: () => boolean) => {
    const isCurrent = () => isOwner() && guard()
    if (!isCurrent() || running.current || latest.current.failed || writer.current.mutation.isPending || writer.current.storageFailure) return
    running.current = true; setBusy(true)
    try {
      while (isCurrent()) {
        const record = readRecord(key, scope)
        if (!record) return
        if (!recover && record.reviewRequired) return
        const unknown = record.items.find(item => item.status === 'unknown')
        const item = recover ? unknown : unknown ? undefined : record.items.find(item => item.status === 'ready')
        if (!item || writer.current.pending && writer.current.pending.idempotencyKey !== item.idempotencyKey) return
        if (!recover && !record.rows.some(row => row.id === item.row.id && row.revision === item.row.revision && row.selected)) return
        if (!persist({ ...record, items: record.items.map(entry => entry.idempotencyKey === item.idempotencyKey ? { ...entry, status: 'unknown' } : entry) }, true)) return
        try {
          await writer.current.mutation.mutateAsync({ ...item.command, idempotencyKey: item.idempotencyKey,
            ...(recover ? { recoverOriginal: true as const } : {}), isCurrent })
        } catch (error) {
          if (!(error instanceof Error) || !('commandRejected' in error) || error.commandRejected !== true) return
        }
        // 恢复只结算原尝试；其余未发送项须由用户重新审阅。
        if (recover) return
      }
    } catch { if (isOwner()) { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next) } }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const changeRows = (rows: Row[], commonReason = latest.current.record.commonReason) => {
    if (!isOwner() || running.current || latest.current.failed || latest.current.record.items.some(item => item.status === 'unknown')) return false
    return persist({ ...latest.current.record, rows, commonReason, items: latest.current.record.items.filter(item => item.status !== 'ready') })
  }
  return {
    rows: shown.record.rows, commonReason: shown.record.commonReason, items: shown.record.items, failed: shown.failed, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    select(orders: InpatientOrder[], selected: boolean) {
      const rows = [...latest.current.record.rows]
      for (const order of orders) {
        if (!orderBatchEligible(order, scope.action) || order.admissionId !== scope.admissionId) return false
        const index = rows.findIndex(row => row.id === order.id)
        if (index < 0) { if (selected) rows.push({ id: order.id, revision: crypto.randomUUID(), selected, order }) }
        else rows[index] = { ...rows[index]!, revision: crypto.randomUUID(), selected, order }
      }
      if (rows.length > 20) return false
      return changeRows(rows)
    },
    setCommonReason: (reason: string) => changeRows(latest.current.record.rows.map(row => row.reasonOverride === undefined ? { ...row, revision: crypto.randomUUID() } : row), reason),
    setReasonOverride: (id: string, reason: string | undefined) => changeRows(latest.current.record.rows.map(row => {
      if (row.id !== id) return row
      const { reasonOverride: _previous, ...rest } = row
      return { ...rest, revision: crypto.randomUUID(), ...(reason === undefined ? {} : { reasonOverride: reason }) }
    })),
    deselectAll: () => changeRows(latest.current.record.rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() }))),
    remove: (id: string) => changeRows(latest.current.record.rows.filter(row => row.id !== id)),
    clear() {
      if (!isOwner() || running.current || latest.current.record.items.some(item => item.status === 'unknown')) return false
      try {
        sessionStorage.removeItem(key); const next = readLatest.current(); latest.current = next; setStored(next); notify(key); return true
      } catch { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next); return false }
    },
    prepare(orders: InpatientOrder[]) {
      if (!isOwner() || running.current || latest.current.failed || write.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
      const rows = latest.current.record.rows.filter(row => row.selected)
      if (!rows.length || rows.length > 20 || rows.some(row => !orders.some(order => signature(order) === signature(row.order)))
        || scope.action === 'request-stop' && rows.some(row => !(row.reasonOverride ?? latest.current.record.commonReason).trim())) return false
      const items = rows.map(row => ({ row: scope.action === 'request-stop' ? { ...row, reasonOverride: (row.reasonOverride ?? latest.current.record.commonReason).trim() } : row, command: commandSchema.parse({ operation: `inpatient.order.${scope.action}`, input: {
        admissionId: scope.admissionId, orderId: row.id, expectedOrderVersion: row.order.version, ...(scope.action === 'request-stop' ? { reason: row.reasonOverride ?? latest.current.record.commonReason } : {}) } }), idempotencyKey: crypto.randomUUID(), status: 'ready' as const }))
      return persist({ ...latest.current.record, items, reviewRequired: false }, true)
    },
    start: (guard: () => boolean) => run(false, guard),
    recover: (guard: () => boolean) => run(true, guard),
  }
}

/** 清原 write-intent 前结算；晚到成功仅移出当时的行修订。 */
export function settleInpatientOrderAttempt(raw: unknown, idempotencyKey: string, session: SessionContext, error?: { code: string; message: string }, recovered = false, response?: unknown): void {
  const parsed = commandSchema.safeParse(raw)
  if (!parsed.success) return
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let rawScope: unknown
    try { rawScope = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
    const candidate = scopeSchema.safeParse(rawScope)
    if (!candidate.success || candidate.data.accountId !== session.user.id || signature(candidate.data.actor) !== signature(session.actor)
      || candidate.data.admissionId !== parsed.data.input.admissionId) continue
    const record = readRecord(key, candidate.data)
    const item = record?.items.find(item => item.idempotencyKey === idempotencyKey && signature(item.command) === signature(parsed.data))
    if (!record || !item) continue
    if (!error) {
      const result = inpatientFullClinicalResponseSchema.parse(response).data
      const order = result.orders.find(order => order.id === item.row.id)
      if (result.admissionId !== candidate.data.admissionId || order?.admissionId !== candidate.data.admissionId
        || order.state !== (candidate.data.action === 'verify' ? 'verified' : candidate.data.action === 'request-stop' ? 'stop-requested' : 'stopped') || order.version !== item.row.order.version + 1
        || parsed.data.operation === 'inpatient.order.request-stop' && order.stopReason !== parsed.data.input.reason
        || parsed.data.operation === 'inpatient.order.verify-stop' && order.stopReason !== item.row.order.stopReason) throw new Error('Order response does not match its original attempt')
    }
    const next = { ...record, reviewRequired: record.reviewRequired || recovered,
      rows: error ? record.rows : record.rows.filter(row => row.id !== item.row.id || row.revision !== item.row.revision),
      items: record.items.map(entry => entry.idempotencyKey === idempotencyKey ? { ...entry, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : entry) }
    sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(next))); notify(key)
  }
}

export function clearInpatientOrderDrafts(): void {
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) { sessionStorage.removeItem(key); notify(key) }
}
