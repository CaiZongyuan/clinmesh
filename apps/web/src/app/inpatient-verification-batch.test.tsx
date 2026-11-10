// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import { afterEach, expect, it, vi } from 'vitest'
import { useInpatientOrderBatch, inpatientOrderBatchScope } from './inpatient-order-batch.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'

const session: SessionContext = { actor: { actorId: 'nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' }, user: { id: 'nurse', name: '合成护士', email: 'nurse@demo.clinmesh.local' }, availableRoles: [] }
const scope = inpatientOrderBatchScope(session, 'patient-1', 'admission-1')
const first = inpatientOrderSchema.parse({ id: 'order-1', admissionId: 'admission-1', kind: 'medication', duration: 'long', catalogItemId: 'medicine-1', catalogVersion: 1,
  display: '合成长期按需药', doseText: '500mg', doseQuantity: 1, unit: '片', frequencyCode: 'PRN', state: 'signed', version: 1, requestVersion: '1', signedAt: '2026-08-24T09:00:00+08:00', signedBy: 'doctor-1', organizationId: 'ward-1' })
const second = inpatientOrderSchema.parse({ ...first, id: 'order-2', display: '合成教育', kind: 'service', duration: 'temporary', doseQuantity: 2, doseText: '2次', unit: '次', frequencyCode: 'QD' })
const third = inpatientOrderSchema.parse({ ...second, id: 'order-3', doseQuantity: 1, doseText: '1次' })
const output = { auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [], data: { admissionId: 'admission-1', encounterVersion: '1', diagnosis: { revision: 0, entries: [] }, orders: [first, second, third].map(order => ({ ...order, state: 'verified', version: 2 })), executions: [], dispenses: [], charges: [], chargesFen: 0 } }
const clients: QueryClient[] = []
function mount(owner = scope, activeSession = session) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  return renderHook(({ owner, activeSession }) => {
    const write = useInpatientWriteIntent(activeSession, () => undefined)
    return { write, batch: useInpatientOrderBatch({ scope: owner, session: activeSession, write }) }
  }, { initialProps: { owner, activeSession }, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it.each(['denied-read', 'failed-remove'])('服务端退出成功后旧医嘱待办清理失败仍退出，恢复读取前先清理：%s', async kind => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first], true) })
  const storage = kind === 'denied-read'
    ? vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new DOMException('合成存储被禁止', 'SecurityError') })
    : vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成删除失败') })
  await act(async () => { await expect(signOut()).resolves.toBeUndefined() })
  expect(mounted.result.current.batch.rows).toEqual([])
  expect(mounted.result.current.batch.failed).toBe(true)
  storage.mockRestore()
  mounted.unmount()
  const restored = mount()
  expect(restored.result.current.batch.rows).toEqual([])
  expect(restored.result.current.batch.failed).toBe(false)
})

it.each(['request-stop', 'verify-stop'] as const)('%s逐项独立成功与丢响应，重载后只恢复原键原理由且不自动发送余项', async action => {
  const ownerSession: SessionContext = action === 'request-stop' ? { ...session, actor: { ...session.actor, roleCode: 'inpatient-doctor' } } : session
  const owner = inpatientOrderBatchScope(ownerSession, 'patient-1', 'admission-1', action)
  const orders = [first, second, third].map(order => inpatientOrderSchema.parse({ ...order, state: action === 'request-stop' ? 'verified' : 'stop-requested', ...(action === 'verify-stop' ? { stopReason: '合成正式理由' } : {}) }))
  const result = { ...output, data: { ...output.data, orders: orders.map(order => ({ ...order, state: action === 'request-stop' ? 'stop-requested' : 'stopped', version: 2, stopReason: order.id === second.id && action === 'request-stop' ? '合成单项理由' : action === 'request-stop' ? '合成共同理由' : '合成正式理由' })) } }
  const posts: Array<{ key: string | null; body: unknown }> = [], receipts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(ownerSession)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!; receipts.push(key)
      return Response.json({ operationId: `inpatient.order.${action}`, idempotencyKey: key, status: 'completed', response: result })
    }
    const body = JSON.parse(String(init?.body)); posts.push({ key: new Headers(init?.headers).get('idempotency-key'), body })
    if (body.input.orderId === second.id) throw new TypeError('合成响应丢失')
    return Response.json(result)
  }))
  const mounted = mount(owner, ownerSession)
  act(() => {
    mounted.result.current.batch.select(orders, true)
    if (action === 'request-stop') {
      mounted.result.current.batch.setCommonReason('合成共同理由')
      mounted.result.current.batch.setReasonOverride(second.id, '')
      expect(mounted.result.current.batch.prepare(orders)).toBe(false)
      mounted.result.current.batch.setReasonOverride(second.id, '合成单项理由')
    }
    expect(mounted.result.current.batch.prepare(orders)).toBe(true)
  })
  const keys = mounted.result.current.batch.items.map(item => item.idempotencyKey)
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(posts).toHaveLength(2)
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['success', 'unknown', 'ready'])
  if (action === 'request-stop') expect(posts.map(post => post.body)).toMatchObject([{ input: { reason: '合成共同理由' } }, { input: { reason: '合成单项理由' } }])
  mounted.unmount()
  const restored = mount(owner, ownerSession)
  await act(async () => { await restored.result.current.batch.recover(() => true) })
  expect(receipts).toEqual([keys[1]])
  expect(posts.map(post => post.key)).toEqual(keys.slice(0, 2))
  expect(restored.result.current.batch.rows.map(row => row.id)).toEqual([third.id])
  await act(async () => { await restored.result.current.batch.start(() => true) })
  expect(posts).toHaveLength(2)
})

