import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientMaterialReservationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientMaterialItemSchema, inpatientSurgeryCorrectMaterialInputSchema, inpatientSurgeryMaterialHistorySchema, inpatientSurgeryResponseSchema } from '@clinmesh/contracts/inpatient-surgery'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const prefix = 'clinmesh.correction-batch:v1:'
const changedEvent = 'clinmesh.correction-batch.changed'
const bindingSchema = z.object({ admissionId: z.string().min(1), requestId: z.string().min(1), executionId: z.string().min(1) }).strict()
const scopeSchema = bindingSchema.extend({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(), patientId: z.string().min(1) }).strict()
type Scope = z.infer<typeof scopeSchema>
export const correctionRowSchema = z.object({ id: z.string().min(1), revision: z.uuid(), binding: bindingSchema,
  original: inpatientSurgeryMaterialHistorySchema, selected: z.boolean(), mode: z.enum(['void', 'quantity', 'material']),
  material: inpatientMaterialItemSchema.nullable(), quantity: z.string(), reservation: inpatientMaterialReservationSchema.nullable(), reason: z.string(),
}).strict()
export type CorrectionRow = z.infer<typeof correctionRowSchema>
const valueSchema = z.object({ commonReason: z.string(), rows: z.array(correctionRowSchema).max(1000) }).strict()
const commandSchema = z.object({ operation: z.literal('inpatient.surgery.correct-material'), input: inpatientSurgeryCorrectMaterialInputSchema }).strict()
const itemSchema = z.object({ rowId: z.string(), rowRevision: z.uuid(), label: z.string(), command: commandSchema,
  original: inpatientSurgeryMaterialHistorySchema, originalReservationId: z.string().nullable(), idempotencyKey: z.uuid(), status: z.enum(['ready', 'unknown', 'success', 'failed']),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, value: valueSchema, items: z.array(itemSchema).max(20),
  nextRequestVersion: z.number().int().positive().nullable(), touchedReservations: z.array(z.string()), paused: z.boolean(),
}).strict().refine(record => new Set(record.value.rows.map(row => row.id)).size === record.value.rows.length
  && new Set(record.items.map(item => item.rowId)).size === record.items.length
  && new Set(record.items.map(item => item.idempotencyKey)).size === record.items.length
  && record.items.filter(item => item.status === 'unknown').length <= 1)
