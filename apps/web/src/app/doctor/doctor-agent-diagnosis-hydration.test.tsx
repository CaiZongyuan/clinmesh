// @vitest-environment jsdom
import { saveDiagnosisDraftRequestSchema, type DoctorCaseDetail, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPageRegistryProvider, useAgentPageRegistration, useRegisterAgentPage, type AgentPageRegistration } from '../agent-page-context.tsx'
import { doctorDiagnosisAgentActions } from './doctor-agent-diagnosis.tsx'
import { useDoctorCaseModel } from './doctor-case-model.tsx'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DiagnosisPage } from './diagnosis-page.tsx'

const diagnoses = ['a', 'b'].map(id => ({ id: `synthetic-diagnosis-${id}`, code: `SYN-${id}`, nameZh: `合成诊断${id.toUpperCase()}`,
  nameEn: `Synthetic diagnosis ${id}`, system: 'https://clinmesh.example.com/icd-10', version: 1 }))
const session: SessionContext = { user: { id: 'synthetic-user', email: 'doctor@example.test', name: '合成医生' }, availableRoles: [],
  actor: { actorId: 'synthetic-doctor', epoch: 'synthetic-epoch', workspaceId: 'synthetic-workspace', practitionerRoleId: 'synthetic-role',
    roleCode: 'outpatient-doctor', scenarioRunId: 'synthetic-run' } }
const initialDetail: DoctorCaseDetail = { caseId: 'synthetic-case', registrationNumber: null, allergies: [], priorFacts: [], presentation: null,
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', synthetic: true, versionId: '1' },
  encounter: { id: 'synthetic-encounter', versionId: '1', status: 'in-progress' }, status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
  consultation: { version: 1, turns: [] } }
const agentInput = { entries: [{ catalogItemId: 'synthetic-diagnosis-b', role: 'primary' as const, note: 'Agent已核实' }] }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup() {
  let clinical = initialDetail
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/diagnosis/draft')) {
      writes.push(path)
      const request = saveDiagnosisDraftRequestSchema.parse(JSON.parse(String(init?.body)))
      const draftVersion = (clinical.diagnosis?.draftVersion ?? 0) + 1
      clinical = { ...clinical, diagnosis: { draftVersion, draft: { entries: request.input.entries } } }
      return Response.json({ data: { draftVersion }, auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [] })
    }
    if (path.endsWith('/actions/confirm')) throw new TypeError('Synthetic lost response')
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/recording-events')) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Synthetic recording disabled' } }, { status: 503 })
    if (path === '/api/his/v1/catalogs/clinical') return Response.json({ diagnoses, laboratory: [], medications: [], prescriptionConclusionSupported: true })
    if (path === '/api/his/v1/doctor/queue') return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
    const kind = path.match(/\/recommendations\/([^/]+)$/)?.[1]
    if (kind !== undefined) return Response.json({ caseId: clinical.caseId, encounterId: clinical.encounter.id, encounterVersion: '1', kind,
      generation: 1, inputFingerprint: 'a'.repeat(64), status: 'ready', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [] })
    if (path === '/api/his/v1/doctor/cases/synthetic-case') return Response.json(clinical)
    throw new Error(`Unexpected diagnosis request: ${path}`)
  }))
  let registration: AgentPageRegistration | null = null
  function Probe() { registration = useAgentPageRegistration(); return null }
  function Workspace() {
    const model = useDoctorCaseModel({ locale: 'zh-CN', session, selectedCaseId: initialDetail.caseId, queueView: 'active', navigation: null,
      correctionNavigation: undefined, onQueueViewChange: () => {}, onCorrectionNavigationHandled: () => {}, onSelectedCaseIdChange: () => {} })
    useRegisterAgentPage({ actions: doctorDiagnosisAgentActions(model), label: '医生', readState: () => ({}),
      claim: { version: 1, viewId: 'consultation', viewRevision: model.recommendationRevision, ui: { status: 'ready' },
        selection: { id: initialDetail.caseId, kind: 'case', version: '1' } } })
    const detail = model.detail.data
    if (detail === undefined) return null
    const revisions = model.agentDraftHydrationRevisions[detail.caseId]
    return <DoctorPreparationProvider detail={detail} scope={model.pageScope} enabled inputRevision={model.recommendationRevision} formRevisions={revisions} session={session}>
      <DiagnosisPage key={`${detail.caseId}:${revisions?.diagnosis ?? 0}`} caseId={detail.caseId} encounter={detail.encounter} state={detail.diagnosis}
        catalog={diagnoses} locale="zh-CN" messages={model.messages} readOnly={false} elementId="synthetic-diagnosis"
        actions={{ confirm: { error: null, pending: false, onSubmit: () => {} }, save: { error: null, pending: false, success: false, savedRevision: undefined, onSubmit: () => {} } }}
        recommendationScope={model.pageScope} recommendationRevision={model.recommendationRevision} referenceSearch={model.referenceCatalogSearches.diagnoses} />
    </DoctorPreparationProvider>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const content = <QueryClientProvider client={client}><AgentPageRegistryProvider><Workspace /><Probe /></AgentPageRegistryProvider></QueryClientProvider>
  const mounted = render(content)
  return { ...mounted, client, writes, get registration() { return registration! },
    refresh: () => client.invalidateQueries({ queryKey: ['doctor-case'] }),
    remount: () => { mounted.unmount(); return render(content) },
  }
}

