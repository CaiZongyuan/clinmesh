// @vitest-environment jsdom
import { saveDiagnosisDraftRequestSchema, type DoctorCaseDetail, type SessionContext } from '@clinmesh/contracts/his'
import { confirmDoctorPreparationRequestSchema } from '@clinmesh/contracts/doctor-recommendations'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { AgentPageRegistryProvider, useAgentPageRegistration, useRegisterAgentPage, type AgentPageRegistration } from '../agent-page-context.tsx'
import { doctorDiagnosisAgentActions } from './doctor-agent-diagnosis.tsx'
import { useDoctorCaseModel } from './doctor-case-model.tsx'
import { DoctorPreparationProvider } from './doctor-preparation-state.tsx'
import { DiagnosisPage } from './diagnosis-page.tsx'
import { AgentReviewProvider, isAgentReviewTask } from '../agent-review.tsx'

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

function setup(options: { loseResponse?: boolean; session?: SessionContext; rejectionCode?: string; loseRejectionResponse?: boolean } = {}) {
  let clinical = initialDetail
  const writes: string[] = []
  const confirmations: Array<{ body: unknown; key: string | null }> = []
  const receiptReads: string[] = []
  const rejectedKeys = new Set<string | null>()
  const receipt = () => ({ data: { kind: 'diagnosis', caseId: clinical.caseId, draftVersion: 1, encounterVersion: '2', recordIds: ['synthetic-confirmation'] },
    auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [] })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.endsWith('/diagnosis/draft')) {
      writes.push(path)
      const request = saveDiagnosisDraftRequestSchema.parse(JSON.parse(String(init?.body)))
      const draftVersion = (clinical.diagnosis?.draftVersion ?? 0) + 1
      clinical = { ...clinical, diagnosis: { draftVersion, draft: { entries: request.input.entries } } }
      return Response.json({ data: { draftVersion }, auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [] })
    }
    if (path.endsWith('/recommendations/diagnosis/actions/confirm')) {
      const request = confirmDoctorPreparationRequestSchema.parse(JSON.parse(String(init?.body)))
      const key = new Headers(init?.headers).get('idempotency-key')
      confirmations.push({ body: request, key })
      if (options.rejectionCode !== undefined && confirmations.length === 1) rejectedKeys.add(key)
      if (rejectedKeys.has(key)) {
        if (options.loseRejectionResponse && confirmations.length === 1) throw new TypeError('Synthetic lost rejection response')
        return Response.json({ error: { code: options.rejectionCode, message: 'Synthetic diagnosis rejection' } }, { status: 409 })
      }
      clinical = { ...clinical, encounter: { ...clinical.encounter, versionId: '2' }, diagnosis: { draftVersion: 1,
        confirmation: { id: 'synthetic-confirmation', provenanceId: 'synthetic-provenance', confirmedAt: '2026-11-10T00:00:00Z', revisionNumber: 1,
          entries: request.input.selections.map((entry, index) => ({ catalogItemId: 'catalogItemId' in entry ? entry.catalogItemId : '', role: 'role' in entry ? entry.role : 'secondary',
            conditionId: `synthetic-condition-${index}`, conditionVersion: '1', code: 'SYN-b', display: '合成诊断B', system: 'https://clinmesh.example.com/icd-10',
            ...('note' in entry ? { note: entry.note } : {}) })) } } }
      if (options.loseResponse !== false) throw new TypeError('Synthetic lost response')
      return Response.json(receipt())
    }
    if (path.includes('/recommendations/diagnosis/confirmations/')) {
      receiptReads.push(path)
      return clinical.diagnosis?.confirmation === undefined
        ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'No completed confirmation' } }, { status: 404 })
        : Response.json(receipt())
    }
    if (path.endsWith('/actions/confirm')) throw new TypeError('Synthetic lost response')
    if (path === '/api/auth/context') return Response.json(options.session ?? session)
    if (path.endsWith('/recording-events')) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Synthetic recording disabled' } }, { status: 503 })
    if (path === '/api/his/v1/catalogs/clinical') return Response.json({ diagnoses, laboratory: [], medications: [], prescriptionConclusionSupported: true })
    if (path === '/api/his/v1/doctor/queue') return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
    const kind = path.match(/\/recommendations\/([^/]+)$/)?.[1]
    if (kind !== undefined) return Response.json({ caseId: clinical.caseId, encounterId: clinical.encounter.id, encounterVersion: '1', kind,
      generation: 1, inputFingerprint: 'a'.repeat(64), status: 'ready', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [] })
    if (path === '/api/his/v1/doctor/cases/synthetic-case') return Response.json(clinical)
    if (path === '/api/his/v1/doctor/cases/synthetic-other-case') return Response.json({ ...clinical, caseId: 'synthetic-other-case' })
    throw new Error(`Unexpected diagnosis request: ${path}`)
  }))
  let registration: AgentPageRegistration | null = null
  function Probe() { registration = useAgentPageRegistration(); return null }
  function Workspace() {
    const [selectedCaseId, setSelectedCaseId] = useState(initialDetail.caseId)
    const model = useDoctorCaseModel({ locale: 'zh-CN', session, selectedCaseId, queueView: 'active', navigation: null,
      correctionNavigation: undefined, onQueueViewChange: () => {}, onCorrectionNavigationHandled: () => {}, onSelectedCaseIdChange: () => {} })
    useRegisterAgentPage({ actions: doctorDiagnosisAgentActions(model), label: '医生', readState: () => ({}),
      claim: { version: 1, viewId: 'consultation', viewRevision: model.recommendationRevision, ui: { status: 'ready' },
        selection: { id: initialDetail.caseId, kind: 'case', version: '1' } } })
    const detail = model.detail.data
    if (detail === undefined) return null
    const revisions = model.agentDraftHydrationRevisions[detail.caseId]
    return <DoctorPreparationProvider detail={detail} scope={model.pageScope} enabled inputRevision={model.recommendationRevision} formRevisions={revisions} session={session}>
      <button onClick={() => setSelectedCaseId('synthetic-other-case')} type="button">切换合成病例</button>
      <DiagnosisPage key={`${detail.caseId}:${revisions?.diagnosis ?? 0}`} caseId={detail.caseId} encounter={detail.encounter} state={detail.diagnosis}
        catalog={diagnoses} locale="zh-CN" messages={model.messages} readOnly={false} elementId="synthetic-diagnosis"
        actions={{ confirm: { error: null, pending: false, onSubmit: () => {} }, save: { error: null, pending: false, success: false, savedRevision: undefined, onSubmit: () => {} } }}
        recommendationScope={model.pageScope} recommendationRevision={model.recommendationRevision} referenceSearch={model.referenceCatalogSearches.diagnoses} />
    </DoctorPreparationProvider>
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const content = <QueryClientProvider client={client}><AgentReviewProvider><AgentPageRegistryProvider><Workspace /><Probe /></AgentPageRegistryProvider></AgentReviewProvider></QueryClientProvider>
  const mounted = render(content)
  return { ...mounted, client, writes, confirmations, receiptReads, get registration() { return registration! },
    refresh: () => client.invalidateQueries({ queryKey: ['doctor-case'] }),
    remount: () => { mounted.unmount(); return render(content) },
  }
}

