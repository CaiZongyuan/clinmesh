import { sessionContextSchema, type SessionContext } from '@clinmesh/contracts/his'
import { inpatientInvestigationActionInputSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { createDraftDiscard } from './draft-discard.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const prefix = 'clinmesh.inpatient-investigation-actions:v1:'
const changedEvent = 'clinmesh.inpatient-investigation-actions.changed'
const discard = createDraftDiscard(prefix, () => notify('*'), (key, raw) => {
  const record = recordSchema.parse(JSON.parse(raw))
  if (keyOf(record.scope) !== key) throw new Error('Draft scope changed')
  assertBinding(record)
  const unknown = record.items.find(item => item.status === 'unknown')
  return unknown ? JSON.stringify({ ...record, reviewRequired: true, rows: [unknown.row], items: [unknown] }) : null
})
const scopeSchema = z.object({ accountId: z.string().min(1), actor: sessionContextSchema.shape.actor.strict(),
  patientId: z.string().min(1), admissionId: z.string().min(1), action: z.enum(['cancel', 'retry']) }).strict()
const snapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('laboratory'), request: inpatientInvestigationsSchema.shape.laboratoryRequests.element, sent: z.boolean() }).strict(),
  z.object({ kind: z.literal('imaging'), request: inpatientInvestigationsSchema.shape.imagingRequests.element, sent: z.boolean() }).strict(),
])
const rowSchema = z.object({ revision: z.uuid(), selected: z.boolean(), snapshot: snapshotSchema }).strict()
const commandSchema = z.object({ operation: z.enum(['inpatient.investigation.cancel', 'inpatient.investigation.retry']), input: inpatientInvestigationActionInputSchema }).strict()
const itemSchema = z.object({ row: rowSchema, status: z.enum(['ready', 'unknown', 'success', 'failed']), command: commandSchema.optional(),
  idempotencyKey: z.uuid().optional(), error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()
const recordSchema = z.object({ version: z.literal(1), scope: scopeSchema, reviewRequired: z.boolean(), rows: z.array(rowSchema).max(20), items: z.array(itemSchema).max(20) }).strict()
type Scope = z.infer<typeof scopeSchema>
type Record = z.infer<typeof recordSchema>
type Row = z.infer<typeof rowSchema>
export type InvestigationAction = Scope['action']
export type InvestigationActionSnapshot = z.infer<typeof snapshotSchema>
export type InvestigationActionFacts = z.infer<typeof inpatientInvestigationsSchema>

const signature = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const keyOf = (scope: Scope) => prefix + encodeURIComponent(signature(scope))
const notify = (key: string) => window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }))
const commandFor = (scope: Scope, snapshot: InvestigationActionSnapshot) => commandSchema.parse({ operation: `inpatient.investigation.${scope.action}`, input: {
  admissionId: scope.admissionId, requestId: snapshot.request.id, expectedRequestVersion: snapshot.request.version,
  serviceRequestVersion: snapshot.request.serviceRequestVersion, taskVersion: snapshot.request.taskVersion,
} })

export function investigationActionEntries(facts: InvestigationActionFacts): InvestigationActionSnapshot[] {
  const sent = (id: string) => facts.sent.some(item => item.requestId === id)
  return [...facts.laboratoryRequests.map(request => ({ kind: 'laboratory' as const, request, sent: sent(request.id) })),
    ...facts.imagingRequests.map(request => ({ kind: 'imaging' as const, request, sent: sent(request.id) }))]
}
export const investigationActionName = (snapshot: InvestigationActionSnapshot) => snapshot.kind === 'imaging' ? snapshot.request.service.name
  : snapshot.request.laboratoryService?.nameZh ?? snapshot.request.referenceConcept?.display ?? snapshot.request.catalogItemId
export function investigationActionUnavailable(snapshot: InvestigationActionSnapshot, action: InvestigationAction): boolean {
  return action === 'cancel' ? !((snapshot.request.status === 'issued' && !snapshot.sent) || snapshot.request.status === 'generation-failed')
    : snapshot.request.status !== 'generation-failed' || ['INVESTIGATION_TRUTH_INCOMPATIBLE', 'INVESTIGATION_UNSUPPORTED'].includes(snapshot.request.generationError?.code ?? '')
}
export const sameInvestigationActionSnapshot = (left: InvestigationActionSnapshot, right: InvestigationActionSnapshot) => signature(left) === signature(right)
export const canReviewInvestigationAction = (snapshot: InvestigationActionSnapshot, facts: InvestigationActionFacts, action: InvestigationAction) =>
  investigationActionEntries(facts).some(current => !investigationActionUnavailable(current, action) && sameInvestigationActionSnapshot(current, snapshot))

