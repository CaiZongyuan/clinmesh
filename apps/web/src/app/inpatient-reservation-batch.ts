import { commandResponseSchema, sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientMaterialReservationCreateInputSchema, inpatientMaterialReservationListSchema, inpatientMaterialReservationReleaseInputSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { createDraftDiscard, hasUnknownDraftAttempt } from './draft-discard.ts'

const prefix = 'clinmesh.reservation-batch:v1:'
const changedEvent = 'clinmesh.reservation-batch.changed'
const discard = createDraftDiscard(prefix, () => notify('*'))
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
  error: z.object({ code: z.string(), message: z.string(), status: z.number().int().optional(), reason: z.string().optional() }).strict().optional() }).strict()
type Item = z.infer<typeof itemSchema>
type ReservationFailure = NonNullable<Item['error']>
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
  const raw = discard.read(key)
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
    try { if (!bindingValid) throw new Error('Reservation binding changed'); const record = readRecord(key, scope) ?? empty; return { key, record, value: schema.parse(record.value), failed: false, readFailed: false } }
    catch (error) {
      if (error instanceof InvalidReservationBinding) {
        const parsed = schema.safeParse(error.record.value)
        return { key, record: error.record, value: parsed.success ? parsed.data : initial, failed: true, readFailed: true }
      }
      return { key, record: empty, value: initial, failed: true, readFailed: true }
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
    const changed = (event: Event) => { if (event instanceof CustomEvent && (event.detail === key || event.detail === '*')) refresh() }
    refresh(); window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
  }, [key])
  const isOwner = () => mounted.current && owner.current === key && bindingValid
  const persist = (record: Record, value: T, keepCurrentOnFailure = false) => {
    if (!isOwner()) return false
    if (current.current.readFailed) return false
    try {
      discard.ensureCleared()
      assertRecordBinding(record)
      sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record)))
      const next = { key, record, value, failed: false, readFailed: false }; current.current = next; setStored(next); notify(key); return true
    } catch (error) {
      const next = keepCurrentOnFailure ? { ...current.current, failed: true } : { key, record, value, failed: true, readFailed: error instanceof InvalidReservationBinding }
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
    value: shown.value, failed: shown.failed, readFailed: shown.readFailed, items: shown.record.items, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    retryRead() {
      if (!isOwner() || running.current) return
      const next = readLatest.current(); current.current = next; setStored(next)
    },
    save(next: T, options?: { keepCurrentOnFailure: boolean }) {
      if (!isOwner() || current.current.readFailed) return false
      const parsed = schema.safeParse(next)
      if (!parsed.success) {
        const failed = { ...current.current, value: options?.keepCurrentOnFailure ? current.current.value : next, failed: true }; current.current = failed; setStored(failed); return false
      }
      return persist({ ...current.current.record, value: valueSchema.parse(parsed.data) }, parsed.data, options?.keepCurrentOnFailure)
    },
    clear() {
      if (!isOwner() || running.current || write.blocked || current.current.record.items.some(item => item.status === 'unknown')) return false
      try {
        discard.ensureCleared()
        if (hasUnknownDraftAttempt(key)) return false
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

export class ReservationDraftUnreadable extends Error {}

const reservationResponseSchema = commandResponseSchema(inpatientMaterialReservationListSchema)
type ReservationCommand = z.infer<typeof reservationBatchCommandSchema>
function provenReservationPlan(command: ReservationCommand, response: unknown): { requestId: string | null } | undefined {
  const result = reservationResponseSchema.safeParse(response)
  if (!result.success || result.data.data.admissionId !== command.input.admissionId) return
  const { data, effects } = result.data
  if (command.operation === 'inpatient.drg.reservation.release') {
    const { admissionId, reservationId, expectedReservationVersion, reason } = command.input
    const row = data.reservations.find(item => item.id === reservationId)
    if (row?.admissionId === admissionId && row.status === 'released' && row.releaseReason === reason
      && row.version === expectedReservationVersion + 1 && effects.some(effect => effect.kind === 'updated'
        && effect.reference === `InpatientMaterialReservation/${row.id}` && effect.versionId === String(row.version))) return { requestId: row.requestId ?? null }
    return
  }
  const input = command.input
  const created = data.reservations.find(row => row.admissionId === input.admissionId
    && row.requestId === input.requestId && row.materialId === input.materialId
    && row.catalogVersion === input.catalogVersion && row.quantity === input.quantity
    && row.reason === input.reason && row.status === 'reserved' && row.version === 1
    && effects.some(effect => effect.kind === 'created' && effect.reference === `InpatientMaterialReservation/${row.id}` && effect.versionId === '1'))
  if (created) return { requestId: created.requestId ?? null }
}

/** 共享写入层在清原意图前结算；迟到成功只消费本次原行修订。 */
export function settleReservationAttempt(raw: unknown, idempotencyKey: string, session: SessionContext, outcome:
  { response: unknown; discardUnread: boolean } | { error: ReservationFailure }): void {
  const parsed = reservationBatchCommandSchema.safeParse(raw)
  if (!parsed.success) return
  discard.ensureCleared()
  const commandSignature = signature(parsed.data)
  const error = 'error' in outcome ? outcome.error : undefined
  const unreadable: Array<{ key: string; scope: Scope; cause: unknown }> = []
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let rawScope: unknown
    try { rawScope = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
    const candidate = scopeSchema.safeParse(rawScope)
    if (!candidate.success || candidate.data.accountId !== session.user.id || signature(candidate.data.actor) !== signature(session.actor)
      || candidate.data.admissionId !== parsed.data.input.admissionId || candidate.data.action !== parsed.data.operation.split('.').at(-1)) continue
    if (parsed.data.operation === 'inpatient.drg.reservation.create' && candidate.data.requestId !== (parsed.data.input.requestId ?? null)) continue
    let record: Record | null
    try { record = readRecord(key, candidate.data) } catch (cause) {
      // 释放 Command 不携带手术计划；先找同键同命令，不能让其他计划的坏记录挡住原操作。
      unreadable.push({ key, scope: candidate.data, cause })
      continue
    }
    const item = record?.items.find(item => item.idempotencyKey === idempotencyKey && signature(item.command) === commandSignature)
    if (!record || !item) continue
    const next = { ...record, value: error ? record.value : { ...record.value, rows: record.value.rows.filter(row => row.id !== item.rowId || row.revision !== item.rowRevision) },
      items: record.items.map(row => row.idempotencyKey === idempotencyKey ? { ...row, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : row) }
    sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(next))); notify(key)
    return
  }
  if (!unreadable.length) return
  // 释放命令没有计划；只允许经成功结果证明的计划进入明确丢弃。
  const proven = 'response' in outcome ? provenReservationPlan(parsed.data, outcome.response) : undefined
  if (proven === undefined) throw new Error('A possible reservation draft could not be read', { cause: unreadable[0]?.cause })
  const matching = unreadable.filter(candidate => candidate.scope.requestId === proven.requestId)
  if (matching.length === 0) return
  if (matching.length !== 1) throw new Error('Original reservation draft scope is ambiguous')
  const original = matching[0]!
  if (!('discardUnread' in outcome && outcome.discardUnread)) throw new ReservationDraftUnreadable('The original reservation draft is unreadable', { cause: original.cause })
  sessionStorage.removeItem(original.key); notify(original.key)
}
export function clearReservationDrafts(): void {
  discard.clear()
}
