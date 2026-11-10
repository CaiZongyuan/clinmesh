// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientExecutionSchema, inpatientOrderSchema } from '@clinmesh/contracts/inpatient-clinical'
import { afterEach, expect, it, vi } from 'vitest'
import { executionDraftScope, useExecutionDrafts, type ExecutionAction } from './inpatient-execution-drafts.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'

const session: SessionContext = { actor: { actorId: 'nurse', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-nurse', roleCode: 'ward-nurse' }, user: { id: 'nurse', name: '合成护士', email: 'nurse@demo.clinmesh.local' }, availableRoles: [] }
const order = inpatientOrderSchema.parse({ id: 'order-1', admissionId: 'admission-1', kind: 'service', duration: 'temporary', catalogItemId: 'service-education', catalogVersion: 1, display: '合成教育', doseText: '1次', doseQuantity: 1, unit: '次', frequencyCode: 'QD', state: 'verified', version: 2, requestVersion: '2', signedAt: '2026-08-24T09:00:00+08:00', signedBy: 'doctor-1', organizationId: 'ward-1' })
const rows = [1, 2, 3].map(index => ({ id: `execution-${index}`, order: { ...order, id: `order-${index}`, display: `合成教育${index}` }, execution: inpatientExecutionSchema.parse({ id: `execution-${index}`, orderId: `order-${index}`, scheduledFor: '2026-08-24T09:00:00+08:00', status: 'pending', version: 1 }) }))
function response(id: string) {
  return { auditId: 'audit-1', requestId: 'receipt-1', warnings: [], effects: [{ kind: 'updated', reference: `Task/${id}`, versionId: '2' }, { kind: 'created', reference: `ChargeItem/charge-${id}`, versionId: '1' }], data: { admissionId: 'admission-1', encounterVersion: '1', diagnosis: { revision: 0, entries: [] }, orders: rows.map(row => row.order), executions: rows.map(row => ({ ...row.execution, ...(row.id === id ? { status: 'completed', version: 2 } : {}) })), dispenses: [], charges: [{ id: `charge-${id}`, label: '合成教育', kind: 'service', sourceId: id, organizationId: 'ward-1', serviceDate: '2026-08-24', amountFen: 3000, virtualTime: '2026-08-24T09:00:00+08:00', version: 1 }], chargesFen: 3000 } }
}
const clients: QueryClient[] = []
function mount(action: ExecutionAction = 'complete', activeSession = session) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  return renderHook(({ action, activeSession }) => {
    const write = useInpatientWriteIntent(activeSession, () => undefined)
    return { write, batch: useExecutionDrafts({ scope: executionDraftScope(activeSession, 'patient-1', 'admission-1', action), session: activeSession, write }) }
  }, { initialProps: { action, activeSession }, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('第二项丢响应停止后项，刷新只查原键且余项必须重新确认', async () => {
  const posts: Array<{ id: string; key: string | null }> = [], receipts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) {
      const key = new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey')!; receipts.push(key)
      return Response.json({ operationId: 'inpatient.execution.complete', idempotencyKey: key, status: 'completed', response: response('execution-2') })
    }
    const body = JSON.parse(String(init?.body)); posts.push({ id: body.input.executionId, key: new Headers(init?.headers).get('idempotency-key') })
    if (body.input.executionId === 'execution-2') throw new TypeError('合成响应丢失')
    return Response.json(response(body.input.executionId))
  }))
  const mounted = mount()
  act(() => { rows.forEach(row => mounted.result.current.batch.update(row, { verified: true, selected: true })); expect(mounted.result.current.batch.prepare(rows)).toBe(true) })
  const keys = mounted.result.current.batch.items.map(item => item.idempotencyKey)
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(posts.map(post => post.id)).toEqual(['execution-1', 'execution-2'])
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['success', 'unknown', 'ready'])
  mounted.unmount()
  const restored = mount()
  await act(async () => { await restored.result.current.batch.recover(() => true) })
  expect(receipts).toEqual([keys[1]])
  expect(restored.result.current.batch.rows.map(row => row.id)).toEqual(['execution-3'])
  await act(async () => { await restored.result.current.batch.start(() => true) })
  expect(posts).toHaveLength(2)
  act(() => { expect(restored.result.current.batch.prepare([rows[2]!])).toBe(true) })
  await act(async () => { await restored.result.current.batch.start(() => true) })
  expect(posts.map(post => post.id)).toEqual(['execution-1', 'execution-2', 'execution-3'])
  expect(restored.result.current.batch.rows).toEqual([])
})

