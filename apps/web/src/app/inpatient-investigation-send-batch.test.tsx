// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ExaminationRequest, ImagingRequest, LaboratoryRequest, SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { signOut } from './api-client.ts'
import { createDraftDiscard } from './draft-discard.ts'
import { hideUnknownDraftAtLogout } from './inpatient-draft-test-support.ts'
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

function laboratory(
  index: number,
  name: string,
  status: LaboratoryRequest['status'] = 'issued',
  options: { referenceCode?: string; specimenCode?: string; specimenDisplay?: string } = {},
) {
  const code = options.referenceCode ?? `synthetic-${index}`
  const specimenCode = options.specimenCode ?? 'whole-blood'
  const specimenDisplay = options.specimenDisplay ?? '合成全血'
  const referenceConcept = { id: `laboratory-${index}`, code, display: name, system: 'https://example.test/laboratory', version: '1', sourceLocator: 'synthetic-fixture' }
  return {
    id: `request-${index}`, catalogItemId: `laboratory-${index}`, indicationCode: 'screening', serviceRequestId: `service-request-${index}`,
    serviceRequestVersion: '1', taskId: `task-${index}`, taskVersion: '1', status, version: 1, referenceConcept,
    laboratoryService: {
      allowedIndicationCodes: ['screening'], componentServiceIds: [], doctorOrderable: true, executingDepartmentId: 'department-laboratory',
      id: `laboratory-${index}`, localCode: `synthetic-${index}`, nameZh: name, priceFen: 1000, referenceConcept, referenceReleaseId: 'synthetic-release',
      reportDefinition: { conclusionTemplate: '合成检验结论', results: [{ referenceConcept, referenceRange: { text: '合成正常' }, valueType: 'boolean', allowedValues: [false, true] }] },
      specimen: { code: specimenCode, display: specimenDisplay, system: 'https://example.test/specimen' }, serviceKind: 'laboratory', tatMinutes: 30, version: 1,
    },
  }
}

type Post = { requestId: string; key: string | null; body: unknown }

function server(
  requests = [
    laboratory(1, '合成白细胞计数'),
    laboratory(2, '合成血红蛋白'),
    laboratory(3, '合成肌酐测定', 'issued', { specimenCode: 'serum', specimenDisplay: '合成血清' }),
  ],
  extra: { examinationRequests?: ExaminationRequest[]; imagingRequests?: ImagingRequest[] } = {},
) {
  let activeSession = nurse
  let facts = inpatientInvestigationsSchema.parse({
    admissionId: admission.id,
    laboratoryRequests: requests,
    imagingRequests: extra.imagingRequests ?? [],
    examinationRequests: extra.examinationRequests ?? [],
    sent: [],
  })
  const posts: Post[] = []
  const receiptKeys: string[] = []
  const receipts = new Map<string, unknown>()
  let loseResponseFor: string | undefined
  let rejectedRequest: string | undefined
  let delayedRequest: string | undefined
  let responseGate: Promise<void> | undefined
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
      if (body.input.requestId === rejectedRequest) return Response.json({ error: { code: 'VERSION_CONFLICT', message: '合成版本冲突，请重新核对申请' } }, { status: 409 })
      if (!facts.sent.some(item => item.requestId === body.input.requestId)) {
        facts = inpatientInvestigationsSchema.parse({ ...facts, sent: [...facts.sent, { requestId: body.input.requestId, sentAt: '2026-08-24T09:10:00+08:00', sentBy: nurse.actor.actorId }] })
      }
      const response = envelope()
      receipts.set(key!, response)
      if (body.input.requestId === loseResponseFor) throw new TypeError('synthetic committed response loss')
      if (body.input.requestId === delayedRequest) await responseGate
      return Response.json(response)
    }
    if (path.endsWith('/investigations')) return Response.json(facts)
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, receiptKeys, facts: () => facts, replace: (next: unknown) => { facts = inpatientInvestigationsSchema.parse(next) },
    identity: (next: SessionContext) => { activeSession = next },
    reject: (requestId: string) => { rejectedRequest = requestId },
    delayResponse: (requestId: string) => {
      delayedRequest = requestId
      let release: () => void = () => undefined
      responseGate = new Promise<void>(resolve => { release = resolve })
      return () => { release() }
    },
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

