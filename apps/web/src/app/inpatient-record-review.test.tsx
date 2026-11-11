// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgPayerReviewPreviewSchema } from '@clinmesh/contracts/inpatient-drg-payer'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientRecord } from './inpatient-record.tsx'
import { InpatientRecordDrgSummary } from './inpatient-record-drg.tsx'
import { InpatientDrgPayer } from './inpatient-drg-payer.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'coder', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-coder', roleCode: 'medical-records' }, user: { id: 'coder', name: '病案人员', email: 'coder@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成病案患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T09:00:00+08:00', admittedAt: '2026-11-03T09:10:00+08:00', depositFen: 100000, chargesFen: 5000, versionId: '2' })
const diagnosis = { conditionId: 'condition-1', role: 'primary' as const, admissionCondition: '1' as const, ordinal: 1, coding: { id: 'diagnosis-1', code: 'I10', display: '合成高血压', system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', releaseId: 'synthetic-browser-1', sourceLocator: 'cn-health:diagnosis:1' } }
const record = inpatientRecordSchema.parse({ admissionId: admission.id, recordNumber: 'BA-001', sourcesHash: 'a'.repeat(64), reviews: [], reviewCurrent: false, snapshot: {
  patient: { patientId: admission.patientId, patientVersion: '1', identifier: 'SYN-RECORD', name: admission.patientName, gender: 'female', birthDate: '1980-01-01', recordNumber: 'BA-001', admissionCount: 1 },
  stay: { admissionId: admission.id, inpatientNumber: admission.inpatientNumber, admissionRoute: 'direct', registeredAt: admission.registeredAt, admittedAt: admission.admittedAt, initialWardId: admission.wardId, initialOrganizationId: admission.organizationId, dischargeWardId: admission.wardId, dischargeOrganizationId: admission.organizationId, transfers: [], events: [] },
  clinical: { diagnosis: { revision: 1, entries: [diagnosis] }, operations: [], mainProcedureExecutionId: null },
  fees: { admissionId: admission.id, encounterVersion: admission.versionId, status: admission.status, financialStatus: admission.financialStatus, charges: [], chargesFen: 5000, depositFen: 100000, balanceFen: -95000, fingerprint: 'b'.repeat(64), transactions: [], categoryNetFen: { bed: 5000 } },
} })
const result = { status: 'grouped' as const, drgCode: 'RA15', mdcCode: 'MDCR', adrgCode: 'RA1', reason: null, steps: [] }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount(view: (write: ReturnType<typeof useInpatientWriteIntent>) => React.ReactNode, currentSession = session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Subject() { return view(useInpatientWriteIntent(currentSession, () => undefined)) }
  return render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>)
}

it('病案诊断展示临床代码与入院病情，不铺技术来源或POA编码', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(record)))
  mount(write => <InpatientRecord admission={admission} session={session} locale="zh-CN" write={write} />)
  const diagnoses = await screen.findByRole('region', { name: '正式诊断与实际操作' })
  expect(diagnoses.textContent).toContain('I10 合成高血压')
  expect(diagnoses.textContent).toContain('入院病情：有')
  expect(screen.getByText('床位费用')).toBeDefined()
  for (const raw of ['POA', 'urn:clinmesh:', 'synthetic-browser-', 'cn-health:']) expect(diagnoses.textContent).not.toContain(raw)
})

it('病案审核说明关闭重开仍归原患者，切换患者不带入说明', async () => {
  const submitted = { ...record, revision: { revision: 1, sourcesHash: record.sourcesHash, snapshot: record.snapshot, actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: '2026-11-03T09:00:00+08:00' } }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(submitted)))
  const user = userEvent.setup()
  const first = mount(write => <InpatientRecord admission={admission} session={session} locale="zh-CN" write={write} />)
  await user.type(await screen.findByRole('textbox', { name: '编码审核说明' }), '原患者待核对')
  first.unmount()
  const other = mount(write => <InpatientRecord admission={{ ...admission, id: 'admission-2', patientId: 'patient-2' }} session={session} locale="zh-CN" write={write} />)
  expect(await screen.findByRole('textbox', { name: '编码审核说明' })).toHaveProperty('value', '')
  other.unmount()
  mount(write => <InpatientRecord admission={admission} session={session} locale="zh-CN" write={write} />)
  await waitFor(() => expect(screen.getByRole('textbox', { name: '编码审核说明' })).toHaveProperty('value', '原患者待核对'))
})

