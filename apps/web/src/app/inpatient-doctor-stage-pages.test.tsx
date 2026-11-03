// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { inpatientRecordSchema } from '@clinmesh/contracts/inpatient-record'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgPanel } from './inpatient-drg.tsx'
import { InpatientRecord } from './inpatient-record.tsx'
import { InpatientDischarge } from './inpatient-discharge.tsx'
import { InpatientNumber } from './inpatient-number.tsx'
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
function mount(view: (write: ReturnType<typeof useInpatientWriteIntent>) => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() { return view(useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))) }
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

it('医生在院病案先给状态摘要，核心字段可展开，真实首页提交不增加结算门槛', async () => {
  const snapshot = {
    patient: { patientId: admission.patientId, patientVersion: '1', identifier: 'SYN-STAGE-PAGES', name: admission.patientName, gender: 'female', birthDate: '1980-01-01', recordNumber: 'BA-001', admissionCount: 1 },
    stay: { admissionId: admission.id, inpatientNumber: admission.inpatientNumber, admissionRoute: 'direct', registeredAt: admission.registeredAt, admittedAt: admission.admittedAt, initialWardId: admission.wardId, initialOrganizationId: admission.organizationId, dischargeWardId: admission.wardId, dischargeOrganizationId: admission.organizationId, transfers: [], events: [] },
    clinical: { diagnosis: { revision: 0, entries: [] }, operations: [], mainProcedureExecutionId: null },
    fees: { admissionId: admission.id, encounterVersion: admission.versionId, status: admission.status, financialStatus: admission.financialStatus, charges: [], chargesFen: 5000, depositFen: 100000, balanceFen: -95000, fingerprint: 'b'.repeat(64), transactions: [], categoryNetFen: {} },
  }
  let record = inpatientRecordSchema.parse({ admissionId: admission.id, recordNumber: 'BA-001', sourcesHash: 'a'.repeat(64), snapshot, reviews: [], reviewCurrent: false })
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/record/submit')) {
      writes.push(JSON.parse(String(init?.body)))
      record = { ...record, revision: { revision: 1, sourcesHash: record.sourcesHash, snapshot: record.snapshot, actorId: session.actor.actorId, practitionerRoleId: session.actor.practitionerRoleId!, recordedAt: '2026-11-03T10:00:00+08:00' } }
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [], data: record })
    }
    if (path.endsWith('/record')) return Response.json(record)
    throw new Error(`Unexpected record read ${path}`)
  }))
  mount(write => <InpatientRecord admission={admission} session={session} locale="zh-CN" write={write} />)
  const status = await screen.findByRole('region', { name: '病案首页状态' })
  expect(status.textContent).toContain('患者在院中')
  const fields = screen.getByText('查看病案核心字段', { selector: 'summary' })
  expect(fields.closest('details')).toHaveProperty('open', false)
  const user = userEvent.setup()
  await user.click(fields)
  expect(fields.closest('details')).toHaveProperty('open', true)
  expect(within(screen.getByRole('region', { name: '患者基本信息' })).getByText(admission.patientName)).toBeDefined()
  const submit = screen.getByRole('button', { name: '提交首页（本次无已实施操作）' })
  await waitFor(() => expect(submit).toHaveProperty('disabled', false))
  await user.click(submit)
  await waitFor(() => expect(writes).toEqual([{ input: { expectedRevision: 0, expectedSourcesHash: 'a'.repeat(64), mainProcedureExecutionId: null } }]))
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
  const status = await screen.findByRole('region', { name: '出院办理状态' })
  expect(status.textContent).toContain('病区护士')
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