async function addManualDiagnosis() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '添加诊断' }))
  const dialog = within(screen.getByRole('dialog'))
  await user.click(dialog.getByRole('button', { name: '选择 合成诊断A SYN-a' }))
  await user.click(dialog.getByRole('button', { name: '加入诊断' }))
  await user.click(dialog.getByRole('button', { name: '完成选择' }))
  await screen.findByRole('checkbox', { name: '选择合成诊断A' })
}

it('显式 Agent 回填诊断替换旧私稿，普通刷新和重挂载保留后续人工备注', async () => {
  const mounted = setup()
  await addManualDiagnosis()
  await act(async () => { await mounted.registration.actions['outpatient.diagnosis.draft.set']!.execute(agentInput, new AbortController().signal) })
  await screen.findByRole('checkbox', { name: '选择合成诊断B' })
  expect(screen.queryByRole('checkbox', { name: '选择合成诊断A' })).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '调整' }))
  fireEvent.change(screen.getByLabelText('备注'), { target: { value: '人工核实后的备注' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' }))
  await act(async () => { await mounted.refresh() })
  mounted.remount()
  await screen.findByRole('checkbox', { name: '选择合成诊断B' })
  await waitFor(() => expect(mounted.registration.readState()).toMatchObject({ forms: { diagnosis: { entries: [expect.objectContaining({ note: '人工核实后的备注' })] } } }))
})

it.each(['pending', 'corrupt', 'unreadable'] as const)('原诊断意图 %s 时已取得的 Agent 动作也不能写入', async mode => {
  const mounted = setup()
  await addManualDiagnosis()
  const action = mounted.registration.actions['outpatient.diagnosis.draft.set']!
  if (mode === 'pending') {
    await userEvent.setup().click(screen.getByRole('button', { name: /^确认选中诊断/ }))
    await screen.findByRole('button', { name: '恢复原开立' })
  } else {
    const read = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (!key.includes('confirmation:')) return read.call(this, key)
      if (mode === 'unreadable') throw new Error('Synthetic storage unavailable')
      return '{invalid synthetic intent'
    })
  }
  const before = mounted.writes.length
  await act(async () => { await expect(action.execute(agentInput, new AbortController().signal)).rejects.toThrow('请先恢复原操作，再办理新操作。') })
  expect(mounted.writes).toHaveLength(before)
  expect(screen.getByRole('checkbox', { name: '选择合成诊断A' })).toBeTruthy()
})
