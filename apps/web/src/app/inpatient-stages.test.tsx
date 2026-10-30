// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientWorkspace } from './inpatient-workspace.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' },
  user: { id: 'user-doctor', name: '住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [],
}
const admission = { id: 'admission-1', patientId: 'patient-1', patientName: '李淑芬', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', bedId: 'bed-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', admittedAt: '2026-08-24T09:10:00+08:00', depositFen: 100000, chargesFen: 5000, versionId: '2' }
const catalog = { wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient', acceptingAdmissions: true }], beds: [{ id: 'bed-1', name: '1床', roomId: 'room-1', wardId: 'ward-general', dailyPriceFen: 5000, admissionId: admission.id }] }
const scenarioState = { clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' }
function mount(activeSession: SessionContext = session) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><InpatientWorkspace session={activeSession} locale="zh-CN" /></QueryClientProvider>)
}
beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('患者横幅常驻，阶段只显示当前业务表单，切换后保留原输入且未访问病案不发请求', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    paths.push(path)
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [admission] })
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 5000 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-08-24T09:00:00+08:00', requests: [], executions: [] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female', birthDate: '1980-01-01' })
    if (path.endsWith('/discharge')) return Response.json({ admissionId: admission.id, events: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const banner = screen.getByRole('region', { name: '当前住院患者' })
  expect(banner.textContent).toContain('ZY-0001')
  expect(banner.textContent).toContain('住院病区')
  expect(banner.textContent).toContain('1床')
  expect(banner.textContent).toContain('50.00')
  await waitFor(() => expect(banner.textContent).toContain('住院第 1 天'))
  expect(within(screen.getByRole('list', { name: '办理流程' })).getByRole('listitem', { current: 'step' }).textContent).toBe('在院诊疗')
  expect(screen.getByRole('tab', { name: '诊断医嘱', selected: true })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '更多' }))
  expect(await screen.findByRole('tab', { name: '检查检验 · 未发生' })).toBeDefined()
  await screen.findByLabelText('医嘱项目')
  expect(screen.queryByRole('textbox', { name: '出院处理说明' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: '计划术式' })).toBeNull()
  expect(paths.some(path => path.endsWith('/record'))).toBe(false)
  await user.type(screen.getByLabelText('停嘱或按需执行理由'), '保留原停嘱说明')
  await user.click(screen.getByRole('tab', { name: "出院" }))
  expect(within(banner).getByText('李淑芬', { exact: true })).toBeDefined()
  expect(screen.queryByRole('combobox', { name: '医嘱项目' })).toBeNull()
  expect(screen.getByText('住院医生开出院医嘱')).toBeDefined()
  expect(screen.getByText('病区护士办理出院')).toBeDefined()
  expect(screen.getByText('收费员结算')).toBeDefined()
  await user.type(screen.getByLabelText('出院处理说明'), '治疗完成，等待原住院确认')
  await user.click(screen.getByRole('tab', { name: '诊断医嘱' }))
  expect((screen.getByLabelText('停嘱或按需执行理由') as HTMLInputElement).value).toBe('保留原停嘱说明')
  await user.click(screen.getByRole('tab', { name: "出院" }))
  expect((screen.getByLabelText('出院处理说明') as HTMLInputElement).value).toBe('治疗完成，等待原住院确认')
  expect(screen.queryByRole('tab', { name: '转科交接' })).toBeNull()
})

it('流程线随住院状态进入办理出院，同时保留可读业务分区', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'discharge-pending' }] })
    if (path.endsWith('/scenario-runs/current')) return Response.json(scenarioState)
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/clinical')) return Response.json({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [], executions: [], dispenses: [], charges: [], chargesFen: 5000 })
    if (path.endsWith('/surgeries')) return Response.json({ admissionId: admission.id, encounterVersion: '2', virtualTime: scenarioState.virtualTime, requests: [], executions: [] })
    if (path.endsWith('/investigations')) return Response.json({ admissionId: admission.id, laboratoryRequests: [], imagingRequests: [], sent: [] })
    if (path.endsWith('/discharge')) return Response.json({ admissionId: admission.id, events: [] })
    if (path.endsWith('/Patient/patient-1')) return Response.json({ resourceType: 'Patient', id: admission.patientId, gender: 'female' })
    throw new Error(`Unexpected read ${path}`)
  }))
  mount()
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const flow = screen.getByRole('list', { name: '办理流程' })
  expect(within(flow).getByRole('listitem', { current: 'step' }).textContent).toBe('办理出院')
  expect(screen.getByRole('region', { name: '当前住院患者' }).textContent).toContain('待出院')
  const more = screen.queryByRole('button', { name: '更多' })
  if (more) await userEvent.setup().click(more)
  expect(screen.getByRole('tab', { name: '诊断医嘱' })).toBeDefined()
  expect(await screen.findByRole('tab', { name: '检查检验 · 未发生' })).toBeDefined()
  expect(screen.getByRole('tab', { name: '手术 · 未发生' })).toBeDefined()
  expect(screen.getByRole('tab', { name: '出院' })).toBeDefined()
  expect(screen.getByRole('tab', { name: '病案' })).toBeDefined()
})

