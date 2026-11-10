// @vitest-environment jsdom
import { doctorCaseDetailSchema, imagingRequestSchema, pathologyRequestSchema, type SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDoctorCase } from '../api-client.ts'
import { ImagingPage, useImagingViewState } from './imaging-page.tsx'
import { PathologyPage } from './pathology-page.tsx'

const session: SessionContext = {
  actor: { actorId: 'actor-doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor',
    practitionerId: 'practitioner-doctor', organizationId: 'organization-outpatient', locationId: 'location-outpatient', roleCode: 'outpatient-doctor' },
  user: { id: 'account-doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [],
}
const service = { id: 'service-imaging', code: 'SYN-DX', name: '合成胸片', version: 1, bodySite: '胸部', department: '放射科', examCode: 'chest-radiograph',
  method: 'X线摄影', modality: 'DX', applicability: '合成病例检查', reportSections: ['technique', 'findings', 'impression'] }
function facts(pathology = false, count = 3, retry = false) {
  const requests = Array.from({ length: count }, (_, offset) => offset + 1).map(index => {
    const common = { id: `request-${index}`, previousReports: [], serviceRequestId: `service-request-${index}`, serviceRequestVersion: '1', status: retry ? 'generation-failed' : 'issued', taskId: `task-${index}`, taskVersion: '1', version: 1,
      ...(retry ? { generationError: { code: 'PROVIDER_TEMPORARY_FAILURE', message: '合成服务暂时失败' } } : {}) }
    return pathology ? pathologyRequestSchema.parse({ ...common, purpose: '合成病例核对',
      sourceProcedure: { code: 'SYN-PROCEDURE', display: '合成既往手术', performedAt: '2025-01-01T08:00:00+08:00', sourceReference: 'urn:uuid:synthetic-procedure' },
      service: { id: 'service-pathology', code: 'SYN-PATH', name: `合成会诊${index}`, version: 1, bodySite: '乳腺', department: '病理科', applicability: '合成病例检查', examCode: 'breast-slide-consultation', specimenType: '合成石蜡切片', stain: 'HE', reportSections: ['specimen', 'microscopy', 'diagnosis', 'immunohistochemistry', 'note'] } })
      : imagingRequestSchema.parse({ ...common, service: { ...service, name: `合成胸片${index}` }, indication: '合成病例核对' })
  })
  return doctorCaseDetailSchema.parse({ registrationNumber: null, allergies: [], caseId: 'case-1', consultation: { turns: [], version: 1 },
    encounter: { id: 'encounter-1', versionId: '1', status: 'in-progress' },
    patient: { id: 'patient-1', identifier: 'SYN-1', name: '合成集中办理患者', synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'first-visit', taskId: 'case-task', taskVersion: '1',
    ...(pathology ? { pathologyRequests: { draftVersion: 0, requests } } : { imagingRequests: { draftVersion: 0, requests } }) })
}
function server(pathology = false, count = 3, retry = false) {
  let current = facts(pathology, count, retry)
  const controls = { lossSecond: true, dropBeforeCommit: false, receiptFailure: false, receiptMissing: false, wrongProof: false, reject: [] as string[], holdFirst: async () => {} }
  const posts: { key: string; body: unknown; id: string }[] = [], receiptKeys: string[] = []
  const receipts = new Map<string, unknown>()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://example.test').searchParams.get('idempotencyKey')!
      receiptKeys.push(key)
      if (controls.receiptFailure) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成回执读取失败' } }, { status: 409 })
      if (controls.receiptMissing) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成回执不存在' } }, { status: 404 })
      return Response.json({ operationId: `${pathology ? 'pathology' : 'imaging'}-request.${retry ? 'retry' : 'cancel'}`, idempotencyKey: key, status: 'completed', response: receipts.get(key) })
    }
    if ((path.endsWith('/actions/cancel') || path.endsWith('/actions/retry')) && init?.method === 'POST') {
      const id = path.split('/').at(-3)!, key = new Headers(init.headers).get('idempotency-key')!
      const body = JSON.parse(String(init.body))
      posts.push({ key, body, id })
      if (controls.reject.includes(id)) return Response.json({ error: { code: 'WORKFLOW_CONFLICT', message: '合成费用竞争拒绝' } }, { status: 409 })
      const previous = (pathology ? current.pathologyRequests!.requests : current.imagingRequests!.requests).find(item => item.id === id)!
      expect(body).toEqual(retry ? { expectedVersions: { [`Task/${previous.taskId}`]: '1' }, input: { expectedRequestVersion: 1 } }
        : { expectedVersions: { [`ServiceRequest/${previous.serviceRequestId}`]: '1', [`Task/${previous.taskId}`]: '1' }, input: { expectedRequestVersion: 1, reasonCode: 'no-longer-needed' } })
      if (controls.dropBeforeCommit && id === 'request-2') { controls.dropBeforeCommit = false; throw new TypeError('synthetic request loss before commit') }
      const request = (pathology ? pathologyRequestSchema : imagingRequestSchema).parse({ ...previous, status: retry ? 'in-progress' : 'cancelled', generationError: undefined, version: 2, serviceRequestVersion: retry ? '1' : '2', taskVersion: '2' })
      current = doctorCaseDetailSchema.parse(pathology ? { ...current, pathologyRequests: { ...current.pathologyRequests, requests: current.pathologyRequests!.requests.map(item => item.id === id ? request : item) } }
        : { ...current, imagingRequests: { ...current.imagingRequests, requests: current.imagingRequests!.requests.map(item => item.id === id ? request : item) } })
      const response = { auditId: `audit-${id}`, requestId: `command-${id}`, warnings: [], effects: [
        ...(retry ? [] : [{ kind: 'updated', reference: `ServiceRequest/${previous.serviceRequestId}`, versionId: '2' }]),
        { kind: 'updated', reference: `Task/${previous.taskId}`, versionId: '2' },
      ], data: { request } }
      receipts.set(key, response)
      if (id === 'request-1') await controls.holdFirst()
      if (controls.wrongProof && id === 'request-1') return Response.json({ ...response, data: { request: { ...request, version: 4, taskId: 'unrelated-task', taskVersion: '9' } } })
      if (controls.lossSecond && id === 'request-2') throw new TypeError('synthetic committed response loss')
      return Response.json(response)
    }
    if (path.endsWith('/imaging-services')) return Response.json({ items: [{ available: true, service }] })
    if (path.endsWith('/pathology-services')) return Response.json({ items: [] })
    if (path.includes('/recommendations/')) return Response.json({ caseId: 'case-1', kind: pathology ? 'pathology' : 'imaging', encounterId: 'encounter-1', encounterVersion: '1',
      inputFingerprint: 'a'.repeat(64), status: 'ready', generation: 1, missingInformation: [], stale: false, guidelines: [], caseEvidence: [], items: [] })
    if (path.endsWith('/doctor/cases/case-1')) return Response.json(current)
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
  }))
  return { posts, receiptKeys, controls, facts: () => current, update: (value: unknown) => { current = doctorCaseDetailSchema.parse(value) } }
}
function Harness({ pathology = false, boundSession = session }: { pathology?: boolean; boundSession?: SessionContext }) {
  const detail = useQuery({ queryKey: ['doctor-case', 'case-1'], queryFn: () => getDoctorCase('case-1') })
  const view = useImagingViewState('case-1')
  if (!detail.data) return null
  const props = { actions: { canCorrect: false, onChanged: () => detail.refetch(), view }, caseId: detail.data.caseId, elementId: 'imaging',
    encounter: detail.data.encounter, locale: 'zh-CN' as const, readOnly: false, state: detail.data.imagingRequests,
    actionContext: { session: boundSession, caseId: detail.data.caseId, patientId: detail.data.patient.id, encounterId: detail.data.encounter.id, patientName: detail.data.patient.name, onChanged: () => detail.refetch() } }
  return pathology ? <PathologyPage {...props} state={detail.data.pathologyRequests} /> : <ImagingPage {...props} />
}
function mount(pathology = false, boundSession = session) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Harness pathology={pathology} boundSession={boundSession} /></QueryClientProvider>)
}
beforeEach(() => {
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

it('已知现金全额或部分收款仍可临床取消，未知资金阻写，预览明确退款责任另办', async () => {
  const api = server(), user = userEvent.setup()
  api.controls.lossSecond = false
  api.update({ ...api.facts(), imagingRequests: { ...api.facts().imagingRequests, requests: api.facts().imagingRequests!.requests.map((request, index) => ({ ...request,
    billing: { chargeItemId: `charge-${index}`, insuranceFen: 0, paidFen: index === 0 ? 1000 : 500, remainingFen: index === 0 ? 0 : 500,
      price: { currency: 'CNY', effectiveOn: '2026-01-01', id: 'price-synthetic', priceFen: 1000, source: 'synthetic-price', unit: '项', version: 1 },
      quantity: 1, status: index === 0 ? 'paid' : index === 1 ? 'partial' : 'ambiguous' },
  })) } })
  mount()
  for (const index of [1, 2]) {
    const checkbox = await screen.findByRole('checkbox', { name: `选择取消：合成胸片${index}` })
    expect(checkbox.getAttribute('aria-disabled')).not.toBe('true')
    await user.click(checkbox)
  }
  expect(screen.getByRole('checkbox', { name: '选择取消：合成胸片3' }).getAttribute('aria-disabled')).toBe('true')
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const preview = screen.getByRole('dialog', { name: '集中取消申请核对' })
  expect(preview.textContent).toContain('退款须按原交易另行办理')
  await user.click(within(preview).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 2/2'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
})

it('每页10项只全选当前页，跨页搜索保留完整20项；超限不丢清单，清空选择与确认丢弃分开', async () => {
  const api = server(false, 21), first = mount(), user = userEvent.setup()
  await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' })
  expect(screen.getAllByRole('checkbox', { name: /^选择取消：/ })).toHaveLength(10)
  await user.click(screen.getByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '下一页申请' }))
  await user.click(screen.getByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '下一页申请' }))
  await user.click(screen.getByRole('checkbox', { name: '选择取消：合成胸片21' }))
  expect(screen.getAllByRole('status').map(item => item.textContent).join('')).toContain('最多保留20项')
  expect(within(screen.getByRole('region', { name: '取消申请完整待处理清单' })).getAllByRole('checkbox')).toHaveLength(20)
  await user.type(screen.getByRole('textbox', { name: '搜索申请' }), '不存在')
  expect(within(screen.getByRole('region', { name: '取消申请完整待处理清单' })).getAllByRole('checkbox')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '清空取消选择' }))
  expect(within(screen.getByRole('region', { name: '取消申请完整待处理清单' })).getAllByRole('checkbox').every(item => item.getAttribute('aria-checked') === 'false')).toBe(true)
  first.unmount(); mount()
  expect(within(await screen.findByRole('region', { name: '取消申请完整待处理清单' })).getAllByRole('checkbox')).toHaveLength(20)
  await user.click(screen.getByRole('button', { name: '丢弃取消清单' }))
  expect(screen.getByRole('region', { name: '取消申请完整待处理清单', hidden: true })).toBeTruthy()
  await user.click(within(screen.getByRole('dialog', { name: '确认丢弃待处理清单' })).getByRole('button', { name: '确认丢弃' }))
  expect(screen.queryByRole('region', { name: '取消申请完整待处理清单' })).toBeNull()
  expect(api.posts).toHaveLength(0)
})

