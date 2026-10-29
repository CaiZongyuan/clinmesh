// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialEstimateSchema, inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientMaterialEstimates } from './inpatient-material-estimate.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const evidence = { id: 'estimate-evidence-stent', version: 'v1', synthetic: true, scope: '有限合成单病变', applicability: '仅支持合成方案', compatibility: '仅核对已发布组合', specification: '合成支架 3.0 × 18 mm', quantityBasis: '正式记录支持单病变一枚', sourceLocator: 'synthetic:estimate-stent' }
const material = { materialId: 'hospital-material-stent', catalogVersion: 1, display: '合成支架', unit: '枚', quantity: 1, unitPriceFen: 100000, estimatedFen: 100000, reason: '当前正式病变资料支持', quantityBasis: evidence.quantityBasis, evidenceIds: [evidence.id] }
const ready = inpatientMaterialEstimateSchema.parse({ id: 'estimate-1', admissionId: admission.id, requestId: 'surgery-1', version: 1, requestVersion: 1, status: 'succeeded', basisFingerprint: 'a'.repeat(64), failureCode: null, missing: [],
  candidates: [{ materialId: material.materialId, catalogVersion: 1, item: { id: material.materialId, version: 1, display: material.display, chargeDefinition: { id: 'charge-stent', priceFen: 100000, unit: '枚', synthetic: true, trigger: 'execution' } }, evidence, quantityBasis: evidence.quantityBasis, expectedQuantity: 1, eligibility: 'valid', missing: [] }],
  analysis: { id: 'analysis-1', revision: 1, basisFingerprint: 'a'.repeat(64), stage: 'preoperative', createdAt: '2026-08-24T09:00:00+08:00', model: 'synthetic-estimate-model', items: [material], sources: { requestId: 'surgery-1', evidencePackageId: 'estimate-evidence', evidencePackageVersion: 'v1', materialEvidence: [evidence] } },
  draft: { revision: 1, basisFingerprint: 'a'.repeat(64), analysisId: 'analysis-1', items: [{ materialId: material.materialId, catalogVersion: 1, quantity: 1, reason: material.reason }], note: '', edited: false, updatedAt: '2026-08-24T09:00:00+08:00', updatedBy: 'actor-doctor', confirmedRevision: null, reservationIds: [] }, candidateItems: [],
})
const emptyReservations = inpatientMaterialReservationListSchema.parse({ admissionId: admission.id, encounterVersion: '2', reservations: [] })

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount(currentSession = session, currentAdmission = admission) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Content({ acting, stay }: { acting: SessionContext; stay: typeof admission }) {
    const write = useInpatientWriteIntent(acting, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientWriteRecovery write={write} locale="zh-CN" /><InpatientMaterialEstimates admission={stay} session={acting} locale="zh-CN" write={write} /></>
  }
  const view = render(<QueryClientProvider client={client}><Content acting={currentSession} stay={currentAdmission} /></QueryClientProvider>)
  return { client, unmount: view.unmount, rerender: (stay: typeof admission) => view.rerender(<QueryClientProvider client={client}><Content acting={currentSession} stay={stay} /></QueryClientProvider>) }
}

function reads(estimate = ready) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/material-estimates')) return Response.json(inpatientMaterialEstimatesSchema.parse({ admissionId: admission.id, estimates: [estimate], unprepared: [] }))
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    throw new Error(`Unexpected request ${path}`)
  }))
  return requests
}

it('保存计划后的预计展示正式目录金额与有限合成依据，页面读取不派发模型或创建预留', async () => {
  const requests = reads()
  mount()
  const region = await screen.findByRole('region', { name: '手术耗材预计' })
  await within(region).findByText('AI 预计与独立核验已完成')
  expect(within(region).getAllByText(/hospital-material-stent v1/).length).toBeGreaterThan(0)
  expect(within(region).getAllByText(/¥1,000.00/).length).toBeGreaterThan(0)
  expect(within(region).getAllByText(/合成支架 3.0 × 18 mm/).length).toBeGreaterThan(0)
  expect(within(region).getAllByText(/正式记录支持单病变一枚/).length).toBeGreaterThan(0)
  expect(requests.every(request => request.startsWith('GET '))).toBe(true)
  expect(within(region).getByText(/工作稿与有效预留分别保存/)).toBeDefined()
})

