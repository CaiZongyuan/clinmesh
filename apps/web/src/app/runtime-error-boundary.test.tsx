// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeErrorBoundary } from './runtime-error-boundary.tsx'

describe('RuntimeErrorBoundary', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows a localized fallback and remounts the application subtree on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'zh-CN',
      theme: 'system',
    }))
    let shouldFail = true
    function RecoverableApplication() {
      if (shouldFail) {
        throw new Error('private render failure detail')
      }
      return <p>应用已恢复</p>
    }

    render(
      <RuntimeErrorBoundary>
        <RecoverableApplication />
      </RuntimeErrorBoundary>,
    )

    expect(screen.getByRole('alert').textContent).toContain('工作台发生错误')
    shouldFail = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText('应用已恢复')).toBeTruthy()
  })
})
