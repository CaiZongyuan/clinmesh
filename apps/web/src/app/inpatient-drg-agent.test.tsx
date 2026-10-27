// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import { inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgAgentPanel } from './inpatient-drg-agent.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const item = { materialId: 'hospital-material-pci-stent', catalogVersion: 1, display: '合成支架', unit: '枚', quantity: 1, unitPriceFen: 100000, estimatedFen: 100000, reason: '合成病变范围内的方案', quantityBasis: '医生独立确认单病变一枚', evidenceIds: ['pci-evidence-stent'] }
const sources = { selectionConfirmationId: 'selection-1', selectionVersion: 1, evidencePackageId: 'evidence-1', evidencePackageVersion: 'v1', materialEvidence: [{ id: 'pci-evidence-stent', version: 'v1', synthetic: true, scope: '合成单病变', applicability: '合成适用声明', compatibility: '合成兼容声明', specification: '合成支架规格', quantityBasis: '独立数量计划', sourceLocator: 'synthetic:stent' }] }
const ready = inpatientDrgAgentSchema.parse({ admissionId: admission.id, taskId: 'task-1', status: 'succeeded', basisFingerprint: 'a'.repeat(64), stage: 'preoperative', missing: [], failureCode: null,
  analysis: { id: 'analysis-1', revision: 1, basisFingerprint: 'a'.repeat(64), stage: 'preoperative', createdAt: '2026-08-24T09:00:00+08:00', model: 'synthetic-drg-model', items: [item], sources }, confirmedPlan: null, planHistory: [] })
const selection = inpatientPciSelectionSchema.parse({ admissionId: admission.id, confirmation: { id: 'selection-1', version: 1, confirmedBy: 'actor-doctor', practitionerRoleId: 'role-doctor', confirmedAt: '2026-08-24T09:00:00+08:00', parameters: { treatmentPlan: 'PCI', targetSite: 'LAD', measurements: [], plannedQuantities: [{ category: 'stent', quantity: 1, basis: '医生独立确认单病变一枚' }], approvedMaterialIds: [item.materialId] } }, history: [],
  evidencePackage: { id: 'evidence-1', version: 'v1', synthetic: true, limitation: '有限合成仿真' }, candidates: [{ materialId: item.materialId, materialVersion: 1, category: 'stent', item: { id: item.materialId, version: 1, display: item.display, chargeDefinition: { id: 'charge-stent', priceFen: item.unitPriceFen, unit: '枚', synthetic: true, trigger: 'execution' } },
    evidence: { id: 'pci-evidence-stent', version: 'v1', synthetic: true, scope: '合成单病变', applicability: '合成适用声明', compatibility: '合成兼容声明', specification: '合成支架规格', quantityBasis: '独立数量计划', sourceLocator: 'synthetic:stent' }, eligibility: 'valid', missing: [], expectedQuantity: 1, expectedAmountFen: item.estimatedFen }] })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount(currentAdmission = admission) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Content({ stay }: { stay: typeof admission }) {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientWriteRecovery write={write} locale="zh-CN" /><InpatientDrgAgentPanel admission={stay} session={session} locale="zh-CN" write={write} active /></>
  }
  const view = render(<QueryClientProvider client={client}><Content stay={currentAdmission} /></QueryClientProvider>)
  return { client, unmount: view.unmount, rerender: (stay: typeof admission) => view.rerender(<QueryClientProvider client={client}><Content stay={stay} /></QueryClientProvider>) }
}
it('当前建议展示模型、产品版本、独立数量来源和预计收费，说明等待医生确认', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/drg/agent')) return Response.json(ready)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  const region = await screen.findByRole('region', { name: '住院耗材建议' })
  await within(region).findByText(/synthetic-drg-model/)
  expect(within(region).getAllByText(/医生独立确认单病变一枚/).length).toBeGreaterThan(0)
  expect(within(region).getAllByText(/hospital-material-pci-stent v1/).length).toBeGreaterThan(0)
  expect(within(region).getAllByText(/¥1,000.00/).length).toBeGreaterThan(0)
  expect(within(region).getByText(/建议尚未作为已确认计划/)).toBeDefined()
})

it('本轮分析失败仍可只读查看上次已发布建议，不能确认历史结果', async () => {
  const failed = inpatientDrgAgentSchema.parse({ ...ready, status: 'failed', basisFingerprint: 'b'.repeat(64),
    failureCode: 'INPATIENT_DRG_AGENT_FAILED', analysis: null, lastAnalysis: ready.analysis, lastStatus: 'failed' })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/drg/agent')) return Response.json(failed)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  const region = await screen.findByRole('region', { name: '住院耗材建议' })
  await within(region).findByText('历史模型建议，暂不可确认', { exact: true })
  expect(within(region).getByText(/synthetic-drg-model/)).toBeDefined()
  expect(within(region).getByText(/INPATIENT_DRG_AGENT_FAILED/)).toBeDefined()
  expect(within(region).queryByRole('button', { name: '确认耗材计划', exact: true })).toBeNull()
  await userEvent.setup().click(within(region).getByText('查看原参数与证据版本', { exact: true }))
  expect(within(region).getByText('原参数确认：selection-1 v1')).toBeDefined()
})

