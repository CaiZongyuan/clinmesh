import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { ReactSurfaceRegistryImpl } from '../../../../vendor/dsh-react-surface/packages/runtime/src/client/registry.ts'
import { ReactSurfaceHost } from '../../../../vendor/dsh-react-surface/packages/runtime/src/client/surface-host.tsx'
import { createDefinition } from './index.tsx'

async function run() {
  const reset = document.createElement('style')
  reset.textContent = '* { box-sizing: border-box; }'
  document.head.append(reset)
  const registry = new ReactSurfaceRegistryImpl()
  registry.preferences.setSize('clinmesh.his', 'conversation', 400)
  const ctx = {
    get(name: string) {
      if (name === 'reactSurfaces') return registry
      if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) }
      return { list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => () => {} } }
    },
    on: () => () => {},
  }
  // The fixture composes the React 18 runtime declaration with the React 19 app declaration.
  registry.register(
    createDefinition(ctx as unknown as Context) as unknown as Parameters<
      typeof registry.register
    >[0],
  )
  const frame = document.createElement('div')
  frame.style.cssText =
    'position:relative;display:grid;grid-template-columns:280px 1fr 300px;width:2048px;height:800px'
  frame.innerHTML =
    '<aside data-pane="sidebar">DSH navigation</aside><main data-pane="conversation">DSH conversation</main><aside data-rightbar-col>DSH files</aside><div data-shell-overlay style="position:absolute;inset:0;pointer-events:none"></div>'
  document.body.append(frame)
  const overlay = frame.querySelector('[data-shell-overlay]')!
  flushSync(() => createRoot(overlay).render(<ReactSurfaceHost registry={registry} />))
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
    mode: frame.getAttribute('data-dsh-react-surface-layout'),
    hiddenNative: frame.querySelector('[data-pane="conversation"]')!.hasAttribute('inert'),
    draft: shadow.querySelector<HTMLInputElement>('input')?.value,
    conversationWidth: frame.querySelector('main')!.getBoundingClientRect().width,
  })
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
