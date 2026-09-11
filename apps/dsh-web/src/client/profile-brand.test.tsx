// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { registerProfileBrand } from './profile-brand.tsx'

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('brands the new-session hero and restores its native headline when removed', async () => {
  const entries = new Map<string, ComponentType<{ size: number }>>()
  const listeners = new Set<() => void>()
  let active = 'zh'
  const locale = {
    getLocale: () => ({ active }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const ctx = {
    get: () => locale,
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (entry: { name: string }, component: ComponentType<{ size: number }>) => {
        entries.set(entry.name, component)
        return () => entries.delete(entry.name)
      },
    },
  }
  const dispose = registerProfileBrand(ctx as unknown as Context)
  const entry = entries.get('conversation.hero.brand.mark')
  expect(entry).toBeDefined()
  if (!entry) throw new Error('Missing hero brand registration')
  const Hero: ComponentType<{ size: number }> = entry
  function Host({ title, branded = true }: { title: string; branded?: boolean }) {
    return (
      <div>
        <span>
          <div data-slot="conversation.hero.brand.mark">{branded ? <Hero size={34} /> : null}</div>
        </span>
        <span>
          <span data-testid="headline">{title}</span>
          <span>预览版</span>
        </span>
        <input aria-label="Message" defaultValue="kept draft" />
      </div>
    )
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const result = { rerender: (element: React.ReactNode) => act(() => root!.render(element)) }
  result.rerender(<Host title="探索未至之境" />)
  expect(container.querySelector('[data-testid=headline]')!.textContent).toBe('医疗智能体平台')
  expect(container.querySelector('img[alt=ClinMesh]')!.getAttribute('width')).toBe('34')
  act(() => {
    active = 'en'
    for (const listener of listeners) listener()
  })
  result.rerender(<Host title="Into the Unknown" />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(container.querySelector('[data-testid=headline]')!.textContent).toBe(
    'Medical AI Agent Platform',
  )
  expect(container.textContent).toContain('预览版')
  expect(container.querySelector('input')!.value).toBe('kept draft')
  result.rerender(<Host title="Into the Unknown" branded={false} />)
  expect(container.querySelector('[data-testid=headline]')!.textContent).toBe('Into the Unknown')
  dispose()
  expect(entries.size).toBe(0)
  expect(listeners.size).toBe(0)
})
