// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'

vi.mock('./imaging/imaging-viewer.tsx', () => ({ ImagingViewer: ({ onFrameShown }: { onFrameShown?: () => void }) => <button onClick={onFrameShown}>确认合成帧已显示</button> }))

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general',
  organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const diagnosis = { id: 'diagnosis-1', code: 'I25.1', display: '合成冠心病诊断', system: 'https://example.test/icd', version: '1', sourceLocator: 'synthetic-fixture' }
const hypertension = { id: 'nhsa-diagnosis:nhc-icd10-clinical@2022.r4:I10.x09', code: 'I10.x09', display: '合成高血压', domain: 'diagnosis', sourceLocator: 'synthetic-fixture', status: 'active', system: 'https://example.test/nhc-icd10', version: '2022.r4' }
const medication = { id: 'medication-2', display: '合成降压药', version: 1, priceFen: 1500, unit: '片', doseBasis: { amount: 5, unit: 'mg' }, doses: [{ doseText: '5 mg', quantity: 1 }], frequencyCodes: ['QD'], lots: [] }
const simulation = { admissionId: 'admission-1', evaluatedAt: '2026-08-24T09:00:00+08:00', fingerprint: 'a'.repeat(64), rulesId: 'synthetic-rules', rulesVersion: '1',
  formal: { chargesFen: 5000, items: [] }, committed: { items: [] }, reserved: { items: [] }, draft: { items: [{ kind: 'medication', id: 'medication-2', display: '合成降压药', quantity: 1, estimatedFen: 1500 }], missing: [] },
  coverage: { coveredFen: 5000, estimatedTotalFen: 6500, coveredRatioBp: 7692, note: '合成' }, grouping: { formal: { status: 'grouped', drgCode: 'FR59', mdcCode: 'MDCF', adrgCode: 'FR5', steps: [], reason: null }, projected: null, note: '合成' },
  paymentReference: null, incompleteness: { costMissing: true, paymentReferenceMissing: true } }
const clinical = inpatientFullClinicalSchema.parse({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 1, entries: [{ conditionId: 'condition-1', role: 'primary', admissionCondition: '1', ordinal: 1, coding: diagnosis }] },
  orders: [{ id: 'order-1', admissionId: admission.id, kind: 'medication', duration: 'long', catalogItemId: 'medication-1', catalogVersion: 1, display: '合成抗血小板药', doseText: '1片', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 1, requestVersion: '1', signedAt: '2026-08-24T09:00:00+08:00', signedBy: 'doctor-1', organizationId: 'organization-inpatient' }],
  executions: [{ id: 'execution-1', orderId: 'order-1', scheduledFor: '2026-08-24T09:00:00+08:00', status: 'completed', version: 1 }], dispenses: [], charges: [], chargesFen: 0 })
const investigations = inpatientInvestigationsSchema.parse({ admissionId: admission.id, sent: [], imagingRequests: [], laboratoryRequests: [{ id: 'request-1', catalogItemId: 'laboratory-1', indicationCode: 'screening', serviceRequestId: 'service-request-1', serviceRequestVersion: '1', taskId: 'task-1', taskVersion: '1', status: 'reported', version: 1,
  referenceConcept: { ...diagnosis, id: 'laboratory-1', display: '合成肌钙蛋白' }, report: { diagnosticReportId: 'report-1', diagnosticReportVersion: '1', issuedAt: '2026-08-24T09:40:00+08:00', revisionNumber: 1, specimenId: 'specimen-1', status: 'final', conclusion: '合成报告结论',
    results: [{ code: 'troponin', display: '肌钙蛋白 I', value: 0.02, interpretation: 'normal', observationId: 'observation-1', referenceRange: { high: 0.04, text: '0–0.04' }, unit: { code: 'ng/mL', display: 'ng/mL', system: 'http://unitsofmeasure.org' } }] } }] })

