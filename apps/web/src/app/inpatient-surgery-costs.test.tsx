// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgeryCosts } from './inpatient-surgery-costs.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import userEvent from '@testing-library/user-event'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T00:00:00Z', depositFen: 0, chargesFen: 0, versionId: '1' })
const costs = { fingerprint: 'a'.repeat(64), components: { formalChargesFen: 200000, pendingOrdersFen: 10000, remainingMaterialsFen: 100000, plannedSurgeryFen: 30000, projectedTotalFen: 340000 }, currentGrouping: null, projectedGrouping: null, currentPaymentReference: null, projectedPaymentReference: null, currentDifferenceFen: null, projectedDifferenceFen: null, paymentStatus: 'rules-unavailable', paymentMessage: '医院尚未启用医保分组', exceptionAlert: 'unknown' }
const usage = [
  { requestId: 'request-1', executionId: 'execution-1', procedureDisplay: 'PCI', materialId: 'wire', catalogVersion: 1, display: '导丝', unit: '根', plannedQuantity: 1, actualQuantity: 2, remainingQuantity: 0, unplanned: false, excessQuantity: 1, usedFen: 20000, additionalFen: 10000 },
  { requestId: 'request-1', executionId: 'execution-1', procedureDisplay: 'PCI', materialId: 'stent', catalogVersion: 1, display: '支架', unit: '枚', plannedQuantity: 1, actualQuantity: 0, remainingQuantity: 1, unplanned: false, excessQuantity: 0, usedFen: 0, additionalFen: 0 },
  { requestId: 'request-1', executionId: 'execution-1', procedureDisplay: 'PCI', materialId: 'balloon', catalogVersion: 1, display: '球囊', unit: '个', plannedQuantity: 0, actualQuantity: 1, remainingQuantity: 0, unplanned: true, excessQuantity: 1, usedFen: 50000, additionalFen: 50000 },
  { requestId: 'request-2', executionId: 'execution-2', procedureDisplay: '另台手术', materialId: 'other', catalogVersion: 1, display: '不属于本台的耗材', unit: '个', plannedQuantity: 0, actualQuantity: 9, remainingQuantity: 0, unplanned: true, excessQuantity: 9, usedFen: 900000, additionalFen: 900000 },
]
const agent = { admissionId: admission.id, taskId: null, status: 'inactive', basisFingerprint: null, stage: 'intraoperative', missing: [], failureCode: null, costs, usage, analysis: null, lastAnalysis: null, confirmedPlan: null, planHistory: [] }
const checks = { admissionId: admission.id, encounterVersion: '1', fingerprint: 'a'.repeat(64), status: 'complete', simulation: null, issues: [], sources: [], paymentStatus: 'grouping-incomplete', paymentMessage: '医院尚未启用医保分组', missing: [], costs, usage }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount(currentSession = session, stay = admission) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientSurgeryCosts admission={stay} session={currentSession} locale="zh-CN" write={write} executionId="execution-1" />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return client
}

it('术中按本台规则用量显示计划、已用、剩余与额外费用，更正刷新不请求模型', async () => {
  let current = agent
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path.endsWith('/drg/agent')) return Response.json(current)
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = mount()
  const panel = await screen.findByRole('region', { name: '本台耗材与实时费用' })
  const wire = await within(panel).findByRole('row', { name: /导丝/ })
  expect(wire.textContent).toContain('超出计划 1根')
  expect(wire.textContent).toContain('¥100.00')
  expect(within(panel).getByRole('row', { name: /支架/ }).textContent).toContain('1枚')
  expect(within(panel).getByRole('row', { name: /球囊/ }).textContent).toContain('计划外')
  expect(within(panel).getByText('本台已用耗材费用').parentElement?.textContent).toContain('¥700.00')
  expect(within(panel).queryByText('不属于本台的耗材')).toBeNull()
  current = { ...agent, usage: [usage[1]!, usage[3]!], costs: { ...costs, components: { ...costs.components, formalChargesFen: 130000, projectedTotalFen: 270000 } } }
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  await waitFor(() => expect(within(panel).queryByRole('row', { name: /导丝/ })).toBeNull())
  expect(within(panel).getByText('本台已用耗材费用').parentElement?.textContent).toContain('¥0.00')
  expect(within(panel).getByText('预计住院总费用').parentElement?.textContent).toContain('¥2,700.00')
  expect(requests.every(request => request.startsWith('GET '))).toBe(true)
})

it('护士仅读取已授权的规则费用和用量，不读取医生核对或展示模型建议', async () => {
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    reads.push(path)
    if (!path.endsWith('/drg/agent')) throw new Error(`Nurse must not read ${path}`)
    return Response.json(agent)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'ward-nurse', practitionerRoleId: 'role-nurse' } })
  await screen.findByRole('row', { name: /导丝/ })
  expect(screen.getByText('预计住院总费用').parentElement?.textContent).toContain('¥3,400.00')
  expect(screen.queryByRole('button', { name: '展开 AI 解释' })).toBeNull()
  expect(screen.queryByRole('region', { name: '住院耗材建议' })).toBeNull()
  expect(reads).toHaveLength(1)
})

it('术中显式请求一次费用解释，核验完成后收起、重开与刷新均复用', async () => {
  let explanation = { admissionId: admission.id, taskId: null, version: 0, fingerprint: checks.fingerprint, status: 'idle', failureCode: null, result: null as null | { id: string; fingerprint: string; model: string; createdAt: string; observations: []; costExplanation: string } }
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/agent')) return Response.json(agent)
    if (path.endsWith('/drg/record-checks')) return Response.json(checks)
    if (path.endsWith('/drg/record-checks/explanation')) return Response.json(explanation)
    if (path.endsWith('/drg/record-checks/explain')) {
      posts.push(JSON.parse(String(init?.body)).input)
      explanation = { ...explanation, status: 'succeeded', version: 1, result: { id: 'explanation-1', fingerprint: checks.fingerprint, model: 'synthetic', createdAt: '2026-11-03T00:00:00Z', observations: [], costExplanation: '本台耗材费用为¥700.00，计划外或超计划费用为¥600.00。' } }
      return Response.json({ data: explanation, auditId: 'audit-1', requestId: 'request-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = mount(), user = userEvent.setup()
  await screen.findByRole('button', { name: '展开 AI 解释' })
  expect(posts).toEqual([])
  await user.click(screen.getByRole('button', { name: '展开 AI 解释' }))
  await screen.findByText('本台耗材费用为¥700.00，计划外或超计划费用为¥600.00。')
  await user.click(screen.getByRole('button', { name: '收起 AI 解释' }))
  await user.click(screen.getByRole('button', { name: '展开 AI 解释' }))
  await act(async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
  expect(posts).toEqual([{ expectedFingerprint: checks.fingerprint, expectedVersion: 0 }])
})
