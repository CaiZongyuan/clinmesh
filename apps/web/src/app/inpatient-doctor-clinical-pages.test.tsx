// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationAcknowledgeInputSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'

vi.mock('./imaging/imaging-viewer.tsx', () => ({ ImagingViewer: ({ onFrameShown }: { onFrameShown?: () => void }) => <button onClick={onFrameShown}>确认合成帧已显示</button> }))

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerId: 'doctor-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
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

function mount(page: 'orders' | 'investigations', { investigationFacts = investigations, imagingAvailable = false, activeSession = session, clinicalFacts = clinical, rejectIssue = false, catalogItems = [] as unknown[], onSimulation, onClinicalRead, preserveDrafts = false }: {
  investigationFacts?: typeof investigations; imagingAvailable?: boolean; activeSession?: SessionContext; clinicalFacts?: typeof clinical; rejectIssue?: boolean; catalogItems?: unknown[]; onSimulation?: () => Promise<void>; onClinicalRead?: () => Promise<void>; preserveDrafts?: boolean
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const writes: Array<{ path: string; body: unknown }> = []
  function Subject({ currentAdmission = admission, active = true }: { currentAdmission?: typeof admission; active?: boolean }) {
    const write = useInpatientWriteIntent(activeSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage={page === 'orders' ? 'orders' : 'investigations'}>{page === 'orders' ? <InpatientClinical admission={currentAdmission} session={activeSession} locale="zh-CN" active={active} write={write} /> : <InpatientInvestigations admission={currentAdmission} session={activeSession} locale="zh-CN" write={write} />}<aside aria-label="底部操作"><InpatientActionOutlet /></aside></InpatientActionProvider>
  }
  if (!preserveDrafts) sessionStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(activeSession)
    if (path.endsWith('/drg/simulation')) { await onSimulation?.(); return Response.json(simulation) }
    if (init?.method === 'POST') {
      if (rejectIssue && path.endsWith('/orders/issue')) return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '本次住院确诊不符合药品适应症' } }, { status: 409 })
      writes.push({ path, body: JSON.parse(String(init.body)) })
      if (path.endsWith('/investigations/acknowledge')) {
        const input = inpatientInvestigationAcknowledgeInputSchema.parse({ admissionId: admission.id, ...JSON.parse(String(init.body)).input })
        investigationFacts = inpatientInvestigationsSchema.parse({ ...investigationFacts, laboratoryRequests: investigationFacts.laboratoryRequests.map(request => request.id === input.requestId && request.report ? { ...request, version: request.version + 1, status: 'acknowledged', report: { ...request.report, acknowledgement: { id: 'ack-1', acknowledgedAt: '2026-08-24T10:00:00+08:00', acknowledgedBy: 'doctor-1' } } } : request) })
      }
      if (path.endsWith('/orders/request-stop') || path.endsWith('/orders/verify-stop')) {
        const body = JSON.parse(String(init.body)), request = path.endsWith('/orders/request-stop')
        clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinicalFacts, orders: clinicalFacts.orders.map(order => order.id === body.input.orderId ? { ...order, state: request ? 'stop-requested' : 'stopped', version: order.version + 1, ...(request ? { stopReason: body.input.reason } : {}) } : order) })
      }
      if (path.endsWith('/orders/verify')) {
        const body = JSON.parse(String(init.body))
        clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinicalFacts, orders: clinicalFacts.orders.map(order => order.id === body.input.orderId ? { ...order, state: 'verified', version: order.version + 1 } : order) })
      }
      return Response.json({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: path.includes('/investigations') ? investigationFacts : clinicalFacts })
    }
    if (path.endsWith('/clinical')) { await onClinicalRead?.(); return Response.json(clinicalFacts) }
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [diagnosis, { ...diagnosis, id: 'diagnosis-local', display: '合成院内诊断' }], medications: [medication], services: [{ id: 'service-1', display: '合成健康教育', version: 1, priceFen: 1000, unit: '次' }] })
    if (path.includes('/inpatient/catalog-search?')) return Response.json({ kind: 'medication', source: 'hospital', page: 1, pageSize: 50, total: 2, items: [
      { id: medication.id, display: medication.display, status: 'available', missingFields: [], catalogItemId: medication.id, catalogVersion: 1, medication },
      { id: 'medication-missing', display: '合成缺价药', status: 'incomplete', missingFields: ['price'] }] })
    if (path.includes('/reference-catalogs/diagnoses?')) return Response.json({ page: 1, pageSize: 20, total: 1, releaseId: 'synthetic-release', items: [hypertension] })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' })
    if (path.endsWith('/investigations')) return Response.json(investigationFacts)
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: catalogItems })
    if (path.endsWith('/imaging-studies/study-1')) return Response.json({ available: imagingAvailable, examCode: 'chest-ct-plain', series: [], studyId: 'study-1' })
    throw new Error(`Unexpected read ${path}`)
  }))
  const mounted = render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>)
  return { ...mounted, writes,
    changeActive: (active: boolean) => mounted.rerender(<QueryClientProvider client={client}><Subject active={active} /></QueryClientProvider>),
    changeAdmission: (currentAdmission: typeof admission, next: typeof investigationFacts) => { investigationFacts = next; mounted.rerender(<QueryClientProvider client={client}><Subject currentAdmission={currentAdmission} /></QueryClientProvider>) },
    refreshInvestigations: async (next: typeof investigationFacts) => { investigationFacts = next; await client.invalidateQueries({ queryKey: ['inpatient'] }) },
    refreshClinical: async (next: typeof clinicalFacts) => { clinicalFacts = next; await client.invalidateQueries({ queryKey: ['inpatient'] }) } }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('医生集中停嘱预览逐项最终理由，显式空覆盖必须修正或删除，原单项表单退场', async () => {
  const facts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [clinical.orders[0], { ...clinical.orders[0], id: 'order-2', display: '合成第二停嘱', state: 'signed' }], executions: [] })
  const { writes } = mount('orders', { clinicalFacts: facts }), user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择停嘱：合成抗血小板药' }))
  await user.click(screen.getByRole('checkbox', { name: '选择停嘱：合成第二停嘱' }))
  expect(screen.queryByRole('button', { name: '申请停嘱' })).toBeNull()
  await user.type(screen.getByRole('textbox', { name: '共同停嘱理由' }), '合成病情好转')
  await user.click(screen.getByRole('button', { name: '单独填写理由：合成第二停嘱' }))
  expect(screen.getByRole('button', { name: '集中申请停嘱 (2)' }).hasAttribute('disabled')).toBe(true)
  await user.type(screen.getByRole('textbox', { name: '单项停嘱理由：合成第二停嘱' }), '合成疗程已满')
  await user.click(screen.getByRole('button', { name: '集中申请停嘱 (2)' }))
  let dialog = screen.getByRole('dialog', { name: '集中申请停嘱' })
  expect(dialog.textContent).toContain('最终停嘱理由：合成病情好转')
  expect(dialog.textContent).toContain('最终停嘱理由：合成疗程已满')
  expect(writes).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: '返回修改' }))
  await user.click(screen.getByRole('button', { name: '使用共同理由：合成第二停嘱' }))
  await user.click(screen.getByRole('button', { name: '集中申请停嘱 (2)' }))
  dialog = screen.getByRole('dialog', { name: '集中申请停嘱' })
  await user.click(within(dialog).getByRole('button', { name: '确认申请 2 条停嘱' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(writes.map(write => write.body)).toMatchObject([
    { input: { orderId: 'order-1', expectedOrderVersion: 1, reason: '合成病情好转' } },
    { input: { orderId: 'order-2', expectedOrderVersion: 1, reason: '合成病情好转' } },
  ])
})

it('护士独立集中核停，展示正式与历史缺失理由及待执行、已发待给任务影响', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const facts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [
    { ...clinical.orders[0], state: 'stop-requested', stopReason: '合成疗程已满' },
    { ...clinical.orders[0], id: 'legacy-stop', display: '合成历史停嘱', state: 'stop-requested' },
    { ...clinical.orders[0], id: 'new-order', display: '合成新医嘱', state: 'signed' },
  ], executions: [
    { ...clinical.executions[0], status: 'pending' },
    { ...clinical.executions[0], id: 'dispensed-task', status: 'dispensed' },
  ] })
  const { writes } = mount('orders', { activeSession: nurse, clinicalFacts: facts }), user = userEvent.setup()
  const orders = await screen.findByRole('region', { name: '住院医嘱' })
  expect(within(orders).queryByRole('checkbox', { name: '选择核停：合成新医嘱' })).toBeNull()
  expect(within(orders).queryByRole('button', { name: '核对停嘱' })).toBeNull()
  await user.click(within(orders).getByRole('button', { name: '全选当前页可核停医嘱' }))
  const list = within(orders).getByRole('region', { name: '待核停清单' })
  expect(list.textContent).toContain('正式停嘱理由：合成疗程已满')
  expect(list.textContent).toContain('历史医嘱缺少停嘱理由')
  expect(list.textContent).toContain('待执行 1 次、已发药待给药 1 次执行任务将取消')
  expect(list.textContent).toContain('既有发药和给药记录保留，库存及费用不自动退回')
  await user.click(screen.getByRole('button', { name: '集中核对停嘱 (2)' }))
  const dialog = screen.getByRole('dialog', { name: '集中核对停嘱' })
  expect(dialog.textContent).toContain('待停嘱核对')
  expect(dialog.textContent).toContain('合成疗程已满')
  expect(within(dialog).queryByText('合成新医嘱')).toBeNull()
  expect(writes).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: '确认核对 2 条停嘱' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(writes.map(write => write.path)).toEqual([
    '/api/his/v1/inpatient/admissions/admission-1/orders/verify-stop',
    '/api/his/v1/inpatient/admissions/admission-1/orders/verify-stop',
  ])
  expect(writes.map(write => write.body)).toMatchObject([
    { input: { orderId: 'order-1', expectedOrderVersion: 1 } },
    { input: { orderId: 'legacy-stop', expectedOrderVersion: 1 } },
  ])
})