type Record = z.infer<typeof recordSchema>

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}
function matches(scope: Scope, context: z.infer<typeof bindingSchema>) {
  return context.admissionId === scope.admissionId && context.requestId === scope.requestId && context.executionId === scope.executionId
}
function assertBinding(record: Record): void {
  if (!record.value.rows.every(row => matches(record.scope, row.binding) && row.original.id === row.id && row.original.correction === null)
    || !record.items.every(item => matches(record.scope, item.command.input) && item.rowId === item.command.input.materialUseId
      && item.original.id === item.rowId && item.original.correction === null && item.originalReservationId === item.original.reservationId)) {
    throw new Error('Correction attempt does not match its original material use')
  }
}
function notify(key: string) { window.dispatchEvent(new CustomEvent(changedEvent, { detail: key })) }
function readRecord(key: string, scope: Scope): Record | null {
  const raw = sessionStorage.getItem(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Correction scope changed')
  assertBinding(record)
  return record
}
export function correctionDraftScope({ session, ...context }: { session: SessionContext; patientId: string; admissionId: string; requestId: string; executionId: string }): Scope {
  return scopeSchema.parse({ ...context, accountId: session.user.id, actor: session.actor })
}
export function correctionInput(row: CorrectionRow, commonReason: string, expectedRequestVersion: number) {
  const reason = row.reason.trim() || commonReason.trim()
  const material = row.material
  return inpatientSurgeryCorrectMaterialInputSchema.safeParse({ ...row.binding, materialUseId: row.id, expectedRequestVersion, note: reason,
    ...(row.mode === 'void' ? {} : { replacement: { materialId: material?.id, catalogVersion: material?.version, quantity: Number(row.quantity),
      ...(row.reservation ? { reservationId: row.reservation.id, expectedReservationVersion: row.reservation.version } : {}) } }),
  })
}

/** 更正私稿冻结原使用与逐项意图；回执及重放仍归共享 write-intent。 */
export function useCorrectionBatchDraft({ scope, session, write }: { scope: Scope; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent> }) {
  const key = `${prefix}${encodeURIComponent(signature(scope))}`
  const bindingValid = scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
  const read = () => {
    const empty: Record = { version: 1, scope, value: { commonReason: '', rows: [] }, items: [], nextRequestVersion: null, touchedReservations: [], paused: false }
    try {
      if (!bindingValid) throw new Error('Correction identity changed')
      return { key, record: readRecord(key, scope) ?? empty, failed: false }
    } catch {
      // 输入展示与发送校验分开；错误归属不能静默清空用户输入或重新发出。
      let record = empty
      try { const raw = sessionStorage.getItem(key); if (raw !== null && bindingValid) {
        const parsed = recordSchema.parse(JSON.parse(raw)); if (signature(parsed.scope) === signature(scope)) record = parsed
      } } catch { /* 原始存储保留 */ }
      return { key, record, failed: true }
    }
  }
  const [stored, setStored] = useState(read), [busy, setBusy] = useState(false)
  const current = useRef(stored), reader = useRef(read), owner = useRef<string | null>(key), mounted = useRef(true), running = useRef(false), writer = useRef(write)
  reader.current = read; owner.current = bindingValid ? key : null; writer.current = write
  if (current.current.key !== key) current.current = read()
  const shown = bindingValid ? stored.key === key ? stored : current.current : read()
  useEffect(() => {
    mounted.current = true
    const refresh = () => { if (owner.current === key) { const next = reader.current(); current.current = next; setStored(next) } }
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === key) refresh() }
    refresh(); window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
  }, [key])
  const isOwner = () => mounted.current && owner.current === key && bindingValid
  const persist = (record: Record, keepOnFailure = false) => {
    if (!isOwner()) return false
    try {
      if (current.current.failed) readRecord(key, scope)
      assertBinding(record)
      sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record)))
      const next = { key, record, failed: false }; current.current = next; setStored(next); notify(key); return true
    } catch {
      const next = { key, record: keepOnFailure ? current.current.record : record, failed: true }
      current.current = next; setStored(next); return false
    }
  }
  const run = async (recover: boolean, guard: () => boolean) => {
    const isCurrent = () => isOwner() && guard()
    if (!isCurrent() || running.current || current.current.failed || writer.current.mutation.isPending || writer.current.storageFailure) return
    running.current = true; setBusy(true)
    try {
      while (isCurrent()) {
        const record = readRecord(key, scope)
        if (record === null || !recover && record.paused) return
        const unknown = record.items.find(item => item.status === 'unknown')
        const item = recover ? unknown : unknown ? undefined : record.items.find(item => item.status === 'ready')
        if (!item || writer.current.pending && writer.current.pending.idempotencyKey !== item.idempotencyKey) return
        if (!recover) {
          const row = record.value.rows.find(row => row.id === item.rowId && row.revision === item.rowRevision && row.selected)
          if (!row) { persist({ ...record, paused: true }, true); return }
          const dependencies = [item.originalReservationId, item.command.input.replacement?.reservationId]
          if (dependencies.some(id => id !== null && id !== undefined && record.touchedReservations.includes(id))) {
            persist({ ...record, paused: true }, true); return
          }
        }
        const frozen = recover ? item : { ...item, command: { ...item.command, input: { ...item.command.input,
          expectedRequestVersion: record.nextRequestVersion ?? item.command.input.expectedRequestVersion } } }
        if (!persist({ ...record, items: record.items.map(row => row.idempotencyKey === item.idempotencyKey ? { ...frozen, status: 'unknown' } : row) }, true)) return
        try {
          await writer.current.mutation.mutateAsync({ ...frozen.command, idempotencyKey: frozen.idempotencyKey, ...(recover ? { recoverOriginal: true as const } : {}), isCurrent })
        } catch (error) {
          if (!(error instanceof Error) || !('commandRejected' in error) || error.commandRejected !== true) return
        }
        if (recover) return
      }
    } catch { if (isOwner()) { const failed = reader.current(); current.current = { ...failed, failed: true }; setStored(current.current) } }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  return {
    value: shown.record.value, items: shown.record.items, paused: shown.record.paused, failed: shown.failed, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    retryStorage() { return persist(current.current.record, true) },
    save(value: z.infer<typeof valueSchema>, keepOnFailure = false) {
      const parsed = valueSchema.safeParse(value)
      if (!parsed.success || !isOwner()) return false
      return persist({ ...current.current.record, value: parsed.data }, keepOnFailure)
    },
    clear() {
      if (!isOwner() || running.current || current.current.record.items.some(item => item.status === 'unknown')) return false
      try {
        sessionStorage.removeItem(key)
        const next = reader.current(); current.current = next; setStored(next); notify(key); return true
      } catch { current.current = { ...current.current, failed: true }; setStored(current.current); return false }
    },
    discardReady() {
      if (!isOwner() || running.current || current.current.record.items.some(item => item.status === 'unknown')) return false
      return persist({ ...current.current.record, items: current.current.record.items.filter(item => item.status !== 'ready'), paused: false, nextRequestVersion: null, touchedReservations: [] }, true)
    },
    prepareBatch(expectedRequestVersion: number) {
      const record = current.current.record, rows = record.value.rows.filter(row => row.selected)
      if (!isOwner() || running.current || current.current.failed || write.blocked || record.items.some(item => ['ready', 'unknown'].includes(item.status))
        || rows.length === 0 || rows.length > 20) return false
      const items: Record['items'] = []
      for (const row of rows) {
        const input = correctionInput(row, record.value.commonReason, expectedRequestVersion)
        if (!input.success) return false
        items.push({ rowId: row.id, rowRevision: row.revision, label: `${row.original.item.display} × ${row.original.quantity}`, original: row.original, originalReservationId: row.original.reservationId,
          command: { operation: 'inpatient.surgery.correct-material', input: input.data }, idempotencyKey: crypto.randomUUID(), status: 'ready' })
      }
      return persist({ ...record, items, paused: false, nextRequestVersion: null, touchedReservations: [] }, true)
    },
    start: (guard: () => boolean) => run(false, guard), resume: (guard: () => boolean) => run(true, guard),
  }
}