it.each(['wrong-key', 'wrong-operation', 'missing-charge-effect', 'wrong-source', 'wrong-execution-version'])('错误的成功证明继续未知并保留原输入：%s', async kind => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    const output = response('execution-1')
    if (kind === 'missing-charge-effect') output.effects = output.effects.filter(effect => !effect.reference.startsWith('ChargeItem/'))
    if (kind === 'wrong-source') output.data.charges[0]!.sourceId = 'other-execution'
    if (kind === 'wrong-execution-version') output.data.executions[0]!.version = 1
    if (path.includes('/command-receipts?')) return Response.json({ operationId: kind === 'wrong-operation' ? 'inpatient.execution.administer' : 'inpatient.execution.complete', idempotencyKey: kind === 'wrong-key' ? 'other-key' : new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey'), status: 'completed', response: output })
    posts += 1
    if (kind === 'wrong-key' || kind === 'wrong-operation') throw new TypeError('合成丢响应')
    expect(new Headers(init?.headers).get('idempotency-key')).toBeTruthy()
    return Response.json(output)
  }))
  const mounted = mount()
  act(() => { rows.slice(0, 2).forEach(row => mounted.result.current.batch.update(row, { verified: true, selected: true })); mounted.result.current.batch.prepare(rows) })
  await act(async () => { await mounted.result.current.batch.start(() => true); await mounted.result.current.batch.recover(() => true) })
  expect(posts).toBe(1)
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['unknown', 'ready'])
  expect(mounted.result.current.batch.rows).toHaveLength(2)
  expect(mounted.result.current.write.pending).not.toBeNull()
})

it('已结算成功但清共享意图失败，仍能从原回执恢复且不重发已完成记录', async () => {
  let posts = 0, receipts = 0, rejectRemove = true
  const remove = Storage.prototype.removeItem
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
    if (rejectRemove && key.startsWith('clinmesh.inpatient-intent:')) throw new Error('合成清意图失败')
    remove.call(this, key)
  })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) { receipts += 1; return Response.json({ operationId: 'inpatient.execution.complete', idempotencyKey: new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey'), status: 'completed', response: response('execution-1') }) }
    posts += 1; return Response.json(response('execution-1'))
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true }); mounted.result.current.batch.prepare(rows) })
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(mounted.result.current.batch.rows).toEqual([])
  expect(mounted.result.current.batch.items[0]?.status).toBe('success')
  expect(mounted.result.current.write.pending).not.toBeNull()
  rejectRemove = false
  await act(async () => { await mounted.result.current.batch.recover(() => true) })
  expect(posts).toBe(1); expect(receipts).toBe(1)
  expect(mounted.result.current.batch.rows).toEqual([])
  expect(mounted.result.current.write.pending).toBeNull()
})

