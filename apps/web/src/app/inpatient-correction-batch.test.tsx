// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientSurgeryMaterialHistorySchema, inpatientSurgeryRequestSchema } from '@clinmesh/contracts/inpatient-surgery'
import { afterEach, expect, it, vi } from 'vitest'
import { correctionDraftScope, correctionRowSchema, useCorrectionBatchDraft } from './inpatient-correction-batch.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const scope = correctionDraftScope({ session, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', executionId: 'execution-1' })
const charge = { id: 'charge-1', priceFen: 10000, unit: '根', synthetic: true, trigger: 'execution' }
const request = inpatientSurgeryRequestSchema.parse({ id: scope.requestId, admissionId: scope.admissionId, version: 1, status: 'completed', plannedProcedure: { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '36.0600', display: 'PCI', category: '介入治疗', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { ...charge, unit: '次' } }, plannedFor: '2026-11-03T00:00:00Z', reason: '合成计划', requestedAt: '2026-11-03T00:00:00Z', requestedBy: 'doctor', organizationId: 'org-1' })
const use = inpatientSurgeryMaterialHistorySchema.parse({ id: 'use-1', item: { id: 'wire', version: 1, display: '合成导丝', chargeDefinition: charge }, quantity: 2, amountFen: 20000, recordedAt: '2026-11-03T00:00:00Z', recordedBy: 'doctor', practitionerRoleId: 'role-doctor', note: '原始使用一', reservationId: null, chargeId: 'charge-1', correction: null })
const row = correctionRowSchema.parse({ id: use.id, revision: crypto.randomUUID(), binding: { admissionId: scope.admissionId, requestId: scope.requestId, executionId: scope.executionId }, original: use, selected: true, mode: 'void', material: use.item, quantity: '2', reservation: null, reason: '合成第一笔更正' })
const second = { ...row, id: 'use-2', revision: crypto.randomUUID(), original: { ...use, id: 'use-2', note: '原始使用二' }, reason: '合成第二笔更正' }
const third = { ...row, id: 'use-3', revision: crypto.randomUUID(), original: { ...use, id: 'use-3', note: '原始使用三' }, reason: '合成第三笔更正' }
const output = (version: number) => ({ data: { admissionId: scope.admissionId, encounterVersion: '1', virtualTime: '2026-11-03T00:00:00Z', requests: [{ ...request, version }], executions: [], inProgress: [] }, auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [] })
const clients: QueryClient[] = []
function mount(owner = scope, activeSession = session) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  return renderHook(({ owner, activeSession }) => { const write = useInpatientWriteIntent(activeSession, () => undefined); return { write, draft: useCorrectionBatchDraft({ scope: owner, session: activeSession, write }) } }, {
    initialProps: { owner, activeSession }, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('原键恢复后余项必须重新准备，旧核对不能直接继续发出', async () => {
  const posts: Array<{ id: string; key: string | null; version: number }> = [], lookups: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) {
      lookups.push(new URL(path, 'https://synthetic.local').searchParams.get('idempotencyKey')!)
      return Response.json({ operationId: 'inpatient.surgery.correct-material', idempotencyKey: lookups.at(-1), status: 'completed', response: output(3) })
    }
    const body = JSON.parse(String(init?.body)).input
    posts.push({ id: body.materialUseId, key: new Headers(init?.headers).get('idempotency-key'), version: body.expectedRequestVersion })
    if (body.materialUseId === second.id) throw new TypeError('合成响应丢失')
    return Response.json(output(posts.length + 1))
  }))
  const first = mount()
  act(() => { first.result.current.draft.save({ commonReason: '', rows: [row, second, third] }); expect(first.result.current.draft.prepareBatch(1)).toBe(true) })
  await act(async () => { await first.result.current.draft.start(() => true) })
  expect(posts.map(item => item.id)).toEqual([row.id, second.id])
  const originalKey = posts[1]!.key
  first.unmount()
  const restored = mount()
  await act(async () => { await restored.result.current.draft.resume(() => true) })
  expect(lookups).toEqual([originalKey])
  expect(restored.result.current.draft.value.rows.map(row => row.id)).toEqual([third.id])
  await act(async () => { await restored.result.current.draft.start(() => true) })
  expect(posts.map(item => item.id)).toEqual([row.id, second.id])
  act(() => { expect(restored.result.current.draft.discardReady()).toBe(true); expect(restored.result.current.draft.prepareBatch(3)).toBe(true) })
  await act(async () => { await restored.result.current.draft.start(() => true) })
  expect(posts.map(item => item.version)).toEqual([1, 2, 3])
})