function assertBinding(record: Record) {
  if (new Set(record.rows.map(row => row.snapshot.request.id)).size !== record.rows.length
    || new Set(record.items.map(item => item.row.snapshot.request.id)).size !== record.items.length
    || new Set(record.items.flatMap(item => item.idempotencyKey ? [item.idempotencyKey] : [])).size !== record.items.filter(item => item.idempotencyKey).length
    || record.items.filter(item => item.status === 'unknown').length > 1
    || record.items.some(item => item.command ? !item.idempotencyKey || signature(item.command) !== signature(commandFor(record.scope, item.row.snapshot))
      : item.idempotencyKey !== undefined || item.status === 'unknown' || item.status === 'success')) throw new Error('Invalid investigation action binding')
}
function readRecord(key: string, scope: Scope): Record | null {
  const raw = discard.read(key)
  if (raw === null) return null
  const record = recordSchema.parse(JSON.parse(raw))
  if (signature(record.scope) !== signature(scope)) throw new Error('Investigation action scope changed')
  assertBinding(record)
  return record
}

/** 保存人工核对清单与原尝试；正式申请始终由 Query 拥有。 */
export function useInvestigationActionDrafts({ scope, session, write, refresh }: { scope: Scope; session: SessionContext;
  write: ReturnType<typeof useInpatientWriteIntent>; refresh: () => Promise<InvestigationActionFacts | undefined> }) {
  const key = keyOf(scope), valid = session.actor.roleCode === 'inpatient-doctor' && scope.accountId === session.user.id && signature(scope.actor) === signature(session.actor)
  const read = () => {
    const empty: Record = { version: 1, scope, reviewRequired: false, rows: [], items: [] }
    try { if (!valid) throw new Error('Investigation session changed'); return { key, record: readRecord(key, scope) ?? empty, failed: false } }
    catch { return { key, record: empty, failed: true } }
  }
  const [stored, setStored] = useState(read), [busy, setBusy] = useState(false)
  const latest = useRef(stored), readLatest = useRef(read), owner = useRef<string | null>(key), mounted = useRef(true), running = useRef(false), writer = useRef(write), refreshLatest = useRef(refresh)
  readLatest.current = read; owner.current = valid ? key : null; writer.current = write; refreshLatest.current = refresh
  if (latest.current.key !== key) latest.current = read()
  const shown = stored.key === key ? stored : latest.current
  useEffect(() => {
    mounted.current = true
    const refresh = () => { if (owner.current === key) { const next = readLatest.current(); latest.current = next; setStored(next) } }
    const changed = (event: Event) => { if (event instanceof CustomEvent && (event.detail === key || event.detail === '*')) refresh() }
    refresh(); window.addEventListener(changedEvent, changed)
    return () => { mounted.current = false; window.removeEventListener(changedEvent, changed) }
  }, [key])
  const isOwner = () => mounted.current && owner.current === key && valid
  const persist = (record: Record) => {
    if (!isOwner()) return false
    try { discard.ensureCleared(); sessionStorage.setItem(key, JSON.stringify(recordSchema.parse(record))); const next = { key, record, failed: false }; latest.current = next; setStored(next); notify(key); return true }
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
          if (!facts || facts.admissionId !== scope.admissionId || !canReviewInvestigationAction(item.row.snapshot, facts, scope.action)) {
            if (!persist({ ...record, items: record.items.map(entry => entry.row.revision === item!.row.revision
              ? { ...entry, status: 'failed', error: { code: 'INVESTIGATION_REVIEW_CHANGED', message: '申请内容或状态已变化，请重新核对；该项未发送。' } } : entry) })) return
            continue
          }
          item = { ...item, status: 'unknown', idempotencyKey: crypto.randomUUID(), command: commandFor(scope, item.row.snapshot) }
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
    select(snapshots: InvestigationActionSnapshot[], selected: boolean) {
      const rows = [...latest.current.record.rows]
      for (const snapshot of snapshots) {
        const index = rows.findIndex(row => row.snapshot.request.id === snapshot.request.id), row = { revision: crypto.randomUUID(), selected, snapshot }
        if (index < 0) { if (selected) rows.push(row) } else rows[index] = row
      }
      return rows.length <= 20 && changeRows(rows)
    },
    deselectAll: () => changeRows(latest.current.record.rows.map(row => ({ ...row, selected: false, revision: crypto.randomUUID() }))),
    remove: (id: string) => changeRows(latest.current.record.rows.filter(row => row.snapshot.request.id !== id)),
    clear() {
      if (!isOwner() || running.current || writer.current.blocked || latest.current.record.items.some(item => item.status === 'unknown')) return false
      try { sessionStorage.removeItem(key); discard.ensureCleared(); const next = readLatest.current(); latest.current = next; setStored(next); notify(key); return true }
      catch { const next = { ...latest.current, failed: true }; latest.current = next; setStored(next); return false }
    },
    prepare(facts: InvestigationActionFacts) {
      if (blocked() || facts.admissionId !== scope.admissionId) return false
      const rows = latest.current.record.rows.filter(row => row.selected)
      if (!rows.length || rows.some(row => !canReviewInvestigationAction(row.snapshot, facts, scope.action))) return false
      return persist({ ...latest.current.record, items: rows.map(row => ({ row, status: 'ready' })), reviewRequired: false })
    },
    start: (guard: () => boolean) => run(false, guard), recover: (guard: () => boolean) => run(true, guard),
  }
}