it('本阶段没有剩余耗材建议时说明结果，不展示无法提交的空计划表单', async () => {
  const completed = inpatientDrgAgentSchema.parse({ ...ready, stage: 'postoperative',
    analysis: { ...ready.analysis!, stage: 'postoperative', items: [] } })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/drg/agent')) return Response.json(completed)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  const region = await screen.findByRole('region', { name: '住院耗材建议' })
  await within(region).findByText('本阶段没有新增耗材建议。', { exact: true })
  expect(within(region).queryByRole('button', { name: '确认耗材计划', exact: true })).toBeNull()
  expect(within(region).queryByText(/修改后的产品或数量超出当前核验范围/)).toBeNull()
})

it('医生修改理由后按当前建议和计划版本确认，成功后展示保存的计划与历史', async () => {
  let current = ready
  const submitted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    if (path.endsWith('/drg/agent')) return Response.json(current)
    if (path.endsWith('/drg/agent/confirm')) {
      const { input } = JSON.parse(String(init?.body)); submitted.push(input)
      const plan = { stage: 'preoperative', sources, revision: 1, analysisId: input.analysisId, basisFingerprint: input.expectedBasisFingerprint,
        items: input.items.map((value: { quantity: number; reason: string }) => ({ ...item, quantity: value.quantity, reason: value.reason })),
        note: input.note, confirmedBy: 'actor-doctor', confirmedAt: '2026-08-24T09:00:00+08:00' }
      current = inpatientDrgAgentSchema.parse({ ...ready, confirmedPlan: plan, planHistory: [plan] })
      return Response.json({ data: current, auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  const reason = await screen.findByRole('textbox', { name: '计划理由：合成支架' })
  await user.clear(reason); await user.type(reason, '医生修改后的用途说明')
  await user.type(screen.getByRole('textbox', { name: '医生确认说明' }), '已核对具体产品与来源')
  await user.click(screen.getByRole('button', { name: '确认耗材计划' }))
  await screen.findByRole('region', { name: '已确认耗材计划' })
  expect(submitted).toEqual([{ analysisId: 'analysis-1', expectedBasisFingerprint: 'a'.repeat(64), expectedRevision: 0, note: '已核对具体产品与来源',
    items: [{ materialId: 'hospital-material-pci-stent', catalogVersion: 1, quantity: 1, reason: '医生修改后的用途说明' }] }])
  expect(screen.getAllByText(/已核对具体产品与来源/).length).toBeGreaterThan(0)
  expect(screen.getByText('查看已确认计划历史')).toBeDefined()
  const savedPlan = screen.getByRole('region', { name: '已确认耗材计划' })
  await user.click(within(savedPlan).getByText('查看原参数与证据版本'))
  expect(within(savedPlan).getByText('原参数确认：selection-1 v1')).toBeDefined()
  expect(within(savedPlan).getByText('原依据包：evidence-1 · v1')).toBeDefined()
})


it('超出核验数量、旧依据、未知及受阻状态均不能确认旧建议', async () => {
  let current = ready
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/drg/agent')) return Response.json(current)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    throw new Error(`Unexpected read ${path}`)
  }))
  const { client } = mount(), user = userEvent.setup()
  const quantity = await screen.findByRole('spinbutton', { name: '预计数量：合成支架' })
  await user.type(screen.getByRole('textbox', { name: '医生确认说明' }), '医生审阅说明')
  await user.clear(quantity); await user.type(quantity, '2')
  expect(screen.getByRole('button', { name: '确认耗材计划' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/修改后的产品或数量超出当前核验范围/)).toBeDefined()
  await user.clear(quantity); await user.type(quantity, '1')
  expect(screen.getByRole('button', { name: '确认耗材计划' }).hasAttribute('disabled')).toBe(false)
  for (const status of ['stale', 'unknown', 'blocked', 'failed', 'incomplete'] as const) {
    current = inpatientDrgAgentSchema.parse({ ...ready, status, basisFingerprint: 'b'.repeat(64), missing: status === 'incomplete' ? ['缺少新测量'] : [], failureCode: status === 'unknown' ? 'MODEL_OUTCOME_UNKNOWN' : status === 'blocked' ? 'MODEL_METERING_UNAVAILABLE' : null })
    await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
    await screen.findByText({ stale: '依据已变化，建议需重评', unknown: '模型请求结果未知，等待核查', blocked: '模型分析尚未完成，派发受阻', failed: '模型分析失败', incomplete: '模型分析尚未完成，依据不完整' }[status], { exact: true })
    expect(screen.getByRole('button', { name: '确认耗材计划' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('历史模型建议，暂不可确认')).toBeDefined()
  }
  expect(screen.getByText('缺少新测量')).toBeDefined()
})

it('确认丢回执后重挂载只恢复原回执，保留原建议、依据和计划版本而不重发确认', async () => {
  let current = ready, originalKey: string | null = null
  const posts: unknown[] = [], receiptKeys: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    if (path.endsWith('/drg/agent')) return Response.json(current)
    if (path.endsWith('/drg/agent/confirm')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input)
      originalKey = new Headers(init?.headers).get('idempotency-key')
      const plan = { stage: 'preoperative', sources, revision: 1, analysisId: input.analysisId, basisFingerprint: input.expectedBasisFingerprint, items: [item], note: input.note, confirmedBy: 'actor-doctor', confirmedAt: '2026-08-24T09:00:00+08:00' }
      current = inpatientDrgAgentSchema.parse({ ...ready, confirmedPlan: plan, planHistory: [plan] })
      throw new TypeError('synthetic committed response loss')
    }
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'http://localhost').searchParams
      expect(query.get('operationId')).toBe('inpatient.drg.agent.confirm')
      receiptKeys.push(query.get('idempotencyKey')!)
      return Response.json({ operationId: 'inpatient.drg.agent.confirm', idempotencyKey: originalKey, status: 'completed', response: { data: current, auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [] } })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const first = mount(), user = userEvent.setup()
  await screen.findByRole('textbox', { name: '医生确认说明' })
  await user.type(screen.getByRole('textbox', { name: '医生确认说明' }), '保留原确认意图')
  await user.click(screen.getByRole('button', { name: '确认耗材计划' }))
  await screen.findByRole('button', { name: '恢复原住院操作' })
  first.unmount()
  mount()
  await user.click(await screen.findByRole('button', { name: '恢复原住院操作' }))
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '恢复原住院操作' })).toBeNull())
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ analysisId: 'analysis-1', expectedRevision: 0, expectedBasisFingerprint: 'a'.repeat(64), note: '保留原确认意图' })
  expect(receiptKeys).toEqual([originalKey])
  expect(sessionStorage.length).toBe(0)
  expect(await screen.findByRole('region', { name: '已确认耗材计划' })).toBeDefined()
})


