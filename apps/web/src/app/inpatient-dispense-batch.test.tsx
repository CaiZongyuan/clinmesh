// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDispenseInputSchema, inpatientPharmacySchema } from '@clinmesh/contracts/inpatient-clinical'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InpatientPharmacy } from './inpatient-pharmacy.tsx'

const pharmacist: SessionContext = {
  actor: { actorId: 'actor-pharmacist', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1',
    practitionerRoleId: 'role-pharmacist', practitionerId: 'practitioner-pharmacist', organizationId: 'organization-pharmacy', locationId: 'location-pharmacy', roleCode: 'pharmacist' },
  user: { id: 'user-pharmacist', name: '合成药师', email: 'pharmacist@demo.clinmesh.local' }, availableRoles: [],
}
const admission = { admissionId: 'admission-1', patientId: 'patient-1', patientName: '合成发药患者', inpatientNumber: 'ZY-0001', wardId: 'ward-general', status: 'admitted' as const }
const virtualTime = '2026-08-25T09:00:00+08:00'
const names = ['合成阿司匹林', '合成氯吡格雷', '合成阿托伐他汀']
const scheduled = ['2026-08-24T08:00:00+08:00', '2026-08-24T20:00:00+08:00', '2026-08-25T08:00:00+08:00']

function pharmacyFacts() {
  return inpatientPharmacySchema.parse({ admission, medicationAllergies: [], dispenses: [],
    orders: names.map((display, index) => ({ id: `order-${index + 1}`, admissionId: admission.admissionId, kind: 'medication', duration: 'temporary',
      catalogItemId: `medication-${index + 1}`, catalogVersion: 1, display, doseText: ['100 mg', '75 mg', '20 mg'][index], doseQuantity: index === 2 ? 2 : 1,
      unit: '片', frequencyCode: 'QD', state: 'verified', version: 2, requestVersion: '2', signedAt: '2026-08-24T07:00:00+08:00', signedBy: 'synthetic-doctor',
      organizationId: 'organization-inpatient', verifiedAt: '2026-08-24T07:10:00+08:00' })),
    executions: names.map((_, index) => ({ id: `execution-${index + 1}`, orderId: `order-${index + 1}`, scheduledFor: scheduled[index], status: 'pending', version: 1 })),
    medications: names.map((display, index) => ({ id: `medication-${index + 1}`, display, unit: '片',
      lots: [{ id: `lot-${index + 1}`, version: 1, quantityOnHand: 10, expiresOn: '2027-12-31' }] })),
  })
}

function sameLotFacts() {
  const facts = pharmacyFacts()
  return inpatientPharmacySchema.parse({ ...facts, orders: [{ ...facts.orders[0]!, duration: 'long', frequencyCode: 'BID' }],
    executions: facts.executions.map(execution => ({ ...execution, orderId: 'order-1' })), medications: [facts.medications[0]!] })
}

