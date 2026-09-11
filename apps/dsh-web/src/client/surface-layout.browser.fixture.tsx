import { apply as applySurfaceRuntime, type ReactSurfaceRegistry } from 'dsh-react-surface/client'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { createDefinition } from './index.tsx'

async function run() {
  const reset = document.createElement('style')
  reset.textContent = '* { box-sizing: border-box; }'
  document.head.append(reset)
  const provided: { registry?: ReactSurfaceRegistry; host?: React.ComponentType } = {}
  const ctx = {
    get(name: string) {
      if (name === 'reactSurfaces') return provided.registry
      if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) }
      return { list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => () => {} } }
    },
    on: () => () => {},
    effect: (callback: () => () => void) => callback(),
    inject: () => ({ dispose() {} }),
    reflect: {
      provide: (_name: string, registry: ReactSurfaceRegistry) => {
        provided.registry = registry
        return () => {}
      },
    },
    slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (entry: { name: string }, component: React.ComponentType) => {
        if (entry.name === 'shell.overlay') provided.host = component
        return () => {}
      },
    },
  }
  applySurfaceRuntime(ctx as unknown as Context)
  const { registry, host: SurfaceHost } = provided
  if (!registry || !SurfaceHost) throw new Error('Surface runtime did not provide its host')
  registry.register(createDefinition(ctx as unknown as Context))
  const frame = document.createElement('div')
  frame.style.cssText =
    'position:relative;display:grid;grid-template-columns:280px 1fr 300px;width:2048px;height:800px'
  frame.innerHTML =
    '<aside data-pane="sidebar">DSH navigation</aside><main data-pane="conversation">DSH conversation</main><aside data-rightbar-col>DSH files</aside><div data-shell-overlay style="position:absolute;inset:0;pointer-events:none"></div>'
  document.body.append(frame)
  const overlay = frame.querySelector('[data-shell-overlay]')!
  flushSync(() => createRoot(overlay).render(<SurfaceHost />))
  const settle = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
    )
  flushSync(() => registry.open('clinmesh.his'))
  await settle()
  const shadow = frame.querySelector('[data-surface-id]')!.shadowRoot!
  const draft = shadow.querySelector<HTMLInputElement>('input')!
  draft.value = 'kept clinical draft'
  const snapshot = () => ({
    controlInSidebar: shadow.querySelector('button')?.closest('[data-slot="sidebar-footer"]') !== null,
    hasTopToolbar: shadow.querySelector('[role="toolbar"]') !== null,
    mode: frame.getAttribute('data-dsh-react-surface-layout'),
    hiddenNative: frame.querySelector('[data-pane="conversation"]')!.hasAttribute('inert'),
    draft: shadow.querySelector<HTMLInputElement>('input')?.value,
    conversationWidth: frame.querySelector('main')!.getBoundingClientRect().width,
  })
  const handle = frame.querySelector('[role=separator]')!
  for (let i = 0; i < 3; i++) {
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await settle()
  }
  const initial = snapshot()
  shadow.querySelector<HTMLButtonElement>('button')!.click()
  await settle()
  const fullscreen = snapshot()
  const returnVisible = shadow.querySelector('button')?.textContent === '返回 DSH 分屏'
  shadow.querySelector<HTMLButtonElement>('button')!.click()
  await settle()
  const restored = snapshot()
  const resized = []
  for (const width of [1280, 768, 2048]) {
    frame.style.width = `${width}px`
    await settle()
    resized.push(snapshot())
  }
  document.title = btoa(JSON.stringify({ initial, fullscreen, restored, resized, returnVisible }))
}
void run().catch((error) => {
  document.title = btoa(JSON.stringify({ error: String(error) }))
})
