import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationReleaseInputSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const prefix = 'clinmesh.reservation-batch:v1:'
const changedEvent = 'clinmesh.reservation-batch.changed'
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(), patientId: z.string().min(1),
  admissionId: z.string().min(1), requestId: z.string().min(1).nullable(), action: z.enum(['create', 'release']) }).strict()
type Scope = z.infer<typeof scopeSchema>
export const reservationBatchCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inpatient.drg.reservation.create'), input: inpatientMaterialReservationCreateInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.drg.reservation.release'), input: inpatientMaterialReservationReleaseInputSchema.extend({ expectedReservationVersion: z.number().int().positive() }) }).strict(),
])
const entrySchema = z.object({ rowId: z.string().min(1), rowRevision: z.string().min(1), label: z.string().min(1), command: reservationBatchCommandSchema }).strict()
type Entry = z.infer<typeof entrySchema>
const releaseBindingSchema = z.object({ admissionId: z.string().min(1), requestId: z.string().min(1).nullable(),
  reservationId: z.string().min(1), version: z.number().int().positive() }).strict()
const itemSchema = entrySchema.extend({ idempotencyKey: z.uuid(), status: z.enum(['ready', 'unknown', 'success', 'failed']),
  releaseBinding: releaseBindingSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()
type Item = z.infer<typeof itemSchema>
type Row = { id: string; revision: string; selected: boolean }
type Value = { commonReason: string; rows: Row[] }
const valueSchema = z.object({ commonReason: z.string(), rows: z.array(z.object({ id: z.string().min(1), revision: z.string().min(1), selected: z.boolean() }).passthrough()) }).passthrough()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, value: valueSchema, items: z.array(itemSchema).max(20) }).strict()
  .refine(record => new Set(record.value.rows.map(row => row.id)).size === record.value.rows.length
    && new Set(record.items.map(item => item.idempotencyKey)).size === record.items.length
    && new Set(record.items.map(item => item.rowId)).size === record.items.length
    && record.items.filter(item => item.status === 'unknown').length <= 1)
type Record = z.infer<typeof recordSchema>

