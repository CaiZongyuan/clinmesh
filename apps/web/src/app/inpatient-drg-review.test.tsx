// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDrgReviewSchema } from '@clinmesh/contracts/inpatient-drg-review'
import { afterEach, expect, it, vi } from 'vitest'
import { InpatientDrgReviewDisclosure, InpatientDrgReviewPanel } from './inpatient-drg-review.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientActionOutlet, InpatientActionProvider, InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: '2026-11-03T00:00:00Z', depositFen: 0, chargesFen: 0, versionId: '1' })
const todo = { id: 'todo-1', version: 1, evidenceFingerprint: 'a'.repeat(64), key: 'extra-use:wire', kind: 'extra-use', ownerRole: 'inpatient-doctor', display: '导丝', materialId: 'wire', plannedQuantity: 1, actualQuantity: 2, procedureDisplay: '经皮冠状动脉介入治疗', executionId: 'execution-1', requestId: 'request-1', explanation: '实际用量超出原确认计划，请核实额外用途。', evidence: ['Procedure/execution-1'], target: 'surgery', status: 'pending', reason: null }
const review = inpatientDrgReviewSchema.parse({ admissionId: admission.id, taskId: null, version: 1, status: 'complete', fingerprint: 'a'.repeat(64), freezeReason: null,
  summary: { formalDrgCode: null, formalChargesFen: 200000, projectedTotalFen: null }, simulation: null, comparisons: [], planBases: [], missing: [], todos: [todo], resolvedTodos: [], actions: [], model: null, handedOver: null })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); sessionStorage.clear() })
function mount(currentSession = session, stay = admission, compact = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  const navigate = vi.fn()
  function Harness() {
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientDrgReviewPanel admission={stay} session={currentSession} locale="zh-CN" write={write} compact={compact} onOpenRecord={navigate} />
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return navigate
}

it('医生术后待办直接可处理，来源与已解决历史按需打开且焦点归还', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...review, summary: { ...review.summary, projectedTotalFen: 220000 },
    model: { current: true, status: 'succeeded', failureCode: null, observations: [] },
    resolvedTodos: [{ ...todo, id: 'resolved-1', status: 'resolved', display: '已解决的合成导管', reason: '原记录已核实' }] })))
  const navigate = mount(session, admission, true)
  const item = (await screen.findByText('导丝')).closest('article')!
  expect(screen.getByRole('list', { name: '术后核查清单' })).toBeDefined()
  expect(screen.queryByText(/^阶段正式收费/)).toBeNull()
  expect(screen.queryByText(/^阶段费用预计|术后分析可查看/)).toBeNull()
  expect(item.textContent).toContain('多用 1')
  expect(within(item).queryByRole('textbox', { name: '待办处理说明' })).toBeNull()
  expect(screen.queryByText('Procedure/execution-1')).toBeNull()
  expect(screen.queryByText(/已解决的合成导管/)).toBeNull()
  const user = userEvent.setup(), source = within(item).getByRole('button', { name: '看术中登记' })
  await user.click(within(item).getByRole('button', { name: '修改处理说明 导丝' }))
  expect(within(item).getByRole('textbox', { name: '待办处理说明' })).toBeDefined()
  await user.click(source)
  const dialog = await screen.findByRole('dialog', { name: '导丝' })
  expect(dialog.textContent).toContain('计划量：1')
  expect(dialog.textContent).toContain('实际量：2')
  await user.click(within(dialog).getByRole('button', { name: '前往手术原记录' }))
  expect(navigate).toHaveBeenCalledWith('surgery')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(source))
  await user.click(screen.getByRole('button', { name: '核查依据与历史' }))
  expect(await screen.findByText(/已解决的合成导管/)).toBeDefined()
  expect(within(screen.getByRole('dialog', { name: '核查依据与历史' })).getByText('术后分析可查看')).toBeDefined()
  await user.keyboard('{Escape}')
  expect(within(item).getByRole('textbox', { name: '待办处理说明' })).toBeDefined()
})

it('未开启跟进的术后待办展示原手术和数量，并直接进入原记录', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(review)))
  const navigate = mount()
  const item = (await screen.findByText('导丝')).closest('article')!
  expect(item.textContent).toContain('计划量：1')
  expect(item.textContent).toContain('实际量：2')
  expect(item.textContent).toContain('经皮冠状动脉介入治疗')
  await userEvent.setup().click(within(item).getByRole('button', { name: '前往手术原记录' }))
  expect(navigate).toHaveBeenCalledWith('surgery')
  expect(screen.queryByText('尚未开启本次住院跟进。')).toBeNull()
})

