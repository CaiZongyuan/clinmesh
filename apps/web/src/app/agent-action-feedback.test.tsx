// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentActionFeedbackProvider, useAgentActionFeedback, type AgentFeedbackScope } from './agent-action-feedback.tsx'
import { WebRuntimeProvider } from './web-runtime.tsx'
import type { AgentActionFeedback } from './surface-agent-tools.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps overlapping actions independent, preserves editing, and ignores late results after a patient switch', () => {
  vi.useFakeTimers()
  let feedback: (event: AgentActionFeedback) => void = () => undefined
  function Harness({ scope }: { scope: AgentFeedbackScope }): React.JSX.Element {
    feedback = useAgentActionFeedback(scope)
    return <input aria-label="人工编辑" defaultValue="未保存内容" />
  }
  const scope = { identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'record' }
  const app = (current: AgentFeedbackScope) => <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: document.body } }}>
    <AgentActionFeedbackProvider><Harness scope={current} /></AgentActionFeedbackProvider>
  </WebRuntimeProvider>
  const view = render(app(scope))
  const field = screen.getByLabelText('人工编辑')
  field.focus()
  const event = { id: 'first', operationId: 'outpatient.record.draft.set', input: {}, phase: 'executing' as const }
  act(() => { feedback(event); feedback({ ...event, id: 'second' }) })
  act(() => { feedback({ ...event, phase: 'completed' }); vi.advanceTimersByTime(900) })
  expect(screen.getByRole('status').textContent).toContain('正在操作')
  expect(document.activeElement).toBe(field)
  expect(field.hasAttribute('disabled')).toBe(false)
  const oldFeedback = feedback
  view.rerender(app({ ...scope, selection: 'case-2' }))
  act(() => oldFeedback({ ...event, id: 'second', phase: 'completed' }))
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows completion on the selected target after a real selection transition', () => {
  let feedback: (event: AgentActionFeedback) => void = () => undefined
  function Harness({ scope }: { scope: AgentFeedbackScope }): null { feedback = useAgentActionFeedback(scope); return null }
  const scope = { identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'record' }
  const app = (current: AgentFeedbackScope) => <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: document.body } }}>
    <AgentActionFeedbackProvider><Harness scope={current} /></AgentActionFeedbackProvider>
  </WebRuntimeProvider>
  const view = render(app(scope))
  const event = { id: 'select', operationId: 'outpatient.case.select', input: { caseId: 'case-2' }, phase: 'executing' as const }
  act(() => feedback(event))
  const oldFeedback = feedback
  view.rerender(app({ ...scope, selection: 'case-2' }))
  act(() => oldFeedback({ ...event, phase: 'completed' }))
  expect(screen.getByRole('status').textContent).toContain('已完成')
})
