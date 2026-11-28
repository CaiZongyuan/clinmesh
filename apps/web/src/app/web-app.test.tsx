// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebApp, type WebRuntimeOptions } from './web-app.tsx'
import { getRegistrationQueue } from './api-client.ts'
import { usageOverview } from './model-usage.test-fixture.ts'

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

async function renderWebApp(options: {
  history?: RouterHistory
  runtime?: WebRuntimeOptions
} = {}) {
  const rendered = render(<WebApp {...options} />)
  await screen.findByRole('heading', { level: 1 })
  return rendered
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '用户菜单' }))
  await user.click(await screen.findByRole('menuitem', { name: '设置' }))
}

describe('Web application shell', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.removeAttribute('style')
    document.documentElement.className = ''
    document.documentElement.lang = 'zh-CN'
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-size')
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => createMediaQueryList(query)))
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') return Response.json(registrarSession)
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], locations: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/api/his/v1/registration/synthetic-cases') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      if (path === '/api/his/v1/registrations') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the active role workspace without a duplicate overview entry', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    expect(screen.queryByRole('navigation', { name: '岗位导航' })).toBeNull()
    expect(screen.queryByRole('link', { name: '工作台总览' })).toBeNull()
    expect(screen.queryByRole('link', { name: '门诊收费' })).toBeNull()
    expect(screen.queryByRole('img', { name: '科灵脉智标志' })).toBeNull()
    expect(screen.queryByRole('button', { name: '通知' })).toBeNull()
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeTruthy()
    expect(screen.queryByText('外观')).toBeNull()
    expect(screen.queryByRole('button', { name: 'English' })).toBeNull()
    expect(await screen.findByText('暂无挂号记录')).toBeTruthy()
    expect(screen.queryByText('助手未连接')).toBeNull()
    expect(screen.queryByRole('button', { name: '切换导航栏' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    expect(await screen.findByRole('menuitem', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '设置' })).toBeTruthy()
  })

  it('opens model usage from Settings', async () => {
    const initialFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async input => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/model-usage/overview') return Response.json(usageOverview)
      if (path === '/api/model-usage/requests') return Response.json({ items: [], total: 0 })
      return initialFetch(input)
    })
    const user = userEvent.setup()
    await renderWebApp({ history: createMemoryHistory({ initialEntries: ['/settings'] }) })
    await user.click(screen.getByRole('link', { name: '模型用量' }))
    await screen.findByRole('heading', { name: '模型用量', level: 1 })
    expect(screen.getByRole('tab', { name: '用量总览' }).getAttribute('aria-selected')).toBe('true')
  })

  it('refreshes routes after a role change and clears unsubmitted drafts after sign-out', async () => {
    const initialFetch = vi.mocked(fetch).getMockImplementation()!
    let signedOut = false
    let registrar = false
    vi.mocked(fetch).mockImplementation(async input => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/role') {
        registrar = true
        return Response.json(registrarSession)
      }
      if (path === '/api/auth/sign-out') {
        signedOut = true
        return Response.json({})
      }
      if (path === '/api/auth/context') {
        if (signedOut) return Response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in' } }, { status: 401 })
        if (registrar) return Response.json(registrarSession)
        return Response.json({
          ...registrarSession,
          actor: { ...registrarSession.actor, roleCode: 'administrator', practitionerRoleId: 'administrator-role' },
          availableRoles: [
            ...registrarSession.availableRoles,
            { ...registrarSession.availableRoles[0], id: 'administrator-role', code: 'administrator' },
          ],
        })
      }
      return initialFetch(input)
    })
    const user = userEvent.setup()
    await renderWebApp({
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    })
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '挂号员' }))
    await screen.findByRole('heading', { name: '门诊挂号', level: 1 })
    const reviewDraft = 'clinmesh.inpatient-review-draft:v1:unsubmitted'
    const preparedDraft = 'clinmesh.inpatient-review-draft:v1:prepared-before-send'
    const libraryDraft = 'clinmesh.patient-library-visit:v1:unsubmitted'
    const oldQueue = 'clinmesh.inpatient-review-queue:v1:old'
    const originalIntent = 'clinmesh.inpatient-intent:v1:original'
    for (const key of [reviewDraft, preparedDraft, libraryDraft, oldQueue, originalIntent]) sessionStorage.setItem(key, '{}')
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    await screen.findByRole('heading', { name: '登录科灵脉智' })
    expect(sessionStorage.getItem(reviewDraft)).toBeNull()
    expect(sessionStorage.getItem(preparedDraft)).toBeNull()
    expect(sessionStorage.getItem(libraryDraft)).toBeNull()
    expect(sessionStorage.getItem(oldQueue)).toBeNull()
    expect(sessionStorage.getItem(originalIntent)).toBe('{}')
  })

  it('groups the role menu into outpatient, inpatient, and system sections', async () => {
    const initialFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async input => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') {
        return Response.json({
          ...registrarSession,
          availableRoles: [
            registrarSession.availableRoles[0],
            { ...registrarSession.availableRoles[0], id: 'practitioner-role-outpatient-doctor', code: 'outpatient-doctor', practitionerId: 'practitioner-outpatient-doctor', practitionerName: '合成门诊医生' },
            { ...registrarSession.availableRoles[0], id: 'practitioner-role-pharmacist', code: 'pharmacist', practitionerId: 'practitioner-pharmacist', practitionerName: '合成药师' },
            { ...registrarSession.availableRoles[0], id: 'practitioner-role-inpatient-doctor', code: 'inpatient-doctor', practitionerId: 'practitioner-inpatient-doctor', practitionerName: '合成住院医生' },
            { ...registrarSession.availableRoles[0], id: 'practitioner-role-ward-nurse', code: 'ward-nurse', practitionerId: 'practitioner-ward-nurse', practitionerName: '合成病区护士' },
            { ...registrarSession.availableRoles[0], id: 'practitioner-role-administrator', code: 'administrator', practitionerId: 'practitioner-administrator', practitionerName: '合成管理员' },
          ],
        })
      }
      return initialFetch(input)
    })
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    expect(await screen.findByRole('group', { name: '门诊' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '住院' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '系统' })).toBeTruthy()

    const groupText = (label: string): string => (
      screen.getByRole('group', { name: label }).textContent ?? ''
    )
    const outpatient = groupText('门诊')
    expect(outpatient).toContain('挂号员')
    expect(outpatient).toContain('门诊医生')
    expect(outpatient).toContain('药师')
    expect(outpatient).not.toContain('住院医生')
    expect(outpatient).not.toContain('管理员')
    const inpatient = groupText('住院')
    expect(inpatient).toContain('住院医生')
    expect(inpatient).toContain('病区护士')
    expect(inpatient).not.toContain('挂号员')
    const system = groupText('系统')
    expect(system).toContain('管理员')
    expect(system).not.toContain('门诊医生')
    expect(screen.getByRole('menuitemradio', { name: '挂号员' }).getAttribute('aria-checked')).toBe('true')
  })

  it('prompts for sign-in when a business request reports an expired session', async () => {
    const initialFetch = vi.mocked(fetch).getMockImplementation()!
    await renderWebApp({
      history: createMemoryHistory({ initialEntries: ['/registration'] }),
    })
    let respondToOldRequest: (response: Response) => void = () => undefined
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { respondToOldRequest = resolve }))
    const oldRequest = getRegistrationQueue()
    vi.mocked(fetch).mockResolvedValue(Response.json({
      error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in' },
    }, { status: 401 }))

    await act(async () => {
      await expect(getRegistrationQueue()).rejects.toMatchObject({ status: 401 })
    })

    expect(await screen.findByRole('heading', { name: '登录科灵脉智' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '门诊挂号' })).toBeNull()

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/auth/sign-in/email') return Response.json({ user: { id: registrarSession.user.id } })
      return initialFetch(input, init)
    })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('账户邮箱'), registrarSession.user.email)
    await user.type(screen.getByLabelText('账户密码'), 'synthetic-test-password')
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '门诊挂号' })).toBeTruthy()

    await act(async () => {
      respondToOldRequest(Response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in' } }, { status: 401 }))
      await expect(oldRequest).rejects.toMatchObject({ status: 401 })
      // TanStack Query batches observer notifications onto the next task.
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
  })

  it.each([0, 403, 500])('keeps the session after a business error with status %s', async status => {
    await renderWebApp({
      history: createMemoryHistory({ initialEntries: ['/registration'] }),
    })
    if (status === 0) vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    else vi.mocked(fetch).mockResolvedValue(Response.json({
      error: { code: 'REQUEST_FAILED', message: 'Request failed' },
    }, { status }))

    await act(async () => {
      await expect(getRegistrationQueue()).rejects.toMatchObject({ status })
    })

    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '登录科灵脉智' })).toBeNull()
  })

  it('opens the public component catalog without requesting application data', async () => {
    window.history.replaceState(null, '', '/components')

    await renderWebApp()

    expect(screen.getByRole('heading', { level: 1, name: '组件目录' })).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps component theme controls in sync with system changes before an explicit choice', async () => {
    const media = installMatchMedia(false)
    window.history.replaceState(null, '', '/components')
    await renderWebApp()
    expect(document.documentElement.dataset.theme).toBe('light')
    await act(() => media.setPrefersDark(true))
    expect(document.documentElement.dataset.theme).toBe('dark')
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

  it('keeps a single theme entry in settings without duplicating theme controls in the component catalog header', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    expect(screen.getByRole('heading', { name: '组件目录' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '暗色主题' })).toBeNull()
    expect(screen.queryByRole('button', { name: '亮色主题' })).toBeNull()
  })

  it('navigates between role workspaces without reloading the application shell', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '门诊挂号' }))

    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
  })

  it('opens the UI component catalog from the developer settings navigation', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await screen.findByRole('menuitem', { name: '退出登录' })
    expect(screen.getByRole('menuitem', { name: '设置' })).toBeTruthy()
    await user.keyboard('{Escape}')
    await openSettings(user)

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

  it('previews and persists the selected font size from appearance settings', async () => {
    window.history.replaceState(null, '', '/settings')
    const user = userEvent.setup()
    const rendered = await renderWebApp()
    const applicationRoot = document.querySelector<HTMLElement>('[data-clinmesh-app="web"]')

    expect(applicationRoot?.dataset.fontSize).toBe('standard')
    expect(screen.getByRole('group', { name: '字号' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '标准' }).getAttribute('aria-pressed')).toBe('true')

    await user.click(screen.getByRole('button', { name: '较大' }))

    expect(applicationRoot?.dataset.fontSize).toBe('larger')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      fontSize: 'larger',
      locale: 'zh-CN',
      theme: 'system',
    })

    rendered.unmount()
    await renderWebApp()
    expect(document.querySelector<HTMLElement>('[data-clinmesh-app="web"]')?.dataset.fontSize)
      .toBe('larger')
    expect(screen.getByRole('button', { name: '较大' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('localizes the mobile settings navigation dialog', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => (
      createMediaQueryList(query, query === '(max-width: 767px)')
    )))
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/settings')
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置导航' }))

    expect(await screen.findByRole('dialog', { name: '设置导航' })).toBeTruthy()
    expect(screen.getByText('显示移动端设置导航。')).toBeTruthy()
  })

  it('switches the complete shell to English and restores that preference', async () => {
    const user = userEvent.setup()
    const rendered = await renderWebApp()

    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Settings navigation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'User menu' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Font size' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Standard' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Larger' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Large' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'User menu' }))
    expect(await screen.findByRole('menuitem', { name: 'Notifications' })).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      fontSize: 'standard',
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

    await openSettings(user)
    const appearance = screen.getByRole('region', { name: '外观' })
    await user.click(within(appearance).getByRole('button', { name: '暗色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    act(() => media.setPrefersDark(false))
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(within(appearance).getByRole('button', { name: '亮色' }))
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.click(within(appearance).getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      fontSize: 'standard',
      locale: 'zh-CN',
      theme: 'system',
    })
  })

  it('redirects an unauthorized refreshed SPA path to the active role workspace', async () => {
    window.history.replaceState(null, '', '/pharmacy')
    const user = userEvent.setup()

    await renderWebApp()

    expect(await screen.findByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    expect((await screen.findByRole('menuitem', { name: '门诊挂号' })).getAttribute('aria-current')).toBe('page')
  })

  it('opens the notification and user preference menus', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '通知' }))
    expect(await screen.findByText('当前无待处理通知')).toBeTruthy()

    await user.keyboard('{Escape}{Escape}')
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    expect(await screen.findByRole('menuitem', { name: '退出登录' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'English' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: '暗色' })).toBeTruthy()
  })
})
