// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeErrorBoundary } from './runtime-error-boundary.tsx'
import { createWebRouter, WebApp, type WebRuntimeOptions } from './web-app.tsx'

describe('RuntimeErrorBoundary', () => {
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

  it('catches an error thrown while composing the production Web application', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = Object.defineProperty({}, 'apiBasePath', {
      get() {
        throw new Error('private WebApp composition detail')
      },
    }) as WebRuntimeOptions

    render(<WebApp runtime={runtime} />)

    expect(screen.getByRole('alert').textContent).toContain('工作台发生错误')
  })

  it('recovers a production route failure without exposing the original error', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rootRoute = createWebRouter().routeTree
    const originalComponent = rootRoute.options.component
    if (originalComponent === undefined) throw new Error('The production root route needs a component')
    let shouldFail = true
    function RecoverableRoute() {
      if (shouldFail) throw new Error('private route failure detail')
      return <p>岗位页面已恢复</p>
    }
    rootRoute.update({ component: RecoverableRoute })
    const toggle = vi.fn()

    try {
      render(<WebApp history={createMemoryHistory({ initialEntries: ['/'] })} runtime={{
        surfaceDisplay: { fullscreen: true, toggle },
      }} />)

      expect((await screen.findByRole('alert')).textContent).toContain('工作台发生错误')
      expect(screen.queryByText('private route failure detail')).toBeNull()
      expect(screen.queryByText('Show Error')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: '返回 DSH 分屏' }))
      expect(toggle).toHaveBeenCalledOnce()
      shouldFail = false
      await userEvent.click(screen.getByRole('button', { name: '重试' }))
      expect(await screen.findByText('岗位页面已恢复')).toBeTruthy()
    } finally {
      rootRoute.update({ component: originalComponent })
    }
  })
})
