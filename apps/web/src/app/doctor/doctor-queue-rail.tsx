import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { StethoscopeIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { DoctorQueueModule } from './doctor-queue-module.tsx'
import { getWorkspaceMessages } from '../workspace-i18n.ts'

type WorkspaceMessages = ReturnType<typeof getWorkspaceMessages>

/** DSH 镜像布局的队列回落形态：收起把手贴内容区左缘可扫读计数，展开后复用队列模块完成切换。 */
export function DoctorQueueRail({
  activeCaseId,
  messages,
  navigation,
  onQueuePageChange,
  onSelectCase,
  queueData,
  queueError,
  queuePending,
  queueView,
}: {
  activeCaseId: string | undefined
  messages: WorkspaceMessages
  navigation: ReactNode
  onQueuePageChange: (page: number) => void
  onSelectCase: (caseId: string) => void
  queueData: Parameters<typeof DoctorQueueModule>[0]['queueData']
  queueError: Error | null
  queuePending: boolean
  queueView: Parameters<typeof DoctorQueueModule>[0]['queueView']
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const total = queueData?.total ?? 0
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-20 flex items-center">
      <div className="pointer-events-auto flex h-full max-h-full items-center gap-1">
        <Button
          aria-expanded={open}
          aria-label={`${messages.consultationQueue} · ${messages.doctorQueueCount.replace('{count}', String(total))}`}
          className="h-auto rounded-r-md border border-l-0 px-1.5 py-3 shadow-md"
          onClick={() => setOpen(current => !current)}
          size="sm"
          type="button"
          variant="secondary"
        >
          <span className="flex flex-col items-center gap-1">
            <StethoscopeIcon aria-hidden="true" className="size-4" />
            <Badge className="px-1.5 tabular-nums" variant="secondary">{total}</Badge>
          </span>
        </Button>
        {open ? (
          <div aria-label={messages.consultationQueue} className="h-full w-72 overflow-hidden border bg-background shadow-lg" role="group">
            <DoctorQueueModule
              activeCaseId={activeCaseId}
              messages={messages}
              navigation={navigation}
              onQueuePageChange={onQueuePageChange}
              onSelectCase={caseId => { onSelectCase(caseId); setOpen(false) }}
              queueData={queueData}
              queueError={queueError}
              queuePending={queuePending}
              queueView={queueView}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
