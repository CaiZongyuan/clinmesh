// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgeryMaterials } from './inpatient-surgery-materials.tsx'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T00:00:00Z', depositFen: 0, chargesFen: 0, versionId: '1' })
const charge = { id: 'charge-1', priceFen: 10000, unit: '根', synthetic: true, trigger: 'execution' }
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0600', display: 'PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { ...charge, unit: '次' } }
const request = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 1, status: 'completed', plannedProcedure: procedure, plannedFor: '2026-11-03T00:00:00Z', reason: '合成计划', requestedAt: '2026-11-03T00:00:00Z', requestedBy: 'doctor', organizationId: 'org-1' })
const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: admission.id, requestId: request.id, actualProcedure: procedure, performedAt: '2026-11-03T00:00:00Z', performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术', materials: [{ id: 'use-1', item: { id: 'wire', version: 1, display: '导丝', chargeDefinition: charge }, quantity: 2, amountFen: 20000 }], materialHistory: [{ id: 'use-1', item: { id: 'wire', version: 1, display: '导丝', chargeDefinition: charge }, quantity: 2, amountFen: 20000, recordedAt: '2026-11-03T00:00:00Z', recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '初次记录', reservationId: null, chargeId: 'charge-1', correction: null }] })
const usage = { requestId: request.id, executionId: execution.id, procedureDisplay: 'PCI', materialId: 'wire', catalogVersion: 1, display: '导丝', unit: '根', plannedQuantity: 1, actualQuantity: 2, remainingQuantity: 0, unplanned: false, excessQuantity: 1, usedFen: 20000, additionalFen: 10000 }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('实际更正命令成功后同一登记区刷新规则费用板，不产生模型命令', async () => {
  let current = usage
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/drg/agent')) return Response.json({ admissionId: admission.id, taskId: null, status: 'inactive', basisFingerprint: null, stage: null, missing: [], failureCode: null, costs: null, usage: [current], analysis: null, confirmedPlan: null, planHistory: [] })
    if (path.endsWith('/drg/record-checks')) return Response.json({ admissionId: admission.id, admissionVersion: '1', encounterVersion: '1', fingerprint: 'a'.repeat(64), status: 'complete', simulation: null, issues: [], sources: [], paymentStatus: 'grouping-incomplete', paymentMessage: '分组尚未完成', missing: [] })
    if (init?.method === 'POST') {
      posts.push(path)
      expect(JSON.parse(String(init.body)).input).toMatchObject({ executionId: execution.id, materialUseId: 'use-1', note: '更正误记的导丝用量' })
      current = { ...usage, actualQuantity: 0, remainingQuantity: 1, excessQuantity: 0, usedFen: 0, additionalFen: 0 }
      return Response.json({ data: { admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-11-03T00:00:00Z', requests: [request], executions: [{ ...execution, materials: [], materialHistory: [] }], inProgress: [] }, auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness({ currentExecution }: { currentExecution: typeof execution }) {
    const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="surgery"><InpatientSurgeryMaterials admission={admission} session={session} locale="zh-CN" write={write} execution={currentExecution} request={request} catalog={undefined} reservations={[]} dataReady={false} running refresh={() => Promise.resolve()} /><InpatientActionOutlet /></InpatientActionProvider>
  }
  const view = render(<QueryClientProvider client={client}><Harness currentExecution={execution} /></QueryClientProvider>)
  const panel = await screen.findByRole('region', { name: '本台耗材' })
  const row = await within(panel).findByRole('row', { name: /导丝/ })
  expect(panel.textContent).toContain('已登记耗材 ¥200.00')
  expect(panel.textContent).toContain('术式费 ¥100.00 在完成手术时计入')
  const user = userEvent.setup()
  await user.click(within(row).getByRole('button', { name: /更正/ }))
  await user.type(screen.getByRole('textbox', { name: '更正依据' }), '更正误记的导丝用量')
  await user.click(screen.getByRole('button', { name: '确认更正' }))
  await waitFor(() => expect(posts).toEqual([`/api/his/v1/inpatient/admissions/${admission.id}/surgeries/correct-material`]))
  view.rerender(<QueryClientProvider client={client}><Harness currentExecution={{ ...execution, materials: [], materialHistory: [] }} /></QueryClientProvider>)
  expect(panel.textContent).toContain('已登记耗材 ¥0.00')
})
