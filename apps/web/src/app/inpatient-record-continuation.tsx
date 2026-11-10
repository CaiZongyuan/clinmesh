import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientListSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { Button } from '@clinmesh/ui/components/button'
import { useEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { useInpatientReviewQueue, type InpatientReviewQueueSnapshot, type ReviewQueueCommand } from './inpatient-review-queue.ts'
import { ReviewDraftFailure } from './review-draft-failure.tsx'

type WriteStatus = { blocked: boolean; mutation: { reset: () => void } }
type Target = NonNullable<InpatientReviewQueueSnapshot['target']>
type Choice = { target?: Target | null; notice?: 'changed' | 'read'; reselect?: boolean }
const keyOf = (snapshot: InpatientReviewQueueSnapshot) => JSON.stringify([snapshot.sourceId, snapshot.operation, snapshot.signature])
const orderedAfter = <T,>(items: T[], index: number) => [...items.slice(index + 1), ...items.slice(0, Math.max(0, index))]
const mayHandle = (item: InpatientAdmission, operation: ReviewQueueCommand['operation']) => operation === 'inpatient.record.review'
  ? item.recordStatus === 'open' : item.recordStatus === 'reviewed' && item.status === 'cleared' && item.financialStatus === 'settled'
const targetOf = ({ id, patientId, patientName, versionId }: InpatientAdmission): Target => ({ id, patientId, patientName, versionId })
const readRecord = (id: string) => apiGet(`/api/his/v1/inpatient/admissions/${encodeURIComponent(id)}/record`, inpatientRecordSchema)
function canHandle(item: InpatientAdmission, record: ReturnType<typeof inpatientRecordSchema.parse>, operation: ReviewQueueCommand['operation']) {
  return mayHandle(item, operation) && record.admissionId === item.id && record.snapshot.patient.patientId === item.patientId
    && !record.archive && record.revision?.sourcesHash === record.sourcesHash && record.reviewCurrent === (operation === 'inpatient.record.archive')
}

export function useInpatientRecordContinuation(session: SessionContext, selectedId: string | undefined, items: InpatientAdmission[], filter: string,
  write: WriteStatus, select: (id: string, filter: string) => void, refresh: () => Promise<unknown>, zh: boolean) {
  const queue = useInpatientReviewQueue(session, selectedId)
  const [checking, setChecking] = useState(false), [choices, setChoices] = useState<Partial<Record<string, Choice>>>({})
  const current = useRef(selectedId), mounted = useRef(true), inFlight = useRef(false), blocked = useRef(write.blocked)
  current.current = selectedId
  blocked.current = write.blocked
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const beforeAction = (command: ReviewQueueCommand) => {
    if (!selectedId || queue.error || inFlight.current || blocked.current) return false
    const target = orderedAfter(items, items.findIndex(item => item.id === selectedId)).find(item => item.id !== selectedId && mayHandle(item, command.operation))
    const previous = queue.snapshots.find(snapshot => snapshot.operation === command.operation)
    const prepared = queue.prepare(command, { filter, page: 1, queue: items.map(item => item.id), ...(target ? { target: targetOf(target) } : {}) })
    if (prepared && previous && choices[keyOf(previous)]) {
      setChoices(current => { const next = { ...current }; delete next[keyOf(previous)]; return next })
    }
    return prepared
  }
  const verify = async (snapshot: InpatientReviewQueueSnapshot, target: Target | undefined) => {
    if (blocked.current || inFlight.current) return
    const key = keyOf(snapshot), choice = choices[key]
    const active = () => mounted.current && current.current === snapshot.sourceId && !blocked.current
    const show = (value: Choice) => setChoices(previous => ({ ...previous, [key]: value }))
    inFlight.current = true; setChecking(true)
    try {
      const [list, record] = await Promise.all([
        apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema),
        target ? readRecord(target.id) : undefined,
      ])
      if (!active()) return
      if (target) {
        const fresh = list.items.find(item => item.id === target.id)
        if (!fresh || fresh.patientId !== target.patientId || fresh.versionId !== target.versionId || !record || !canHandle(fresh, record, snapshot.operation)) {
          show({ ...choice, notice: 'changed', reselect: true })
          await refresh()
          return
        }
        await refresh()
        if (active()) { select(target.id, snapshot.filter); write.mutation.reset() }
        return
      }
      const indexed = new Map(list.items.map(item => [item.id, item]))
      let replacement: Target | null = null
      // Preserve the original order and stop on an unknown read instead of skipping that record.
      for (const id of orderedAfter(snapshot.queue, snapshot.queue.indexOf(snapshot.sourceId))) {
        const item = indexed.get(id)
        if (!item || item.id === snapshot.sourceId || !mayHandle(item, snapshot.operation)) continue
        const candidate = await readRecord(id)
        if (!active()) return
        if (canHandle(item, candidate, snapshot.operation)) { replacement = targetOf(item); break }
      }
      await refresh()
      if (active()) show({ target: replacement })
    } catch {
      if (active()) show({ ...choice, notice: 'read' })
    } finally { inFlight.current = false; if (mounted.current) setChecking(false) }
  }
  return { beforeAction, checking, content: <>
    <ReviewDraftFailure key={queue.scope} failure={queue.failure} locked={write.blocked || checking} retry={queue.retry} discardUnread={queue.discardUnread} zh={zh} queue />
    {queue.snapshots.filter(snapshot => snapshot.complete && snapshot.operation !== 'inpatient.drg.payer.review').map(snapshot => {
      const choice = choices[keyOf(snapshot)], target = choice?.target === null ? undefined : choice?.target ?? snapshot.target
      const notice = choice?.notice === 'changed' ? zh ? '目标病案状态已变化，请刷新队列后重新选择' : 'The target record changed. Refresh the queue and select it again.'
        : choice?.notice === 'read' ? zh ? '目标病案暂时无法确认，请重试' : 'Unable to verify the target record. Retry.'
          : snapshot.operation === 'inpatient.record.review'
            ? target ? zh ? '本份编码审核已完成，可继续原待审核队列。' : 'Coding review complete. Continue the original review queue.' : zh ? '本次待审核队列已完成' : 'This review queue is complete.'
            : target ? zh ? '本份归档已完成，可继续原待归档队列。' : 'Archive complete. Continue the original archive queue.' : zh ? '本次待归档队列已完成' : 'This archive queue is complete.'
      return <div key={snapshot.operation} aria-label={snapshot.operation === 'inpatient.record.review' ? '待审核连续队列' : '待归档连续队列'} className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
        <p role="status" className="text-sm">{notice}</p>
        {target ? <Button variant="outline" disabled={write.blocked || checking || choice?.reselect} onClick={() => void verify(snapshot, target)}>{zh ? `下一份：${target.patientName}` : `Next record: ${target.patientName}`}</Button> : null}
        {choice?.reselect ? <Button variant="outline" disabled={write.blocked || checking} onClick={() => void verify(snapshot, undefined)}>{zh ? '刷新队列并重选下一份' : 'Refresh and choose the next record'}</Button> : null}
      </div>
    })}
  </> }
}
