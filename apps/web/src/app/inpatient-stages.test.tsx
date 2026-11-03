// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientWorkspace } from './inpatient-workspace.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = { id: 'admission-1', patientId: 'patient-1', patientName: '李淑芬', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', bedId: 'bed-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', admittedAt: '2026-08-24T09:10:00+08:00', depositFen: 100000, chargesFen: 5000, versionId: '2' }
const catalog = { wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient', acceptingAdmissions: true }], beds: [{ id: 'bed-1', name: '1床', roomId: 'room-1', wardId: 'ward-general', dailyPriceFen: 5000, admissionId: admission.id }] }
const scenarioState = { clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' }
function mount(activeSession: SessionContext = session) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><InpatientWorkspace session={activeSession} locale="zh-CN" /></QueryClientProvider>)
}
beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('患者横幅常驻，阶段只显示当前业务表单，切换后保留原输入且未访问病案不发请求', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    paths.push(path)
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [admission] })
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 5000 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female', birthDate: '1980-01-01' })
    if (path.endsWith('/discharge')) return Response.json({ admissionId: admission.id, events: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const banner = screen.getByRole('region', { name: '当前住院患者' })
  expect(banner.textContent).toContain('ZY-0001')
  expect(banner.textContent).toContain('住院病区')
  expect(banner.textContent).toContain('1床')
  expect(banner.textContent).toContain('50.00')
  await waitFor(() => expect(banner.textContent).toContain('住院第 1 天'))
  expect(within(screen.getByRole('list', { name: '办理流程' })).getByRole('listitem', { current: 'step' }).textContent).toBe('在院诊疗')
  expect(screen.getByRole('tab', { name: '诊断医嘱', selected: true })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '更多' }))
  expect(await screen.findByRole('tab', { name: '检查检验' })).toBeDefined()
  await screen.findByLabelText('医嘱项目')
  expect(within(screen.getByRole('group', { name: '医嘱时效' })).getByRole('button', { name: '长期' })).toBeDefined()
  expect(screen.queryByRole('textbox', { name: '出院处理说明' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '计划术式' })).toBeNull()
  expect(paths.some(path => path.endsWith('/record'))).toBe(false)
  await user.type(screen.getByLabelText('停嘱或按需执行理由'), '保留原停嘱说明')
  await user.click(screen.getByRole('tab', { name: "出院" }))
  expect(within(banner).getByText('李淑芬', { exact: true })).toBeDefined()
  expect(screen.queryByRole('combobox', { name: '医嘱项目' })).toBeNull()
  expect(screen.getByText('住院医生开出院医嘱')).toBeDefined()
  expect(screen.getByText('病区护士办理出院')).toBeDefined()
  expect(screen.getByText('收费员结算')).toBeDefined()
  await user.type(screen.getByLabelText('出院处理说明'), '治疗完成，等待原住院确认')
  await user.click(screen.getByRole('tab', { name: '诊断医嘱' }))
  expect((screen.getByLabelText('停嘱或按需执行理由') as HTMLInputElement).value).toBe('保留原停嘱说明')
  await user.click(screen.getByRole('tab', { name: "出院" }))
  expect((screen.getByLabelText('出院处理说明') as HTMLInputElement).value).toBe('治疗完成，等待原住院确认')
  expect(screen.queryByRole('tab', { name: '转科交接' })).toBeNull()
})

it('流程线随住院状态进入办理出院，同时保留可读业务分区', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'discharge-pending' }] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 5000 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: scenarioState.virtualTime, requests: [], executions: [] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/discharge')) return Response.json({ admissionId: admission.id, events: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const flow = screen.getByRole('list', { name: '办理流程' })
  expect(within(flow).getByRole('listitem', { current: 'step' }).textContent).toBe('办理出院')
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('待出院')
  const more = screen.queryByRole('button', { name: '更多' })
  if (more) await userEvent.setup().click(more)
  expect(screen.getByRole('tab', { name: '诊断医嘱' })).toBeDefined()
  expect(await screen.findByRole('tab', { name: '检查检验' })).toBeDefined()
  expect(screen.getByRole('tab', { name: '手术' })).toBeDefined()
  expect(screen.getByRole('tab', { name: '出院' })).toBeDefined()
  expect(screen.getByRole('tab', { name: '病案' })).toBeDefined()
})

