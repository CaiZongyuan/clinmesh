// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentReviewProvider,
  useAgentReview,
  type AgentReviewTask,
} from './agent-review.tsx'

describe('ClinMesh Agent review', () => {
  afterEach(cleanup)

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
    expect(await screen.findByRole('alertdialog', { name: '创建患者' })).toBeTruthy()

    act(() => review.cancel('The ClinMesh Agent page scope changed'))

    await rejected
    expect(screen.queryByRole('alertdialog', { name: '创建患者' })).toBeNull()
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
