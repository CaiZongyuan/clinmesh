import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { InpatientDrgPanel } from '../../../web/src/app/inpatient-drg.tsx'
import { InpatientClinical } from '../../../web/src/app/inpatient-clinical.tsx'
import { InpatientDrgPayer } from '../../../web/src/app/inpatient-drg-payer.tsx'
import { InpatientWriteRecovery } from '../../../web/src/app/inpatient-write-recovery.tsx'
import { useInpatientWriteIntent } from '../../../web/src/app/inpatient-write-intent.ts'
import { apiGet, getSession } from '../../../web/src/app/api-client.ts'

function Fixture({ session }: { session: SessionContext }) {
  const client = useQueryClient()
  const detail = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, document.documentElement.dataset.admissionId, 'detail'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${document.documentElement.dataset.admissionId}`, inpatientDetailSchema, signal) })
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  return <><InpatientWriteRecovery write={write} locale="zh-CN" />{detail.data ? session.actor.roleCode === 'medical-insurance'
    ? <InpatientDrgPayer admission={detail.data.admission} session={session} locale="zh-CN" write={write} />
    : document.documentElement.dataset.view === 'clinical'
      ? <InpatientClinical admission={detail.data.admission} session={session} locale="zh-CN" write={write} />
      : <InpatientDrgPanel admission={detail.data.admission} session={session} locale="zh-CN" write={write} /> : null}</>
}
const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('div')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.fontSize = 'large'
container.dataset.theme = 'light'
container.style.cssText = 'padding:16px;min-width:0'
shadow.append(container)
void getSession().then(session => {
  createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortalContainerProvider container={container}><Fixture session={session} /></PortalContainerProvider></QueryClientProvider>)
})
