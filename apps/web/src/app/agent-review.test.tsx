// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentReviewProvider,
  useAgentReview,
  type AgentReviewTask,
} from './agent-review.tsx'

describe('ClinMesh Agent review', () => {
  afterEach(cleanup)

  it('rejects a proposal whose signal was already aborted without opening review', async () => {
    let review = {} as ReturnType<typeof useAgentReview>
    function Harness(): null { review = useAgentReview(); return null }
    render(<AgentReviewProvider><Harness /></AgentReviewProvider>)
    const controller = new AbortController()
    controller.abort()
    const task = review.request({ confirmLabel: '签署病历', description: '合成患者',
      onConfirm: () => { throw new Error('An aborted review cannot sign') },
      signal: controller.signal, title: '签署病历' })
    await expect(task.decision).rejects.toThrow('cancelled')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('closes a pending review when its Surface page scope is cancelled', async () => {
    let review = {} as ReturnType<typeof useAgentReview>
    function Harness(): null {
      review = useAgentReview()
      return null
    }
    render(<AgentReviewProvider><Harness /></AgentReviewProvider>)
    let task = {} as AgentReviewTask
    act(() => {
      task = review.request({
        confirmLabel: '创建患者',
        description: '合成患者丁',
        onConfirm: () => ({ created: true }),
        signal: new AbortController().signal,
        title: '创建患者',
      })
    })
    const rejected = expect(task.decision).rejects.toThrow('page scope changed')
    expect(await screen.findByRole('region', { name: '创建患者' })).toBeTruthy()

    act(() => review.cancel('The ClinMesh Agent page scope changed'))

    await rejected
    expect(screen.queryByRole('region', { name: '创建患者' })).toBeNull()
  })

  it('records the human decision before invoking its Command', async () => {
    const order: string[] = []
    let review = {} as ReturnType<typeof useAgentReview>
    function Harness(): null {
      review = useAgentReview()
      return null
    }
    render(<AgentReviewProvider><Harness /></AgentReviewProvider>)
    let task = {} as AgentReviewTask
    act(() => {
      task = review.request({
        confirmLabel: '创建患者',
        description: '合成患者戊',
        onConfirm: () => {
          order.push('command')
          return { created: true }
        },
        signal: new AbortController().signal,
        title: '创建患者',
      })
      task.bindDecisionGate(async decision => {
        order.push(`decision:${decision}`)
      })
    })

    await userEvent.setup().click(await screen.findByRole('button', { name: '创建患者' }))

    await expect(task.decision).resolves.toEqual({ approved: true, data: { created: true } })
    expect(order).toEqual(['decision:approved', 'command'])
  })

  it('rejects through the decision gate on Escape without invoking the Command', async () => {
    let review!: ReturnType<typeof useAgentReview>
    function Harness(): null { review = useAgentReview(); return null }
    render(<AgentReviewProvider><Harness /></AgentReviewProvider>)
    let task!: AgentReviewTask
    const decisions: string[] = []
    let commands = 0
    act(() => {
      task = review.request({ confirmLabel: '创建患者', description: '合成患者', title: '创建患者',
        signal: new AbortController().signal, onConfirm: () => { commands += 1 } })
      task.bindDecisionGate(async decision => { decisions.push(decision) })
    })
    const outcome = task.decision.catch(() => undefined)
    expect(document.activeElement).toBe(await screen.findByRole('button', { name: '创建患者' }))
    await userEvent.setup().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('region', { name: '创建患者' })).toBeNull())
    await expect(outcome).resolves.toEqual({ approved: false })
    expect(decisions).toEqual(['rejected'])
    expect(commands).toBe(0)
  })

  it('keeps focus on the context switch when the old input element is reused', async () => {
    let review!: ReturnType<typeof useAgentReview>
    function Harness() {
      review = useAgentReview()
      const [caseName, setCaseName] = useState('甲')
      return <><label htmlFor="review-note">处方{caseName}审核意见</label><input id="review-note" />
        <button onClick={() => { setCaseName('乙'); review.cancel('The page scope changed') }}>切换处方</button></>
    }
    render(<AgentReviewProvider><Harness /></AgentReviewProvider>)
    const original = screen.getByRole('textbox', { name: '处方甲审核意见' })
    original.focus()
    let task!: AgentReviewTask
    const decisions: string[] = []
    act(() => {
      task = review.request({ confirmLabel: '审核通过', description: '处方甲', title: '处方审核',
        signal: new AbortController().signal, onConfirm: () => { throw new Error('No Command after a scope change') } })
      task.bindDecisionGate(async decision => { decisions.push(decision) })
    })
    const rejected = expect(task.decision).rejects.toThrow('page scope changed')
    const switchButton = screen.getByRole('button', { name: '切换处方' })
    await userEvent.setup().click(switchButton)
    await rejected
    expect(screen.getByRole('textbox', { name: '处方乙审核意见' })).toBe(original)
    expect(document.activeElement).toBe(switchButton)
    expect(decisions).toEqual([])
  })

  it('does not revoke a Command after the approval gate has linearized', async () => {
    let review = {} as ReturnType<typeof useAgentReview>
    let finishCommand: () => void = () => undefined
    const command = new Promise<void>(resolve => {
      finishCommand = resolve
    })
    function Harness(): null {
      review = useAgentReview()
      return null
    }
    render(<AgentReviewProvider><Harness /></AgentReviewProvider>)
    let task = {} as AgentReviewTask
    act(() => {
      task = review.request({
        confirmLabel: '创建患者',
        description: '合成患者己',
        onConfirm: () => command.then(() => ({ created: true })),
        signal: new AbortController().signal,
        title: '创建患者',
      })
      task.bindDecisionGate(async () => undefined)
    })

    await userEvent.setup().click(await screen.findByRole('button', { name: '创建患者' }))
    act(() => review.cancel('The ClinMesh Agent Page Context changed'))
    act(() => finishCommand())

    await expect(task.decision).resolves.toEqual({ approved: true, data: { created: true } })
  })
})
