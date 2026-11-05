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
async function selectStage(user: ReturnType<typeof userEvent.setup>, name: string) {
  const tab = screen.queryByRole('tab', { name })
  if (tab) { await user.click(tab); return }
  await user.click(screen.getByRole('button', { name: '更多' }))
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: new RegExp(`^${name}`) }))
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
    if (path.includes('/reference-catalogs/diagnoses?')) return Response.json({ page: 1, pageSize: 20, total: 0, releaseId: 'synthetic-release', items: [] })
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
  expect(screen.getByRole('tab', { name: '检查检验', hidden: true })).toBeDefined()
  await screen.findByLabelText('医嘱项目')
  expect(within(screen.getByRole('group', { name: '医嘱时效' })).getByRole('button', { name: '长期' })).toBeDefined()
  expect(screen.queryByRole('textbox', { name: '出院处理说明' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '计划术式' })).toBeNull()
  expect(paths.some(path => path.endsWith('/record'))).toBe(false)
  await user.click(screen.getByRole('button', { name: '添加诊断' }))
  await user.type(screen.getByRole('textbox', { name: '搜索诊断名称或编码' }), '保留诊断检索词')
  await user.click(within(screen.getByRole('dialog', { name: '确认住院诊断' })).getByRole('button', { name: '取消' }))
  await selectStage(user, '出院')
  expect(within(banner).getByText('李淑芬', { exact: true })).toBeDefined()
  expect(screen.queryByRole('textbox', { name: '医嘱项目' })).toBeNull()
  expect(screen.getByText('住院医生开出院医嘱')).toBeDefined()
  expect(screen.getByText('病区护士办理出院')).toBeDefined()
  expect(screen.getByText('收费员结算')).toBeDefined()
  await user.type(screen.getByLabelText('出院处理说明'), '治疗完成，等待原住院确认')
  await selectStage(user, '诊断医嘱')
  await user.click(screen.getByRole('button', { name: '添加诊断' }))
  expect((screen.getByRole('textbox', { name: '搜索诊断名称或编码' }) as HTMLInputElement).value).toBe('保留诊断检索词')
  await user.click(within(screen.getByRole('dialog', { name: '确认住院诊断' })).getByRole('button', { name: '取消' }))
  await selectStage(user, '出院')
  expect((screen.getByLabelText('出院处理说明') as HTMLInputElement).value).toBe('治疗完成，等待原住院确认')
  expect(screen.queryByRole('tab', { name: '转科交接' })).toBeNull()
})

it('开立被业务规则拒绝时只在开立区显示服务端原因，不再出现目录已变化的全局提示', async () => {
  const medication = { id: 'medication-1', display: '合成降压药', version: 1, priceFen: 1500, unit: '片', doses: [{ doseText: '1片', quantity: 1 }], frequencyCodes: ['QD'], lots: [] }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (init?.method === 'POST' && path.endsWith('/orders/issue')) return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '本次住院确诊不符合药品适应症' } }, { status: 409 })
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [admission] })
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [medication], services: [] })
    if (path.includes('/inpatient/catalog-search?')) return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 1, items: [{ id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication }] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 1, entries: [{ conditionId: 'condition-1', role: 'primary', admissionCondition: '1', ordinal: 1,
      coding: { id: 'diagnosis-1', code: 'J18.9', display: '合成肺炎', system: 'https://example.test/icd', version: '1', sourceLocator: 'synthetic-fixture' } }] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 5000 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: scenarioState.virtualTime, requests: [], executions: [] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    if (path.endsWith('/discharge')) return Response.json({ admissionId: admission.id, events: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  await selectStage(user, '诊断医嘱')
  await user.click(await screen.findByRole('button', { name: '查询' }))
  await user.click(await within(await screen.findByRole('region', { name: '医嘱项目候选' })).findByRole('button', { name: /合成降压药/ }))
  await user.click(screen.getByRole('button', { name: '开立医嘱' }))
  const issue = screen.getByRole('region', { name: '开立医嘱' })
  expect((await within(issue).findByRole('alert')).textContent).toContain('不能开立 合成降压药：本次住院确诊不符合药品适应症')
  expect(document.body.textContent).not.toContain('目录或业务规则已变化')
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
  expect(screen.getByRole('tab', { name: '诊断医嘱', hidden: true })).toBeDefined()
  expect(await screen.findByRole('tab', { name: '检查检验', hidden: true })).toBeDefined()
  expect(screen.getByRole('tab', { name: '手术', hidden: true })).toBeDefined()
  expect(screen.getByRole('tab', { name: '出院', hidden: true })).toBeDefined()
  expect(screen.getByRole('tab', { name: '病案', hidden: true })).toBeDefined()
})

