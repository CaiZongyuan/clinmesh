// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema, inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientTabs } from './inpatient-layout.tsx'
import { InpatientNurseBench } from './inpatient-nurse-bench.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('更多菜单展示收起页签的待办摘要，隐藏页签仍保留待办与助手读屏状态', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  render(<InpatientTabs id="inpatient-count-test" locale="zh-CN" value="orders" onValueChange={() => undefined}
    items={[{ value: 'orders', label: '诊断医嘱', count: 2 }, { value: 'investigations', label: '检查检验', count: 1, more: true, assistant: 1 }]}>{null}</InpatientTabs>)
  expect(within(screen.getByRole('tab', { name: '诊断医嘱' })).getByText('2')).toBeDefined()
  const investigations = screen.getByRole('tab', { name: '检查检验', hidden: true })
  expect(within(investigations).getByText('1')).toBeDefined()
  expect(within(investigations).getByText('助手 1')).toBeDefined()
  await userEvent.setup().click(screen.getByRole('button', { name: '更多' }))
  expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /^检查检验/ }).textContent).toContain('待办 1 项')
})

it('护士床位队列以住院状态代替零待办，保留选中患者和空床价格', async () => {
  const session: SessionContext = { actor: { actorId: 'actor-nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' },
    user: { id: 'user-nurse', name: '病区护士', email: 'ward-nurse@demo.clinmesh.local' }, availableRoles: [] }
  const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成床位患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general', bedId: 'bed-1',
    organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', admittedAt: '2026-08-24T09:10:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
  const catalog = inpatientCatalogSchema.parse({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient', acceptingAdmissions: true }], beds: [
    { id: 'bed-1', name: '1床', roomId: 'room-1', wardId: 'ward-general', dailyPriceFen: 5000, admissionId: admission.id }, { id: 'bed-2', name: '2床', roomId: 'room-1', wardId: 'ward-general', dailyPriceFen: 5000 }] })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 0 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' })
    throw new Error(`Unexpected read ${path}`)
  }))
  const select = vi.fn()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientNurseBench admissions={[admission]} selectedId={admission.id} catalog={catalog} session={session} locale="zh-CN" onSelect={select} /></QueryClientProvider>)
  const patient = screen.getByRole('button', { name: '1床 合成床位患者' })
  await waitFor(() => expect(patient.textContent).toContain('在院'))
  expect(patient.getAttribute('aria-current')).toBe('true')
  expect(screen.queryByText('床位与任务')).toBeNull()
  expect(screen.queryByText(/轮到你 0/)).toBeNull()
  expect(screen.queryByText(/2026\/8\/24/)).toBeNull()
  expect(screen.getByText('空床').closest('li')?.textContent).toContain('2床 空床¥50.00/日')
  await userEvent.setup().click(patient)
  expect(select).toHaveBeenCalledWith(admission.id)
})

it('手术页签计入未解决术后核查，确认后保留历史且待办数清零', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const { inpatientStageTabs } = await import('./inpatient-stage-activity.ts')
  const { inpatientDrgReviewSchema } = await import('@clinmesh/contracts/inpatient-drg-review')
  const admission = inpatientAdmissionSchema.parse({ id: 'admission-review', patientId: 'patient-review', patientName: '合成术后患者', inpatientNumber: 'ZY-POST', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-13T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '1' })
  let review = inpatientDrgReviewSchema.parse({ admissionId: admission.id, taskId: null, version: 1, status: 'complete', fingerprint: 'a'.repeat(64), summary: { formalDrgCode: null, formalChargesFen: 0, projectedTotalFen: 0 }, simulation: null, comparisons: [], missing: [], actions: [], model: null, handedOver: null, resolvedTodos: [],
    todos: [1, 2, 3].map(index => ({ id: `todo-${index}`, version: 1, evidenceFingerprint: 'a'.repeat(64), key: `extra-use:${index}`, kind: 'extra-use', ownerRole: 'inpatient-doctor', materialId: `material-${index}`, display: '合成耗材', plannedQuantity: 1, actualQuantity: 2, explanation: '核对额外用量', evidence: ['Procedure/execution-1'], status: index === 3 ? 'dismissed' : 'pending', reason: null })) })
  const content = () => <InpatientTabs id="postoperative-count" locale="zh-CN" value="surgery" onValueChange={() => undefined} items={inpatientStageTabs({ admission, role: 'inpatient-doctor', review }, false, 'zh-CN')}>{null}</InpatientTabs>
  const view = render(content())
  expect(within(screen.getByRole('tab', { name: '手术' })).getByText('2')).toBeDefined()
  review = { ...review, todos: review.todos.map(todo => ({ ...todo, status: 'dismissed', reason: '医生已核对' })) }
  view.rerender(content())
  expect(within(screen.getByRole('tab', { name: '手术' })).queryByText('2')).toBeNull()
})
