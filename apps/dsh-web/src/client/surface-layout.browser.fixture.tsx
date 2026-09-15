import { apply as applySurfaceRuntime, type ReactSurfaceRegistry } from 'dsh-react-surface/client'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyClinMesh } from './index.tsx'

async function run() {
  const reset = document.createElement('style')
  reset.textContent = '* { box-sizing: border-box; }'
  document.head.append(reset)
  const provided: { registry?: ReactSurfaceRegistry; host?: React.ComponentType } = {}
  const brandSlots = new Set<string>()
  const ctx = {
    get reactSurfaces() {
      return provided.registry
    },
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
        if (entry.name.startsWith('sidebar.brand.')) brandSlots.add(entry.name)
        return () => {
          brandSlots.delete(entry.name)
        }
      },
    },
  }
  applySurfaceRuntime(ctx as unknown as Context)
  const { registry, host: SurfaceHost } = provided
  if (!registry || !SurfaceHost) throw new Error('Surface runtime did not provide its host')
  applyClinMesh(ctx as unknown as Context)
  const brandsBeforeOpen = [...brandSlots]
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
    controlInHeader:
      shadow.querySelector('button')?.closest('header') !== null,
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
  const returnVisible = shadow.querySelector('button')?.getAttribute('aria-label') === '返回 DSH 分屏'
  shadow.querySelector<HTMLButtonElement>('button')!.click()
  await settle()
  const restored = snapshot()
  const resized = []
  for (const width of [1280, 768, 2048]) {
    frame.style.width = `${width}px`
    await settle()
    resized.push(snapshot())
  }
  const conversation = frame.querySelector<HTMLElement>('main')!
  conversation.innerHTML = '<input aria-label="Native draft" value="kept native draft"><div style="height:1500px">Messages</div>'
  conversation.style.overflow = 'auto'
  conversation.scrollTop = 120
  const details = frame.querySelector<HTMLElement>('[data-rightbar-col]')!
  details.innerHTML = '<div style="visibility:visible"><input aria-label="Selected file" value="synthetic.txt"></div>'
  const collapse = shadow.querySelector<HTMLButtonElement>('[aria-label="收起会话"]')
  if (!collapse) throw new Error('Missing collapse conversation control')
  collapse.click()
  await settle()
  const collapsed = {
    hidden: conversation.inert && details.inert && getComputedStyle(conversation).visibility === 'hidden' && getComputedStyle(details).visibility === 'hidden',
    sidebarActive: !frame.querySelector<HTMLElement>('aside')!.inert,
    right: frame.querySelector<HTMLElement>('[data-dsh-react-surface-layer]')!.style.right,
    expandable: shadow.querySelector('[aria-label="展开会话"]') !== null,
    fileHidden: !details.querySelector('input')!.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  }
  shadow.querySelector<HTMLButtonElement>('[aria-label="全屏 ClinMesh"]')!.click()
  await settle()
  shadow.querySelector<HTMLButtonElement>('[aria-label="返回 DSH 分屏"]')!.click()
  await settle()
  const retainedCollapse = conversation.inert && details.inert
  shadow.querySelector<HTMLButtonElement>('[aria-label="展开会话"]')!.click()
  await settle()
  const expanded = {
    ...snapshot(),
    nativeDraft: conversation.querySelector('input')!.value,
    selectedFile: details.querySelector('input')!.value,
    scrollTop: conversation.scrollTop,
    nativeVisible: !conversation.inert && !details.inert && getComputedStyle(conversation).visibility === 'visible' && getComputedStyle(details).visibility === 'visible',
  }
  shadow.querySelector<HTMLButtonElement>('[aria-label="收起会话"]')!.click()
  await settle()
  flushSync(() => registry.close())
  await settle()
  const closedRestored = !conversation.inert && !details.inert && getComputedStyle(conversation).visibility === 'visible' && getComputedStyle(details).visibility === 'visible'
  const brandsAfterClose = [...brandSlots]
  document.title = btoa(
    JSON.stringify({
      initial,
      fullscreen,
      restored,
      resized,
      returnVisible,
      brandsBeforeOpen,
      brandsAfterClose,
      collapsed,
      retainedCollapse,
      expanded,
      closedRestored,
    }),
  )
}
void run().catch((error) => {
  document.title = btoa(JSON.stringify({ error: String(error) }))
})