it('药师选中患者后保留窄住院上下文，显示发药后交接给护士的办理位置', async () => {
  let detailsUnavailable = false
  let medicationAllergies: { id: string; display: string }[] = []
  const pharmacyAdmission = { admissionId: admission.id, patientId: admission.patientId, patientName: admission.patientName, inpatientNumber: admission.inpatientNumber, wardId: admission.wardId, status: 'admitted' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: [pharmacyAdmission] })
    if (path.endsWith('/pharmacy')) return detailsUnavailable ? Response.json({ error: { code: 'UNAVAILABLE', message: '合成药房读取失败' } }, { status: 503 }) : Response.json({ admission: pharmacyAdmission,
      orders: [{ id: 'order-1', admissionId: admission.id, kind: 'medication', duration: 'long', catalogItemId: 'med-1', catalogVersion: 1, display: '合成氨氯地平', doseText: '5 mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 1, requestVersion: '1', signedAt: scenarioState.virtualTime, signedBy: 'synthetic-doctor', organizationId: 'org-1', verifiedAt: scenarioState.virtualTime }],
      executions: [{ id: 'execution-1', orderId: 'order-1', scheduledFor: scenarioState.virtualTime, status: 'pending', version: 1 }], dispenses: [],
      medications: [{ id: 'med-1', display: '合成氨氯地平', unit: '片', lots: [{ id: 'lot-internal-1', version: 1, quantityOnHand: 10, expiresOn: '2026-08-30' }] }], medicationAllergies })
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientPharmacy session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} locale="zh-CN" /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬 · 合成氨氯地平' }))
  const banner = await screen.findByRole('region', { name: '当前住院患者' })
  expect(banner.textContent).toContain('ZY-0001')
  expect(banner.textContent).toContain('合成氨氯地平')
  expect(screen.getByRole('combobox', { name: '发药批次' }).textContent).toContain('库存批次 1')
  expect(screen.getByRole('combobox', { name: '发药批次' }).textContent).toContain('10片')
  expect(document.body.textContent).not.toContain('lot-internal-1')
  expect(screen.getByText('药师发药', { selector: 'strong' }).parentElement?.textContent).toContain('护士校对 → 药师发药 → 护士给药')
  expect(screen.queryByRole('button', { name: '给药' })).toBeNull()
  const allergies = await screen.findByRole('region', { name: '药物过敏提示' })
  expect(allergies.textContent).toContain('未记录有效药物过敏')
  detailsUnavailable = true
  await user.click(screen.getByRole('button', { name: '刷新' }))
  await within(allergies).findByText('药物过敏信息读取失败，请重试。')
  expect(allergies.textContent).not.toContain('未记录有效药物过敏')
  expect(screen.getByRole('button', { name: '发药' }).hasAttribute('disabled')).toBe(true)
  detailsUnavailable = false
  medicationAllergies = [{ id: 'synthetic-allergy', display: '合成青霉素' }]
  await user.click(screen.getByRole('button', { name: '重试读取' }))
  await within(allergies).findByText('药物过敏 · 合成青霉素')
  expect(allergies.textContent).not.toContain('未记录有效药物过敏')
  expect(screen.getByRole('button', { name: '发药' }).hasAttribute('disabled')).toBe(false)
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
  const surgery = screen.getByRole('tab', { name: /手术/, hidden: true })
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
  expect(within(progress).getAllByRole('listitem')).toHaveLength(3)
  expect(within(progress).getAllByRole('listitem')[0]?.textContent).toContain('预览结算')
  expect(progress.textContent).not.toContain('补交')
  expect(screen.getAllByText('无需补交，直接预览结算。')).toHaveLength(1)
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

it.each(['refund', 'deposit'] as const)('未知%s尚未查明时不把未发生的补交和收款步骤标为完成', async pendingKind => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'departed', outstandingFen: null }] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/payments')) return Response.json({ admissionId: admission.id, depositFen: 100000, supplementFen: 0, pendingCount: 1, refundedFen: 0, remainingFen: -95000, sources: [],
      payments: pendingKind === 'deposit' ? [{ paymentId: 'unknown-deposit', admissionId: admission.id, kind: 'deposit', amountFen: 1000, tenders: [{ method: 'cash', amountFen: 1000 }], initialOutcome: 'ambiguous', outcome: 'ambiguous', correlationId: 'synthetic-correlation', createdAt: scenarioState.virtualTime, resolvedAt: null, version: 1 }] : [],
      refunds: pendingKind === 'refund' ? [{ refundId: 'unknown-refund', sourceKind: 'inpatient-deposit', sourceId: 'original-deposit', basisId: 'original-basis', ownerKind: 'inpatient', ownerId: admission.id, amountFen: 1000, initialOutcome: 'ambiguous', outcome: 'ambiguous', correlationId: 'synthetic-correlation', createdAt: scenarioState.virtualTime, resolvedAt: null, version: 1 }] : [],
    })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成非本次读取' } }, { status: 503 })
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'cashier' } })
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  await screen.findByText('原支付结果待查明')
  const steps = within(screen.getByRole('list', { name: '出院结算进度' })).getAllByRole('listitem').slice(0, 3)
  expect(steps.map(step => step.getAttribute('data-status'))).toEqual(['pending', 'pending', 'pending'])
})