it('切换住院后迟到的旧确认失败不显示在新病例，旧建议也不会混入', async () => {
  let release: (response: Response) => void = () => { throw new Error('Missing pending confirmation') }
  const response = new Promise<Response>(resolve => { release = resolve })
  let posted = false
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/agent/confirm')) { posted = true; return response }
    if (path.includes('/admission-2/')) return Response.json(path.endsWith('/drg/agent')
      ? { ...ready, admissionId: 'admission-2', taskId: null, status: 'inactive', analysis: null }
      : { ...selection, admissionId: 'admission-2', confirmation: null, candidates: [] })
    if (path.endsWith('/drg/agent')) return Response.json(ready)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount(), user = userEvent.setup()
  await user.type(await screen.findByRole('textbox', { name: '医生确认说明' }), '旧病例确认说明')
  await user.click(screen.getByRole('button', { name: '确认耗材计划' }))
  await vi.waitFor(() => expect(posted).toBe(true))
  view.rerender({ ...admission, id: 'admission-2', patientName: '新合成患者' })
  await screen.findByText('尚未开启模型分析')
  await act(async () => { release(Response.json({ error: { code: 'INPATIENT_DRG_AGENT_STALE', message: '旧病例专用失败信息' } }, { status: 409 })) })
  await vi.waitFor(() => expect(sessionStorage.length).toBe(0))
  expect(screen.queryByText(/旧病例专用失败信息/)).toBeNull()
  expect(screen.queryByText(/hospital-material-pci-stent v1/)).toBeNull()
  expect(screen.queryByRole('button', { name: '确认耗材计划' })).toBeNull()
})

it('同依据后台刷新保留医生输入和焦点，仅暂时冻结确认', async () => {
  let reads = 0, release: () => void = () => undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    if (path.endsWith('/drg/agent')) { reads++; if (reads === 2) await barrier; return Response.json(ready) }
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount(), user = userEvent.setup()
  const reason = await screen.findByRole('textbox', { name: '计划理由：合成支架' })
  await user.type(screen.getByRole('textbox', { name: '医生确认说明' }), '先保留审阅说明')
  await user.type(reason, '，医生继续编辑')
  let refresh: Promise<void> | undefined
  act(() => { refresh = client.invalidateQueries({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'drg-agent'] }) })
  await vi.waitFor(() => expect(reads).toBe(2))
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '确认耗材计划' }).hasAttribute('disabled')).toBe(true))
  expect(reason.matches(':disabled')).toBe(false)
  expect(document.activeElement).toBe(reason)
  await act(async () => { release(); await refresh })
  expect(screen.getByRole('textbox', { name: '计划理由：合成支架' }).getAttribute('value')).toContain('医生继续编辑')
  expect(document.activeElement).toBe(reason)
})
