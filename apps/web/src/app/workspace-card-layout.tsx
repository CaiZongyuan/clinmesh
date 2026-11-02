import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEventHandler, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { CheckIcon, ChevronDownIcon, CircleDotIcon, CircleIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import { Button } from '@clinmesh/ui/components/button'
import { Badge } from '@clinmesh/ui/components/badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { cn } from '@clinmesh/ui/lib/utils'
import { AgentReviewOutlet, useAgentReviewPending } from './agent-review.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

// queueNarrow and queueOverlayOpen describe the overlay queue below queueOverlayWidth; queueCollapsed is the wide-layout choice.
interface WorkspaceCardView { queueCollapsed: boolean; queueNarrow: boolean; queueOverlayOpen: boolean; moreExpanded: boolean; tab?: string }
const emptyView: WorkspaceCardView = { queueCollapsed: false, queueNarrow: false, queueOverlayOpen: false, moreExpanded: false }
const useCardViews = create<{ views: Record<string, WorkspaceCardView>; update(id: string, value: Partial<WorkspaceCardView>): void }>(set => ({
  views: {},
  update: (id, value) => set(state => ({ views: { ...state.views, [id]: { ...emptyView, ...state.views[id], ...value } } })),
}))

export function useWorkspaceCardView(id: string) {
  const view = useCardViews(state => state.views[id] ?? emptyView)
  const update = useCardViews(state => state.update)
  const setQueueCollapsed = useCallback((queueCollapsed: boolean) => update(id, { queueCollapsed }), [id, update])
  const setMoreExpanded = useCallback((moreExpanded: boolean) => update(id, { moreExpanded }), [id, update])
  const setTab = useCallback((tab: string) => update(id, { tab }), [id, update])
  const queueShown = view.queueNarrow ? view.queueOverlayOpen : !view.queueCollapsed
  return { ...view, queueShown, setQueueCollapsed, setMoreExpanded, setTab }
}

const WorkspaceLocaleContext = createContext<WorkspaceLocale>('zh-CN')
type HeaderSlot = 'patient' | 'lead' | 'flow'
const HeaderSlotsContext = createContext<{ elements: Partial<Record<HeaderSlot, HTMLElement>>; register(slot: HeaderSlot, element: HTMLElement | null): void } | null>(null)

export function WorkspaceHeaderProvider({ children }: { children: ReactNode }) {
  const [elements, setElements] = useState<Partial<Record<HeaderSlot, HTMLElement>>>({})
  const register = useCallback((slot: HeaderSlot, element: HTMLElement | null) => setElements(previous => {
    if ((previous[slot] ?? null) === element) return previous
    const next = { ...previous }
    if (element) next[slot] = element
    else delete next[slot]
    return next
  }), [])
  const value = useMemo(() => ({ elements, register }), [elements, register])
  return <HeaderSlotsContext.Provider value={value}>{children}</HeaderSlotsContext.Provider>
}

function useHeaderSlotRef(slot: HeaderSlot) {
  const context = useContext(HeaderSlotsContext)
  const register = context?.register
  return useCallback((element: HTMLElement | null) => register?.(slot, element), [register, slot])
}

export function WorkspaceHeaderPatientSlot() {
  return <div ref={useHeaderSlotRef('patient')} className="min-w-0 max-w-[30%] shrink truncate text-sm text-muted-foreground" />
}
export function WorkspaceHeaderLeadSlot() { return <div ref={useHeaderSlotRef('lead')} className="flex shrink-0 empty:hidden" /> }
export function WorkspaceHeaderFlowSlot() { return <div ref={useHeaderSlotRef('flow')} className="clinmesh-header-flow flex min-w-0 flex-1 @max-[40rem]/workspace-header:hidden" /> }

export function WorkspaceHeaderPatient({ children }: { children: ReactNode }) {
  const element = useContext(HeaderSlotsContext)?.elements.patient
  return element ? createPortal(children, element) : null
}

export interface WorkspaceFlowStep {
  value: string
  label: string
  status?: 'completed' | 'current' | 'pending'
}

export interface WorkspaceCardLayoutProps {
  id: string
  queue?: ReactNode
  patient?: ReactNode
  tabs?: ReactNode
  action?: ReactNode
  flow?: readonly WorkspaceFlowStep[]
  activeStep?: string
  locale?: WorkspaceLocale
  children: ReactNode
}

// Below this Surface width the main card would drop under ~520px beside the queue, so the queue becomes an overlay.
const queueOverlayWidth = 800

function WorkspaceFlow({ flow, activeStep, locale }: { flow: readonly WorkspaceFlowStep[]; activeStep?: string | undefined; locale: WorkspaceLocale }) {
  const host = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLOListElement>(null)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const element = host.current, full = measure.current
    if (!element || !full) return
    const update = () => setCompact(full.scrollWidth > element.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [flow])
  const current = flow.findIndex(step => step.value === activeStep || step.status === 'current')
  const steps = (hidden: boolean) => flow.map((step, index) => <li key={step.value} title={step.label} data-status={step.status}
    aria-current={!hidden && index === current ? 'step' : undefined}>
    {step.status === 'completed' ? <CheckIcon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
    <span className={!hidden && compact && index !== current ? 'sr-only' : undefined}>{step.label}</span>
  </li>)
  return <div ref={host} className="clinmesh-card-flow-steps">
    <ol aria-label={locale === 'zh-CN' ? '办理流程' : 'Care workflow'} data-compact={compact || undefined}>{steps(false)}</ol>
    {compact && current >= 0 ? <span className="clinmesh-card-flow-count" aria-hidden="true">{current + 1}/{flow.length}</span> : null}
    <ol ref={measure} className="clinmesh-card-flow-measure" aria-hidden="true">{steps(true)}</ol>
  </div>
}

export function WorkspaceCardLayout({ id, queue, patient, tabs, action, flow, activeStep, locale = 'zh-CN', children }: WorkspaceCardLayoutProps) {
  const view = useWorkspaceCardView(id), { queueCollapsed, setQueueCollapsed } = view
  const update = useCardViews(state => state.update)
  const reviewing = useAgentReviewPending()
  const header = useContext(HeaderSlotsContext)?.elements
  const section = useRef<HTMLElement>(null)
  const narrow = view.queueNarrow, overlayOpen = view.queueOverlayOpen
  const setOverlayOpen = useCallback((queueOverlayOpen: boolean) => update(id, { queueOverlayOpen }), [id, update])
  useLayoutEffect(() => {
    const element = section.current
    if (!element) return
    const measure = () => {
      // A zero width means no layout yet (or jsdom); keep the wide default until a real width arrives.
      const queueNarrow = element.clientWidth > 0 && element.clientWidth < queueOverlayWidth
      if (queueNarrow !== (useCardViews.getState().views[id]?.queueNarrow ?? false)) update(id, { queueNarrow, queueOverlayOpen: false })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [id, update])
  const queueShown = Boolean(queue) && view.queueShown
  const ToggleIcon = queueShown ? PanelLeftCloseIcon : PanelLeftOpenIcon
  const toggleLabel = locale === 'zh-CN' ? queueShown ? '收起队列' : '展开队列' : queueShown ? 'Hide queue' : 'Show queue'
  const toggle = queue ? <Button type="button" variant="ghost" size="icon" aria-label={toggleLabel} title={toggleLabel} aria-expanded={queueShown}
    onClick={() => narrow ? setOverlayOpen(!overlayOpen) : setQueueCollapsed(!queueCollapsed)}><ToggleIcon aria-hidden="true" /></Button> : null
  const flowSteps = flow?.length ? <WorkspaceFlow flow={flow} activeStep={activeStep} locale={locale} /> : null
  const inHeader = Boolean(header?.lead && header.flow)
  return <WorkspaceLocaleContext.Provider value={locale}>
    <section ref={section} className="clinmesh-card-workspace" data-workspace-id={id}
      onKeyDown={narrow && overlayOpen ? event => { if (event.key === 'Escape') { event.stopPropagation(); setOverlayOpen(false) } } : undefined}>
      {inHeader
        ? <>{toggle ? createPortal(toggle, header!.lead!) : null}{flowSteps ? createPortal(flowSteps, header!.flow!) : null}</>
        : toggle || flowSteps ? <div className="clinmesh-card-flow">{toggle}{flowSteps}</div> : null}
      <div className="clinmesh-card-columns" data-has-queue={queueShown && !narrow || undefined}>
        {queueShown ? <div className="clinmesh-card-queue" data-overlay={narrow || undefined}
          onClick={narrow ? event => {
            // Choosing a patient in the overlay returns the full width to the main card.
            if (event.target instanceof Element && event.target.closest('[data-workspace-queue-items] :is(button, a, [role="option"])')) setOverlayOpen(false)
          } : undefined}>{queue}</div> : null}
        {narrow && queueShown ? <div className="clinmesh-card-scrim" aria-hidden="true" onClick={() => setOverlayOpen(false)} /> : null}
        <div className="clinmesh-card-main">
          {patient ? <div className="clinmesh-card-patient">{patient}</div> : null}
          {tabs}
          <div className="clinmesh-card-content">{children}</div>
          {!reviewing ? action : null}
          <AgentReviewOutlet />
        </div>
      </div>
    </section>
  </WorkspaceLocaleContext.Provider>
}

interface WorkspaceCardProps { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }

export function WorkspaceCard({ title, description, actions, children, className }: WorkspaceCardProps) {
  return <Card className={cn('min-w-0 shadow-none', className)}>
    {title || description || actions ? <CardHeader>
      {title ? <CardTitle>{typeof title === 'string' ? <h2>{title}</h2> : title}</CardTitle> : null}
      {description ? <CardDescription>{description}</CardDescription> : null}
      {actions ? <CardAction>{actions}</CardAction> : null}
    </CardHeader> : null}
    <CardContent className="min-w-0">{children}</CardContent>
  </Card>
}

export function WorkspaceQueueCard(props: WorkspaceCardProps) { return <WorkspaceCard {...props} /> }
export function WorkspacePatientCard({ title, ...props }: WorkspaceCardProps) {
  return <><WorkspaceHeaderPatient>{title}</WorkspaceHeaderPatient><WorkspaceCard title={title} {...props} /></>
}

export function useWorkspaceConfirmation({ open, pending, disabled, scope, onCancel }: {
  open: boolean; pending: boolean; disabled: boolean; scope: string; onCancel(): void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const origin = useRef<HTMLButtonElement | null>(null)
  const openedScope = useRef<string | undefined>(undefined)
  const captureTrigger = () => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    origin.current = active instanceof HTMLButtonElement ? active : null
  }
  const confirmRef = useCallback((node: HTMLButtonElement | null) => {
    // 底栏可能等其他主操作结束后才挂载，按钮就绪时再转移焦点。
    if (!node || !open || pending) return
    if (!disabled && !node.disabled) node.focus()
    else node.parentElement?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [open, pending, disabled, scope])
  useLayoutEffect(() => {
    if (open) openedScope.current = scope
    else if (openedScope.current !== undefined) {
      if (openedScope.current === scope) {
        const target = origin.current?.isConnected ? origin.current : triggerRef.current
        target?.focus({ preventScroll: true })
      }
      openedScope.current = undefined
      origin.current = null
    }
  }, [open, scope])
  const onKeyDown: KeyboardEventHandler<HTMLElement> = event => {
    if (event.key === 'Escape' && open && !pending) { event.preventDefault(); event.stopPropagation(); onCancel() }
  }
  return { triggerRef, confirmRef, captureTrigger, onKeyDown }
}

export function WorkspaceActionBar({ summary, reason, action, tone = 'normal', onKeyDown }: {
  summary?: ReactNode
  reason?: ReactNode
  action?: ReactNode
  tone?: 'normal' | 'blocked' | 'complete' | 'confirm' | 'assistant'
  onKeyDown?: KeyboardEventHandler<HTMLElement>
}) {
  const locale = useContext(WorkspaceLocaleContext)
  if (!action && tone !== 'complete') return null
  return <section role="region" aria-label={locale === 'zh-CN' ? '当前操作' : 'Current action'} className="clinmesh-card-action" data-tone={tone} onKeyDown={onKeyDown}>
    {summary ? <div className="tabular-nums">{summary}</div> : null}
    <div className="min-w-0 flex-1" role={tone === 'blocked' ? 'status' : undefined}>{reason}</div>
    {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
  </section>
}

export function AgentDraftField({ assisted, onUserEdit, locale = 'zh-CN', children }: {
  assisted: boolean; onUserEdit?: () => void; locale?: WorkspaceLocale; children: ReactNode
}) {
  return <div className="clinmesh-agent-draft-field" data-agent-draft-source={assisted ? 'assistant' : undefined}
    onInputCapture={assisted ? onUserEdit : undefined} onChangeCapture={assisted ? onUserEdit : undefined}>
    {children}
    {assisted ? <Badge className="clinmesh-agent-draft-label" variant="outline">{locale === 'zh-CN' ? '助手' : 'Assistant'}</Badge> : null}
  </div>
}

export interface WorkspaceTabItem {
  value: string
  label: string
  status?: 'completed' | 'current' | 'pending' | 'blocked'
  count?: number
  /** 该页签内助手准备、待人确认的条数，蓝色标记，和待办数分开。 */
  assistant?: number
  group?: string
  more?: boolean
}

export function WorkspaceTabs({ id, items, value, onValueChange, locale = 'zh-CN', children }: {
  id: string; items: readonly WorkspaceTabItem[]; value: string; onValueChange(value: string): void; locale?: WorkspaceLocale; children?: ReactNode
}) {
  const { moreExpanded, setMoreExpanded, setTab } = useWorkspaceCardView(id)
  const host = useRef<HTMLDivElement>(null)
  const measures = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => items.map(item => item.value))
  useLayoutEffect(() => {
    const element = host.current, measure = measures.current
    if (!element || !measure) return
    const update = () => {
      const widths = new Map([...measure.querySelectorAll<HTMLElement>('[data-tab-measure]')].map(item => [item.dataset.tabMeasure!, item.getBoundingClientRect().width]))
      const primary = items.filter(item => !item.more || item.value === value)
      const available = element.clientWidth
      const total = primary.reduce((sum, item) => sum + (widths.get(item.value) ?? 0) + 4, 0)
      const needsMore = items.some(item => item.more && item.value !== value) || total > available
      let remaining = available - (needsMore ? (measure.lastElementChild?.getBoundingClientRect().width ?? 72) + 8 : 0)
      const next: string[] = []
      for (const item of primary) {
        const width = (widths.get(item.value) ?? 0) + 4
        if (remaining < width) continue
        next.push(item.value)
        remaining -= width
      }
      if (!next.includes(value) && items.some(item => item.value === value)) {
        const width = (widths.get(value) ?? 0) + 4
        while (next.length && remaining < width) remaining += (widths.get(next.pop()!) ?? 0) + 4
        next.push(value)
      }
      setVisible(previous => previous.length === next.length && previous.every((item, index) => item === next[index]) ? previous : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    for (const child of measure.children) observer.observe(child)
    return () => observer.disconnect()
  }, [items, value])
  const hidden = items.some(item => !visible.includes(item.value))
  const shown = moreExpanded ? items : items.filter(item => visible.includes(item.value))
  const groups = [...new Set(shown.map(item => items.length > 3 ? item.group ?? '' : ''))]
  const content = (item: WorkspaceTabItem) => <>
    {item.status === 'completed' ? <CheckIcon aria-hidden="true" /> : item.status === 'current' ? <CircleDotIcon aria-hidden="true" /> : item.status ? <CircleIcon aria-hidden="true" /> : null}
    <span>{item.label}</span>{item.count !== undefined ? <Badge aria-hidden="true" variant="secondary">{item.count}</Badge> : null}
    {item.assistant ? <Badge aria-hidden="true" variant="outline" className="border-info/40 text-info">{locale === 'zh-CN' ? '助手' : 'Assistant'} {item.assistant}</Badge> : null}
  </>
  const renderTab = (item: WorkspaceTabItem) => <TabsTrigger key={item.value} id={`${id}-${item.value}`} value={item.value}
    aria-label={item.label} aria-describedby={item.status || item.count !== undefined || item.assistant ? `${id}-${item.value}-status` : undefined} className="flex-none">
    {content(item)}
    <span id={`${id}-${item.value}-status`} className="sr-only">
      {item.status ? locale === 'zh-CN'
        ? { completed: '已完成', current: '正在办理', pending: '待办理', blocked: '受阻' }[item.status]
        : { completed: 'Completed', current: 'In progress', pending: 'Pending', blocked: 'Blocked' }[item.status] : ''}
      {item.count !== undefined ? locale === 'zh-CN' ? `，待办 ${item.count} 项` : `, ${item.count} pending` : ''}
      {item.assistant ? locale === 'zh-CN' ? `，助手建议 ${item.assistant} 条` : `, ${item.assistant} assistant suggestions` : ''}
    </span>
  </TabsTrigger>
  return <div ref={host} className="clinmesh-workspace-tabs" data-has-panels={Boolean(children) || undefined}>
    <Tabs value={value} onValueChange={next => { if (typeof next === 'string') { setTab(next); onValueChange(next) } }}>
      <div className="flex min-w-0 items-end gap-2">
        <TabsList variant="line" className="clinmesh-workspace-tabs-list" aria-label={locale === 'zh-CN' ? '工作分区' : 'Work sections'}>
          {groups.map(group => <div key={group} className="clinmesh-workspace-tab-group" role={group ? 'group' : undefined} aria-label={group || undefined}>
            {group ? <span className="text-xs text-muted-foreground">{group}</span> : null}
            <div className="flex min-w-0 flex-wrap gap-1">{shown.filter(item => (items.length > 3 ? item.group ?? '' : '') === group).map(renderTab)}</div>
          </div>)}
          <div hidden aria-hidden="true">{items.filter(item => !shown.includes(item)).map(renderTab)}</div>
        </TabsList>
        {hidden || moreExpanded ? <Button size="sm" variant="ghost" aria-expanded={moreExpanded} onClick={() => setMoreExpanded(!moreExpanded)}>
          {locale === 'zh-CN' ? moreExpanded ? '收起' : '更多' : moreExpanded ? 'Less' : 'More'}<ChevronDownIcon aria-hidden="true" data-icon="inline-end" />
        </Button> : null}
      </div>
      {children}
    </Tabs>
    <div ref={measures} className="clinmesh-workspace-tab-measures" aria-hidden="true">
      {items.map(item => <span data-tab-measure={item.value} key={item.value}>{content(item)}</span>)}
      <span>{locale === 'zh-CN' ? '更多' : 'More'}<ChevronDownIcon aria-hidden="true" /></span>
    </div>
  </div>
}
