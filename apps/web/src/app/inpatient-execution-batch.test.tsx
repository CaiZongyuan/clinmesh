// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalResponseSchema, inpatientFullClinicalSchema, inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientClinical } from './inpatient-clinical.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const session: SessionContext = { actor: { actorId: 'nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' }, user: { id: 'nurse', name: '合成护士', email: 'nurse@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-1', admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
const first = inpatientOrderSchema.parse({ id: 'order-1', admissionId: admission.id, kind: 'medication', duration: 'temporary', catalogItemId: 'medicine-1', catalogVersion: 1, display: '合成给药一', doseText: '5mg', doseQuantity: 1, unit: '片', frequencyCode: 'QD', state: 'verified', version: 2, requestVersion: '2', signedAt: '2026-08-24T09:00:00+08:00', signedBy: 'doctor-1', organizationId: 'organization-inpatient' })
const second = { ...first, id: 'order-2', display: '合成给药二' }
const facts = inpatientFullClinicalSchema.parse({ admissionId: admission.id, encounterVersion: '2', diagnosis: { revision: 0, entries: [] }, orders: [first, second], executions: [first, second].map((order, index) => ({ id: `execution-${index + 1}`, orderId: order.id, scheduledFor: '2026-08-24T09:00:00+08:00', status: 'dispensed', version: 2 })), dispenses: [first, second].map((order, index) => ({ id: `dispense-${index + 1}`, executionId: `execution-${index + 1}`, lotId: 'lot-1', quantity: order.doseQuantity, dispensedAt: '2026-08-24T09:00:00+08:00', dispensedBy: 'pharmacist' })), charges: [], chargesFen: 0 })
const education = inpatientFullClinicalSchema.parse({ ...facts, orders: [first, second].map(order => ({ ...order, kind: 'service', display: `合成教育${order.id}`, catalogItemId: 'service-education', doseText: '1次', unit: '次' })), executions: facts.executions.map(execution => ({ ...execution, status: 'pending', version: 1 })), dispenses: [] })
const prn = inpatientFullClinicalSchema.parse({ ...facts, orders: [first, second].map(order => ({ ...order, duration: 'long', frequencyCode: 'PRN', display: `合成PRN${order.id}` })), executions: [], dispenses: [] })
const clients: QueryClient[] = []
function mount(initial = facts, options: { admission?: InpatientAdmission; locale?: WorkspaceLocale; beforeRequest?: (path: string) => Promise<Response | undefined>; afterMutation?: (path: string, response: unknown) => void } = {}) {
  let clinical = initial
  const writes: Array<{ path: string; key: string | null; input: Record<string, unknown> }> = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const overridden = await options.beforeRequest?.(path)
    if (overridden) return overridden
    if (path === '/api/auth/context') return Response.json(session)
    if (init?.method === 'POST') {
      const { input } = JSON.parse(String(init.body))
      writes.push({ path, key: new Headers(init.headers).get('idempotency-key'), input })
      const execution = clinical.executions.find(item => item.id === input.executionId)
      const effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> = []
      if (path.endsWith('/request-prn')) {
        const id = `prn-${input.orderId}`
        clinical = inpatientFullClinicalSchema.parse({ ...clinical, executions: [...clinical.executions, { id, orderId: input.orderId, scheduledFor: '2026-08-24T15:00:00+08:00', status: 'pending', version: 1, reason: input.reason }] })
        effects.push({ kind: 'created', reference: `Task/${id}`, versionId: '1' })
      } else if (execution) {
        const administer = path.endsWith('/administer')
        clinical = inpatientFullClinicalSchema.parse({ ...clinical, executions: clinical.executions.map(item => item.id === execution.id ? { ...item, status: 'completed', version: item.version + 1, ...(administer ? { administrationId: `administration-${item.id}` } : {}) } : item),
          charges: administer ? clinical.charges : [...clinical.charges, { id: `charge-${execution.id}`, label: '合成教育', kind: 'service', sourceId: execution.id, organizationId: 'organization-inpatient', serviceDate: '2026-08-24', amountFen: 3000, virtualTime: '2026-08-24T15:00:00+08:00', version: 1 }], chargesFen: administer ? clinical.chargesFen : clinical.chargesFen + 3000 })
        effects.push({ kind: 'created', reference: administer ? `MedicationAdministration/administration-${execution.id}` : `ChargeItem/charge-${execution.id}`, versionId: '1' }, { kind: 'updated', reference: `Task/${execution.id}`, versionId: String(execution.version + 1) })
      }
      const response = { auditId: 'audit-1', requestId: 'request-1', warnings: [], effects, data: clinical }
      options.afterMutation?.(path, response)
      return Response.json(response)
    }
    if (path.endsWith('/clinical')) return Response.json(clinical)
    if (path.endsWith('/clinical-catalog')) return Response.json({ diagnoses: [], medications: [], services: [] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'hash-1', kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'run-1', seed: 1, status: 'active', virtualTime: '2026-08-24T15:00:00+08:00', workspaceId: 'workspace-demo' })
    throw new Error(`Unexpected read ${path}`)
  }))
  function Subject({ active = true }: { active?: boolean }) { const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] })); return <InpatientClinical admission={options.admission ?? admission} session={session} locale={options.locale ?? 'zh-CN'} write={write} active={active} /> }
  const rendered = render(<QueryClientProvider client={client}><Subject /></QueryClientProvider>)
  return { ...rendered, writes, changeActive: (active: boolean) => rendered.rerender(<QueryClientProvider client={client}><Subject active={active} /></QueryClientProvider>), refresh: async (next: typeof facts) => { clinical = next; await client.invalidateQueries({ queryKey: ['inpatient'] }) } }
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it.each([
  { status: 'discharge-pending', recordStatus: 'open' },
  { status: 'departed', recordStatus: 'open' },
  { status: 'cleared', recordStatus: 'open' },
  { status: 'cleared', recordStatus: 'archived' },
] as const)('共享意图缺失且患者$status/$recordStatus时仍可查询原回执，不开放新执行', async change => {
  let receipt: unknown
  const original = mount(education, { afterMutation: (_path, response) => { receipt = response; throw new TypeError('合成响应丢失') } }), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  let dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  for (const order of education.orders) {
    await user.click(within(dialog).getByRole('checkbox', { name: `已核实实际教育：${order.display}` }))
    await user.click(within(dialog).getByRole('checkbox', { name: `选择教育：${order.display}` }))
  }
  await user.click(within(dialog).getByRole('button', { name: '核对教育记录 (2)' }))
  await user.click(within(dialog).getByRole('button', { name: '确认保存教育记录' }))
  await within(dialog).findByText(/原结果待查明/)
  expect(original.writes).toHaveLength(1)
  const originalKey = original.writes[0]!.key
  sessionStorage.removeItem(Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-intent:'))!)
  original.unmount()
  const receipts: string[] = []
  const restored = mount(inpatientFullClinicalResponseSchema.parse(receipt).data, { admission: { ...admission, ...change }, beforeRequest: async path => {
    if (!path.includes('/command-receipts?')) return undefined
    const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!; receipts.push(key)
    return Response.json({ operationId: 'inpatient.execution.complete', idempotencyKey: key, status: 'completed', response: receipt })
  } })
  await screen.findByRole('button', { name: '集中记录健康教育' })
  restored.changeActive(false)
  expect(screen.getByRole('button', { name: '集中记录健康教育' }).hasAttribute('disabled')).toBe(true)
  restored.changeActive(true)
  const trigger = screen.getByRole('button', { name: '集中记录健康教育' })
  expect(trigger.hasAttribute('disabled')).toBe(false)
  await user.click(trigger)
  dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  expect(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-2' }).getAttribute('aria-disabled')).toBe('true')
  expect(within(dialog).getByRole('button', { name: '核对教育记录 (2)' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '恢复原教育结果' }))
  await waitFor(() => expect(within(dialog).getByText('逐项结果 · 成功 1/2')).toBeTruthy())
  expect(receipts).toEqual([originalKey])
  expect(restored.writes).toEqual([])
  expect(within(dialog).getByText(/尚未发送，需重新核对/)).toBeTruthy()
})

it.each((['zh-CN', 'en-US'] as const).flatMap(locale => [
  { code: 'INPATIENT_EXECUTION_CONFLICT', expected: locale === 'zh-CN' ? '请核对医嘱校对、发药和执行时间，并刷新执行单。' : 'Check order verification, dispensing and due time, then refresh the execution.' },
  { code: 'INPATIENT_DISPENSE_CONFLICT', expected: locale === 'zh-CN' ? '发药数量须等于本次执行所需片数，批次不能重复。' : 'The selected lots must be unique and total the quantity required for this execution.' },
  { code: 'ROLE_NOT_ALLOWED', expected: locale === 'zh-CN' ? '请切换到有权限的岗位后重试。' : 'Switch to an authorized role and try again.' },
  { code: 'UNCLASSIFIED_SYNTHETIC_ERROR', expected: locale === 'zh-CN' ? '服务暂时无法完成请求，请稍后重试。' : 'The service cannot complete the request right now. Try again later.' },
].map(example => ({ ...example, locale }))))('逐项失败只以受控错误码生成具体反馈，忽略服务端原文：$locale $code', async ({ locale, code, expected }) => {
  const rawMessage = '合成内部异常原文 RAW_INTERNAL_FAILURE'
  mount(facts, { locale, beforeRequest: async path => path.endsWith('/administer') ? Response.json({ error: { code, message: rawMessage } }, { status: code === 'ROLE_NOT_ALLOWED' ? 403 : code === 'UNCLASSIFIED_SYNTHETIC_ERROR' ? 422 : 409 }) : undefined })
  const user = userEvent.setup(), zh = locale === 'zh-CN'
  const title = zh ? '集中记录给药' : 'Record administrations'
  await user.click(await screen.findByRole('button', { name: title }))
  const dialog = screen.getByRole('dialog', { name: title })
  await user.click(within(dialog).getByRole('checkbox', { name: zh ? `已核实实际给药：${first.display}` : `Verified actual administration: ${first.display}` }))
  await user.click(within(dialog).getByRole('checkbox', { name: zh ? `选择给药：${first.display}` : `Select administration: ${first.display}` }))
  await user.click(within(dialog).getByRole('button', { name: zh ? '核对给药记录 (1)' : 'Review administration records (1)' }))
  await user.click(within(dialog).getByRole('button', { name: zh ? '确认保存给药记录' : 'Save administration records' }))
  const results = await within(dialog).findByRole('region', { name: zh ? '给药逐项结果' : 'Administration results' })
  await waitFor(() => expect(results.textContent).toContain(expected))
  expect(results.textContent).not.toContain(rawMessage)
  expect(results.textContent).toContain(zh ? '输入保留，请重新核实。' : 'input retained. Verify again.')
})

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

it('教育必须逐项核实，两项记录用原complete保存且与给药清单隔离', async () => {
  const mounted = mount(education), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  const dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  for (const order of education.orders) {
    expect(within(dialog).getByRole('checkbox', { name: `选择教育：${order.display}` }).getAttribute('aria-disabled')).toBe('true')
    await user.click(within(dialog).getByRole('checkbox', { name: `已核实实际教育：${order.display}` }))
    await user.click(within(dialog).getByRole('checkbox', { name: `选择教育：${order.display}` }))
  }
  await user.click(within(dialog).getByRole('button', { name: '核对教育记录 (2)' }))
  await user.click(within(dialog).getByRole('button', { name: '确认保存教育记录' }))
  await waitFor(() => expect(within(dialog).getByText('逐项结果 · 成功 2/2')).toBeTruthy())
  expect(mounted.writes.map(write => write.path)).toEqual(['/api/his/v1/inpatient/admissions/admission-1/executions/complete', '/api/his/v1/inpatient/admissions/admission-1/executions/complete'])
  await user.click(within(dialog).getByRole('button', { name: '关闭办理窗口' }))
  await user.click(screen.getByRole('button', { name: '集中记录给药' }))
  expect(within(screen.getByRole('dialog', { name: '集中记录给药' })).getByText('待办清单 0/20 · 已选 0')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '完成健康教育' })).toBeNull()
})

