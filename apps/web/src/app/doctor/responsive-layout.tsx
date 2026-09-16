import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@clinmesh/ui/components/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@clinmesh/ui/components/sheet'
import { useContainerCompact } from '@clinmesh/ui/hooks/use-container-compact'

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
        style={{ gridTemplateColumns: compact ? 'minmax(0, 1fr)' : '240px minmax(0, 1fr)' }}
      >
        <div hidden={compact && !showQueue} className="min-h-0 min-w-0 overflow-y-auto border-r">
          {queue(() => setShowQueue(false))}
        </div>
        <div hidden={compact && showQueue} className="min-h-0 min-w-0 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

export function DoctorCaseLayout({
  children,
  rail,
  contextLabel,
}: {
  children: ReactNode
  rail: (expanded: boolean, onExpandedChange: (expanded: boolean) => void) => ReactNode
  contextLabel: string
}) {
  const { ref, compact } = useContainerCompact(960)
  const [expanded, setExpanded] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  useEffect(() => {
    if (!compact) setSheetOpen(false)
  }, [compact])
  return (
    <div ref={ref} className="flex min-h-full min-w-0 flex-1 flex-col bg-background">
      {compact ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <div className="flex justify-end border-b p-1">
            <SheetTrigger render={<Button size="sm" variant="ghost" />}>
              {contextLabel}
            </SheetTrigger>
          </div>
          <SheetContent className="max-w-full overflow-y-auto" side="right">
            <SheetHeader>
              <SheetTitle>{contextLabel}</SheetTitle>
            </SheetHeader>
            {rail(true, setSheetOpen)}
          </SheetContent>
        </Sheet>
      ) : null}
      <div
        className="grid min-w-0 flex-1"
        style={{
          gridTemplateColumns: compact
            ? 'minmax(0, 1fr)'
            : `minmax(0, 1fr) ${expanded ? '264px' : '44px'}`,
        }}
      >
        <div className="@container/case-content flex min-w-0 flex-col">{children}</div>
        {compact ? null : rail(expanded, setExpanded)}
      </div>
    </div>
  )
}