it('药师选中患者后保留窄住院上下文，显示发药后交接给护士的办理位置', async () => {
  const pharmacyAdmission = { admissionId: admission.id, patientId: admission.patientId, patientName: admission.patientName, inpatientNumber: admission.inpatientNumber, wardId: admission.wardId, status: 'admitted' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: [pharmacyAdmission] })
    if (path.endsWith('/pharmacy')) return Response.json({ admission: pharmacyAdmission, orders: [], executions: [], dispenses: [], medications: [], medicationAllergies: [] })
    throw new Error(`Unexpected pharmacy read ${path}`)
  }))
  const { InpatientPharmacy } = await import('./inpatient-pharmacy.tsx')
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InpatientPharmacy session={{ ...session, actor: { ...session.actor, roleCode: 'pharmacist' } }} locale="zh-CN" /></QueryClientProvider>)
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  const banner = await screen.findByRole('region', { name: '当前住院患者' })
  expect(banner.textContent).toContain('ZY-0001')
  expect(screen.getByText('护士校对 → 药师发药 → 护士给药')).toBeDefined()
  expect(screen.queryByRole('button', { name: '给药' })).toBeNull()
})


it('登记员只显示登记入口和流程，不提供其他岗位空壳或读取临床数据', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    paths.push(path)
    if (path.endsWith('/inpatient/catalog')) return Response.json(catalog)
    if (path.endsWith('/inpatient/transfer-catalog')) return Response.json({ wards: [{ id: 'ward-general', name: '住院病区', organizationId: 'organization-inpatient' }], beds: [] })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [{ ...admission, status: 'registered', bedId: undefined }] })
    if (path.endsWith('/inpatient/referrals')) return Response.json({ items: [] })
    throw new Error(`Unexpected registrar read ${path}`)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'registrar' } })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '查看李淑芬' }))
  expect(screen.getByRole('heading', { name: admission.patientName })).toBeDefined()
  expect(within(screen.getByRole('table')).getByRole('cell', { name: '待入科' })).toBeDefined()
  expect(screen.getByRole('list', { name: '办理流程' }).textContent).toContain('入科分床')
  expect(screen.queryByRole('tab', { name: '诊断医嘱', hidden: true })).toBeNull()
  expect(screen.queryByRole('tab', { name: '手术', hidden: true })).toBeNull()
  expect(screen.queryByRole('button', { name: "开立医嘱" })).toBeNull()
  expect(paths.some(path => path.includes('/clinical') || path.includes('/auth/role'))).toBe(false)
})

it('目录暂不可读时不把已知占床住院错误显示为未分床', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/inpatient/catalog')) return Response.json({ error: { code: 'UNAVAILABLE', message: 'synthetic catalog unavailable' } }, { status: 503 })
    if (path.endsWith('/inpatient/admissions')) return Response.json({ items: [admission] })
    if (path.endsWith('/inpatient/referrals')) return Response.json({ items: [] })
    throw new Error(`Unexpected registrar read ${path}`)
  }))
  mount({ ...session, actor: { ...session.actor, roleCode: 'registrar' } })
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看李淑芬' }))
  expect(screen.getByRole('heading', { name: admission.patientName })).toBeDefined()
  expect(within(screen.getByRole('table')).getByRole('cell', { name: '在院' })).toBeDefined()
  expect(screen.getByRole('alert').textContent).toContain('病区目录读取失败')
  expect(document.body.textContent).not.toContain('未分床')
})