it('药房详情读取失败时保留未知状态，重试成功后才显示零待办', async () => {
  let unavailable = true
  const pharmacyAdmission = { admissionId: admission.id, patientId: admission.patientId, patientName: admission.patientName, inpatientNumber: admission.inpatientNumber, wardId: admission.wardId, status: 'admitted' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: [pharmacyAdmission] })
    if (path.endsWith('/pharmacy')) return unavailable ? Response.json({ error: { code: 'UNAVAILABLE', message: '合成药房详情暂不可用' } }, { status: 503 })
      : Response.json({ admission: pharmacyAdmission, orders: [], executions: [], dispenses: [], medications: [], medicationAllergies: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientPharmacy session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} locale="zh-CN" /></QueryClientProvider>)
  await screen.findByRole('alert')
  const state = screen.getByRole('group', { name: '住院发药状态' })
  expect(state.textContent).not.toMatch(/待发药\s*0|已发药\s*0/)
  expect(screen.queryByText('暂无待发药品')).toBeNull()
  unavailable = false
  await userEvent.setup().click(screen.getByRole('button', { name: '重试读取' }))
  await screen.findByText('暂无待发药品')
  expect(state.textContent).toMatch(/待发药\s*0/)
})

it('分次补交已有成功收款但仍有余额时保留当前补交步骤', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'departed', depositFen: 0, chargesFen: 10000, outstandingFen: 5000 }] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/payments')) return Response.json({ admissionId: admission.id, depositFen: 0, supplementFen: 5000, pendingCount: 0, refundedFen: 0, remainingFen: 5000, sources: [], refunds: [],
      payments: [{ paymentId: 'partial-supplement', admissionId: admission.id, kind: 'supplement', amountFen: 5000, tenders: [{ method: 'cash', amountFen: 5000 }], initialOutcome: 'success', outcome: 'success', correlationId: 'synthetic-correlation', createdAt: scenarioState.virtualTime, resolvedAt: scenarioState.virtualTime, version: 1 }],
    })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成非本次读取' } }, { status: 503 })
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'cashier' } })
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  await within(screen.getByRole('region', { name: '当前住院患者' })).findByText('需补交 ¥50.00')
  const progress = screen.getByRole('list', { name: '出院结算进度' })
  expect(within(progress).getByRole('listitem', { current: 'step' }).textContent).toContain('出院补交')
})