it('批量停嘱跨页选择遵守20条上限，清空选择保留理由，丢弃待办须确认', async () => {
  const facts = inpatientFullClinicalSchema.parse({ ...clinical, orders: Array.from({ length: 21 }, (_, index) => ({ ...clinical.orders[0], id: `stop-${index}`, display: `合成待停${index + 1}` })), executions: [] })
  const { writes } = mount('orders', { clinicalFacts: facts }), user = userEvent.setup()
  const orders = await screen.findByRole('region', { name: '住院医嘱' })
  await user.click(within(orders).getByRole('button', { name: '全选当前页可停嘱医嘱' }))
  await user.type(within(orders).getByRole('textbox', { name: '共同停嘱理由' }), '合成共同待办理由')
  await user.click(within(orders).getByRole('button', { name: '下一页' }))
  await user.click(within(orders).getByRole('button', { name: '全选当前页可停嘱医嘱' }))
  await user.click(within(orders).getByRole('button', { name: '下一页' }))
  await user.click(within(orders).getByRole('button', { name: '全选当前页可停嘱医嘱' }))
  expect(orders.textContent).toContain('每次最多保留20条停嘱待办')
  const list = within(orders).getByRole('region', { name: '待停嘱清单' })
  expect(list.textContent).toContain('(20/20) · 已选 20')
  await user.click(within(orders).getByRole('button', { name: '清空选择' }))
  expect(list.textContent).toContain('(20/20) · 已选 0')
  expect(within(list).getByRole('textbox', { name: '共同停嘱理由' }).getAttribute('value')).toBe('合成共同待办理由')
  await user.click(within(orders).getByRole('button', { name: '丢弃停嘱待办' }))
  let dialog = screen.getByRole('dialog', { name: '丢弃停嘱待办？' })
  await user.click(within(dialog).getByRole('button', { name: '保留待办' }))
  expect(list.textContent).toContain('(20/20)')
  await user.click(within(orders).getByRole('button', { name: '丢弃停嘱待办' }))
  dialog = screen.getByRole('dialog', { name: '丢弃停嘱待办？' })
  await user.click(within(dialog).getByRole('button', { name: '确认丢弃停嘱待办' }))
  expect(within(orders).queryByRole('region', { name: '待停嘱清单' })).toBeNull()
  expect(writes).toHaveLength(0)
}, 15_000)

