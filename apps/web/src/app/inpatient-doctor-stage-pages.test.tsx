// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import { inpatientFinancialSchema } from '@clinmesh/contracts/inpatient-finance'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { InpatientRecord } from './inpatient-record.tsx'
import { InpatientDischarge, InpatientSettlement } from './inpatient-discharge.tsx'
import { InpatientNumber } from './inpatient-number.tsx'
import { InpatientFinancialAdjustments } from './inpatient-financial-adjustments.tsx'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

vi.mock('./inpatient-drg-record-checks.tsx', () => ({ InpatientDrgRecordChecksPanel: () => <p>真实病案核对入口</p> }))
vi.mock('./inpatient-drg-review.tsx', () => ({ InpatientDrgReviewPanel: () => <p>真实责任交接入口</p> }))
vi.mock('./inpatient-drg-followup.tsx', () => ({ InpatientDrgFollowupPanel: () => <label>跟进备注<input /></label> }))
vi.mock('./inpatient-drg-agent.tsx', () => ({ InpatientDrgAgentPanel: () => <p>真实耗材建议入口</p> }))

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成医生页面患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', bedId: 'bed-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T09:00:00+08:00', admittedAt: '2026-11-03T09:10:00+08:00', depositFen: 100000, chargesFen: 5000, versionId: '2' })
const grouping = { status: 'grouped', drgCode: 'FM39', mdcCode: 'F', adrgCode: 'FM3', reason: null, steps: [] }
const simulation = inpatientDrgSimulationSchema.parse({ admissionId: admission.id, evaluatedAt: '2026-11-03T10:00:00+08:00', fingerprint: 'a'.repeat(64), rulesId: 'synthetic-rules', rulesVersion: '1', formal: { chargesFen: 5000, items: [] }, committed: { items: [] }, reserved: { items: [] }, draft: { items: [], missing: [] }, coverage: { coveredFen: 5000, estimatedTotalFen: 5000, coveredRatioBp: 10000, note: '合成完整费用' }, grouping: { formal: grouping, projected: { ...grouping, drgCode: 'FM49' }, note: '合成手术比较' }, paymentReference: null, incompleteness: { costMissing: false, paymentReferenceMissing: false } })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount(view: (write: ReturnType<typeof useInpatientWriteIntent>) => ReactNode, currentSession = session) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() { return view(useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))) }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}

it('DRG先展示当前与计划比较，次级跟进按需打开且收起后保留输入', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/drg/simulation')) return Response.json(simulation)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-11-03T10:00:00+08:00', requests: [], executions: [], inProgress: [] })
    throw new Error(`Unexpected page read ${path}`)
  }))
  mount(write => <InpatientDrgPanel admission={admission} session={session} locale="zh-CN" write={write} reservations={false} />)
  const current = await screen.findByRole('region', { name: '按当前诊断和手术' })
  expect(screen.getByRole('region', { name: '如按计划手术' }).textContent).toContain('FM49')
  const summary = screen.getByText('住院自动跟进', { selector: 'summary' })
  expect(current.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '跟进备注' })).toBeNull()
  const user = userEvent.setup()
  await user.click(summary)
  await user.type(await screen.findByRole('textbox', { name: '跟进备注' }), '保留临床跟进输入')
  await user.click(summary); await user.click(summary)
  expect(screen.getByRole('textbox', { name: '跟进备注' })).toHaveProperty('value', '保留临床跟进输入')
})

