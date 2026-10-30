import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { triageQueueSchema, type SessionContext } from '@clinmesh/contracts/his'
import { AgentPageRegistryProvider } from '../../../web/src/app/agent-page-context.tsx'
import { AgentReviewProvider } from '../../../web/src/app/agent-review.tsx'
import { TriageWorkspace } from '../../../web/src/app/triage-workspace.tsx'
import { AgentDraftProbe } from './agent-draft-probe.browser.fixture.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-triage', epoch: 'epoch-1', locationId: 'location-triage', organizationId: 'hospital',
    practitionerId: 'nurse', practitionerRoleId: 'role-triage', roleCode: 'triage-nurse', scenarioRunId: 'run-1', workspaceId: 'workspace-1' },
  availableRoles: [{ code: 'triage-nurse', id: 'role-triage', locationId: 'location-triage', organizationId: 'hospital', practitionerId: 'nurse', practitionerName: '分诊护士' }],
  user: { email: 'triage@demo.clinmesh.local', id: 'user-triage', name: '分诊护士' },
}
const queue = triageQueueSchema.parse({ items: [{
  arrivedAt: '2026-10-30T09:00:00+08:00', caseId: 'case-1',
  department: { id: 'department-1', nameEn: 'General medicine', nameZh: '内科' },
  encounterId: 'encounter-1', encounterVersion: '1',
  location: { id: 'location-triage', nameEn: 'Clinic', nameZh: '门诊诊疗区' },
  patient: { id: 'patient-1', name: '合成分诊患者', birthDate: '1990-01-01', gender: 'female', identifier: 'SYN-TRIAGE-DRAFT', synthetic: true, versionId: '1' },
  registrationNumber: 'CM-OP-20261030-0001', riskFlags: [], status: 'awaiting-triage', taskId: 'triage-task', taskVersion: '1',
  visitType: { id: 'visit-general', nameEn: 'General visit', nameZh: '普通门诊' },
}], page: 1, pageSize: 20, total: 1 })
queue.items.push({ ...queue.items[0]!, caseId: 'case-2', encounterId: 'encounter-2', taskId: 'triage-task-2',
  registrationNumber: 'CM-OP-20261030-0002', patient: { ...queue.items[0]!.patient, id: 'patient-2', name: '合成分诊患者二', identifier: 'SYN-TRIAGE-DRAFT-2' } })
queue.total = 2
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
  if (url.pathname !== '/api/his/v1/triage/queue') throw new Error(`Unexpected fixture request: ${url.pathname}`)
  return Response.json(url.searchParams.get('status') === 'completed' ? { ...queue, items: [], total: 0 } : queue)
}, globalThis.fetch)
const host = document.createElement('div')
host.style.cssText = 'width:944px;height:800px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root'
root.dataset.clinmeshApp = 'web'
root.style.height = '100%'
root.lang = 'zh-CN'
shadow.append(root)
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
function Fixture() {
  const [currentSession, setCurrentSession] = useState(session)
  return <QueryClientProvider client={client}>
    <AgentPageRegistryProvider><AgentReviewProvider>
      <button onClick={() => setCurrentSession(current => ({ ...current, actor: { ...current.actor, epoch: 'epoch-2' } }))}>切换数据世代</button>
      <AgentDraftProbe operation="triage.draft.set" input={{ acuityCode: 'level-2', chiefComplaint: '助手填写的主诉',
        diastolicMmHg: 80, oxygenSaturationPct: 97, pulseBpm: 110, respirationBpm: 22, systolicMmHg: 120, temperatureC: 38.2 }} />
      <TriageWorkspace locale="zh-CN" session={currentSession} />
    </AgentReviewProvider></AgentPageRegistryProvider>
  </QueryClientProvider>
}
createRoot(root).render(<Fixture />)
