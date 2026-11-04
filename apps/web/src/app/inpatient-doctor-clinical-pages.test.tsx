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
const clinical = inpatientFullClinicalSchema.parse({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 1, entries: [{ conditionId: 'condition-1', role: 'primary', admissionCondition: '1', ordinal: 1, coding: diagnosis }] },
  orders: [{ id: 'order-1', admissionId: admission.id, kind: 'medication', duration: 'long', catalogItemId: 'medication-1', catalogVersion: 1, display: '合成抗血小板药', doseText: '1片', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 1, requestVersion: '1', signedAt: '2026-08-24T09:00:00+08:00', signedBy: 'doctor-1', organizationId: 'organization-inpatient' }],
  executions: [{ id: 'execution-1', orderId: 'order-1', scheduledFor: '2026-08-24T09:00:00+08:00', status: 'completed', version: 1 }], dispenses: [], charges: [], chargesFen: 0 })
const investigations = inpatientInvestigationsSchema.parse({ admissionId: admission.id, sent: [], imagingRequests: [], laboratoryRequests: [{ id: 'request-1', catalogItemId: 'laboratory-1', indicationCode: 'screening', serviceRequestId: 'service-request-1', serviceRequestVersion: '1', taskId: 'task-1', taskVersion: '1', status: 'reported', version: 1,
  referenceConcept: { ...diagnosis, id: 'laboratory-1', display: '合成肌钙蛋白' }, report: { diagnosticReportId: 'report-1', diagnosticReportVersion: '1', issuedAt: '2026-08-24T09:40:00+08:00', revisionNumber: 1, specimenId: 'specimen-1', status: 'final', conclusion: '合成报告结论',
    results: [{ code: 'troponin', display: '肌钙蛋白 I', value: 0.02, interpretation: 'normal', observationId: 'observation-1', referenceRange: { high: 0.04, text: '0–0.04' }, unit: { code: 'ng/mL', display: 'ng/mL', system: 'http://unitsofmeasure.org' } }] } }] })

function mount(page: 'orders' | 'investigations', { investigationFacts = investigations, imagingAvailable = false, activeSession = session, clinicalFacts = clinical, catalogItems = [] as unknown[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const writes: Array<{ path: string; body: unknown }> = []
  function Subject() {
    const write = useInpatientWriteIntent(activeSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage={page === 'orders' ? 'orders' : 'investigations'}>{page === 'orders' ? <InpatientClinical admission={admission} session={activeSession} locale="zh-CN" write={write} /> : <InpatientInvestigations admission={admission} session={activeSession} locale="zh-CN" write={write} />}<aside aria-label="底部操作"><InpatientActionOutlet /></aside></InpatientActionProvider>
  }
  sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(activeSession)
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) })
      if (path.endsWith('/orders/verify')) clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinicalFacts, orders: clinicalFacts.orders.map(order => order.id === 'verify-order' ? { ...order, state: 'verified', version: order.version + 1 } : order) })
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: path.includes('/investigations') ? investigationFacts : clinicalFacts })
    }
    if (path.endsWith('/clinical')) return Response.json(clinicalFacts)
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [diagnosis], medications: [], services: [] })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' })
    if (path.endsWith('/investigations')) return Response.json(investigationFacts)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: catalogItems })
    if (path.endsWith('/imaging-studies/study-1')) return Response.json({ available: imagingAvailable, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' })
    throw new Error(`Unexpected read ${path}`)
  }))
  return { ...render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>), writes }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('诊断摘要先于医嘱和开立表单，诊断编辑可收起且保留草稿', async () => {
  mount('orders')
  const user = userEvent.setup()
  const summary = await screen.findByRole('region', { name: '住院诊断摘要' })
  expect(summary.textContent).toContain('合成冠心病诊断主诊断入院病情：有')
  const orders = screen.getByRole('region', { name: '住院医嘱' }), issue = screen.getByRole('region', { name: '开立医嘱' })
  expect(summary.compareDocumentPosition(orders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(orders.compareDocumentPosition(issue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '主诊断备注' })).toBeNull()
  expect(screen.getByText(/执行记录/).closest('details')?.hasAttribute('open')).toBe(false)
  await user.click(within(summary).getByRole('button', { name: '修改诊断' }))
  await user.type(screen.getByRole('textbox', { name: '主诊断备注' }), '保留诊断草稿')
  await user.click(within(summary).getByRole('button', { name: '收起诊断编辑' }))
  expect(screen.queryByRole('textbox', { name: '主诊断备注' })).toBeNull()
  await user.click(within(summary).getByRole('button', { name: '修改诊断' }))
  expect(screen.getByRole('textbox', { name: '主诊断备注' }).getAttribute('value')).toBe('保留诊断草稿')
})

it('停嘱理由跟随对应医嘱展开，填写后才允许确认且收起不丢失理由', async () => {
  mount('orders')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '申请停嘱' }))
  expect(screen.getByRole('button', { name: '确认申请停嘱' }).hasAttribute('disabled')).toBe(true)
  await user.type(screen.getByRole('textbox', { name: '停嘱理由' }), '合成患者治疗已完成')
  expect(screen.getByRole('button', { name: '确认申请停嘱' }).hasAttribute('disabled')).toBe(false)
  await user.click(screen.getByRole('button', { name: '收起' }))
  expect(screen.queryByRole('textbox', { name: '停嘱理由' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '申请停嘱' }))
  expect(screen.getByRole('textbox', { name: '停嘱理由' }).getAttribute('value')).toBe('合成患者治疗已完成')
})

