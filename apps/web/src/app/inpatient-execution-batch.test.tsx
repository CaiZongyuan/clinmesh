// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema, inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' }, user: { id: 'nurse', name: '合成护士', email: 'nurse@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-1', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const first = inpatientOrderSchema.parse({ id: 'order-1', admissionId: admission.id, kind: 'medication', duration: 'temporary', catalogItemId: 'medicine-1', catalogVersion: 1, display: '合成给药一', doseText: '5mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 2, requestVersion: '2', signedAt: '2026-08-24T09:00:00+08:00', signedBy: 'doctor-1', organizationId: 'organization-inpatient' })
const second = { ...first, id: 'order-2', display: '合成给药二' }
const facts = inpatientFullClinicalSchema.parse({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [first, second], executions: [first, second].map((order, index) => ({ id: `execution-${index + 1}`, orderId: order.id, scheduledFor: '2026-08-24T09:00:00+08:00', status: 'dispensed', version: 2 })), dispenses: [first, second].map((order, index) => ({ id: `dispense-${index + 1}`, executionId: `execution-${index + 1}`, lotId: 'lot-1', quantity: order.doseQuantity, dispensedAt: '2026-08-24T09:00:00+08:00', dispensedBy: 'pharmacist' })), charges: [], chargesFen: 0 })
const clients: QueryClient[] = []
function mount(initial = facts) {
  let clinical = initial
  const writes: Array<{ path: string; key: string | null; input: Record<string, unknown> }> = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (init?.method === 'POST') {
      const { input } = JSON.parse(String(init.body))
      writes.push({ path, key: new Headers(init.headers).get('idempotency-key'), input })
      const execution = clinical.executions.find(item => item.id === input.executionId)!
      clinical = inpatientFullClinicalSchema.parse({ ...clinical, executions: clinical.executions.map(item => item.id === execution.id ? { ...item, status: 'completed', version: item.version + 1, administrationId: `administration-${item.id}` } : item) })
      return Response.json({ auditId: 'audit-1', requestId: 'request-1', warnings: [], effects: [{ kind: 'created', reference: `MedicationAdministration/administration-${execution.id}`, versionId: '1' }, { kind: 'updated', reference: `Task/${execution.id}`, versionId: String(execution.version + 1) }], data: clinical })
    }
    if (path.endsWith('/clinical')) return Response.json(clinical)
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' })
    throw new Error(`Unexpected read ${path}`)
  }))
  function Subject() { const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] })); return <InpatientClinical admission={admission} session={session} locale="zh-CN" write={write} /> }
  return { ...render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>), writes }
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('护士逐项核实实际给药后才能选择，两项独立原命令保存且不保留旧单项入口', async () => {
  const mounted = mount(), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录给药' }))
  const dialog = screen.getByRole('dialog', { name: '集中记录给药' })
  expect(within(dialog).queryByRole('button', { name: /全选/ })).toBeNull()
  for (const order of [first, second]) {
    const selection = within(dialog).getByRole('checkbox', { name: `选择给药：${order.display}` })
    expect(selection.getAttribute('aria-disabled')).toBe('true')
    expect(selection.getAttribute('aria-checked')).toBe('false')
    await user.click(within(dialog).getByRole('checkbox', { name: `已核实实际给药：${order.display}` }))
    await user.click(selection)
  }
  expect(mounted.writes).toEqual([])
  await user.click(within(dialog).getByRole('button', { name: '核对给药记录 (2)' }))
  expect(within(dialog).getByText('合成给药一')).toBeTruthy()
  expect(within(dialog).getByText('合成给药二')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '确认保存给药记录' }))
  await waitFor(() => expect(mounted.writes).toHaveLength(2))
  await waitFor(() => expect(within(dialog).getByText(/成功 2\/2/)).toBeTruthy())
  expect(mounted.writes.map(item => item.input)).toEqual([{ executionId: 'execution-1', expectedExecutionVersion: 2 }, { executionId: 'execution-2', expectedExecutionVersion: 2 }])
  expect(new Set(mounted.writes.map(item => item.key)).size).toBe(2)
  expect(screen.queryByRole('button', { name: '确认给药' })).toBeNull()
})
