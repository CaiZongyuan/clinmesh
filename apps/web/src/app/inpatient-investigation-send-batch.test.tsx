// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LaboratoryRequest, SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { signOut } from './api-client.ts'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientActionOutlet, InpatientActionProvider } from './inpatient-workspace-actions.tsx'

const nurse: SessionContext = {
  actor: { actorId: 'actor-nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' },
  user: { id: 'user-nurse', name: '合成护士', email: 'ward-nurse@demo.clinmesh.local' }, availableRoles: [],
}
const admission = inpatientAdmissionSchema.parse({
  id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-0001', admissionRoute: 'direct', wardId: 'ward-general',
  organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2',
})

function laboratory(index: number, name: string, status: LaboratoryRequest['status'] = 'issued') {
  const referenceConcept = { id: `laboratory-${index}`, code: `synthetic-${index}`, display: name, system: 'https://example.test/laboratory', version: '1', sourceLocator: 'synthetic-fixture' }
  return {
    id: `request-${index}`, catalogItemId: `laboratory-${index}`, indicationCode: 'screening', serviceRequestId: `service-request-${index}`,
    serviceRequestVersion: '1', taskId: `task-${index}`, taskVersion: '1', status, version: 1, referenceConcept,
    laboratoryService: {
      allowedIndicationCodes: ['screening'], componentServiceIds: [], doctorOrderable: true, executingDepartmentId: 'department-laboratory',
      id: `laboratory-${index}`, localCode: `synthetic-${index}`, nameZh: name, priceFen: 1000, referenceConcept, referenceReleaseId: 'synthetic-release',
      reportDefinition: { conclusionTemplate: '合成检验结论', results: [{ referenceConcept, referenceRange: { text: '合成正常' }, valueType: 'boolean', allowedValues: [false, true] }] },
      specimen: { code: 'whole-blood', display: '合成全血', system: 'https://example.test/specimen' }, serviceKind: 'laboratory', tatMinutes: 30, version: 1,
    },
  }
}

type Post = { requestId: string; key: string | null; body: unknown }

function server(requests = [laboratory(1, '合成白细胞计数'), laboratory(2, '合成血红蛋白'), laboratory(3, '合成血小板计数')]) {
  let activeSession = nurse
  let facts = inpatientInvestigationsSchema.parse({ admissionId: admission.id, laboratoryRequests: requests, imagingRequests: [], sent: [] })
  const posts: Post[] = []
  const receiptKeys: string[] = []
  const receipts = new Map<string, unknown>()
  let loseResponseFor: string | undefined
  const envelope = () => ({ auditId: 'synthetic-audit', requestId: 'synthetic-command', effects: [], warnings: [], data: facts })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(activeSession)
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'https://example.test').searchParams
      const key = query.get('idempotencyKey')!
      receiptKeys.push(key)
      expect(query.get('operationId')).toBe('inpatient.investigation.send')
      const response = receipts.get(key)
      return response === undefined
        ? Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执不存在' } }, { status: 404 })
        : Response.json({ operationId: 'inpatient.investigation.send', idempotencyKey: key, status: 'completed', response })
    }
    if (init?.method === 'POST' && path.endsWith('/investigations/send')) {
      const body = JSON.parse(String(init.body)) as { input: { requestId: string } }
      const key = new Headers(init.headers).get('idempotency-key')
      posts.push({ requestId: body.input.requestId, key, body })
      if (!facts.sent.some(item => item.requestId === body.input.requestId)) {
        facts = inpatientInvestigationsSchema.parse({ ...facts, sent: [...facts.sent, { requestId: body.input.requestId, sentAt: '2026-08-24T09:10:00+08:00', sentBy: nurse.actor.actorId }] })
      }
      const response = envelope()
      receipts.set(key!, response)
      if (body.input.requestId === loseResponseFor) throw new TypeError('synthetic committed response loss')
      return Response.json(response)
    }
    if (path.endsWith('/investigations')) return Response.json(facts)
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, receiptKeys, facts: () => facts, replace: (next: unknown) => { facts = inpatientInvestigationsSchema.parse(next) },
    identity: (next: SessionContext) => { activeSession = next },
    loseResponse: (requestId: string) => { loseResponseFor = requestId } }
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  type Context = { session: SessionContext; admission: typeof admission; active: boolean }
  let context: Context = { session: nurse, admission, active: true }
  function Subject({ context: current }: { context: Context }) {
    const write = useInpatientWriteIntent(current.session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="investigations">
      <InpatientInvestigations admission={current.admission} session={current.session} locale="zh-CN" write={write} active={current.active} />
      <aside aria-label="底部操作"><InpatientActionOutlet /></aside>
    </InpatientActionProvider>
  }
  const mounted = render(<QueryClientProvider client={client}><Subject context={context} /></QueryClientProvider>)
  return { ...mounted, refresh: () => client.invalidateQueries({ queryKey: ['inpatient'] }),
    change: (next: Partial<Context>) => { context = { ...context, ...next }; mounted.rerender(<QueryClientProvider client={client}><Subject context={context} /></QueryClientProvider>) } }
}

beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('集中送检逐项结算；响应丢失后刷新只恢复原项，剩余申请须重新核对再发送', async () => {
  const api = server()
  api.loseResponse('request-2')
  const first = mount()
  const user = userEvent.setup()
  for (const name of ['合成白细胞计数', '合成血红蛋白', '合成血小板计数']) {
    await user.click(await screen.findByRole('checkbox', { name: `选择送检：${name}` }))
  }
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  let preview = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(preview.textContent).toContain('合成全血')
  expect(preview.textContent).toContain('检验')
  expect(preview.textContent).toContain('待送检')
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2']))
  const results = await screen.findByRole('region', { name: '送检逐项结果' })
  expect(results.textContent).toContain('合成白细胞计数')
  expect(results.textContent).toMatch(/成功|已送检/)
  expect(results.textContent).toContain('合成血红蛋白')
  await screen.findByRole('button', { name: '恢复原送检' })
  first.unmount()

  mount()
  await user.click(await screen.findByRole('button', { name: '恢复原送检' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[1]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原送检' })).toBeNull())
  expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2'])
  expect(api.facts().sent.map(item => item.requestId)).toEqual(['request-1', 'request-2'])
  expect(api.facts().laboratoryRequests.map(request => [request.status, request.version])).toEqual([['issued', 1], ['issued', 1], ['issued', 1]])

  await user.click(screen.getByRole('button', { name: '集中送检' }))
  preview = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(preview.textContent).toContain('合成血小板计数')
  expect(api.posts).toHaveLength(2)
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2', 'request-3']))
  expect(new Set(api.posts.map(post => post.key)).size).toBe(3)
  await waitFor(() => expect(api.facts().sent).toHaveLength(3))
})

it('全选只作用于当前十条；搜索翻页保留完整清单，超过二十条拒绝且清空选择不丢草稿', async () => {
  const api = server(Array.from({ length: 21 }, (_, index) => laboratory(index + 1, `合成检验${String(index + 1).padStart(2, '0')}`)))
  const first = mount()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: '选择送检：合成检验01' })
  expect(screen.getAllByRole('checkbox', { name: /^选择送检：/ })).toHaveLength(10)
  await user.click(screen.getByRole('button', { name: '全选本页可送检申请' }))
  let drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(within(drafts).getAllByRole('checkbox')).toHaveLength(10)
  expect(drafts.textContent).toContain('已选 10 项')
  await user.click(screen.getByRole('button', { name: '下一页' }))
  expect(screen.getByRole('checkbox', { name: '选择送检：合成检验11' }).getAttribute('aria-checked')).toBe('false')
  await user.click(screen.getByRole('button', { name: '全选本页可送检申请' }))
  drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(within(drafts).getAllByRole('checkbox')).toHaveLength(20)
  expect(drafts.textContent).toContain('合成检验01')
  expect(drafts.textContent).toContain('合成检验20')
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await user.click(screen.getByRole('checkbox', { name: '选择送检：合成检验21' }))
  expect(screen.getByText(/每次最多20项/)).toBeDefined()
  expect(within(drafts).getAllByRole('checkbox')).toHaveLength(20)
  expect(within(drafts).queryByRole('checkbox', { name: '待送检选择：合成检验21' })).toBeNull()
  await user.type(screen.getByRole('textbox', { name: '搜索送检申请' }), '合成检验01')
  expect(screen.getAllByRole('checkbox', { name: /^选择送检：/ })).toHaveLength(1)
  expect(drafts.textContent).toContain('已选 20 项')
  expect(drafts.textContent).toContain('合成检验20')
  await user.click(screen.getByRole('button', { name: '清空选择' }))
  expect(drafts.textContent).toContain('已选 0 项')
  expect(within(drafts).getAllByRole('checkbox')).toHaveLength(20)
  first.unmount()
  mount()
  drafts = await screen.findByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('已选 0 项')
  expect(within(drafts).getAllByRole('checkbox')).toHaveLength(20)
  await user.click(within(drafts).getByRole('button', { name: '丢弃送检草稿' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃送检草稿' })).getByRole('button', { name: '保留草稿' }))
  expect(screen.getByRole('region', { name: '送检待处理清单' })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '丢弃送检草稿' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃送检草稿' })).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  expect(api.facts().laboratoryRequests).toHaveLength(21)
  expect(api.posts).toEqual([])
})

it('已送检但仍issued的申请与其他不可送检状态显示禁选原因，全选只纳入可发送项', async () => {
  const api = server([
    laboratory(1, '合成可送检项目'), laboratory(2, '合成已送检项目'), laboratory(3, '合成已受理项目', 'accepted'),
    laboratory(4, '合成执行中项目', 'in-progress'), laboratory(5, '合成失败项目', 'generation-failed'), laboratory(6, '合成已取消项目', 'cancelled'),
  ])
  api.replace({ ...api.facts(), sent: [{ requestId: 'request-2', sentAt: '2026-08-24T09:10:00+08:00', sentBy: nurse.actor.actorId }] })
  mount()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: '选择送检：合成可送检项目' })
  for (const name of ['合成已送检项目', '合成已受理项目', '合成执行中项目', '合成失败项目', '合成已取消项目']) {
    const choice = screen.getByRole('checkbox', { name: `选择送检：${name}` })
    expect(choice.getAttribute('aria-disabled')).toBe('true')
    expect(choice.closest('article')?.textContent).toContain(name === '合成已送检项目' ? '已送检，不能重复送检' : '当前状态不可送检')
  }
  await user.click(screen.getByRole('button', { name: '全选本页可送检申请' }))
  const drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(within(drafts).getAllByRole('checkbox')).toHaveLength(1)
  expect(drafts.textContent).toContain('合成可送检项目')
  expect(drafts.textContent).toContain('已选 1 项')
  expect(api.posts).toEqual([])
})

it('集中核对期间申请版本变化时不发送；保留原选择并由护士显式更新核对', async () => {
  const api = server([laboratory(1, '合成待重审项目')])
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择送检：合成待重审项目' }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const preview = screen.getByRole('dialog', { name: '集中送检核对' })
  api.replace({ ...api.facts(), laboratoryRequests: api.facts().laboratoryRequests.map(request => ({ ...request, taskVersion: '2' })) })
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await within(preview).findByText('申请或送检状态已变化，请返回逐项更新核对；没有发送本次操作。')
  expect(api.posts).toEqual([])
  expect(within(preview).getByRole('button', { name: '确认送检' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(preview).getByRole('button', { name: '返回修改' }))
  const drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('已选 1 项')
  expect(drafts.textContent).toContain('申请已变化，请更新核对后重试')
  await user.click(within(drafts).getByRole('button', { name: '更新核对：合成待重审项目' }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中送检核对' })).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts).toHaveLength(1))
  expect(api.posts[0]!.body).toEqual({ input: { requestId: 'request-1', expectedRequestVersion: 1, serviceRequestVersion: '1', taskVersion: '2' } })
})

it('冻结原送检草稿持久化失败时不发送，重挂仍保留之前可靠保存的选择', async () => {
  const api = server([laboratory(1, '合成存储故障项目')])
  const first = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择送检：合成存储故障项目' }))
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('synthetic storage failure', 'QuotaExceededError') })
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const preview = screen.getByRole('dialog', { name: '集中送检核对' })
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await within(preview).findByText('申请或送检状态已变化，请返回逐项更新核对；没有发送本次操作。')
  expect(api.posts).toEqual([])
  await user.click(within(preview).getByRole('button', { name: '返回修改' }))
  expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('送检草稿无法可靠读取或保存，已阻止发送'))).toBe(true)
  expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 1 项')
  expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(true)
  first.unmount()
  storage.mockRestore()
  mount()
  const drafts = await screen.findByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('合成存储故障项目')
  expect(drafts.textContent).toContain('已选 1 项')
  expect(api.posts).toEqual([])
})

it('患者和完整受信身份分别隔离草稿，切离页面与重挂保留原患者选择，真实退出清理草稿', async () => {
  const api = server([laboratory(1, '合成身份隔离项目')])
  const view = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择送检：合成身份隔离项目' }))
  view.change({ active: false })
  expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 1 项')
  expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(true)
  view.change({ active: true })
  const nextAdmission = inpatientAdmissionSchema.parse({ ...admission, id: 'admission-2', patientId: 'patient-2', patientName: '另一合成患者' })
  api.replace({ ...api.facts(), admissionId: nextAdmission.id })
  view.change({ admission: nextAdmission })
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  api.replace({ ...api.facts(), admissionId: admission.id })
  view.change({ admission })
  expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 1 项')
  const identities: SessionContext[] = [
    { ...nurse, user: { ...nurse.user, id: 'other-account' } },
    ...['actorId', 'workspaceId', 'epoch', 'scenarioRunId', 'practitionerRoleId', 'practitionerId', 'organizationId', 'locationId'].map(field => ({
      ...nurse, actor: { ...nurse.actor, [field]: `other-${field}` },
    })),
  ]
  for (const session of identities) {
    api.identity(session)
    view.change({ session })
    expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
    api.identity(nurse)
    view.change({ session: nurse })
    expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 1 项')
  }
  view.unmount()
  const restored = mount()
  expect((await screen.findByRole('region', { name: '送检待处理清单' })).textContent).toContain('合成身份隔离项目')
  await act(async () => { await signOut() })
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  restored.unmount()
  mount()
  await screen.findByRole('checkbox', { name: '选择送检：合成身份隔离项目' })
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  expect(api.posts).toEqual([])
})

it('损坏草稿阻止发送，护士仍可显式确认丢弃后重新选择原申请', async () => {
  const api = server([laboratory(1, '合成损坏草稿项目')])
  const first = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择送检：合成损坏草稿项目' }))
  const storedKey = sessionStorage.key(0)!
  first.unmount()
  sessionStorage.setItem(storedKey, '{synthetic-invalid-json')
  mount()
  await screen.findByText('送检草稿无法可靠读取或保存，已阻止发送；请先恢复原操作。')
  expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(true)
  await user.click(screen.getByRole('button', { name: '丢弃送检草稿' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃送检草稿' })).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByText('送检草稿无法可靠读取或保存，已阻止发送；请先恢复原操作。')).toBeNull()
  await user.click(screen.getByRole('checkbox', { name: '选择送检：合成损坏草稿项目' }))
  expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 1 项')
  expect(api.posts).toEqual([])
})