it('已结算患者头部读取当前更正账，失败可重试且未知资金不显示确定金额', async () => {
  let state: 'error' | 'unknown' | 'refund' | 'collect' = 'error'
  const financial = () => ({ admissionId: admission.id, status: 'cleared', recordStatus: 'open', firstSettlement: { id: 'first-settlement', fingerprint: 'a'.repeat(64), chargesFen: 5000, depositFen: 5000, balanceFen: 0, settledAt: scenarioState.virtualTime },
    charges: [], adjustments: [], sources: [], refunds: [], payments: [], frozenChargesFen: 5000, currentChargesFen: state === 'collect' ? 6000 : 3000, frozenFundsFen: 5000, currentFundsFen: 5000,
    remainingRefundFen: state === 'collect' ? 0 : 2000, remainingCollectFen: state === 'collect' ? 1000 : 0, reservedFen: state === 'unknown' ? 1000 : 0, reservedCollectFen: 0, fingerprint: 'b'.repeat(64),
  })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'cleared', financialStatus: 'settled', outstandingFen: state === 'unknown' ? null : 0 }] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/financial-adjustments')) return state === 'error' ? Response.json({ error: { code: 'UNAVAILABLE', message: '合成更正账暂不可用' } }, { status: 503 }) : Response.json(financial())
    if (path.endsWith('/payments')) return Response.json({ admissionId: admission.id, payments: [], refunds: [], sources: [], depositFen: 5000, supplementFen: 0, pendingCount: 0, refundedFen: 0, remainingFen: 0 })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成非本次读取' } }, { status: 503 })
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'cashier' } })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const head = screen.getByRole('region', { name: '当前住院患者' })
  await within(head).findByText('资金读取失败')
  state = 'unknown'
  await user.click(within(head).getByRole('button', { name: '重试资金' }))
  await within(head).findByText('等收费员查明原支付结果')
  expect(head.textContent).not.toContain('应退')
  state = 'refund'
  await user.click(screen.getByRole('button', { name: '刷新' }))
  await within(head).findByText('应退 ¥20.00')
  state = 'collect'
  await user.click(screen.getByRole('button', { name: '刷新' }))
  await within(head).findByText('需补交 ¥10.00')
})

it('药房只读取当前患者页的窄详情，用户翻页后才读取下一页且计数限于本页', async () => {
  const detailReads: string[] = []
  const items = Array.from({ length: 25 }, (_, index) => ({ admissionId: `paged-admission-${index + 1}`, patientId: `paged-patient-${index + 1}`, patientName: `合成分页患者${index + 1}`, inpatientNumber: `ZY-${index + 1}`, wardId: 'ward-general', status: 'admitted' }))
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items })
    const item = items.find(item => path.endsWith(`/admissions/${item.admissionId}/pharmacy`))
    if (item) {
      detailReads.push(item.admissionId)
      const suffix = item.admissionId.split('-').at(-1)
      return Response.json({ admission: item,
        orders: [{ id: `paged-order-${suffix}`, admissionId: item.admissionId, kind: 'medication', duration: 'temporary', catalogItemId: `paged-med-${suffix}`, catalogVersion: 1, display: `分页药品${suffix}`, doseText: '5 mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 1, requestVersion: '1', signedAt: scenarioState.virtualTime, signedBy: 'synthetic-doctor', organizationId: 'org-1', verifiedAt: scenarioState.virtualTime }],
        executions: [{ id: `paged-execution-${suffix}`, orderId: `paged-order-${suffix}`, scheduledFor: scenarioState.virtualTime, status: 'pending', version: 1 }], dispenses: [],
        medications: [{ id: `paged-med-${suffix}`, display: `分页药品${suffix}`, unit: '片', lots: [{ id: `paged-lot-${suffix}`, version: 1, quantityOnHand: 10, expiresOn: '2030-12-31' }] }], medicationAllergies: [] })
    }
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientPharmacy session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} locale="zh-CN" /></QueryClientProvider>)
  await screen.findByRole('button', { name: '查看合成分页患者1 · 分页药品1' })
  expect(detailReads).toHaveLength(10)
  expect(detailReads).not.toContain('paged-admission-11')
  expect(screen.getByText('药品计数仅限本页患者')).toBeDefined()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('button', { name: '查看合成分页患者11 · 分页药品11' })
  expect(detailReads).toHaveLength(20)
  expect(detailReads).not.toContain('paged-admission-21')
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('button', { name: '查看合成分页患者25 · 分页药品25' })
  expect(detailReads).toHaveLength(25)
  expect(screen.getByRole('button', { name: '下一页' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('group', { name: '住院发药状态' }).textContent).toContain('待发药 5')
})