class InvalidReservationBinding extends Error {
  constructor(readonly record: Record) { super('Reservation attempt does not match its stored scope') }
}
function itemMatchesScope(scope: Scope, item: Item): boolean {
  if (item.command.input.admissionId !== scope.admissionId || item.command.operation.split('.').at(-1) !== scope.action) return false
  if (item.command.operation === 'inpatient.drg.reservation.create') return (item.command.input.requestId ?? null) === scope.requestId && item.releaseBinding === undefined
  const original = item.releaseBinding
  return original !== undefined && original.admissionId === scope.admissionId && original.requestId === scope.requestId
    && original.reservationId === item.rowId && original.reservationId === item.command.input.reservationId
    && original.version === item.command.input.expectedReservationVersion
}
function assertRecordBinding(record: Record): void {
  if (!record.items.every(item => itemMatchesScope(record.scope, item))) throw new InvalidReservationBinding(record)
}

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}
function storageKey(scope: Scope) { return `${prefix}${encodeURIComponent(signature(scope))}` }
function notify(key: string) { window.dispatchEvent(new CustomEvent(changedEvent, { detail: key })) }
function readRecord(key: string, scope: Scope): Record | null {
  const raw = sessionStorage.getItem(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Reservation scope changed')
  assertRecordBinding(record)
  return record
}
export function reservationDraftScope({ session, requestId, ...context }: { session: SessionContext; patientId: string; admissionId: string;
  requestId?: string | null; action: Scope['action'] }): Scope {
  return scopeSchema.parse({ ...context, requestId: requestId ?? null, accountId: session.user.id, actor: session.actor })
}

/** 人工输入与冻结尝试同存；原回执与重放只由共享 write-intent 处理。 */
export function useReservationBatchDraft<T extends Value>({ scope, schema, initial, session, write }: {
  scope: Scope; schema: z.ZodType<T>; initial: T; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent>;
}) {
  const key = storageKey(scope)
  const bindingValid = scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
  const read = () => {
    const empty: Record = { version: 1, scope, value: valueSchema.parse(initial), items: [] }
    try { if (!bindingValid) throw new Error('Reservation binding changed'); const record = readRecord(key, scope) ?? empty; return { key, record, value: schema.parse(record.value), failed: false, invalidBinding: false } }
    catch (error) {
      if (error instanceof InvalidReservationBinding) {
        const parsed = schema.safeParse(error.record.value)
        return { key, record: error.record, value: parsed.success ? parsed.data : initial, failed: true, invalidBinding: true }
      }
      return { key, record: empty, value: initial, failed: true, invalidBinding: false }
    }
  }
  const [stored, setStored] = useState(read), [busy, setBusy] = useState(false)
  const current = useRef(stored), readLatest = useRef(read), owner = useRef<string | null>(key), mounted = useRef(true), running = useRef(false), writer = useRef(write)
  readLatest.current = read; owner.current = bindingValid ? key : null; writer.current = write
  if (current.current.key !== key) current.current = read()
  const shown = bindingValid ? stored.key === key ? stored : current.current : read()
  useEffect(() => {
    mounted.current = true
    const refresh = () => { if (owner.current === key) { const next = readLatest.current(); current.current = next; setStored(next) } }
    const changed = (event: Event) => { if (event instanceof CustomEvent && event.detail === key) refresh() }
    refresh(); window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
  }, [key])
  const isOwner = () => mounted.current && owner.current === key && bindingValid
  const persist = (record: Record, value: T, keepCurrentOnFailure = false) => {
    if (!isOwner()) return false
    if (current.current.invalidBinding) {
      const failed = { ...current.current, value: keepCurrentOnFailure ? current.current.value : value, failed: true }; current.current = failed; setStored(failed); return false
    }
    try {
      assertRecordBinding(record)
      sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record)))
      const next = { key, record, value, failed: false, invalidBinding: false }; current.current = next; setStored(next); notify(key); return true
    } catch (error) {
      const next = keepCurrentOnFailure ? { ...current.current, failed: true } : { key, record, value, failed: true, invalidBinding: error instanceof InvalidReservationBinding }
      current.current = next; setStored(next); return false
    }
  }
  const run = async (mode: 'ready' | 'unknown', guard: () => boolean) => {
    const isCurrent = () => isOwner() && guard()
    if (!isCurrent() || running.current || current.current.failed || writer.current.mutation.isPending || writer.current.storageFailure) return
    running.current = true; setBusy(true)
    try {
      while (isCurrent()) {
        const record = readRecord(key, scope)
        if (record === null) return
        if (mode === 'ready' && record.items.some(item => item.status === 'ready'
          && !record.value.rows.some(row => row.id === item.rowId && row.revision === item.rowRevision && row.selected))) return
        const unknown = record.items.find(item => item.status === 'unknown')
        const item = mode === 'unknown' ? unknown : unknown ? undefined : record.items.find(item => item.status === 'ready')
        if (!item || writer.current.pending && writer.current.pending.idempotencyKey !== item.idempotencyKey) return
        if (!persist({ ...record, items: record.items.map(row => row.idempotencyKey === item.idempotencyKey ? { ...row, status: 'unknown' } : row) }, schema.parse(record.value), true)) return
        try {
          await writer.current.mutation.mutateAsync({ ...item.command, idempotencyKey: item.idempotencyKey, ...(mode === 'unknown' ? { recoverOriginal: true as const } : {}), isCurrent })
        } catch (error) {
          // 只有共享层确认的实际写入拒绝才可继续；回执/网络/存储失败一律停在原尝试。
          if (!(error instanceof Error) || !('commandRejected' in error) || error.commandRejected !== true) return
        }
        if (mode === 'unknown') return
      }
    } catch (error) {
      if (isOwner()) { const failed = error instanceof InvalidReservationBinding ? readLatest.current() : { ...current.current, failed: true }; current.current = failed; setStored(failed) }
    } finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  return {
    value: shown.value, failed: shown.failed, items: shown.record.items, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    save(next: T, options?: { keepCurrentOnFailure: boolean }) {
      if (!isOwner()) return false
      const parsed = schema.safeParse(next)
      if (!parsed.success) {
        const failed = { ...current.current, value: options?.keepCurrentOnFailure ? current.current.value : next, failed: true }; current.current = failed; setStored(failed); return false
      }
      return persist({ ...current.current.record, value: valueSchema.parse(parsed.data) }, parsed.data, options?.keepCurrentOnFailure)
    },
    clear() {
      if (!isOwner() || running.current || current.current.record.items.some(item => item.status === 'unknown')) return false
      try {
        sessionStorage.removeItem(key)
        const next = readLatest.current(); current.current = next; setStored(next); notify(key); return true
      } catch { const failed = { ...current.current, failed: true }; current.current = failed; setStored(failed); return false }
    },
    discardReady() {
      if (!isOwner() || running.current || current.current.record.items.some(item => item.status === 'unknown')) return false
      return persist({ ...current.current.record, items: current.current.record.items.filter(item => item.status !== 'ready') }, current.current.value, true)
    },
    prepareBatch(raw: Entry[]) {
      if (!isOwner() || running.current || current.current.failed || write.blocked || current.current.record.items.some(item => item.status === 'ready' || item.status === 'unknown')) return false
      const parsed = z.array(entrySchema).min(1).max(scope.requestId === null ? 1 : 20).safeParse(raw)
      if (!parsed.success || new Set(parsed.data.map(entry => entry.rowId)).size !== parsed.data.length) return false
      const items: Item[] = []
      for (const entry of parsed.data) {
        const row = current.current.value.rows.find(row => row.id === entry.rowId && row.revision === entry.rowRevision && row.selected)
        if (!row) return false
        const item: Item = { ...entry, idempotencyKey: crypto.randomUUID(), status: 'ready' }
        if (entry.command.operation === 'inpatient.drg.reservation.release') {
          const original = z.object({ reservation: z.object({ id: z.string(), admissionId: z.string(), requestId: z.string().nullable().optional(), version: z.number().int().positive() }).passthrough() }).passthrough().safeParse(row)
          if (!original.success) return false
          item.releaseBinding = { admissionId: original.data.reservation.admissionId, requestId: original.data.reservation.requestId ?? null,
            reservationId: original.data.reservation.id, version: original.data.reservation.version }
        }
        if (!itemMatchesScope(scope, item)) return false
        items.push(item)
      }
      return persist({ ...current.current.record, items }, current.current.value, true)
    },
    start: (isCurrent: () => boolean) => run('ready', isCurrent),
    resume: (isCurrent: () => boolean) => run('unknown', isCurrent),
  }
}