it('归档后保留待办与原记录入口，关闭处置、复查和交接写入', async () => {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(path)
    return Response.json({ ...review, status: 'frozen', freezeReason: '病案已归档，停止新的临床分析。' })
  }))
  const navigate = mount(session, { ...admission, recordStatus: 'archived' })
  await screen.findByText('导丝')
  expect(screen.queryByRole('textbox', { name: '待办处理说明' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: '本轮交接说明' })).toBeNull()
  expect(screen.queryByRole('button', { name: '复查最新业务记录' })).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: '前往手术原记录' }))
  expect(navigate).toHaveBeenCalledWith('surgery')
  expect(posts).toEqual([])
})

it('收费员只展示财务差异与正式收费，并进入本岗费用原记录', async () => {
  const financialTodo = { ...todo, kind: 'billing-mismatch', ownerRole: 'cashier', display: '导丝收费不一致', target: 'charges', plannedQuantity: null,
    expectedChargeFen: 20000, actualChargeFen: 10000, chargeDifferenceFen: -10000 }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...review, summary: { formalDrgCode: null, formalChargesFen: 10000, projectedTotalFen: null }, todos: [financialTodo] })))
  const navigate = mount({ ...session, actor: { ...session.actor, roleCode: 'cashier', practitionerRoleId: 'role-cashier' } })
  const panel = await screen.findByRole('region', { name: '费用差异核对' })
  await within(panel).findByText('导丝收费不一致')
  expect(within(panel).getByText('正式费用合计（已扣除退费）：¥100.00')).toBeDefined()
  expect(within(panel).getByText('应计费用：¥200.00')).toBeDefined()
  expect(within(panel).queryByText(/计划量：|实际量：|阶段 DRG|费用预计/)).toBeNull()
  expect(within(panel).queryByText('Procedure/execution-1')).toBeNull()
  expect(within(panel).queryByRole('button', { name: '前往手术原记录' })).toBeNull()
  await userEvent.setup().click(within(panel).getByRole('button', { name: '前往费用原记录' }))
  expect(navigate).toHaveBeenCalledWith('fees')
})

it.each(['cashier', 'medical-records'] as const)('%s核查首开后保留真实草稿，关闭停轮询且患者与身份隔离', async role => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const currentSession: SessionContext = { ...session, actor: { ...session.actor, roleCode: role } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const match = path.match(/admissions\/([^/]+)\/drg\/review$/)
    if (!match) throw new Error('Unexpected review read ' + path)
    reads += 1
    return Response.json({ ...review, admissionId: match[1], status: role === 'medical-records' ? 'frozen' : 'complete',
      freezeReason: role === 'medical-records' ? '本次跟进已停止' : null, todos: [{ ...todo, ownerRole: role }] })
  }))
  function Harness({ actorSession, stay, active }: { actorSession: SessionContext; stay: typeof admission; active: boolean }) {
    const write = useInpatientWriteIntent(actorSession, () => undefined)
    return <InpatientActionProvider stage="fees"><InpatientPrimaryAction stage="fees"><button>费用主操作</button></InpatientPrimaryAction>
      <InpatientDrgReviewDisclosure admission={stay} session={actorSession} locale="zh-CN" write={write} active={active} /><InpatientActionOutlet /></InpatientActionProvider>
  }
  const view = (actorSession = currentSession, stay = admission, active = true) => <QueryClientProvider client={client}><Harness actorSession={actorSession} stay={stay} active={active} /></QueryClientProvider>
  const rendered = render(view())
  try {
    expect(reads).toBe(0)
    const user = userEvent.setup(), title = role === 'cashier' ? '费用差异核对' : '术后核查与责任交接'
    await user.click(screen.getByText(title, { selector: 'summary' }))
    const label = role === 'cashier' ? '待办处理说明' : '本轮交接说明'
    await user.type(await screen.findByRole('textbox', { name: label }), 'A的未提交说明')
    const initial = reads
    await act(async () => { vi.advanceTimersByTime(3_100) })
    await waitFor(() => expect(reads).toBeGreaterThan(initial))
    await user.click(screen.getByText(title, { selector: 'summary' }))
    const details = screen.getByText(title, { selector: 'summary' }).closest('details')!
    await waitFor(() => expect(details.querySelector('input')).toBeNull())
    const closedReads = reads
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(reads).toBe(closedReads)
    expect(screen.getByRole('button', { name: '费用主操作' })).toBeDefined()
    await user.click(screen.getByText(title, { selector: 'summary' }))
    expect(await screen.findByRole<HTMLInputElement>('textbox', { name: label })).toHaveProperty('value', 'A的未提交说明')
    rendered.rerender(view(currentSession, admission, false))
    await waitFor(() => expect(details.querySelector('input')).toBeNull())
    const inactiveReads = reads
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(reads).toBe(inactiveReads)
    rendered.rerender(view({ ...currentSession, actor: { ...currentSession.actor, actorId: 'another-actor' } }))
    expect(await screen.findByRole<HTMLInputElement>('textbox', { name: label })).toHaveProperty('value', '')
    await user.type(screen.getByRole('textbox', { name: label }), '另一身份的A说明')
    rendered.rerender(view(currentSession, { ...admission, id: 'admission-B', patientName: '合成患者B' }))
    expect(await screen.findByRole<HTMLInputElement>('textbox', { name: label })).toHaveProperty('value', '')
  } finally {
    rendered.unmount()
    client.clear()
    vi.useRealTimers()
  }
})

