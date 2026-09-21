import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentActionLabel, agentActionTarget, changedClinicalRecordSelectors } from './agent-action-targets.ts'
import type { AgentActionFeedback } from './surface-agent-tools.ts'
import { useWebRuntime } from './web-runtime.tsx'

export interface AgentFeedbackScope {
  identity: string
  view: string
  selection: string
  section: string
}

interface FeedbackController {
  bind(scope: AgentFeedbackScope): (event: AgentActionFeedback) => void
  setScope(scope: AgentFeedbackScope | undefined): void
}
interface DisplayFeedback extends AgentActionFeedback {
  updatedAt: number
  scope: AgentFeedbackScope
  initialConsultationMessageIds?: ReadonlySet<string>
  recordSelectors?: string[]
}
const FeedbackContext = createContext<FeedbackController | null>(null)

function sameScope(left: AgentFeedbackScope | undefined, right: AgentFeedbackScope): boolean {
  return left?.identity === right.identity && left.view === right.view
    && left.selection === right.selection && left.section === right.section
}

function matchesTransition(event: AgentActionFeedback, source: AgentFeedbackScope, target: AgentFeedbackScope | undefined): boolean {
  if (target?.identity !== source.identity) return false
  const values = event.input as Record<string, unknown>
  if (event.operationId === 'ui.navigate') return target.view === values.destination
  if (!event.operationId.endsWith('.select') || target.view !== source.view) return false
  if (event.operationId === 'outpatient.section.select') return target.selection === source.selection && target.section === values.section
  return target.selection === (values.caseId ?? values.patientId ?? values.chargeItemId ?? values.prescriptionId)
}

export function AgentActionFeedbackProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const runtime = useWebRuntime()
  const appearanceRoot = useRef(runtime.appearanceRoot)
  useLayoutEffect(() => { appearanceRoot.current = runtime.appearanceRoot }, [runtime.appearanceRoot])
  const [events, setEvents] = useState<DisplayFeedback[]>([])
  const currentScope = useRef<AgentFeedbackScope | undefined>(undefined)
  const generation = useRef(0)
  const controller = useMemo<FeedbackController>(() => ({
    setScope(scope) {
      if (scope !== undefined && sameScope(currentScope.current, scope)) return
      const previousScope = currentScope.current
      currentScope.current = scope
      generation.current += 1
      setEvents(previous => previous.flatMap(event => scope !== undefined && event.phase === 'completed'
        && sameScope(previousScope, event.scope) && matchesTransition(event, event.scope, scope)
        ? [{ ...event, scope }] : []))
    },
    bind(scope) {
      let startedGeneration: number | undefined
      return event => {
        const current = currentScope.current
        if (startedGeneration === undefined) {
          if (!sameScope(current, scope)) return
          startedGeneration = generation.current
        }
        const transitioned = matchesTransition(event, scope, current) && generation.current === startedGeneration + 1
        if (!sameScope(current, scope) && !transitioned) return
        if (generation.current !== startedGeneration && !transitioned) return
        const initialMessageIds = event.phase === 'executing' && event.operationId.startsWith('outpatient.consultation.')
          ? new Set([...appearanceRoot.current.current?.querySelectorAll('[data-agent-consultation-message]') ?? []]
            .map(element => element.getAttribute('data-agent-consultation-message')!))
          : undefined
        const changedRecordSelectors = event.phase === 'executing' && event.operationId === 'outpatient.record.draft.set'
          ? changedClinicalRecordSelectors(event.input, scope.selection, appearanceRoot.current.current)
          : undefined
        setEvents(previous => {
          const previousEvent = previous.find(item => item.id === event.id)
          const initialConsultationMessageIds = previousEvent?.initialConsultationMessageIds ?? initialMessageIds
          const recordSelectors = previousEvent?.recordSelectors ?? changedRecordSelectors
          return [
            ...previous.filter(item => item.id !== event.id),
            { ...event, scope: current ?? scope, updatedAt: Date.now(),
              ...(recordSelectors === undefined ? {} : { recordSelectors }),
              ...(initialConsultationMessageIds === undefined ? {} : { initialConsultationMessageIds }) },
          ]
        })
      }
    },
  }), [])
  useEffect(() => {
    if (events.length === 0) return
    const timer = setInterval(() => {
      setEvents(previous => previous.filter(event => {
        if (['executing', 'submitting', 'awaiting-review'].includes(event.phase)) return true
        return Date.now() - event.updatedAt < (event.phase === 'completed' ? 4_000 : 5_000)
      }))
    }, 100)
    return () => clearInterval(timer)
  }, [events.length])
  return (
    <FeedbackContext.Provider value={controller}>
      {children}
      {runtime.mode === 'surface' && events.length > 0 ? (
        <FeedbackDisplay events={events} root={runtime.appearanceRoot.current} />
      ) : null}
    </FeedbackContext.Provider>
  )
}

export function useAgentActionFeedback(scope: AgentFeedbackScope | undefined): (event: AgentActionFeedback) => void {
  const controller = useContext(FeedbackContext)
  const identity = scope?.identity
  const view = scope?.view
  const selection = scope?.selection
  const section = scope?.section
  useLayoutEffect(() => {
    controller?.setScope(scope)
  }, [controller, identity, view, selection, section])
  useEffect(() => () => controller?.setScope(undefined), [controller])
  return useMemo(() => scope === undefined ? () => undefined : controller?.bind(scope) ?? (() => undefined),
    [controller, identity, view, selection, section])
}