/** 共享写入层在清原意图前结算；迟到成功只消费本次原行修订。 */
export function settleReservationAttempt(raw: unknown, idempotencyKey: string, session: SessionContext, error?: { code: string; message: string }): void {
  const parsed = reservationBatchCommandSchema.safeParse(raw)
  if (!parsed.success) return
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let rawScope: unknown
    try { rawScope = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
    const candidate = scopeSchema.safeParse(rawScope)
    if (!candidate.success || candidate.data.accountId !== session.user.id || signature(candidate.data.actor) !== signature(session.actor)
      || candidate.data.admissionId !== parsed.data.input.admissionId || candidate.data.action !== parsed.data.operation.split('.').at(-1)) continue
    if (parsed.data.operation === 'inpatient.drg.reservation.create' && candidate.data.requestId !== (parsed.data.input.requestId ?? null)) continue
    const record = readRecord(key, candidate.data)
    const item = record?.items.find(item => item.idempotencyKey === idempotencyKey && signature(item.command) === signature(parsed.data))
    if (!record || !item) continue
    const next = { ...record, value: error ? record.value : { ...record.value, rows: record.value.rows.filter(row => row.id !== item.rowId || row.revision !== item.rowRevision) },
      items: record.items.map(row => row.idempotencyKey === idempotencyKey ? { ...row, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : row) }
    sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(next))); notify(key)
  }
}
export function clearReservationDrafts(): void {
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) { sessionStorage.removeItem(key); notify(key) }
}
