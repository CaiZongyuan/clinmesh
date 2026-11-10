// @vitest-environment jsdom
import { savePrescriptionDraftRequestSchema, type ClinicalCatalog, type DoctorCaseDetail, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPageRegistryProvider, useAgentPageRegistration, useRegisterAgentPage, type AgentPageRegistration } from '../agent-page-context.tsx'
import { doctorPrescriptionAgentActions } from './doctor-agent-prescription.tsx'
import { useDoctorCaseModel } from './doctor-case-model.tsx'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { PrescriptionPage, type PrescriptionPageActions } from './prescription-page.tsx'

type Medication = Extract<ClinicalCatalog, { prescriptionConclusionSupported: true }>['medications'][number]
const medications: Medication[] = ['a', 'b'].map((id, index) => ({
  id: `synthetic-medication-${id}`, nameZh: `合成药品${id.toUpperCase()}`, nameEn: `Synthetic medicine ${id}`,
  version: 1, allowedCombinationIds: [`synthetic-medication-${index === 0 ? 'b' : 'a'}`],
  allowedCourseDays: [3], allowedDoseTexts: ['5 mg', '10 mg'], allowedFrequencyCodes: ['QD'], allowedQuantities: [3],
  defaultCourseDays: 3, defaultDoseText: '5 mg', defaultFrequencyCode: 'QD', defaultQuantity: 3,
}))
const session: SessionContext = { user: { id: 'synthetic-user', email: 'doctor@example.test', name: '合成医生' }, availableRoles: [],
  actor: { actorId: 'synthetic-doctor', epoch: 'synthetic-epoch', workspaceId: 'synthetic-workspace',
    practitionerRoleId: 'synthetic-doctor-role', roleCode: 'outpatient-doctor', scenarioRunId: 'synthetic-run' } }
const initialDetail: DoctorCaseDetail = { caseId: 'synthetic-case', registrationNumber: null, allergies: [], priorFacts: [], presentation: null,
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC', name: '合成患者', synthetic: true, versionId: '1' },
  encounter: { id: 'synthetic-encounter', versionId: '1' }, status: 'first-visit', taskId: 'synthetic-task', taskVersion: '1',
  consultation: { version: 1, turns: [] } }
const agentInput = { items: [{ catalogItemId: 'synthetic-medication-b', courseDays: 3, doseText: '10 mg', frequencyCode: 'QD', quantity: 3 }] }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup() {
  let clinical = initialDetail
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/prescription/draft')) {
      writes.push(path)
      const request = savePrescriptionDraftRequestSchema.parse(JSON.parse(String(init?.body)))
      const draftVersion = (clinical.medicationConclusion?.draftVersion ?? 0) + 1
      clinical = { ...clinical, medicationConclusion: { draftVersion, draft: { items: request.input.items } } }
      return Response.json({ data: { draftVersion }, auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [] })
    }
    if (path.endsWith('/actions/confirm')) throw new TypeError('Synthetic lost confirmation response')
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/recording-events')) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Synthetic recording disabled' } }, { status: 503 })
    if (path === '/api/his/v1/catalogs/clinical') return Response.json({ diagnoses: [], laboratory: [], medications, prescriptionConclusionSupported: true })
    if (path === '/api/his/v1/doctor/queue') return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
    const kind = path.match(/\/recommendations\/([^/]+)$/)?.[1]
    if (kind !== undefined) return Response.json({ caseId: clinical.caseId, encounterId: clinical.encounter.id,
      encounterVersion: clinical.encounter.versionId, kind, generation: 1, inputFingerprint: 'a'.repeat(64),
      status: 'ready', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [] })
    if (path === '/api/his/v1/doctor/cases/synthetic-case') return Response.json(clinical)
    throw new Error(`Unexpected prescription request: ${path}`)
  }))
  let registration: AgentPageRegistration | null = null
  function Probe() { registration = useAgentPageRegistration(); return null }
  function Workspace() {
    const model = useDoctorCaseModel({ locale: 'zh-CN', session, selectedCaseId: initialDetail.caseId, queueView: 'active', navigation: null,
      correctionNavigation: undefined, onQueueViewChange: () => {}, onCorrectionNavigationHandled: () => {}, onSelectedCaseIdChange: () => {} })
    useRegisterAgentPage({ actions: doctorPrescriptionAgentActions(model), label: '医生', readState: () => ({}),
      claim: { version: 1, viewId: 'consultation', viewRevision: model.recommendationRevision, ui: { status: 'ready' },
        selection: { id: initialDetail.caseId, kind: 'case', version: '1' } } })
    const detail = model.detail.data
    if (detail === undefined) return null
    const actions: PrescriptionPageActions = {
      saveDraft: { error: model.savePrescription.error, pending: model.savePrescription.isPending, success: model.savePrescription.isSuccess,
        savedRevision: model.savePrescription.variables === undefined ? undefined : JSON.stringify(model.savePrescription.variables.items),
        onSubmit: items => model.savePrescription.mutate({ caseId: detail.caseId, items }) },
      deleteDraft: { data: undefined, error: model.removePrescriptionDraft.error, pending: model.removePrescriptionDraft.isPending,
        onSubmit: () => model.removePrescriptionDraft.mutate({ caseId: detail.caseId }) },
      issue: { error: model.issueCasePrescription.error, pending: model.issueCasePrescription.isPending,
        onSubmit: () => model.issueCasePrescription.mutate({ caseId: detail.caseId }) },
      confirmNoMedication: { error: model.confirmCaseNoMedication.error, pending: model.confirmCaseNoMedication.isPending,
        onSubmit: () => model.confirmCaseNoMedication.mutate({ caseId: detail.caseId }) },
      withdraw: { error: model.withdrawCasePrescription.error, pending: model.withdrawCasePrescription.isPending, onSubmit: () => {} },
    }
    const revisions = model.agentDraftHydrationRevisions[detail.caseId]
    return <DoctorPreparationProvider detail={detail} scope={model.pageScope} enabled inputRevision={model.recommendationRevision} formRevisions={revisions} session={session}>
      <PrescriptionPage key={`${detail.caseId}:${revisions?.prescription ?? 0}`} detail={detail} catalog={medications} locale="zh-CN"
        messages={model.messages} actions={actions} allowWithdrawal readOnly={false} elementId="synthetic-prescription"
        recommendationScope={model.pageScope} recommendationRevision={model.recommendationRevision} referenceSearch={model.referenceCatalogSearches.medications} />
    </DoctorPreparationProvider>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const content = <QueryClientProvider client={client}><AgentPageRegistryProvider><Workspace /><Probe /></AgentPageRegistryProvider></QueryClientProvider>
  const mounted = render(content)
  return { ...mounted, client, writes, get registration() { return registration! },
    refresh: () => client.invalidateQueries({ queryKey: ['doctor-case'] }),
    changeServerDraft: () => { clinical = { ...clinical, medicationConclusion: { draftVersion: 99, draft: agentInput } } },
    remount: () => { mounted.unmount(); return render(content) },
  }
}

