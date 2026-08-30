// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
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
})
