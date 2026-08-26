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
    practitionerId: 'practitioner-registrar',
    practitionerName: '合成挂号员',
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

  it('opens the active role workspace without a duplicate overview entry', async () => {
    await renderWebApp()

    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('navigation', { name: '岗位导航' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '工作台总览' })).toBeNull()
    expect(screen.queryByRole('link', { name: '门诊收费' })).toBeNull()
    expect(screen.getByRole('button', { name: '通知' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeTruthy()
    expect(screen.queryByText('外观')).toBeNull()
    expect(screen.queryByRole('button', { name: 'English' })).toBeNull()
    expect(await screen.findByText('暂无挂号记录')).toBeTruthy()
    expect(screen.queryByText(/Agent|AI|助手/i)).toBeNull()
  })

  it('opens the public component catalog without requesting application data', async () => {
    window.history.replaceState(null, '', '/components')

    await renderWebApp()

    expect(screen.getByRole('heading', { level: 1, name: '组件目录' })).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('localizes the public component catalog from the saved Web preference', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'system',
    }))
    window.history.replaceState(null, '', '/components')

    await renderWebApp()

    expect(document.documentElement.lang).toBe('en-US')
    expect(screen.getByRole('heading', { level: 1, name: 'Component catalog' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Controls and forms' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dark theme' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: '组件目录' })).toBeNull()
  })

  it('shows every component group in one continuous column', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    for (const heading of [
      '控件与表单',
      '临床数据与状态',
      '弹层与反馈',
      '基础与导航',
      '会话组件',
    ]) expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: '组件分类' })).toBeNull()
  })

  it('exposes form, validation, loading, and submit states in the component catalog', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    expect(screen.getByRole('textbox', { name: '主诉' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '患者姓名' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('textbox', { name: '初步诊断' }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert', { name: '诊断不能为空' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '正在提交' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('region', { name: '固定提交区' })).toBeTruthy()
  })

  it('shows clinical tables, semantic states, loading, and long Chinese content', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    expect(screen.getByRole('table', { name: '门诊检验结果' })).toBeTruthy()
    expect(screen.getByText('青霉素过敏')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByRole('status', { name: '正在加载病例' })).toBeTruthy()
    expect(screen.getByRole('alert', { name: '处方审查失败' })).toBeTruthy()
    expect(screen.getByText(/请复核同一患者在本次就诊中已开具的全部药品/)).toBeTruthy()
  })

  it('opens catalog feedback, restores dialog focus, and emits a toast', async () => {
    window.history.replaceState(null, '', '/components')
    const user = userEvent.setup()
    await renderWebApp()

    const deleteTrigger = screen.getByRole('button', { name: '删除医嘱' })
    await user.click(deleteTrigger)

    expect(await screen.findByRole('alertdialog', { name: '确认删除医嘱' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '取消删除' }))
    expect(document.activeElement).toBe(deleteTrigger)

    await user.click(screen.getByRole('button', { name: '发送成功反馈' }))
    expect(await screen.findByText('病历已保存')).toBeTruthy()
  })

  it('previews and persists light and dark component themes', async () => {
    window.history.replaceState(null, '', '/components')
    const user = userEvent.setup()
    await renderWebApp()

    const darkTheme = screen.getByRole('button', { name: '暗色主题' })
    await user.click(darkTheme)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(darkTheme.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'zh-CN',
      theme: 'dark',
    })

    await user.click(darkTheme)
    expect(darkTheme.getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(screen.getByRole('button', { name: '亮色主题' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('navigates between role workspaces without reloading the application shell', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('link', { name: '门诊挂号' }))

    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
  })

  it('opens the UI component catalog from the developer settings navigation', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    expect(screen.queryByRole('link', { name: '设置' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))

    expect(window.location.pathname).toBe('/settings')
    expect(screen.getByRole('navigation', { name: '设置导航' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: '通用' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '语言' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'English' })).toBeTruthy()
    expect(screen.getByText('开发者')).toBeTruthy()

    await user.click(screen.getByRole('link', { name: 'UI 组件' }))

    expect(window.location.pathname).toBe('/settings/developer/components')
    expect(screen.getByRole('heading', { level: 1, name: 'UI 组件' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '控件与表单' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: '组件分类' })).toBeNull()
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

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Settings navigation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'User menu' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'en-US',
      theme: 'system',
    })

    rendered.unmount()
    await renderWebApp()
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
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
    expect(await screen.findByRole('menuitem', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'English' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: '暗色' })).toBeTruthy()
  })
})