it.each([false, true])('病案岗位复用原预分组与病案投影，冻结状态为%s', async frozen => {
  const paths: string[] = []
  const grouping = inpatientDrgPregroupResultSchema.parse({ admissionId: admission.id, recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成分组口径', frozen, result })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { paths.push(path); return Response.json(path.endsWith('/record') ? record : grouping) }))
  mount(() => <InpatientRecordDrgSummary admission={admission} session={session} locale="zh-CN" />)
  const summary = await screen.findByRole('region', { name: frozen ? '归档分组' : '当前病案分组' })
  expect(summary.textContent).toContain('RA15')
  expect(paths.sort()).toEqual([`/api/his/v1/inpatient/admissions/${admission.id}/drg/pregroup`, `/api/his/v1/inpatient/admissions/${admission.id}/record`].sort())
})

it('历史归档缺少冻结分组时保留缺失状态，不伪造结果或把原病案读取标为失败', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'DRG_FROZEN_RESULT_MISSING', message: '归档未形成固定分组' } }, { status: 409 })))
  mount(() => <InpatientRecordDrgSummary admission={{ ...admission, recordStatus: 'archived' }} session={session} locale="zh-CN" />)
  expect((await screen.findByRole('status')).textContent).toContain('归档时未形成固定分组')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('region', { name: '归档分组' })).toBeNull()
})

it.each([[403, 'FORBIDDEN'], [404, 'INPATIENT_NOT_FOUND'], [503, 'SYNTHETIC_READ_FAILURE']] as const)('真实HTTP %s分组读取失败仍显示错误，不能作为历史缺失状态吞掉', async (status, code) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code, message: '合成读取失败' } }, { status })))
  mount(() => <InpatientRecordDrgSummary admission={{ ...admission, recordStatus: 'archived' }} session={session} locale="zh-CN" />)
  expect(await screen.findByRole('alert')).toBeDefined()
  expect(screen.queryByRole('region', { name: '归档分组' })).toBeNull()
})

it('未归档病例的同名错误和网络不可用都不冒充已知历史缺失', async () => {
  let offline = false
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (offline) throw new TypeError('synthetic offline')
    return Response.json({ error: { code: 'DRG_FROZEN_RESULT_MISSING', message: '合成未归档异常' } }, { status: 409 })
  }))
  mount(() => <InpatientRecordDrgSummary admission={admission} session={session} locale="zh-CN" />)
  expect(await screen.findByRole('alert')).toBeDefined()
  offline = true
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新分组' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('无法连接'))
  expect(screen.queryByRole('region', { name: '归档分组' })).toBeNull()
})

it('医保病例显示真实离院方式与病情标签，完整公式说明按需展开', async () => {
  const insurer: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'medical-insurance' } }
  const archived = inpatientAdmissionSchema.parse({ ...admission, status: 'cleared', financialStatus: 'settled', recordStatus: 'archived' })
  const note = '合成参数说明：基础费率乘以病组权重，仅供模拟核定，不代表实际医保资金。'
  const preview = inpatientDrgPayerReviewPreviewSchema.parse({ admissionId: admission.id, encounterVersion: '2', fingerprint: 'a'.repeat(64), archiveSourcesHash: 'b'.repeat(64), frozenResultHash: 'c'.repeat(64), drgCode: 'RA15', parameterSetId: 'synthetic-parameters', parameterVersion: '1', simulatedPaymentFen: 6000, hospitalChargesFen: 5000, differenceFen: 1000, note, caseSummary: {
    recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成病例口径', groupingInput: { diagnoses: [{ code: 'I10', role: 'main' }], operations: [], gender: 'female', ageYears: 46, ageDays: null, birthWeightGrams: null, dischargeMode: 'home', inpatientDays: 1 }, diagnoses: [diagnosis], operations: [],
  } })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pregroup')) return Response.json({ admissionId: admission.id, recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成病例口径', frozen: true, result })
    if (path.endsWith('/payer-review-preview')) return Response.json(preview)
    if (path.endsWith('/payer-reviews')) return Response.json({ admissionId: admission.id, reviews: [] })
    throw new Error(`Unexpected read ${path}`)
  }))
  mount(write => <InpatientDrgPayer admission={archived} session={insurer} locale="zh-CN" write={write} />, insurer)
  await userEvent.setup().click(await screen.findByText('查看归档病例与编码', { selector: 'summary' }))
  const summary = await screen.findByRole('region', { name: '固定病例与编码来源' })
  expect(summary.textContent).toContain('离院方式 医嘱离院')
  expect(summary.textContent).toContain('入院病情 有')
  expect(summary.textContent).not.toContain('离院方式编码 home')
  const noteElement = screen.getByText(note)
  expect(noteElement.closest('details')?.open).toBe(false)
  await userEvent.setup().click(screen.getByText('查看核定参数来源', { selector: 'summary' }))
  expect(noteElement.closest('details')?.open).toBe(true)
  expect(within(screen.getByTestId('drg-payer-preview')).getByText(/差额不会自动产生收款或退款/)).toBeDefined()
})