function server(initial = pharmacyFacts()) {
  let facts = initial
  let loseResponseFor: string | undefined
  let receiptUnavailable = false
  let afterCommit: ((facts: ReturnType<typeof pharmacyFacts>, executionId: string) => ReturnType<typeof pharmacyFacts>) | undefined
  const posts: Array<{ key: string; body: unknown; executionId: string }> = []
  const receiptKeys: string[] = []
  const receipts = new Map<string, unknown>()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(pharmacist)
    if (path.endsWith('/pharmacy/admissions')) return Response.json({ items: [facts.admission] })
    if (path.endsWith('/scenario-runs/current')) return Response.json({ clinicalReview: null, epoch: 'epoch-1', initialStateHash: 'synthetic-hash',
      kind: 'candidate', scenarioId: 'scenario-1', scenarioRunId: 'scenario-run-1', seed: 1, status: 'active', virtualTime, workspaceId: 'workspace-demo' })
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'https://example.test').searchParams
      const key = query.get('idempotencyKey')!
      receiptKeys.push(key)
      expect(query.get('operationId')).toBe('inpatient.execution.dispense')
      if (receiptUnavailable) return Response.json({ error: { code: 'INPATIENT_STOCK_CONFLICT', message: '合成回执读取失败' } }, { status: 409 })
      const response = receipts.get(key)
      return response === undefined
        ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执不存在' } }, { status: 404 })
        : Response.json({ operationId: 'inpatient.execution.dispense', idempotencyKey: key, status: 'completed', response })
    }
    if (init?.method === 'POST' && path.endsWith('/executions/dispense')) {
      const body: unknown = JSON.parse(String(init.body))
      const command = inpatientDispenseInputSchema.parse({ ...JSON.parse(String(init.body)).input, admissionId: facts.admission.admissionId })
      const key = new Headers(init.headers).get('idempotency-key')!
      posts.push({ key, body, executionId: command.executionId })
      const replay = receipts.get(key)
      if (replay !== undefined) return Response.json(replay)
      const execution = facts.executions.find(item => item.id === command.executionId)!
      const order = facts.orders.find(item => item.id === execution.orderId)!
      if (execution.status !== 'pending' || execution.version !== command.expectedExecutionVersion) {
        return Response.json({ error: { code: 'INPATIENT_EXECUTION_CONFLICT', message: '合成执行单已变化' } }, { status: 409 })
      }
      const lots = facts.medications.find(item => item.id === order.catalogItemId)!.lots
      if (command.lotSelections.some(selection => !lots.some(lot => lot.id === selection.lotId && lot.version === selection.expectedVersion && lot.quantityOnHand >= selection.quantity))) {
        return Response.json({ error: { code: 'INPATIENT_STOCK_CONFLICT', message: '合成库存版本或数量已变化' } }, { status: 409 })
      }
      facts = inpatientPharmacySchema.parse({ ...facts,
        executions: facts.executions.map(item => item.id === command.executionId ? { ...item, status: 'dispensed', version: item.version + 1 } : item),
        medications: facts.medications.map(item => item.id !== order.catalogItemId ? item : { ...item, lots: item.lots.map(lot => {
          const selection = command.lotSelections.find(item => item.lotId === lot.id)
          return selection ? { ...lot, version: lot.version + 1, quantityOnHand: lot.quantityOnHand - selection.quantity } : lot
        }) }),
        dispenses: [...facts.dispenses, ...command.lotSelections.map((selection, index) => ({ id: `dispense-${command.executionId}-${index + 1}`,
          executionId: command.executionId, lotId: selection.lotId, quantity: selection.quantity, dispensedAt: virtualTime, dispensedBy: pharmacist.actor.actorId }))],
      })
      const response = { auditId: `audit-${command.executionId}`, requestId: `command-${command.executionId}`, warnings: [], data: facts,
        effects: command.lotSelections.flatMap((selection, index) => [
          { kind: 'created', reference: `MedicationDispense/dispense-${command.executionId}-${index + 1}`, versionId: '1' },
          { kind: 'created', reference: `InventoryMovement/movement-${command.executionId}-${index + 1}`, versionId: '1' },
          { kind: 'updated', reference: `InventoryItem/${selection.lotId}`, versionId: String(selection.expectedVersion + 1) },
        ]) }
      receipts.set(key, response)
      if (afterCommit) facts = inpatientPharmacySchema.parse(afterCommit(facts, command.executionId))
      if (command.executionId === loseResponseFor) throw new TypeError('synthetic committed response loss')
      return Response.json(response)
    }
    if (path.endsWith('/pharmacy')) return Response.json(facts)
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, receiptKeys, facts: () => facts, loseResponse: (executionId: string) => { loseResponseFor = executionId },
    receiptUnavailable: (unavailable: boolean) => { receiptUnavailable = unavailable },
    replaceFacts: (next: ReturnType<typeof pharmacyFacts>) => { facts = inpatientPharmacySchema.parse(next) },
    afterCommit: (change: NonNullable<typeof afterCommit>) => { afterCommit = change } }
}

function mount(activeSession: SessionContext = pharmacist) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><InpatientPharmacy session={activeSession} locale="zh-CN" /></QueryClientProvider>)
}

async function openPatient(user: ReturnType<typeof userEvent.setup>) {
  await user.click((await screen.findAllByRole('button', { name: /^查看合成发药患者/ }))[0]!)
}

beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('三项发药逐项结算；第二项响应丢失后停止余项，刷新按原键恢复再重新核对剩余项', async () => {
  const api = server()
  api.loseResponse('execution-2')
  const first = mount()
  const user = userEvent.setup()
  await openPatient(user)
  for (const name of names) await user.click(await screen.findByRole('checkbox', { name: new RegExp(`^选择发药：${name}`) }))
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  let preview = screen.getByRole('dialog', { name: '集中发药核对' })
  expect(preview.textContent).toContain('库存批次')
  expect(preview.textContent).toContain('2027-12-31')
  expect(preview.textContent).toContain('2片')
  expect(preview.textContent).toContain('20:00')
  await user.click(within(preview).getByRole('button', { name: '确认发药' }))
  await waitFor(() => expect(api.posts.map(post => post.executionId)).toEqual(['execution-1', 'execution-2']))
  await screen.findByRole('button', { name: '恢复原发药' })
  const results = screen.getByRole('region', { name: '发药逐项结果' })
  expect(results.textContent).toContain('合成阿司匹林')
  expect(results.textContent).toContain('合成氯吡格雷')
  expect(results.textContent).toMatch(/待确认|待核实/)
  first.unmount()

  mount()
  await openPatient(user)
  await user.click(await screen.findByRole('button', { name: '恢复原发药' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[1]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原发药' })).toBeNull())
  expect(api.posts.map(post => post.executionId)).toEqual(['execution-1', 'execution-2'])
  expect(api.facts().dispenses.map(item => item.executionId)).toEqual(['execution-1', 'execution-2'])
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  preview = screen.getByRole('dialog', { name: '集中发药核对' })
  expect(preview.textContent).toContain('合成阿托伐他汀')
  expect(api.posts).toHaveLength(2)
  await user.click(within(preview).getByRole('button', { name: '确认发药' }))
  await waitFor(() => expect(api.posts.map(post => post.executionId)).toEqual(['execution-1', 'execution-2', 'execution-3']))
  expect(new Set(api.posts.map(post => post.key)).size).toBe(3)
  await waitFor(() => expect(api.facts().dispenses).toHaveLength(3))
  expect(api.facts().medications.map(item => [item.lots[0]!.version, item.lots[0]!.quantityOnHand])).toEqual([[2, 9], [2, 9], [2, 8]])
  expect(api.facts().executions.map(item => item.status)).toEqual(['dispensed', 'dispensed', 'dispensed'])
})

it('同药三个执行时点共用同批库存，后续只采用本批成功推进的版本且每单仅扣一次', async () => {
  const api = server(sameLotFacts())
  mount()
  const user = userEvent.setup()
  await openPatient(user)
  const choices = await screen.findAllByRole('checkbox', { name: /^选择发药：合成阿司匹林/ })
  expect(choices).toHaveLength(3)
  for (const choice of choices) await user.click(choice)
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  const preview = screen.getByRole('dialog', { name: '集中发药核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(3)
  await user.click(within(preview).getByRole('button', { name: '确认发药' }))
  await waitFor(() => expect(api.facts().dispenses).toHaveLength(3))
  expect(api.posts.map(post => post.executionId)).toEqual(['execution-1', 'execution-2', 'execution-3'])
  expect(api.posts.map(post => post.body)).toEqual([
    { input: { executionId: 'execution-1', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'lot-1', expectedVersion: 1, quantity: 1 }] } },
    { input: { executionId: 'execution-2', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'lot-1', expectedVersion: 2, quantity: 1 }] } },
    { input: { executionId: 'execution-3', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'lot-1', expectedVersion: 3, quantity: 1 }] } },
  ])
  expect(api.facts().medications[0]!.lots).toEqual([{ id: 'lot-1', version: 4, quantityOnHand: 7, expiresOn: '2027-12-31' }])
  await waitFor(() => expect(screen.getByRole('region', { name: '发药逐项结果' }).textContent).toContain('成功 3/3'))
})