it('退出清理删除失败后重挂不回显送检私稿，持久标记补清理后可保存新选择', async () => {
  const api = server([
    laboratory(1, '合成白细胞计数'),
    laboratory(2, '合成肌酐测定', 'issued', { specimenCode: 'serum', specimenDisplay: '合成血清' }),
  ])
  const user = userEvent.setup(), original = mount()
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  const prefix = 'clinmesh.investigation-send:v1:'
  const key = Object.keys(sessionStorage).find(key => key.startsWith(prefix))!
  expect(key).toBeDefined()
  const remove = Storage.prototype.removeItem
  const denied = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, target) {
    if (target.startsWith(prefix)) throw new DOMException('合成退出删除失败', 'SecurityError')
    remove.call(this, target)
  })
  try {
    await act(async () => { await expect(signOut()).resolves.toBeUndefined() })
    expect(sessionStorage.getItem(key)).not.toBeNull()
    original.unmount()
    const unavailable = mount()
    await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
    expect(within(screen.getByRole('region', { name: '送检待处理清单' })).queryByRole('checkbox')).toBeNull()
    unavailable.unmount()
    denied.mockRestore()
    expect(createDraftDiscard(prefix).read(key)).toBeNull()
    const restored = mount()
    await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：促凝黄头管/ }))
    restored.unmount()
    mount()
    const list = await screen.findByRole('region', { name: '送检待处理清单' })
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(list).getByRole('checkbox', { name: /^待送检采血管：促凝黄头管/ }).getAttribute('aria-checked')).toBe('true')
    expect(list.textContent).not.toContain('合成白细胞计数')
    expect(api.posts).toHaveLength(0)
  } finally { denied.mockRestore() }
})

