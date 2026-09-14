// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, createDefinition } from './index.tsx'

describe('ClinMesh React Surface definition', () => {
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
