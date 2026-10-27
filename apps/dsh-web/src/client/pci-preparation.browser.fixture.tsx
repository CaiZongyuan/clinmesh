import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { getSession } from '../../../web/src/app/api-client.ts'
import { InpatientWorkspace } from '../../../web/src/app/inpatient-workspace.tsx'
import { SyntheticPatientLibrary } from '../../../web/src/app/synthetic-patient-library.tsx'

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('div')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.theme = 'light'
container.style.cssText = 'display:flex;flex-direction:column;min-height:100dvh;min-width:0'
shadow.append(container)
void getSession().then(session => {
  createRoot(container).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <PortalContainerProvider container={container}>
        {session.actor.roleCode === 'administrator'
          ? <SyntheticPatientLibrary locale="zh-CN" session={session} />
          : <InpatientWorkspace locale="zh-CN" session={session} />}
      </PortalContainerProvider>
    </QueryClientProvider>,
  )
})
