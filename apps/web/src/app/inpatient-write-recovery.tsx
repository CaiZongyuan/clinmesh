import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { useState } from 'react'
import { OriginalContinuationUnreadable, type useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function InpatientWriteRecovery({ write, locale }: { write: ReturnType<typeof useInpatientWriteIntent>; locale: WorkspaceLocale }): React.JSX.Element | null {
  if (write.pending === null || write.mutation.isPending) return null
  const zh = locale === 'zh-CN'
  const clock = write.pending.command.operation === 'scenario.advance-time'
  return <Alert role="region" aria-label={zh ? '待确认操作' : 'Pending operation'}><AlertDescription>
    <p>{zh ? '原操作结果待确认，已保留当时的信息。请先恢复，再办理新操作。' : 'The original result is unconfirmed. Recover the saved operation before starting another.'}</p>
    <Button disabled={write.mutation.isPending} type="button" variant="outline" onClick={() => write.mutation.mutate(undefined)}>
      {clock ? (zh ? '恢复原时间推进' : 'Recover time advance') : (zh ? '恢复原住院操作' : 'Recover inpatient operation')}
    </Button>
    <ContinuationDraftRecovery write={write} locale={locale} />
  </AlertDescription></Alert>
}

export function ContinuationDraftRecovery({ write, locale }: { write: ReturnType<typeof useInpatientWriteIntent>; locale: WorkspaceLocale }) {
  const [confirmKey, setConfirmKey] = useState<string>()
  const pending = write.pending, error = write.mutation.error, zh = locale === 'zh-CN'
  if (!pending || write.mutation.isPending || !(error instanceof OriginalContinuationUnreadable) || error.idempotencyKey !== pending.idempotencyKey) return null
  return <div className="mt-2 flex flex-col gap-2">
    <p>{zh ? '原操作已成功，但原病例的草稿或交接记录无法读取。可重试查询或明确丢弃不可读记录。' : 'The original operation succeeded, but its draft or handoff cannot be read. Retry recovery or discard the unreadable record.'}</p>
    {confirmKey !== pending.idempotencyKey ? <Button className="self-start" variant="outline" onClick={() => setConfirmKey(pending.idempotencyKey)}>{zh ? '丢弃原不可读记录' : 'Discard unreadable original record'}</Button>
      : <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setConfirmKey(undefined)}>{zh ? '保留原记录' : 'Keep original record'}</Button>
        <Button disabled={write.storageFailure !== null} onClick={() => {
          setConfirmKey(undefined)
          write.mutation.mutate({ ...pending.command, idempotencyKey: pending.idempotencyKey, recoverOriginal: true, discardUnreadContinuationDraft: true })
        }}>{zh ? '确认丢弃并恢复' : 'Confirm discard and recover'}</Button></div>}
  </div>
}