const recordSnapshot = {
  patient: { patientId: admission.patientId, patientVersion: '1', identifier: 'SYN-STAGE-PAGES', name: admission.patientName, gender: 'female', birthDate: '1980-01-01', recordNumber: 'BA-001', admissionCount: 1 },
  stay: { admissionId: admission.id, inpatientNumber: admission.inpatientNumber, admissionRoute: 'direct', registeredAt: admission.registeredAt, admittedAt: admission.admittedAt, initialWardId: admission.wardId, initialOrganizationId: admission.organizationId, dischargeWardId: admission.wardId, dischargeOrganizationId: admission.organizationId, transfers: [], events: [] },
  clinical: { diagnosis: { revision: 0, entries: [] }, operations: [], mainProcedureExecutionId: null },
  fees: { admissionId: admission.id, encounterVersion: admission.versionId, status: admission.status, financialStatus: admission.financialStatus, charges: [{ id: 'charge-1', label: '合成床位费', amountFen: 5000, kind: 'bed', sourceId: 'bed-1', organizationId: admission.organizationId, serviceDate: '2026-11-03', virtualTime: '2026-11-03T10:00:00+08:00', version: 1 }], chargesFen: 5000, depositFen: 100000, balanceFen: -95000, fingerprint: 'b'.repeat(64), transactions: [], categoryNetFen: { bed: 5000 } },
}
const recordRevision = { revision: 1, sourcesHash: 'a'.repeat(64), snapshot: recordSnapshot, actorId: session.actor.actorId, practitionerRoleId: session.actor.practitionerRoleId!, recordedAt: '2026-11-03T15:10:00+08:00' }
function stubRecord(initial: Record<string, unknown>, writes: unknown[] = []) {
  let record = inpatientRecordSchema.parse({ admissionId: admission.id, recordNumber: 'BA-001', sourcesHash: 'a'.repeat(64), snapshot: recordSnapshot, reviews: [], reviewCurrent: false, ...initial })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/record/submit')) {
      writes.push(JSON.parse(String(init?.body)))
      record = { ...record, revision: { ...recordRevision, revision: (record.revision?.revision ?? 0) + 1 } }
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: record })
    }
    if (path.endsWith('/record')) return Response.json(record)
    throw new Error(`Unexpected record read ${path}`)
  }))
}
const clearedAdmission = { ...admission, status: 'cleared' as const, financialStatus: 'settled' as const }

it('医生在院病案列出提交首页前的条件，字段直接展示，无已实施操作时结算前不能提交', async () => {
  stubRecord({})
  mount(write => <InpatientRecord admission={admission} session={session} locale="zh-CN" write={write} />)
  const conditions = await screen.findByRole('region', { name: '提交首页前' })
  expect(conditions.textContent).toContain('主诊断')
  expect(conditions.textContent).toContain('离院信息')
  expect(conditions.textContent).toContain('费用')
  expect(screen.queryByRole('region', { name: '病案首页状态' })).toBeNull()
  expect(screen.queryByText('查看病案核心字段')).toBeNull()
  expect(screen.queryByRole('region', { name: '患者基本信息' })).toBeNull()
  const submit = screen.getByRole('button', { name: '提交病案首页' })
  expect(submit.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('status').textContent).toContain('出院结算后')
})

