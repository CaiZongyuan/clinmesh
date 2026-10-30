import type { DoctorCaseSection } from '@clinmesh/contracts/agent'
import { TabsContent } from '@clinmesh/ui/components/tabs'
import { cn } from '@clinmesh/ui/lib/utils'
import { type ReactNode, type Ref } from 'react'
import { WorkspaceCardLayout, WorkspaceQueueCard } from '../workspace-card-layout.tsx'
import { outpatientFlow, type OutpatientFlowState } from '../workspace-flow.ts'

export function DoctorWorkspaceLayout({ children, queue, suggestions, action, activeStep, flowState, locale = 'zh-CN' }: {
  children: ReactNode
  queue: (showDetail: () => void) => ReactNode
  selectedCaseId?: string | undefined
  queueLabel: string
  detailLabel: string
  suggestions?: { label: string; node: ReactNode } | undefined
  action?: ReactNode
  locale?: 'zh-CN' | 'en-US'
  activeStep?: string | undefined
  flowState?: OutpatientFlowState | undefined
}) {
  return <WorkspaceCardLayout id="outpatient-doctor" locale={locale} {...(activeStep === undefined ? {} : { activeStep })}
    flow={outpatientFlow(locale, flowState)}
    queue={<WorkspaceQueueCard>{queue(() => undefined)}</WorkspaceQueueCard>}
    aside={suggestions === undefined ? undefined : <aside aria-label={suggestions.label}>{suggestions.node}</aside>}
    action={action}>
    <div data-doctor-region="detail" className="@container/case-detail flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
  </WorkspaceCardLayout>
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