it('护士校对与核停按动作隔离，错误岗位不能选择或恢复停嘱申请', () => {
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first], true) })
  const stopScope = inpatientOrderBatchScope(session, 'patient-1', 'admission-1', 'verify-stop')
  mounted.rerender({ owner: stopScope, activeSession: session })
  expect(mounted.result.current.batch.rows).toEqual([])
  act(() => { expect(mounted.result.current.batch.select([{ ...first, state: 'stop-requested' }], true)).toBe(true) })
  mounted.rerender({ owner: scope, activeSession: session })
  expect(mounted.result.current.batch.rows.map(row => row.order.state)).toEqual(['signed'])
  mounted.rerender({ owner: inpatientOrderBatchScope(session, 'patient-1', 'admission-1', 'request-stop'), activeSession: session })
  act(() => { expect(mounted.result.current.batch.select([first], true)).toBe(false) })
  expect(mounted.result.current.batch.failed).toBe(true)
})

it('核停响应擅改正式理由时不消费待办且保留原键恢复', async () => {
  const order = inpatientOrderSchema.parse({ ...first, state: 'stop-requested', stopReason: '合成原正式理由' })
  const owner = inpatientOrderBatchScope(session, 'patient-1', 'admission-1', 'verify-stop')
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/context' ? Response.json(session)
    : Response.json({ ...output, data: { ...output.data, orders: [{ ...order, state: 'stopped', version: 2, stopReason: '合成不符理由' }] } })))
  const mounted = mount(owner)
  act(() => { mounted.result.current.batch.select([order], true); mounted.result.current.batch.prepare([order]) })
  const key = mounted.result.current.batch.items[0]!.idempotencyKey
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(mounted.result.current.batch.items[0]).toMatchObject({ status: 'unknown', idempotencyKey: key })
  expect(mounted.result.current.batch.rows.map(row => row.order.stopReason)).toEqual(['合成原正式理由'])
})

it('校对草稿按完整身份与住院隔离，清空选择保留原项目，20条上限不截断输入，退出清理', async () => {
  const mounted = mount()
  act(() => { expect(mounted.result.current.batch.select([first, second], true)).toBe(true); mounted.result.current.batch.deselectAll() })
  expect(mounted.result.current.batch.rows.map(row => [row.id, row.selected])).toEqual([['order-1', false], ['order-2', false]])
  const old = mounted.result.current.batch
  const another = { ...session, actor: { ...session.actor, locationId: 'another-location' } }
  mounted.rerender({ owner: inpatientOrderBatchScope(another, 'patient-1', 'admission-1'), activeSession: another })
  expect(mounted.result.current.batch.rows).toEqual([])
  act(() => { expect(old.clear()).toBe(false); expect(old.select([third], true)).toBe(false) })
  mounted.rerender({ owner: scope, activeSession: session })
  expect(mounted.result.current.batch.rows).toHaveLength(2)
  const twenty = Array.from({ length: 20 }, (_, index) => ({ ...first, id: `bounded-${index}` }))
  act(() => { mounted.result.current.batch.clear(); expect(mounted.result.current.batch.select(twenty, true)).toBe(true) })
  act(() => { expect(mounted.result.current.batch.select([third], true)).toBe(false) })
  expect(mounted.result.current.batch.rows).toHaveLength(20)
  act(() => { expect(mounted.result.current.batch.select([{ ...first, state: 'stop-requested' }], true)).toBe(false) })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await act(async () => { await signOut() })
  expect(mounted.result.current.batch.rows).toEqual([])
})

