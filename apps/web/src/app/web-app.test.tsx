// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebApp } from './web-app.tsx'

const registrarSession = {
  actor: {
    actorId: 'actor-registrar',
    epoch: 'epoch-1',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerRoleId: 'practitioner-role-registrar',
    roleCode: 'registrar',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'registrar',
    id: 'practitioner-role-registrar',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
  }],
  user: {
    email: 'registrar@demo.clinmesh.local',
    id: 'user-registrar',
    name: '合成挂号员',
  },
}

function createMediaQueryList(media: string, matches = false): MediaQueryList {
  return {
    matches,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }
}

function installMatchMedia(prefersDark: boolean): { setPrefersDark: (matches: boolean) => void } {
  let darkMatches = prefersDark
  const darkListeners = new Set<EventListenerOrEventListenerObject>()

  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    if (query !== '(prefers-color-scheme: dark)') return createMediaQueryList(query)

    return {
      get matches() {
        return darkMatches
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => darkListeners.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => darkListeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } satisfies MediaQueryList
  }))

  return {
    setPrefersDark(matches) {
      darkMatches = matches
      const event = new Event('change')
      for (const listener of darkListeners) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    },
  }
}

async function renderWebApp() {
  const rendered = render(<WebApp />)
  await screen.findByRole('heading', { level: 1 })
  return rendered
}

describe('Web application shell', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.removeAttribute('style')
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => createMediaQueryList(query)))
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') return Response.json(registrarSession)
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/api/his/v1/registrations') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens in Chinese with role navigation and no Agent surface', async () => {
    await renderWebApp()

    expect(screen.getByRole('heading', { name: '工作台总览' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: '岗位导航' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '门诊收费' })).toBeNull()
    expect(screen.getByRole('button', { name: '通知' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeTruthy()
    expect(await screen.findByText('暂无挂号记录')).toBeTruthy()
    expect(screen.queryByText(/Agent|AI|助手/i)).toBeNull()
  })

  it('navigates between role workspaces without reloading the application shell', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('link', { name: '门诊挂号' }))

    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
  })

  it('localizes the mobile navigation dialog', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => (
      createMediaQueryList(query, query === '(max-width: 767px)')
    )))
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '切换导航栏' }))

    expect(await screen.findByRole('dialog', { name: '岗位导航' })).toBeTruthy()
    expect(screen.getByText('显示移动端岗位导航。')).toBeTruthy()
  })

  it('switches the complete shell to English and restores that preference', async () => {
    const user = userEvent.setup()
    const rendered = await renderWebApp()

    await user.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'Workspace overview' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Role navigation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'User menu' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Registration' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Triage' })).toBeNull()
    expect(screen.queryByRole('link', { name: '门诊挂号' })).toBeNull()
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'en-US',
      theme: 'system',
    })

    rendered.unmount()
    await renderWebApp()
    expect(screen.getByRole('heading', { name: 'Workspace overview' })).toBeTruthy()
  })

  it('follows the system theme and supports explicit light and dark modes', async () => {
    const media = installMatchMedia(true)
    const user = userEvent.setup()
    await renderWebApp()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    act(() => media.setPrefersDark(false))
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.click(screen.getByRole('button', { name: '暗色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    act(() => media.setPrefersDark(false))
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(screen.getByRole('button', { name: '亮色' }))
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.click(screen.getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'zh-CN',
      theme: 'system',
    })
  })

  it('redirects an unauthorized refreshed SPA path to the active role workspace', async () => {
    window.history.replaceState(null, '', '/pharmacy')

    await renderWebApp()

    expect(await screen.findByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('link', { name: '门诊挂号' }).getAttribute('aria-current')).toBe('page')
  })

  it('opens the notification and user preference menus', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '通知' }))
    expect(await screen.findByText('当前无待处理通知')).toBeTruthy()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    expect(await screen.findByRole('menuitemradio', { name: 'English' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: '暗色' })).toBeTruthy()
  })
})