it('PRN以共同理由和逐项覆盖分别发起，显式空覆盖阻止提交且不生成给药记录', async () => {
  const mounted = mount(prn), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中发起 PRN' }))
  const dialog = screen.getByRole('dialog', { name: '集中发起 PRN' })
  for (const order of prn.orders) await user.click(within(dialog).getByRole('checkbox', { name: `选择PRN：${order.display}` }))
  await user.type(within(dialog).getByRole('textbox', { name: 'PRN共同理由' }), '合成共同理由')
  const secondDraft = within(dialog).getByRole('article', { name: '待办项目：order-2' })
  await user.click(within(secondDraft).getByRole('button', { name: '单独填写理由' }))
  expect(within(dialog).getByRole('button', { name: '核对 PRN 发起 (2)' }).hasAttribute('disabled')).toBe(true)
  await user.type(within(secondDraft).getByRole('textbox', { name: '单项 PRN 理由：合成PRNorder-2' }), '合成第二项理由')
  await user.click(within(dialog).getByRole('button', { name: '核对 PRN 发起 (2)' }))
  expect(within(dialog).getByText('最终理由：合成共同理由')).toBeTruthy()
  expect(within(dialog).getByText('最终理由：合成第二项理由')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '确认发起 PRN' }))
  await waitFor(() => expect(within(dialog).getByText('逐项结果 · 成功 2/2')).toBeTruthy())
  expect(mounted.writes.map(write => write.input)).toEqual([{ orderId: 'order-1', expectedOrderVersion: 2, reason: '合成共同理由' }, { orderId: 'order-2', expectedOrderVersion: 2, reason: '合成第二项理由' }])
  expect(within(dialog).getAllByText(/已发起，仍待执行/)).toHaveLength(2)
  expect(screen.queryByRole('button', { name: '按需给药' })).toBeNull()
})

