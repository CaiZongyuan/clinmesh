import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { InpatientClinical } from '../../../web/src/app/inpatient-clinical.tsx'
import { InpatientInvestigations } from '../../../web/src/app/inpatient-investigations.tsx'
import { useInpatientWriteIntent } from '../../../web/src/app/inpatient-write-intent.ts'
import { apiGet, getSession } from '../../../web/src/app/api-client.ts'
import type { WorkspaceLocale } from '../../../web/src/app/workspace-i18n.ts'

function Fixture({ session, admission }: { session: SessionContext; admission: z.infer<typeof inpatientDetailSchema>['admission'] }) {
  const client = useQueryClient()
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  const [locale, setLocale] = React.useState<WorkspaceLocale>('zh-CN')
  return <>
    <button onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}>Switch language</button>
    <InpatientInvestigations admission={admission} session={session} locale={locale} write={write} />
    <InpatientClinical admission={admission} session={session} locale={locale} write={write} />
  </>
}

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('div')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.dataset.fontSize = 'standard'
container.style.cssText = 'padding:16px;min-width:0'
shadow.append(container)
void Promise.all([
  getSession(),
  apiGet(`/api/his/v1/inpatient/admissions/${document.documentElement.dataset.admissionId}`, inpatientDetailSchema),
]).then(([session, data]) => {
  createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PortalContainerProvider container={container}><Fixture session={session} admission={data.admission} /></PortalContainerProvider>
  </QueryClientProvider>)
})
