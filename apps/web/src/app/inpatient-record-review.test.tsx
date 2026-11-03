// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
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

it.each([false, true])('病案岗位只从原预分组入口读取真实分组，冻结状态为%s', async frozen => {
  const paths: string[] = []
  const grouping = inpatientDrgPregroupResultSchema.parse({ admissionId: admission.id, recordRevision: 1, rulesId: 'synthetic-rules', rulesVersion: '1', inputCoding: 'nhc-icd10-clinical@2022.r4', codingNote: '合成分组口径', frozen, result })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { paths.push(path); return Response.json(grouping) }))
  mount(() => <InpatientRecordDrgSummary admission={admission} session={session} locale="zh-CN" />)
  const summary = await screen.findByRole('region', { name: frozen ? '归档分组' : '当前病案分组' })
  expect(summary.textContent).toContain('RA15')
  expect(paths).toEqual([`/api/his/v1/inpatient/admissions/${admission.id}/drg/pregroup`])
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