it('在院已实施操作时仍可选定主操作提交，供 DRG 预分组使用', async () => {
  const writes: unknown[] = []
  const coding = { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical' as const, version: '3.0' as const, code: '36.0700', display: '合成支架置入', category: '介入治疗' as const, releaseId: 'clinmesh-surgery-subset-2026-10-20' as const, sourceUrl: 'https://example.test/source', sourceSha256: 'c'.repeat(64), sourceLocator: 'row-1' }
  const operation = { id: 'execution-1', admissionId: admission.id, requestId: 'surgery-1', actualProcedure: { id: 'procedure-1', version: 1, coding, chargeDefinition: { id: 'charge-def-1', priceFen: 100, unit: '次', synthetic: true as const, trigger: 'execution' as const } },
    performedAt: '2026-11-03T15:40:00+08:00', performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: admission.organizationId, note: '合成手术记录', materials: [], procedureVersion: '1', primary: false }
  stubRecord({ snapshot: { ...recordSnapshot, clinical: { ...recordSnapshot.clinical, operations: [operation] } } }, writes)
  mount(write => <InpatientRecord admission={admission} session={session} locale="zh-CN" write={write} />)
  const user = userEvent.setup()
  const submit = await screen.findByRole('button', { name: '提交病案首页' })
  expect(submit.hasAttribute('disabled')).toBe(true)
  await user.click(within(screen.getByRole('radiogroup', { name: '本次主操作' })).getByRole('radio', { name: /36.0700/ }))
  expect(screen.getByRole('region', { name: '当前操作' }).textContent).toContain('DRG 预分组')
  await user.click(submit)
  await waitFor(() => expect(writes).toEqual([{ input: { expectedRevision: 0, expectedSourcesHash: 'a'.repeat(64), mainProcedureExecutionId: 'execution-1' } }]))
})

it('结算后提交病案首页，提交后显示第 1 次提交并不再给提交按钮', async () => {
  const writes: unknown[] = []
  stubRecord({}, writes)
  const open = vi.fn()
  mount(write => <InpatientRecord admission={clearedAdmission} session={session} locale="zh-CN" write={write} onOpenStage={open} />)
  const user = userEvent.setup()
  const submit = await screen.findByRole('button', { name: '提交病案首页' })
  await waitFor(() => expect(submit).toHaveProperty('disabled', false))
  expect(screen.queryByRole('region', { name: '提交首页前' })).toBeNull()
  expect(within(screen.getByRole('region', { name: '患者基本信息' })).getByText(admission.patientName)).toBeDefined()
  expect(within(screen.getByRole('region', { name: '病案费用' })).queryByText('合成床位费')).toBeNull()
  await user.click(within(screen.getByRole('region', { name: '病案费用' })).getByRole('button', { name: /费用/ }))
  expect(open).toHaveBeenCalledWith('fees')
  await user.click(submit)
  await waitFor(() => expect(writes).toEqual([{ input: { expectedRevision: 0, expectedSourcesHash: 'a'.repeat(64), mainProcedureExecutionId: null } }]))
  expect(await screen.findByText(/第 1 次提交/)).toBeDefined()
  await waitFor(() => expect(screen.queryByRole('button', { name: /提交病案首页/ })).toBeNull())
  expect(screen.getByRole('region', { name: '当前操作' }).textContent).toContain('等病案人员编码审核')
})

it('被退回时退回理由置顶，可重新提交病案首页', async () => {
  stubRecord({ revision: recordRevision, reviews: [{ id: 'review-1', revision: 1, sourcesHash: 'a'.repeat(64), outcome: 'returned', reason: '次要诊断缺失分级', actorId: 'coder', practitionerRoleId: 'role-coder', recordedAt: '2026-11-04T09:30:00+08:00' }] })
  mount(write => <InpatientRecord admission={clearedAdmission} session={session} locale="zh-CN" write={write} />)
  const returned = await screen.findByText(/次要诊断缺失分级/, { selector: '[role="status"] *, [role="status"]' })
  expect(returned.compareDocumentPosition(screen.getByRole('region', { name: '患者基本信息' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: '重新提交病案首页' })).toBeDefined()
  expect(screen.queryByText(/修订 1/)).toBeNull()
})

it('医生出院页先说明真实办理状态，保留原开立输入且不代护士填写离院方式', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/discharge')) return Response.json({ admissionId: admission.id, events: [] })
    if (path.endsWith('/discharge/issue')) {
      writes.push(JSON.parse(String(init?.body)))
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: { admission: { ...admission, status: 'discharge-pending', versionId: '3' } } })
    }
    throw new Error(`Unexpected discharge read ${path}`)
  }))
  mount(write => <InpatientDischarge admission={admission} session={session} locale="zh-CN" write={write} />)
  await screen.findByRole('region', { name: '开出院医嘱前' })
  expect(screen.queryByRole('region', { name: '出院办理状态' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '离院方式' })).toBeNull()
  expect(screen.queryByText(/计划手术将取消/)).toBeNull()
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '出院处理说明' }), '合成出院复诊说明')
  await user.click(screen.getByRole('button', { name: '开出院医嘱' }))
  await waitFor(() => expect(writes).toEqual([{ input: { encounterVersion: '2', reason: '合成出院复诊说明' } }]))
})