it('本批成功后外部批次版本变化不得自动接受；受影响项保留，其他批次的独立项继续', async () => {
  const shared = sameLotFacts(), independent = pharmacyFacts()
  const initial = inpatientPharmacySchema.parse({ ...shared, orders: [shared.orders[0], independent.orders[1]],
    executions: shared.executions.map(execution => execution.id === 'execution-3' ? { ...execution, orderId: 'order-2' } : execution),
    medications: [shared.medications[0], independent.medications[1]] })
  const api = server(initial)
  api.afterCommit((facts, executionId) => executionId !== 'execution-1' ? facts : inpatientPharmacySchema.parse({ ...facts,
    medications: facts.medications.map(medication => medication.id !== 'medication-1' ? medication : { ...medication,
      lots: medication.lots.map(lot => ({ ...lot, version: lot.version + 1 })) }) }))
  mount()
  const user = userEvent.setup()
  await openPatient(user)
  await screen.findAllByRole('checkbox', { name: /^选择发药：/ })
  await user.click(screen.getByRole('button', { name: '全选本页可发药执行单' }))
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中发药核对' })).getByRole('button', { name: '确认发药' }))
  await waitFor(() => expect(api.posts.map(post => post.executionId)).toEqual(['execution-1', 'execution-3']))
  const results = screen.getByRole('region', { name: '发药逐项结果' })
  await waitFor(() => expect(results.textContent).toContain('成功 2/3'))
  expect(results.textContent).toMatch(/变化|重新核对/)
  const drafts = screen.getByRole('region', { name: '发药待处理清单' })
  expect(drafts.textContent).toContain('合成阿司匹林')
  expect(drafts.textContent).not.toContain('合成氯吡格雷')
  expect(api.facts().executions.map(execution => execution.status)).toEqual(['dispensed', 'pending', 'dispensed'])
  expect(api.facts().medications[0]!.lots[0]).toMatchObject({ version: 3, quantityOnHand: 9 })
  expect(screen.queryByRole('button', { name: '恢复原发药' })).toBeNull()
})

