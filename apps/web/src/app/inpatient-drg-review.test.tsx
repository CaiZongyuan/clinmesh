// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T00:00:00Z', depositFen: 0, chargesFen: 0, versionId: '1' })
const todo = { id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire', kind: 'extra-use', ownerRole: 'inpatient-doctor', display: '导丝', materialId: 'wire', plannedQuantity: 1, actualQuantity: 2, procedureDisplay: '经皮冠状动脉介入治疗', executionId: 'execution-1', requestId: 'request-1', explanation: '实际用量超出原确认计划，请核实额外用途。', evidence: ['Procedure/execution-1'], target: 'surgery', status: 'pending', reason: null }
const review = inpatientDrgReviewSchema.parse({ admissionId: admission.id, taskId: null, version: 1, status: 'complete', fingerprint: 'a'.repeat(64), freezeReason: null,
  summary: { formalDrgCode: null, formalChargesFen: 200000, projectedTotalFen: null }, simulation: null, comparisons: [], planBases: [], missing: [], todos: [todo], resolvedTodos: [], actions: [], model: null, handedOver: null })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount(currentSession = session, stay = admission) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const navigate = vi.fn()
  function Harness() {
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientDrgReviewPanel admission={stay} session={currentSession} locale="zh-CN" write={write} onOpenRecord={navigate} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return navigate
}

it('未开启跟进的术后待办展示原手术和数量，并直接进入原记录', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(review)))
  const navigate = mount()
  const item = (await screen.findByText('导丝')).closest('article')!
  expect(item.textContent).toContain('计划量：1')
  expect(item.textContent).toContain('实际量：2')
  expect(item.textContent).toContain('经皮冠状动脉介入治疗')
  await userEvent.setup().click(within(item).getByRole('button', { name: '前往手术原记录' }))
  expect(navigate).toHaveBeenCalledWith('surgery')
  expect(screen.queryByText('尚未开启本次住院跟进。')).toBeNull()
})

it('归档后保留待办与原记录入口，关闭处置、复查和交接写入', async () => {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(path)
    return Response.json({ ...review, status: 'frozen', freezeReason: '病案已归档，停止新的临床分析。' })
  }))
  const navigate = mount(session, { ...admission, recordStatus: 'archived' })
  await screen.findByText('导丝')
  expect(screen.queryByRole('textbox', { name: '待办处理说明' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: '本轮交接说明' })).toBeNull()
  expect(screen.queryByRole('button', { name: '复查最新业务记录' })).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '前往手术原记录' }))
  expect(navigate).toHaveBeenCalledWith('surgery')
  expect(posts).toEqual([])
})

it('收费员只展示财务差异与正式收费，并进入本岗费用原记录', async () => {
  const financialTodo = { ...todo, kind: 'billing-mismatch', ownerRole: 'cashier', display: '导丝收费不一致', target: 'charges', plannedQuantity: null,
    expectedChargeFen: 20000, actualChargeFen: 10000, chargeDifferenceFen: -10000 }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...review, summary: { formalDrgCode: null, formalChargesFen: 10000, projectedTotalFen: null }, todos: [financialTodo] })))
  const navigate = mount({ ...session, actor: { ...session.actor, roleCode: 'cashier', practitionerRoleId: 'role-cashier' } })
  const panel = await screen.findByRole('region', { name: '住院费用核查待办' })
  await within(panel).findByText('导丝收费不一致')
  expect(within(panel).getByText('正式收费净额：¥100.00')).toBeDefined()
  expect(within(panel).getByText('应计费用：¥200.00')).toBeDefined()
  expect(within(panel).queryByText(/计划量：|实际量：|阶段 DRG|费用预计/)).toBeNull()
  expect(within(panel).queryByRole('button', { name: '前往手术原记录' })).toBeNull()
  await userEvent.setup().click(within(panel).getByRole('button', { name: '前往费用原记录' }))
  expect(navigate).toHaveBeenCalledWith('fees')
})