it.each(['outpatient.diagnosis.draft.set', 'outpatient.diagnosis.confirm.propose'])('切换病例后旧 Agent 动作 %s 不发送写入', async name => {
  const mounted = setup()
  await addManualDiagnosis()
  const action = mounted.registration.actions[name]!
  await userEvent.setup().click(screen.getByRole('button', { name: '切换合成病例' }))
  await screen.findByRole('button', { name: '添加诊断' })
  await expect(async () => action.execute(agentInput, new AbortController().signal)).rejects.toThrow()
  expect(mounted.writes).toHaveLength(0)
  expect(mounted.confirmations).toHaveLength(0)
})

it('Agent 人审整组确认丢响应后由页面读取原回执，刷新不创建新键或新修订', async () => {
  const mounted = setup()
  await addManualDiagnosis()
  const task = mounted.registration.actions['outpatient.diagnosis.confirm.propose']!.execute(agentInput, new AbortController().signal)
  if (!isAgentReviewTask(task)) throw new Error('Expected public human review task')
  task.bindDecisionGate(async () => {})
  const outcome = task.decision.catch(error => error)
  await userEvent.setup().click(await screen.findByRole('button', { name: '确认诊断' }))
  await outcome
  expect(mounted.confirmations).toHaveLength(1)
  expect(mounted.writes).toHaveLength(0)
  mounted.remount()
  await userEvent.setup().click(await screen.findByRole('button', { name: '恢复原确认' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原确认' })).toBeNull())
  expect(mounted.confirmations).toHaveLength(1)
  expect(mounted.receiptReads).toHaveLength(1)
  expect(mounted.receiptReads[0]).toContain(mounted.confirmations[0]!.key!)
  expect(await screen.findByText(/第 1 次确认/)).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: '选择合成诊断A' })).toBeTruthy()
})

