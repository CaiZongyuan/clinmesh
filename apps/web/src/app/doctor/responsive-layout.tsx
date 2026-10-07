import { useEffect, useState, type ReactNode, type Ref } from 'react'
import type { DoctorCaseSection } from '@clinmesh/contracts/agent'
import { Button } from '@clinmesh/ui/components/button'
import { useContainerCompact } from '@clinmesh/ui/hooks/use-container-compact'
import { cn } from '@clinmesh/ui/lib/utils'
import { TabsContent } from '@clinmesh/ui/components/tabs'

export function DoctorWorkspaceLayout({
  children,
  queue,
  selectedCaseId,
  queueLabel,
  detailLabel,
}: {
  children: ReactNode
  queue: (showDetail: () => void) => ReactNode
  selectedCaseId?: string | undefined
  queueLabel: string
  detailLabel: string
}) {
  const { ref, compact } = useContainerCompact(720)
  const [showQueue, setShowQueue] = useState(selectedCaseId === undefined)
  useEffect(() => setShowQueue(selectedCaseId === undefined), [selectedCaseId])
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {compact ? (
        <div className="flex gap-2 border-b p-2" role="group" aria-label={queueLabel}>
          <Button
            aria-pressed={showQueue}
            onClick={() => setShowQueue(true)}
            size="sm"
            variant={showQueue ? 'secondary' : 'ghost'}
          >
            {queueLabel}
          </Button>
          <Button
            aria-pressed={!showQueue}
            onClick={() => setShowQueue(false)}
            size="sm"
            variant={!showQueue ? 'secondary' : 'ghost'}
          >
            {detailLabel}
          </Button>
        </div>
      ) : null}
      <div
        className="grid min-h-0 min-w-0 flex-1"
        style={{ gridTemplateColumns: compact ? 'minmax(0, 1fr)' : '200px minmax(0, 1fr)' }}
      >
        <div hidden={compact && !showQueue} className="min-h-0 min-w-0 overflow-y-auto border-r">
          {queue(() => setShowQueue(false))}
        </div>
        <div hidden={compact && showQueue} className="@container/case-detail min-h-0 min-w-0 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  )
}

export function DoctorCaseLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1">
        <div className="@container/case-content flex min-h-0 min-w-0 flex-col">{children}</div>
      </div>
    </div>
  )
}

export function DoctorCaseDetailRegion({ children, containerRef, labelledBy }: {
  children: ReactNode
  containerRef?: Ref<HTMLElement>
  labelledBy?: string
}) {
  return <section ref={containerRef} aria-labelledby={labelledBy} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden @max-[400px]/case-detail:gap-0">{children}</section>
}

export function DoctorCasePanel({ children, value }: {
  children: ReactNode
  value: DoctorCaseSection
}) {
  return (
    <TabsContent
      data-agent-section={value}
      value={value}
      className={cn('min-h-0 overflow-y-auto overscroll-contain p-4', value === 'consultation' && 'flex flex-col')}
    >
      {children}
    </TabsContent>
  )
}
