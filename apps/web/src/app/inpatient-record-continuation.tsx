import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientListSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { Button } from '@clinmesh/ui/components/button'
import { useEffect, useRef, useState } from 'react'
import { apiGet } from './api-client.ts'
import { useInpatientReviewQueue, type InpatientReviewQueueSnapshot, type ReviewQueueCommand } from './inpatient-review-queue.ts'

type WriteStatus = { blocked: boolean; mutation: { reset: () => void } }
export function useInpatientRecordContinuation(session: SessionContext, selectedId: string | undefined, items: InpatientAdmission[], filter: string,
  write: WriteStatus, select: (id: string, filter: string) => void, refresh: () => Promise<unknown>, zh: boolean) {
  const queue = useInpatientReviewQueue(session, selectedId)
  const [checking, setChecking] = useState(false), [notice, setNotice] = useState<{ operation: string; message: string }>()
  const current = useRef(selectedId), mounted = useRef(true)
  current.current = selectedId
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const beforeAction = (command: ReviewQueueCommand) => {
    if (!selectedId || queue.error) return false
    const index = items.findIndex(item => item.id === selectedId)
    const ordered = [...items.slice(index + 1), ...items.slice(0, Math.max(0, index))]
    const target = ordered.find(item => item.id !== selectedId && (command.operation === 'inpatient.record.review' ? item.recordStatus === 'open' : item.recordStatus === 'reviewed'))
    const prepared = queue.prepare(command, { filter, page: 1, queue: items.map(item => item.id), ...(target ? { target: { id: target.id, patientId: target.patientId, patientName: target.patientName, versionId: target.versionId } } : {}) })
    if (prepared) setNotice(undefined)
    return prepared
  }
  const next = async (snapshot: InpatientReviewQueueSnapshot) => {
    if (!snapshot.target || write.blocked || checking) return
    const target = snapshot.target
    setChecking(true); setNotice(undefined)
    try {
      const [list, record] = await Promise.all([
        apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema),
        apiGet(`/api/his/v1/inpatient/admissions/${target.id}/record`, inpatientRecordSchema),
      ])
      if (!mounted.current || current.current !== snapshot.sourceId) return
      const fresh = list.items.find(item => item.id === target.id)
      const eligible = fresh?.patientId === target.patientId && fresh.versionId === target.versionId && record.admissionId === target.id && record.snapshot.patient.patientId === target.patientId && !record.archive && record.revision?.sourcesHash === record.sourcesHash
        && (snapshot.operation === 'inpatient.record.review' ? fresh.recordStatus === 'open' && !record.reviewCurrent : fresh.recordStatus === 'reviewed' && record.reviewCurrent && fresh.status === 'cleared' && fresh.financialStatus === 'settled')
      if (!eligible) {
        setNotice({ operation: snapshot.operation, message: zh ? '目标病案状态已变化，请刷新队列后重新选择' : 'The target record changed. Refresh the queue and select it again.' })
        await refresh(); return
      }
      await refresh()
      if (!mounted.current || current.current !== snapshot.sourceId) return
      select(target.id, snapshot.filter); write.mutation.reset()
    } catch {
      if (mounted.current && current.current === snapshot.sourceId) setNotice({ operation: snapshot.operation, message: zh ? '目标病案暂时无法确认，请重试' : 'Unable to verify the target record. Retry.' })
    } finally { if (mounted.current) setChecking(false) }
  }
  return { beforeAction, content: <>
    {queue.error ? <p role="alert">{zh ? '原队列快照暂时无法读取，请重试后办理。' : 'Unable to read the original queue. Retry before continuing.'}<Button variant="outline" onClick={queue.retry}>{zh ? '重试队列快照' : 'Retry queue snapshot'}</Button></p> : null}
    {queue.snapshots.filter(snapshot => snapshot.complete && snapshot.operation !== 'inpatient.drg.payer.review').map(snapshot => <div key={snapshot.operation} aria-label={snapshot.operation === 'inpatient.record.review' ? '待审核连续队列' : '待归档连续队列'} className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
      <p role="status" className="text-sm">{notice?.operation === snapshot.operation ? notice.message : snapshot.operation === 'inpatient.record.review'
        ? snapshot.target ? zh ? '本份编码审核已完成，可继续原待审核队列。' : 'Coding review complete. Continue the original review queue.' : zh ? '本次待审核队列已完成' : 'This review queue is complete.'
        : snapshot.target ? zh ? '本份归档已完成，可继续原待归档队列。' : 'Archive complete. Continue the original archive queue.' : zh ? '本次待归档队列已完成' : 'This archive queue is complete.'}</p>
      {snapshot.target ? <Button variant="outline" disabled={write.blocked || checking} onClick={() => void next(snapshot)}>{zh ? `下一份：${snapshot.target.patientName}` : `Next record: ${snapshot.target.patientName}`}</Button> : null}
    </div>)}
  </> }
}