function FeedbackDisplay({ events, root }: { events: DisplayFeedback[]; root: HTMLElement | null }): React.JSX.Element {
  const english = root?.lang === 'en-US'
  const overlay = useRef<HTMLDivElement>(null)
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null)
  const [rectangles, setRectangles] = useState<{ key: string; left: number; top: number; width: number; height: number; phase: string }[]>([])
  const measure = useCallback(() => {
    if (root === null || overlay.current === null) return
    const catalogDialog = root.querySelector<HTMLElement>('[role="dialog"][data-agent-catalog]:not([data-closed])')
    setOverlayRoot(catalogDialog)
    const origin = overlay.current.getBoundingClientRect()
    const selected = new Map<Element, DisplayFeedback>()
    // Active operations retain their border when an overlapping operation finishes.
    for (const event of [...events].sort((a, b) => Number(isRunning(a)) - Number(isRunning(b)))) {
      if (event.phase === 'completed' && Date.now() - event.updatedAt >= 2_100) continue
      for (const selector of event.recordSelectors ?? agentActionTarget(event).selectors) {
        for (const element of root.querySelectorAll(selector)) selected.set(element, event)
      }
      if (event.initialConsultationMessageIds !== undefined) {
        for (const element of root.querySelectorAll('[data-agent-consultation-message]')) {
          if (!event.initialConsultationMessageIds.has(element.getAttribute('data-agent-consultation-message')!)) selected.set(element, event)
        }
      }
    }
    const bounds = root.getBoundingClientRect()
    setRectangles([...selected].flatMap(([element, event], index) => {
      if (catalogDialog !== null && !catalogDialog.contains(element)) return []
      const rect = element.getBoundingClientRect()
      let left = Math.max(rect.left, bounds.left, 0)
      let top = Math.max(rect.top, bounds.top, 0)
      let right = Math.min(rect.right, bounds.right, window.innerWidth)
      let bottom = Math.min(rect.bottom, bounds.bottom, window.innerHeight)
      for (let parent = element.parentElement; parent !== null && parent !== root; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const clip = parent.getBoundingClientRect()
        if (style.overflowX !== 'visible') { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
        if (style.overflowY !== 'visible') { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      }
      if (right <= left || bottom <= top) return []
      const phase = event.phase === 'completed' && Date.now() - event.updatedAt >= 1_500 ? 'fading' : event.phase
      return [{ key: element.id || String(index), left: left - origin.left, top: top - origin.top, width: right - left, height: bottom - top, phase }]
    }))
  }, [events, root, overlayRoot])
  useLayoutEffect(() => {
    measure()
    const timer = setInterval(measure, 100)
    return () => clearInterval(timer)
  }, [measure])
  const statusEvents = new Map<string, DisplayFeedback>()
  for (const event of events) {
    statusEvents.set(`${agentActionLabel(event, english)}:${event.phase}:${event.message ?? ''}`, event)
  }
  const status = <div className="clinmesh-agent-feedback" role="status" aria-live="polite">
    {[...statusEvents.values()].map(event => <div key={event.id}>
      <span>{agentActionLabel(event, english)} · {phaseLabel(event, english)}</span>
      {event.message === undefined ? null : <span>：{event.message}</span>}
    </div>)}
  </div>
  const statusRoot = root?.querySelector('[data-agent-feedback-status]')
  const layer = <div ref={overlay} className="clinmesh-agent-overlay" aria-hidden="true">
    {rectangles.map(({ key, phase, ...rect }) => (
      <div className="clinmesh-agent-target" data-phase={phase} key={key} style={rect} />
    ))}
  </div>
  return (
    <>
      {statusRoot === undefined || statusRoot === null ? status : createPortal(status, statusRoot)}
      {overlayRoot === null ? layer : createPortal(layer, overlayRoot)}
    </>
  )
}

function isRunning(event: AgentActionFeedback): boolean {
  return event.phase === 'executing' || event.phase === 'submitting'
}

function phaseLabel(event: AgentActionFeedback, english: boolean): string {
  if (english) {
    switch (event.phase) {
      case 'executing': return 'In progress'
      case 'submitting': return 'Submitting'
      case 'awaiting-review': return 'Awaiting human confirmation'
      case 'completed': return event.operationId.includes('.draft.') ? 'Draft updated; not formally submitted' : 'Completed'
      case 'rejected': return 'Rejected by reviewer'
      case 'failed': return 'Not completed'
      case 'unconfirmed': return 'Outcome unconfirmed'
    }
  }
  switch (event.phase) {
    case 'executing': return '正在操作'
    case 'submitting': return '正在提交'
    case 'awaiting-review': return '待人工确认'
    case 'completed': return event.operationId.includes('.draft.') ? '草稿已更新，尚未正式提交' : '已完成'
    case 'rejected': return '人工已拒绝'
    case 'failed': return '未完成'
    case 'unconfirmed': return '结果尚未确认'
  }
}
