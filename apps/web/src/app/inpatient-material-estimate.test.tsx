// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialEstimateSchema, inpatientMaterialEstimatesSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { inpatientCostsSchema, inpatientMaterialReservationListSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientPciSelectionDraftSchema, inpatientPciSelectionSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientMaterialEstimates } from './inpatient-material-estimate.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import type { ComponentProps } from 'react'

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
const emptyReservations = inpatientMaterialReservationListSchema.parse({ admissionId: admission.id, encounterVersion: '2', reservations: [],
  reservationSets: [{ requestId: 'surgery-1', fingerprint: 'c'.repeat(64) }] })
const pciRequest = inpatientSurgeryRequestSchema.parse({ id: 'surgery-1', admissionId: admission.id, version: 1, status: 'requested',
  plannedProcedure: { id: 'hospital-pci', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成 PCI 计划', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.test/coding', sourceSha256: '0'.repeat(64), sourceLocator: 'test:1' }, chargeDefinition: { id: 'charge-pci', priceFen: 180000, unit: '次', synthetic: true, trigger: 'execution' } },
  plannedFor: '2026-08-25T09:00:00+08:00', reason: '合成计划', requestedAt: '2026-08-24T09:00:00+08:00', requestedBy: 'doctor', organizationId: 'organization-inpatient' })
const pciDraft = inpatientPciSelectionDraftSchema.parse({ requestId: 'surgery-1', version: 1, reportId: 'report-1', reportVersion: 1,
  edited: false, confirmedSelectionVersion: null, parameters: { requestId: 'surgery-1', treatmentPlan: '合成 PCI 计划', targetSite: 'LAD 中段',
    measurements: [{ kind: 'lesion-length', object: 'lesion', site: 'LAD 中段', value: 12, unit: 'mm', method: '合成定量造影',
      source: { reference: 'DiagnosticReport/report-1', version: '1', note: '正式合成造影报告', synthetic: true } },
    ...(['proximal-reference-diameter', 'distal-reference-diameter'] as const).map(kind => ({ kind, object: 'reference-lumen', site: 'LAD 中段', value: 3, unit: 'mm', method: '合成定量造影',
      source: { reference: 'DiagnosticReport/report-1', version: '1', note: '正式合成造影报告', synthetic: true } }))],
    plannedQuantities: [{ category: 'stent', quantity: 1, basis: '有限合成单病变方案' }], approvedMaterialIds: [] } })
const pciSelection = inpatientPciSelectionSchema.parse({ admissionId: admission.id, confirmation: null, history: [],
  evidencePackage: { id: 'pci-evidence', version: 'v1', synthetic: true, limitation: '有限合成范围' }, candidates: [], drafts: [pciDraft] })
const angiographyReport = { id: 'report-1', admissionId: admission.id, procedureId: 'angiography-1', version: 1, synthetic: true,
  status: 'final', targetSite: 'LAD 中段', measurements: pciDraft.parameters.measurements, missing: [], issuedAt: '2026-08-24T09:00:00+08:00' }