it('编辑自动合并保存后重新挂载恢复手改内容，保存不创建预留', async () => {
  let current = ready
  const posts: Array<{ path: string; input: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push({ path, input })
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, items: input.items,
        note: input.note, analysisId: input.analysisId, revision: 2, edited: true } })
      return Response.json({ data: current, auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const first = mount(), user = userEvent.setup()
  const reason = await screen.findByRole('textbox', { name: '预计理由：合成支架' })
  await user.clear(reason); await user.type(reason, '医生保留的个体用途')
  await user.type(screen.getByRole('textbox', { name: '工作稿说明' }), '待核对后统一确认')
  await screen.findByText(/服务端工作稿：v2/, {}, { timeout: 3_000 })
  first.unmount(); mount()
  expect((await screen.findByRole('textbox', { name: '预计理由：合成支架' })).getAttribute('value')).toBe('医生保留的个体用途')
  expect(screen.getByRole('textbox', { name: '工作稿说明' }).getAttribute('value')).toBe('待核对后统一确认')
  expect(posts).toEqual([{ path: '/api/his/v1/inpatient/admissions/admission-1/material-estimates/save', input: {
    requestId: 'surgery-1', expectedVersion: 1, expectedDraftRevision: 1, expectedBasisFingerprint: 'a'.repeat(64), analysisId: 'analysis-1',
    items: [{ materialId: material.materialId, catalogVersion: 1, quantity: 1, reason: '医生保留的个体用途' }], note: '待核对后统一确认',
  } }])
})

it('晚到的新预计作为候选差异展示，保留当前手改和焦点，医生显式采用后才替换', async () => {
  let current = ready
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount(), user = userEvent.setup()
  const reason = await screen.findByRole('textbox', { name: '预计理由：合成支架' })
  await user.clear(reason); await user.type(reason, '未保存的医生判断')
  current = inpatientMaterialEstimateSchema.parse({ ...ready, version: 2,
    analysis: { ...ready.analysis!, id: 'analysis-2', revision: 2, items: [{ ...material, reason: '新模型候选用途' }] },
    candidateItems: [{ ...material, reason: '新模型候选用途' }] })
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  const candidates = await screen.findByRole('region', { name: '新预计候选差异' })
  expect(reason.getAttribute('value')).toBe('未保存的医生判断')
  expect(document.activeElement).toBe(reason)
  expect(candidates.textContent).toContain('新模型候选用途')
  await user.click(screen.getByRole('button', { name: '采用新候选到工作稿' }))
  expect(screen.getByRole('textbox', { name: '预计理由：合成支架' }).getAttribute('value')).toBe('新模型候选用途')
})

it('修改后一次确认先持久保存，再原子确认完整本计划预留替代清单，其他计划不进入替代范围', async () => {
  let current = ready
  const reservations = inpatientMaterialReservationListSchema.parse({ ...emptyReservations, reservations: [
    { id: 'reservation-old', admissionId: admission.id, requestId: 'surgery-1', materialId: material.materialId, materialDisplay: material.display, quantity: 1,
      unit: '枚', specification: '原冻结规格', consumedQuantity: 0, version: 3, priceFen: 90000, status: 'reserved', reason: '原计划预留', createdAt: '2026-08-24T09:00:00+08:00' },
    { id: 'reservation-other', admissionId: admission.id, requestId: 'surgery-other', materialId: material.materialId, materialDisplay: material.display, quantity: 1,
      priceFen: 100000, status: 'reserved', reason: '另一计划', createdAt: '2026-08-24T09:00:00+08:00' },
  ] })
  const posts: Array<{ path: string; input: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(reservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push({ path, input })
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, revision: 2, items: input.items, note: input.note, edited: true } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    if (path.endsWith('/material-estimates/confirm')) {
      const { input } = JSON.parse(String(init?.body)); posts.push({ path, input })
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, confirmedRevision: 2, reservationIds: ['reservation-new'] } })
      return Response.json({ data: current, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.type(await screen.findByRole('textbox', { name: '工作稿说明' }), '医生统一审阅本计划')
  expect(screen.getByRole('region', { name: '本计划有效预留' }).textContent).toContain('reservation-old v3')
  expect(screen.getByRole('region', { name: '本计划有效预留' }).textContent).not.toContain('reservation-other')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await screen.findByRole('button', { name: '本版工作稿已确认' })
  expect(posts.map(post => post.path.split('/').at(-1))).toEqual(['save', 'confirm'])
  expect(posts[1]?.input).toEqual({ requestId: 'surgery-1', expectedVersion: 1, expectedDraftRevision: 2,
    expectedBasisFingerprint: 'a'.repeat(64), expectedRequestVersion: 1, encounterVersion: '2',
    replace: [{ reservationId: 'reservation-old', expectedVersion: 3 }], reason: '医生统一审阅本计划' })
})

it('数量超出依据仍可保存工作稿，不能确认未经核对的具体项', async () => {
  reads()
  mount()
  const user = userEvent.setup()
  const quantity = await screen.findByRole('spinbutton', { name: '预计数量：合成支架' })
  await user.clear(quantity); await user.type(quantity, '2')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  expect(screen.getByRole('button', { name: '保存工作稿' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/具体产品或数量尚未通过当前依据核对/)).toBeDefined()
})

it.each(['unknown', 'stale', 'cancelled', 'queued', 'running'] as const)('%s 状态保留工作稿但禁止确认旧结果', async status => {
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, status, failureCode: status === 'unknown' ? 'MODEL_OUTCOME_UNKNOWN' : null }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('textbox', { name: '预计理由：合成支架' }).getAttribute('value')).toBe('当前正式病变资料支持')
  if (status === 'unknown') expect(screen.getByRole('button', { name: '重新预计，保留工作稿' }).hasAttribute('disabled')).toBe(true)
})