it.each(['dispensed', 'new-task'] as const)('核停确认前执行任务%s变化须显式重新审阅影响，旧预览不发送', async change => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const facts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [{ ...clinical.orders[0], state: 'stop-requested', stopReason: '合成疗程结束' }], executions: [{ ...clinical.executions[0], status: 'pending' }] })
  const mounted = mount('orders', { activeSession: nurse, clinicalFacts: facts }), user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择核停：合成抗血小板药' }))
  await user.click(screen.getByRole('button', { name: '集中核对停嘱 (1)' }))
  let dialog = screen.getByRole('dialog', { name: '集中核对停嘱' })
  expect(dialog.textContent).toContain('待执行 1 次、已发药待给药 0 次')
  const changed = inpatientFullClinicalSchema.parse({ ...facts, executions: change === 'dispensed'
    ? [{ ...facts.executions[0], status: 'dispensed', version: 2 }]
    : [...facts.executions, { ...facts.executions[0], id: 'new-task', scheduledFor: '2026-08-25T09:00:00+08:00' }] })
  await mounted.refreshClinical(changed)
  await user.click(within(dialog).getByRole('button', { name: '确认核对 1 条停嘱' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '集中核对停嘱' })).toBeNull())
  expect(mounted.writes).toHaveLength(0)
  expect(screen.getByText('执行任务已变化，请重新审阅停嘱影响后确认；原输入已保留。')).toBeDefined()
  await user.click(screen.getByRole('button', { name: '集中核对停嘱 (1)' }))
  dialog = screen.getByRole('dialog', { name: '集中核对停嘱' })
  expect(dialog.textContent).toContain(change === 'dispensed' ? '待执行 0 次、已发药待给药 1 次' : '待执行 2 次、已发药待给药 0 次')
  await user.click(within(dialog).getByRole('button', { name: '确认核对 1 条停嘱' }))
  await waitFor(() => expect(mounted.writes).toHaveLength(1))
})

it('医生清空停嘱选择仍保留理由，并可返回原开立操作', async () => {
  mount('orders')
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  await user.click(await screen.findByRole('checkbox', { name: '选择停嘱：合成抗血小板药' }))
  await user.type(screen.getByRole('textbox', { name: '共同停嘱理由' }), '合成待办理由')
  await user.click(within(screen.getByRole('region', { name: '住院医嘱' })).getByRole('button', { name: '清空选择' }))
  expect(screen.getByRole('textbox', { name: '共同停嘱理由' }).getAttribute('value')).toBe('合成待办理由')
  expect(within(bar).getByRole('button', { name: '开立医嘱' })).toBeDefined()
})

it('诊断摘要先于医嘱和开立表单，诊断两栏弹窗只查国家临床版且关闭重开保留草稿', async () => {
  const { writes } = mount('orders')
  const user = userEvent.setup()
  const summary = await screen.findByRole('region', { name: '住院诊断摘要' })
  expect(summary.textContent).toContain('主诊断合成冠心病诊断I25.1入院病情：有')
  const orders = screen.getByRole('region', { name: '住院医嘱' }), issue = screen.getByRole('region', { name: '开立医嘱' })
  expect(summary.compareDocumentPosition(orders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(orders.compareDocumentPosition(issue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: '执行记录 (1)' })).toBeDefined()
  expect(screen.queryByText('已完成')).toBeNull()
  await user.click(within(summary).getByRole('button', { name: '修改诊断' }))
  let dialog = screen.getByRole('dialog', { name: '修改住院诊断' })
  expect(within(dialog).getByText('国家临床版 2022')).toBeDefined()
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

it('未确诊时弹窗药品标明先确认诊断，护理项目照常可开', async () => {
  const { writes } = mount('orders', { clinicalFacts: inpatientFullClinicalSchema.parse({ ...clinical, diagnosis: { revision: 0, entries: [] }, orders: [], executions: [] }) })
  const user = userEvent.setup()
  const summary = await screen.findByRole('region', { name: '住院诊断摘要' })
  expect(summary.textContent).toContain('尚未确认')
  await user.click(within(summary).getByRole('button', { name: '添加诊断' }))
  const diagnosisDialog = screen.getByRole('dialog', { name: '确认住院诊断' })
  expect(within(diagnosisDialog).getByRole('status').textContent).toBe('还差：至少加入一条诊断')
  await user.click(within(diagnosisDialog).getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '开立医嘱' }))
  const dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  const medicine = await within(dialog).findByRole('button', { name: '选择合成降压药' })
  expect(medicine.hasAttribute('disabled')).toBe(true)
  expect(medicine.textContent).toContain('先确认诊断')
  await user.click(within(dialog).getByRole('button', { name: '选择合成健康教育' }))
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ path: expect.stringContaining('/orders/issue'), body: { input: { selection: { kind: 'service', serviceId: 'service-1', quantity: 1 } } } })
})

