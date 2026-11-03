import { createRoot } from 'react-dom/client'
import { StrictMode, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { doctorQueueSchema, pharmacyQueueSchema, triageQueueSchema, type SessionContext } from '@clinmesh/contracts/his'
import { AgentPageRegistryProvider } from '../../../web/src/app/agent-page-context.tsx'
import { AgentReviewProvider } from '../../../web/src/app/agent-review.tsx'
import { DoctorWorkspace } from '../../../web/src/app/doctor/doctor-case-controller.tsx'
import { DoctorQueueModule } from '../../../web/src/app/doctor/doctor-queue-module.tsx'
import { DoctorWorkspaceLayout } from '../../../web/src/app/doctor/responsive-layout.tsx'
import { ConsultationPage } from '../../../web/src/app/doctor/consultation-page.tsx'
import { TriageWorkspace } from '../../../web/src/app/triage-workspace.tsx'
import { PharmacyWorkspace } from '../../../web/src/app/pharmacy-workspace.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', epoch: 'epoch-1', locationId: 'clinic', organizationId: 'hospital',
    practitionerId: 'doctor', practitionerRoleId: 'role-doctor', roleCode: 'outpatient-doctor', scenarioRunId: 'run-1', workspaceId: 'workspace-1' },
  availableRoles: [{ code: 'outpatient-doctor', id: 'role-doctor', locationId: 'clinic', organizationId: 'hospital', practitionerId: 'doctor', practitionerName: '合成医生' }],
  user: { email: 'doctor@example.test', id: 'user-doctor', name: '合成医生' },
}
const patient = { id: 'patient-1', name: '合成长姓名患者甲乙丙', birthDate: '1990-01-01', gender: 'female', identifier: 'SYN-QUEUES', synthetic: true, versionId: '1' }
const registrationNumber = 'CM-OP-20261104-000001'
const queueNumbers = [registrationNumber, 'CM-OP-20261020-1234567', 'CM-OP-20261020-123456789012345678901234567890']
const triage = triageQueueSchema.parse({ items: queueNumbers.map((registrationNumber, index) => ({
  arrivedAt: '2026-11-04T09:00:00+08:00', caseId: `case-${index + 1}`,
  department: { id: 'department', nameEn: 'General medicine', nameZh: '内科' },
  encounterId: 'encounter', encounterVersion: '1',
  location: { id: 'clinic', nameEn: 'Clinic', nameZh: '门诊诊疗区' },
  patient: { ...patient, id: `patient-${index + 1}` }, registrationNumber, riskFlags: [], status: 'awaiting-triage', taskId: `triage-task-${index + 1}`, taskVersion: '1',
  visitType: { id: 'visit-general', nameEn: 'General visit', nameZh: '普通门诊' },
})), page: 1, pageSize: 20, total: queueNumbers.length })
const doctor = doctorQueueSchema.parse({ items: queueNumbers.map((registrationNumber, index) => ({ patient: { ...patient, id: `patient-${index + 1}` }, registrationNumber, caseId: `case-${index + 1}`, encounterId: 'encounter', encounterVersion: '1',
  presentation: null, triage: { acuityCode: 'level-3', chiefComplaint: '反复头晕一周', temperatureC: 37 }, status: 'first-visit', taskId: `doctor-task-${index + 1}`, taskVersion: '1' })), page: 1, pageSize: 20, total: queueNumbers.length })