it('确认弹窗只发送本次审阅集合；同上下文另一界面新增选择后必须返回重新核对', async () => {
  const api = server()
  const first = mount()
  const user = userEvent.setup()
  await user.click((await within(first.container).findAllByRole('button', { name: /^查看合成发药患者/ }))[0]!)
  await user.click(await within(first.container).findByRole('checkbox', { name: /^选择发药：合成阿司匹林/ }))
  const second = mount()
  await user.click((await within(second.container).findAllByRole('button', { name: /^查看合成发药患者/ }))[0]!)
  await user.click(within(first.container).getByRole('button', { name: '集中发药' }))
  const preview = screen.getByRole('dialog', { name: '集中发药核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(1)
  expect(preview.textContent).not.toContain('合成氯吡格雷')

  // 第二个真实挂载代表同会话的另一个界面；不读取或修改私有草稿结构。
  fireEvent.click(within(second.container).getByRole('checkbox', { name: /^选择发药：合成氯吡格雷/, hidden: true }))
  await user.click(within(preview).getByRole('button', { name: '确认发药' }))
  await within(preview).findByText(/本次未发送/)
  expect(api.posts).toHaveLength(0)
  await user.click(within(preview).getByRole('button', { name: '返回修改' }))
  expect(within(first.container).getByRole('region', { name: '发药待处理清单' }).textContent).toContain('合成氯吡格雷')
})

it('已核对批次消失后不可重新选择或全选，原待处理清单保留供人工处理', async () => {
  const api = server(sameLotFacts())
  mount()
  const user = userEvent.setup()
  await openPatient(user)
  await user.click((await screen.findAllByRole('checkbox', { name: /^选择发药：合成阿司匹林/ }))[0]!)
  api.replaceFacts({ ...api.facts(), medications: api.facts().medications.map(medication => ({ ...medication, lots: [] })) })
  await user.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => {
    for (const choice of screen.getAllByRole('checkbox', { name: /^选择发药：合成阿司匹林/ })) expect(choice.getAttribute('aria-disabled')).toBe('true')
  })
  expect(screen.getByRole('button', { name: '全选本页可发药执行单' }).hasAttribute('disabled')).toBe(true)
  const drafts = screen.getByRole('region', { name: '发药待处理清单' })
  expect(drafts.textContent).toContain('合成阿司匹林')
  expect(within(drafts).getByRole('button', { name: /^移除：合成阿司匹林/ })).toBeDefined()
  expect(api.posts).toHaveLength(0)
})

it('成功结算后清理原意图暂时失败，同键恢复不会重复扣库存且余项重新核对后继续', async () => {
  const api = server(sameLotFacts())
  const removeItem = Storage.prototype.removeItem
  let failOnce = true
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
    if (key.startsWith('clinmesh.inpatient-intent:') && failOnce) {
      failOnce = false
      throw new DOMException('synthetic removal unavailable', 'QuotaExceededError')
    }
    removeItem.call(this, key)
  })
  mount()
  const user = userEvent.setup()
  await openPatient(user)
  await user.click(screen.getByRole('button', { name: '全选本页可发药执行单' }))
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中发药核对' })).getByRole('button', { name: '确认发药' }))
  await user.click(await screen.findByRole('button', { name: '恢复原住院操作' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[0]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原住院操作' })).toBeNull())
  expect(api.posts.map(post => post.executionId)).toEqual(['execution-1'])
  expect(api.facts().medications[0]!.lots[0]).toMatchObject({ version: 2, quantityOnHand: 9 })
  const drafts = screen.getByRole('region', { name: '发药待处理清单' })
  for (const button of within(drafts).getAllByRole('button', { name: /^更新核对：/ })) await user.click(button)
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  const preview = screen.getByRole('dialog', { name: '集中发药核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(2)
  await user.click(within(preview).getByRole('button', { name: '确认发药' }))
  await waitFor(() => expect(api.facts().dispenses).toHaveLength(3))
  expect(api.posts.map(post => post.executionId)).toEqual(['execution-1', 'execution-2', 'execution-3'])
  expect(api.posts.map(post => post.body)).toEqual([
    { input: { executionId: 'execution-1', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'lot-1', expectedVersion: 1, quantity: 1 }] } },
    { input: { executionId: 'execution-2', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'lot-1', expectedVersion: 2, quantity: 1 }] } },
    { input: { executionId: 'execution-3', expectedExecutionVersion: 1, lotSelections: [{ lotId: 'lot-1', expectedVersion: 3, quantity: 1 }] } },
  ])
  expect(api.facts().medications[0]!.lots[0]).toMatchObject({ version: 4, quantityOnHand: 7 })
})