it('恢复期间切离页签，不因回执不存在而在非活动页签重发原执行', async () => {
  let holdAuth = false, release: () => void = () => undefined, authReads = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const mounted = mount(education, { beforeRequest: async path => {
    if (path === '/api/auth/context' && holdAuth) { authReads += 1; await held; return Response.json(session) }
    if (path.includes('/command-receipts?')) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成无回执' } }, { status: 404 })
    return undefined
  }, afterMutation: () => { throw new TypeError('合成响应丢失') } }), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  const dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  await user.click(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-1' }))
  await user.click(within(dialog).getByRole('checkbox', { name: '选择教育：合成教育order-1' }))
  await user.click(within(dialog).getByRole('button', { name: '核对教育记录 (1)' }))
  await user.click(within(dialog).getByRole('button', { name: '确认保存教育记录' }))
  await screen.findByRole('button', { name: '恢复原教育结果' })
  holdAuth = true
  await user.click(within(dialog).getByRole('button', { name: '恢复原教育结果' }))
  await waitFor(() => expect(authReads).toBe(1))
  mounted.changeActive(false)
  release()
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '关闭办理窗口' }).hasAttribute('disabled')).toBe(false))
  expect(mounted.writes).toHaveLength(1)
  expect(within(dialog).getByText(/原结果待查明/)).toBeTruthy()
})