const costs = inpatientCostsSchema.parse({ fingerprint: 'd'.repeat(64),
  components: { formalChargesFen: 200000, pendingOrdersFen: 15000, remainingMaterialsFen: 100000, plannedSurgeryFen: 30000, projectedTotalFen: 345000 },
  currentGrouping: { status: 'ungroupable', drgCode: null, mdcCode: null, adrgCode: null, reason: '尚未启用', steps: [] },
  projectedGrouping: { status: 'ungroupable', drgCode: null, mdcCode: null, adrgCode: null, reason: '尚未启用', steps: [] },
  currentPaymentReference: null, projectedPaymentReference: null, currentDifferenceFen: null, projectedDifferenceFen: null,
  paymentStatus: 'rules-unavailable', paymentMessage: '医院尚未启用医保分组', exceptionAlert: 'unknown' })

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount(currentSession = session, currentAdmission = admission, surgery?: Pick<ComponentProps<typeof InpatientMaterialEstimates>, 'requests' | 'inProgressRequestIds'>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Content({ acting, stay, active = true }: { acting: SessionContext; stay: typeof admission; active?: boolean }) {
    const write = useInpatientWriteIntent(acting, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <><InpatientWriteRecovery write={write} locale="zh-CN" /><InpatientMaterialEstimates admission={stay} session={acting} locale="zh-CN" write={write} {...surgery} active={active} /></>
  }
  const view = render(<QueryClientProvider client={client}><Content acting={currentSession} stay={currentAdmission} /></QueryClientProvider>)
  return { client, unmount: view.unmount, rerender: (stay: typeof admission, active = true) => view.rerender(<QueryClientProvider client={client}><Content acting={currentSession} stay={stay} active={active} /></QueryClientProvider>) }
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

it('报告带入参数与待确认清单同屏展示，一次确认只派发整批确认命令', async () => {
  let current = inpatientMaterialEstimateSchema.parse({ ...ready, costs })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/pci-selection')) return Response.json(pciSelection)
    if (path.endsWith('/angiography-reports')) return Response.json({ admissionId: admission.id, reports: [angiographyReport] })
    if (path.endsWith('/material-estimates/confirm')) {
      posts.push(path)
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, confirmedRevision: 1 } })
      return Response.json({ data: current, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`)
  }))
  mount(session, admission, { requests: [pciRequest] })
  const region = await screen.findByRole('region', { name: '报告带入的 PCI 参数' })
  expect(within(region).getByRole('spinbutton', { name: '病变长度 数值' }).getAttribute('value')).toBe('12')
  expect(within(region).getByRole('spinbutton', { name: '近端参考直径 数值' }).getAttribute('value')).toBe('3')
  expect(within(region).getByText('绑定造影报告：report-1 v1 · 选型草稿 v1')).toBeDefined()
  expect(within(region).getAllByText('助手').length).toBeGreaterThan(0)
  expect(within(region).getByText('依据')).toBeDefined()
  expect(screen.getByRole('region', { name: '住院费用与医保参考' }).textContent).toContain('¥3,450.00')
  expect(screen.getByText('医院尚未启用医保分组')).toBeDefined()
  const user = userEvent.setup()
  await user.click(screen.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理' }))
  expect(screen.getByRole('region', { name: '当前操作' }).getAttribute('data-tone')).toBe('assistant')
  await user.click(screen.getByRole('button', { name: '确认选型、清单与预留' }))
  await screen.findByRole('button', { name: '本版耗材清单已确认' })
  expect(posts).toEqual(['/api/his/v1/inpatient/admissions/admission-1/material-estimates/confirm'])
})

it('人工修订报告参数只保存草稿，原报告原值仍可核对且旧审阅立即撤销', async () => {
  let selection = pciSelection
  const posts: Array<{ path: string; input: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [ready], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    if (path.endsWith('/angiography-reports')) return Response.json({ admissionId: admission.id, reports: [angiographyReport] })
    if (path.endsWith('/pci-selection/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push({ path, input })
      selection = inpatientPciSelectionSchema.parse({ ...selection, drafts: [{ ...pciDraft, version: 2, edited: true,
        parameters: { ...input.parameters, measurements: input.parameters.measurements.map((item: typeof pciDraft.parameters.measurements[number]) => item.kind !== 'lesion-length' ? item : { ...item,
          source: { reference: 'InpatientPciSelectionDraft/surgery-1', version: '2', note: '医生人工修订', synthetic: true } }) } }] })
      return Response.json({ data: selection, auditId: 'audit-pci-save', requestId: 'request-pci-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount(session, admission, { requests: [pciRequest] })
  const length = await screen.findByRole('spinbutton', { name: '病变长度 数值' }), user = userEvent.setup()
  const review = screen.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理' })
  await user.click(review)
  fireEvent.change(length, { target: { value: '0' } })
  expect(length.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByText('请输入大于 0 且不超过 1000 的有限数值，未知可留空。')).toBeDefined()
  expect(screen.getByRole('button', { name: '保存选型草稿' }).hasAttribute('disabled')).toBe(true)
  expect(posts).toEqual([])
  fireEvent.change(length, { target: { value: '13' } })
  expect(length.hasAttribute('aria-invalid')).toBe(false)
  expect(screen.queryByText('请输入大于 0 且不超过 1000 的有限数值，未知可留空。')).toBeNull()
  expect(review.getAttribute('aria-checked')).toBe('false')
  expect(length.closest('[data-agent-draft-source]')).toBeNull()
  expect(screen.getByText('医生人工修订；绑定报告仅作为原始依据，不代表报告原值。')).toBeDefined()
  expect(screen.getByRole('button', { name: '确认选型、清单与预留' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '保存选型草稿' }))
  await screen.findByText('绑定造影报告：report-1 v1 · 选型草稿 v2')
  expect(length.getAttribute('value')).toBe('13')
  expect(screen.getByText(/病变长度 · 12 mm · LAD 中段/)).toBeDefined()
  expect(posts).toEqual([{ path: '/api/his/v1/inpatient/admissions/admission-1/pci-selection/save', input: {
    requestId: 'surgery-1', expectedDraftVersion: 1, parameters: { ...pciDraft.parameters,
      measurements: expect.arrayContaining(pciDraft.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 13 } : item)) },
  } }])
})

it('报告缺少测量时保持空值并说明缺项，不从支架目录补出管径或允许确认', async () => {
  const partialDraft = { ...pciDraft, parameters: { ...pciDraft.parameters, measurements: pciDraft.parameters.measurements.filter(item => item.kind === 'lesion-length') } }
  const missing = ['近端与远端参考管径尚未取得']
  const incomplete = inpatientMaterialEstimateSchema.parse({ ...ready, status: 'incomplete', missing, analysis: null, draft: null,
    candidates: ready.candidates.map(candidate => ({ ...candidate, eligibility: 'incomplete', expectedQuantity: null, missing })) })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(path)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [incomplete], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/pci-selection')) return Response.json({ ...pciSelection, drafts: [partialDraft] })
    if (path.endsWith('/angiography-reports')) return Response.json({ admissionId: admission.id, reports: [{ ...angiographyReport, status: 'partial', measurements: partialDraft.parameters.measurements, missing }] })
    throw new Error(`Unexpected request ${path}`)
  }))
  mount(session, admission, { requests: [pciRequest] })
  const region = await screen.findByRole('region', { name: '报告带入的 PCI 参数' })
  expect(within(region).getByRole('spinbutton', { name: '近端参考直径 数值' }).getAttribute('value')).toBe('')
  expect(within(region).getByRole('spinbutton', { name: '远端参考直径 数值' }).getAttribute('value')).toBe('')
  expect(within(region).getByText('近端与远端参考管径尚未取得')).toBeDefined()
  await userEvent.setup().click(screen.getByRole('checkbox', { name: '已核对选型参数、材料、数量、费用、依据及原预留处理' }))
  expect(screen.getByRole('button', { name: '确认选型、清单与预留' }).hasAttribute('disabled')).toBe(true)
  expect(posts).toEqual([])
})

it('其他会话更新选型草稿时保留人工输入，显示最新值并要求核对后再保存', async () => {
  let selection = pciSelection
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [ready], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/pci-selection')) return Response.json(selection)
    if (path.endsWith('/angiography-reports')) return Response.json({ admissionId: admission.id, reports: [angiographyReport] })
    if (path.endsWith('/pci-selection/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input)
      selection = inpatientPciSelectionSchema.parse({ ...selection, drafts: [{ ...selection.drafts![0], version: 3, parameters: input.parameters }] })
      return Response.json({ data: selection, auditId: 'audit-pci-save', requestId: 'request-pci-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount(session, admission, { requests: [pciRequest] }), user = userEvent.setup()
  const length = await screen.findByRole('spinbutton', { name: '病变长度 数值' })
  fireEvent.change(length, { target: { value: '13' } })
  selection = inpatientPciSelectionSchema.parse({ ...selection, drafts: [{ ...pciDraft, version: 2, edited: true,
    parameters: { ...pciDraft.parameters, targetSite: 'RCA 近段', plannedQuantities: [{ category: 'stent', quantity: 2, basis: '另一会话待核对的数量更正' }],
      measurements: pciDraft.parameters.measurements.map(item => item.kind === 'lesion-length' ? { ...item, value: 14,
      source: { reference: 'InpatientPciSelectionDraft/surgery-1', version: '2', note: '医生人工修订', synthetic: true } } : item) } }] })
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await screen.findByText('绑定造影报告：report-1 v1 · 选型草稿 v2')
  expect(length.getAttribute('value')).toBe('13')
  expect(screen.getByRole('button', { name: '保存选型草稿' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/最新已保存：14 mm/)).toBeDefined()
  expect(screen.getByText('最新已保存：RCA 近段')).toBeDefined()
  expect(screen.getByText('最新已保存：2 · 另一会话待核对的数量更正')).toBeDefined()
  expect(posts).toEqual([])
  await user.click(screen.getByRole('button', { name: '保留输入并核对最新选型草稿' }))
  await user.click(screen.getByRole('button', { name: '保存选型草稿' }))
  await screen.findByText('绑定造影报告：report-1 v1 · 选型草稿 v3')
  expect(length.getAttribute('value')).toBe('13')
  expect(posts).toEqual([expect.objectContaining({ requestId: 'surgery-1', expectedDraftVersion: 2 })])
})

it('单次预计直接展示当前已核验的 AI 费用说明及金额依据', async () => {
  const explanation = '预计住院总费用为3450.00元；医院尚未启用医保分组，支付参考暂不可估。'
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, costs, analysis: { ...ready.analysis!, costExplanation: explanation } }))
  mount()
  const section = await screen.findByRole('region', { name: '当前AI费用说明' })
  expect(section.textContent).toContain(explanation)
  expect(screen.queryByText('历史AI费用说明（不用于当前费用）', { exact: true })).toBeNull()
  await userEvent.setup().click(within(section).getByText('费用说明依据', { exact: true }))
  expect(section.textContent).toContain('确定性费用块')
  expect(screen.getByRole('region', { name: '住院费用与医保参考' }).textContent).toContain('¥3,450.00')
})

it('当前费用更新后旧 AI 金额仅保留为折叠历史，不作为当前说明', async () => {
  const explanation = '原预计住院总费用为3450.00元。'
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, status: 'stale', basisFingerprint: 'b'.repeat(64), candidateItems: [material],
    costs: { ...costs, fingerprint: 'e'.repeat(64), components: { ...costs.components, formalChargesFen: 300000, projectedTotalFen: 445000 } },
    analysis: { ...ready.analysis!, costExplanation: explanation } }))
  mount()
  const summary = await screen.findByText('历史AI费用说明（不用于当前费用）', { exact: true })
  expect(summary.closest('details')?.open).toBe(false)
  expect(screen.queryByRole('region', { name: '当前AI费用说明' })).toBeNull()
  expect(screen.getByRole('region', { name: '住院费用与医保参考' }).textContent).toContain('¥4,450.00')
  await userEvent.setup().click(summary)
  expect(summary.closest('details')?.open).toBe(true)
  expect(screen.getByRole('region', { name: '历史AI费用说明' }).textContent).toContain(explanation)
})

it.each(['仅状态失败', '仅依据指纹改变'] as const)('%s时费用文字不能冒充当前说明，规则金额仍可见', async kind => {
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, costs, status: kind === '仅状态失败' ? 'failed' : 'succeeded',
    basisFingerprint: kind === '仅依据指纹改变' ? 'b'.repeat(64) : ready.basisFingerprint,
    analysis: { ...ready.analysis!, costExplanation: '原预计住院总费用为3450.00元。' } }))
  mount()
  await screen.findByText('历史AI费用说明（不用于当前费用）', { exact: true })
  expect(screen.queryByRole('region', { name: '当前AI费用说明' })).toBeNull()
  expect(screen.getByRole('region', { name: '住院费用与医保参考' }).textContent).toContain('¥3,450.00')
})

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
  expect(within(region).getByText(/耗材清单与有效预留分别保存/)).toBeDefined()
})

it('确认区展示留存的原术前清单，不随已消耗或释放的预留消失', async () => {
  reads(inpatientMaterialEstimateSchema.parse({ ...ready, planBasis: { requestId: 'surgery-1', status: 'confirmed',
    effectiveReference: 'MaterialPlan/confirmed-1', history: [{ reference: 'MaterialPlan/confirmed-1', requestId: 'surgery-1',
      source: 'material-estimate', sourceId: ready.id, sourceVersion: 1, basisFingerprint: ready.basisFingerprint,
      sources: { evidencePackageId: 'synthetic-pci-evidence', evidencePackageVersion: '2026.r1', materialEvidence: [evidence] },
      confirmedBy: 'actor-doctor', confirmedAt: '2026-08-24T09:00:00+08:00', supersedes: null,
      items: [{ ...material, specification: evidence.specification }], reservationIds: ['reservation-consumed'] }] } }))
  mount()
  const basis = await screen.findByRole('region', { name: '手术术前确认依据 surgery-1' })
  expect(within(basis).getByText('当前有效依据：单次耗材清单确认 v1')).toBeDefined()
  expect(within(basis).getByText(/原确认数量：1枚/)).toBeDefined()
  expect(screen.getByText('本次确认同时留存术前清单，术后按原确认数量核查；无需再确认另一份计划，也不会自动开启持续跟进。')).toBeDefined()
})

it('手术开始后禁用整批确认，原术前依据不能被工作稿编辑覆盖', async () => {
  reads()
  mount(session, admission, { inProgressRequestIds: ['surgery-1'] })
  const panel = await screen.findByRole('region', { name: '手术耗材预计' })
  await within(panel).findByText('AI 预计与独立核验已完成')
  expect(within(panel).getByRole('button', { name: '确认整批预留' }).closest('fieldset')?.disabled).toBe(true)
  expect(within(panel).getByRole('button', { name: '重新预计，保留耗材清单' }).hasAttribute('disabled')).toBe(true)
  expect(within(panel).getByText('仅能在手术开始前确认；当前术前确认依据只读，工作稿编辑不会改写原确认清单。')).toBeDefined()
})

it.each(['首次生成', '其他会话保存', '重新预计完成', '其他会话采用新预计'] as const)('%s后保留未保存输入，医生核对后可继续保存', async kind => {
  let current = kind === '首次生成'
    ? inpatientMaterialEstimateSchema.parse({ ...ready, status: 'running', analysis: null, draft: null }) : ready
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body))
      posts.push(input)
      if (input.expectedDraftRevision !== current.draft?.revision) {
        return Response.json({ error: { code: 'INPATIENT_ESTIMATE_CONFLICT', message: '工作稿已变化，请审阅最新差异' } }, { status: 409 })
      }
      if (input.analysisId !== null && input.analysisId !== current.analysis?.id) {
        return Response.json({ error: { code: 'INPATIENT_DRG_AGENT_STALE', message: '不能采用旧生成结果' } }, { status: 409 })
      }
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, revision: input.expectedDraftRevision + 1,
        items: input.items, note: input.note, analysisId: input.analysisId, edited: true } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount()
  const note = await screen.findByRole('textbox', { name: "耗材清单说明" })
  fireEvent.change(note, { target: { value: '需要保留的人工编辑' } })
  current = kind === '首次生成' ? ready : kind === '其他会话保存'
    ? inpatientMaterialEstimateSchema.parse({ ...ready, draft: { ...ready.draft!, revision: 2, note: '另一会话已保存的说明' } })
    : inpatientMaterialEstimateSchema.parse({ ...ready, version: 2, analysis: { ...ready.analysis!, id: 'analysis-2', revision: 2 },
      draft: kind === '其他会话采用新预计' ? { ...ready.draft!, revision: 2, analysisId: 'analysis-2' } : ready.draft })
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  const review = await screen.findByRole('button', { name: "保留当前编辑并核对最新耗材清单" })
  expect(note.getAttribute('value')).toBe('需要保留的人工编辑')
  expect(screen.getByRole('button', { name: "保存耗材清单" }).hasAttribute('disabled')).toBe(true)
  expect(posts).toEqual([])
  await userEvent.setup().click(review)
  await screen.findByText(kind.startsWith('其他会话') ? /服务端耗材清单：v3/ : /服务端耗材清单：v2/, {}, { timeout: 3000 })
  expect(current.draft?.note).toBe('需要保留的人工编辑')
  expect(note.getAttribute('value')).toBe('需要保留的人工编辑')
  expect(posts).toHaveLength(1)
  if (kind === '重新预计完成' || kind === '其他会话采用新预计') expect(posts[0]).toMatchObject({ analysisId: null })
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
  await user.type(screen.getByRole('textbox', { name: "耗材清单说明" }), '待核对后统一确认')
  await screen.findByText(/服务端耗材清单：v2/, {}, { timeout: 3_000 })
  first.unmount(); mount()
  expect((await screen.findByRole('textbox', { name: '预计理由：合成支架' })).getAttribute('value')).toBe('医生保留的个体用途')
  expect(screen.getByRole('textbox', { name: "耗材清单说明" }).getAttribute('value')).toBe('待核对后统一确认')
  expect(posts).toEqual([{ path: '/api/his/v1/inpatient/admissions/admission-1/material-estimates/save', input: {
    requestId: 'surgery-1', expectedVersion: 1, expectedDraftRevision: 1, expectedBasisFingerprint: 'a'.repeat(64), analysisId: 'analysis-1',
    items: [{ materialId: material.materialId, catalogVersion: 1, quantity: 1, reason: '医生保留的个体用途' }], note: '待核对后统一确认',
  } }])
})

it('保存期间继续输入时同步回执的新修订、依据和分析关联，保留新输入后可再次保存', async () => {
  let current = ready, release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  const posts: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input)
      if (posts.length === 1) { started(); await held }
      current = inpatientMaterialEstimateSchema.parse({ ...current, basisFingerprint: 'b'.repeat(64),
        draft: { ...current.draft!, revision: input.expectedDraftRevision + 1, basisFingerprint: 'b'.repeat(64), analysisId: null,
          items: input.items, note: input.note, edited: true } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const note = await screen.findByRole('textbox', { name: '耗材清单说明' })
  fireEvent.change(note, { target: { value: '首轮说明' } })
  await userEvent.setup().click(screen.getByRole('button', { name: '保存耗材清单' }))
  await began
  fireEvent.change(note, { target: { value: '保存期间继续输入的说明' } })
  await act(async () => { release() })
  await screen.findByText(/服务端耗材清单：v3/, {}, { timeout: 3_000 })
  expect(note.getAttribute('value')).toBe('保存期间继续输入的说明')
  expect(posts).toHaveLength(2)
  expect(posts[1]).toMatchObject({ expectedDraftRevision: 2, expectedBasisFingerprint: 'b'.repeat(64), analysisId: null,
    note: '保存期间继续输入的说明' })
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
  await user.click(screen.getByRole('button', { name: "采用新候选到耗材清单" }))
  expect(screen.getByRole('textbox', { name: '预计理由：合成支架' }).getAttribute('value')).toBe('新模型候选用途')
})

it('保存回执晚于外部依据更新时保留本地输入，不把外部变化当成本次保存', async () => {
  let current = ready, release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input); started(); await held
      return Response.json({ data: { ...ready, draft: { ...ready.draft!, revision: 2, note: input.note } },
        auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const { client } = mount()
  const note = await screen.findByRole('textbox', { name: '耗材清单说明' })
  fireEvent.change(note, { target: { value: '不能被晚到回执清除的说明' } })
  await userEvent.setup().click(screen.getByRole('button', { name: '保存耗材清单' }))
  await began
  current = inpatientMaterialEstimateSchema.parse({ ...ready, version: 2, basisFingerprint: 'b'.repeat(64),
    draft: { ...ready.draft!, revision: 3, note: '另一会话的新稿' } })
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await act(async () => { release() })
  await screen.findByText(/最新已保存说明：另一会话的新稿/)
  expect(note.getAttribute('value')).toBe('不能被晚到回执清除的说明')
  expect(screen.getByRole('button', { name: '保存耗材清单' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }).getAttribute('aria-checked')).toBe('false')
  expect(posts).toHaveLength(1)
})

it.each([false, true])('修改后一次确认先保存，再原子确认完整本计划预留，其他计划不进入替代范围（回执推进依据：%s）', async normalized => {
  let current = ready
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { started = resolve })
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
      const basisFingerprint = normalized ? 'b'.repeat(64) : current.basisFingerprint
      current = inpatientMaterialEstimateSchema.parse({ ...current, basisFingerprint, draft: { ...current.draft!, revision: 2, items: input.items, note: input.note, edited: true,
        basisFingerprint, analysisId: normalized ? null : current.draft!.analysisId } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    if (path.endsWith('/material-estimates/confirm')) {
      const { input } = JSON.parse(String(init?.body)); posts.push({ path, input })
      started(); await held
      current = inpatientMaterialEstimateSchema.parse({ ...current, draft: { ...current.draft!, confirmedRevision: 2, reservationIds: ['reservation-new'] } })
      return Response.json({ data: current, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.type(await screen.findByRole('textbox', { name: "耗材清单说明" }), '医生统一审阅本计划')
  expect(screen.getByRole('region', { name: '本计划有效预留' }).textContent).toContain('reservation-old v3')
  expect(screen.getByRole('region', { name: '本计划有效预留' }).textContent).not.toContain('reservation-other')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await began
  await screen.findByText(/服务端耗材清单：v2/)
  try { expect(screen.getByRole('button', { name: '正在确认清单与预留' }).hasAttribute('disabled')).toBe(true) }
  finally { await act(async () => { release() }) }
  await screen.findByRole('button', { name: "本版耗材清单已确认" })
  expect(posts.map(post => post.path.split('/').at(-1))).toEqual(['save', 'confirm'])
  expect(posts[1]?.input).toEqual({ requestId: 'surgery-1', expectedVersion: 1, expectedDraftRevision: 2,
    expectedBasisFingerprint: (normalized ? 'b' : 'a').repeat(64), expectedRequestVersion: 1, encounterVersion: '2',
    expectedReservationFingerprint: 'c'.repeat(64), reason: '医生统一审阅本计划' })
})

it('确认前保存发现费用变化时撤销旧审阅，先显示新费用再由医生确认', async () => {
  let current = inpatientMaterialEstimateSchema.parse({ ...ready, costs })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push('save')
      current = inpatientMaterialEstimateSchema.parse({ ...current, costs: { ...costs, fingerprint: 'e'.repeat(64),
        components: { ...costs.components, formalChargesFen: 300000, projectedTotalFen: 445000 } }, draft: { ...ready.draft!, revision: 2, note: input.note } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    if (path.endsWith('/material-estimates/confirm')) {
      posts.push('confirm')
      return Response.json({ data: current, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  fireEvent.change(await screen.findByRole('textbox', { name: '耗材清单说明' }), { target: { value: '审阅原费用后的说明' } })
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await screen.findByText(/服务端耗材清单：v2/)
  expect(screen.getByRole('region', { name: '住院费用与医保参考' }).textContent).toContain('¥4,450.00')
  expect(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }).getAttribute('aria-checked')).toBe('false')
  expect(posts).toEqual(['save'])
  expect(screen.getByText('参数、报告、清单、费用或原预留已更新，请重新审阅后确认。')).toBeDefined()
})

it('原预留集合更新后取消旧审阅，医生重新核对才能确认', async () => {
  let reservations = emptyReservations
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [ready], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(reservations)
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount(), user = userEvent.setup()
  const review = await screen.findByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' })
  await user.click(review)
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(false)
  reservations = inpatientMaterialReservationListSchema.parse({ ...emptyReservations,
    reservationSets: [{ requestId: 'surgery-1', fingerprint: 'd'.repeat(64) }],
    reservations: [{ id: 'reservation-concurrent', admissionId: admission.id, requestId: 'surgery-1', materialId: material.materialId,
      materialDisplay: material.display, quantity: 1, version: 1, priceFen: 100000, status: 'reserved', reason: '另一会话新增', createdAt: '2026-08-24T09:00:00+08:00' }],
  })
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await screen.findByText(/reservation-concurrent v1/)
  expect(review.getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(true)
  await user.click(review)
  expect(screen.getByRole('button', { name: '确认整批预留' }).hasAttribute('disabled')).toBe(false)
})

it('数量超出依据仍可保存工作稿，不能确认未经核对的具体项', async () => {
  reads()
  mount()
  const user = userEvent.setup()
  const quantity = await screen.findByRole('spinbutton', { name: '预计数量：合成支架' })
  await user.clear(quantity); await user.type(quantity, '2')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  expect(screen.getByRole('button', { name: "保存耗材清单" }).hasAttribute('disabled')).toBe(false)
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
  if (status === 'unknown') {
    expect(screen.getByRole('button', { name: "重新预计，保留耗材清单" }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('MODEL_OUTCOME_UNKNOWN')).toBeNull()
  }
})

it('护士只读查看工作稿和有效预留，不显示任何预计写操作', async () => {
  reads()
  mount({ ...session, actor: { ...session.actor, roleCode: 'ward-nurse', practitionerRoleId: 'role-nurse' } })
  await screen.findByText('当前岗位或病案状态只允许查看。')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /确认整批预留|保存耗材清单|重新预计|院内方案/ })).toBeNull()
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
  await screen.findByText(/服务端耗材清单：v3/, {}, { timeout: 4_000 })
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
  await screen.findByText(/耗材清单依据已变化，原编辑仍保留/)
  expect(screen.getByRole('button', { name: "保存耗材清单" }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: "按当前依据核对耗材清单" }))
  await screen.findByText(/服务端耗材清单：v2/, {}, { timeout: 3_000 })
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
  await user.type(await screen.findByRole('textbox', { name: "耗材清单说明" }), '旧病例审阅')
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await began
  view.rerender({ ...admission, id: 'admission-2', patientName: '另一合成患者' })
  await screen.findByText('暂无需要预计的冠脉手术计划。')
  await act(async () => { release() })
  await vi.waitFor(() => expect(sessionStorage.length).toBe(0))
  expect(posts).toEqual(['/api/his/v1/inpatient/admissions/admission-1/material-estimates/save'])
})

it.each([false, true])('确认前保存期间隐藏页签，晚到回执保留输入但不续发确认（再次显示：%s）', async reopen => {
  let current = ready, release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (path.endsWith('/material-estimates/save')) {
      posts.push('save'); const { input } = JSON.parse(String(init?.body)); started(); await held
      current = inpatientMaterialEstimateSchema.parse({ ...ready, draft: { ...ready.draft!, revision: 2, note: input.note } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    if (path.endsWith('/material-estimates/confirm')) {
      posts.push('confirm')
      return Response.json({ data: current, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount(), user = userEvent.setup()
  fireEvent.change(await screen.findByRole('textbox', { name: '耗材清单说明' }), { target: { value: '切页时仍须保留的说明' } })
  await user.click(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await began
  view.rerender(admission, false)
  if (reopen) view.rerender(admission, true)
  await act(async () => { release() })
  await screen.findByText(/服务端耗材清单：v2/)
  if (!reopen) {
    expect(screen.getByText('切页时仍须保留的说明')).toBeDefined()
    view.rerender(admission, true)
  }
  expect(screen.getByRole('textbox', { name: '耗材清单说明' }).getAttribute('value')).toBe('切页时仍须保留的说明')
  expect(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }).getAttribute('aria-checked')).toBe('false')
  expect(posts).toEqual(['save'])
})

it('页签隐藏时保留未保存输入，停止查询与自动保存，重新进入后才继续保存', async () => {
  let current = ready
  const posts: unknown[] = [], gets: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/material-estimates')) { gets.push(path); return Response.json({ admissionId: admission.id, estimates: [current], unprepared: [] }) }
    if (path.endsWith('/drg/reservations')) { gets.push(path); return Response.json(emptyReservations) }
    if (path.endsWith('/material-estimates/save')) {
      const { input } = JSON.parse(String(init?.body)); posts.push(input)
      current = inpatientMaterialEstimateSchema.parse({ ...ready, draft: { ...ready.draft!, revision: 2, note: input.note } })
      return Response.json({ data: current, auditId: 'audit-save', requestId: 'request-save', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount()
  fireEvent.change(await screen.findByRole('textbox', { name: '耗材清单说明' }), { target: { value: '隐藏时的未保存说明' } })
  view.rerender(admission, false)
  const before = gets.length
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['inpatient'] }); await new Promise(resolve => setTimeout(resolve, 900)) })
  expect(gets).toHaveLength(before)
  expect(posts).toEqual([])
  expect(screen.getByText('隐藏时的未保存说明')).toBeDefined()
  view.rerender(admission, true)
  await screen.findByText(/服务端耗材清单：v2/, {}, { timeout: 3_000 })
  expect(screen.getByRole('textbox', { name: '耗材清单说明' }).getAttribute('value')).toBe('隐藏时的未保存说明')
  expect(posts).toHaveLength(1)
})

it('会话校验等待期间隐藏再进入页签，不发送旧确认且保留重新审阅入口', async () => {
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { started = resolve })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') { started(); await held; return Response.json(session) }
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [ready], unprepared: [] })
    if (path.endsWith('/drg/reservations')) return Response.json(emptyReservations)
    if (init?.method === 'POST') {
      posts.push(path)
      return Response.json({ data: ready, auditId: 'audit-confirm', requestId: 'request-confirm', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const view = mount(), user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }))
  await user.click(screen.getByRole('button', { name: '确认整批预留' }))
  await began
  view.rerender(admission, false)
  view.rerender(admission, true)
  await act(async () => { release() })
  await screen.findByText('岗位或业务数据已变化，原操作未重发。请核对原登记和费用记录。')
  expect(posts).toEqual([])
  expect(sessionStorage.length).toBe(0)
  expect(screen.getByRole('checkbox', { name: '已核对材料、数量、依据及以上原预留处理' }).getAttribute('aria-checked')).toBe('false')
})
