import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { useState } from 'react'

export function ReviewDraftFailure({ failure, locked, retry, discardUnread, zh, queue = false }: {
  failure: 'read' | 'write' | null
  locked: boolean
  retry: () => void
  discardUnread: () => boolean
  zh: boolean
  queue?: boolean
}) {
  const [confirm, setConfirm] = useState(false)
  if (failure === null) return null
  const read = failure === 'read'
  return <Alert variant="destructive"><AlertDescription className="flex flex-col gap-2">
    <p>{queue ? (zh ? '原队列快照暂不可用，请重试后办理。' : 'The original queue is unavailable. Retry before continuing.')
      : read ? (zh ? '原稿暂时无法读取，已保留原内容。' : 'The original draft cannot be read. Its contents are retained.')
      : (zh ? '填写内容尚未保存，请重试后提交。' : 'The entered details could not be saved. Retry before submitting.')}</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => { setConfirm(false); retry() }}>{queue ? (zh ? '重试队列快照' : 'Retry queue snapshot') : read ? (zh ? '重试读取草稿' : 'Retry reading draft') : (zh ? '重试保存' : 'Retry saving')}</Button>
      {read && !confirm ? <Button variant="outline" disabled={locked} onClick={() => setConfirm(true)}>{queue ? (zh ? '丢弃损坏队列快照' : 'Discard damaged queue snapshot') : (zh ? '丢弃不可读草稿' : 'Discard unreadable draft')}</Button> : null}
    </div>
    {read && confirm ? <div className="flex flex-wrap items-center gap-2">
      <p>{queue ? (zh ? '仅丢弃当前病例的损坏交接记录。' : 'Discard only the damaged handoff record for this case.')
        : (zh ? '仅丢弃当前病例不可读的未提交草稿。' : 'Discard only the unreadable, unsubmitted draft for this case.')}</p>
      <Button variant="outline" onClick={() => setConfirm(false)}>{zh ? '保留草稿' : 'Keep draft'}</Button>
      <Button disabled={locked} onClick={() => { if (!locked && discardUnread()) setConfirm(false) }}>{queue ? (zh ? '确认丢弃队列快照' : 'Confirm queue snapshot discard') : (zh ? '确认丢弃草稿' : 'Confirm draft discard')}</Button>
    </div> : null}
  </AlertDescription></Alert>
}
