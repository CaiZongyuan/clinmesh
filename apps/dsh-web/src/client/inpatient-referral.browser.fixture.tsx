import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { InpatientReferral } from '../../../web/src/app/inpatient-referral.tsx'

const session = { actor: { actorId: 'synthetic-actor', epoch: 'epoch-1', workspaceId: 'workspace-demo', scenarioRunId: 'scenario-run-1',
  roleCode: 'outpatient-doctor' as const, practitionerRoleId: 'practitioner-role-outpatient-doctor' },
  user: { id: 'synthetic-user', name: '合成门诊医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.className = 'clinmesh-web-root'
shadow.append(root)
function Fixture(): React.JSX.Element {
  const [encounterId, setEncounterId] = React.useState('synthetic-encounter')
  return <>
    <button type="button" onClick={() => setEncounterId('synthetic-encounter-b')}>切换病例B</button>
    <InpatientReferral key={encounterId} encounterId={encounterId} encounterVersion="3" locale="zh-CN" session={session} />
  </>
}
createRoot(root).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PortalContainerProvider container={root}>
    <Fixture />
  </PortalContainerProvider>
</QueryClientProvider>)