it.each([false, true])('按采血管合管核对后逐项结算；响应丢失后停止余管，坏稿遮蔽原尝试=%s', async poisonedLogout => {
  const api = server()
  api.loseResponse('request-2')
  const first = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  await user.click(screen.getByRole('checkbox', { name: /^选择采血管：促凝黄头管/ }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  let preview = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(preview.textContent).toContain('共 2 管采血（合并 3 项检验）')
  expect(within(preview).getAllByRole('article')).toHaveLength(2)
  expect(preview.textContent).toContain('EDTA-K2 紫头管')
  expect(preview.textContent).toContain('促凝黄头管')
  expect(preview.textContent).toContain('待送检')
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2']))
  const results = await screen.findByRole('region', { name: '送检逐项结果' })
  expect(results.textContent).toContain('合成白细胞计数')
  expect(results.textContent).toMatch(/成功|已送检/)
  expect(results.textContent).toContain('合成血红蛋白')
  await screen.findByRole('button', { name: '恢复原送检' })
  expect(screen.getByRole('button', { name: '丢弃送检清单' }).hasAttribute('disabled')).toBe(true)
  const pendingDrafts = screen.getByRole('region', { name: '送检待处理清单' })
  const unknownTube = within(pendingDrafts).getByRole('checkbox', { name: /^待送检采血管：EDTA-K2 紫头管/ }).closest('article')!
  expect(unknownTube.textContent).toContain('送检结果待确认，请恢复原送检')
  first.unmount()

  if (poisonedLogout) {
    const hidden = await hideUnknownDraftAtLogout('clinmesh.investigation-send:v1:')
    mount()
    await user.click(await screen.findByRole('button', { name: '丢弃送检清单' }))
    await user.click(within(screen.getByRole('dialog', { name: '丢弃送检清单' })).getByRole('button', { name: '确认丢弃' }))
    expect(sessionStorage.getItem(hidden.key)).toBe(hidden.raw)
    expect(sessionStorage.getItem(hidden.blocker)).toBe('{synthetic-corrupted')
    expect(api.posts).toHaveLength(2)
    return
  }

  mount()
  await user.click(await screen.findByRole('button', { name: '恢复原送检' }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[1]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原送检' })).toBeNull())
  expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2'])
  expect(api.facts().sent.map(item => item.requestId)).toEqual(['request-1', 'request-2'])
  expect(api.facts().laboratoryRequests.map(request => [request.status, request.version])).toEqual([['issued', 1], ['issued', 1], ['issued', 1]])

  await user.click(screen.getByRole('button', { name: '集中送检' }))
  preview = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(within(preview).getAllByRole('article')).toHaveLength(1)
  expect(preview.textContent).toContain('合成肌酐测定')
  expect(api.posts).toHaveLength(2)
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2', 'request-3']))
  expect(new Set(api.posts.map(post => post.key)).size).toBe(3)
  await waitFor(() => expect(api.facts().sent).toHaveLength(3))
})

it('全选只作用于本页送检单元；整管超出二十项上限时整管拦截且不产生半管勾选', async () => {
  const customItems = Array.from({ length: 18 }, (_, index) =>
    laboratory(index + 1, `合成特检${String(index + 1).padStart(2, '0')}`, 'issued', {
      specimenCode: `custom-${index + 1}`,
      specimenDisplay: `特殊体液${index + 1}`,
    }),
  )
  const purpleItems = [
    laboratory(19, '合成白细胞计数'),
    laboratory(20, '合成血红蛋白'),
    laboratory(21, '合成血小板计数'),
  ]
  const api = server([...customItems, ...purpleItems])
  const first = mount()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: /合成特检01/ })
  expect(screen.getAllByRole('checkbox', { name: /^选择采血管：/ })).toHaveLength(10)
  await user.click(screen.getByRole('button', { name: '全选本页可送检申请' }))
  let drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('已选 10 项')
  await user.click(screen.getByRole('button', { name: '下一页' }))
  expect(screen.getAllByRole('checkbox', { name: /^选择采血管：/ })).toHaveLength(9)
  for (let idx = 11; idx <= 18; idx += 1) {
    await user.click(screen.getByRole('checkbox', { name: new RegExp(`^选择采血管：.*合成特检${String(idx).padStart(2, '0')}`) }))
  }
  drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('已选 18 项')
  // 再勾选含 3 项的紫头管（18 + 3 = 21 > 20）须整管拦截，不产生半管勾选
  const purpleChoice = screen.getByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  await user.click(purpleChoice)
  expect(screen.getByText(/每次最多保留20项/)).toBeDefined()
  expect(purpleChoice.getAttribute('aria-checked')).toBe('false')
  expect(drafts.textContent).toContain('已选 18 项')
  expect(drafts.textContent).not.toContain('合成白细胞计数')

  await user.type(screen.getByRole('textbox', { name: '搜索送检申请' }), 'EDTA-K2 紫头管')
  expect(screen.getAllByRole('checkbox', { name: /^选择采血管：/ })).toHaveLength(1)
  expect(drafts.textContent).toContain('已选 18 项')
  await user.click(screen.getByRole('button', { name: '清空选择' }))
  expect(drafts.textContent).toContain('已选 0 项')
  first.unmount()
  mount()
  drafts = await screen.findByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('已选 0 项')
  await user.click(within(drafts).getByRole('button', { name: '丢弃送检清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃送检清单' })).getByRole('button', { name: '保留清单' }))
  expect(screen.getByRole('region', { name: '送检待处理清单' })).toBeDefined()
  await user.click(screen.getByRole('button', { name: '丢弃送检清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃送检清单' })).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  expect(api.facts().laboratoryRequests).toHaveLength(21)
  expect(api.posts).toEqual([])
}, 20_000)

it('已送检但仍issued的申请与其他不可送检状态独立展示禁选原因，绝不混入待采血管卡片', async () => {
  const api = server([
    laboratory(1, '合成可送检项目'),
    laboratory(2, '合成已送检项目'),
    laboratory(3, '合成已受理项目', 'accepted'),
    laboratory(4, '合成执行中项目', 'in-progress'),
    laboratory(5, '合成失败项目', 'generation-failed'),
    laboratory(6, '合成已取消项目', 'cancelled'),
  ])
  api.replace({ ...api.facts(), sent: [{ requestId: 'request-2', sentAt: '2026-08-24T09:10:00+08:00', sentBy: nurse.actor.actorId }] })
  mount()
  const user = userEvent.setup()
  const purpleTube = await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  expect(purpleTube.closest('article')?.textContent).toContain('合成可送检项目')
  expect(purpleTube.closest('article')?.textContent).not.toContain('合成已送检项目')
  expect(purpleTube.closest('article')?.textContent).not.toContain('合成已取消项目')
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
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
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
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('synthetic storage failure', 'QuotaExceededError') })
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const preview = screen.getByRole('dialog', { name: '集中送检核对' })
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await within(preview).findByText('申请或送检状态已变化，请返回逐项更新核对；没有发送本次操作。')
  expect(api.posts).toEqual([])
  await user.click(within(preview).getByRole('button', { name: '返回修改' }))
  expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('送检清单无法可靠读取或保存，已阻止发送'))).toBe(true)
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
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
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
  await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  expect(api.posts).toEqual([])
})