function mount(page: 'orders' | 'investigations', { investigationFacts = investigations, imagingAvailable = false, activeSession = session, clinicalFacts = clinical, rejectIssue = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const writes: Array<{ path: string; body: unknown }> = []
  function Subject() {
    const write = useInpatientWriteIntent(activeSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage={page === 'orders' ? 'orders' : 'investigations'}>{page === 'orders' ? <InpatientClinical admission={admission} session={activeSession} locale="zh-CN" write={write} /> : <InpatientInvestigations admission={admission} session={activeSession} locale="zh-CN" write={write} />}<aside aria-label="底部操作"><InpatientActionOutlet /></aside></InpatientActionProvider>
  }
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(activeSession)
    if (path.endsWith('/drg/simulation')) return Response.json(simulation)
    if (init?.method === 'POST') {
      if (rejectIssue && path.endsWith('/orders/issue')) return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '本次住院确诊不符合药品适应症' } }, { status: 409 })
      writes.push({ path, body: JSON.parse(String(init.body)) })
      if (path.endsWith('/orders/verify')) clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinicalFacts, orders: clinicalFacts.orders.map(order => order.id === 'verify-order' ? { ...order, state: 'verified', version: order.version + 1 } : order) })
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: clinicalFacts })
    }
    if (path.endsWith('/clinical')) return Response.json(clinicalFacts)
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [diagnosis, { ...diagnosis, id: 'diagnosis-local', display: '合成院内诊断' }], medications: [medication], services: [{ id: 'service-1', display: '合成健康教育', version: 1, priceFen: 1000, unit: '次' }] })
    if (path.includes('/inpatient/catalog-search?')) return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 2, items: [
      { id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication },
      { id: 'medication-missing', display: '合成缺价药', status: 'incomplete', missingFields: ['price'] }] })
    if (path.includes('/reference-catalogs/diagnoses?')) return Response.json({ page: 1, pageSize: 20, total: 1, releaseId: 'synthetic-release', items: [hypertension] })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' })
    if (path.endsWith('/investigations')) return Response.json(investigationFacts)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: [] })
    if (path.endsWith('/imaging-studies/study-1')) return Response.json({ available: imagingAvailable, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' })
    throw new Error(`Unexpected read ${path}`)
  }))
  return { ...render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>), writes }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('诊断摘要先于医嘱和开立表单，诊断两栏弹窗只查国家临床版且关闭重开保留草稿', async () => {
  const { writes } = mount('orders')
  const user = userEvent.setup()
  const summary = await screen.findByRole('region', { name: '住院诊断摘要' })
  expect(summary.textContent).toContain('主诊断合成冠心病诊断I25.1入院病情：有')
  const orders = screen.getByRole('region', { name: '住院医嘱' }), issue = screen.getByRole('region', { name: '开立医嘱' })
  expect(summary.compareDocumentPosition(orders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(orders.compareDocumentPosition(issue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText(/执行记录/).closest('details')?.hasAttribute('open')).toBe(false)
  await user.click(within(summary).getByRole('button', { name: '修改诊断' }))
  let dialog = screen.getByRole('dialog', { name: '修改住院诊断' })
  expect(within(dialog).getByText('国家临床版 2022')).toBeDefined()
  expect(within(dialog).getByText(/只查国家临床版 2022/)).toBeDefined()
  expect(within(dialog).queryByText('合成院内诊断')).toBeNull()
  await user.type(within(dialog).getByRole('textbox', { name: '搜索诊断名称或编码' }), '高血压')
  await user.click(await within(dialog).findByRole('button', { name: '加入合成高血压' }))
  const chosen = within(dialog).getByRole('region', { name: '本次住院诊断' })
  expect(chosen.textContent).toContain('2 条 · 第一条加入的自动为主诊断')
  expect(within(dialog).getByRole('button', { name: '已加入合成高血压' }).hasAttribute('disabled')).toBe(true)
  expect(within(dialog).getByRole('status').textContent).toBe('还差：1 条诊断的入院病情')
  expect(within(dialog).getByRole('button', { name: '确认住院诊断' }).hasAttribute('disabled')).toBe(true)
  expect(within(chosen).queryByRole('textbox', { name: '合成高血压 备注' })).toBeNull()
  await user.click(within(within(chosen).getByRole('group', { name: '合成高血压 入院病情' })).getByRole('button', { name: '临床未确定' }))
  await user.click(within(chosen).getByRole('button', { name: '加备注：合成高血压' }))
  await user.type(within(chosen).getByRole('textbox', { name: '合成高血压 备注' }), '合成待复查')
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await user.click(within(summary).getByRole('button', { name: '修改诊断' }))
  dialog = screen.getByRole('dialog', { name: '修改住院诊断' })
  expect((within(dialog).getByRole('textbox', { name: '搜索诊断名称或编码' }) as HTMLInputElement).value).toBe('高血压')
  expect((within(dialog).getByRole('textbox', { name: '合成高血压 备注' }) as HTMLInputElement).value).toBe('合成待复查')
  await user.click(within(dialog).getByRole('button', { name: '设为主诊断：合成高血压' }))
  expect(within(dialog).getByRole('status').textContent).toBe('主诊断：合成高血压')
  await user.click(within(dialog).getByRole('button', { name: '确认住院诊断' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ path: expect.stringContaining('/diagnoses/confirm'), body: { input: { expectedRevision: 1, entries: [
    { catalogItemId: hypertension.id, role: 'primary', admissionCondition: '2', note: '合成待复查' },
    { catalogItemId: diagnosis.id, role: 'secondary', admissionCondition: '1' },
  ] } } })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}, 15_000)

it('未确诊时操作栏主按钮确认住院诊断，药品标明先确认诊断，护理项目照常可开', async () => {
  const { writes } = mount('orders', { clinicalFacts: inpatientFullClinicalSchema.parse({ ...clinical, diagnosis: { revision: 0, entries: [] }, orders: [], executions: [] }) })
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  const summary = await screen.findByRole('region', { name: '住院诊断摘要' })
  expect(summary.textContent).toContain('尚未确认')
  expect(await within(bar).findByText('确认后才能开立药品医嘱')).toBeDefined()
  await user.click(within(bar).getByRole('button', { name: '确认住院诊断' }))
  const dialog = screen.getByRole('dialog', { name: '确认住院诊断' })
  expect(within(dialog).getByRole('status').textContent).toBe('还差：至少加入一条诊断')
  await user.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(within(summary).getByRole('button', { name: '添加诊断' })).toBeDefined()
  expect(screen.getByText('药品按住院诊断核对适应症；确认诊断前只能开护理项目。')).toBeDefined()
  await user.type(screen.getByRole('textbox', { name: '医嘱项目' }), '合成')
  const suggestions = await screen.findByRole('region', { name: '医嘱项目候选' })
  const medicine = await within(suggestions).findByRole('button', { name: /合成降压药/ })
  expect(medicine.hasAttribute('disabled')).toBe(true)
  expect(medicine.textContent).toContain('先确认诊断')
  await user.click(within(suggestions).getByRole('button', { name: /合成健康教育/ }))
  expect(screen.queryByRole('region', { name: '医嘱项目候选' })).toBeNull()
  await user.click(within(bar).getByRole('button', { name: '开立医嘱' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ path: expect.stringContaining('/orders/issue'), body: { input: { selection: { kind: 'service', serviceId: 'service-1', quantity: 1 } } } })
})

it('开立区常驻时效频次剂量，选中后频次中文、剂量换算，费用预计是唯一开立按钮旁的次级操作', async () => {
  const { writes } = mount('orders')
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  const issue = await screen.findByRole('region', { name: '开立医嘱' })
  expect(within(within(issue).getByRole('group', { name: '医嘱时效' })).getByRole('button', { name: '长期' }).hasAttribute('disabled')).toBe(true)
  expect(within(issue).getByText('选择项目后显示')).toBeDefined()
  expect(within(issue).getByRole('textbox', { name: '每次剂量' }).hasAttribute('disabled')).toBe(true)
  expect(await within(bar).findByText('还差：选择医嘱项目')).toBeDefined()
  expect(within(bar).getByRole('button', { name: '开立医嘱' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('region', { name: '医嘱项目候选' })).toBeNull()
  await user.click(within(issue).getByRole('button', { name: '查询' }))
  const suggestions = await screen.findByRole('region', { name: '医嘱项目候选' })
  expect((await within(suggestions).findByRole('button', { name: /合成降压药/ })).textContent).toContain('每次 5 mg · 每日一次 · ¥15.00/片')
  await user.click(within(suggestions).getByRole('button', { name: /另有 1 项暂不能开立/ }))
  expect(suggestions.textContent).toContain('合成缺价药暂不能开立：缺院内价格')
  await user.click(within(suggestions).getByRole('button', { name: /合成降压药/ }))
  expect((within(issue).getByRole('textbox', { name: '医嘱项目' }) as HTMLInputElement).value).toBe('合成降压药')
  expect(within(issue).getByText('每日一次 · 08:00')).toBeDefined()
  expect(within(issue).queryByRole('combobox', { name: '医嘱频次' })).toBeNull()
  expect((within(issue).getByRole('textbox', { name: '每次剂量' }) as HTMLInputElement).value).toBe('5 mg')
  expect(within(issue).getByText('= 1 片')).toBeDefined()
  expect(screen.getAllByRole('button', { name: '开立医嘱' })).toHaveLength(1)
  await user.click(within(bar).getByRole('button', { name: '费用预计' }))
  const estimate = await within(issue).findByRole('region', { name: '费用预计' })
  await waitFor(() => expect(estimate.textContent).toContain('开立后病组 FR59'))
  expect(estimate.textContent).toContain('预计总额 ¥50.00 → ¥65.00')
  expect(within(bar).getByRole('button', { name: '收起费用预计' })).toBeDefined()
  await user.click(within(bar).getByRole('button', { name: '开立医嘱' }))
  await waitFor(() => expect(writes.filter(write => write.path.endsWith('/orders/issue'))).toHaveLength(1))
  expect(writes.find(write => write.path.endsWith('/orders/issue'))).toMatchObject({ body: { input: { expectedDrgFingerprint: 'a'.repeat(64),
    selection: { kind: 'medication', catalogItemId: 'medication-2', doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } } } })
})

it('开立被拒时就地显示服务端原因，并可修改诊断或换一个项目', async () => {
  mount('orders', { rejectIssue: true })
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  const issue = await screen.findByRole('region', { name: '开立医嘱' })
  await user.type(within(issue).getByRole('textbox', { name: '医嘱项目' }), '降压')
  await user.click(await within(await screen.findByRole('region', { name: '医嘱项目候选' })).findByRole('button', { name: /合成降压药/ }))
  await user.click(within(bar).getByRole('button', { name: '开立医嘱' }))
  const alert = await within(issue).findByRole('alert')
  expect(alert.textContent).toContain('不能开立 合成降压药：本次住院确诊不符合药品适应症')
  expect(alert.textContent).not.toContain('目录或业务规则已变化')
  expect(within(bar).getByText('不能开立：本次住院确诊不符合药品适应症')).toBeDefined()
  await user.click(within(alert).getByRole('button', { name: '修改诊断' }))
  expect(screen.getByRole('dialog', { name: '修改住院诊断' })).toBeDefined()
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
  await user.click(within(alert).getByRole('button', { name: '换一个项目' }))
  expect((within(issue).getByRole('textbox', { name: '医嘱项目' }) as HTMLInputElement).value).toBe('')
  expect(within(issue).queryByRole('alert')).toBeNull()
})

it('医嘱条目频次显示中文，申请停嘱原位填写理由，操作栏变为确认申请停嘱', async () => {
  mount('orders')
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  const row = (await within(await screen.findByRole('region', { name: '住院医嘱' })).findByText('合成抗血小板药')).closest('article')!
  expect(row.textContent).toContain('每日一次 · 08:00')
  expect(row.textContent).not.toContain('QD')
  await user.click(within(row).getByRole('button', { name: '申请停嘱' }))
  expect(within(row).getByText('提交后由病区护士核对生效。')).toBeDefined()
  expect(within(bar).getByText('还差：停嘱理由')).toBeDefined()
  expect(within(bar).getByRole('button', { name: '确认申请停嘱' }).hasAttribute('disabled')).toBe(true)
  await user.type(within(row).getByRole('textbox', { name: '停嘱理由' }), '合成患者治疗已完成')
  expect(within(bar).getByRole('button', { name: '确认申请停嘱' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(bar).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('textbox', { name: '停嘱理由' })).toBeNull()
  await user.click(within(row).getByRole('button', { name: '申请停嘱' }))
  expect(screen.getByRole('textbox', { name: '停嘱理由' }).getAttribute('value')).toBe('合成患者治疗已完成')
})

it('报告结果和参考区间常驻，完整报告与新检查申请按需展开', async () => {
  mount('investigations')
  const user = userEvent.setup()
  await screen.findByText('合成肌钙蛋白')
  const row = screen.getByText('合成肌钙蛋白').closest('article')
  expect(row?.textContent).toContain('0.02 ng/mL · 参考 0–0.04')
  expect(screen.getByText('查看完整报告').closest('details')?.hasAttribute('open')).toBe(false)
  expect(screen.queryByRole('combobox', { name: '住院检查项目' })).toBeNull()
  const entry = screen.getByRole('button', { name: '开立住院检查' })
  expect((row?.compareDocumentPosition(entry) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(entry)
  expect(screen.getByRole('combobox', { name: '住院检查项目' })).toBeDefined()
  await user.click(screen.getByText('查看完整报告'))
  expect(screen.getByText('查看完整报告').closest('details')?.hasAttribute('open')).toBe(true)
  expect(screen.getByRole('button', { name: '已阅' }).hasAttribute('disabled')).toBe(false)
})

it.each([true, false])('展开报告不会跳过影像门禁，帧显示回调仍核对可读状态 %s', async available => {
  const imaging = inpatientInvestigationsSchema.parse({ admissionId: admission.id, sent: [], laboratoryRequests: [], imagingRequests: [{ id: 'image-request-1', indication: '合成检查指征', serviceRequestId: 'service-request-1', serviceRequestVersion: '1', taskId: 'task-1', taskVersion: '1', status: 'reported', version: 1,
    service: { id: 'service-1', name: '合成胸部CT', code: 'CT-1', version: 1, applicability: '合成适用范围', bodySite: '胸部', department: '放射科', examCode: 'chest-ct-plain', method: '平扫', modality: 'CT', reportSections: ['findings', 'impression', 'technique'] },
    report: { diagnosticReportId: 'report-1', diagnosticReportVersion: '1', examinedAt: '2026-08-24T09:30:00+08:00', issuedAt: '2026-08-24T09:40:00+08:00', revisionNumber: 1, status: 'final', studyId: 'study-1', findings: '合成所见', impression: '合成印象', technique: '合成检查技术' } }] })
  mount('investigations', { investigationFacts: imaging, imagingAvailable: available })
  const user = userEvent.setup()
  const acknowledge = await screen.findByRole('button', { name: '已阅' })
  expect(acknowledge.hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByText('查看完整报告'))
  expect(acknowledge.hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '查看影像' }))
  await user.click(await screen.findByRole('button', { name: '确认合成帧已显示' }))
  expect(acknowledge.hasAttribute('disabled')).toBe(!available)
})

it('护士逐条校对在底栏可操作，PRN按医嘱分别填写理由且不自动执行', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const prn = { ...clinical.orders[0]!, frequencyCode: 'PRN' as const }
  const clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [{ ...prn, id: 'verify-order', display: '合成待校对医嘱', state: 'signed' }, { ...prn, id: 'prn-one', display: '合成按需药一' }, { ...prn, id: 'prn-two', display: '合成按需药二' }], executions: [] })
  const { writes } = mount('orders', { activeSession: nurse, clinicalFacts })
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  expect(await within(bar).findByText('还差 1 条医嘱待校对')).toBeDefined()
  expect(within(bar).getByRole('button', { name: '校对下一条医嘱' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(bar).getByRole('button', { name: '校对下一条医嘱' }))
  await within(bar).findByText('本次医嘱校对已完成')
  expect(writes[0]).toMatchObject({ path: expect.stringContaining('/orders/verify'), body: { input: { orderId: 'verify-order', expectedOrderVersion: 1 } } })
  expect(screen.queryByRole('textbox', { name: '按需执行理由' })).toBeNull()
  const first = screen.getByText('合成按需药一').closest('article')!, second = screen.getByText('合成按需药二').closest('article')!
  await user.click(within(first).getByRole('button', { name: '按需给药' }))
  expect(within(bar).getByRole('button', { name: '确认按需给药' }).hasAttribute('disabled')).toBe(true)
  await user.type(screen.getByRole('textbox', { name: '按需执行理由' }), '合成按需药一的独立理由')
  expect(within(bar).getByRole('button', { name: '确认按需给药' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(second).getByRole('button', { name: '按需给药' }))
  expect(screen.getByRole('textbox', { name: '按需执行理由' }).getAttribute('value')).toBe('')
  await user.click(within(first).getByRole('button', { name: '按需给药' }))
  expect(screen.getByRole('textbox', { name: '按需执行理由' }).getAttribute('value')).toBe('合成按需药一的独立理由')
  expect(writes).toHaveLength(1)
  await user.click(within(bar).getByRole('button', { name: '确认按需给药' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(writes[1]).toMatchObject({ body: { input: { orderId: 'prn-one', expectedOrderVersion: 1, reason: '合成按需药一的独立理由' } } })
})
