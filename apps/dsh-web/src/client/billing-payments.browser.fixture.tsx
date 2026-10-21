import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { getSession } from '../../../web/src/app/api-client.ts'
import { AgentReviewProvider } from '../../../web/src/app/agent-review.tsx'
import { BillingWorkspace } from '../../../web/src/app/billing-workspace.tsx'
import { WebRuntimeProvider } from '../../../web/src/app/web-runtime.tsx'
import { AgentPageRegistryProvider, useAgentPageRegistration } from '../../../web/src/app/agent-page-context.tsx'

function AgentSelectionProbe() {
  const registration = useAgentPageRegistration()
  React.useEffect(() => {
    const select = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      void Promise.resolve().then(() => registration?.actions['billing.item.select']?.execute(event.detail, new AbortController().signal))
        .then(result => window.dispatchEvent(new CustomEvent('billing-payments-agent-result', { detail: { result } })))
        .catch(error => window.dispatchEvent(new CustomEvent('billing-payments-agent-result', { detail: { error: String(error) } })))
    }
    window.addEventListener('billing-payments-agent-select', select)
    return () => window.removeEventListener('billing-payments-agent-select', select)
  }, [registration])
  return null
}

const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const host = document.createElement('div')
host.id = 'billing-payments-host'
host.style.cssText = 'width:100%;height:900px;container-type:inline-size;container-name:dsh-react-surface-content;contain:strict'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
const styles = document.createElement('style')
styles.textContent = document.querySelector('style[data-fixture]')?.textContent ?? ''
const container = document.createElement('div')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.fontSize = 'large'
container.dataset.theme = 'light'
container.lang = 'zh-CN'
container.style.cssText = 'height:100%;min-width:0;overflow-y:auto;padding:16px'
shadow.append(styles, container)
const session = getSession()
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
window.addEventListener('billing-payments-refresh-queue', () => { void queryClient.invalidateQueries({ queryKey: ['billing-queue'] }) })
void session.then(session => {
  createRoot(container).render(
    <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: container } }}>
      <PortalContainerProvider container={container}>
        <QueryClientProvider client={queryClient}>
          <AgentPageRegistryProvider>
            <AgentSelectionProbe />
            <AgentReviewProvider locale="zh-CN"><BillingWorkspace locale="zh-CN" session={session} /></AgentReviewProvider>
          </AgentPageRegistryProvider>
        </QueryClientProvider>
      </PortalContainerProvider>
    </WebRuntimeProvider>,
  )
}).catch(error => errors.push(String(error)))
window.addEventListener('billing-payments-errors', () => {
  document.title = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ errors }))))
})
document.title = btoa(JSON.stringify({ ready: true }))