/** 原回执证明指定申请的本次动作后，先结算清单，再清除持久写意图。 */
export function settleInpatientInvestigationActionAttempt(raw: unknown, key: string, session: SessionContext, error?: { code: string; message: string }, recovered = false, response?: unknown): void {
  const command = commandSchema.safeParse(raw)
  if (!command.success) return
  discard.ensureCleared()
  for (const storageKey of Object.keys(sessionStorage).filter(key => key.startsWith(prefix))) {
    let decoded: unknown
    try { decoded = JSON.parse(decodeURIComponent(storageKey.slice(prefix.length))) } catch { continue }
    const scope = scopeSchema.safeParse(decoded)
    if (!scope.success || scope.data.accountId !== session.user.id || signature(scope.data.actor) !== signature(session.actor)
      || scope.data.admissionId !== command.data.input.admissionId || `inpatient.investigation.${scope.data.action}` !== command.data.operation) continue
    const record = readRecord(storageKey, scope.data), item = record?.items.find(item => item.idempotencyKey === key && signature(item.command) === signature(command.data))
    if (!record || !item || item.status === 'success' || item.status === 'failed') continue
    if (!error) {
      const result = inpatientInvestigationResponseSchema.parse(response), original = item.row.snapshot.request
      const current = (item.row.snapshot.kind === 'laboratory' ? result.data.laboratoryRequests : result.data.imagingRequests).find(entry => entry.id === original.id)
      const taskVersion = String(BigInt(original.taskVersion) + 1n), serviceVersion = scope.data.action === 'cancel'
        ? String(BigInt(original.serviceRequestVersion) + 1n) : original.serviceRequestVersion
      if (result.data.admissionId !== scope.data.admissionId || current?.status !== (scope.data.action === 'cancel' ? 'cancelled' : 'in-progress')
        || current.version !== original.version + 1 || current.taskId !== original.taskId || current.taskVersion !== taskVersion
        || current.serviceRequestId !== original.serviceRequestId || current.serviceRequestVersion !== serviceVersion
        || !result.effects.some(effect => effect.kind === 'updated' && effect.reference === `Task/${original.taskId}` && effect.versionId === taskVersion)
        || scope.data.action === 'cancel' && !result.effects.some(effect => effect.kind === 'updated' && effect.reference === `ServiceRequest/${original.serviceRequestId}` && effect.versionId === serviceVersion)) throw new Error('Investigation response does not prove the original action')
    }
    const next = { ...record, reviewRequired: record.reviewRequired || recovered,
      rows: error ? record.rows : record.rows.filter(row => row.revision !== item.row.revision),
      items: record.items.map(entry => entry.idempotencyKey === key ? { ...entry, status: error ? 'failed' as const : 'success' as const, ...(error ? { error } : {}) } : entry) }
    discard.ensureCleared(); sessionStorage.setItem(storageKey, JSON.stringify(recordSchema.parse(next))); notify(storageKey)
  }
}

export function clearInpatientInvestigationActionDrafts(): void {
  discard.clear()
}