it('药师选中患者后保留窄住院上下文，显示发药后交接给护士的办理位置', async () => {
  const pharmacyAdmission = { admissionId: admission.id, patientId: admission.patientId, patientName: admission.patientName, inpatientNumber: admission.inpatientNumber, wardId: admission.wardId, status: 'admitted' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: [pharmacyAdmission] })
    if (path.endsWith('/pharmacy')) return Response.json({ admission: pharmacyAdmission,
      orders: [{ id: 'order-1', admissionId: admission.id, kind: 'medication', duration: 'long', catalogItemId: 'med-1', catalogVersion: 1, display: '合成氨氯地平', doseText: '5 mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 1, requestVersion: '1', signedAt: scenarioState.virtualTime, signedBy: 'synthetic-doctor', organizationId: 'org-1', verifiedAt: scenarioState.virtualTime }],
      executions: [{ id: 'execution-1', orderId: 'order-1', scheduledFor: scenarioState.virtualTime, status: 'pending', version: 1 }], dispenses: [],
      medications: [{ id: 'med-1', display: '合成氨氯地平', unit: '片', lots: [{ id: 'lot-internal-1', version: 1, quantityOnHand: 10, expiresOn: '2026-08-30' }] }], medicationAllergies: [] })
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientPharmacy session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} locale="zh-CN" /></QueryClientProvider>)
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬 · 合成氨氯地平' }))
  const banner = await screen.findByRole('region', { name: '当前住院患者' })
  expect(banner.textContent).toContain('ZY-0001')
  expect(banner.textContent).toContain('合成氨氯地平')
  expect(screen.getByRole('combobox', { name: '发药批次' }).textContent).toContain('库存批次 1')
  expect(screen.getByRole('combobox', { name: '发药批次' }).textContent).toContain('10片')
  expect(document.body.textContent).not.toContain('lot-internal-1')
  expect(screen.getByText('药师发药', { selector: 'strong' }).parentElement?.textContent).toContain('护士校对 → 药师发药 → 护士给药')
  expect(screen.queryByRole('button', { name: '给药' })).toBeNull()
})


it('登记员只显示登记入口和流程，不提供其他岗位空壳或读取临床数据', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    paths.push(path)
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'registered', bedId: undefined },
      { ...admission, id: 'admission-0', patientName: '合成昨日患者', status: 'registered', bedId: undefined, registeredAt: '2026-08-23T09:00:00+08:00' }] })
    if (path.endsWith('/inpatient/referrals')) return Response.json({ items: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected registrar read ${path}`)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'registrar' } })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  expect(screen.getByRole('heading', { name: admission.patientName })).toBeDefined()
  // 今日按场景虚拟时间判断：前一天登记的患者不进「今日已登记」。
  const today = screen.getByRole('region', { name: '今日已登记' })
  expect(within(today).getByRole('button', { name: '查看李淑芬' }).textContent).toContain('待入科')
  expect(within(today).queryByRole('button', { name: '查看合成昨日患者' })).toBeNull()
  expect(screen.getByRole('region', { name: '门诊住院证' }).textContent).toContain('门诊医生开具住院证后会出现在这里')
  expect(screen.getByRole('list', { name: '办理流程' }).textContent).toContain('入科分床')
  expect(screen.queryByRole('tab', { name: '诊断医嘱', hidden: true })).toBeNull()
  expect(screen.queryByRole('tab', { name: '手术', hidden: true })).toBeNull()
  expect(screen.queryByRole('button', { name: "开立医嘱" })).toBeNull()
  expect(paths.some(path => path.includes('/clinical') || path.includes('/auth/role'))).toBe(false)
})

it('目录暂不可读时不把已知占床住院错误显示为未分床', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json({ error: { code: 'UNAVAILABLE', message: 'synthetic catalog unavailable' } }, { status: 503 })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [admission] })
    if (path.endsWith('/inpatient/referrals')) return Response.json({ items: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected registrar read ${path}`)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'registrar' } })
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  expect(screen.getByRole('heading', { name: admission.patientName })).toBeDefined()
  expect(within(screen.getByRole('region', { name: '今日已登记' })).getByRole('button', { name: '查看李淑芬' }).textContent).toContain('在院')
  expect(screen.getByRole('alert').textContent).toContain('病区目录读取失败')
  expect(document.body.textContent).not.toContain('未分床')
})

