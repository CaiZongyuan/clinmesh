// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientMaterialEstimateSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionProvider, InpatientActionOutlet } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-13T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '88.5500', display: '用单根导管的冠状动脉造影术', category: '诊断性操作', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } }
const material = { id: 'material-1', version: 1, display: '合成造影导管', chargeDefinition: { id: 'material-price', priceFen: 2000, unit: '根', synthetic: true, trigger: 'execution' } }
const plan = { id: 'request-1', admissionId: admission.id, version: 3, status: 'ready', plannedProcedure: procedure, plannedFor: time, reason: '合成冠脉造影计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1', consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '已核实同意书' }, preopCheck: { actorId: 'nurse', practitionerRoleId: 'role-nurse', recordedAt: time, note: '已核对' } }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount({ consent = true, stale = true, pci = false, changed = false } = {}) {
  const estimate = inpatientMaterialEstimateSchema.parse({ id: 'estimate-1', admissionId: admission.id, requestId: plan.id, version: 1, requestVersion: 3,
    status: stale ? 'stale' : 'succeeded', basisFingerprint: 'a'.repeat(64), failureCode: null, missing: [], candidates: [], analysis: null, candidateItems: [],
    draft: { revision: 1, basisFingerprint: 'b'.repeat(64), analysisId: null, items: [{ materialId: material.id, catalogVersion: 1, quantity: 1, reason: '按造影方案' }], note: '', edited: false, updatedAt: time, updatedBy: 'doctor', confirmedRevision: 1, reservationIds: ['reservation-1'] } })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '1', virtualTime: time, requests: [{ ...plan, plannedProcedure: pci ? { ...procedure, coding: { ...procedure.coding, code: '36.0700' } } : procedure, status: consent ? 'ready' : 'requested', consentConfirmation: consent ? plan.consentConfirmation : undefined }], executions: [], inProgress: [] })
    if (path.endsWith('/surgery-catalog')) return Response.json({ procedures: [procedure], materials: [material] })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservationSets: [], reservations: [{ id: 'reservation-1', admissionId: admission.id, requestId: plan.id, materialId: material.id, materialDisplay: material.display, quantity: 1, catalogVersion: 1, consumedQuantity: 0, priceFen: 2000, status: 'reserved', reason: '按造影方案', createdAt: time }] })
    if (path.endsWith('/pci-selection')) return Response.json({ admissionId: admission.id, confirmation: null, history: [], evidencePackage: { id: 'synthetic-evidence', version: '1', synthetic: true, limitation: '仅合成验证' }, candidates: [], drafts: [{ requestId: plan.id, version: 1, reportId: 'report-1', reportVersion: 1, edited: changed, confirmedSelectionVersion: changed ? null : 1, parameters: { requestId: plan.id, treatmentPlan: '支架置入', targetSite: 'LAD', measurements: [], plannedQuantities: [], approvedMaterialIds: [] } }] })
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [estimate], unprepared: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() { const write = useInpatientWriteIntent(session, () => undefined); return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={admission} session={session} locale="zh-CN" write={write} /><InpatientActionOutlet /></InpatientActionProvider> }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}

it('预留后通用费用依据失效不误报选型变化，重新进入仍可开始手术', async () => {
  mount()
  await screen.findByRole('region', { name: '手术耗材' })
  await screen.findByText(/已为本计划预留/)
  expect(screen.queryByText(/选型已变化/)).toBeNull()
  const action = screen.getByRole('region', { name: '当前操作' })
  expect(within(action).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(false)
})

it('知情同意与开始说明可点选并继续修改，清空后不能提交', async () => {
  mount({ consent: false, stale: false })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '确认已签' }))
  await user.click(screen.getByRole('button', { name: '患者及家属已签署手术知情同意书' }))
  const field = screen.getByRole('textbox', { name: '签署说明' })
  expect(field).toHaveProperty('value', '患者及家属已签署手术知情同意书')
  await user.type(field, '，已核对')
  expect(field).toHaveProperty('value', '患者及家属已签署手术知情同意书，已核对')
  await user.clear(field)
  expect(screen.getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(true)
})

it('预留后真实修改 PCI 选型仍提示再次核对手术耗材', async () => {
  mount({ pci: true, changed: true })
  expect(await screen.findByText(/选型已变化/)).toBeDefined()
  expect(within(screen.getByRole('region', { name: '当前操作' })).getByRole('button', { name: '确认手术耗材' })).toBeDefined()
})

it('开始说明可点选，清空后禁止开始', async () => {
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '开始手术' }))
  const dialog = await screen.findByRole('dialog', { name: '开始手术' })
  await user.click(within(dialog).getByRole('button', { name: '术前准备已完成，按计划开始手术' }))
  const input = within(dialog).getByRole('textbox', { name: '开始说明' })
  expect(input).toHaveProperty('value', '术前准备已完成，按计划开始手术')
  await user.clear(input)
  expect(within(dialog).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(true)
})