it('响应的原申请投影与Task证明不符时保留原操作并停止后项，恢复只接受匹配原回执', async () => {
  const api = server(), user = userEvent.setup()
  api.controls.wrongProof = true
  mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中取消申请核对' })).getByRole('button', { name: '确认取消申请' }))
  await screen.findByRole('button', { name: '恢复原取消' })
  await waitFor(() => expect(api.posts.map(item => item.id)).toEqual(['request-1']))
  expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 0/3')
  await user.click(screen.getByRole('button', { name: '恢复原取消' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消' })).toBeNull())
  expect(api.receiptKeys).toEqual([api.posts[0]!.key])
  expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 1/3')
  expect(api.posts).toHaveLength(1)
})

it('确认后清单持久化失败阻止全部写入，不能把可读的旧清单误当存储已恢复', async () => {
  const api = server(), user = userEvent.setup()
  mount()
  await user.click(await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('synthetic quota', 'QuotaExceededError') })
  await user.click(within(screen.getByRole('dialog', { name: '集中取消申请核对' })).getByRole('button', { name: '确认取消申请' }))
  await screen.findByText('待处理清单存储不可用')
  expect(screen.getByRole('button', { name: '集中取消申请' }).hasAttribute('disabled')).toBe(true)
  expect(api.posts).toHaveLength(0)
  write.mockRestore()
  await user.click(screen.getByRole('button', { name: '重新读取清单' }))
  expect(screen.getByRole('button', { name: '集中取消申请' }).hasAttribute('disabled')).toBe(false)
})

it('原回执读取失败保持未知，刷新后仅在明确不存在时以原body和原key重发，不自动续办余项', async () => {
  const api = server(), first = mount(), user = userEvent.setup()
  api.controls.lossSecond = false; api.controls.dropBeforeCommit = true
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中取消申请核对' })).getByRole('button', { name: '确认取消申请' }))
  await screen.findByRole('button', { name: '恢复原取消' })
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复原取消' }).hasAttribute('disabled')).toBe(false))
  api.controls.receiptFailure = true
  await user.click(screen.getByRole('button', { name: '恢复原取消' }))
  await screen.findByText('原结果仍待查明，请再次恢复原操作')
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
  first.unmount(); mount()
  api.controls.receiptFailure = false; api.controls.receiptMissing = true
  await user.click(await screen.findByRole('button', { name: '恢复原取消' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消' })).toBeNull())
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2', 'request-2'])
  expect(api.posts[2]).toEqual(api.posts[1])
  expect(api.receiptKeys).toEqual([api.posts[1]!.key, api.posts[1]!.key])
  expect(api.facts().imagingRequests!.requests.map(item => item.status)).toEqual(['cancelled', 'cancelled', 'issued'])
})

it('最终提交逐项重读当前状态和资金，保留旧核对冲突与服务端确定拒绝，并继续保留独立成功', async () => {
  const api = server(false, 4), user = userEvent.setup()
  api.controls.lossSecond = false; api.controls.reject = ['request-3']
  mount()
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  api.update({ ...api.facts(), imagingRequests: { ...api.facts().imagingRequests, requests: api.facts().imagingRequests!.requests.map((request, index) => index === 0
    ? { ...request, status: 'accepted', version: 2, taskVersion: '2' } : index === 1 ? { ...request,
      billing: { chargeItemId: 'charge-2', insuranceFen: 0, paidFen: 0, remainingFen: 1000,
        price: { currency: 'CNY', effectiveOn: '2026-01-01', id: 'price-synthetic', priceFen: 1000, source: 'synthetic-price', unit: '项', version: 1 }, quantity: 1, status: 'ambiguous' },
    } : request) } })
  await user.click(within(screen.getByRole('dialog', { name: '集中取消申请核对' })).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 1/4'))
  expect(api.posts.map(item => item.id)).toEqual(['request-3', 'request-4'])
  expect(screen.queryByRole('button', { name: '恢复原取消' })).toBeNull()
  const remaining = screen.getByRole('region', { name: '取消申请完整待处理清单' })
  expect(within(remaining).getAllByRole('checkbox')).toHaveLength(3)
  expect(remaining.textContent).toContain('申请状态、费用或内容已变化')
  expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('当前状态或关联费用不允许办理')
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  expect(within(screen.getByRole('dialog', { name: '集中取消申请核对' })).getByRole('button', { name: '确认取消申请' }).hasAttribute('disabled')).toBe(true)
})

it.each(['corrupt', 'read-failure'])('清单损坏或不可读时明确阻写且可重新读取，不伪装成空清单（%s）', async mode => {
  const api = server(), first = mount(), user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' }))
  first.unmount()
  const key = Object.keys(sessionStorage)[0]!, original = sessionStorage.getItem(key)!
  const readFailure = mode === 'read-failure' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('synthetic inaccessible storage') }) : undefined
  if (mode === 'corrupt') sessionStorage.setItem(key, '{')
  mount()
  await screen.findAllByText('待处理清单存储不可用')
  expect(screen.getByRole('button', { name: '集中取消申请' }).hasAttribute('disabled')).toBe(true)
  expect(api.posts).toHaveLength(0)
  readFailure?.mockRestore(); sessionStorage.setItem(key, original)
  for (const button of screen.getAllByRole('button', { name: '重新读取清单' })) await user.click(button)
  expect(screen.getByRole('checkbox', { name: '选择取消：合成胸片1' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('button', { name: '集中取消申请' }).hasAttribute('disabled')).toBe(false)
})

it('完整账号与Actor、患者和就诊隔离清单，返回原上下文恢复明确选择', async () => {
  const api = server(), first = mount(), user = userEvent.setup()
  await user.click(await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' }))
  first.unmount()
  const sessions: SessionContext[] = [
    { ...session, user: { ...session.user, id: 'account-other' } },
    ...[{ actorId: 'actor-other' }, { workspaceId: 'workspace-other' }, { epoch: 'epoch-other' }, { scenarioRunId: 'run-other' },
      { practitionerRoleId: 'role-other' }, { practitionerId: 'practitioner-other' }, { organizationId: 'organization-other' }, { locationId: 'location-other' }]
      .map(actor => ({ ...session, actor: { ...session.actor, ...actor } })),
    { ...session, actor: { ...session.actor, roleCode: 'inpatient-doctor' } },
  ]
  for (const scopedSession of sessions) {
    const other = mount(false, scopedSession)
    expect((await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' })).getAttribute('aria-checked')).toBe('false')
    other.unmount()
  }
  const original = api.facts()
  for (const change of [{ patient: { ...original.patient, id: 'patient-other' } }, { caseId: 'case-other' }, { encounter: { ...original.encounter, id: 'encounter-other' } }]) {
    api.update({ ...original, ...change })
    const other = mount()
    expect((await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' })).getAttribute('aria-checked')).toBe('false')
    other.unmount()
  }
  api.update(original); mount()
  expect((await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' })).getAttribute('aria-checked')).toBe('true')
  expect(api.posts).toHaveLength(0)
})

it('同scope另一挂载新增选择不会扩大已打开核对弹窗的提交集合', async () => {
  const api = server(), first = mount(), user = userEvent.setup()
  await user.click(await within(first.container).findByRole('checkbox', { name: '选择取消：合成胸片1' }))
  await user.click(within(first.container).getByRole('button', { name: '集中取消申请' }))
  const preview = screen.getByRole('dialog', { name: '集中取消申请核对' })
  const second = mount()
  // A second surface can change the shared list while the first surface retains its reviewed set.
  fireEvent.click(await within(second.container).findByRole('checkbox', { name: '选择取消：合成胸片2', hidden: true }))
  expect(within(preview).getAllByRole('article')).toHaveLength(1)
  await user.click(within(preview).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(api.posts.map(item => item.id)).toEqual(['request-1']))
  await waitFor(() => expect(within(first.container).getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 1/1'))
  expect(within(first.container).getByRole('checkbox', { name: '待处理取消：合成胸片2' }).getAttribute('aria-checked')).toBe('true')
})

it('切患者后的迟到成功只结算原清单，停止旧计划；返回原患者保留余项重审', async () => {
  const api = server(), first = mount(), user = userEvent.setup()
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  api.controls.holdFirst = () => held
  await user.click(await screen.findByRole('button', { name: '全选本页可取消申请' }))
  await user.click(screen.getByRole('button', { name: '集中取消申请' }))
  await user.click(within(screen.getByRole('dialog', { name: '集中取消申请核对' })).getByRole('button', { name: '确认取消申请' }))
  await waitFor(() => expect(api.facts().imagingRequests!.requests[0]!.status).toBe('cancelled'))
  const original = api.facts()
  first.unmount()
  api.update({ ...facts(), caseId: 'case-other', patient: { ...facts().patient, id: 'patient-other', name: '合成另一患者' }, encounter: { ...facts().encounter, id: 'encounter-other' } })
  const other = mount()
  expect((await screen.findByRole('checkbox', { name: '选择取消：合成胸片1' })).getAttribute('aria-checked')).toBe('false')
  release()
  await waitFor(() => expect(screen.queryByRole('button', { name: '恢复原取消' })).toBeNull())
  expect(screen.queryByRole('region', { name: '取消申请逐项结果' })).toBeNull()
  other.unmount(); api.update(original); mount()
  await waitFor(() => expect(screen.getByRole('region', { name: '取消申请逐项结果' }).textContent).toContain('成功 1/3'))
  expect(screen.getByRole('region', { name: '取消申请完整待处理清单' }).textContent).toContain('合成胸片2')
  expect(api.posts.map(item => item.id)).toEqual(['request-1'])
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each([{ pathology: false, retry: false }, { pathology: true, retry: false }, { pathology: false, retry: true }, { pathology: true, retry: true }])('放射/病理同类申请部分成功、未知停止、刷新原回执恢复，余项重审（%j）', async ({ pathology, retry }) => {
  const api = server(pathology, 3, retry), first = mount(pathology), user = userEvent.setup(), label = retry ? '重试' : '取消'
  for (const index of [1, 2, 3]) await user.click(await screen.findByRole('checkbox', { name: `选择${label}：合成${pathology ? '会诊' : '胸片'}${index}` }))
  await user.click(screen.getByRole('button', { name: `集中${label}申请` }))
  const preview = screen.getByRole('dialog', { name: `集中${label}申请核对` })
  expect(within(preview).getAllByRole('article')).toHaveLength(3)
  expect(preview.textContent).toContain(retry ? '未取得结果' : '不再需要')
  if (!retry) expect(preview.textContent).toContain('取消不等于退款')
  await user.click(within(preview).getByRole('button', { name: `确认${label}申请` }))
  await screen.findByRole('button', { name: `恢复原${label}` })
  await waitFor(() => expect(screen.getByRole('button', { name: `恢复原${label}` }).hasAttribute('disabled')).toBe(false))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2'])
  first.unmount()
  mount(pathology)
  await user.click(await screen.findByRole('button', { name: `恢复原${label}` }))
  await waitFor(() => expect(api.receiptKeys).toEqual([api.posts[1]!.key]))
  await waitFor(() => expect(screen.queryByRole('button', { name: `恢复原${label}` })).toBeNull())
  expect(api.posts).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: `集中${label}申请` }))
  const remaining = screen.getByRole('dialog', { name: `集中${label}申请核对` })
  expect(within(remaining).getAllByRole('article')).toHaveLength(1)
  await user.click(within(remaining).getByRole('button', { name: `确认${label}申请` }))
  await waitFor(() => expect((pathology ? api.facts().pathologyRequests!.requests : api.facts().imagingRequests!.requests).every(item => item.status === (retry ? 'in-progress' : 'cancelled'))).toBe(true))
  await waitFor(() => expect(screen.getByRole('region', { name: `${label}申请逐项结果` }).textContent).toContain('成功 1/1'))
  expect(api.posts.map(item => item.id)).toEqual(['request-1', 'request-2', 'request-3'])
  expect(new Set(api.posts.map(item => item.key)).size).toBe(3)
})
