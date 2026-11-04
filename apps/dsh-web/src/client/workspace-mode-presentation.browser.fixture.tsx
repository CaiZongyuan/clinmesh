import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Toaster } from '@clinmesh/ui/components/toast'
import { RoleWorkspace } from '../../../web/src/app/role-workspaces.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'
import { getSession } from '../../../web/src/app/api-client.ts'

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('main')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.fontSize = 'standard'
container.dataset.theme = 'light'
container.style.cssText = 'display:flex;flex-direction:column;height:100dvh;min-width:0'
shadow.append(container)
void getSession().then(session => {
  const section = session.actor.roleCode === 'cashier' ? 'billing' : 'pharmacy'
  createRoot(container).render(<WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: container } }}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PortalContainerProvider container={container}><Toaster><RoleWorkspace activeSection={section} locale="zh-CN" session={session} /></Toaster></PortalContainerProvider>
    </QueryClientProvider>
  </WebRuntimeProvider>)
})
