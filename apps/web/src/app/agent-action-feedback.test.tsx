// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentActionFeedbackProvider, useAgentActionFeedback, type AgentFeedbackScope } from './agent-action-feedback.tsx'
import { WebRuntimeProvider } from './web-runtime.tsx'
import type { AgentActionFeedback } from './surface-agent-tools.ts'
import { ConsultationPage } from './doctor/consultation-page.tsx'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it.each([
  { changed: { chiefComplaint: '新的主诉' }, expected: ['10px'] },
  { changed: { chiefComplaint: '新的主诉', historyOfPresentIllness: '新的现病史' }, expected: ['10px', '20px'] },
  { changed: {}, expected: [] },
])('highlights only clinical record fields changed from the current unsaved values: $expected', ({ changed, expected }) => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(Number(this.getAttribute('data-left') ?? 0), 0, 100, 100)
  })
  let feedback: (event: AgentActionFeedback) => void = () => undefined
  function Harness() {
    feedback = useAgentActionFeedback({ identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'record' })
    return <>
      <input id="clinical-record-case-1-chiefComplaint" aria-label="主诉" defaultValue="原主诉" data-left="10" />
      <textarea id="clinical-record-case-1-historyOfPresentIllness" aria-label="现病史" defaultValue="原现病史" data-left="20" />
      <textarea id="clinical-record-case-1-assessment" aria-label="评估" defaultValue="原评估" data-left="30" />
      <input id="clinical-record-case-2-chiefComplaint" aria-label="其他病例主诉" defaultValue="其他病例" data-left="40" />
    </>
  }
  render(<WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: document.body } }}>
    <AgentActionFeedbackProvider><Harness /></AgentActionFeedbackProvider>
  </WebRuntimeProvider>)
  fireEvent.change(screen.getByLabelText('主诉'), { target: { value: '尚未保存的主诉' } })
  const input = { chiefComplaint: '尚未保存的主诉', historyOfPresentIllness: '原现病史', assessment: '原评估', ...changed }
  const event: AgentActionFeedback = { id: 'record', operationId: 'outpatient.record.draft.set', input, phase: 'executing' }
  const highlighted = () => [...document.querySelectorAll<HTMLElement>('.clinmesh-agent-target')].map(element => element.style.left)
  act(() => feedback(event))
  expect(highlighted()).toEqual(expected)
  fireEvent.change(screen.getByLabelText('主诉'), { target: { value: input.chiefComplaint } })
  fireEvent.change(screen.getByLabelText('现病史'), { target: { value: input.historyOfPresentIllness } })
  act(() => feedback({ ...event, phase: 'completed' }))
  expect(highlighted()).toEqual(expected)
  expect(screen.getByRole('status').textContent).toContain('草稿已更新')
})

it.each([
  { operationId: 'outpatient.section.select', input: { section: 'diagnosis' }, expected: ['14px'] },
  { operationId: 'outpatient.diagnosis.draft.set', input: {}, expected: ['20px', '30px'] },
  { operationId: 'outpatient.prescription.draft.set', input: {}, expected: ['40px', '50px', '60px', '70px'] },
])('highlights the visible work area for $operationId', ({ operationId, input, expected }) => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(Number(this.getAttribute('data-left') ?? 0), 0, 100, 100)
  })
  let feedback: (event: AgentActionFeedback) => void = () => undefined
  function Harness() {
    feedback = useAgentActionFeedback({ identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'diagnosis' })
    return <>
      <button data-agent-selection="diagnosis" data-left="5">诊断标签</button>
      <section data-agent-section="diagnosis" data-left="10">诊断内容</section>
      <button data-agent-catalog-trigger="diagnosis" data-left="20">添加诊断</button>
      <div data-agent-catalog="diagnosis" data-left="30">疾病目录</div>
      <span data-agent-medication-name="" data-left="40">药品名称</span>
      <button data-agent-catalog-trigger="medication" data-left="50">添加药品</button>
      <div data-agent-catalog="medication" data-left="60">药品目录</div>
      <button data-agent-medication-package="" data-left="70">包装</button>
    </>
  }
  render(<WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: document.body } }}>
    <AgentActionFeedbackProvider><Harness /></AgentActionFeedbackProvider>
  </WebRuntimeProvider>)
  act(() => feedback({ id: 'action', operationId, input, phase: 'completed' }))
  expect([...document.querySelectorAll<HTMLElement>('.clinmesh-agent-target')].map(element => element.style.left)).toEqual(expected)
})