async function addManualMedicine() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '添加药品' }))
  const dialog = within(screen.getByRole('dialog'))
  await user.click(dialog.getByRole('button', { name: '选择 合成药品A' }))
  await user.click(dialog.getByRole('button', { name: '加入处方' }))
  await user.click(dialog.getByRole('button', { name: '完成选择' }))
  await screen.findByRole('checkbox', { name: '选择合成药品A' })
}

it('显式 Agent 回填替换旧私稿，随后普通刷新与重新挂载保留人工编辑', async () => {
  const mounted = setup()
  await addManualMedicine()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '添加药品' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '选择 合成药品B' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '完成选择' }))
  await act(async () => { await mounted.registration.actions['outpatient.prescription.draft.set']!.execute(agentInput, new AbortController().signal) })
  await screen.findByRole('checkbox', { name: '选择合成药品B' })
  expect(screen.queryByRole('checkbox', { name: '选择合成药品A' })).toBeNull()
  expect(mounted.registration.readState()).toMatchObject({ forms: { prescription: agentInput } })
  await user.click(screen.getByRole('button', { name: '添加药品' }))
  expect(within(screen.getByRole('dialog')).queryByRole('combobox', { name: '剂量' })).toBeNull()
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '完成选择' }))
  await user.click(screen.getByRole('button', { name: '调整' }))
  fireEvent.change(screen.getByLabelText('每次剂量'), { target: { value: '5 mg' } })
  await user.click(screen.getByRole('button', { name: '保留本次调整' }))
  mounted.changeServerDraft()
  await act(async () => { await mounted.refresh() })
  expect(mounted.registration.readState()).toMatchObject({ forms: { prescription: { items: [expect.objectContaining({ doseText: '5 mg' })] } } })
  mounted.remount()
  await screen.findByRole('checkbox', { name: '选择合成药品B' })
  expect(mounted.registration.readState()).toMatchObject({ forms: { prescription: { items: [expect.objectContaining({ doseText: '5 mg' })] } } })
  await act(async () => { await mounted.registration.actions['outpatient.prescription.draft.set']!.execute(agentInput, new AbortController().signal) })
  await waitFor(() => expect(mounted.registration.readState()).toMatchObject({ forms: { prescription: agentInput } }))
})

it('原处方结果未知时，先前取得的 Agent 回填动作也不能保存新草稿', async () => {
  const mounted = setup()
  await addManualMedicine()
  const priorAction = mounted.registration.actions['outpatient.prescription.draft.set']!
  const issue = screen.getByRole('button', { name: /^开具处方（/ })
  await waitFor(() => expect(issue).toHaveProperty('disabled', false))
  await userEvent.setup().click(issue)
  await screen.findByRole('button', { name: '恢复原开立' })
  const before = mounted.writes.length
  await act(async () => {
    await expect(priorAction.execute(agentInput, new AbortController().signal)).rejects.toThrow('请先恢复原操作，再办理新操作。')
  })
  expect(mounted.writes).toHaveLength(before)
  expect(screen.getByRole('button', { name: '恢复原开立' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: '选择合成药品A' })).toBeTruthy()
})

it.each(['corrupt', 'unreadable'] as const)('原意图存储 %s 时 Agent 回填也保留人工稿并停止写入', async mode => {
  const mounted = setup()
  await addManualMedicine()
  const action = mounted.registration.actions['outpatient.prescription.draft.set']!
  const read = Storage.prototype.getItem
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (!key.includes('confirmation:')) return read.call(this, key)
    if (mode === 'unreadable') throw new Error('Synthetic storage unavailable')
    return '{invalid synthetic intent'
  })
  const before = mounted.writes.length
  await act(async () => { await expect(action.execute(agentInput, new AbortController().signal)).rejects.toThrow('请先恢复原操作，再办理新操作。') })
  expect(mounted.writes).toHaveLength(before)
  expect(screen.getByRole('checkbox', { name: '选择合成药品A' })).toBeTruthy()
})