it('执行时间读取失败明确提示并允许重试，未加载时不能核实或保存', async () => {
  let failClock = true
  mount(education, { beforeRequest: async path => path.endsWith('/scenario-runs/current') && failClock ? Response.json({ error: { code: 'UNAVAILABLE', message: '合成执行时间暂不可读' } }, { status: 503 }) : undefined })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  const dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  expect(await within(dialog).findByText(/执行记录或执行时间读取失败/)).toBeTruthy()
  expect(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-1' }).getAttribute('aria-disabled')).toBe('true')
  failClock = false
  await user.click(within(dialog).getByRole('button', { name: '重试执行记录' }))
  await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-1' }).getAttribute('aria-disabled')).not.toBe('true'))
})

it('跨页和搜索保留完整已选清单，关闭刷新恢复，清空选择、移除与确认丢弃彼此独立', async () => {
  const twelve = inpatientFullClinicalSchema.parse({ ...education, orders: Array.from({ length: 12 }, (_, index) => ({ ...education.orders[0], id: `order-${index + 1}`, display: `合成教育${index + 1}` })), executions: Array.from({ length: 12 }, (_, index) => ({ ...education.executions[0], id: `execution-${index + 1}`, orderId: `order-${index + 1}` })) })
  const mounted = mount(twelve), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  let dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  await user.click(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育1' }))
  await user.click(within(dialog).getByRole('checkbox', { name: '选择教育：合成教育1' }))
  await user.click(within(dialog).getByRole('button', { name: '下一页' }))
  await user.click(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育11' }))
  await user.click(within(dialog).getByRole('checkbox', { name: '选择教育：合成教育11' }))
  await user.type(within(dialog).getByRole('textbox', { name: '搜索教育项目' }), '不存在的项目')
  expect(within(dialog).getByRole('region', { name: '教育待办清单' }).textContent).toContain('已选 2')
  expect(within(dialog).getByRole('checkbox', { name: '清单选择：合成教育1' }).getAttribute('aria-checked')).toBe('true')
  await user.click(within(dialog).getByRole('button', { name: '关闭办理窗口' }))
  mounted.unmount()
  const restored = mount(twelve)
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  expect(within(dialog).getByText('待办清单 2/20 · 已选 2')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '清空选择' }))
  expect(within(dialog).getByText('待办清单 2/20 · 已选 0')).toBeTruthy()
  await user.click(within(within(dialog).getByRole('article', { name: '待办项目：execution-1' })).getByRole('button', { name: '移除项目' }))
  expect(within(dialog).getByText('待办清单 1/20 · 已选 0')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '丢弃待办清单' }))
  const confirmation = screen.getByRole('dialog', { name: '丢弃未提交清单？' })
  await user.click(within(confirmation).getByRole('button', { name: '保留清单' }))
  expect(within(dialog).getByText('待办清单 1/20 · 已选 0')).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '丢弃待办清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃未提交清单？' })).getByRole('button', { name: '确认丢弃待办清单' }))
  expect(within(dialog).getByText('待办清单 0/20 · 已选 0')).toBeTruthy()
  expect(restored.writes).toEqual([])
})