it('真实长病案号显示摘要、可查看全文并复制原始号码', async () => {
  const number = 'MR-019a4ad8-4567-7def-8123-123456789abc'
  const user = userEvent.setup()
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  render(<InpatientNumber locale="zh-CN" number={number} label="病案号" />)
  expect(screen.getByTitle(number).textContent).toBe('病案号 MR-019a…9abc')
  await user.click(screen.getByRole('button', { name: `复制病案号 ${number}` }))
  expect(copy).toHaveBeenCalledWith(number)
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '已复制')
})

it('已知未收口手术按原出院门禁提示先处理，填写说明后也不发送必然失败的命令', async () => {
  const surgery = inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '2', virtualTime: admission.registeredAt, executions: [], requests: [{ id: 'request-1', admissionId: admission.id, version: 1, status: 'requested', plannedFor: admission.registeredAt, requestedAt: admission.registeredAt, requestedBy: 'doctor', organizationId: admission.organizationId, reason: '合成未实施手术',
    plannedProcedure: { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '51.2300', display: '合成胆囊切除术', category: '手术', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.test/procedures', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } } }] })
  const writes: string[] = [], open = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(path)
    return Response.json({ admissionId: admission.id, events: [] })
  }))
  mount(write => <InpatientDischarge admission={admission} session={session} locale="zh-CN" write={write} activity={{ admission, role: 'inpatient-doctor', surgery }} onOpenStage={open} />)
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '出院处理说明' }), '合成出院说明草稿')
  expect(screen.getByRole('region', { name: '开出院医嘱前' }).textContent).toContain('1 项手术申请尚未实施或取消')
  expect(screen.getByRole('button', { name: '开出院医嘱' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '开出院医嘱' }))
  expect(writes).toEqual([])
  await user.click(screen.getByRole('button', { name: '去手术' }))
  expect(open).toHaveBeenCalledWith('surgery')
  expect(screen.getByRole('textbox', { name: '出院处理说明' })).toHaveProperty('value', '合成出院说明草稿')
})

const nursingClinical = inpatientFullClinicalSchema.parse({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] },
  orders: ['medication', 'service'].map((kind, index) => ({ id: 'order-' + index, admissionId: admission.id, kind, duration: 'long', catalogItemId: 'item-' + index, catalogVersion: 1, display: '合成护理待办' + index, doseText: '1次', doseQuantity: 1, unit: '次', frequencyCode: 'QD', state: 'verified', version: 1, requestVersion: '1', signedAt: admission.registeredAt, signedBy: 'doctor', organizationId: admission.organizationId })),
  executions: [{ id: 'execution-0', orderId: 'order-0', scheduledFor: admission.registeredAt, status: 'dispensed', version: 1 }, { id: 'execution-1', orderId: 'order-1', scheduledFor: admission.registeredAt, status: 'pending', version: 1 }],
  dispenses: [], charges: [], chargesFen: 0,
})

it('在院护士出院清单同时说明医生出院医嘱和真实给药执行待办', async () => {
  const nurse: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'ward-nurse' } }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, events: [] })))
  mount(write => <InpatientDischarge admission={admission} session={nurse} locale="zh-CN" write={write} activity={{ admission, role: 'ward-nurse', clinical: nursingClinical }} />, nurse)
  const blockers = screen.getByRole('region', { name: '办理出院还差' })
  expect(blockers.textContent).toContain('住院医生：先开出院医嘱')
  expect(blockers.textContent).toContain('2 条医嘱')
  expect(blockers.textContent).toContain('病区护士完成或取消给药：1 次')
  expect(blockers.textContent).toContain('病区护士完成或取消执行：1 次')
  expect(screen.getByRole('button', { name: '办理出院' }).hasAttribute('disabled')).toBe(true)
})

it('医生开出院医嘱的说明提示不混入护士实际离院的停嘱给药门禁', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, events: [] })))
  mount(write => <InpatientDischarge admission={admission} session={session} locale="zh-CN" write={write} activity={{ admission, role: 'inpatient-doctor', clinical: nursingClinical }} />)
  expect(screen.getByRole('status').textContent).toBe('还差：出院处理说明')
  expect(screen.queryByText(/请住院医生停嘱/)).toBeNull()
  // 在用医嘱只提醒，不阻止开出院医嘱。
  expect(screen.getByRole('region', { name: '开出院医嘱前' }).textContent).toContain('2 条医嘱未停')
  await userEvent.setup().type(screen.getByRole('textbox', { name: '出院处理说明' }), '合成医生出院说明')
  expect(screen.getByRole('button', { name: '开出院医嘱' }).hasAttribute('disabled')).toBe(false)
})

