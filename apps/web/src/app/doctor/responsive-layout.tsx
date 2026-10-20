import { useEffect, useState, type ReactNode, type Ref } from 'react'
import type { DoctorCaseSection } from '@clinmesh/contracts/agent'
import { Button } from '@clinmesh/ui/components/button'
import { cn } from '@clinmesh/ui/lib/utils'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@clinmesh/ui/components/sheet'
import { SparklesIcon } from 'lucide-react'
import { TabsContent } from '@clinmesh/ui/components/tabs'

export function DoctorWorkspaceLayout({
  children,
  queue,
  selectedCaseId,
  queueLabel,
  detailLabel,
  suggestions,
}: {
  children: ReactNode
  queue: (showDetail: () => void) => ReactNode
  selectedCaseId?: string | undefined
  queueLabel: string
  detailLabel: string
  /** 右侧建议栈：宽容器显示为第三栏，窄容器折叠为抽屉。断点全部由容器查询驱动。 */
  suggestions?: { label: string; node: ReactNode } | undefined
}) {
  const [showQueue, setShowQueue] = useState(selectedCaseId === undefined)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  useEffect(() => setShowQueue(selectedCaseId === undefined), [selectedCaseId])
  const compactHidden = '@max-[720px]/doctor-workspace:hidden'
  return (
    <div className="@container/doctor-workspace relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="@min-[720px]/doctor-workspace:hidden flex gap-2 border-b p-2" role="group" aria-label={queueLabel}>
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
      <div
        className={cn(
          'grid min-h-0 min-w-0 flex-1',
          '@min-[720px]/doctor-workspace:grid-cols-[200px_minmax(0,1fr)]',
          suggestions !== undefined && '@min-[1080px]/doctor-workspace:grid-cols-[200px_minmax(0,1fr)_280px]',
        )}
      >
        <div
          data-doctor-region="queue"
          className={cn('min-h-0 min-w-0 overflow-y-auto border-r', !showQueue && compactHidden)}
        >
          {queue(() => setShowQueue(false))}
        </div>
        <div
          data-doctor-region="detail"
          className={cn('@container/case-detail min-h-0 min-w-0 overflow-hidden', showQueue && compactHidden)}
        >
          {children}
        </div>
        {suggestions !== undefined ? (
          <>
            <aside
              data-doctor-region="suggestions"
              aria-label={suggestions.label}
              className="hidden min-h-0 min-w-0 overflow-y-auto border-l @min-[1080px]/doctor-workspace:block"
            >
              {suggestions.node}
            </aside>
            <Button
              aria-expanded={suggestionsOpen}
              aria-haspopup="dialog"
              className="@min-[1080px]/doctor-workspace:hidden absolute right-4 bottom-4 z-10 shadow-md"
              onClick={() => setSuggestionsOpen(true)}
              size="icon-sm"
              variant="secondary"
            >
              <SparklesIcon />
              <span className="sr-only">{suggestions.label}</span>
            </Button>
            <Sheet onOpenChange={setSuggestionsOpen} open={suggestionsOpen}>
              <SheetContent className="w-80 sm:max-w-80" side="right">
                <SheetHeader>
                  <SheetTitle>{suggestions.label}</SheetTitle>
                </SheetHeader>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                  {suggestions.node}
                </div>
              </SheetContent>
            </Sheet>
          </>
        ) : null}
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

export function DoctorCasePanel({ children, keepMounted = false, value }: {
  children: ReactNode
  value: DoctorCaseSection
  keepMounted?: boolean
}) {
  return (
    <TabsContent
      keepMounted={keepMounted}
      data-agent-section={value}
      value={value}
      className={cn('min-h-0 overflow-y-auto overscroll-contain p-4', value === 'consultation' && 'flex flex-col')}
    >
      {children}
    </TabsContent>
  )
}
