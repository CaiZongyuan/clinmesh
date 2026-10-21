import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
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
  </AlertDescription></Alert>
}