it.each([false, true])('损坏草稿阻止发送，退出=%s时仍可显式确认丢弃后重新选择原申请', async logout => {
  const api = server([laboratory(1, '合成损坏草稿项目')])
  const first = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  const storedKey = sessionStorage.key(0)!
  first.unmount()
  sessionStorage.setItem(storedKey, '{synthetic-invalid-json')
  if (logout) await act(async () => { await signOut() })
  mount()
  await screen.findByText('送检清单无法可靠读取或保存，已阻止发送；请先恢复原操作。')
  expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(true)
  expect(sessionStorage.getItem(storedKey)).toBe('{synthetic-invalid-json')
  await user.click(screen.getByRole('button', { name: '丢弃送检清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃送检清单' })).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByText('送检清单无法可靠读取或保存，已阻止发送；请先恢复原操作。')).toBeNull()
  await user.click(screen.getByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 1 项')
  expect(api.posts).toEqual([])
})

it('切患者后迟到成功只结算原患者，保留新患者已有选择且不显示原患者结果', async () => {
  const api = server([laboratory(1, '合成原患者项目')])
  const original = api.facts()
  const release = api.delayResponse('request-1')
  const view = mount()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  const otherAdmission = inpatientAdmissionSchema.parse({ ...admission, id: 'admission-2', patientId: 'patient-2', patientName: '另一合成患者' })
  const otherFacts = inpatientInvestigationsSchema.parse({ admissionId: otherAdmission.id, laboratoryRequests: [laboratory(2, '合成新患者项目')], imagingRequests: [], sent: [] })
  api.replace(otherFacts)
  view.change({ admission: otherAdmission })
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  api.replace(original)
  view.change({ admission })
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中送检核对' })).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts).toHaveLength(1))
  const completedOriginal = api.facts()
  api.replace(otherFacts)
  view.change({ admission: otherAdmission })
  await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  await act(async () => { release() })
  await waitFor(() => expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(false))
  const drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('合成新患者项目')
  expect(drafts.textContent).toContain('已选 1 项')
  expect(drafts.textContent).not.toContain('合成原患者项目')
  expect(screen.queryByRole('region', { name: '送检逐项结果' })).toBeNull()
  api.replace(completedOriginal)
  view.change({ admission })
  const results = await screen.findByRole('region', { name: '送检逐项结果' })
  expect(results.textContent).toContain('合成原患者项目：已送检')
  expect(screen.queryByRole('region', { name: '送检待处理清单' })).toBeNull()
  expect(api.posts.map(post => post.requestId)).toEqual(['request-1'])
})