it('护士只读查看工作稿和有效预留，不显示任何预计写操作', async () => {
  reads()
  mount({ ...session, actor: { ...session.actor, roleCode: 'ward-nurse', practitionerRoleId: 'role-nurse' } })
  await screen.findByText('当前岗位或病案状态只允许查看。')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /确认整批预留|保存工作稿|重新预计|院内方案/ })).toBeNull()
  expect(screen.getByText(/预计数量：1枚/)).toBeDefined()
})

it('自动保存进行中继续编辑，旧保存回执只推进版本并保留新输入，随后按新版本再保存', async () => {
  let current = ready
  let release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const posts: Array<{ expectedDraftRevision: number; items: Array<{ reason: string }> }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input)
      if (posts.length === 1) { started(); await held }
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, revision: posts.length + 1, items: input.items, note: input.note, edited: true } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup(), reason = await screen.findByRole('textbox', { name: '预计理由：合成支架' })
  await user.clear(reason); await user.type(reason, '第一版')
  await began
  expect(reason.matches(':disabled')).toBe(false)
  await user.clear(reason); await user.type(reason, '保存中继续输入的第二版')
  await act(async () => { release() })
  await screen.findByText(/服务端工作稿：v3/, {}, { timeout: 4_000 })
  expect(reason.getAttribute('value')).toBe('保存中继续输入的第二版')
  expect(posts.map(post => ({ revision: post.expectedDraftRevision, reason: post.items[0]?.reason }))).toEqual([
    { revision: 1, reason: '第一版' }, { revision: 2, reason: '保存中继续输入的第二版' },
  ])
})

it('依据变化后保留旧工作稿，显式核对才按新依据保存，旧分析身份不被沿用', async () => {
  let stale = inpatientMaterialEstimateSchema.parse({ ...ready, status: 'stale', version: 2, basisFingerprint: 'b'.repeat(64) })
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [stale], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input)
      stale = inpatientMaterialEstimateSchema.parse({ ...stale, draft: { ...stale.draft!, revision: 2, basisFingerprint: 'b'.repeat(64), analysisId: null } })
      return Response.json({ data: stale, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await screen.findByText(/工作稿依据已变化，原编辑仍保留/)
  expect(screen.getByRole('button', { name: '保存工作稿' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '按当前依据核对工作稿' }))
  await screen.findByText(/服务端工作稿：v2/, {}, { timeout: 3_000 })
  expect(posts).toEqual([{ requestId: 'surgery-1', expectedVersion: 2, expectedDraftRevision: 1,
    expectedBasisFingerprint: 'b'.repeat(64), analysisId: null,
    items: [{ materialId: 'hospital-material-stent', catalogVersion: 1, quantity: 1, reason: '当前正式病变资料支持' }], note: '' }])
})

it('无模型时有效院内方案可带入人工工作稿，并允许核对后确认', async () => {
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, status: 'blocked', failureCode: 'MODEL_METERING_UNAVAILABLE', analysis: null, draft: null }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '从有效院内方案带入' }))
  expect(screen.getByRole('textbox', { name: '预计理由：合成支架' }).getAttribute('value')).toBe('正式记录支持单病变一枚')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(false)
})

it('无依据建议与普通模型失败分开说明，拒绝结果不成为可确认 AI 清单', async () => {
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, status: 'failed', failureCode: 'INPATIENT_DRG_AGENT_INVALID', analysis: null, draft: null }))
  mount()
  await screen.findByText(/AI 建议未通过材料、兼容性或数量依据核验/)
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '从有效院内方案带入' }).hasAttribute('disabled')).toBe(false)
})

it('确认前自动保存仍在途时切换病例，晚到保存不继续提交旧病例确认', async () => {
  let release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/admission-2/')) return Response.json(path.endsWith('/material-estimates') ? { admissionId: 'admission-2', estimates: [], unprepared: [] } : { ...emptyReservations, admissionId: 'admission-2' })
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [ready], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      posts.push(path); const { input } = JSON.parse(String(init?.body)); started(); await held
      return Response.json({ data: { ...ready, draft: { ...ready.draft!, revision: 2, items: input.items, note: input.note } }, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    posts.push(path)
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount(), user = userEvent.setup()
  await user.type(await screen.findByRole('textbox', { name: '工作稿说明' }), '旧病例审阅')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await began
  view.rerender({ ...admission, id: 'admission-2', patientName: '另一合成患者' })
  await screen.findByText('暂无需要预计的冠脉手术计划。')
  await act(async () => { release() })
  await vi.waitFor(() => expect(sessionStorage.length).toBe(0))
  expect(posts).toEqual(['/api/his/v1/inpatient/admissions/admission-1/material-estimates/save'])
})