it('同耗材的不同原使用逐笔更正，成功响应续接下一项版本及独立幂等键', async () => {
  const posts: Array<{ body: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') })
    return Response.json(output(posts.length + 1))
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [row, second] }); expect(mounted.result.current.draft.prepareBatch(1)).toBe(true) })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts.map(item => item.body)).toEqual([
    { input: { requestId: scope.requestId, executionId: scope.executionId, materialUseId: row.id, expectedRequestVersion: 1, note: row.reason } },
    { input: { requestId: scope.requestId, executionId: scope.executionId, materialUseId: second.id, expectedRequestVersion: 2, note: second.reason } },
  ])
  expect(new Set(posts.map(item => item.key)).size).toBe(2)
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['success', 'success'])
  expect(mounted.result.current.draft.value.rows).toEqual([])
})

it('共同原预留被前项退回后暂停后项，保留原输入等待显式重审', async () => {
  const first = { ...row, original: { ...row.original, reservationId: 'reservation-1' } }
  const next = { ...second, original: { ...second.original, reservationId: 'reservation-1' } }
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts.push(JSON.parse(String(init?.body)).input.materialUseId); return Response.json(output(2))
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '', rows: [first, next] }); mounted.result.current.draft.prepareBatch(1) })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts).toEqual([row.id])
  expect(mounted.result.current.draft.paused).toBe(true)
  expect(mounted.result.current.draft.pauseReason).toBe('reservation')
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['success', 'ready'])
  expect(mounted.result.current.draft.value.rows).toEqual([next])
})

it('确定失败保留该笔输入，其他成功只消费原修订且不删除后来编辑', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    const id = JSON.parse(String(init?.body)).input.materialUseId; posts.push(id)
    if (id === row.id) return Response.json({ error: { code: 'SYNTHETIC_CONFLICT', message: '合成原使用已变化' } }, { status: 409 })
    await held; return Response.json(output(2))
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '', rows: [row, second] }); mounted.result.current.draft.prepareBatch(1) })
  let running: Promise<void> = Promise.resolve()
  await act(async () => { running = mounted.result.current.draft.start(() => true); await vi.waitFor(() => expect(posts).toEqual([row.id, second.id])) })
  const later = { ...second, revision: crypto.randomUUID(), reason: '原尝试之后另作编辑' }
  act(() => { mounted.result.current.draft.save({ commonReason: '', rows: [row, later] }) })
  await act(async () => { release(); await running })
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['failed', 'success'])
  expect(mounted.result.current.draft.value.rows).toEqual([row, later])
  expect(mounted.result.current.write.pending).toBeNull()
})

it('已核对的未发送行被编辑或取消选择后暂停，不使用旧意图', async () => {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { posts.push(path); return Response.json(session) }))
  const mounted = mount()
  act(() => {
    mounted.result.current.draft.save({ commonReason: '', rows: [row] }); mounted.result.current.draft.prepareBatch(1)
    mounted.result.current.draft.save({ commonReason: '', rows: [{ ...row, selected: false, revision: crypto.randomUUID() }] })
  })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts).toEqual([])
  expect(mounted.result.current.draft.pauseReason).toBe('input')
})

it('离开原视图后不继续下一笔，已发生结果仍结算原行', async () => {
  let release: () => void = () => undefined, active = true
  const held = new Promise<void>(resolve => { release = resolve })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts.push(JSON.parse(String(init?.body)).input.materialUseId); await held; return Response.json(output(2))
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '', rows: [row, second] }); mounted.result.current.draft.prepareBatch(1) })
  let running: Promise<void> = Promise.resolve()
  await act(async () => { running = mounted.result.current.draft.start(() => active); await vi.waitFor(() => expect(posts).toEqual([row.id])) })
  await act(async () => { active = false; release(); await running })
  expect(posts).toEqual([row.id])
  expect(mounted.result.current.draft.value.rows).toEqual([second])
})

