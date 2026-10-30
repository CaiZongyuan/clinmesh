import {
  checkClinicalDocumentQualityRequestSchema, clinicalCatalogSchema, clinicalDocumentDraftResponseSchema, doctorCaseDetailSchema, doctorQueueSchema,
  diagnosisDraftResponseSchema, encounterCompletionPreviewSchema, saveClinicalDocumentDraftRequestSchema, saveDiagnosisDraftRequestSchema, type SessionContext,
} from '@clinmesh/contracts/his'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentPageRegistryProvider } from '../../../web/src/app/agent-page-context.tsx'
import { AgentReviewProvider } from '../../../web/src/app/agent-review.tsx'
import { DoctorWorkspace } from '../../../web/src/app/doctor-workspace.tsx'
import { AgentDraftProbe } from './agent-draft-probe.browser.fixture.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', epoch: 'epoch-1', locationId: 'clinic', organizationId: 'hospital', practitionerId: 'doctor',
    practitionerRoleId: 'role-doctor', roleCode: 'outpatient-doctor', scenarioRunId: 'run-1', workspaceId: 'workspace-1' },
  availableRoles: [{ code: 'outpatient-doctor', id: 'role-doctor', locationId: 'clinic', organizationId: 'hospital', practitionerId: 'doctor', practitionerName: '门诊医生' }],
  user: { email: 'doctor@demo.clinmesh.local', id: 'user-doctor', name: '门诊医生' },
}
const initial = { chiefComplaint: '咽痛两天', historyOfPresentIllness: '初始病史。', assessment: '待查', physicalExamination: '', auxiliaryExamination: '', priorMedicalHistory: '', disposition: '', followUp: '' }
const cases = [1, 2].map(index => doctorCaseDetailSchema.parse({
  registrationNumber: `CM-OP-20261030-000${index}`, allergies: [], caseId: `doctor-draft-case-${index}`,
  encounter: { id: `doctor-draft-encounter-${index}`, status: 'in-progress', versionId: '1' },
  consultation: { turns: [], version: 1 },
  patient: { id: `doctor-draft-patient-${index}`, identifier: `SYN-DRAFT-${index}`, name: `草稿患者${index}`, gender: 'female', synthetic: true, versionId: '1' },
  presentation: null, priorFacts: [], status: 'first-visit', taskId: `doctor-draft-task-${index}`, taskVersion: '1',
  clinicalDocument: { draft: { ...initial, version: 1, updatedAt: '2026-10-30T09:00:00+08:00' }, signed: [] },
}))
const command = (data: unknown) => ({ data, auditId: 'audit-doctor-draft', effects: [], requestId: 'request-doctor-draft', warnings: [] })
let rejectManualWrites = false
let rejectedWrites = 0
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
  const caseId = url.pathname.match(/cases\/([^/]+)/)?.[1]
  const detail = cases.find(item => item.caseId === caseId)
  if (url.pathname === '/api/his/v1/doctor/queue') return Response.json(doctorQueueSchema.parse({
    items: cases.map(item => ({ ...item, encounterId: item.encounter.id, encounterVersion: item.encounter.versionId })), page: 1, pageSize: 20, total: 2,
  }))
  if (url.pathname === '/api/his/v1/catalogs/clinical') return Response.json(clinicalCatalogSchema.parse({
    diagnoses: [{ id: 'diagnosis-throat', code: 'J02.9', nameZh: '合成急性咽炎', nameEn: 'Synthetic pharyngitis', system: 'http://hl7.org/fhir/sid/icd-10', version: 1 }],
    laboratory: [], medications: [], prescriptionConclusionSupported: true,
  }))
  if (detail !== undefined && url.pathname.endsWith(`/cases/${caseId}`)) return Response.json(detail)
  if (url.pathname.endsWith('/diagnosis/draft') && init?.method === 'PUT') {
    const request = saveDiagnosisDraftRequestSchema.parse(JSON.parse(String(init.body)))
    const encounterId = url.pathname.match(/encounters\/([^/]+)/)?.[1]
    const target = cases.find(item => item.encounter.id === encounterId)
    if (target === undefined) throw new Error('Unexpected diagnosis draft target')
    const draftVersion = (target.diagnosis?.draftVersion ?? 0) + 1
    target.diagnosis = { draftVersion, draft: { entries: request.input.entries } }
    return Response.json(diagnosisDraftResponseSchema.parse(command({ draftVersion })))
  }
  if (url.pathname.endsWith('/clinical-document/draft') && init?.method === 'PUT') {
    const request = saveClinicalDocumentDraftRequestSchema.parse(JSON.parse(String(init.body)))
    if (rejectManualWrites && request.input.agentGenerated !== true) {
      rejectedWrites += 1
      document.dispatchEvent(new CustomEvent('doctor-fixture-save-rejected'))
      return Response.json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: 'Synthetic draft save failure' }] }, { status: 503 })
    }
    const encounterId = url.pathname.match(/encounters\/([^/]+)/)?.[1]
    const target = cases.find(item => item.encounter.id === encounterId)
    if (target === undefined) throw new Error('Unexpected doctor draft target')
    const version = target.clinicalDocument!.draft!.version + 1
    target.clinicalDocument = { ...target.clinicalDocument!, draft: { ...request.input.document, version, updatedAt: '2026-10-30T10:00:00+08:00' } }
    return Response.json(clinicalDocumentDraftResponseSchema.parse(command({ caseId: target.caseId, draftVersion: version })))
  }
  if (url.pathname.endsWith('/completion')) return Response.json(encounterCompletionPreviewSchema.parse({ canComplete: false,
    encounterId: url.pathname.match(/encounters\/([^/]+)/)?.[1], encounterVersion: '1', items: [
      { code: 'primary-diagnosis-confirmed', status: 'incomplete', statusText: '待确认主诊断', target: 'diagnosis' },
      { code: 'clinical-document-signed', status: 'incomplete', statusText: '待签署病历', target: 'clinical-document' },
      { code: 'required-reports-acknowledged', status: 'complete', statusText: '无待阅报告', target: 'laboratory' },
      { code: 'medication-conclusion-recorded', status: 'incomplete', statusText: '待确认用药', target: 'medication-conclusion' },
      { code: 'no-pending-drafts', status: 'incomplete', statusText: '有未提交草稿', target: 'clinical-document' },
      { code: 'disposition-complete', status: 'incomplete', statusText: '待写处置', target: 'clinical-document' },
      { code: 'follow-up-complete', status: 'incomplete', statusText: '待写随访', target: 'clinical-document' },
    ],
  }))
  if (detail !== undefined && url.pathname.includes('/document-quality-control')) {
    const request = init?.method === 'POST' ? checkClinicalDocumentQualityRequestSchema.parse(JSON.parse(String(init.body))) : undefined
    const quality = { caseId, encounterId: detail.encounter.id, draftVersion: detail.clinicalDocument?.draft?.version ?? 0,
      ...(request?.input.clientId === undefined ? {} : { clientId: request.input.clientId, clientRevision: request.input.clientRevision }),
      documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), generation: 1, stale: false, status: 'ready', issues: [], notices: [] }
    return Response.json(init?.method === 'POST' ? command(quality) : quality)
  }
  if (detail !== undefined && url.pathname.includes('/recommendations/')) {
    const kind = url.pathname.split('/recommendations/')[1]!.split('/')[0]
    const state = { caseId, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId, kind,
      generation: 0, inputFingerprint: 'a'.repeat(64), status: 'idle', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [] }
    return Response.json(init?.method === 'POST' ? command(state) : state)
  }
  throw new Error(`Unexpected doctor fixture request: ${url.pathname}`)
}, globalThis.fetch)
const host = document.createElement('div')
host.style.cssText = 'width:1100px;max-width:100%;height:850px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root h-full'
shadow.append(root)
function FixtureApp() {
  const [currentSession, setCurrentSession] = useState(session)
  const [rejected, setRejected] = useState(0)
  useEffect(() => {
    const update = () => setRejected(rejectedWrites)
    document.addEventListener('doctor-fixture-save-rejected', update)
    return () => document.removeEventListener('doctor-fixture-save-rejected', update)
  }, [])
  return <>
    <button onClick={() => { rejectManualWrites = true }}>拒绝人工保存</button>
    <button onClick={() => setCurrentSession(current => ({ ...current, actor: { ...current.actor, practitionerRoleId: 'role-doctor-2' },
      availableRoles: [...current.availableRoles, { ...current.availableRoles[0]!, id: 'role-doctor-2' }] }))}>切换医生岗位</button>
    <output aria-label="人工保存拒绝次数">{rejected}</output>
    <output aria-label="当前医生岗位">{currentSession.actor.practitionerRoleId}</output>
    <AgentDraftProbe operation="outpatient.record.draft.set" input={{ ...initial, historyOfPresentIllness: '助手整理：咽痛两天，无呼吸困难。', assessment: '助手评估：上呼吸道感染。' }} />
    <AgentDraftProbe label="助手填写诊断" operation="outpatient.diagnosis.draft.set" input={{ entries: [{ catalogItemId: 'diagnosis-throat', role: 'primary', note: '助手建议：结合咽部查体核对。' }] }} />
    <DoctorWorkspace locale="zh-CN" session={currentSession} />
  </>
}
createRoot(root).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PortalContainerProvider container={root}><AgentPageRegistryProvider><AgentReviewProvider>
    <FixtureApp />
  </AgentReviewProvider></AgentPageRegistryProvider></PortalContainerProvider>
</QueryClientProvider>)
