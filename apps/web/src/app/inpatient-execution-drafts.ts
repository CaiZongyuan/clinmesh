import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientExecutionActionInputSchema, inpatientExecutionSchema, inpatientFullClinicalResponseSchema, inpatientOrderReasonInputSchema, inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const prefix = 'clinmesh.execution-batch:v1:'
const changedEvent = 'clinmesh.execution-batch.changed'
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(), patientId: z.string().min(1), admissionId: z.string().min(1), action: z.enum(['administer', 'complete', 'request-prn']) }).strict()
export type ExecutionAction = z.infer<typeof scopeSchema>['action']
const rowSchema = z.object({ id: z.string().min(1), revision: z.uuid(), selected: z.boolean(), verified: z.boolean(), order: inpatientOrderSchema, execution: inpatientExecutionSchema.optional(), reasonOverride: z.string().max(2000).optional() }).strict()
export type ExecutionDraft = z.infer<typeof rowSchema>
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inpatient.execution.administer'), input: inpatientExecutionActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.execution.complete'), input: inpatientExecutionActionInputSchema }).strict(),
  z.object({ operation: z.literal('inpatient.execution.request-prn'), input: inpatientOrderReasonInputSchema }).strict(),
])
const itemSchema = z.object({ row: rowSchema, command: commandSchema, idempotencyKey: z.uuid(), status: z.enum(['ready', 'unknown', 'success', 'failed']), error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, commonReason: z.string().max(2000), reviewRequired: z.boolean(), rows: z.array(rowSchema).max(20), items: z.array(itemSchema).max(20) }).strict().refine(record => new Set(record.rows.map(row => row.id)).size === record.rows.length && new Set(record.items.map(item => item.idempotencyKey)).size === record.items.length && new Set(record.items.map(item => item.row.id)).size === record.items.length && record.items.filter(item => item.status === 'unknown').length <= 1)
type Record = z.infer<typeof recordSchema>
type Clinical = z.infer<typeof inpatientFullClinicalResponseSchema>['data']
type Scope = z.infer<typeof scopeSchema>
function signature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
function notify(key: string) { window.dispatchEvent(new CustomEvent(changedEvent, { detail: key })) }
export function executionDraftScope(session: SessionContext, patientId: string, admissionId: string, action: ExecutionAction): Scope { return scopeSchema.parse({ accountId: session.user.id, actor: session.actor, patientId, admissionId, action }) }
export function sameExecutionDraft(left: Pick<ExecutionDraft, 'order' | 'execution'>, right: Pick<ExecutionDraft, 'order' | 'execution'>): boolean { return signature(left.order) === signature(right.order) && signature(left.execution) === signature(right.execution) }
function assertBinding(record: Record) {
  const rowMatches = (row: ExecutionDraft) => row.order.admissionId === record.scope.admissionId && row.order.state === 'verified'
    && (record.scope.action === 'request-prn' ? row.id === row.order.id && row.order.frequencyCode === 'PRN' && row.execution === undefined
      : row.id === row.execution?.id && row.execution.orderId === row.order.id && row.order.kind === (record.scope.action === 'administer' ? 'medication' : 'service'))
  if (!record.rows.every(rowMatches) || !record.items.every(item => rowMatches(item.row) && item.row.selected && item.row.verified
    && item.command.operation === `inpatient.execution.${record.scope.action}` && item.command.input.admissionId === record.scope.admissionId
    && (item.command.operation === 'inpatient.execution.request-prn' ? item.command.input.orderId === item.row.id && item.command.input.expectedOrderVersion === item.row.order.version && item.command.input.reason === item.row.reasonOverride?.trim()
      : item.command.input.executionId === item.row.id && item.command.input.expectedExecutionVersion === item.row.execution?.version))) throw new Error('Execution draft binding changed')
}
function readRecord(key: string, scope: Scope): Record | null {
  const raw = sessionStorage.getItem(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Execution scope changed')
  assertBinding(record)
  return record
}

/** 只保存人工事实核实、选择和原尝试，不拥有服务端临床事实。 */
export function useExecutionDrafts({ scope, session, write }: { scope: Scope; session: SessionContext; write: ReturnType<typeof useInpatientWriteIntent> }) {
  const key = `${prefix}${encodeURIComponent(signature(scope))}`
  const bindingValid = scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor) && session.actor.roleCode === 'ward-nurse'
  const read = () => {
    const empty: Record = { version: 1, scope, commonReason: '', reviewRequired: false, rows: [], items: [] }
    try { if (!bindingValid) throw new Error('Execution session changed'); return { key, record: readRecord(key, scope) ?? empty, failed: false } }
    catch {
      let record = empty
      try { const parsed = recordSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null')); if (parsed.success && signature(parsed.data.scope) === signature(scope)) record = parsed.data } catch { /* 不覆盖损坏缓存。 */ }
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
  const persist = (record: Record, keepOnFailure = false) => {
    if (!isOwner()) return false
    try {
      assertBinding(record); sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record)))
      const next = { key, record, failed: false }; latest.current = next; setStored(next); notify(key); return true
    } catch {
      const next = { key, record: keepOnFailure ? latest.current.record : record, failed: true }; latest.current = next; setStored(next); return false
    }
  }
  const change = (rows: ExecutionDraft[], commonReason = latest.current.record.commonReason) => {
    if (running.current || latest.current.failed || latest.current.record.items.some(item => item.status === 'unknown')) return false
    return persist({ ...latest.current.record, rows, commonReason, items: latest.current.record.items.filter(item => item.status !== 'ready') })
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
        // 原结果已结算但清共享意图失败时，仍用同一原尝试恢复清理。
        const settled = recover && writer.current.pending ? record.items.find(item => item.idempotencyKey === writer.current.pending?.idempotencyKey) : undefined
        const item = recover ? unknown ?? settled : unknown ? undefined : record.items.find(item => item.status === 'ready')
        if (!item || writer.current.pending && writer.current.pending.idempotencyKey !== item.idempotencyKey) return
        if (!recover && !record.rows.some(row => row.id === item.row.id && row.revision === item.row.revision && row.selected && row.verified)) return
        if (!persist({ ...record, items: record.items.map(entry => entry.idempotencyKey === item.idempotencyKey ? { ...entry, status: 'unknown' } : entry) }, true)) return
        try { await writer.current.mutation.mutateAsync({ ...item.command, idempotencyKey: item.idempotencyKey, ...(recover ? { recoverOriginal: true as const } : {}), isCurrent }) }
        catch (error) { if (!(error instanceof Error) || !('commandRejected' in error) || error.commandRejected !== true) return }
        if (recover) return
      }
    } catch { if (isOwner()) { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next) } }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  return {
    rows: shown.record.rows, items: shown.record.items, commonReason: shown.record.commonReason, failed: shown.failed, busy,
    blocked: busy || shown.failed || shown.record.items.some(item => item.status === 'unknown') || write.blocked,
    update(candidate: Pick<ExecutionDraft, 'id' | 'order' | 'execution'>, patch: { verified?: boolean; selected?: boolean }) {
      const rows = [...latest.current.record.rows], index = rows.findIndex(row => row.id === candidate.id), previous = rows[index]
      const same = previous !== undefined && sameExecutionDraft(previous, candidate)
      const verified = patch.verified ?? (scope.action === 'request-prn' || same && previous.verified)
      const selected = verified && (patch.selected ?? (same && previous.selected))
      const row: ExecutionDraft = { ...candidate, revision: crypto.randomUUID(), verified, selected, ...(previous?.reasonOverride === undefined ? {} : { reasonOverride: previous.reasonOverride }) }
      if (index < 0) rows.push(row); else rows[index] = row
      if (rows.length > 20) return false
      return change(rows)
    },
    setCommonReason: (reason: string) => change(latest.current.record.rows.map(row => row.reasonOverride === undefined ? { ...row, revision: crypto.randomUUID() } : row), reason),
    setReasonOverride: (id: string, reason: string | undefined) => change(latest.current.record.rows.map(row => {
      if (row.id !== id) return row
      const { reasonOverride: _old, ...rest } = row
      return { ...rest, revision: crypto.randomUUID(), ...(reason === undefined ? {} : { reasonOverride: reason }) }
    })),
    deselectAll: () => change(latest.current.record.rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() }))),
    remove: (id: string) => change(latest.current.record.rows.filter(row => row.id !== id)),
    clear() {
      if (!isOwner() || running.current || latest.current.record.items.some(item => item.status === 'unknown') || writer.current.pending) return false
      try { sessionStorage.removeItem(key); const next = readLatest.current(); latest.current = next; setStored(next); notify(key); return true }
      catch { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next); return false }
    },
    prepare(candidates: Array<Pick<ExecutionDraft, 'id' | 'order' | 'execution'>>) {
      if (!isOwner() || running.current || latest.current.failed || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
      const rows = latest.current.record.rows.filter(row => row.selected)
      if (!rows.length || rows.some(row => !row.verified || !candidates.some(candidate => candidate.id === row.id && sameExecutionDraft(row, candidate))) || scope.action === 'request-prn' && rows.some(row => !(row.reasonOverride ?? latest.current.record.commonReason).trim())) return false
      const items = rows.map(row => ({ row: scope.action === 'request-prn' ? { ...row, reasonOverride: (row.reasonOverride ?? latest.current.record.commonReason).trim() } : row,
        command: commandSchema.parse({ operation: `inpatient.execution.${scope.action}`, input: scope.action === 'request-prn' ? { admissionId: scope.admissionId, orderId: row.id, expectedOrderVersion: row.order.version, reason: row.reasonOverride ?? latest.current.record.commonReason }
          : { admissionId: scope.admissionId, executionId: row.id, expectedExecutionVersion: row.execution?.version } }), idempotencyKey: crypto.randomUUID(), status: 'ready' as const }))
      return persist({ ...latest.current.record, items, reviewRequired: false }, true)
    },
    start: (guard: () => boolean) => run(false, guard), recover: (guard: () => boolean) => run(true, guard),
  }
}

