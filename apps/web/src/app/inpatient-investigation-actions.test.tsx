// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientInvestigationResponseSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearInpatientInvestigationActionDrafts } from './inpatient-investigation-action-drafts.ts'
import { InpatientInvestigations } from './inpatient-investigations.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'
import { createDraftDiscard } from './draft-discard.ts'

const session: SessionContext = { actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1',
  scenarioRunId: 'scenario-run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor', locationId: 'doctor-room' },
  user: { id: 'user-doctor', name: '合成住院医生', email: 'inpatient-doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成取消患者', inpatientNumber: 'ZY-SYNTHETIC',
  admissionRoute: 'direct', wardId: 'ward-general', organizationId: 'organization-inpatient', status: 'admitted', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', admittedAt: '2026-08-24T09:10:00+08:00', depositFen: 0, chargesFen: 0, versionId: '2' })
type Facts = ReturnType<typeof inpatientInvestigationsSchema.parse>
const makeRequest = (index: number) => ({ id: `request-${index}`, catalogItemId: `laboratory-${index}`, indicationCode: 'routine',
  referenceConcept: { id: `concept-${index}`, code: `LAB-${index}`, display: `合成检验项目${index}`, sourceLocator: `synthetic:${index}`, system: 'https://synthetic.invalid/laboratory', version: '1' },
  serviceRequestId: `service-${index}`, serviceRequestVersion: '1', taskId: `task-${index}`, taskVersion: '1', version: 1, status: 'issued', previousReports: [] })

function fixture(count = 2, options: { dropResponse?: number; rejectRequest?: number; receiptFailures?: number; holdResponse?: number } = {}) {
  let facts = inpatientInvestigationsSchema.parse({ admissionId: admission.id, laboratoryRequests: Array.from({ length: count }, (_, index) => makeRequest(index + 1)), imagingRequests: [], sent: [] })
  const posts: { path: string; key: string | null; input: { requestId: string } }[] = []
  const receipts = new Map<string, ReturnType<typeof inpatientInvestigationResponseSchema.parse>>()
  const receiptKeys: string[] = []
  let releaseResponse: () => void = () => undefined
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/auth/sign-out') return Response.json({})
    if (path.endsWith('/investigation-catalog')) return Response.json({ items: [] })
    if (path.endsWith('/investigations')) return Response.json(facts)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const key = new URL(path, 'http://localhost').searchParams.get('idempotencyKey')!
      receiptKeys.push(key)
      if (options.receiptFailures) { options.receiptFailures -= 1; return Response.json({ error: { code: 'SYNTHETIC_RECEIPT_UNAVAILABLE', message: '合成回执读取暂不可用' } }, { status: 503 }) }
      const response = receipts.get(key)!
      return Response.json({ operationId: new URL(path, 'http://localhost').searchParams.get('operationId'), idempotencyKey: key, status: 'completed', response })
    }
    if (init?.method === 'POST') {
      const { input } = JSON.parse(String(init.body))
      posts.push({ path, key: new Headers(init.headers).get('idempotency-key'), input })
      if (options.rejectRequest === posts.length) return Response.json({ error: { code: 'INPATIENT_INVESTIGATION_VERSION_CONFLICT', message: 'Private upstream Task version conflict' } }, { status: 409 })
      const original = facts.laboratoryRequests.find(item => item.id === input.requestId)!
      const retry = path.endsWith('/retry')
      facts = { ...facts, laboratoryRequests: facts.laboratoryRequests.map(item => item.id === input.requestId ? {
        ...item, status: retry ? 'in-progress' : 'cancelled', version: item.version + 1,
        serviceRequestVersion: String(BigInt(item.serviceRequestVersion) + (retry ? 0n : 1n)), taskVersion: String(BigInt(item.taskVersion) + 1n),
      } : item) }
      const response = inpatientInvestigationResponseSchema.parse({ auditId: 'audit-synthetic', requestId: 'http-synthetic', warnings: [], effects: [
        ...(!retry ? [{ kind: 'updated', reference: `ServiceRequest/${original.serviceRequestId}`, versionId: String(BigInt(original.serviceRequestVersion) + 1n) }] : []),
        { kind: 'updated', reference: `Task/${original.taskId}`, versionId: String(BigInt(original.taskVersion) + 1n) },
      ], data: facts })
      receipts.set(new Headers(init.headers).get('idempotency-key')!, response)
      if (options.holdResponse === posts.length) await responseGate
      if (options.dropResponse === posts.length) throw new TypeError('合成已提交但响应丢失')
      return Response.json(response)
    }
    throw new Error(`Unexpected request ${path}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  function Content({ context, stay }: { context: SessionContext; stay: typeof admission }) {
    const write = useInpatientWriteIntent(context, async () => { await client.invalidateQueries({ queryKey: ['inpatient'] }) })
    return <InpatientInvestigations admission={stay} session={context} locale="zh-CN" write={write} />
  }
  const mount = (context = session, stay = admission) => render(<QueryClientProvider client={client}><Content context={context} stay={stay} /></QueryClientProvider>)
  return { mount, posts, receiptKeys, releaseResponse, read: () => facts, update: (value: Facts) => { facts = value }, client }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

it('退出清理删除失败后重挂不回显检查动作私稿，持久标记补清理后可保存新选择', async () => {
  const s = fixture(), user = userEvent.setup(), original = s.mount()
  await user.click(await screen.findByRole('checkbox', { name: /^选择取消申请：合成检验项目1/ }))
  const prefix = 'clinmesh.inpatient-investigation-actions:v1:'
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
    const unavailable = s.mount()
    await screen.findByRole('checkbox', { name: /^选择取消申请：合成检验项目1/ })
    expect(within(screen.getByRole('region', { name: '取消申请待处理清单' })).queryByRole('checkbox')).toBeNull()
    unavailable.unmount()
    denied.mockRestore()
    expect(createDraftDiscard(prefix).read(key)).toBeNull()
    const restored = s.mount()
    await user.click(await screen.findByRole('checkbox', { name: /^选择取消申请：合成检验项目2/ }))
    restored.unmount()
    s.mount()
    const list = await screen.findByRole('region', { name: '取消申请待处理清单' })
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1)
    expect(list.textContent).toContain('合成检验项目2')
    expect(list.textContent).not.toContain('合成检验项目1')
    expect(s.posts).toHaveLength(0)
  } finally { denied.mockRestore() }
})

it('失败重试独立选择两条可恢复申请，不选择不支持的失败，也不将重新生成显示成已出报告', async () => {
  const s = fixture(3), user = userEvent.setup()
  s.update({ ...s.read(), laboratoryRequests: s.read().laboratoryRequests.map((item, index) => ({ ...item, status: 'generation-failed',
    generationError: { code: index === 2 ? 'INVESTIGATION_UNSUPPORTED' : 'SYNTHETIC_PROVIDER_UNAVAILABLE', message: index === 2 ? '合成来源不支持' : '合成生成暂不可用' } })) })
  s.mount()
  await user.click(await screen.findByRole('button', { name: '失败重试' }))
  expect(screen.getByRole('checkbox', { name: /^选择重新生成：合成检验项目3/ }).getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '全选本页可重新生成' }))
  await user.click(screen.getByRole('button', { name: '集中重新生成' }))
  const dialog = screen.getByRole('dialog', { name: '集中重试结果生成' })
  expect(within(dialog).getAllByRole('article')).toHaveLength(2)
  await user.click(within(dialog).getByRole('button', { name: '确认重新生成' }))
  await waitFor(() => expect(within(screen.getByRole('region', { name: '重新生成逐项结果' })).getByText('成功 2/2')).toBeDefined())
  expect(s.posts.every(item => item.path.endsWith('/investigations/retry'))).toBe(true)
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['in-progress', 'in-progress', 'generation-failed'])
  expect(screen.getByRole('status').textContent).toBe('已提交重新生成')
})

it('第二项已提交但响应丢失时停止第三项，刷新后按原回执恢复且余项必须重新核对', async () => {
  const s = fixture(3, { dropResponse: 2 }), user = userEvent.setup()
  const first = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  await screen.findByRole('button', { name: '恢复原取消申请' })
  await waitFor(() => expect(s.posts).toHaveLength(2))
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['cancelled', 'cancelled', 'issued'])
  const originalKey = s.posts[1]!.key
  const intentKey = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-intent:'))!
  const originalIntent = sessionStorage.getItem(intentKey)
  expect(originalIntent).not.toBeNull()
  const discard = screen.getByRole('button', { name: '丢弃待处理清单' })
  expect(discard).toHaveProperty('disabled', true)
  await user.click(discard)
  expect(sessionStorage.getItem(intentKey)).toBe(originalIntent)
  first.unmount()
  s.mount()
  await user.click(await screen.findByRole('button', { name: '恢复原取消申请' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消申请' })).toBeNull())
  expect(s.receiptKeys).toEqual([originalKey])
  expect(s.posts).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const review = screen.getByRole('dialog', { name: '集中取消检查申请' })
  expect(within(review).getAllByRole('article')).toHaveLength(1)
  expect(review.textContent).toContain('合成检验项目3')
  await user.click(within(review).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已完成取消申请'))
  expect(s.posts).toHaveLength(3)
  expect(new Set(s.posts.map(item => item.input.requestId)).size).toBe(3)
  expect(new Set(s.posts.map(item => item.key)).size).toBe(3)
})

it('核对窗口使用临床指征中文与安全失败说明，并明确既有固定取消理由', async () => {
  const s = fixture(), user = userEvent.setup()
  s.update({ ...s.read(), laboratoryRequests: s.read().laboratoryRequests.map(item => ({ ...item, indicationCode: 'clinical-assessment', status: 'generation-failed',
    generationError: { code: 'AI_REQUEST_FAILED', message: 'Provider private upstream unavailable' } })) })
  s.mount()
  const actions = await screen.findByRole('region', { name: '检查申请集中办理' })
  expect(actions.textContent).not.toContain('Provider private upstream unavailable')
  expect(actions.textContent).not.toContain('clinical-assessment')
  expect(actions.textContent).toContain('临床评估')
  expect(actions.textContent).toContain('无法连接结果生成服务')
  await user.click(screen.getByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const dialog = screen.getByRole('dialog', { name: '集中取消检查申请' })
  for (const item of within(dialog).getAllByRole('article')) expect(item.textContent).toContain('取消理由：不再需要')
  expect(within(dialog).queryByRole('textbox')).toBeNull()
})

it('仅全选当前十条，跨页搜索保留完整清单，超过二十条不截断，清空勾选与移除及确认丢弃分别办理', async () => {
  const s = fixture(26), user = userEvent.setup()
  const mounted = s.mount()
  const all = await screen.findByRole('button', { name: '全选本页可取消申请' })
  await user.click(all)
  const list = () => screen.getByRole('region', { name: '取消申请待处理清单' })
  expect(within(list()).getAllByRole('article')).toHaveLength(10)
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await user.click(all)
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '下一页' }))
  await user.click(all)
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  expect(screen.getByRole('alert').textContent).toContain('每次最多保留20条')
  await user.type(screen.getByRole('textbox', { name: '搜索待处理检查申请' }), '合成检验项目26')
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '清空选择' }))
  expect(list().textContent).toContain('已选 0 条')
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  await user.click(within(list()).getByRole('button', { name: '移除：合成检验项目1' }))
  expect(within(list()).getAllByRole('article')).toHaveLength(19)
  await user.click(screen.getByRole('checkbox', { name: /^选择取消申请：合成检验项目26/ }))
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  expect(list().textContent).toContain('已选 1 条')
  await user.click(screen.getByRole('button', { name: '失败重试' }))
  expect(screen.queryByRole('region', { name: '重新生成待处理清单' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '取消申请' }))
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  mounted.unmount()
  s.mount()
  expect(within(await screen.findByRole('region', { name: '取消申请待处理清单' })).getAllByRole('article')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '丢弃待处理清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃待处理清单' })).getByRole('button', { name: '保留待处理清单' }))
  expect(within(list()).getAllByRole('article')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '丢弃待处理清单' }))
  await user.click(within(screen.getByRole('dialog', { name: '丢弃待处理清单' })).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByRole('region', { name: '取消申请待处理清单' })).toBeNull()
  expect(s.posts).toHaveLength(0)
})

it('账号、完整Actor和患者住院改变时不展示原清单，回到原绑定才恢复', async () => {
  const s = fixture(), user = userEvent.setup()
  const original = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  original.unmount()
  const contexts: SessionContext[] = [
    { ...session, user: { ...session.user, id: 'other-account' } },
    ...['actorId', 'workspaceId', 'epoch', 'scenarioRunId', 'practitionerRoleId', 'practitionerId', 'organizationId', 'locationId'].map(field => ({
      ...session, actor: { ...session.actor, [field]: `other-${field}` },
    })),
  ]
  for (const context of contexts) {
    const other = s.mount(context)
    await screen.findByRole('region', { name: '检查申请集中办理' })
    expect(screen.queryByRole('region', { name: '取消申请待处理清单' })).toBeNull()
    other.unmount()
  }
  const otherStay = { ...admission, id: 'admission-2', patientId: 'patient-2', patientName: '合成另一患者' }
  s.update({ ...s.read(), admissionId: otherStay.id })
  const other = s.mount(session, otherStay)
  await screen.findByRole('region', { name: '检查申请集中办理' })
  expect(screen.queryByRole('region', { name: '取消申请待处理清单' })).toBeNull()
  other.unmount()
  s.update({ ...s.read(), admissionId: admission.id })
  s.mount()
  expect(within(await screen.findByRole('region', { name: '取消申请待处理清单' })).getAllByRole('article')).toHaveLength(2)
  expect(s.posts).toHaveLength(0)
})

it('核对后申请变化时阻止发送并保留旧核对，明确更新后才允许继续', async () => {
  const s = fixture(), user = userEvent.setup()
  s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  expect(screen.getByRole('region', { name: '集中取消申请操作' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  s.update({ ...s.read(), laboratoryRequests: s.read().laboratoryRequests.map((item, index) => index ? item : { ...item, version: 2, taskVersion: '2' }) })
  const dialog = screen.getByRole('dialog', { name: '集中取消检查申请' })
  await user.click(within(dialog).getByRole('button', { name: '确认取消申请' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('本次未发送')
  expect(s.posts).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: '返回修改' }))
  await user.click(screen.getByRole('button', { name: '更新核对：合成检验项目1' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已完成取消申请'))
  expect(s.posts).toHaveLength(2)
})

it('原回执读取失败仍保持结果不明，不将查询错误当作原Command被拒绝或发送新尝试', async () => {
  const s = fixture(3, { dropResponse: 2, receiptFailures: 1 }), user = userEvent.setup()
  s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  const recover = await screen.findByRole('button', { name: '恢复原取消申请' })
  await waitFor(() => expect(recover.hasAttribute('disabled')).toBe(false))
  await user.click(recover)
  await waitFor(() => { expect(s.receiptKeys).toHaveLength(1); expect(recover.hasAttribute('disabled')).toBe(false) })
  expect(s.posts).toHaveLength(2)
  expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('结果待确认')
  await user.click(recover)
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消申请' })).toBeNull())
  expect(s.receiptKeys).toEqual([s.posts[1]!.key, s.posts[1]!.key])
  expect(s.posts).toHaveLength(2)
})

it('一个Command确定拒绝时保留失败项并继续独立余项，人工重审只重发失败项', async () => {
  const s = fixture(3, { rejectRequest: 2 }), user = userEvent.setup()
  const first = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  const outcomes = await screen.findByRole('region', { name: '取消申请逐项结果' })
  await within(outcomes).findByText('成功 2/3')
  expect(outcomes.textContent).toContain('检查状态或版本已变化，请刷新并核对送检及当前报告。')
  expect(outcomes.textContent).not.toContain('Private upstream Task version conflict')
  expect(s.posts).toHaveLength(3)
  first.unmount()
  s.mount()
  const restoredOutcomes = await screen.findByRole('region', { name: '取消申请逐项结果' })
  expect(restoredOutcomes.textContent).toContain('检查状态或版本已变化，请刷新并核对送检及当前报告。')
  expect(restoredOutcomes.textContent).not.toContain('Private upstream Task version conflict')
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const review = screen.getByRole('dialog')
  expect(within(review).getAllByRole('article')).toHaveLength(1)
  expect(review.textContent).toContain('合成检验项目2')
  await user.click(within(review).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已完成取消申请'))
  expect(s.posts.map(item => item.input.requestId)).toEqual(['request-1', 'request-2', 'request-3', 'request-2'])
  expect(new Set(s.posts.map(item => item.key)).size).toBe(4)
})

it.each([false, true])('损坏缓存阻止写入，退出=%s时确认丢弃前保留原缓存', async logout => {
  const s = fixture(), user = userEvent.setup(), first = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  first.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-investigation-actions:'))!
  sessionStorage.setItem(key, '{synthetic-corrupted')
  if (logout) await act(async () => { await signOut() })
  s.mount()
  expect((await screen.findByRole('alert')).textContent).toContain('无法可靠读取或保存')
  expect(screen.getByRole('button', { name: '集中取消申请' }).hasAttribute('disabled')).toBe(true)
  expect(sessionStorage.getItem(key)).toBe('{synthetic-corrupted')
  await user.click(screen.getByRole('button', { name: '丢弃待处理清单' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(sessionStorage.getItem(key)).toBeNull()
  expect(s.posts).toHaveLength(0)
})

it('原响应已成功但清单保存失败时保留原意图，恢复只查同一回执且不重复成功项', async () => {
  const s = fixture(), user = userEvent.setup()
  s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const originalSet = Storage.prototype.setItem
  const broken = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('clinmesh.inpatient-investigation-actions:') && value.includes('"status":"success"')) throw new Error('synthetic disk unavailable')
    originalSet.call(this, key, value)
  })
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  const recover = await screen.findByRole('button', { name: '恢复原取消申请' })
  await waitFor(() => expect(recover.hasAttribute('disabled')).toBe(false))
  expect(s.posts).toHaveLength(1)
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['cancelled', 'issued'])
  broken.mockRestore()
  await user.click(recover)
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消申请' })).toBeNull())
  expect(s.receiptKeys).toEqual([s.posts[0]!.key])
  expect(s.posts).toHaveLength(1)
  expect(screen.getByRole('region', { name: '取消申请待处理清单' }).textContent).toContain('合成检验项目2')
})

it('同绑定另一界面扩充选择后，旧确认窗口不能发送未展示的申请', async () => {
  const s = fixture(), user = userEvent.setup()
  const first = s.mount()
  await user.click(await within(first.container).findByRole('checkbox', { name: /^选择取消申请：合成检验项目1/ }))
  const other = s.mount()
  await within(other.container).findByRole('region', { name: '取消申请待处理清单' })
  await user.click(within(first.container).getByRole('button', { name: '集中取消申请' }))
  const dialog = screen.getByRole('dialog', { name: '集中取消检查申请' })
  expect(within(dialog).getAllByRole('article')).toHaveLength(1)
  fireEvent.click(within(other.container).getByLabelText('选择取消申请：合成检验项目2'))
  await user.click(within(dialog).getByRole('button', { name: '确认取消申请' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('本次未发送')
  expect(s.posts).toHaveLength(0)
})

it('患者切走后的迟到成功只结算原清单，不把余项发送或结果与输入带入新患者', async () => {
  const s = fixture(2, { holdResponse: 1 }), user = userEvent.setup(), first = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(s.posts).toHaveLength(1))
  const committed = s.read()
  first.unmount()
  const otherStay = { ...admission, id: 'admission-2', patientId: 'patient-2', patientName: '合成另一患者' }
  s.update(inpatientInvestigationsSchema.parse({ admissionId: otherStay.id, laboratoryRequests: [makeRequest(3)], imagingRequests: [], sent: [] }))
  const other = s.mount(session, otherStay)
  await user.type(await screen.findByRole('textbox', { name: '搜索待处理检查申请' }), '合成检验项目3')
  s.releaseResponse()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /^选择取消申请：合成检验项目3/ }).getAttribute('aria-disabled')).not.toBe('true'))
  expect(screen.queryByRole('region', { name: '取消申请逐项结果' })).toBeNull()
  expect(screen.getByRole('textbox', { name: '搜索待处理检查申请' }).getAttribute('value')).toBe('合成检验项目3')
  expect(s.posts).toHaveLength(1)
  other.unmount()
  s.update(committed)
  s.mount()
  const originalList = await screen.findByRole('region', { name: '取消申请待处理清单' })
  expect(within(originalList).getAllByRole('article')).toHaveLength(1)
  expect(originalList.textContent).toContain('合成检验项目2')
  expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 1/2')
  expect(s.posts).toHaveLength(1)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('医生一次核对两条同住院申请后逐项取消，保留原申请且不将取消显示成退款', async () => {
  const s = fixture(), user = userEvent.setup()
  s.update({ ...s.read(), laboratoryRequests: s.read().laboratoryRequests.map((item, index) => index === 0
    ? { ...item, taskVersion: '9007199254740993', serviceRequestVersion: '9007199254740995' } : item) })
  s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const dialog = screen.getByRole('dialog', { name: '集中取消检查申请' })
  expect(within(dialog).getAllByRole('article')).toHaveLength(2)
  expect(dialog.textContent).toContain('合成检验项目1')
  expect(dialog.textContent).toContain('合成检验项目2')
  expect(s.posts).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(within(screen.getByRole('region', { name: '取消申请逐项结果' })).getByText('成功 2/2')).toBeDefined())
  expect(s.posts.map(item => item.path)).toEqual([
    '/api/his/v1/inpatient/admissions/admission-1/investigations/cancel',
    '/api/his/v1/inpatient/admissions/admission-1/investigations/cancel',
  ])
  expect(new Set(s.posts.map(item => item.key)).size).toBe(2)
  expect(s.read().laboratoryRequests.map(item => item.status)).toEqual(['cancelled', 'cancelled'])
  expect(s.posts[0]!.input).toMatchObject({ requestId: 'request-1', taskVersion: '9007199254740993', serviceRequestVersion: '9007199254740995' })
  expect(s.read().laboratoryRequests[0]).toMatchObject({ id: 'request-1', taskVersion: '9007199254740994', serviceRequestVersion: '9007199254740996' })
  expect(screen.queryByRole('button', { name: '取消检查申请' })).toBeNull()
  expect(screen.queryByText('退款成功')).toBeNull()
})

it('退出遇到形状合法但包含两个未知原尝试的缓存时保留原文并阻止读取', async () => {
  const s = fixture(), user = userEvent.setup(), original = s.mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  original.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-investigation-actions:'))!
  const record = JSON.parse(sessionStorage.getItem(key)!)
  record.items = record.rows.map((row: { snapshot: { request: { id: string; version: number; serviceRequestVersion: string; taskVersion: string } } }) => ({
    row, status: 'unknown', idempotencyKey: crypto.randomUUID(), command: { operation: 'inpatient.investigation.cancel', input: {
      admissionId: admission.id, requestId: row.snapshot.request.id, expectedRequestVersion: row.snapshot.request.version,
      serviceRequestVersion: row.snapshot.request.serviceRequestVersion, taskVersion: row.snapshot.request.taskVersion,
    } },
  }))
  const raw = JSON.stringify(record)
  sessionStorage.setItem(key, raw)
  expect(() => clearInpatientInvestigationActionDrafts()).toThrow('Invalid investigation action binding')
  expect(sessionStorage.getItem(key)).toBe(raw)
  s.mount()
  expect((await screen.findByRole('alert')).textContent).toContain('无法可靠读取或保存')
  expect(sessionStorage.getItem(key)).toBe(raw)
  expect(s.posts).toHaveLength(0)
})
