import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InpatientStage } from '@clinmesh/contracts/agent'

const ActionContext = createContext<{
  stage: InpatientStage
  element: HTMLDivElement | null
  mount(element: HTMLDivElement | null): void
  register(id: string, priority?: number): void
  selected: string | undefined
} | null>(null)

export function InpatientActionProvider({ stage, children }: { stage: InpatientStage; children: ReactNode }) {
  const [element, mount] = useState<HTMLDivElement | null>(null)
  const [actions, setActions] = useState<Map<string, number>>(() => new Map())
  const register = useCallback((id: string, priority?: number) => setActions(previous => {
    if (previous.get(id) === priority) return previous
    const next = new Map(previous)
    if (priority === undefined) next.delete(id)
    else next.set(id, priority)
    return next
  }), [])
  const selected = [...actions.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0]
  const value = useMemo(() => ({ stage, element, mount, register, selected }), [stage, element, register, selected])
  return <ActionContext.Provider value={value}>{children}</ActionContext.Provider>
}

export function InpatientActionOutlet() {
  const context = useContext(ActionContext)
  return <div ref={context?.mount} />
}

export function InpatientPrimaryAction({ stage, priority = 0, children, fallback }: { stage: InpatientStage; priority?: number; children: ReactNode; fallback?: ReactNode }) {
  const context = useContext(ActionContext), id = useId()
  const active = context?.stage === stage, register = context?.register
  useLayoutEffect(() => {
    if (!active || !register) return
    register(id, priority)
    return () => register(id)
  }, [active, id, priority, register])
  if (!context) return <>{children}</>
  return active && context.selected === id && context.element ? createPortal(children, context.element) : fallback ?? null
}