it('每条医嘱的费用预计保留单项依据，等待重新预计时不能签发', async () => {
  let calls = 0, releaseRefresh!: () => void
  const refreshHeld = new Promise<void>(resolve => { releaseRefresh = resolve })
  const { writes } = mount('orders', { onSimulation: async () => { calls += 1; if (calls === 2) await refreshHeld } })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  const dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  expect(within(dialog).queryByRole('textbox', { name: '每次剂量' })).toBeNull()
  const suggestions = await within(dialog).findByRole('region', { name: '医嘱项目候选' })
  expect((await within(suggestions).findByRole('button', { name: '选择合成降压药' })).textContent).toContain('每次 5 mg · 每日一次 · ¥15.00/片')
  await user.click(within(suggestions).getByRole('button', { name: /另有 1 项暂不能开立/ }))
  expect(suggestions.textContent).toContain('合成缺价药暂不能开立：缺院内价格')
  await user.click(within(suggestions).getByRole('button', { name: '选择合成降压药' }))
  const row = within(dialog).getByRole('region', { name: '待开：合成降压药' })
  expect((within(row).getByRole('textbox', { name: '每次剂量' }) as HTMLInputElement).value).toBe('5 mg')
  expect(within(row).getByText('= 1 片')).toBeDefined()
  await user.click(within(row).getByRole('button', { name: '费用预计' }))
  const estimate = await within(row).findByRole('region', { name: '费用预计' })
  await waitFor(() => expect(estimate.textContent).toContain('开立后病组 FR59'))
  expect(estimate.textContent).toContain('预计总额 ¥50.00 → ¥65.00')
  await user.click(within(row).getByRole('button', { name: '收起费用预计' }))
  await user.click(within(row).getByRole('button', { name: '费用预计' }))
  expect(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }).hasAttribute('disabled')).toBe(true)
  releaseRefresh()
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }).hasAttribute('disabled')).toBe(false))
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  await waitFor(() => expect(writes.filter(write => write.path.endsWith('/orders/issue'))).toHaveLength(1))
  expect(writes.find(write => write.path.endsWith('/orders/issue'))).toMatchObject({ body: { input: { expectedDrgFingerprint: 'a'.repeat(64), selection: { kind: 'medication', catalogItemId: 'medication-2', doseText: '5 mg', doseQuantity: 1, frequencyCode: 'QD' } } } })
})

it('开立被拒时在该行保留服务端原因和输入，关闭后可修改诊断', async () => {
  mount('orders', { rejectIssue: true })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '开立医嘱' }))
  const dialog = screen.getByRole('dialog', { name: '开立医嘱' })
  await user.click(await within(dialog).findByRole('button', { name: '选择合成降压药' }))
  await user.click(within(dialog).getByRole('button', { name: '开立所选医嘱（1）' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('本次住院确诊不符合药品适应症')
  expect(within(dialog).getByRole('textbox', { name: '每次剂量' }).getAttribute('value')).toBe('5 mg')
  expect(document.body.textContent).not.toContain('目录或业务规则已变化')
  await user.click(within(dialog).getByRole('button', { name: '关闭' }))
  await user.click(screen.getByRole('button', { name: '修改诊断' }))
  expect(screen.getByRole('dialog', { name: '修改住院诊断' })).toBeDefined()
})

it('医嘱条目频次显示中文，批量停嘱关闭重开保留共同理由并归还焦点', async () => {
  mount('orders')
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  const row = (await within(await screen.findByRole('region', { name: '住院医嘱' })).findByText('合成抗血小板药')).closest('article')!
  expect(row.textContent).toContain('每日一次 · 08:00')
  expect(row.textContent).not.toContain('QD')
  await user.click(within(row).getByRole('checkbox', { name: '选择停嘱：合成抗血小板药' }))
  expect(within(bar).getByText('还差：逐项停嘱理由')).toBeDefined()
  const primary = within(bar).getByRole('button', { name: '集中申请停嘱 (1)' })
  expect(primary.hasAttribute('disabled')).toBe(true)
  await user.type(screen.getByRole('textbox', { name: '共同停嘱理由' }), '合成患者治疗已完成')
  await user.click(primary)
  expect(screen.getByRole('dialog').textContent).toContain('最终停嘱理由：合成患者治疗已完成')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(primary))
  expect(screen.getByRole('textbox', { name: '共同停嘱理由' }).getAttribute('value')).toBe('合成患者治疗已完成')
  await user.click(primary)
  expect(screen.getByRole('dialog').textContent).toContain('最终停嘱理由：合成患者治疗已完成')
})