it.each(['admitted', 'departed', 'cleared'] as const)('本页发药完成后显式继续，原患者%s时按对应列表恢复原回执', async recoveredStatus => {
  const pharmacist = { ...session, actor: { ...session.actor, roleCode: 'pharmacist' as const } }
  const indexed = Array.from({ length: 11 }, (_, index) => ({ admissionId: `continue-admission-${index + 1}`, patientId: `continue-patient-${index + 1}`, patientName: `连续患者${index + 1}`, inpatientNumber: `ZY-C${index + 1}`, wardId: 'ward-general', status: 'admitted' }))
  let firstDispensed = false
  let secondDispensed = false
  let lostKey: string | null = null
  const recoveredKeys: string[] = []
  let committedResponse = ''
  const reads: string[] = []
  const writes: unknown[] = []
  const details = (item: typeof indexed[number]) => {
    const number = item.admissionId.split('-').at(-1)
    const pending = number === '11' && !secondDispensed || number === '1' && !firstDispensed
    const status = pending ? 'pending' : item.status === 'admitted' && (number === '1' || number === '11') ? 'dispensed' : 'completed'
    return { admission: item,
      orders: [{ id: `continue-order-${number}`, admissionId: item.admissionId, kind: 'medication', duration: 'temporary', catalogItemId: `continue-med-${number}`, catalogVersion: 1, display: `连续药品${number}`, doseText: '5 mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: item.status === 'admitted' && (number === '1' || number === '11') ? 'verified' : 'completed', version: 1, requestVersion: '1', signedAt: scenarioState.virtualTime, signedBy: 'synthetic-doctor', organizationId: 'org-1', verifiedAt: scenarioState.virtualTime }],
      executions: [{ id: `continue-execution-${number}`, orderId: `continue-order-${number}`, scheduledFor: scenarioState.virtualTime, status, version: status === 'pending' ? 1 : 2 }],
      dispenses: pending ? [] : [{ id: `continue-dispense-${number}`, executionId: `continue-execution-${number}`, lotId: `continue-lot-${number}`, quantity: 1, dispensedAt: scenarioState.virtualTime, dispensedBy: 'synthetic-pharmacist' }],
      medications: [{ id: `continue-med-${number}`, display: `连续药品${number}`, unit: '片', lots: [{ id: `continue-lot-${number}`, version: 1, quantityOnHand: 10, expiresOn: '2030-12-31' }] }], medicationAllergies: [] }
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(pharmacist)
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: indexed })
    if (path.includes('/command-receipts?')) {
      const query = new URL(path, 'http://localhost').searchParams
      recoveredKeys.push(query.get('idempotencyKey')!)
      return Response.json({ operationId: 'inpatient.execution.dispense', idempotencyKey: query.get('idempotencyKey'), status: 'completed', response: JSON.parse(committedResponse) })
    }
    if (path.endsWith('/executions/dispense')) {
      writes.push({ path, body: JSON.parse(String(init?.body)) })
      if (path.includes('/continue-admission-11/')) {
        secondDispensed = true
        lostKey = new Headers(init?.headers).get('idempotency-key')
        committedResponse = JSON.stringify({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: details(indexed[10]!) })
        throw new TypeError('synthetic committed response loss')
      }
      firstDispensed = true
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: details(indexed[0]!) })
    }
    const item = indexed.find(item => path.endsWith(`/admissions/${item.admissionId}/pharmacy`))
    if (item) { reads.push(item.admissionId); return Response.json(details(item)) }
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  const mountPharmacy = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><InpatientPharmacy session={pharmacist} locale="zh-CN" /></QueryClientProvider>)
  const first = mountPharmacy()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看连续患者1 · 连续药品1' }))
  await user.click(screen.getByRole('button', { name: '发药' }))
  await user.click(screen.getByRole('button', { name: '确认发药' }))
  await screen.findByText('本页已完成发药')
  expect(reads).not.toContain('continue-admission-11')
  expect(writes).toEqual([{ path: '/api/his/v1/inpatient/admissions/continue-admission-1/executions/dispense', body: { input: { executionId: 'continue-execution-1', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'continue-lot-1', expectedVersion: 1, quantity: 1 }] } } }])
  await user.click(screen.getByRole('button', { name: '继续下一页' }))
  await screen.findByRole('button', { name: '查看连续患者11 · 连续药品11' })
  await waitFor(() => expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('连续患者11'))
  expect(screen.getByRole('button', { name: '发药' }).hasAttribute('disabled')).toBe(false)
  await user.click(screen.getByRole('button', { name: '上一页' }))
  await user.click(await screen.findByRole('button', { name: '已发药 10' }))
  await user.click(await screen.findByRole('button', { name: '查看连续患者1 · 连续药品1' }))
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('已发药')
  expect(screen.queryByRole('button', { name: '确认发药' })).toBeNull()
  await user.click(screen.getByRole('button', { name: /^待发药/ }))
  await user.click(screen.getByRole('button', { name: '继续下一页' }))
  await screen.findByRole('button', { name: '发药' })
  await user.click(screen.getByRole('button', { name: '发药' }))
  await user.click(screen.getByRole('button', { name: '确认发药' }))
  await screen.findByRole('alert')
  indexed[10]!.status = recoveredStatus
  first.unmount()
  mountPharmacy()
  await user.click(await screen.findByRole('button', { name: '恢复原住院操作' }))
  await screen.findByText(recoveredStatus === 'admitted' ? '本页已完成发药' : '已完成本次发药')
  expect(within(screen.getByRole('navigation', { name: '住院发药分页' })).getByText('2 / 2')).toBeDefined()
  if (recoveredStatus === 'admitted') {
    expect(screen.getByRole('button', { name: '待发药 0' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: /^已发药/ }))
    await user.click(screen.getByRole('button', { name: '下一页' }))
  } else expect(screen.getByRole('button', { name: '已发药 1' }).getAttribute('aria-pressed')).toBe('true')
  await user.click(await screen.findByRole('button', { name: '查看连续患者11 · 连续药品11' }))
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('已发药')
  expect(screen.queryByRole('button', { name: '发药' })).toBeNull()
  expect(within(screen.getByRole('navigation', { name: '住院发药分页' })).getByText('2 / 2')).toBeDefined()
  expect(recoveredKeys).toEqual([lostKey])
  expect(writes).toHaveLength(2)
})

