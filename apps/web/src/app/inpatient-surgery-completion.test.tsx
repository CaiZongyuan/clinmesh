// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientSurgeryExecutionSchema, inpatientSurgeryRequestSchema, inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { inpatientMaterialReservationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientSurgeryCompletion } from './inpatient-surgery-completion.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T00:00:00Z', depositFen: 0, chargesFen: 0, versionId: '1' })
const charge = { id: 'charge-1', priceFen: 10000, unit: '根', synthetic: true, trigger: 'execution' }
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0600', display: 'PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { ...charge, unit: '次' } }
const request = inpatientSurgeryRequestSchema.parse({ id: 'request-1', admissionId: admission.id, version: 1, status: 'ready', plannedProcedure: procedure, plannedFor: '2026-11-03T00:00:00Z', reason: '合成计划', requestedAt: '2026-11-03T00:00:00Z', requestedBy: 'doctor', organizationId: 'org-1' })
const execution = inpatientSurgeryExecutionSchema.parse({ id: 'execution-1', admissionId: admission.id, requestId: request.id, actualProcedure: procedure, performedAt: '2026-11-03T00:00:00Z', performedBy: 'doctor', practitionerRoleId: 'role-doctor', organizationId: 'org-1', note: '合成手术', materials: [], materialHistory: [] })
const catalog = inpatientSurgeryCatalogSchema.parse({ procedures: [procedure], materials: ['导丝', '球囊'].map((display, index) => ({ id: `material-${index + 1}`, version: 1, display, chargeDefinition: charge })) })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount(overrides: Partial<React.ComponentProps<typeof InpatientSurgeryCompletion>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness({ values }: { values: typeof overrides }) {
    const write = useInpatientWriteIntent(values.session ?? session, () => undefined)
    return <InpatientSurgeryCompletion session={session} admission={admission} active execution={execution} request={request} catalog={catalog} reservations={[]} write={write} locale="zh-CN" refresh={() => Promise.resolve()} {...values} />
  }
  const content = (values: typeof overrides) => <QueryClientProvider client={client}><Harness values={values} /></QueryClientProvider>
  const view = render(content(overrides))
  return { ...view, update: (values: typeof overrides) => view.rerender(content(values)) }
}

it('同一窗口连续加入两种最终耗材，关闭与刷新保留各项数量及核实说明', async () => {
  const user = userEvent.setup(), view = mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  await user.click(screen.getByRole('button', { name: '新增最终耗材' }))
  const picker = screen.getByRole('dialog', { name: '选择最终耗材' })
  await user.click(within(picker).getByRole('button', { name: '加入导丝' }))
  await user.click(within(picker).getByRole('button', { name: '加入球囊' }))
  expect(picker.textContent).toContain('已加入 2 / 100 项')
  await user.click(within(picker).getByRole('button', { name: '完成选择' }))
  const first = screen.getByRole('spinbutton', { name: '导丝 · 最终总量 1' })
  await user.clear(first); await user.type(first, '3')
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '保留两种真实耗材')
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '导丝 · 最终总量 1' }).value).toBe('3')
  view.unmount(); mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '球囊 · 最终总量 2' }).value).toBe('1')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('保留两种真实耗材')
})

it('预览只核实同一整台意图，完成成功后消费原草稿版本', async () => {
  const requests: Array<{ path: string; input: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    const body = JSON.parse(String(init?.body)); requests.push({ path, input: body.input })
    if (path.endsWith('/preview-completion')) return Response.json({ fingerprint: 'a'.repeat(64), materials: [], retainedReservations: [], materialDeltaFen: 20000, procedureAmountFen: 10000, totalDeltaFen: 30000 })
    if (path.endsWith('/complete')) return Response.json({ data: { admissionId: admission.id, encounterVersion: '2', virtualTime: '2026-11-03T00:00:00Z', requests: [request], executions: [execution], inProgress: [] }, effects: [], warnings: [], auditId: 'audit-1', requestId: 'receipt-1' })
    throw new Error(`Unexpected ${path}`)
  }))
  const user = userEvent.setup(); mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  await user.click(screen.getByRole('button', { name: '新增最终耗材' }))
  await user.click(screen.getByRole('button', { name: '加入导丝' })); await user.click(screen.getByRole('button', { name: '加入球囊' }))
  await user.click(screen.getByRole('button', { name: '完成选择' }))
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '两材集中核实')
  await user.click(screen.getByRole('button', { name: '预览本次差额' }))
  await user.click(await screen.findByRole('button', { name: '确认完成手术' }))
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe(''))
  expect(requests.map(value => value.path)).toEqual([`/api/his/v1/inpatient/admissions/${admission.id}/surgeries/preview-completion`, `/api/his/v1/inpatient/admissions/${admission.id}/surgeries/complete`])
  expect(requests[1]!.input).toMatchObject({ reconciliation: { finalMaterials: [
    { materialId: 'material-1', quantity: 1 }, { materialId: 'material-2', quantity: 1 },
  ], releaseReservations: [], expectedFingerprint: 'a'.repeat(64) } })
})