it('出院医嘱开立后医嘱未停时提示轮到医生停嘱，并能回到诊断医嘱', async () => {
  const pending = { ...admission, status: 'discharge-pending' as const }
  const open = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ admissionId: admission.id, events: [{ id: 'event-1', kind: 'issue', reason: '合成治疗完成', virtualTime: '2026-11-03T10:05:00+08:00', actorId: 'doctor', practitionerRoleId: 'role-doctor', bedId: 'bed-1' }] })))
  mount(write => <InpatientDischarge admission={pending} session={session} locale="zh-CN" write={write} activity={{ admission: pending, role: 'inpatient-doctor', clinical: nursingClinical }} onOpenStage={open} />)
  const blockers = screen.getByRole('region', { name: '病区护士办理出院还差' })
  expect(blockers.textContent).toContain('2 条医嘱')
  expect(screen.getByText(/出院医嘱开立后不能撤回/)).toBeDefined()
  expect(screen.queryByRole('textbox', { name: '出院处理说明' })).toBeNull()
  const history = await screen.findByRole('region', { name: '出院办理记录' })
  expect(history.textContent).toContain('合成治疗完成')
  expect(history.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  await userEvent.setup().click(screen.getByRole('button', { name: '去诊断医嘱停嘱' }))
  expect(open).toHaveBeenCalledWith('orders')
})

it('已离院未结算时召回理由点开才出现，确认后按理由召回', async () => {
  const departed = { ...admission, status: 'departed' as const }
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/discharge/recall')) {
      writes.push(JSON.parse(String(init?.body)))
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: { admission: { ...admission, versionId: '4' } } })
    }
    return Response.json({ admissionId: admission.id, events: [] })
  }))
  mount(write => <InpatientDischarge admission={departed} session={session} locale="zh-CN" write={write} />)
  expect(screen.queryByRole('textbox')).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '召回住院' }))
  await user.type(screen.getByRole('textbox', { name: '召回理由' }), '离院后胸痛复发')
  await user.click(screen.getByRole('button', { name: '确认召回住院' }))
  await waitFor(() => expect(writes).toEqual([{ input: { encounterVersion: '2', reason: '离院后胸痛复发' } }]))
})

const cashier: SessionContext = { ...session, actor: { ...session.actor, roleCode: 'cashier', practitionerRoleId: 'role-cashier' } }
const settledAdmission = { ...admission, status: 'cleared' as const, financialStatus: 'settled' as const }
const bill = inpatientFinancialSchema.parse({ admissionId: admission.id, status: 'cleared', recordStatus: 'open',
  firstSettlement: { id: 'settlement-1', chargesFen: 5000, depositFen: 5000, balanceFen: 0, fingerprint: 'a'.repeat(64), settledAt: '2026-11-03T10:00:00+08:00' },
  charges: [{ chargeId: 'charge-1', label: '合成住院费用', originalFen: 5000, adjustedFen: 0, addedFen: 0, currentFen: 5000 }], adjustments: [], sources: [], refunds: [], payments: [],
  frozenChargesFen: 5000, currentChargesFen: 5000, frozenFundsFen: 5000, currentFundsFen: 5000, remainingRefundFen: 0, remainingCollectFen: 0, reservedFen: 0, reservedCollectFen: 0, fingerprint: 'b'.repeat(64) })