function provesAttempt(item: z.infer<typeof itemSchema>, response: unknown): boolean {
  const parsed = inpatientFullClinicalResponseSchema.parse(response), result: Clinical = parsed.data, effects = parsed.effects
  const hasEffect = (kind: 'created' | 'updated', reference: string) => effects.some(effect => effect.kind === kind && effect.reference === reference)
  const order = result.orders.find(order => order.id === item.row.order.id)
  if (result.admissionId !== item.command.input.admissionId || order?.admissionId !== item.command.input.admissionId) return false
  if (item.command.operation === 'inpatient.execution.request-prn') {
    return order.version === item.row.order.version && result.executions.some(execution => execution.orderId === item.row.id && execution.status === 'pending' && execution.version === 1
      && execution.reason === item.row.reasonOverride && hasEffect('created', `Task/${execution.id}`))
      && !effects.some(effect => effect.reference.startsWith('MedicationAdministration/'))
  }
  const execution = result.executions.find(execution => execution.id === item.row.id)
  if (!execution || execution.orderId !== item.row.order.id || execution.status !== 'completed' || execution.version !== item.command.input.expectedExecutionVersion + 1 || !hasEffect('updated', `Task/${execution.id}`)) return false
  return item.command.operation === 'inpatient.execution.administer'
    ? execution.administrationId !== undefined && hasEffect('created', `MedicationAdministration/${execution.administrationId}`)
    : result.charges.some(charge => charge.kind === 'service' && charge.sourceId === execution.id && charge.reversalOf === undefined && hasEffect('created', `ChargeItem/${charge.id}`))
}