it('同管内确定拒绝保留失败项目的原选择，其余独立申请继续送检并分别展示结果', async () => {
  const api = server([laboratory(1, '合成拒绝项目'), laboratory(2, '合成可完成项目')])
  api.reject('request-1')
  mount()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  await user.click(screen.getByRole('button', { name: '全选本页可送检申请' }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中送检核对' })).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts.map(post => post.requestId)).toEqual(['request-1', 'request-2']))
  const results = screen.getByRole('region', { name: '送检逐项结果' })
  await waitFor(() => expect(results.textContent).toContain('合成可完成项目：已送检'))
  expect(results.textContent).toContain('合成拒绝项目：送检失败：合成版本冲突，请重新核对申请')
  const drafts = screen.getByRole('region', { name: '送检待处理清单' })
  expect(drafts.textContent).toContain('合成拒绝项目')
  expect(drafts.textContent).not.toContain('合成可完成项目')
  expect(drafts.textContent).toContain('已选 1 项')
  expect(api.facts().sent.map(item => item.requestId)).toEqual(['request-2'])
  expect(screen.queryByRole('button', { name: '恢复原送检' })).toBeNull()
})

it('集中送检列表与核对弹窗将 clinical-assessment 映射为中文临床评估而不裸露内部编码', async () => {
  const assessmentItem = {
    ...laboratory(1, '合成入院肌酐', 'issued', { specimenCode: 'serum', specimenDisplay: '合成血清' }),
    indicationCode: 'clinical-assessment',
    laboratoryService: { ...laboratory(1, '合成入院肌酐', 'issued', { specimenCode: 'serum', specimenDisplay: '合成血清' }).laboratoryService, allowedIndicationCodes: ['clinical-assessment'] },
  }
  server([assessmentItem])
  mount()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: /^选择采血管：促凝黄头管/ })
  const section = screen.getByRole('region', { name: '集中送检' })
  expect(section.textContent).toContain('临床评估')
  expect(section.textContent).not.toContain('clinical-assessment')
  await user.click(screen.getByRole('checkbox', { name: /^选择采血管：促凝黄头管/ }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const reviewDialog = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(reviewDialog.textContent).toContain('临床评估')
  expect(reviewDialog.textContent).not.toContain('clinical-assessment')
})

it('按采血管规则合并全血、血清、抗凝血浆与尿液，血沉黑头管及混合标本独立成卡，功能检查与放射检查并列送检', async () => {
  const exam: ExaminationRequest = {
    id: 'exam-1',
    indication: '合成胸痛心电评估',
    previousReports: [],
    service: {
      applicability: '成人',
      bodySite: '心脏',
      code: 'ECG-12',
      department: '心电图室',
      examCode: 'ecg-12-lead',
      id: 'examination-ecg-12-lead',
      method: '常规十二导联',
      modality: 'ECG',
      name: '常规十二导联心电图',
      reportSections: ['findings', 'impression'],
      version: 1,
    },
    serviceRequestId: 'sr-exam-1',
    serviceRequestVersion: '1',
    status: 'issued',
    taskId: 'task-exam-1',
    taskVersion: '1',
    version: 1,
  }
  const imaging: ImagingRequest = {
    id: 'img-1',
    indication: '合成胸部影像排查',
    previousReports: [],
    service: {
      applicability: '成人',
      bodySite: '胸部',
      code: 'DR-CHEST',
      department: '放射科',
      examCode: 'chest-radiograph',
      id: 'imaging-chest-radiograph',
      method: '正位数字化摄影',
      modality: 'DX',
      name: '胸部正位片',
      reportSections: ['findings', 'impression'],
      version: 1,
    },
    serviceRequestId: 'sr-img-1',
    serviceRequestVersion: '1',
    status: 'issued',
    taskId: 'task-img-1',
    taskVersion: '1',
    version: 1,
  }
  const api = server([
    laboratory(1, '白细胞计数', 'issued', { referenceCode: '6690-2', specimenCode: 'whole-blood', specimenDisplay: '全血' }),
    laboratory(2, '血红蛋白', 'issued', { referenceCode: '718-7', specimenCode: 'whole-blood', specimenDisplay: '全血' }),
    laboratory(3, '血小板计数', 'issued', { referenceCode: '777-3', specimenCode: 'whole-blood', specimenDisplay: '全血' }),
    laboratory(4, '红细胞沉降率测定', 'issued', { referenceCode: '0300101A', specimenCode: 'whole-blood', specimenDisplay: '全血' }),
    laboratory(5, '丙氨酸氨基转移酶', 'issued', { referenceCode: '1742-6', specimenCode: 'serum', specimenDisplay: '血清' }),
    laboratory(6, '肌酐', 'issued', { referenceCode: '2160-0', specimenCode: 'serum', specimenDisplay: '血清' }),
    laboratory(7, '国际标准化比值 INR', 'issued', { referenceCode: '6301-6', specimenCode: 'citrated-plasma', specimenDisplay: '枸橼酸盐抗凝血浆' }),
    laboratory(8, '尿常规', 'issued', { referenceCode: 'CN-LAB-URINALYSIS', specimenCode: 'urine', specimenDisplay: '尿液' }),
    laboratory(9, '炎症指标组合一', 'issued', { referenceCode: 'CN-LAB-INFLAMMATION', specimenCode: 'mixed', specimenDisplay: '混合标本' }),
    laboratory(10, '炎症指标组合二', 'issued', { referenceCode: 'CN-LAB-INFLAMMATION', specimenCode: 'mixed', specimenDisplay: '混合标本' }),
  ], { examinationRequests: [exam], imagingRequests: [imaging] })

  mount()
  const user = userEvent.setup()
  const purpleTube = await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ })
  expect(purpleTube.closest('article')?.textContent).toContain('合并 3 项')
  expect(purpleTube.closest('article')?.textContent).not.toContain('红细胞沉降率测定')

  const blackTube = screen.getByRole('checkbox', { name: /^选择采血管：枸橼酸钠黑头管/ })
  expect(blackTube.closest('article')?.textContent).toContain('红细胞沉降率测定')

  const yellowTube = screen.getByRole('checkbox', { name: /^选择采血管：促凝黄头管/ })
  expect(yellowTube.closest('article')?.textContent).toContain('合并 2 项')

  expect(screen.getByRole('checkbox', { name: /^选择采血管：枸橼酸钠蓝头管/ })).toBeDefined()
  expect(screen.getByRole('checkbox', { name: /^选择采血管：一次性清洁尿管/ })).toBeDefined()
  expect(screen.getAllByRole('checkbox', { name: /^选择采血管：多管分装采集/ })).toHaveLength(2)

  const examChoice = screen.getByRole('checkbox', { name: '选择送检：常规十二导联心电图' })
  expect(examChoice.closest('article')?.textContent).toContain('功能检查')
  const imagingChoice = screen.getByRole('checkbox', { name: '选择送检：胸部正位片' })
  expect(imagingChoice.closest('article')?.textContent).toContain('放射检查')

  await user.click(purpleTube)
  await user.click(yellowTube)
  await user.click(examChoice)
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const dialog = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(dialog.textContent).toContain('共 2 管采血（合并 5 项检验）')
  expect(dialog.textContent).toContain('另含 1 项检查')
  expect(within(dialog).getAllByRole('article')).toHaveLength(3)
  await user.click(within(dialog).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts).toHaveLength(6))

  // 仅选尿液或混合标本容器时不误标为「采血」
  await user.click(screen.getByRole('checkbox', { name: /^选择采血管：一次性清洁尿管/ }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const urineDialog = screen.getByRole('dialog', { name: '集中送检核对' })
  expect(urineDialog.textContent).toContain('共 1 份标本容器（合并 1 项检验）')
  expect(urineDialog.textContent).not.toContain('1 管采血')
})

it('同采血管新增待送检项目时拦截半管送检并支持整管同步勾选；已失效清单管仍可整管取消勾选', async () => {
  const api = server([laboratory(1, '合成白细胞计数')])
  const view = mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: /^选择采血管：EDTA-K2 紫头管/ }))
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  const preview = screen.getByRole('dialog', { name: '集中送检核对' })

  // 核对期间医生向同一紫头管新增一项全血检验：确认送检时拦截半管提交
  api.replace({
    ...api.facts(),
    laboratoryRequests: [
      ...api.facts().laboratoryRequests,
      laboratory(2, '合成血小板计数'),
    ],
  })
  await user.click(within(preview).getByRole('button', { name: '确认送检' }))
  await within(preview).findByText('申请或送检状态已变化，请返回逐项更新核对；没有发送本次操作。')
  expect(api.posts).toEqual([])
  await user.click(within(preview).getByRole('button', { name: '返回修改' }))
  await act(async () => { await view.refresh() })

  const drafts = screen.getByRole('region', { name: '送检待处理清单' })
  await within(drafts).findByText('同采血管新增了待送检检验，请整管同步勾选。')
  expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(true)

  await user.click(within(drafts).getByRole('button', { name: '整管同步勾选' }))
  expect(drafts.textContent).toContain('已选 2 项')
  expect(screen.getByRole('button', { name: '集中送检' }).hasAttribute('disabled')).toBe(false)

  // 若清单内申请全部取消，护士仍可在清单中取消勾选以清空无效已选项
  api.replace({
    ...api.facts(),
    laboratoryRequests: api.facts().laboratoryRequests.map(item => ({ ...item, status: 'cancelled' as const })),
  })
  await act(async () => { await view.refresh() })
  await within(drafts).findAllByText('当前状态不可送检。')
  await user.click(within(drafts).getByRole('checkbox', { name: /^待送检采血管：EDTA-K2 紫头管/ }))
  expect(drafts.textContent).toContain('已选 0 项')
})

