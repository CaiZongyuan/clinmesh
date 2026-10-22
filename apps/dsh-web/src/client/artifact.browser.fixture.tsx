import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import * as surface from './dsh-react-surface.test-stub.ts'
import * as primitives from './dsh-ui-primitives.test-stub.tsx'

type ClientModule = Pick<typeof import('./index.tsx'), 'createDefinition'>
let registered: { id: string; factory: (require: (name: string) => unknown) => ClientModule } | undefined
const modules: Record<string, unknown> = {
  react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM,
  'dsh-react-surface/client': surface, '@deepseek-ai/dsh-client-ui-primitives': primitives,
}
Object.assign(window, { __ModuleLoader__: { load: (module: NonNullable<typeof registered>) => { registered = module } } })

// Replace only host modules and ports. Application code comes from lib/client.js.
window.addEventListener('clinmesh-artifact-mount', () => {
  if (registered?.id !== '@clinmesh/dsh-web') throw new Error('Missing production client registration')
  const client = registered.factory(name => {
    if (!(name in modules)) throw new Error(`Unexpected host module: ${name}`)
    return modules[name]
  })
  const ctx = { get(name: string) {
    if (name === 'uiSession') return { adapter: { current: { getSnapshot: () => ({ key: undefined }), subscribe: () => () => {} } } }
    if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'light' } }) }
    if (name === 'locale') return { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
    return {}
  }, on: () => () => {} }
  const definition = client.createDefinition(ctx as unknown as ClientContext)
  const host = document.createElement('div')
  host.style.cssText = 'height:900px;width:1280px'
  document.body.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const styles = document.createElement('style')
  if (typeof definition.styles !== 'string') throw new Error('Missing production styles')
  styles.textContent = definition.styles
  const container = document.createElement('div')
  container.style.cssText = 'height:100%;min-width:0'
  shadow.append(styles, container)
  createRoot(container).render(React.createElement(definition.component, {
    active: true, agent: { register: () => () => {} },
    capabilities: { agent: { available: false, status: 'unavailable' } },
    close() {}, conversationCollapsed: false, layout: 'workspace', location: '/billing', navigate() {},
  }))
})