it('待发先筛在院患者再分页，已发历史使用独立页码且按用户访问读取', async () => {
  const reads: string[] = []
  const indexed = Array.from({ length: 25 }, (_, index) => ({ admissionId: `status-admission-${index + 1}`, patientId: `status-patient-${index + 1}`, patientName: `状态患者${index + 1}`, inpatientNumber: `ZY-S${index + 1}`, wardId: 'ward-general', status: index === 24 ? 'admitted' : 'cleared' }))
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: indexed })
    const item = indexed.find(item => path.endsWith(`/admissions/${item.admissionId}/pharmacy`))
    if (item) {
      reads.push(item.admissionId)
      const number = item.admissionId.split('-').at(-1), admitted = item.status === 'admitted'
      return Response.json({ admission: item,
        orders: [{ id: `status-order-${number}`, admissionId: item.admissionId, kind: 'medication', duration: 'temporary', catalogItemId: `status-med-${number}`, catalogVersion: 1, display: `状态药品${number}`, doseText: '5 mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: admitted ? 'verified' : 'completed', version: 1, requestVersion: '1', signedAt: scenarioState.virtualTime, signedBy: 'synthetic-doctor', organizationId: 'org-1', verifiedAt: scenarioState.virtualTime }],
        executions: [{ id: `status-execution-${number}`, orderId: `status-order-${number}`, scheduledFor: scenarioState.virtualTime, status: admitted ? 'pending' : 'completed', version: 1 }],
        dispenses: admitted ? [] : [{ id: `status-dispense-${number}`, executionId: `status-execution-${number}`, lotId: `status-lot-${number}`, quantity: 1, dispensedAt: scenarioState.virtualTime, dispensedBy: 'synthetic-pharmacist' }],
        medications: [{ id: `status-med-${number}`, display: `状态药品${number}`, unit: '片', lots: [{ id: `status-lot-${number}`, version: 1, quantityOnHand: 10, expiresOn: '2030-12-31' }] }], medicationAllergies: [] })
    }
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientPharmacy session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} locale="zh-CN" /></QueryClientProvider>)
  await waitFor(() => expect(reads.length).toBeGreaterThan(0))
  expect(reads).toEqual(['status-admission-25'])
  await screen.findByRole('button', { name: '查看状态患者25 · 状态药品25' })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /^已发药/ }))
  await screen.findByRole('button', { name: '查看状态患者1 · 状态药品1' })
  expect(reads).toHaveLength(11)
  expect(reads).not.toContain('status-admission-11')
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('button', { name: '查看状态患者11 · 状态药品11' })
  await user.click(screen.getByRole('button', { name: /^待发药/ }))
  await screen.findByRole('button', { name: '查看状态患者25 · 状态药品25' })
  expect(screen.queryByRole('navigation', { name: '住院发药分页' })).toBeNull()
  expect(screen.queryByRole('button', { name: '下一页' })).toBeNull()
  await user.click(screen.getByRole('button', { name: /^已发药/ }))
  await screen.findByRole('button', { name: '查看状态患者11 · 状态药品11' })
  expect(within(screen.getByRole('navigation', { name: '住院发药分页' })).getByText('2 / 3')).toBeDefined()
})