it('Agent 人审已知成功由同一面板消费匹配行，不另读回执或重发', async () => {
  const mounted = setup({ loseResponse: false })
  await addManualDiagnosis()
  const task = mounted.registration.actions['outpatient.diagnosis.confirm.propose']!.execute({ entries: [{ catalogItemId: 'synthetic-diagnosis-a', role: 'primary' }] }, new AbortController().signal)
  if (!isAgentReviewTask(task)) throw new Error('Expected public human review task')
  task.bindDecisionGate(async () => {})
  const outcome = task.decision.catch(error => error)
  await userEvent.setup().click(await screen.findByRole('button', { name: '确认诊断' }))
  expect(await outcome).toMatchObject({ approved: true })
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择合成诊断A' })).toBeNull())
  expect(screen.queryByRole('button', { name: '恢复原确认' })).toBeNull()
  expect(mounted.confirmations).toHaveLength(1)
  expect(mounted.receiptReads).toHaveLength(0)
  expect(mounted.writes).toHaveLength(0)
})

it.each(['secondary', 'primary'] as const)('Agent 主次诊断不合法时不进入人审或冻结，修正后可确认（两条均为 %s）', async role => {
  const mounted = setup({ loseResponse: false })
  await screen.findByRole('button', { name: '添加诊断' })
  const action = mounted.registration.actions['outpatient.diagnosis.confirm.propose']!
  await expect(async () => {
    const task = action.execute({ entries: diagnoses.map(item => ({ catalogItemId: item.id, role })) }, new AbortController().signal)
    if (isAgentReviewTask(task)) void task.decision.catch(() => {})
  }).rejects.toThrow('必须且只能选择一个主诊断。')
  expect(mounted.confirmations).toHaveLength(0)
  expect(screen.queryByRole('button', { name: '确认诊断' })).toBeNull()
  expect(screen.queryByRole('button', { name: '恢复原确认' })).toBeNull()
  expect(screen.getByRole('button', { name: '添加诊断' })).toHaveProperty('disabled', false)
  const corrected = action.execute(agentInput, new AbortController().signal)
  if (!isAgentReviewTask(corrected)) throw new Error('Expected public human review task')
  corrected.bindDecisionGate(async () => {})
  const outcome = corrected.decision
  await userEvent.setup().click(await screen.findByRole('button', { name: '确认诊断' }))
  expect(await outcome).toMatchObject({ approved: true })
  await screen.findByText(/第 1 次确认/)
  expect(mounted.confirmations).toHaveLength(1)
})