it('PCI 准备行逐项说明未就绪内容，手术助手计数只包含已带入的草稿，读取不派发模型', async () => {
  const requests: string[] = []
  let manualConfirmed = false
  let selectionFailed = false
  let guidePublished = false
  const fingerprint = 'a'.repeat(64)
  const parameters = { requestId: 'pci-plan', treatmentPlan: '合成 PCI 方案', targetSite: '前降支',
    measurements: ['lesion-length', 'proximal-reference-diameter', 'distal-reference-diameter'].map((kind, index) => ({
      kind, object: index === 0 ? 'lesion' : 'reference-lumen', site: '前降支', value: index === 0 ? 12 : 3,
      unit: 'mm', method: '合成造影测量', source: { reference: 'DiagnosticReport/report-1', version: '1', note: '本院正式合成报告', synthetic: true },
    })), plannedQuantities: [], approvedMaterialIds: [] }
  const plannedProcedure = { id: 'pci-procedure', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0',
    code: '36.0700', display: '冠状动脉支架植入', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20',
    sourceUrl: 'https://synthetic.clinmesh.local/procedures', sourceSha256: 'b'.repeat(64), sourceLocator: 'synthetic:procedure' },
    chargeDefinition: { id: 'pci-charge', priceFen: 100000, unit: '次', synthetic: true, trigger: 'execution' } }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [admission] })
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 5000 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: scenarioState.virtualTime,
      requests: [{ id: 'pci-plan', admissionId: admission.id, version: 1, status: 'requested', plannedProcedure, plannedFor: scenarioState.virtualTime,
        requestedAt: scenarioState.virtualTime, requestedBy: session.actor.actorId, organizationId: 'organization-inpatient', reason: '合成支架治疗计划' }], executions: [], inProgress: [] })
    if (path.endsWith('/pci-selection') && selectionFailed) return Response.json({ error: { code: 'SYNTHETIC_RAW_CODE', message: 'SYNTHETIC_RAW_CODE' } }, { status: 503 })
    if (path.endsWith('/pci-selection')) return Response.json({ admissionId: admission.id,
      confirmation: manualConfirmed ? { id: 'manual-selection', version: 1, parameters, confirmedBy: '合成医生',
        practitionerRoleId: session.actor.practitionerRoleId, confirmedAt: scenarioState.virtualTime } : null, history: [], candidates: [],
      evidencePackage: { id: 'synthetic-pci', version: 'r1', synthetic: true, limitation: '有限合成方案' },
      drafts: manualConfirmed ? [] : [{ requestId: 'pci-plan', version: 1, reportId: 'report-1', reportVersion: 1, edited: false, parameters, confirmedSelectionVersion: null }] })
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [{ id: 'estimate-1', admissionId: admission.id,
      requestId: 'pci-plan', version: 1, requestVersion: 1, status: 'queued', basisFingerprint: fingerprint, failureCode: null, missing: [],
      candidates: [], analysis: null, draft: null, candidateItems: [], costs: null }], unprepared: [] })
    if (path.endsWith('/guideline-advice')) return Response.json({ admissionId: admission.id, advice: [{ admissionId: admission.id, requestId: 'pci-plan',
      taskId: 'guide-task', version: 1, fingerprint, status: guidePublished ? 'incomplete' : 'unknown', message: '原指南请求状态。',
      missing: guidePublished ? ['缺少管径测量。'] : [], failureCode: guidePublished ? null : 'SYNTHETIC_RAW_CODE',
      result: guidePublished ? { id: 'guide-result', fingerprint, model: 'synthetic-model', createdAt: scenarioState.virtualTime,
        topic: { id: 'pci-stent', version: 'r1', fingerprint }, guidelines: [{ id: 'guide-source', title: '合成指南', publisher: '合成机构',
          documentType: 'guideline', version: '2021', url: 'https://synthetic.clinmesh.local/guideline', locator: 'PDF 物理第 1 页',
          scope: '合成界面合同', sourceHash: fingerprint, text: '合成条件原句。' }],
        conclusions: ['stent-category', 'imaging-guidance', 'measurement-requirements'].map(kind => ({ kind, applicability: 'conditional',
          text: '资料有缺项，仍可核对有条件的类别说明。', citations: [{ evidenceId: 'guide-source', quote: '合成条件原句。' }] })), limitations: ['具体尺寸仍待测量。'] } : null }] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected PCI summary read ${path}`)
  }))
  mount()
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const prepared = await screen.findByRole('region', { name: '助手已准备' })
  await waitFor(() => expect(prepared.textContent).toContain('选型参数 · 已带入'))
  expect(prepared.textContent).toContain('耗材清单 · 正在准备')
  expect(prepared.textContent).toContain('费用说明 · 正在准备')
  expect(prepared.textContent).toContain('指南参考意见 · 结果未知')
  const more = screen.queryByRole('button', { name: '更多' })
  if (more) await userEvent.setup().click(more)
  const surgery = screen.getByRole('tab', { name: /手术/ })
  expect(surgery.textContent).toContain('助手 1')
  expect(document.body.textContent).not.toContain('SYNTHETIC_RAW_CODE')
  expect(requests.every(request => request.startsWith('GET '))).toBe(true)
  manualConfirmed = true
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(prepared.textContent).toContain('选型参数 · 医生已确认'))
  expect(prepared.textContent).not.toContain('尚无造影报告')
  expect(surgery.textContent).not.toContain('助手 1')
  selectionFailed = true
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(prepared.textContent).toContain('选型参数 · 读取失败，请重试'))
  expect(prepared.textContent).not.toContain('医生已确认')
  expect(document.body.textContent).not.toContain('SYNTHETIC_RAW_CODE')
  expect(requests.every(request => request.startsWith('GET '))).toBe(true)
  guidePublished = true
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(prepared.textContent).toContain('指南参考意见 · 已准备，资料仍需补充'))
  expect(surgery.textContent).toContain('助手 1')
})

it('收费头部按应退金额显示，无需补交跳过收款且不把未发生的收款步骤打勾', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'departed', outstandingFen: 0 }] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female', birthDate: '1980-01-01' })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/payments')) return Response.json({ admissionId: admission.id, payments: [], refunds: [], sources: [], depositFen: 100000, supplementFen: 0, pendingCount: 0, refundedFen: 0, remainingFen: -95000 })
    if (path.includes('/insurance')) return Response.json({ error: { code: 'UNAVAILABLE', message: 'synthetic insurance unavailable' } }, { status: 503 })
    throw new Error(`Unexpected cashier read ${path}`)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'cashier' } })
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const banner = await screen.findByRole('region', { name: '当前住院患者' })
  await waitFor(() => expect(banner.textContent).toContain('应退'))
  expect(banner.textContent).toContain('950.00')
  expect(banner.textContent).not.toContain('需补交')
  expect(screen.queryByLabelText('现金金额（元）')).toBeNull()
  const progress = screen.getByRole('list', { name: '出院结算进度' })
  const skipped = within(progress).getAllByRole('listitem').slice(0, 3)
  expect(skipped.every(item => item.textContent?.includes('无需补交'))).toBe(true)
  expect(skipped.some(item => item.getAttribute('data-status') === 'completed')).toBe(false)
  expect(screen.getByRole('button', { name: '预览结算' })).toBeDefined()
})

it('收费资金读取失败可原位重试，未知结果不显示确定的补退款金额', async () => {
  let unavailable = true
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, outstandingFen: null }] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/charges')) return Response.json({ admissionId: admission.id, financialStatus: 'open', charges: [], chargesFen: 5000 })
    if (path.endsWith('/payments')) return unavailable ? Response.json({ error: { code: 'UNAVAILABLE', message: 'synthetic funding unavailable' } }, { status: 503 }) : Response.json({ admissionId: admission.id, payments: [], refunds: [], sources: [], depositFen: 100000, supplementFen: 0, pendingCount: 1, refundedFen: 0, remainingFen: -95000 })
    throw new Error(`Unexpected cashier read ${path}`)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'cashier' } })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const banner = await screen.findByRole('region', { name: '当前住院患者' })
  await within(banner).findByText('资金读取失败')
  unavailable = false
  await user.click(within(banner).getByRole('button', { name: '重试资金' }))
  await waitFor(() => expect(banner.textContent).toContain('等收费员查明原支付结果'))
  expect(banner.textContent).not.toContain('应退')
  expect(banner.textContent).not.toContain('需补交')
})
