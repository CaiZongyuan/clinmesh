// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, createDefinition } from './index.tsx'
import { createWorkspaceNavigation, registerWorkspaceNavigation } from './workspace-navigation.tsx'

describe('ClinMesh React Surface definition', () => {
  it('updates workspace routes, settings and launcher through the same host locale event', async () => {
    const listeners = new Set<() => void>()
    let language = 'zh-CN'
    let Entry: ComponentType<{ wide: boolean }> = () => null
    const snapshot = { activeId: 'clinmesh.his', surfaces: [] }
    const ctx = {
      get(name: string) {
        if (name === 'locale') return {
          getLocale: () => ({ active: language }),
          subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        }
        if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) }
        if (name === 'reactSurfaces') return { getSnapshot: () => snapshot, subscribe: () => () => {}, open() {}, close() {} }
        return { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } }
      },
      on: () => () => {},
      slots: {
        inject: (_name: string, register: () => () => void) => register(),
        register(_entry: unknown, component: ComponentType<{ wide: boolean }>) { Entry = component; return () => {} },
      },
    }
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      actor: { actorId: 'actor-registrar', epoch: 'epoch-1', locationId: 'location-registrar', organizationId: 'organization-clinmesh', practitionerId: 'practitioner-registrar', practitionerRoleId: 'role-registrar', roleCode: 'registrar', scenarioRunId: 'run-1', workspaceId: 'workspace-demo' },
      availableRoles: [{ code: 'registrar', id: 'role-registrar', locationId: 'location-registrar', organizationId: 'organization-clinmesh', practitionerId: 'practitioner-registrar', practitionerName: '合成挂号员' }],
      user: { email: 'registrar@example.test', id: 'user-registrar', name: '合成挂号员' },
    })))
    const container = document.createElement('div')
    container.innerHTML = '<aside data-slot="sidebar"><div><div data-slot="sidebar.workspaces"></div></div><div id="locale-navigation"></div></aside><div id="locale-application"></div>'
    document.body.append(container)
    const entryRoot = createRoot(container.querySelector('#locale-navigation')!)
    const appRoot = createRoot(container.querySelector('#locale-application')!)
    const navigation = createWorkspaceNavigation()
    const dispose = registerWorkspaceNavigation(ctx as unknown as ClientContext, navigation)
    const { component } = createDefinition(ctx as unknown as ClientContext, navigation)
    const props = { active: true, conversationCollapsed: false, agent: { register: () => () => {} }, capabilities: { agent: { available: false, status: 'unavailable' as const } }, close() {}, layout: 'workspace' as const, location: '/settings', navigate() {} }
    try {
      await act(async () => {
        entryRoot.render(createElement(Entry, { wide: true }))
        appRoot.render(createElement(component, props))
      })
      // The real application publishes its authorized routes after the session query settles.
      await vi.waitFor(async () => {
        await act(async () => {})
        expect(navigation.getSnapshot()?.items.some(item => item.label === '门诊挂号')).toBe(true)
      })
      const shadow = container.querySelector('[data-clinmesh-host-navigation]')!.shadowRoot!
      const trigger = shadow.querySelector<HTMLButtonElement>('button')!
      await act(() => trigger.click())
      expect(shadow.textContent).toContain('通用')
      await act(() => {
        language = 'en-US'
        for (const listener of listeners) listener()
      })
      expect(trigger.getAttribute('aria-label')).toBe('Hospital workspace')
      expect(shadow.textContent).toContain('General')
      expect(container.querySelector('[data-clinmesh-host-routes]')!.shadowRoot!.querySelector('button')?.textContent).toBe('Registration')
      expect(container.querySelector('[data-clinmesh-app="web"]')?.textContent).toContain('Font size')
      expect(container.querySelector('[data-clinmesh-app="web"]')?.textContent).not.toContain('Language is managed by DSH')
    } finally {
      await act(() => { appRoot.unmount(); entryRoot.unmount() })
      dispose()
      container.remove()
      localStorage.clear()
      vi.unstubAllGlobals()
    }
    expect(listeners.size).toBe(0)
  })

  it('subscribes the application to the host theme while hidden and releases the subscription on unmount', async () => {
    const listeners = new Set<() => void>()
    const localeListeners = new Set<() => void>()
    let language: unknown = 'en-US'
    let colorScheme: 'light' | 'dark' = 'dark'
    const ctx = {
      get(name: string) {
        if (name === 'theme') return { getTheme: () => ({ active: { colorScheme } }) }
        if (name === 'locale') return {
          getLocale: () => ({ active: language }),
          subscribe(listener: () => void) {
            localeListeners.add(listener)
            return () => { localeListeners.delete(listener) }
          },
        }
        return { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} } }
      },
      on(event: string, listener: () => void) {
        if (event !== 'theme/change') throw new Error(`Unexpected event: ${event}`)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const preferences = JSON.stringify({ fontSize: 'standard', locale: 'en-US', theme: 'light' })
    localStorage.setItem('clinmesh.preferences:v1', preferences)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const { component } = createDefinition(ctx as unknown as ClientContext)
    const props = {
      active: true,
      conversationCollapsed: false,
      agent: { register: () => () => {} },
      capabilities: { agent: { available: false, status: 'unavailable' as const } },
      close() {}, layout: 'workspace' as const, location: '/components', navigate() {},
    }
    try {
      await act(() => root.render(createElement(component, props)))
      const application = container.querySelector<HTMLElement>('[data-clinmesh-app="web"]')!
      expect(application.dataset.theme).toBe('dark')
      expect(application.lang).toBe('en-US')
      await act(() => root.render(createElement(component, { ...props, active: false })))
      await act(() => {
        colorScheme = 'light'
        for (const listener of listeners) listener()
      })
      expect(application.dataset.theme).toBe('light')
      for (const [input, expected] of [
        ['zh-Hans', 'zh-CN'], ['en-GB', 'en-US'], ['fr-FR', 'en-US'],
        [undefined, 'zh-CN'], [123, 'zh-CN'], ['not_a_locale', 'zh-CN'], ['ZH-cn', 'zh-CN'],
      ]) {
        await act(() => {
          language = input
          for (const listener of localeListeners) listener()
        })
        expect(application.lang).toBe(expected)
      }
      await act(() => root.render(createElement(component, props)))
      await act(() => {
        colorScheme = 'dark'
        for (const listener of listeners) listener()
      })
      expect(application.dataset.theme).toBe('dark')
      expect(localStorage.getItem('clinmesh.preferences:v1')).toBe(preferences)
    } finally {
      await act(() => root.unmount())
      container.remove()
      localStorage.clear()
      vi.unstubAllGlobals()
    }
    expect(listeners.size).toBe(0)
    expect(localeListeners.size).toBe(0)
  })

  it('registers the Profile identity before any application is opened and retracts it on unload', () => {
    const occupants = new Map<string, ComponentType<{ size: number }>>()
    const disposers: Array<() => void> = []
    let registered = false
    const ctx = {
      get: () => ({
        list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
      }),
      reactSurfaces: {
        register: () => {
          registered = true
          return () => {
            registered = false
          }
        },
      },
      effect: (callback: () => () => void) => {
        disposers.push(callback())
      },
      slots: {
        inject: (_name: string, register: () => () => void) => register(),
        register: (entry: { name: string }, component: ComponentType<{ size: number }>) => {
          occupants.set(entry.name, component)
          return () => {
            occupants.delete(entry.name)
          }
        },
      },
    }
    apply(ctx as unknown as ClientContext)
    expect(registered).toBe(true)
    expect([...occupants.keys()]).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'sidebar.footer.action',
    ])
    const Mark = occupants.get('sidebar.brand.mark')!
    const Name = occupants.get('sidebar.brand.name')!
    expect(renderToStaticMarkup(createElement(Name, { size: 28 }))).toContain('ClinMesh')
    for (const size of [20, 28]) {
      const mark = renderToStaticMarkup(createElement(Mark, { size }))
      expect(mark).toContain('alt="ClinMesh"')
      expect(mark).toContain(`width="${size}"`)
      expect(mark).toContain(`height="${size}"`)
    }
    for (const dispose of disposers.reverse()) dispose()
    expect(registered).toBe(false)
    expect(occupants.size).toBe(0)
  })

  it('preserves DSH appearance and keeps narrow workspaces side by side', () => {
    const sessions = {
      list: {
        getSnapshot: () => ({ current: undefined }),
        subscribe: () => () => undefined,
      },
    }
    const definition = createDefinition({
      get: () => sessions,
    } as unknown as ClientContext) as unknown as {
      branding: { shell: string; tokens?: Record<string, string> }
      layout: { fallback: string; supported: string[] }
    }

    expect(definition.branding.shell).toBe('preserve')
    expect(definition.branding.tokens).toBeUndefined()
    expect(definition.layout.fallback).toBe('shrink')
    expect(definition.layout.supported).toEqual(['workspace', 'full-frame'])
  })
})