it('术后处理说明按记录带出，一次确认逐项提交，第二项失败保留未提交项', async () => {
  const items = [todo, { ...todo, id: 'todo-2', key: 'extra-use:balloon', materialId: 'balloon', display: '球囊' }, { ...todo, id: 'todo-3', key: 'unused-plan:stent', kind: 'unused-plan', materialId: 'stent', display: '支架' }]
  const posts: string[] = []
  let current = inpatientDrgReviewSchema.parse({ ...review, todos: items })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (init?.method === 'POST') {
      const input = JSON.parse(String(init.body)).input
      posts.push(input.todoId)
      if (input.todoId === 'todo-2') return Response.json({ error: { code: 'VERSION_CONFLICT', message: '合成第二项依据已变化' } }, { status: 409 })
      current = { ...current, todos: current.todos.map(item => item.id === input.todoId ? { ...item, status: 'dismissed', reason: input.note } : item) }
      return Response.json({ data: current, auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [] })
    }
    if (path.endsWith('/drg/review')) return Response.json(current)
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成原记录未准备' } }, { status: 503 })
  }))
  mount(session, admission, true)
  await screen.findByText('导丝')
  await userEvent.setup().click(screen.getByRole('button', { name: '修改处理说明 导丝' }))
  expect(screen.getAllByRole<HTMLInputElement>('textbox', { name: '待办处理说明' })[0]!.value).toContain('实际用量超出原确认计划')
  await userEvent.setup().click(screen.getByRole('button', { name: '一次全部确认' }))
  await waitFor(() => expect(posts).toEqual(['todo-1', 'todo-2']))
  expect((await screen.findByRole('alert')).textContent).toMatch(/变化|更新|刷新|冲突|重试/)
  expect(screen.getByText('球囊')).toBeDefined()
  expect(screen.getByText('支架')).toBeDefined()
})

it('批量确认途中离开页面会停止后续提交，回来后仍可办理余项', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const posts: string[] = []
  let current = inpatientDrgReviewSchema.parse({ ...review, todos: [todo, { ...todo, id: 'todo-next', key: 'extra-use:next', display: '下一项' }] })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (init?.method === 'POST') {
      const input = JSON.parse(String(init.body)).input; posts.push(input.todoId)
      await gate
      current = { ...current, todos: current.todos.map(item => item.id === input.todoId ? { ...item, status: 'dismissed', reason: input.note } : item) }
      return Response.json({ data: current, auditId: 'audit-leave', requestId: 'receipt-leave', effects: [], warnings: [] })
    }
    if (path.endsWith('/drg/review')) return Response.json(current)
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  function Harness({ active }: { active: boolean }) {
    const write = useInpatientWriteIntent(session, () => undefined)
    return <InpatientDrgReviewPanel admission={admission} session={session} locale="zh-CN" write={write} active={active} compact />
  }
  const view = (active: boolean) => <QueryClientProvider client={client}><Harness active={active} /></QueryClientProvider>
  const rendered = render(view(true)), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '一次全部确认' }))
  await waitFor(() => expect(posts).toEqual(['todo-1']))
  rendered.rerender(view(false))
  await act(async () => { release() })
  rendered.rerender(view(true))
  await screen.findByText('下一项')
  expect(await screen.findByRole<HTMLButtonElement>('button', { name: '一次全部确认' })).toHaveProperty('disabled', false)
  expect(posts).toEqual(['todo-1'])
})

it('全部确认保留已处置历史，但不再显示确认按钮或未完成输入', async () => {
  let current = inpatientDrgReviewSchema.parse({ ...review, todos: [todo] })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(session)
    if (init?.method === 'POST') {
      const input = JSON.parse(String(init.body)).input
      current = { ...current, todos: current.todos.map(item => ({ ...item, status: 'dismissed', reason: input.note })) }
      return Response.json({ data: current, auditId: 'audit-done', requestId: 'receipt-done', effects: [], warnings: [] })
    }
    if (path.endsWith('/drg/review')) return Response.json(current)
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  mount(session, admission, true)
  await userEvent.setup().click(await screen.findByRole('button', { name: '一次全部确认' }))
  await screen.findByText('已全部确认')
  expect(screen.getByText('已确认')).toBeDefined()
  expect(screen.queryByRole('button', { name: '一次全部确认' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: '待办处理说明' })).toBeNull()
})