it('存储写入失败保留输入并阻止预览，恢复存储后可明确重试保存', async () => {
  const user = userEvent.setup(); mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic storage unavailable') })
  fireEvent.change(screen.getByRole('textbox', { name: '核实说明' }), { target: { value: '未丢失的核实说明' } })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('未丢失的核实说明')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览本次差额' }).disabled).toBe(true)
  storage.mockRestore()
  await user.click(screen.getByRole('button', { name: '重试保存核实草稿' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览本次差额' }).disabled).toBe(false)
})

it('移除耗材的存储失败保留原行，避免刷新前后出现不同清单', async () => {
  const user = userEvent.setup(); mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  await user.click(screen.getByRole('button', { name: '新增最终耗材' }))
  await user.click(screen.getByRole('button', { name: '加入导丝' }))
  await user.click(screen.getByRole('button', { name: '完成选择' }))
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic removal failure') })
  await user.click(screen.getByRole('button', { name: '移除此新增项 1' }))
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '导丝 · 最终总量 1' }).value).toBe('1')
  expect(screen.getByRole('alert').textContent).toContain('草稿无法保存')
  storage.mockRestore()
  await user.click(screen.getByRole('button', { name: '重试保存核实草稿' }))
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '导丝 · 最终总量 1' }).value).toBe('1')
})

it('并发新增实际使用时保留编辑并标出新增耗材，明确重新带入后才可预览', async () => {
  const user = userEvent.setup(), view = mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '原核实编辑仍保留')
  const use = { id: 'new-use', item: catalog.materials[1]!, quantity: 2, amountFen: 20000 }
  const latest = inpatientSurgeryExecutionSchema.parse({ ...execution, materials: [use], materialHistory: [{ ...use,
    recordedAt: '2026-11-03T00:00:00Z', recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '合成其他窗口新登记', reservationId: null, chargeId: 'charge-2', correction: null }] })
  view.update({ execution: latest })
  expect(screen.getByRole('alert').textContent).toContain('新增实际使用：球囊')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('原核实编辑仍保留')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览本次差额' }).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '清空草稿并重新带入当前用量' }))
  await user.click(screen.getByRole('button', { name: '确认丢弃并重新带入' }))
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '球囊 · 最终总量 1' }).value).toBe('2')
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '重新核实新增用量')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '预览本次差额' }).disabled).toBe(false)
})

