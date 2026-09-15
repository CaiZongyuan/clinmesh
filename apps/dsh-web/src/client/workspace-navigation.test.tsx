// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import {
  createWorkspaceNavigation,
  registerWorkspaceNavigation,
  WorkspaceNavigation,
} from './workspace-navigation.tsx'

it('uses one official launcher cell and restores the native launcher on unload', () => {
  const slots = new SlotCore()
  slots.register(
    { name: 'root', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } } },
    ({ renderSlot }: PropsRenderSlots<'sidebar.footer.action'>) =>
      renderSlot('sidebar.footer.action', { wide: true }),
  )
  const original = () => null
  slots.register({ name: 'sidebar.footer.action', id: 'dsh-react-surface-launcher' }, original)
  const ctx = {
    get: () => ({}),
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: slots.register.bind(slots),
    },
  }
  const dispose = registerWorkspaceNavigation(ctx as unknown as Context, createWorkspaceNavigation())
  expect(slots.entriesOfSlot('sidebar.footer.action')).toHaveLength(1)
  expect(slots.entriesOfSlot('sidebar.footer.action')[0]?.options.label).toBe('医院工作台')
  dispose()
  expect(slots.entriesOfSlot('sidebar.footer.action')).toHaveLength(1)
  expect(slots.entriesOfSlot('sidebar.footer.action')[0]?.component).toBe(original)
})

it('places authorized routes above workspaces, keeps settings in the footer, and cleans up on unload', async () => {
  const navigation = createWorkspaceNavigation()
  const open = vi.fn()
  const openOther = vi.fn()
  const close = vi.fn()
  const navigate = vi.fn()
  const element = document.createElement('div')
  const sidebar = document.createElement('div')
  sidebar.dataset.slot = 'sidebar'
  const newSession = document.createElement('button')
  newSession.textContent = '新会话'
  const workspaceRegion = document.createElement('div')
  const workspaces = document.createElement('div')
  workspaces.dataset.slot = 'sidebar.workspaces'
  workspaceRegion.append(workspaces)
  sidebar.append(newSession, workspaceRegion, element)
  document.body.append(sidebar)
  const root = createRoot(element)
  try {
    await act(() =>
      root.render(
        <WorkspaceNavigation
          navigation={navigation}
          wide={false}
          open={open}
          close={close}
          applications={[{ id: 'reference', title: '参考应用', open: openOther }]}
        />,
      ),
    )
    const shadow = element.querySelector('[data-clinmesh-host-navigation]')?.shadowRoot
    if (!shadow) throw new Error('Missing host navigation')
    const trigger = shadow.querySelector<HTMLButtonElement>('button')!
    expect(trigger.getAttribute('aria-label')).toBe('医院工作台')
    await act(() => trigger.click())
    expect(shadow.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('设置')
    expect(shadow.querySelector('[data-slot="dropdown-menu-label"]')?.textContent).toBe('设置')
    const opener = shadow.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(opener.textContent).toContain('打开 ClinMesh')
    await act(() => opener.click())
    expect(open).toHaveBeenCalledOnce()
    await act(() => trigger.click())
    await act(() =>
      [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === '参考应用')!
        .click(),
    )
    expect(openOther).toHaveBeenCalledOnce()
    await act(() => trigger.click())
    await act(() =>
      [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === '返回 DSH 会话')!
        .click(),
    )
    expect(close).toHaveBeenCalledOnce()
    let release = () => {}
    await act(() => {
      release = navigation.register({
        items: [
          { path: '/registration', label: '门诊挂号' },
          { path: '/settings', label: '通用' },
        ],
        activePath: '/registration',
        locale: 'zh-CN',
        navigate,
      })
    })
    await act(() => trigger.click())
    const items = [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(shadow.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0)
    expect(items.some((item) => item.textContent === '门诊挂号')).toBe(false)
    const routeHost = sidebar.querySelector('[data-clinmesh-host-routes]')!
    expect(newSession.nextElementSibling).toBe(routeHost)
    expect(routeHost.nextElementSibling).toBe(workspaceRegion)
    const route = routeHost.shadowRoot!.querySelector<HTMLButtonElement>('button')!
    expect(route.getAttribute('aria-label')).toBe('门诊挂号')
    expect(route.getAttribute('aria-current')).toBe('page')
    await act(() => route.click())
    expect(navigate).toHaveBeenCalledWith('/registration')
    const settings = items.find((item) => item.textContent === '通用')!
    await act(() => settings.click())
    expect(navigate).toHaveBeenCalledWith('/settings')
    await act(() => root.render(<WorkspaceNavigation navigation={navigation} wide open={open} />))
    expect(routeHost.shadowRoot!.textContent).toContain('门诊挂号')
    open.mockClear()
    navigate.mockClear()
    await act(() => trigger.click())
    const returnToHis = [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === '返回 HIS 页面')
    expect(returnToHis).toBeDefined()
    expect([...shadow.querySelectorAll('[role^="menuitem"]')].at(-1)?.textContent).toBe('返回 HIS 页面')
    await act(() => returnToHis!.click())
    expect(open).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    await act(() => root.render(<WorkspaceNavigation navigation={navigation} wide open={open} active close={close} />))
    await act(() => trigger.click())
    const activeItems = [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(activeItems.some((item) => item.textContent === '返回 HIS 页面')).toBe(false)
    expect(activeItems.some((item) => item.textContent === '返回 DSH 会话')).toBe(true)
    await act(() => trigger.click())
    const replacementRegion = document.createElement('div')
    await act(() => {
      replacementRegion.append(workspaces)
      workspaceRegion.replaceWith(replacementRegion)
    })
    expect(routeHost.nextElementSibling).toBe(replacementRegion)
    expect(replacementRegion.contains(workspaces)).toBe(true)
    const oldState = navigation.getSnapshot()!
    await act(() => release())
    oldState.navigate('/registration')
    expect(navigate).not.toHaveBeenCalled()
    await act(() => trigger.click())
    expect(shadow.textContent).not.toContain('门诊挂号')
    expect(routeHost.shadowRoot!.querySelector('button')).toBeNull()
  } finally {
    await act(() => root.unmount())
    expect(sidebar.querySelector('[data-clinmesh-host-routes]')).toBeNull()
    expect(sidebar.contains(workspaces)).toBe(true)
    sidebar.remove()
  }
})