it('待阅检验直接展示完整结果表，开立窗口按需打开', async () => {
  const { writes } = mount('investigations')
  const user = userEvent.setup()
  await screen.findByText('合成肌钙蛋白')
  const row = screen.getByText('合成肌钙蛋白').closest('article')
  expect(within(row!).getByRole('table').textContent).toContain('肌钙蛋白 I0.02 ng/mL0–0.04正常')
  expect(screen.queryByText('查看完整报告')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  const entry = screen.getByRole('button', { name: '开立住院检查' })
  expect((row?.compareDocumentPosition(entry) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(entry)
  expect(within(await screen.findByRole('dialog', { name: '开立住院检查' })).getByRole('textbox', { name: '搜索检查检验目录' })).toBeDefined()
  await user.keyboard('{Escape}')
  expect(screen.getByText('合成报告结论')).toBeDefined()
  expect(screen.queryByRole('button', { name: '已阅' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '连续阅读住院报告' }))
  const reader = screen.getByRole('dialog', { name: '住院报告阅读与已阅确认' })
  expect(within(reader).getByRole('checkbox', { name: '选择已阅：合成肌钙蛋白' }).getAttribute('aria-disabled')).toBe('true')
  await user.click(within(reader).getByRole('button', { name: '打开报告：合成肌钙蛋白' }))
  expect(within(reader).getByRole('table').textContent).toContain('肌钙蛋白 I0.02 ng/mL0–0.04正常')
  await waitFor(() => expect(within(reader).getByRole('checkbox', { name: '选择已阅：合成肌钙蛋白' }).getAttribute('aria-disabled')).not.toBe('true'))
  expect(writes).toHaveLength(0)
})

it('开立窗口按类别折叠不可开立项，检验单项适应证只读且检查单独保留指征', async () => {
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
  expect(within(dialog).getByRole('button', { name: '开立所选检验（0）' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '检查' }))
  await user.click(within(dialog).getByRole('button', { name: '选择合成胸部CT' }))
  expect(within(dialog).getByText('住院价格')).toBeDefined()
  expect(screen.getByText('请填写检查指征（至少 2 字）')).toBeDefined()
  expect(within(dialog).getByRole('button', { name: '开立所选检查（1）' }).hasAttribute('disabled')).toBe(true)
  await user.type(within(dialog).getByRole('textbox', { name: '检查指征' }), '合成胸痛待查')
  expect(within(dialog).getByRole('button', { name: '开立所选检查（1）' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(dialog).getByRole('button', { name: '检验' }))
  await user.click(within(dialog).getByRole('button', { name: '选择合成血常规' }))
  expect(within(dialog).queryByRole('combobox', { name: '检验适应证' })).toBeNull()
  expect(within(dialog).getByText('发热')).toBeDefined()
  await user.click(within(dialog).getByRole('button', { name: '开立所选检验（1）' }))
  await within(dialog).findByText('已成功开立 1 项')
  await user.click(within(dialog).getByRole('button', { name: '检查' }))
  expect(within(dialog).getByRole('textbox', { name: '检查指征' }).getAttribute('value')).toBe('合成胸痛待查')
  expect(writes.at(-1)).toMatchObject({ path: expect.stringContaining('/admission-1/investigations/issue'), body: { input: { catalogVersion: 1, selection: { kind: 'laboratory', catalogItemId: 'lab-single', indicationCode: 'fever' } } } })
})

it('连续阅读窗口明确打开并选择检验报告，核对后集中确认已阅', async () => {
  const { writes } = mount('investigations')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '连续阅读住院报告' }))
  const reader = screen.getByRole('dialog', { name: '住院报告阅读与已阅确认' })
  expect(within(reader).getByRole('button', { name: '核对选中报告' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(reader).getByRole('button', { name: '打开报告：合成肌钙蛋白' }))
  expect(writes).toHaveLength(0)
  await user.click(within(reader).getByRole('checkbox', { name: '选择已阅：合成肌钙蛋白' }))
  await user.click(within(reader).getByRole('button', { name: '核对选中报告' }))
  const review = screen.getByRole('dialog', { name: '住院报告已阅核对' })
  expect(within(review).getByText('合成肌钙蛋白')).toBeDefined()
  expect(writes).toHaveLength(0)
  await user.click(within(review).getByRole('button', { name: '确认选中报告已阅' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ path: expect.stringContaining('acknowledge'), body: { input: { requestId: 'request-1', expectedRequestVersion: 1, serviceRequestVersion: '1', taskVersion: '1', diagnosticReportId: 'report-1', diagnosticReportVersion: '1' } } })
  await waitFor(() => expect(screen.getByRole('region', { name: '报告已阅逐项结果' }).textContent).toContain('成功 1/1'))
  await user.click(screen.getByRole('button', { name: '关闭阅读窗口' }))
  await screen.findByRole('button', { name: '查看全文' })
  expect(screen.queryByRole('table')).toBeNull()
})

it('已阅报告只留摘要，全文与既往修订在同一弹窗回看并归还焦点', async () => {
  const current = investigations.laboratoryRequests[0]!
  const facts = inpatientInvestigationsSchema.parse({ ...investigations, laboratoryRequests: [{ ...current, status: 'acknowledged', report: { ...current.report!, acknowledgement: { id: 'ack-1', acknowledgedAt: '2026-08-24T10:00:00+08:00', acknowledgedBy: 'doctor-1' } },
    previousReports: [{ ...current.report!, diagnosticReportId: 'old-report', conclusion: '合成既往报告结论' }] }] })
  const mounted = mount('investigations', { investigationFacts: facts })
  const user = userEvent.setup()
  const trigger = await screen.findByRole('button', { name: '查看全文' })
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByText('合成既往报告结论')).toBeNull()
  await user.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '合成肌钙蛋白 · 完整报告' })
  expect(within(dialog).getAllByRole('table')).toHaveLength(2)
  expect(within(dialog).getByText('合成既往报告结论')).toBeDefined()
  expect(within(dialog).queryByRole('button', { name: '已阅' })).toBeNull()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
  await user.click(trigger)
  mounted.changeAdmission({ ...admission, id: 'admission-2', patientName: '合成第二患者' }, inpatientInvestigationsSchema.parse({ ...facts, admissionId: 'admission-2', laboratoryRequests: [{ ...facts.laboratoryRequests[0]!, report: { ...facts.laboratoryRequests[0]!.report!, conclusion: '合成第二患者报告' } }] }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(await screen.findByRole('button', { name: '查看全文' }))
  expect(screen.getByRole('dialog').textContent).toContain('合成第二患者报告')
  expect(within(screen.getByRole('dialog')).queryByText('合成报告结论')).toBeNull()
})

it('医生按医嘱查执行记录，护士仍在主页面执行', async () => {
  const data = inpatientFullClinicalSchema.parse({ ...clinical, orders: [...clinical.orders, { ...clinical.orders[0]!, id: 'order-2', display: '合成第二医嘱' }],
    executions: [...clinical.executions, { ...clinical.executions[0]!, id: 'execution-2', orderId: 'order-2', status: 'pending' }] })
  const mounted = mount('orders', { clinicalFacts: data })
  const user = userEvent.setup()
  const orders = await screen.findByRole('region', { name: '住院医嘱' })
  const order = (await within(orders).findByText('合成抗血小板药')).closest('article')!
  const trigger = within(order).getByRole('button', { name: '执行记录 (1)' })
  await user.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '合成抗血小板药 · 执行记录 (1)' })
  expect(within(dialog).getByText('已完成')).toBeDefined()
  expect(within(dialog).queryByText('合成第二医嘱')).toBeNull()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
  mounted.unmount()
  mount('orders', { clinicalFacts: data, activeSession: { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } } })
  expect(await screen.findByText('已完成')).toBeDefined()
  expect(screen.queryByRole('button', { name: '执行记录 (1)' })).toBeNull()
})

it.each([true, false])('报告直接展示与连续阅读均保留影像首帧门禁 %s', async available => {
  const imaging = inpatientInvestigationsSchema.parse({ admissionId: admission.id, sent: [], laboratoryRequests: [], imagingRequests: [{ id: 'image-request-1', indication: '合成检查指征', serviceRequestId: 'service-request-1', serviceRequestVersion: '1', taskId: 'task-1', taskVersion: '1', status: 'reported', version: 1,
    service: { id: 'service-1', name: '合成胸部CT', code: 'CT-1', version: 1, applicability: '合成适用范围', bodySite: '胸部', department: '放射科', examCode: 'chest-ct-plain', method: '平扫', modality: 'CT', reportSections: ['findings', 'impression', 'technique'] },
    report: { diagnosticReportId: 'report-1', diagnosticReportVersion: '1', examinedAt: '2026-08-24T09:30:00+08:00', issuedAt: '2026-08-24T09:40:00+08:00', revisionNumber: 1, status: 'final', studyId: 'study-1', findings: '合成所见', impression: '合成印象', technique: '合成检查技术' } }] })
  const mounted = mount('investigations', { investigationFacts: imaging, imagingAvailable: available })
  const user = userEvent.setup()
  await screen.findByText('合成所见')
  expect(screen.getByText('合成印象')).toBeDefined()
  expect(screen.queryByRole('button', { name: '已阅' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '连续阅读住院报告' }))
  const reader = screen.getByRole('dialog', { name: '住院报告阅读与已阅确认' })
  const selection = () => within(reader).getByRole('checkbox', { name: '选择已阅：合成胸部CT' })
  const review = within(reader).getByRole('button', { name: '核对选中报告' })
  expect(selection().getAttribute('aria-disabled')).toBe('true')
  await user.click(within(reader).getByRole('button', { name: '打开报告：合成胸部CT' }))
  expect(within(reader).getByText('合成所见')).toBeDefined()
  expect(within(reader).getByText('合成印象')).toBeDefined()
  expect(selection().getAttribute('aria-disabled')).toBe('true')
  expect(review.hasAttribute('disabled')).toBe(true)
  expect(mounted.writes).toHaveLength(0)
  if (available) {
    await user.click(await within(reader).findByRole('button', { name: '确认合成帧已显示' }))
    await waitFor(() => expect(selection().getAttribute('aria-disabled')).not.toBe('true'))
    await user.click(selection())
    expect(review.hasAttribute('disabled')).toBe(false)
    const current = imaging.imagingRequests[0]!
    await mounted.refreshInvestigations(inpatientInvestigationsSchema.parse({ ...imaging, imagingRequests: [{ ...current, report: { ...current.report!, diagnosticReportVersion: '2', impression: '合成更正印象' } }] }))
    await within(reader).findByText('合成更正印象')
    expect(selection().getAttribute('aria-disabled')).toBe('true')
    expect(review.hasAttribute('disabled')).toBe(true)
    await user.click(await within(reader).findByRole('button', { name: '确认合成帧已显示' }))
    await waitFor(() => expect(selection().getAttribute('aria-disabled')).not.toBe('true'))
    await user.click(selection())
    expect(review.hasAttribute('disabled')).toBe(false)
  } else {
    expect(await within(reader).findByText('影像暂不可读')).toBeDefined()
    expect(within(reader).getByRole('button', { name: '重新读取影像' })).toBeDefined()
    expect(within(reader).queryByRole('button', { name: '确认合成帧已显示' })).toBeNull()
    expect(selection().getAttribute('aria-disabled')).toBe('true')
    expect(review.hasAttribute('disabled')).toBe(true)
  }
  expect(mounted.writes).toHaveLength(0)
})

it('护士先选择并集中核对新医嘱，PRN按医嘱分别填写理由且不自动执行', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const prn = { ...clinical.orders[0]!, frequencyCode: 'PRN' as const }
  const clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [{ ...prn, id: 'verify-order', display: '合成待校对医嘱', state: 'signed' }, { ...prn, id: 'prn-one', display: '合成按需药一' }, { ...prn, id: 'prn-two', display: '合成按需药二' }], executions: [] })
  const { writes } = mount('orders', { activeSession: nurse, clinicalFacts })
  const user = userEvent.setup(), bar = screen.getByRole('complementary', { name: '底部操作' })
  await user.click(await screen.findByRole('checkbox', { name: '选择校对：合成待校对医嘱' }))
  await user.click(within(bar).getByRole('button', { name: '集中核对新医嘱 (1)' }))
  const review = screen.getByRole('dialog', { name: '集中核对新医嘱' })
  expect(review.textContent).toContain('合成待校对医嘱')
  expect(writes).toHaveLength(0)
  await user.click(within(review).getByRole('button', { name: '确认校对 1 条新医嘱' }))
  await within(bar).findByText('本次医嘱校对已完成')
  expect(writes[0]).toMatchObject({ path: expect.stringContaining('/orders/verify'), body: { input: { orderId: 'verify-order', expectedOrderVersion: 1 } } })
  expect(screen.queryByRole('textbox', { name: '按需执行理由' })).toBeNull()
  expect(screen.queryByRole('button', { name: '按需给药' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '集中发起 PRN' }))
  const prnDialog = screen.getByRole('dialog', { name: '集中发起 PRN' })
  for (const [id, display] of [['prn-one', '合成按需药一'], ['prn-two', '合成按需药二']]) {
    await user.click(within(prnDialog).getByRole('checkbox', { name: `选择PRN：${display}` }))
    const draft = within(prnDialog).getByRole('article', { name: `待办项目：${id}` })
    await user.click(within(draft).getByRole('button', { name: '单独填写理由' }))
    await user.type(within(draft).getByRole('textbox', { name: `单项 PRN 理由：${display}` }), `${display}的独立理由`)
  }
  await user.click(within(prnDialog).getByRole('button', { name: '关闭办理窗口' }))
  await user.click(screen.getByRole('button', { name: '集中发起 PRN' }))
  expect(within(screen.getByRole('dialog', { name: '集中发起 PRN' })).getByRole('textbox', { name: '单项 PRN 理由：合成按需药一' }).getAttribute('value')).toBe('合成按需药一的独立理由')
  await user.click(within(screen.getByRole('dialog', { name: '集中发起 PRN' })).getByRole('button', { name: '核对 PRN 发起 (2)' }))
  const preview = screen.getByRole('dialog', { name: '集中发起 PRN' })
  expect(within(preview).getByText('最终理由：合成按需药一的独立理由')).toBeTruthy()
  expect(within(preview).getByText('最终理由：合成按需药二的独立理由')).toBeTruthy()
  expect(writes).toHaveLength(1)
})