it('同一采血管超过 20 项待送检申请时自动拆分为有界 20 项分管，可分两批无死锁完成全部送检', async () => {
  const twentyTwoSerum = Array.from({ length: 22 }, (_, index) =>
    laboratory(index + 1, `合成血清项目${String(index + 1).padStart(2, '0')}`, 'issued', {
      specimenCode: 'serum',
      specimenDisplay: '血清',
    }),
  )
  const api = server(twentyTwoSerum)
  mount()
  const user = userEvent.setup()
  const tubeChoices = await screen.findAllByRole('checkbox', { name: /^选择采血管：促凝黄头管/ })
  expect(tubeChoices).toHaveLength(2)

  // 首支分管含 20 项，可直接勾选并完成送检
  await user.click(tubeChoices[0]!)
  expect(screen.getByRole('region', { name: '送检待处理清单' }).textContent).toContain('已选 20 项')
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中送检核对' })).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts).toHaveLength(20))

  // 首批 20 项转为已送检历史（占前 2 页），翻至第 3 页勾选剩余 2 项黄头管完成第二批送检
  await waitFor(() => expect(screen.getByText('1/3')).toBeDefined())
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await user.click(screen.getByRole('button', { name: '下一页' }))
  const remainingTube = await screen.findByRole('checkbox', { name: /^选择采血管：促凝黄头管/ })
  await user.click(remainingTube)
  await user.click(screen.getByRole('button', { name: '集中送检' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中送检核对' })).getByRole('button', { name: '确认送检' }))
  await waitFor(() => expect(api.posts).toHaveLength(22))
  expect(api.facts().sent).toHaveLength(22)
}, 20_000)
