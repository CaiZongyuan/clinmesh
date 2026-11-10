import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientDispenseInputSchema, inpatientPharmacyResponseSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { createDraftDiscard } from './draft-discard.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const prefix = 'clinmesh.dispense-drafts:v1:'
const changedEvent = 'clinmesh.dispense-drafts.changed'
const discard = createDraftDiscard(prefix, () => notify('*'), (key, raw) => {
  const record = recordSchema.parse(JSON.parse(raw))
  if (keyOf(record.scope) !== key) throw new Error('Dispense scope changed')
  assertBinding(record)
  const unknown = record.items.find(item => item.status === 'unknown')
  if (!unknown) return null
  return JSON.stringify({ ...record, reviewRequired: true, rows: [unknown.row], items: record.items.filter(item => item === unknown
    || item.status === 'success' && item.row.snapshot.lot.id === unknown.row.snapshot.lot.id) })
})
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  patientId: z.string().min(1), admissionId: z.string().min(1), action: z.literal('dispense') }).strict()
const snapshotSchema = z.object({ order: inpatientPharmacySchema.shape.orders.element, execution: inpatientPharmacySchema.shape.executions.element,
  lot: inpatientPharmacySchema.shape.medications.element.shape.lots.element,
  allergies: inpatientPharmacySchema.shape.medicationAllergies }).strict()
const rowSchema = z.object({ revision: z.uuid(), selected: z.boolean(), snapshot: snapshotSchema }).strict()
const commandSchema = z.object({ operation: z.literal('inpatient.execution.dispense'), input: inpatientDispenseInputSchema }).strict()
const itemSchema = z.object({ row: rowSchema, status: z.enum(['ready', 'unknown', 'success', 'failed']), command: commandSchema.optional(),
  idempotencyKey: z.uuid().optional(), error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, reviewRequired: z.boolean(), rows: z.array(rowSchema).max(20), items: z.array(itemSchema).max(20) }).strict().refine(record =>
  new Set(record.rows.map(row => row.snapshot.execution.id)).size === record.rows.length
  && new Set(record.items.map(item => item.row.snapshot.execution.id)).size === record.items.length
  && new Set(record.items.flatMap(item => item.idempotencyKey ? [item.idempotencyKey] : [])).size === record.items.filter(item => item.idempotencyKey).length
  && record.items.filter(item => item.status === 'unknown').length <= 1
  && record.items.every(item => item.status === 'ready' ? !item.command && !item.idempotencyKey
    : item.status === 'failed' && !item.command ? !item.idempotencyKey : !!item.command && !!item.idempotencyKey))
type Scope = z.infer<typeof scopeSchema>
type Record = z.infer<typeof recordSchema>
type Row = z.infer<typeof rowSchema>
export type DispenseSnapshot = z.infer<typeof snapshotSchema>
export type PharmacyFacts = z.infer<typeof inpatientPharmacySchema>
export type DispenseEntry = { order: PharmacyFacts['orders'][number]; execution: PharmacyFacts['executions'][number]; lots: DispenseSnapshot['lot'][]; unavailable: boolean }

