import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applySurfaceRuntime, type ReactSurfaceRegistry } from 'dsh-react-surface/client'
import { createDefinition } from './index.tsx'

const nativeStore = { create() { throw new Error('The Surface host owns store creation') } }
const nativeSnapshot = { layoutInfo: { rightbar: null, rightbarShown: false, rightbarFullscreen: false, viewportWidth: innerWidth } }
const nativeProps = {
  useStore: <T,>(selector: (state: unknown) => T) => selector(nativeSnapshot),
  actions: { setRightbar() {} },
}
const provided: { registry?: ReactSurfaceRegistry; host?: React.ComponentType<typeof nativeProps> } = {}
const ctx = {
  get reactSurfaces() { return provided.registry },
  get(name: string) {
    if (name === 'reactSurfaces') return provided.registry
    if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) }
    if (name === 'locale') return { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
    if (name === 'uiSession') return { adapter: { current: { getSnapshot: () => ({ key: undefined }), subscribe: () => () => {} } } }
    return {}
  },
  on: () => () => {},
  inject: () => ({ dispose() {} }),
  effect: (callback: () => () => void) => callback(),
  reflect: { provide: (_name: string, registry: ReactSurfaceRegistry) => { provided.registry = registry; return () => {} } },
  slots: {
    entries: () => [{ store: nativeStore }],
    inject: (_name: string, callback: () => () => void) => callback(),
    register: (entry: { name: string; store?: unknown }, component: React.ComponentType<typeof nativeProps>) => {
      if (entry.name === 'shell.overlay') {
        if (entry.store !== nativeStore) throw new Error('Surface must share the native root store')
        provided.host = component
      }
      return () => {}
    },
  },
}

// 只替换宿主端口。真实 upstream registry/host 挂载 createDefinition 的真实 WebApp。
applySurfaceRuntime(ctx as unknown as Context)
const { registry, host: SurfaceHost } = provided
if (registry === undefined || SurfaceHost === undefined) throw new Error('Missing the upstream Surface host')
const definition = createDefinition(ctx as unknown as Context)
registry.register({ ...definition, initialLocation: new URL(location.href).searchParams.get('view') ?? '/consultation' })
const reset = document.createElement('style')
reset.textContent = 'html,body{margin:0}*{box-sizing:border-box}'
document.head.append(reset)
const frame = document.createElement('div')
frame.style.cssText = 'position:relative;display:grid;grid-template-columns:0px minmax(0,1fr) 0px;width:100vw;height:100vh'
frame.innerHTML = '<aside data-pane="sidebar"></aside><main data-pane="conversation">合成宿主会话</main><aside data-rightbar-col></aside><div data-shell-overlay style="position:absolute;inset:0;pointer-events:none"></div>'
document.body.append(frame)
const root = createRoot(frame.querySelector('[data-shell-overlay]')!)
flushSync(() => root.render(<SurfaceHost {...nativeProps} />))
flushSync(() => { registry.open('clinmesh.his'); registry.setLayout('clinmesh.his', 'full-frame') })