it('患者与岗位隔离草稿，清空草稿必须明确确认', async () => {
  const user = userEvent.setup(), view = mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '原患者人工核实')
  view.update({ admission: { ...admission, id: 'admission-2', patientId: 'patient-2' }, execution: { ...execution, id: 'execution-2', admissionId: 'admission-2' }, request: { ...request, id: 'request-2', admissionId: 'admission-2' } })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('')
  view.update({ session: { ...session, actor: { ...session.actor, practitionerRoleId: 'role-other' } } })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('')
  view.update({})
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('原患者人工核实')
  await user.click(screen.getByRole('button', { name: '清空草稿并重新带入当前用量' }))
  await user.click(screen.getByRole('button', { name: '保留草稿' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('原患者人工核实')
  await user.click(screen.getByRole('button', { name: '清空草稿并重新带入当前用量' }))
  const storage = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('synthetic clear failure') })
  await user.click(screen.getByRole('button', { name: '确认丢弃并重新带入' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('清空草稿失败，原内容仍保留')
  storage.mockRestore()
  await user.click(screen.getByRole('button', { name: '确认丢弃并重新带入' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('')
})

it('fresh Session 与当前视图变化阻止已点击的旧核实意图发送', async () => {
  const pending: Array<(response: Response) => void> = []
  let delaySession = false
  const mutations: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return delaySession ? new Promise<Response>(resolve => { pending.push(resolve) }) : Response.json(session)
    mutations.push(path)
    if (path.endsWith('/preview-completion')) return Response.json({ fingerprint: 'a'.repeat(64), materials: [], retainedReservations: [], materialDeltaFen: 0, procedureAmountFen: 10000, totalDeltaFen: 10000 })
    throw new Error(`Unexpected ${path}`)
  }))
  const user = userEvent.setup(), view = mount()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '待当前岗位确认')
  delaySession = true
  await user.click(screen.getByRole('button', { name: '预览本次差额' }))
  await waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()?.(Response.json({ ...session, actor: { ...session.actor, practitionerRoleId: 'other-role' } }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('岗位或业务数据已变化'))
  expect(mutations).toEqual([])
  delaySession = false
  await user.click(screen.getByRole('button', { name: '预览本次差额' }))
  const complete = await screen.findByRole('button', { name: '确认完成手术' })
  delaySession = true
  await user.click(complete)
  await waitFor(() => expect(pending).toHaveLength(1))
  view.update({ active: false })
  pending.shift()?.(Response.json(session))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '核实最终耗材并完成手术' })).toBeNull())
  expect(mutations).toEqual([`/api/his/v1/inpatient/admissions/${admission.id}/surgeries/preview-completion`])
})

it('同一预留跨冻结行按合计最终量判断全选，清空释放选择保留数量和说明', async () => {
  const item = catalog.materials[0]!
  const firstReservation = inpatientMaterialReservationSchema.parse({ id: 'reservation-1', admissionId: admission.id, requestId: request.id,
    version: 3, materialId: item.id, materialDisplay: item.display, catalogVersion: 1, quantity: 3, consumedQuantity: 2,
    remainingQuantity: 1, unit: '根', priceFen: 10000, reason: '合成导丝预留', status: 'reserved', createdAt: '2026-11-03T00:00:00Z' })
  const secondReservation = inpatientMaterialReservationSchema.parse({ ...firstReservation, id: 'reservation-2', materialId: 'material-2', materialDisplay: '球囊', quantity: 2,
    consumedQuantity: 0, remainingQuantity: 2, reason: '合成球囊预留' })
  const uses = [1, 2].map(index => ({ id: `use-${index}`, item: { ...item, chargeDefinition: { ...charge, id: `charge-${index}` } }, quantity: 1, amountFen: 10000,
    recordedAt: '2026-11-03T00:00:00Z', recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '合成使用', reservationId: firstReservation.id, chargeId: `charge-${index}`, correction: null }))
  const currentExecution = inpatientSurgeryExecutionSchema.parse({ ...execution, materials: uses.map(({ id, item, quantity, amountFen }) => ({ id, item, quantity, amountFen })), materialHistory: uses })
  mount({ execution: currentExecution, reservations: [firstReservation, secondReservation] })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '核实最终耗材并完成手术' }))
  for (const name of ['导丝 · 最终总量 1', '导丝 · 最终总量 2']) {
    const input = screen.getByRole('spinbutton', { name }); await user.clear(input); await user.type(input, '2')
  }
  await user.type(screen.getByRole('textbox', { name: '核实说明' }), '合计核实两个冻结来源')
  await user.click(screen.getByRole('button', { name: '全选当前页可释放预留' }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /释放剩余预留 · 导丝/ }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /释放剩余预留 · 球囊/ }).getAttribute('aria-checked')).toBe('true')
  const first = screen.getByRole('spinbutton', { name: '导丝 · 最终总量 1' }); await user.clear(first); await user.type(first, '0')
  await user.click(screen.getByRole('button', { name: '全选当前页可释放预留' }))
  expect(screen.getByRole('group', { name: '剩余预留释放' }).textContent).toContain('已选释放 2 / 100 项')
  await user.click(screen.getByRole('button', { name: '清空释放选择' }))
  expect(screen.getByRole('group', { name: '剩余预留释放' }).textContent).toContain('已选释放 0 / 100 项')
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '导丝 · 最终总量 1' }).value).toBe('0')
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '导丝 · 最终总量 2' }).value).toBe('2')
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '核实说明' }).value).toBe('合计核实两个冻结来源')
})