it('同批三个完整剂量合计超过库存时允许预览核对但确认前阻止全部发送', async () => {
  const initial = sameLotFacts()
  const api = server({ ...initial, medications: [{ ...initial.medications[0]!, lots: [{ ...initial.medications[0]!.lots[0]!, quantityOnHand: 2 }] }] })
  mount()
  const user = userEvent.setup()
  await openPatient(user)
  await user.click(screen.getByRole('button', { name: '全选本页可发药执行单' }))
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  const preview = screen.getByRole('dialog', { name: '集中发药核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(3)
  await user.click(within(preview).getByRole('button', { name: '确认发药' }))
  await within(preview).findByText(/所选总量超过同批库存.*本次未发送/)
  expect(api.posts).toHaveLength(0)
  expect(api.facts().dispenses).toHaveLength(0)
  await user.click(within(preview).getByRole('button', { name: '返回修改' }))
  expect(within(screen.getByRole('region', { name: '发药待处理清单' })).getAllByRole('article')).toHaveLength(3)
})

it('原回执读取409不视为发药被确定拒绝，保留原键与余项直到查明', async () => {
  const api = server()
  api.loseResponse('execution-1')
  mount()
  const user = userEvent.setup()
  await openPatient(user)
  await user.click(screen.getByRole('button', { name: '全选本页可发药执行单' }))
  await user.click(screen.getByRole('button', { name: '集中发药' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中发药核对' })).getByRole('button', { name: '确认发药' }))
  api.receiptUnavailable(true)
  await user.click(await screen.findByRole('button', { name: '恢复原发药' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[0]!.key]))
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复原发药' }).hasAttribute('disabled')).toBe(false))
  const results = screen.getByRole('region', { name: '发药逐项结果' })
  expect(results.textContent).toContain('结果待确认')
  expect(results.textContent).not.toContain('发药失败')
  expect(api.posts.map(post => post.executionId)).toEqual(['execution-1'])
  expect(screen.queryByRole('button', { name: '集中发药' })).toBeNull()
  api.receiptUnavailable(false)
  await user.click(screen.getByRole('button', { name: '恢复原发药' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[0]!.key, api.posts[0]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原发药' })).toBeNull())
  expect(api.posts).toHaveLength(1)
  expect(api.facts().dispenses.map(item => item.executionId)).toEqual(['execution-1'])
  expect(within(screen.getByRole('region', { name: '发药待处理清单' })).getAllByRole('article')).toHaveLength(2)
})

it.each(['账户', '药房位置', '场景轮次', '患者', '住院'] as const)('%s变化不串用原选择，返回原上下文仍可恢复待处理清单', async changed => {
  const original = pharmacyFacts()
  const api = server(original)
  const first = mount()
  const user = userEvent.setup()
  await openPatient(user)
  await user.click(await screen.findByRole('checkbox', { name: /^选择发药：合成阿司匹林/ }))
  first.unmount()

  const otherSession = changed === '账户' ? { ...pharmacist, user: { ...pharmacist.user, id: 'other-account' } }
    : changed === '药房位置' ? { ...pharmacist, actor: { ...pharmacist.actor, locationId: 'other-location' } }
      : changed === '场景轮次' ? { ...pharmacist, actor: { ...pharmacist.actor, scenarioRunId: 'other-run' } } : pharmacist
  const otherAdmission = { ...original.admission, ...(changed === '患者' ? { patientId: 'other-patient' } : changed === '住院' ? { admissionId: 'other-admission' } : {}) }
  api.replaceFacts({ ...original, admission: otherAdmission, orders: original.orders.map(order => ({ ...order, admissionId: otherAdmission.admissionId })) })
  const other = mount(otherSession)
  await openPatient(user)
  await screen.findByRole('checkbox', { name: /^选择发药：合成阿司匹林/ })
  expect(screen.queryByRole('region', { name: '发药待处理清单' })).toBeNull()
  expect(screen.getByRole('button', { name: '集中发药' }).hasAttribute('disabled')).toBe(true)
  other.unmount()

  api.replaceFacts(original)
  mount()
  await openPatient(user)
  const drafts = await screen.findByRole('region', { name: '发药待处理清单' })
  expect(within(drafts).getAllByRole('article')).toHaveLength(1)
  expect(drafts.textContent).toContain('合成阿司匹林')
  expect(api.posts).toHaveLength(0)
})

it('持久化选择损坏时阻止发送，用户明确丢弃后才能重新建立选择', async () => {
  const api = server()
  const first = mount()
  const user = userEvent.setup()
  await openPatient(user)
  await user.click(await screen.findByRole('checkbox', { name: /^选择发药：合成阿司匹林/ }))
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.dispense-drafts:'))!
  first.unmount()
  sessionStorage.setItem(key, '{synthetic-corrupted-storage')
  mount()
  await openPatient(user)
  await screen.findByText('发药待处理清单无法可靠读取或保存，已阻止发送；请先核查原操作。')
  expect(screen.getByRole('button', { name: '集中发药' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('checkbox', { name: /^选择发药：合成阿司匹林/ }).getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '丢弃发药待处理清单' }))
  const dialog = screen.getByRole('dialog', { name: '丢弃发药待处理清单' })
  await user.click(within(dialog).getByRole('button', { name: '保留待处理清单' }))
  expect(sessionStorage.getItem(key)).toBe('{synthetic-corrupted-storage')
  await user.click(screen.getByRole('button', { name: '丢弃发药待处理清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃发药待处理清单' })).getByRole('button', { name: '确认丢弃' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: '发药待处理清单' })).toBeNull())
  await user.click(screen.getByRole('checkbox', { name: /^选择发药：合成氯吡格雷/ }))
  expect(screen.getByRole('region', { name: '发药待处理清单' }).textContent).toContain('合成氯吡格雷')
  expect(api.posts).toHaveLength(0)
})
