import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DoctorCompletedCaseDetail, DoctorCompletedCaseList, SessionContext } from '@clinmesh/contracts/his'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { DoctorCompletedCaseLibrary } from '../src/app/doctor-completed-cases.tsx'
import { findScrollViewport } from './scroll-viewport.browser.fixture.ts'

export async function runCompletedCaseScrollFixture(appRoot: Root, root: HTMLElement, host: HTMLElement,
  patient: DoctorCompletedCaseDetail['patient']) {
  const session: SessionContext = {
    actor: { actorId: 'actor', epoch: 'epoch', locationId: 'clinic', organizationId: 'hospital',
      practitionerId: 'doctor', practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor',
      scenarioRunId: 'run', workspaceId: 'workspace' },
    availableRoles: [], user: { email: 'synthetic@example.invalid', id: 'user', name: '合成医生' },
  }
  const scope = [session.actor.workspaceId, session.actor.epoch, session.actor.actorId, session.actor.practitionerRoleId] as const
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  queryClient.setQueryData(['clinical-catalog', ...scope], { diagnoses: [] })
  queryClient.setQueryData(['doctor-completed-cases', ...scope, {}, 1], {
    items: [{ caseId: 'completed', completedAt: '2026-10-06T09:00:00+08:00',
      encounterId: 'completed-encounter', encounterVersion: '1', patient: patient }],
    page: 1, pageSize: 20, total: 1,
  } satisfies DoctorCompletedCaseList)
  queryClient.setQueryData(['doctor-completed-case', ...scope, 'completed'], {
    caseId: 'completed', completedAt: '2026-10-06T09:00:00+08:00',
    clinicalDocuments: [], laboratoryRequests: [], imagingRequests: [], pathologyRequests: [],
    encounter: { id: 'completed-encounter', status: 'completed', versionId: '1' }, patient: patient,
    timeline: Array.from({ length: 30 }, (_, index) => ({ kind: 'encounter-completed',
      occurredAt: '2026-10-06T09:00:00+08:00', reference: `Encounter/completed-${index}`, relatedReferences: [] })),
  } satisfies DoctorCompletedCaseDetail)
  flushSync(() => appRoot.render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-full min-h-0 flex-col">
        <Tabs defaultValue="completed" className="min-h-0 flex-1 gap-0">
          <DoctorCompletedCaseLibrary locale="zh-CN" session={session} onOpenCorrection={() => {}}
            navigation={<TabsList><TabsTrigger value="completed">完诊</TabsTrigger></TabsList>} />
        </Tabs>
      </div>
    </QueryClientProvider>,
  ))
  const completed = []
  for (const [width, height] of [[1000, 700], [600, 700], [320, 520]] as const) {
    host.style.width = `${width}px`
    host.style.height = `${height}px`
    await new Promise(resolve => setTimeout(resolve, 150))
    const select = root.querySelector<HTMLButtonElement>(`[aria-label="查看病例 ${patient.name}"]`)!
    flushSync(() => select.click())
    await new Promise(resolve => setTimeout(resolve, 50))
    const region = root.querySelector<HTMLElement>('[aria-labelledby="completed-case-detail-heading"]')!
    const lastEntry = region.querySelector('ol li:last-child')!
    const viewport = findScrollViewport(region)
    viewport.scrollTop = 0
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const clippedBefore = lastEntry.getBoundingClientRect().top > host.getBoundingClientRect().bottom
    viewport.scrollTop = viewport.scrollHeight
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const end = lastEntry.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    completed.push({ width, height, clippedBefore, scrolled: viewport.scrollTop > 0,
      endVisible: end.bottom <= host.getBoundingClientRect().bottom && end.top >= bounds.top && end.bottom <= bounds.bottom,
      viewportBounded: bounds.bottom <= host.getBoundingClientRect().bottom })
  }
  return completed
}
