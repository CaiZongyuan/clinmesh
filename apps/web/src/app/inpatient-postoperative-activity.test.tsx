// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgerySchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientPatientWorkspace } from './inpatient-patient-workspace.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-14T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '合成医生', email: 'synthetic@example.test' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成术后患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, admittedAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成冠脉支架植入', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://synthetic.example.test/procedures', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic:procedure' }, chargeDefinition: { id: 'charge-1', priceFen: 180000, unit: '次', synthetic: true, trigger: 'execution' } }
const surgeries = inpatientSurgerySchema.parse({ admissionId: admission.id, encounterVersion: '1', virtualTime: time,
  requests: [{ id: 'request-1', admissionId: admission.id, version: 4, status: 'completed', plannedProcedure: procedure, plannedFor: time, reason: '合成术后核查', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1' }], inProgress: [],
  executions: [{ id: 'execution-1', admissionId: admission.id, requestId: 'request-1', actualProcedure: procedure, performedAt: time, completedAt: time, performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术已完成', materials: [], materialHistory: [] }] })
const review = inpatientDrgReviewSchema.parse({ admissionId: admission.id, taskId: null, version: 1, status: 'complete', fingerprint: 'a'.repeat(64), freezeReason: null,
  summary: { formalDrgCode: null, formalChargesFen: 0, projectedTotalFen: null }, simulation: null, comparisons: [], planBases: [], missing: [], resolvedTodos: [], actions: [], model: null, handedOver: null,
  todos: [{ id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire', kind: 'extra-use', ownerRole: 'inpatient-doctor', display: '合成导丝', materialId: 'wire', plannedQuantity: 1, actualQuantity: 2, procedureDisplay: procedure.coding.display, executionId: 'execution-1', requestId: 'request-1', explanation: '核实合成额外用途', evidence: ['Procedure/execution-1'], target: 'surgery', status: 'pending', reason: null }] })
const clients: QueryClient[] = []
let clientNumber = 0
beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount(readReview: () => Promise<Response>) {
  const currentSession = { ...session, actor: { ...session.actor, practitionerRoleId: `role-postoperative-${++clientNumber}` } }
  const reads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    reads.push(path)
    if (path.endsWith('/drg/review')) return readReview()
    if (path.endsWith('/surgeries')) return Response.json(surgeries)
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '1', diagnosis: { revision: 1, entries: [{ conditionId: 'condition-1', role: 'primary', admissionCondition: '1', ordinal: 1, coding: { id: 'diagnosis-1', code: 'I25.103', display: '合成冠心病', system: 'https://synthetic.example.test/icd', version: '1', sourceLocator: 'synthetic' } }] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0 })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservations: [], reservationSets: [] })
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'male' })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'synthetic-hash', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'run-1', seed: 1, status: 'active', virtualTime: time, workspaceId: 'workspace-demo' })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料暂不可用' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(currentSession, () => undefined)
    return <InpatientPatientWorkspace admission={admission} admissions={[admission]} catalog={undefined} allowTransfers={false} session={currentSession} locale="zh-CN" write={write} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return reads
}

it.each([false, true])('冷缓存读取术后待办再决定默认落点，保留人工选择=%s', async manual => {
  let release = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const reads = mount(async () => { await wait; return Response.json(review) })
  try {
    await waitFor(() => expect(reads.some(path => path.endsWith('/drg/review'))).toBe(true))
    expect(screen.queryByRole('region', { name: '术后核查与责任交接' })).toBeNull()
    if (manual) {
      const user = userEvent.setup(), tab = screen.queryByRole('tab', { name: '检查检验' })
      if (tab) await user.click(tab)
      else { await user.click(screen.getByRole('button', { name: '更多' })); await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /^检查检验/ })) }
    }
    await act(async () => { release(); await wait })
    await waitFor(() => expect(screen.getByRole('tab', { name: '手术', hidden: true }).textContent).toContain('待办 1 项'))
    expect(screen.getByRole('tab', { name: manual ? '检查检验' : '手术', selected: true })).toBeDefined()
    if (!manual) expect(screen.getByText('轮到你：确认术后核查差异')).toBeDefined()
  } finally { release() }
})

it('术后待办读取失败有重试入口，重试成功更新页签待办', async () => {
  let failed = true
  mount(async () => failed ? Response.json({ error: { code: 'UNAVAILABLE', message: '合成术后核查暂不可用' } }, { status: 503 }) : Response.json(review))
  const retry = await screen.findByRole('button', { name: '重试术后核查' })
  failed = false
  await userEvent.setup().click(retry)
  await waitFor(() => expect(screen.getByRole('tab', { name: '手术', hidden: true }).textContent).toContain('待办 1 项'))
  expect(screen.queryByRole('button', { name: '重试术后核查' })).toBeNull()
})