const pharmacy = pharmacyQueueSchema.parse({ items: [{
  allergyWarnings: [], authoredBy: 'doctor', caseId: 'case-1', encounterId: 'encounter', encounterStatus: 'completed', encounterVersion: '1', patient,
  prescriptionId: 'prescription', prescriptionNumber: 'CM-RX-20261104-000001', prescriptionStatus: 'issued', prescriptionVersion: 1, status: 'awaiting-review',
  medications: [{ doseText: '一片', dispensedQuantity: 0, frequencyCode: 'BID', lots: [], medicationId: 'medication', medicationRequestId: 'medication-request', medicationRequestVersion: '1',
    nameEn: 'Synthetic medication', nameZh: '合成药品', quantity: 10, remainingQuantity: 10, unitPriceFen: 100 }],
}], page: 1, pageSize: 20, total: 1 })
const consultation = { version: 1, turns: [
  { speaker: 'patient', messageText: '我最近一周总是头晕。' },
  { speaker: 'doctor', messageText: '头晕是持续的还是一阵阵的？' },
  { speaker: 'patient', messageText: '是一阵阵的。' },
].map((turn, index) => ({ ...turn, speaker: turn.speaker === 'doctor' ? 'doctor' as const : 'patient' as const,
  id: `turn-${index}`, actorId: null, practitionerId: null, kind: 'text' as const, source: 'persona-opening' as const,
  personaRevision: null, reportReference: null, sequence: index + 1, recordedAt: '2026-11-04T09:00:00+08:00' })) }
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
  if (url.pathname === '/api/his/v1/catalogs/clinical') return Response.json({ diagnoses: [], laboratory: [], medications: [], prescriptionConclusionSupported: true })
  if (url.pathname === '/api/his/v1/doctor/queue' || url.pathname === '/api/his/v1/doctor/completed-cases') return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
  if (url.pathname === '/api/his/v1/triage/queue') return Response.json(triage)
  if (url.pathname === '/api/his/v1/pharmacy/queue') return Response.json(pharmacy)
  throw new Error(`Unexpected queue fixture request: ${url.pathname}`)
}, globalThis.fetch)
const host = document.createElement('div')
host.dataset.outpatientFixtureHost = ''
host.style.cssText = 'width:1101px;height:900px;container-type:inline-size;container-name:dsh-react-surface-content'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root h-full flex flex-col'
root.dataset.clinmeshApp = 'web'
root.lang = 'zh-CN'
shadow.append(root)
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
function Fixture() {
  const [mode, setMode] = useState('doctor')
  const [pending, setPending] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const messages = getWorkspaceMessages('zh-CN')
  return <><nav className="flex shrink-0 gap-2">{['doctor', 'row', 'triage', 'pharmacy', 'consultation'].map(mode => <button key={mode} onClick={() => setMode(mode)}>{mode}</button>)}
    <button onClick={() => root.classList.toggle('dark')}>切换主题</button>
    <button onClick={() => setPending(value => !value)}>切换等待</button>
    <button onClick={() => setReadOnly(value => !value)}>切换只读</button>
  </nav><div className="flex min-h-0 flex-1 flex-col">
    {mode === 'doctor' ? <DoctorWorkspace locale="zh-CN" session={session} />
      : mode === 'row' ? <DoctorWorkspaceLayout queueLabel="队列" detailLabel="病例" queue={() => <DoctorQueueModule navigation={null} queueView="active" activeCaseId="case-1" messages={messages}
        onQueuePageChange={() => {}} onSelectCase={() => {}} queueData={doctor} queueError={null} queuePending={false} />}>{null}</DoctorWorkspaceLayout>
        : mode === 'triage' ? <TriageWorkspace locale="zh-CN" session={{ ...session, actor: { ...session.actor, roleCode: 'triage-nurse' } }} />
          : mode === 'pharmacy' ? <PharmacyWorkspace locale="zh-CN" session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} />
            : <div className="flex h-full min-h-0 flex-col bg-card p-4" style={{ width: 600 }}><ConsultationPage action={{ error: null, pending, onAsk: () => setPending(true), onRetry: () => {} }}
              consultation={consultation} locale="zh-CN" messages={messages} patientName="合成患者" readOnly={readOnly} /></div>}
  </div></>
}
createRoot(root).render(<StrictMode><QueryClientProvider client={client}><AgentPageRegistryProvider><AgentReviewProvider><Fixture />
</AgentReviewProvider></AgentPageRegistryProvider></QueryClientProvider></StrictMode>)