it('医保归档摘要把分组、病组、归档费用与冻结支付预估放在同一事实条，不在模拟预览重复归档值', async () => {
  const insurer: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'medical-insurance' } }
  const archived = { ...admission, recordStatus: 'archived' as const }
  const paymentEstimate = { parameterSetId: 'archive-parameters', parameterVersion: 'archive-1', drgCode: 'RA15', referenceFen: 3000, note: '归档医院支付预估' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pregroup')) return Response.json({ admissionId: admission.id, recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成分组口径', frozen: true, result, paymentEstimate })
    if (path.endsWith('/payer-review-preview')) return Response.json({ admissionId: admission.id, encounterVersion: '2', fingerprint: 'a'.repeat(64), archiveSourcesHash: 'b'.repeat(64), frozenResultHash: 'c'.repeat(64), drgCode: 'RA15', parameterSetId: 'current-parameters', parameterVersion: 'current-2', simulatedPaymentFen: 6000, hospitalChargesFen: 5000, differenceFen: 1000, paymentEstimate, estimateDifferenceFen: 3000, note: '当前模拟核定', caseSummary: { recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成口径', groupingInput: { diagnoses: [{ code: 'I10', role: 'main' }], operations: [], gender: 'female', ageYears: 46, ageDays: null, birthWeightGrams: null, dischargeMode: 'home', inpatientDays: 1 }, diagnoses: [diagnosis], operations: [] } })
    if (path.endsWith('/payer-reviews')) return Response.json({ admissionId: admission.id, reviews: [] })
    throw new Error(`Unexpected read ${path}`)
  }))
  mount(write => <InpatientActionProvider stage="record"><InpatientDrgPayer admission={archived} session={insurer} locale="zh-CN" write={write} /><InpatientActionOutlet /></InpatientActionProvider>, insurer)
  const summary = await screen.findByRole('region', { name: '归档时的分组与费用' })
  await waitFor(() => expect(within(summary).getAllByRole('term').map(term => term.textContent)).toEqual(['归档分组', '归档病组', '归档费用', '归档支付预估']))
  await within(summary).findByText('¥50.00')
  expect(within(summary).getByText('¥30.00')).toBeDefined()
  const simulated = screen.getByTestId('drg-payer-preview')
  expect(simulated.textContent).not.toContain('RA15')
  expect(within(simulated).queryByText('归档费用', { exact: true })).toBeNull()
  expect(within(simulated).getByText('¥60.00')).toBeDefined()
  const reviewBtn = screen.getByRole('button', { name: '审阅模拟核定' })
  expect(reviewBtn.hasAttribute('disabled')).toBe(false)
  const user = userEvent.setup()
  await user.click(reviewBtn)
  expect(screen.getByRole('button', { name: '提交模拟核定' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '按归档病组核定，无扣减' }))
  expect(screen.getByRole('button', { name: '提交模拟核定' }).hasAttribute('disabled')).toBe(false)
})