/** 必须先可靠结算原修订，再允许共享 writer 清除原意图。 */
export function settleExecutionAttempt(raw: unknown, idempotencyKey: string, session: SessionContext, error?: { code: string; message: string }, recovered = false, response?: unknown): void {
  const command = commandSchema.safeParse(raw)
  if (!command.success) return
  for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let rawScope: unknown
    try { rawScope = JSON.parse(decodeURIComponent(key.slice(prefix.length))) } catch { continue }
    const scope = scopeSchema.safeParse(rawScope)
    if (!scope.success || scope.data.accountId !== session.user.id || signature(scope.data.actor) !== signature(session.actor) || scope.data.admissionId !== command.data.input.admissionId) continue
    const record = readRecord(key, scope.data)
    const item = record?.items.find(item => item.idempotencyKey === idempotencyKey && signature(item.command) === signature(command.data))
    if (!record || !item) continue
    if (!error && !provesAttempt(item, response)) throw new Error('Execution response does not prove its original attempt')
    const next = { ...record, reviewRequired: record.reviewRequired || recovered,
      rows: error ? record.rows : record.rows.filter(row => row.id !== item.row.id || row.revision !== item.row.revision),
      items: record.items.map(entry => entry.idempotencyKey === idempotencyKey ? { ...entry, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : entry) }
    sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(next))); notify(key)
  }
}
export function clearExecutionDrafts(): void { for (const key of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) { sessionStorage.removeItem(key); notify(key) } }