it.each([false, true])('主诊断被明确拒绝后可保留备注、修改并重新确认（先丢响应：%s）', async loseRejectionResponse => {
  const mounted = setup({ loseResponse: false, rejectionCode: 'DIAGNOSIS_PRIMARY_REQUIRED', loseRejectionResponse })
  await addManualDiagnosis()
  const user = userEvent.setup()
  const task = mounted.registration.actions['outpatient.diagnosis.confirm.propose']!.execute(agentInput, new AbortController().signal)
  if (!isAgentReviewTask(task)) throw new Error('Expected public human review task')
  task.bindDecisionGate(async () => {})
  const outcome = task.decision.catch(error => error)
  await user.click(await screen.findByRole('button', { name: '确认诊断' }))
  await outcome
  if (loseRejectionResponse) {
    await screen.findByRole('button', { name: '恢复原确认' })
    expect(screen.getByRole('button', { name: '添加诊断' })).toHaveProperty('disabled', true)
    mounted.remount()
    await user.click(await screen.findByRole('button', { name: '恢复原确认' }))
    await waitFor(() => expect(mounted.client.isMutating()).toBe(0))
    expect(mounted.receiptReads).toHaveLength(1)
    expect(mounted.confirmations[1]).toEqual(mounted.confirmations[0])
  }
  await waitFor(() => expect(screen.getByRole('button', { name: '添加诊断' })).toHaveProperty('disabled', false))
  expect(screen.queryByRole('button', { name: '恢复原确认' })).toBeNull()
  expect(screen.queryByText(/第 1 次确认/)).toBeNull()
  await user.click(screen.getByRole('button', { name: '编辑诊断 合成诊断A' }))
  const dialog = within(screen.getByRole('dialog', { name: '编辑诊断' }))
  fireEvent.change(dialog.getByRole('textbox', { name: '诊断备注' }), { target: { value: '重新核实的主诊断备注' } })
  await user.click(dialog.getByRole('button', { name: '保存修改' }))
  await user.click(screen.getByRole('button', { name: /^确认选中诊断/ }))
  await screen.findByText(/第 1 次确认/)
  const confirmed = mounted.confirmations.at(-1)!
  expect(confirmed.key).not.toBe(mounted.confirmations[0]!.key)
  expect(confirmDoctorPreparationRequestSchema.parse(confirmed.body).input.selections).toEqual([
    { kind: 'diagnosis', source: 'manual', catalogItemId: 'synthetic-diagnosis-a', role: 'primary', note: '重新核实的主诊断备注' },
  ])
}, 15_000)

it('Agent 人审在 fresh Session 改变后拒绝发送，原人工草稿保留', async () => {
  const mounted = setup({ session: { ...session, actor: { ...session.actor, actorId: 'another-synthetic-doctor' } } })
  await addManualDiagnosis()
  const task = mounted.registration.actions['outpatient.diagnosis.confirm.propose']!.execute(agentInput, new AbortController().signal)
  if (!isAgentReviewTask(task)) throw new Error('Expected public human review task')
  task.bindDecisionGate(async () => {})
  const outcome = task.decision.catch(error => error)
  await userEvent.setup().click(await screen.findByRole('button', { name: '确认诊断' }))
  expect(await outcome).toBeInstanceOf(Error)
  expect(mounted.confirmations).toHaveLength(0)
  expect(mounted.writes).toHaveLength(0)
  expect(screen.getByRole('checkbox', { name: '选择合成诊断A' })).toBeTruthy()
})

it('已打开的 Agent 人审在另一确认结果未知时也不能发新组', async () => {
  const mounted = setup()
  await addManualDiagnosis()
  const task = mounted.registration.actions['outpatient.diagnosis.confirm.propose']!.execute(agentInput, new AbortController().signal)
  if (!isAgentReviewTask(task)) throw new Error('Expected public human review task')
  task.bindDecisionGate(async () => {})
  const outcome = task.decision.catch(error => error)
  await userEvent.setup().click(await screen.findByRole('button', { name: /^确认选中诊断/ }))
  await screen.findByRole('button', { name: '恢复原确认' })
  await userEvent.setup().click(screen.getByRole('button', { name: '确认诊断' }))
  expect(await outcome).toMatchObject({ message: '请先恢复原操作，再办理新操作。' })
  expect(mounted.confirmations).toHaveLength(1)
  expect(mounted.writes).toHaveLength(0)
})

it.each(['outpatient.diagnosis.draft.set', 'outpatient.diagnosis.confirm.propose'])('未保存的逐行备注阻止旧 Agent 动作 %s 覆盖输入', async name => {
  const mounted = setup()
  await addManualDiagnosis()
  const action = mounted.registration.actions[name]!
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '编辑诊断 合成诊断A' }))
  const dialog = within(screen.getByRole('dialog'))
  await user.type(dialog.getByRole('textbox', { name: '诊断备注' }), '后续未保存备注')
  await user.click(dialog.getByRole('button', { name: '完成选择' }))
  await expect(async () => action.execute(agentInput, new AbortController().signal)).rejects.toThrow('有未保存诊断编辑，请保存修改后再确认。')
  expect(mounted.writes).toHaveLength(0)
  expect(mounted.confirmations).toHaveLength(0)
})

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
    await screen.findByRole('button', { name: '恢复原确认' })
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