it('报告结果和参考区间常驻，完整报告与开立窗口按需展开', async () => {
  mount('investigations')
  const user = userEvent.setup()
  await screen.findByText('合成肌钙蛋白')
  const row = screen.getByText('合成肌钙蛋白').closest('article')
  expect(row?.textContent).toContain('0.02 ng/mL · 参考 0–0.04')
  expect(screen.getByText('查看完整报告').closest('details')?.hasAttribute('open')).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  const entry = screen.getByRole('button', { name: '开立住院检查' })
  expect((row?.compareDocumentPosition(entry) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(entry)
  expect(within(await screen.findByRole('dialog', { name: '开立住院检查' })).getByRole('textbox', { name: '搜索检查检验目录' })).toBeDefined()
  await user.keyboard('{Escape}')
  await user.click(screen.getByText('查看完整报告'))
  expect(screen.getByText('查看完整报告').closest('details')?.hasAttribute('open')).toBe(true)
  expect(screen.getByText('合成报告结论')).toBeDefined()
  expect(screen.getByRole('button', { name: '已阅' }).hasAttribute('disabled')).toBe(false)
})

it('开立窗口折叠不可开立项，检验单项适应证只读，影像须填写检查指征', async () => {
  const catalogItems = [
    { id: 'lab-single', kind: 'laboratory', display: '合成血常规', version: 1, priceFen: 2000, available: true, indicationCodes: ['fever'] },
    { id: 'lab-unpriced', kind: 'laboratory', display: '合成未定价检验', version: 1, available: false, unavailableReason: 'unpriced', indicationCodes: ['fever'] },
    { id: 'ct-chest', kind: 'imaging', display: '合成胸部CT', version: 3, priceFen: 30000, available: true, indicationCodes: [] },
  ]
  const { writes } = mount('investigations', { catalogItems })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '开立住院检查' }))
  const dialog = await screen.findByRole('dialog', { name: '开立住院检查' })
  await within(dialog).findByRole('button', { name: '选择合成血常规' })
  expect(within(dialog).queryByRole('button', { name: '选择合成未定价检验' })).toBeNull()
  expect(within(dialog).getByText('另有 1 项暂不能开立')).toBeDefined()
  await user.click(within(dialog).getByRole('button', { name: '查看原因' }))
  expect(within(dialog).getByText(/未声明住院价格/)).toBeDefined()
  const confirm = () => within(dialog).getAllByRole('button', { name: '开立住院检查' }).at(-1)!
  expect(confirm().hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '选择合成胸部CT' }))
  expect(within(dialog).getByText('住院价格')).toBeDefined()
  expect(within(dialog).getByText('还差：检查指征')).toBeDefined()
  expect(confirm().hasAttribute('disabled')).toBe(true)
  await user.type(within(dialog).getByRole('textbox', { name: '检查指征' }), '合成胸痛待查')
  expect(confirm().hasAttribute('disabled')).toBe(false)
  await user.click(within(dialog).getByRole('button', { name: '选择合成血常规' }))
  expect(within(dialog).queryByRole('combobox', { name: '检验适应证' })).toBeNull()
  expect(within(dialog).getByText('发热')).toBeDefined()
  await user.click(confirm())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes.at(-1)).toMatchObject({ path: expect.stringContaining('/admission-1/investigations/issue'), body: { input: { catalogVersion: 1, selection: { kind: 'laboratory', catalogItemId: 'lab-single', indicationCode: 'fever' } } } })
})

it('操作栏逐份已阅检验报告', async () => {
  const { writes } = mount('investigations')
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  await user.click(await within(bar).findByRole('button', { name: '已阅：合成肌钙蛋白' }))
  await waitFor(() => expect(writes.at(-1)).toMatchObject({ path: expect.stringContaining('acknowledge'), body: { input: { requestId: 'request-1', diagnosticReportId: 'report-1' } } }))
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
  const bar = screen.getByRole('complementary', { name: '底部操作' }), primary = within(bar).getByRole('button', { name: '已阅：合成胸部CT' })
  expect(primary.hasAttribute('disabled')).toBe(true)
  expect(within(bar).getByText('还差：先查看影像再已阅')).toBeDefined()
  await user.click(await screen.findByRole('button', { name: '确认合成帧已显示' }))
  expect(acknowledge.hasAttribute('disabled')).toBe(!available)
  await waitFor(() => expect(primary.hasAttribute('disabled')).toBe(!available))
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