it('第二笔丢响应后停止，刷新与共享恢复只查原key，未发送项必须重新审阅后才办理', async () => {
  const posts: Array<{ key: string | null; id: string }> = [], receipts: Array<string | null> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey'); receipts.push(key)
      return Response.json({ operationId: 'inpatient.order.verify', idempotencyKey: key, status: 'completed', response: output })
    }
    const body = JSON.parse(String(init?.body)); posts.push({ key: new Headers(init?.headers).get('idempotency-key'), id: body.input.orderId })
    if (body.input.orderId === second.id) throw new TypeError('合成响应丢失')
    return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first, second, third], true); expect(mounted.result.current.batch.prepare([first, second, third])).toBe(true) })
  const keys = mounted.result.current.batch.items.map(item => item.idempotencyKey)
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(posts.map(post => post.id)).toEqual(['order-1', 'order-2'])
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['success', 'unknown', 'ready'])
  act(() => { expect(mounted.result.current.batch.clear()).toBe(false) })
  mounted.unmount()
  const restored = mount()
  await act(async () => { await restored.result.current.write.mutation.mutateAsync(undefined) })
  expect(receipts).toEqual([keys[1]])
  expect(restored.result.current.batch.rows.map(row => row.id)).toEqual(['order-3'])
  await act(async () => { await restored.result.current.batch.start(() => true) })
  expect(posts).toHaveLength(2)
  act(() => { expect(restored.result.current.batch.prepare([third])).toBe(true) })
  await act(async () => { await restored.result.current.batch.start(() => true) })
  expect(posts.map(post => post.id)).toEqual(['order-1', 'order-2', 'order-3'])
  expect(posts.slice(0, 2).map(post => post.key)).toEqual(keys.slice(0, 2))
  expect(restored.result.current.batch.rows).toEqual([])
})

it('确定拒绝保留原输入且继续独立项目，重复点击不产生重复校对', async () => {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    const body = JSON.parse(String(init?.body)); posts.push(body.input.orderId)
    return body.input.orderId === first.id ? Response.json({ error: { code: 'VERSION_CONFLICT', message: '合成医嘱版本已变化' } }, { status: 409 }) : Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first, second], true); mounted.result.current.batch.prepare([first, second]) })
  await act(async () => { await Promise.all([mounted.result.current.batch.start(() => true), mounted.result.current.batch.start(() => true)]) })
  expect(posts).toEqual(['order-1', 'order-2'])
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['failed', 'success'])
  expect(mounted.result.current.batch.rows.map(row => row.order)).toEqual([first])
  act(() => { expect(mounted.result.current.batch.prepare([{ ...first, version: 2 }])).toBe(false) })
})

it('私稿存储失败保留选择并阻止发送，丢弃失败也不丢原输入', async () => {
  const mounted = mount(), fetch = vi.fn(async () => Response.json(output)); vi.stubGlobal('fetch', fetch)
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('合成空间不足') })
  act(() => { expect(mounted.result.current.batch.select([first], true)).toBe(false) })
  expect(mounted.result.current.batch.rows.map(row => row.order)).toEqual([first])
  expect(mounted.result.current.batch.failed).toBe(true)
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(fetch).not.toHaveBeenCalled()
  save.mockRestore()
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成丢弃失败') })
  act(() => { expect(mounted.result.current.batch.clear()).toBe(false) })
  expect(mounted.result.current.batch.rows.map(row => row.order)).toEqual([first])
  remove.mockRestore()
})