it('highlights the consultation region and new reply bubbles without highlighting old messages', () => {
  vi.useFakeTimers()
  const rects = new Map<Element, DOMRect>()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rects.get(this) ?? new DOMRect(0, 0, 600, 600)
  })
  let feedback: (event: AgentActionFeedback) => void = () => undefined
  const messages = getWorkspaceMessages('zh-CN')
  type Consultation = NonNullable<DoctorCaseDetail['consultation']>
  const oldTurn: Consultation['turns'][number] = {
    actorId: null, practitionerId: null,
    id: 'old-patient', kind: 'text', messageText: '之前的患者消息', personaRevision: 1,
    recordedAt: '2026-09-20T09:00:00+08:00', reportReference: null, sequence: 1,
    source: 'persona-opening', speaker: 'patient',
  }
  function Harness({ turns }: { turns: Consultation['turns'] }) {
    feedback = useAgentActionFeedback({ identity: 'session:doctor', view: 'consultation', selection: 'case-1', section: 'consultation' })
    return <ConsultationPage action={{ error: null, onAsk: () => {}, onRetry: () => {}, pending: false }}
      consultation={{ turns, version: turns.length }} locale="zh-CN" messages={messages} patientName="合成患者" readOnly={false} />
  }
  const app = (turns: Consultation['turns']) => <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: document.body } }}>
    <AgentActionFeedbackProvider><Harness turns={turns} /></AgentActionFeedbackProvider>
  </WebRuntimeProvider>
  const view = render(app([oldTurn]))
  rects.set(screen.getByRole('region', { name: '问诊记录' }), new DOMRect(5, 5, 500, 700))
  rects.set(document.querySelector('[data-slot="message-scroller"]')!, new DOMRect(10, 10, 500, 400))
  rects.set(screen.getByText('之前的患者消息').closest('[data-slot="bubble"]')!, new DOMRect(20, 20, 100, 40))
  const event: AgentActionFeedback = { id: 'ask', operationId: 'outpatient.consultation.ask', input: { message: '本次问题' }, phase: 'executing' }
  act(() => feedback(event))
  const highlightedLefts = () => [...document.querySelectorAll<HTMLElement>('.clinmesh-agent-target')].map(element => element.style.left)
  expect(highlightedLefts()).toEqual(['10px'])
  view.rerender(app([
    oldTurn,
    { ...oldTurn, id: 'new-doctor', messageText: '本次问题', sequence: 2, speaker: 'doctor', source: 'doctor-typed', personaRevision: null },
    { ...oldTurn, id: 'new-patient', messageText: '本次回答', sequence: 3, source: 'patient-agent' },
  ]))
  rects.set(screen.getByText('本次问题').closest('[data-slot="bubble"]')!, new DOMRect(30, 60, 100, 40))
  rects.set(screen.getByText('本次回答').closest('[data-slot="bubble"]')!, new DOMRect(40, 100, 100, 40))
  act(() => vi.advanceTimersByTime(100))
  expect(highlightedLefts()).toEqual(['10px', '30px', '40px'])
  act(() => feedback({ ...event, phase: 'completed' }))
  expect(highlightedLefts()).not.toContain('20px')
  act(() => vi.advanceTimersByTime(1400))
  expect(highlightedLefts()).toEqual(['10px', '30px', '40px'])
  expect(document.querySelector('.clinmesh-agent-target')?.getAttribute('data-phase')).toBe('completed')
  act(() => vi.advanceTimersByTime(200))
  expect(document.querySelector('.clinmesh-agent-target')?.getAttribute('data-phase')).toBe('fading')
  act(() => feedback({ ...event, id: 'ask-again', phase: 'completed' }))
  act(() => vi.advanceTimersByTime(1000))
  expect(document.querySelector('.clinmesh-agent-target')?.getAttribute('data-phase')).toBe('completed')
  act(() => vi.advanceTimersByTime(1200))
  expect(highlightedLefts()).toEqual([])
  expect(screen.getByRole('status').textContent).toContain('已完成')
  expect(screen.getByRole('status').children).toHaveLength(1)
  act(() => vi.advanceTimersByTime(1900))
  expect(screen.queryByRole('status')).toBeNull()
})

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