it('病案四项摘要使用归档费用与冻结预估，不把诊断名称冒充病组名称或沿用当前费用', async () => {
  const paymentEstimate = { parameterSetId: 'archive-parameters', parameterVersion: 'archive-1', drgCode: 'RA15', referenceFen: 3000, note: '归档医院支付预估' }
  const archived = inpatientRecordSchema.parse({ ...record, snapshot: { ...record.snapshot, fees: { ...record.snapshot.fees, chargesFen: 9000 } }, archive: {
    id: 'archive-1', revision: 1, reviewId: 'review-1', sourcesHash: 'a'.repeat(64), snapshot: record.snapshot,
    actorId: 'coder', practitionerRoleId: 'role-coder', recordedAt: '2026-11-03T11:00:00+08:00',
  } })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/record')) return Response.json(archived)
    if (path.endsWith('/pregroup')) return Response.json({ admissionId: admission.id, recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成分组口径', frozen: true, result, paymentEstimate })
    throw new Error(`Unexpected read ${path}`)
  }))
  mount(() => <InpatientRecordDrgSummary admission={{ ...admission, recordStatus: 'archived' }} session={session} locale="zh-CN" />)
  const summary = await screen.findByRole('region', { name: '归档分组' })
  expect(within(summary).getAllByRole('term').map(term => term.textContent)).toEqual(['病组', '病组名称', '病案费用', '支付预估'])
  await within(summary).findByText('¥50.00')
  expect(summary.textContent).not.toContain('¥90.00')
  expect(within(summary).getByText('¥30.00')).toBeDefined()
  expect(within(summary).getByLabelText('当前资料未提供病组名称')).toBeDefined()
})

it('病案费用刷新失败后不把查询缓存的旧金额继续作为当前摘要事实', async () => {
  let failed = false
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/record')) return failed
      ? Response.json({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成病案费用读取失败' } }, { status: 503 })
      : Response.json(record)
    return Response.json({ admissionId: admission.id, recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成口径', frozen: false, result })
  }))
  mount(() => <InpatientRecordDrgSummary admission={admission} session={session} locale="zh-CN" />)
  const summary = await screen.findByRole('region', { name: '当前病案分组' })
  await within(summary).findByText('¥50.00')
  failed = true
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新分组' }))
  await screen.findByText('病案费用暂不可用，请刷新后核对。')
  expect(within(summary).queryByText('¥50.00')).toBeNull()
  expect(within(summary).getByText('RA15')).toBeDefined()
})

it('病案人员看归档病案不重复归档标签和修订号，时间到分钟', async () => {
  const archivedAdmission = { ...admission, status: 'cleared' as const, financialStatus: 'settled' as const, recordStatus: 'archived' as const }
  const by = { actorId: 'synthetic-user', practitionerRoleId: 'role-coder' }
  const archived = inpatientRecordSchema.parse({ ...record, reviewCurrent: true,
    revision: { revision: 1, sourcesHash: record.sourcesHash, snapshot: record.snapshot, recordedAt: '2026-11-04T10:05:00+08:00', ...by },
    reviews: [{ id: 'review-1', revision: 1, sourcesHash: record.sourcesHash, outcome: 'approved', reason: '合成审核', recordedAt: '2026-11-04T11:20:00+08:00', ...by }],
    archive: { id: 'archive-1', revision: 1, reviewId: 'review-1', sourcesHash: record.sourcesHash, snapshot: record.snapshot, recordedAt: '2026-11-04T12:30:00+08:00', ...by } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(archived)))
  mount(write => <InpatientRecord admission={archivedAdmission} session={session} locale="zh-CN" write={write} />)
  const region = await screen.findByRole('region', { name: '住院病案首页核心字段集' })
  await within(region).findByRole('region', { name: '审核与归档记录' })
  expect(screen.queryByRole('heading', { name: '住院病案首页核心字段集' })?.className ?? 'sr-only').toContain('sr-only')
  expect(region.textContent).not.toContain('修订')
  expect(region.textContent).toContain('第 1 次提交')
  expect(region.textContent).toContain('11-03 09:10')
  expect(region.textContent).toContain('11-04 12:30')
  expect(region.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  expect(within(region).getAllByText(/病案已归档，只读可查/)).toHaveLength(1)
  // 病案号、住院号仍用等宽；时间不用。
  expect([...region.querySelectorAll('.font-mono')].filter(node => /\d{2}:\d{2}/.test(node.textContent ?? ''))).toEqual([])
})