it('新医嘱当前页全选保留跨页勾选，20条上限保留输入，清空选择与确认丢弃明确区分', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const orders = Array.from({ length: 21 }, (_, index) => ({ ...clinical.orders[0]!, id: `signed-${index}`, display: `合成待校对${index + 1}`, state: 'signed' }))
  const clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [...orders, { ...orders[0], id: 'stop-only', display: '合成待核停', state: 'stop-requested' }], executions: [] })
  const { writes } = mount('orders', { activeSession: nurse, clinicalFacts }), user = userEvent.setup()
  const region = await screen.findByRole('region', { name: '新医嘱校对' })
  expect(within(region).getAllByRole('checkbox')).toHaveLength(10)
  expect(within(region).queryByRole('checkbox', { name: '选择校对：合成待核停' })).toBeNull()
  await user.click(within(region).getByRole('button', { name: '全选当前页可校对医嘱' }))
  let drafts = within(region).getByRole('region', { name: '待校对清单' })
  expect(drafts.textContent).toContain('待校对清单 (10/20) · 已选 10')
  await user.click(within(region).getByRole('button', { name: '下一页' }))
  await user.click(within(region).getByRole('button', { name: '全选当前页可校对医嘱' }))
  expect(drafts.textContent).toContain('待校对清单 (20/20) · 已选 20')
  await user.click(within(region).getByRole('button', { name: '下一页' }))
  await user.click(within(region).getByRole('button', { name: '全选当前页可校对医嘱' }))
  expect(region.textContent).toContain('待校对清单最多保留20条')
  expect(drafts.textContent).toContain('待校对清单 (20/20) · 已选 20')
  await user.type(within(region).getByRole('textbox', { name: '搜索待校对医嘱' }), '待校对21')
  expect(within(region).getByRole('checkbox', { name: '选择校对：合成待校对21' }).getAttribute('aria-checked')).toBe('false')
  await user.click(within(region).getByRole('button', { name: '清空选择' }))
  expect(drafts.textContent).toContain('待校对清单 (20/20) · 已选 0')
  await user.click(within(region).getByRole('button', { name: '清空待校对清单' }))
  let dialog = screen.getByRole('dialog', { name: '丢弃待校对清单？' })
  await user.click(within(dialog).getByRole('button', { name: '保留清单' }))
  drafts = within(region).getByRole('region', { name: '待校对清单' })
  expect(drafts.textContent).toContain('(20/20)')
  await user.click(within(region).getByRole('button', { name: '清空待校对清单' }))
  dialog = screen.getByRole('dialog', { name: '丢弃待校对清单？' })
  await user.click(within(dialog).getByRole('button', { name: '确认丢弃待校对清单' }))
  expect(within(region).queryByRole('region', { name: '待校对清单' })).toBeNull()
  expect(writes).toHaveLength(0)
}, 15_000)