it('原执行内容变化撤回旧核实资格，必须按新记录逐项重新核实', async () => {
  const mounted = mount(education), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '集中记录健康教育' }))
  const dialog = screen.getByRole('dialog', { name: '集中记录健康教育' })
  await user.click(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-1' }))
  await user.click(within(dialog).getByRole('checkbox', { name: '选择教育：合成教育order-1' }))
  await mounted.refresh(inpatientFullClinicalSchema.parse({ ...education, executions: education.executions.map(execution => execution.id === 'execution-1' ? { ...execution, version: 2 } : execution) }))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '核对教育记录 (1)' }).hasAttribute('disabled')).toBe(true))
  expect(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-1' }).getAttribute('aria-checked')).toBe('false')
  expect(within(dialog).getByText('状态或内容已变化，须重新核实或移除。')).toBeTruthy()
  await user.click(within(dialog).getByRole('checkbox', { name: '已核实实际教育：合成教育order-1' }))
  await user.click(within(dialog).getByRole('checkbox', { name: '选择教育：合成教育order-1' }))
  await user.click(within(dialog).getByRole('button', { name: '核对教育记录 (1)' }))
  await user.click(within(dialog).getByRole('button', { name: '确认保存教育记录' }))
  await waitFor(() => expect(mounted.writes[0]?.input.expectedExecutionVersion).toBe(2))
  await waitFor(() => expect(within(dialog).getByText('逐项结果 · 成功 1/1')).toBeTruthy())
})
