// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, createDefinition } from './index.tsx'

describe('ClinMesh React Surface definition', () => {
  it('subscribes the application to the host theme while hidden and releases the subscription on unmount', async () => {
    const listeners = new Set<() => void>()
    let colorScheme: 'light' | 'dark' = 'dark'
    const ctx = {
      get(name: string) {
        if (name === 'theme') return { getTheme: () => ({ active: { colorScheme } }) }
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
      await act(() => root.render(createElement(component, { ...props, active: false })))
      await act(() => {
        colorScheme = 'light'
        for (const listener of listeners) listener()
      })
      expect(application.dataset.theme).toBe('light')
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