it('结构合法但命令错绑另一住院时保留原私稿并禁止发送', async () => {
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first], true); mounted.result.current.batch.prepare([first]) })
  mounted.unmount()
  const key = sessionStorage.key(0)!, record = JSON.parse(sessionStorage.getItem(key)!)
  record.items[0].command.input.admissionId = 'other-admission'
  sessionStorage.setItem(key, JSON.stringify(record))
  const fetch = vi.fn(async () => Response.json(output)); vi.stubGlobal('fetch', fetch)
  const restored = mount()
  expect(restored.result.current.batch.failed).toBe(true)
  expect(restored.result.current.batch.rows.map(row => row.order)).toEqual([first])
  await act(async () => { await restored.result.current.batch.start(() => true); await restored.result.current.batch.recover(() => true) })
  expect(fetch).not.toHaveBeenCalled()
})

it('未知原尝试即使共享意图尚未写成也先查原回执，确实不存在才原key原参数发送', async () => {
  let posts = 0, receiptReads = 0
  const bodies: unknown[] = [], keys: Array<string | null> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) { receiptReads += 1; return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成无回执' } }, { status: 404 }) }
    posts += 1; bodies.push(JSON.parse(String(init?.body))); keys.push(new Headers(init?.headers).get('idempotency-key'))
    if (posts === 1) throw new TypeError('合成断线')
    return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first], true); mounted.result.current.batch.prepare([first]) })
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  const intentKey = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-intent:'))!
  sessionStorage.removeItem(intentKey); mounted.unmount()
  const restored = mount()
  await act(async () => { await restored.result.current.batch.recover(() => true) })
  expect(receiptReads).toBe(1)
  expect(bodies).toEqual([{ input: { orderId: 'order-1', expectedOrderVersion: 1 } }, { input: { orderId: 'order-1', expectedOrderVersion: 1 } }])
  expect(keys[1]).toBe(keys[0])
  expect(restored.result.current.batch.rows).toEqual([])
})

it('切患者发生在身份预检时不发送旧住院，回原患者保留原尝试用于恢复', async () => {
  let release: () => void = () => undefined, posts = 0, authReads = 0, active = true
  const held = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') { authReads += 1; await held; return Response.json(session) }
    posts += 1; return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first], true); mounted.result.current.batch.prepare([first]) })
  let attempt: Promise<void> = Promise.resolve()
  act(() => { attempt = mounted.result.current.batch.start(() => active) })
  await waitFor(() => expect(authReads).toBe(1))
  active = false
  await act(async () => { release(); await attempt })
  expect(posts).toBe(0)
  expect(mounted.result.current.batch.rows.map(row => row.order)).toEqual([first])
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['unknown'])
})

it.each(['wrong-admission', 'missing-order', 'wrong-version', 'receipt-rejected'])('成功形状不足以消费私稿，归属或回执错误继续保留原尝试：%s', async kind => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) return Response.json({ error: { code: 'FORBIDDEN', message: '合成回执读取拒绝' } }, { status: 403 })
    posts += 1
    if (kind === 'receipt-rejected') throw new TypeError('合成写后丢响应')
    return Response.json({ ...output, data: { ...output.data,
      admissionId: kind === 'wrong-admission' ? 'other-admission' : 'admission-1',
      orders: kind === 'missing-order' ? [] : output.data.orders.map(order => kind === 'wrong-version' && order.id === first.id ? { ...order, version: 1 } : order),
    } })
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first, second], true); mounted.result.current.batch.prepare([first, second]) })
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(posts).toBe(1)
  expect(mounted.result.current.batch.rows.map(row => row.id)).toEqual(['order-1', 'order-2'])
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['unknown', 'ready'])
  expect(mounted.result.current.write.pending).not.toBeNull()
  await act(async () => { await mounted.result.current.batch.recover(() => true) })
  expect(posts).toBe(1)
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['unknown', 'ready'])
})

it('迟到成功结算旧尝试但不删除该行后来修订的选择', async () => {
  let release: () => void = () => undefined, posts = 0
  const held = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts += 1; await held; return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.select([first], true); mounted.result.current.batch.prepare([first]) })
  let attempt: Promise<void> = Promise.resolve()
  act(() => { attempt = mounted.result.current.batch.start(() => true) })
  await waitFor(() => expect(posts).toBe(1))
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.verification-batch:'))!
  const record = JSON.parse(sessionStorage.getItem(key)!)
  record.rows[0].revision = crypto.randomUUID()
  record.rows[0].selected = false
  sessionStorage.setItem(key, JSON.stringify(record))
  await act(async () => { release(); await attempt })
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['success'])
  expect(mounted.result.current.batch.rows.map(row => [row.id, row.selected])).toEqual([['order-1', false]])
})