/** 原回执结算先于清除意图；只消费原行修订，并由成功响应续接本计划版本。 */
export function settleCorrectionAttempt(raw: unknown, idempotencyKey: string, session: SessionContext, response?: unknown, error?: { code: string; message: string }): void {
  const command = commandSchema.safeParse(raw)
  if (!command.success) return
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let scope: Scope
    try { scope = scopeSchema.parse(JSON.parse(decodeURIComponent(key.slice(prefix.length)))) } catch { continue }
    if (scope.accountId !== session.user.id || signature(scope.actor) !== signature(session.actor) || !matches(scope, command.data.input)) continue
    const record = readRecord(key, scope)
    const item = record?.items.find(item => item.idempotencyKey === idempotencyKey && signature(item.command) === signature(command.data))
    if (!record || !item) continue
    const output = error ? null : inpatientSurgeryResponseSchema.parse(response)
    const request = output?.data.requests.find(request => request.id === scope.requestId && request.admissionId === scope.admissionId)
    if (output && (output.data.admissionId !== scope.admissionId || !request)) throw new Error('Correction response does not match original plan')
    const touched = [item.originalReservationId, item.command.input.replacement?.reservationId].filter((id): id is string => id !== null && id !== undefined)
    const next: Record = { ...record,
      value: error ? record.value : { ...record.value, rows: record.value.rows.filter(row => row.id !== item.rowId || row.revision !== item.rowRevision) },
      items: record.items.map(row => row.idempotencyKey === idempotencyKey ? { ...row, status: error ? 'failed' : 'success', ...(error ? { error } : {}) } : row),
      nextRequestVersion: request?.version ?? record.nextRequestVersion,
      touchedReservations: error ? record.touchedReservations : [...new Set([...record.touchedReservations, ...touched])],
      paused: record.paused || !error && record.items.some(row => row.status === 'ready' && row.idempotencyKey !== idempotencyKey
        && [row.originalReservationId, row.command.input.replacement?.reservationId].some(id => id !== null && id !== undefined && touched.includes(id))),
    }
    assertBinding(next); sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(next))); notify(key)
  }
}
export function clearCorrectionDrafts(): void {
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) { sessionStorage.removeItem(key); notify(key) }
}