it('明确拒绝保留失败内容并继续独立项，双击不重复保存成功项', async () => {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    const id = JSON.parse(String(init?.body)).input.executionId; posts.push(id)
    return id === 'execution-1' ? Response.json({ error: { code: 'VERSION_CONFLICT', message: '合成执行单已变化' } }, { status: 409 }) : Response.json(response(id))
  }))
  const mounted = mount()
  act(() => { rows.forEach(row => mounted.result.current.batch.update(row, { verified: true, selected: true })); mounted.result.current.batch.prepare(rows) })
  await act(async () => { await Promise.all([mounted.result.current.batch.start(() => true), mounted.result.current.batch.start(() => true)]) })
  expect(posts).toEqual(['execution-1', 'execution-2', 'execution-3'])
  expect(mounted.result.current.batch.rows.map(row => [row.id, row.verified, row.selected])).toEqual([['execution-1', true, true]])
  expect(mounted.result.current.batch.items.map(item => item.status)).toEqual(['failed', 'success', 'success'])
  expect(mounted.result.current.batch.items[0]?.error?.message).toBe('合成执行单已变化')
})

it('原共享意图未保存时也先查原回执，明确404才同键同参数重放', async () => {
  let reads = 0
  const posts: Array<{ key: string | null; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) { reads += 1; return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成无回执' } }, { status: 404 }) }
    posts.push({ key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) })
    if (posts.length === 1) throw new TypeError('合成断线')
    return Response.json(response('execution-1'))
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true }); mounted.result.current.batch.prepare(rows) })
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  sessionStorage.removeItem(Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-intent:'))!)
  mounted.unmount()
  const restored = mount()
  await act(async () => { await restored.result.current.batch.recover(() => true) })
  expect(reads).toBe(1); expect(posts).toHaveLength(2)
  expect(posts[1]).toEqual(posts[0])
  expect(restored.result.current.batch.rows).toEqual([])
})

it.each(['receipt-forbidden', 'receipt-pending'])('原回执暂不能查明时保留未知与原键，不发第二笔：%s', async kind => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.includes('/command-receipts?')) return kind === 'receipt-forbidden' ? Response.json({ error: { code: 'FORBIDDEN', message: '合成回执拒绝' } }, { status: 403 }) : Response.json({ operationId: 'inpatient.execution.complete', idempotencyKey: new URL(path, 'https://synthetic.test').searchParams.get('idempotencyKey'), status: 'pending' })
    posts += 1; throw new TypeError('合成丢响应')
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true }); mounted.result.current.batch.prepare(rows) })
  await act(async () => { await mounted.result.current.batch.start(() => true); await mounted.result.current.batch.recover(() => true) })
  expect(posts).toBe(1); expect(mounted.result.current.batch.items[0]?.status).toBe('unknown')
  expect(mounted.result.current.write.pending?.idempotencyKey).toBe(mounted.result.current.batch.items[0]?.idempotencyKey)
})

it('执行清单按完整行动身份和动作隔离，20项上限不截断且真实退出清理', async () => {
  const mounted = mount()
  act(() => { rows.forEach(row => mounted.result.current.batch.update(row, { verified: true, selected: true })); mounted.result.current.batch.deselectAll() })
  expect(mounted.result.current.batch.rows.map(row => row.selected)).toEqual([false, false, false])
  const old = mounted.result.current.batch, another = { ...session, actor: { ...session.actor, locationId: 'different-location' } }
  mounted.rerender({ action: 'complete', activeSession: another })
  expect(mounted.result.current.batch.rows).toEqual([])
  act(() => { expect(old.update(rows[0]!, { verified: true })).toBe(false) })
  mounted.rerender({ action: 'complete', activeSession: session })
  expect(mounted.result.current.batch.rows).toHaveLength(3)
  mounted.rerender({ action: 'administer', activeSession: session })
  expect(mounted.result.current.batch.rows).toEqual([])
  mounted.rerender({ action: 'complete', activeSession: session })
  act(() => {
    mounted.result.current.batch.clear()
    for (let index = 0; index < 20; index += 1) expect(mounted.result.current.batch.update({ ...rows[0]!, id: `bounded-${index}`, execution: { ...rows[0]!.execution, id: `bounded-${index}` } }, { verified: true })).toBe(true)
    expect(mounted.result.current.batch.update(rows[1]!, { verified: true })).toBe(false)
  })
  expect(mounted.result.current.batch.rows).toHaveLength(20)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await act(async () => { await signOut() })
  expect(mounted.result.current.batch.rows).toEqual([])
})

