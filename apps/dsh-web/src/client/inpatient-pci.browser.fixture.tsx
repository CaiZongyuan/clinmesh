import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { InpatientWorkspace } from '../../../web/src/app/inpatient-workspace.tsx'
import { InpatientPharmacy } from '../../../web/src/app/inpatient-pharmacy.tsx'
import { getSession } from '../../../web/src/app/api-client.ts'

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('div')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.fontSize = 'large'
container.dataset.theme = 'light'
container.style.cssText = 'display:flex;flex-direction:column;height:100dvh;min-width:0'
shadow.append(container)
void getSession().then(session => {
  createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortalContainerProvider container={container}>{session.actor.roleCode === 'pharmacist' ? <InpatientPharmacy session={session} locale="zh-CN" /> : <InpatientWorkspace session={session} locale="zh-CN" />}</PortalContainerProvider></QueryClientProvider>)
})