it('完整身份及患者手术隔离，旧生命周期不能写入新归属', () => {
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '', rows: [row] }) })
  const old = mounted.result.current.draft
  const other = { ...session, actor: { ...session.actor, locationId: 'other-location' } }
  const otherScope = correctionDraftScope({ session: other, patientId: 'patient-2', admissionId: 'admission-2', requestId: 'request-2', executionId: 'execution-2' })
  mounted.rerender({ owner: otherScope, activeSession: other })
  expect(mounted.result.current.draft.value.rows).toEqual([])
  act(() => { expect(old.save({ commonReason: '迟到旧输入', rows: [] })).toBe(false); expect(old.clear()).toBe(false) })
  mounted.rerender({ owner: scope, activeSession: session })
  expect(mounted.result.current.draft.value.rows).toEqual([row])
})

it('结构合法但命令错绑的存储阻断发送并保留原输入', async () => {
  const first = mount()
  act(() => { first.result.current.draft.save({ commonReason: '', rows: [row] }); first.result.current.draft.prepareBatch(1) })
  first.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.correction-batch:'))!
  const record = JSON.parse(sessionStorage.getItem(key)!)
  record.items[0].command.input.admissionId = 'another-admission'
  sessionStorage.setItem(key, JSON.stringify(record))
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { calls.push(path); return Response.json(session) }))
  const restored = mount()
  expect(restored.result.current.draft.failed).toBe(true)
  expect(restored.result.current.draft.value.rows).toEqual([row])
  await act(async () => { await restored.result.current.draft.start(() => true); await restored.result.current.draft.resume(() => true) })
  expect(calls).toEqual([])
  act(() => { expect(restored.result.current.draft.retryStorage()).toBe(false) })
  expect(JSON.parse(sessionStorage.getItem(key)!).items[0].command.input.admissionId).toBe('another-admission')
})

it('存储写失败保留内存输入并阻写，重试保存恢复；丢弃失败保留原值', () => {
  const mounted = mount(), original = Storage.prototype.setItem
  const setter = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('合成配额不足') })
  act(() => { expect(mounted.result.current.draft.save({ commonReason: '共同依据', rows: [row] })).toBe(false) })
  expect(mounted.result.current.draft.value.rows).toEqual([row])
  expect(mounted.result.current.draft.blocked).toBe(true)
  setter.mockImplementation(original)
  act(() => { expect(mounted.result.current.draft.retryStorage()).toBe(true) })
  expect(mounted.result.current.draft.failed).toBe(false)
  const remover = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成删除失败') })
  act(() => { expect(mounted.result.current.draft.clear()).toBe(false) })
  expect(mounted.result.current.draft.value.rows).toEqual([row])
  remover.mockRestore()
})

it('超过20笔或缺少依据不得准备，保持全部人工输入，退出清除各作用域', async () => {
  const mounted = mount(), many = Array.from({ length: 21 }, (_, index) => ({ ...row, id: `use-${index}`, revision: crypto.randomUUID(), original: { ...use, id: `use-${index}` } }))
  act(() => { expect(mounted.result.current.draft.save({ commonReason: '', rows: many })).toBe(true); expect(mounted.result.current.draft.prepareBatch(1)).toBe(false) })
  expect(mounted.result.current.draft.value.rows).toHaveLength(21)
  act(() => { mounted.result.current.draft.save({ commonReason: '', rows: [{ ...row, reason: '' }] }); expect(mounted.result.current.draft.prepareBatch(1)).toBe(false) })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await act(async () => { await signOut() })
  expect(mounted.result.current.draft.value.rows).toEqual([])
})

it.each(['remove', 'access'] as const)('退出删除被拒时不以容错展示恢复更正旧输入，存储恢复后允许保存新行（%s）', async failure => {
  const original = mount()
  act(() => { expect(original.result.current.draft.save({ commonReason: '退出前依据', rows: [row] })).toBe(true) })
  original.unmount()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  const denied = failure === 'remove'
    ? vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成删除被拒') })
    : vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('合成存储访问被拒') })
  await expect(signOut()).resolves.toBeUndefined()
  const blocked = mount()
  expect(blocked.result.current.draft.value.rows).toEqual([])
  expect(blocked.result.current.draft.failed).toBe(true)
  blocked.unmount(); denied.mockRestore()
  const restored = mount()
  expect(restored.result.current.draft.value.rows).toEqual([])
  expect(restored.result.current.draft.failed).toBe(false)
  act(() => { expect(restored.result.current.draft.save({ commonReason: '重新登录后依据', rows: [second] })).toBe(true) })
  restored.unmount()
  expect(mount().result.current.draft.value.rows).toEqual([second])
})