it('校对选择关闭和刷新保留，版本变化先阻止确认并要求逐项重新核对', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [{ ...clinical.orders[0], state: 'signed' }], executions: [] })
  const mounted = mount('orders', { activeSession: nurse, clinicalFacts }), user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择校对：合成抗血小板药' }))
  await user.click(screen.getByRole('button', { name: '集中核对新医嘱 (1)' }))
  let dialog = screen.getByRole('dialog', { name: '集中核对新医嘱' })
  expect(dialog.textContent).toContain('1片')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '集中核对新医嘱 (1)' })))
  mounted.unmount()
  const restored = mount('orders', { activeSession: nurse, clinicalFacts, preserveDrafts: true })
  expect((await screen.findByRole('checkbox', { name: '选择校对：合成抗血小板药' })).getAttribute('aria-checked')).toBe('true')
  const changed = inpatientFullClinicalSchema.parse({ ...clinicalFacts, orders: [{ ...clinicalFacts.orders[0], version: 2, doseText: '2片', doseQuantity: 2 }] })
  await restored.refreshClinical(changed)
  await screen.findByText('状态或内容已变化，须重新核对或移除。')
  expect(screen.getByRole('button', { name: '集中核对新医嘱 (1)' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '重新核对：合成抗血小板药' }))
  await user.click(screen.getByRole('button', { name: '集中核对新医嘱 (1)' }))
  dialog = screen.getByRole('dialog', { name: '集中核对新医嘱' })
  expect(dialog.textContent).toContain('2片')
  expect(restored.writes).toHaveLength(0)
}, 15_000)

