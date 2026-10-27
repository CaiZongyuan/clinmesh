// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientPciSelection } from './inpatient-pci-selection.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general',
  organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const initial = { admissionId: admission.id, confirmation: null, history: [], evidencePackage: { id: 'evidence-package', version: 'v1', synthetic: true, limitation: '有限合成仿真，不是真实临床金标准' }, candidates: [] }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount() {
  function Content() { return <InpatientPciSelection admission={admission} session={session} locale="zh-CN" write={useInpatientWriteIntent(session, () => undefined)} /> }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Content /></QueryClientProvider>)
}
it('医生可手工确认治疗方向，未知测量保留空值而不预填耗材规格', async () => {
  const submitted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/confirm')) {
      const { input } = JSON.parse(String(init?.body))
      submitted.push(input)
      return Response.json({ data: { ...initial, confirmation: { id: 'selection-1', version: 1, parameters: input.parameters, confirmedBy: 'actor-doctor', practitionerRoleId: 'role-doctor', confirmedAt: '2026-08-24T09:00:00+08:00' } }, auditId: 'audit-1', effects: [], requestId: 'request-1', warnings: [] })
    }
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/pci-selection')) return Response.json(initial)
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.click(screen.getByText('PCI 选型参数与候选依据'))
  await user.type(await screen.findByRole('textbox', { name: '治疗方向与术式' }), '合成择期PCI计划')
  await user.type(screen.getByRole('textbox', { name: '靶病变部位' }), 'LAD中段')
  expect(screen.getByRole('spinbutton', { name: '病变长度 数值' }).getAttribute('value')).toBe('')
  await user.click(screen.getByRole('button', { name: '确认 PCI 参数' }))
  await vi.waitFor(() => expect(submitted).toEqual([{ expectedVersion: 0, parameters: { treatmentPlan: '合成择期PCI计划', targetSite: 'LAD中段', measurements: [], plannedQuantities: [], approvedMaterialIds: [] } }]))
})


it('只选择本次住院未完成未取消的 PCI 计划，并把requestId随临床参数确认', async () => {
  const submitted: unknown[] = []
  const procedure = { id: 'hospital-surgery-3', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0700', display: '合成PCI计划', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.test/coding', sourceSha256: '0'.repeat(64), sourceLocator: 'test:1' }, chargeDefinition: { id: 'charge-surgery-3', priceFen: 180000, unit: '次', synthetic: true, trigger: 'execution' } }
  const requests = ['requested', 'cancelled', 'completed'].map((status, index) => ({ id: `pci-request-${index}`, admissionId: admission.id, version: 1, status,
    plannedProcedure: procedure, plannedFor: '2026-08-25T09:00:00+08:00', reason: '合成计划', requestedAt: '2026-08-24T09:00:00+08:00', requestedBy: 'doctor', organizationId: 'organization-inpatient' }))
  requests.push({ ...requests[0]!, id: 'non-pci', plannedProcedure: { ...procedure, coding: { ...procedure.coding, code: '47.0100', display: '阑尾切除术' } } })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests, executions: [] })
    if (path.endsWith('/pci-selection')) return Response.json(initial)
    if (path.endsWith('/confirm')) {
      const { input } = JSON.parse(String(init?.body)); submitted.push(input)
      return Response.json({ data: { ...initial, confirmation: { id: 'selection-1', version: 1, parameters: input.parameters, confirmedBy: 'actor-doctor', practitionerRoleId: 'role-doctor', confirmedAt: '2026-08-24T09:00:00+08:00' } }, auditId: 'audit-1', effects: [], requestId: 'request-1', warnings: [] })
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.click(screen.getByText('PCI 选型参数与候选依据'))
  const select = await screen.findByRole('combobox', { name: '关联 PCI 手术计划' })
  select.focus(); await user.keyboard('{Enter}')
  expect(screen.queryByRole('option', { name: /阑尾切除术/ })).toBeNull()
  expect(await screen.findAllByRole('option')).toHaveLength(2)
  await user.click(screen.getByRole('option', { name: /合成PCI计划/ }))
  await user.type(screen.getByRole('textbox', { name: '治疗方向与术式' }), '合成PCI')
  await user.type(screen.getByRole('textbox', { name: '靶病变部位' }), 'LAD')
  await user.click(screen.getByRole('button', { name: '确认 PCI 参数' }))
  await vi.waitFor(() => expect(submitted).toEqual([expect.objectContaining({ parameters: expect.objectContaining({ requestId: 'pci-request-0' }) })]))
})