function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
export const sameDispenseSnapshot = (a: DispenseSnapshot, b: DispenseSnapshot) => signature(a) === signature(b)
export function dispenseEntries(facts: PharmacyFacts): DispenseEntry[] {
  return facts.executions.flatMap(execution => {
    const order = facts.orders.find(order => order.id === execution.orderId)
    if (!order) return []
    const lots = facts.medications.find(item => item.id === order.catalogItemId)?.lots.toSorted((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id)) ?? []
    return [{ order, execution, lots, unavailable: facts.admission.status !== 'admitted' || order.state !== 'verified' || execution.status !== 'pending'
      || facts.dispenses.some(item => item.executionId === execution.id) }]
  })
}
export const dispenseSnapshot = (entry: DispenseEntry, lot: DispenseSnapshot['lot'], facts: PharmacyFacts): DispenseSnapshot => ({
  order: entry.order, execution: entry.execution, lot, allergies: facts.medicationAllergies,
})
export function dispenseScope(session: SessionContext, facts: PharmacyFacts): Scope {
  return scopeSchema.parse({ accountId: session.user.id, actor: session.actor, patientId: facts.admission.patientId, admissionId: facts.admission.admissionId, action: 'dispense' })
}
const keyOf = (scope: Scope) => `${prefix}${encodeURIComponent(signature(scope))}`
const notify = (key: string) => window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
function assertBinding(record: Record) {
  const valid = (row: Row) => row.snapshot.order.admissionId === record.scope.admissionId
    && row.snapshot.execution.orderId === row.snapshot.order.id && row.snapshot.order.state === 'verified' && row.snapshot.execution.status === 'pending'
  if (!record.rows.every(valid) || !record.items.every(item => valid(item.row) && item.row.selected && (!item.command
    || item.command.input.admissionId === record.scope.admissionId && item.command.input.executionId === item.row.snapshot.execution.id
      && item.command.input.expectedExecutionVersion === item.row.snapshot.execution.version
      && item.command.input.lotSelections.length === 1 && item.command.input.lotSelections[0]!.lotId === item.row.snapshot.lot.id
      && item.command.input.lotSelections[0]!.quantity === item.row.snapshot.order.doseQuantity))) throw new Error('Dispense draft binding changed')
}
function readRecord(key: string, scope: Scope): Record | null {
  const raw = discard.read(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Dispense scope changed')
  assertBinding(record)
  return record
}
function advancedSnapshot(record: Record, row: Row): DispenseSnapshot {
  const prior = record.items.filter(item => item.status === 'success' && item.row.snapshot.lot.id === row.snapshot.lot.id)
  if (prior.some(item => signature(item.row.snapshot.lot) !== signature(row.snapshot.lot)
    || item.row.snapshot.order.catalogItemId !== row.snapshot.order.catalogItemId)) throw new Error('Dispense lot review baseline changed')
  return { ...row.snapshot, lot: { ...row.snapshot.lot, version: row.snapshot.lot.version + prior.length,
    quantityOnHand: row.snapshot.lot.quantityOnHand - prior.reduce((sum, item) => sum + item.row.snapshot.order.doseQuantity, 0) } }
}
function matchesFacts(snapshot: DispenseSnapshot, facts: PharmacyFacts): boolean {
  const entry = dispenseEntries(facts).find(entry => entry.execution.id === snapshot.execution.id)
  const lot = entry?.lots.find(lot => lot.id === snapshot.lot.id)
  return !!entry && !entry.unavailable && !!lot && lot.quantityOnHand >= entry.order.doseQuantity
    && sameDispenseSnapshot(snapshot, dispenseSnapshot(entry, lot, facts))
}
export const canReviewDispense = (snapshot: DispenseSnapshot, facts: PharmacyFacts) => matchesFacts(snapshot, facts)

/** 只持久化人工核对快照、未发送计划与不可变原尝试；Query 拥有正式库存。 */
export function useDispenseDrafts({ scope, session, write, refresh }: { scope: Scope; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent>; refresh: () => Promise<PharmacyFacts | undefined> }) {
  const key = keyOf(scope), bindingValid = session.actor.roleCode === 'pharmacist' && scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
  const read = () => {
    const empty: Record = { version: 1, scope, reviewRequired: false, rows: [], items: [] }
    try { if (!bindingValid) throw new Error('Dispense session changed'); return { key, record: readRecord(key, scope) ?? empty, failed: false } }
    catch {
      let record = empty
      try { const candidate = recordSchema.safeParse(JSON.parse(discard.read(key) ?? 'null')); if (candidate.success && signature(candidate.data.scope) === signature(scope)) record = candidate.data } catch { /* 补清理失败时不得回显退出前的原缓存。 */ }
      return { key, record, failed: true }
    }
  }
  const [stored, setStored] = useState(read), [busy, setBusy] = useState(false)
  const latest = useRef(stored), readLatest = useRef(read), owner = useRef<string | null>(key), mounted = useRef(true), running = useRef(false), writer = useRef(write), refreshLatest = useRef(refresh)
  readLatest.current = read; owner.current = bindingValid ? key : null; writer.current = write; refreshLatest.current = refresh
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
    try { discard.ensureCleared(); assertBinding(record); sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record))); const next = { key, record, failed: false }; latest.current = next; setStored(next); notify(key); return true }
    catch { const next = { key, record: latest.current.record, failed: true }; latest.current = next; setStored(next); return false }
  }
  const blocked = () => !isOwner() || running.current || latest.current.failed || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')
  const changeRows = (rows: Row[]) => !blocked() && persist({ ...latest.current.record, rows, items: latest.current.record.items.filter(item => item.status !== 'ready') })
  const run = async (recover: boolean, guard: () => boolean) => {
    const isCurrent = () => isOwner() && guard()
    if (!isCurrent() || running.current || latest.current.failed || writer.current.mutation.isPending || writer.current.storageFailure) return
    running.current = true; setBusy(true)
    try {
      while (isCurrent()) {
        let record = readRecord(key, scope)
        if (!record || !recover && record.reviewRequired) return
        const unknown = record.items.find(item => item.status === 'unknown')
        let item = recover ? unknown : unknown ? undefined : record.items.find(item => item.status === 'ready')
        if (!item || writer.current.pending && writer.current.pending.idempotencyKey !== item.idempotencyKey) return
        if (!recover) {
          const facts = await refreshLatest.current()
          if (!isCurrent()) return
          record = readRecord(key, scope)
          if (!record || record.items.some(entry => entry.status === 'unknown')
            || !record.items.some(entry => entry.status === 'ready' && entry.row.revision === item!.row.revision)
            || !record.rows.some(row => row.revision === item!.row.revision && row.selected)) return
          const snapshot = advancedSnapshot(record, item.row)
          if (!facts || facts.admission.admissionId !== scope.admissionId || facts.admission.patientId !== scope.patientId || !matchesFacts(snapshot, facts)) {
            if (!persist({ ...record, items: record.items.map(entry => entry.row.revision === item!.row.revision
              ? { ...entry, status: 'failed', error: { code: 'DISPENSE_REVIEW_CHANGED', message: '医嘱、执行单、过敏或库存已变化，请重新核对；该项未发送。' } } : entry) })) return
            continue
          }
          item = { ...item, status: 'unknown', idempotencyKey: crypto.randomUUID(), command: { operation: 'inpatient.execution.dispense', input: {
            admissionId: scope.admissionId, executionId: snapshot.execution.id, expectedExecutionVersion: snapshot.execution.version,
            lotSelections: [{ lotId: snapshot.lot.id, expectedVersion: snapshot.lot.version, quantity: snapshot.order.doseQuantity }],
          } } }
          if (!persist({ ...record, items: record.items.map(entry => entry.row.revision === item!.row.revision ? item! : entry) })) return
        }
        if (!item.command || !item.idempotencyKey) return
        try { await writer.current.mutation.mutateAsync({ ...item.command, idempotencyKey: item.idempotencyKey, ...(recover ? { recoverOriginal: true as const } : {}), isCurrent }) }
        catch (error) { if (!(error instanceof Error) || !('commandRejected' in error) || error.commandRejected !== true) return }
        if (recover) return
      }
    } catch { if (isOwner()) { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next) } }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  return {
    rows: shown.record.rows, items: shown.record.items, failed: shown.failed, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    select(snapshots: DispenseSnapshot[], selected: boolean) {
      const rows = [...latest.current.record.rows]
      for (const snapshot of snapshots) {
        const index = rows.findIndex(row => row.snapshot.execution.id === snapshot.execution.id), row = { revision: crypto.randomUUID(), selected, snapshot }
        if (index < 0) { if (selected) rows.push(row) } else rows[index] = row
      }
      return rows.length <= 20 && changeRows(rows)
    },
    deselectAll: () => changeRows(latest.current.record.rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() }))),
    remove: (id: string) => changeRows(latest.current.record.rows.filter(row => row.snapshot.execution.id !== id)),
    clear() {
      if (!isOwner() || running.current || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
      try { discard.ensureCleared(); sessionStorage.removeItem(key); const next = readLatest.current(); latest.current = next; setStored(next); notify(key); return true }
      catch { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next); return false }
    },
    prepare(facts: PharmacyFacts) {
      if (blocked() || facts.admission.admissionId !== scope.admissionId || facts.admission.patientId !== scope.patientId) return false
      const rows = latest.current.record.rows.filter(row => row.selected)
      if (!rows.length || rows.some(row => !matchesFacts(row.snapshot, facts))) return false
      for (const row of rows) {
        const sameLot = rows.filter(other => other.snapshot.lot.id === row.snapshot.lot.id)
        if (sameLot.some(other => signature(other.snapshot.lot) !== signature(row.snapshot.lot))
          || sameLot.reduce((sum, item) => sum + item.snapshot.order.doseQuantity, 0) > row.snapshot.lot.quantityOnHand) return false
      }
      return persist({ ...latest.current.record, items: rows.map(row => ({ row, status: 'ready' })), reviewRequired: false })
    },
    start: (guard: () => boolean) => run(false, guard), recover: (guard: () => boolean) => run(true, guard),
  }
}

