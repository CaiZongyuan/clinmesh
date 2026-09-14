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

it('opens the application from the collapsed host menu and revokes obsolete actions', async () => {
  const navigation = createWorkspaceNavigation()
  const open = vi.fn()
  const openOther = vi.fn()
  const close = vi.fn()
  const navigate = vi.fn()
  const setTheme = vi.fn()
  const element = document.createElement('div')
  document.body.append(element)
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
        theme: 'system',
        navigate,
        setTheme,
      })
    })
    await act(() => trigger.click())
    const items = [...shadow.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const settings = items.find((item) => item.textContent === '通用')!
    await act(() => settings.click())
    expect(navigate).toHaveBeenCalledWith('/settings')
    const oldState = navigation.getSnapshot()!
    await act(() => release())
    oldState.navigate('/registration')
    oldState.setTheme('dark')
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(setTheme).not.toHaveBeenCalled()
    await act(() => trigger.click())
    expect(shadow.textContent).not.toContain('门诊挂号')
  } finally {
    await act(() => root.unmount())
    element.remove()
  }
})