it('结算后按需发起更正，收起保留输入且审阅后仍绑定原费用指纹', async () => {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(cashier)
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return Response.json({ auditId: 'audit-adjustment', requestId: 'request-adjustment', effects: [], warnings: [], data: bill })
    }
    if (path.endsWith('/financial-adjustments')) return Response.json(bill)
    throw new Error(`Unexpected financial read ${path}`)
  }))
  mount(write => <InpatientFinancialAdjustments admission={settledAdmission} session={cashier} locale="zh-CN" write={write} />, cashier)
  expect((await screen.findByRole('region', { name: '财务更正状态' })).textContent).toContain('当前无待收退金额')
  const start = screen.getByText('发起财务更正', { selector: 'summary' })
  expect(start.closest('details')).toHaveProperty('open', false)
  const user = userEvent.setup()
  await user.click(start)
  await user.type(screen.getByRole('textbox', { name: '更正金额（元）' }), '10')
  await user.type(screen.getByRole('textbox', { name: '财务更正原因' }), '合成重复计费更正')
  await user.click(start); await user.click(start)
  expect(screen.getByRole('textbox', { name: '更正金额（元）' })).toHaveProperty('value', '10')
  await user.click(screen.getByRole('button', { name: '审阅财务更正' }))
  expect(writes).toEqual([])
  await user.click(screen.getByRole('button', { name: '提交财务更正' }))
  await waitFor(() => expect(writes).toEqual([{ input: { chargeId: 'charge-1', direction: 'decrease', amountFen: 1000, expectedFingerprint: bill.fingerprint, reason: '合成重复计费更正' } }]))
})

it('未知后续退款不藏入历史，并按原退款版本查询', async () => {
  const unknownBill = inpatientFinancialSchema.parse({ ...bill, reservedFen: 1000, refunds: [{ refundId: 'refund-1', sourceKind: 'inpatient-deposit', sourceId: 'deposit-1', basisId: 'adjustment-1', ownerKind: 'inpatient', ownerId: admission.id, amountFen: 1000,
    initialOutcome: 'ambiguous', outcome: 'ambiguous', correlationId: 'synthetic-correlation', createdAt: '2026-11-03T10:00:00+08:00', resolvedAt: null, version: 3 }] })
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(cashier)
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return Response.json({ auditId: 'audit-refund', requestId: 'request-refund', effects: [], warnings: [], data: unknownBill })
    }
    if (path.endsWith('/financial-adjustments')) return Response.json(unknownBill)
    throw new Error(`Unexpected recovery read ${path}`)
  }))
  mount(write => <InpatientFinancialAdjustments admission={settledAdmission} session={cashier} locale="zh-CN" write={write} />, cashier)
  const recover = await screen.findByRole('button', { name: '查询原后续退款结果' })
  expect(recover.closest('details')).toBeNull()
  expect(screen.getByRole('region', { name: '财务更正状态' }).textContent).toContain('资金结果未知')
  expect(screen.getByText('查看更正与收退款记录', { selector: 'summary' }).closest('details')?.open).toBe(false)
  expect(screen.queryByText('当前无待收退金额，可按需发起财务更正。')).toBeNull()
  await userEvent.setup().click(recover)
  await waitFor(() => expect(writes).toEqual([{ input: { refundId: 'refund-1', expectedRefundVersion: 3 } }]))
})

it('无须补交时只展示实际结算步骤，不重复提示或把收款标为完成', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/payments')) return Response.json({ admissionId: admission.id, payments: [], refunds: [], sources: [], depositFen: 100000, supplementFen: 0, pendingCount: 0, refundedFen: 0, remainingFen: -95000 })
    if (path.includes('/insurance')) return Response.json({ error: { code: 'UNAVAILABLE', message: '合成医保暂不可用' } }, { status: 503 })
    throw new Error(`Unexpected settlement read ${path}`)
  }))
  mount(write => <InpatientSettlement admission={{ ...admission, status: 'departed' }} session={cashier} locale="zh-CN" write={write} />, cashier)
  await screen.findByText('无需补交，直接预览结算。')
  const steps = within(screen.getByRole('list', { name: '出院结算进度' })).getAllByRole('listitem')
  expect(steps).toHaveLength(3)
  expect(steps[0]?.textContent).toContain('预览结算')
  expect(steps.some(step => step.textContent?.includes('收款') || step.getAttribute('data-status') === 'completed')).toBe(false)
  expect(screen.getAllByText(/无需补交/)).toHaveLength(1)
})