/** 原响应证明发药和库存增量后结算，必须在清 write-intent 之前完成。 */
export function settleDispenseAttempt(raw: unknown, key: string, session: SessionContext, error?: { code: string; message: string }, recovered = false, response?: unknown): void {
  const command = commandSchema.safeParse(raw)
  if (!command.success) return
  discard.ensureCleared()
  for (const storageKey of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let decoded: unknown
    try { decoded = JSON.parse(decodeURIComponent(storageKey.slice(prefix.length))) } catch { continue }
    const scope = scopeSchema.safeParse(decoded)
    if (!scope.success || scope.data.accountId !== session.user.id || signature(scope.data.actor) !== signature(session.actor) || scope.data.admissionId !== command.data.input.admissionId) continue
    const record = readRecord(storageKey, scope.data), item = record?.items.find(item => item.idempotencyKey === key && signature(item.command) === signature(command.data))
    if (!record || !item || item.status === 'success' || item.status === 'failed') continue
    if (!error) {
      const result = inpatientPharmacyResponseSchema.parse(response), facts = result.data, snapshot = advancedSnapshot(record, item.row)
      const execution = facts.executions.find(entry => entry.id === command.data.input.executionId), supplied = facts.dispenses.filter(entry => entry.executionId === command.data.input.executionId)
      const lot = facts.medications.find(entry => entry.id === snapshot.order.catalogItemId)?.lots.find(entry => entry.id === snapshot.lot.id)
      const remaining = snapshot.lot.quantityOnHand - snapshot.order.doseQuantity
      if (facts.admission.admissionId !== scope.data.admissionId || facts.admission.patientId !== scope.data.patientId
        || execution?.orderId !== snapshot.order.id || execution.status !== 'dispensed' || execution.version !== snapshot.execution.version + 1
        || supplied.length !== 1 || supplied[0]!.lotId !== snapshot.lot.id || supplied[0]!.quantity !== snapshot.order.doseQuantity
        || command.data.input.lotSelections[0]!.expectedVersion !== snapshot.lot.version
        || !result.effects.some(effect => effect.kind === 'updated' && effect.reference === `InventoryItem/${snapshot.lot.id}` && effect.versionId === String(snapshot.lot.version + 1))
        || !result.effects.some(effect => effect.kind === 'created' && effect.reference === `MedicationDispense/${supplied[0]!.id}` && effect.versionId === '1')
        || (remaining === 0 ? lot !== undefined && (lot.version !== snapshot.lot.version + 1 || lot.quantityOnHand !== 0)
          : !lot || lot.version !== snapshot.lot.version + 1 || lot.quantityOnHand !== remaining || lot.expiresOn !== snapshot.lot.expiresOn)) throw new Error('Dispense response does not prove its original stock movement')
    }
    const next = { ...record, reviewRequired: record.reviewRequired || recovered,
      rows: error ? record.rows : record.rows.filter(row => row.revision !== item.row.revision),
      items: record.items.map(entry => entry.idempotencyKey === key ? { ...entry, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : entry) }
    sessionStorage.setItem(storageKey, JSON.stringify(recordSchema.parse(next))); notify(storageKey)
  }
}
export function clearDispenseDrafts(): void {
  discard.clear()
}