it('新医嘱校对完成后底栏交回独立核停动作，不能混入已选批次', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [
    { ...clinical.orders[0], id: 'new-order', state: 'signed' },
    { ...clinical.orders[0], id: 'stop-order', display: '合成待停药', state: 'stop-requested' },
  ], executions: [] })
  const { writes } = mount('orders', { activeSession: nurse, clinicalFacts }), user = userEvent.setup()
  const bar = screen.getByRole('complementary', { name: '底部操作' })
  await user.click(await screen.findByRole('checkbox', { name: '选择校对：合成抗血小板药' }))
  expect(screen.queryByRole('checkbox', { name: '选择校对：合成待停药' })).toBeNull()
  await user.click(within(bar).getByRole('button', { name: '集中核对新医嘱 (1)' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中核对新医嘱' })).getByRole('button', { name: '确认校对 1 条新医嘱' }))
  expect(await within(bar).findByRole('button', { name: '集中核对停嘱 (0)' })).toBeDefined()
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ body: { input: { orderId: 'new-order' } } })
})

it('核对读取期间切到其他页签，返回后保留选择并可再次集中核对', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  const clinicalFacts = inpatientFullClinicalSchema.parse({ ...clinical, orders: [{ ...clinical.orders[0], state: 'signed' }], executions: [] })
  let clinicalReads = 0, releaseRead: () => void = () => undefined
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const mounted = mount('orders', { activeSession: nurse, clinicalFacts, onClinicalRead: async () => { clinicalReads += 1; if (clinicalReads === 2) await held } })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择校对：合成抗血小板药' }))
  await user.click(screen.getByRole('button', { name: '集中核对新医嘱 (1)' }))
  await waitFor(() => expect(clinicalReads).toBe(2))
  mounted.changeActive(false)
  releaseRead()
  await mounted.refreshClinical(clinicalFacts)
  expect(screen.queryByRole('dialog', { name: '集中核对新医嘱' })).toBeNull()
  mounted.changeActive(true)
  const review = screen.getByRole('button', { name: '集中核对新医嘱 (1)' })
  await waitFor(() => expect(review.hasAttribute('disabled')).toBe(false))
  expect(screen.getByRole('checkbox', { name: '选择校对：合成抗血小板药' }).getAttribute('aria-checked')).toBe('true')
  await user.click(review)
  expect(await screen.findByRole('dialog', { name: '集中核对新医嘱' })).toBeDefined()
  expect(mounted.writes).toHaveLength(0)
})