it('持久保存失败保留已核实内容且阻止写入，损坏绑定不被静默覆盖', async () => {
  const mounted = mount(), fetch = vi.fn(async () => Response.json(response('execution-1'))); vi.stubGlobal('fetch', fetch)
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('合成空间不足') })
  act(() => { expect(mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true })).toBe(false) })
  expect(mounted.result.current.batch.rows[0]?.verified).toBe(true)
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(fetch).not.toHaveBeenCalled()
  save.mockRestore()
  act(() => { mounted.result.current.batch.clear(); mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true }); mounted.result.current.batch.prepare(rows) })
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.execution-batch:'))!, raw = JSON.parse(sessionStorage.getItem(key)!)
  raw.items[0].command.input.admissionId = 'other-admission'; sessionStorage.setItem(key, JSON.stringify(raw)); mounted.unmount()
  const restored = mount()
  expect(restored.result.current.batch.failed).toBe(true)
  expect(restored.result.current.batch.rows).toHaveLength(1)
  await act(async () => { await restored.result.current.batch.start(() => true); await restored.result.current.batch.recover(() => true) })
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['missing-created-task', 'wrong-reason', 'wrong-task', 'completed-task'])('PRN不能借历史或错误任务证明本次发起：%s', async kind => {
  const prnOrder = { ...order, kind: 'medication' as const, duration: 'long' as const, frequencyCode: 'PRN' as const }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    return Response.json({ ...response('execution-1'), effects: kind === 'missing-created-task' ? [] : [{ kind: 'created', reference: `Task/${kind === 'wrong-task' ? 'other-task' : 'old-task'}`, versionId: '1' }], data: { ...response('execution-1').data, orders: [prnOrder], executions: [{ id: 'old-task', orderId: prnOrder.id, scheduledFor: '2026-08-24T09:00:00+08:00', status: kind === 'completed-task' ? 'completed' : 'pending', version: 1, reason: kind === 'wrong-reason' ? '合成旧理由' : '合成本次理由' }], charges: [], chargesFen: 0 } })
  }))
  const mounted = mount('request-prn')
  act(() => { mounted.result.current.batch.update({ id: prnOrder.id, order: prnOrder }, { selected: true }); mounted.result.current.batch.setCommonReason('合成本次理由'); mounted.result.current.batch.prepare([{ id: prnOrder.id, order: prnOrder }]) })
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  expect(mounted.result.current.batch.items[0]?.status).toBe('unknown')
  expect(mounted.result.current.batch.rows).toHaveLength(1)
})

it.each(['denied-read', 'failed-remove'])('服务端已退出时私稿清理故障不判登录失败，当前运行时在恢复清理前不恢复旧输入：%s', async kind => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  const mounted = mount()
  act(() => { mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true }) })
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

it('退出清理待办失败仍保留未知写入的完整原意图与原键', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/auth/sign-out') return Response.json({})
    throw new TypeError('合成响应丢失')
  }))
  const mounted = mount()
  act(() => { mounted.result.current.batch.update(rows[0]!, { verified: true, selected: true }); mounted.result.current.batch.prepare(rows) })
  await act(async () => { await mounted.result.current.batch.start(() => true) })
  const intentKey = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.inpatient-intent:'))!, original = sessionStorage.getItem(intentKey)
  expect(mounted.result.current.write.pending?.idempotencyKey).toBe(mounted.result.current.batch.items[0]?.idempotencyKey)
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成删除失败') })
  await act(async () => { await signOut() })
  remove.mockRestore()
  expect(sessionStorage.getItem(intentKey)).toBe(original)
  const originalIntent = mounted.result.current.write.pending
  mounted.unmount()
  const restored = mount()
  expect(restored.result.current.batch.rows).toEqual([])
  expect(restored.result.current.write.pending).toEqual(originalIntent)
})
