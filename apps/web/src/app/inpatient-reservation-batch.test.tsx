// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { reservationDraftScope, useReservationBatchDraft } from './inpatient-reservation-batch.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const scope = reservationDraftScope({ session, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', action: 'create' })
const schema = z.object({ commonReason: z.string(), rows: z.array(z.object({ id: z.string(), revision: z.string(), selected: z.boolean(), note: z.string() }).strict()) }).strict()
const initial = { commonReason: '', rows: [] }
const firstRow = { id: 'row-1', revision: crypto.randomUUID(), selected: true, note: '第一种耗材依据' }
const secondRow = { id: 'row-2', revision: crypto.randomUUID(), selected: true, note: '第二种耗材依据' }
const command = (materialId: string) => ({ operation: 'inpatient.drg.reservation.create' as const, input: { admissionId: 'admission-1', encounterVersion: '1', requestId: 'request-1', materialId, catalogVersion: 1, quantity: 2, reason: '合成预留依据' } })
const entries = [{ rowId: firstRow.id, rowRevision: firstRow.revision, label: '第一种合成耗材', command: command('material-1') }, { rowId: secondRow.id, rowRevision: secondRow.revision, label: '第二种合成耗材', command: command('material-2') }]
const output = { auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [], data: { admissionId: 'admission-1', encounterVersion: '1', reservations: [], reservationSets: [] } }
const clients: QueryClient[] = []
const releaseScope = reservationDraftScope({ session, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', action: 'release' })
const releaseValueSchema = z.object({ commonReason: z.string(), rows: z.array(z.object({ id: z.string(), revision: z.string(), selected: z.boolean(),
  reservation: z.object({ id: z.string(), admissionId: z.string(), requestId: z.string(), version: z.number() }).strict(), reason: z.string() }).strict()) }).strict()
const releaseRow = { id: 'reservation-1', revision: crypto.randomUUID(), selected: true, reservation: { id: 'reservation-1', admissionId: 'admission-1', requestId: 'request-1', version: 4 }, reason: '合成核对余量释放' }
const releaseCommand = { operation: 'inpatient.drg.reservation.release' as const, input: { admissionId: 'admission-1', encounterVersion: '1', reservationId: 'reservation-1', expectedReservationVersion: 4, reason: releaseRow.reason } }
const releaseEntry = { rowId: releaseRow.id, rowRevision: releaseRow.revision, label: '合成待释放预留', command: releaseCommand }
function mountRelease(owner = releaseScope) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  return renderHook(() => { const write = useInpatientWriteIntent(session, () => undefined); return { write, draft: useReservationBatchDraft({ session, scope: owner, schema: releaseValueSchema, initial: { commonReason: '', rows: [] }, write }) } }, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}
function mount(owner = scope, activeSession = session) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  return renderHook(({ owner, activeSession }) => { const write = useInpatientWriteIntent(activeSession, () => undefined); return { write, draft: useReservationBatchDraft({ session: activeSession, scope: owner, schema, initial, write }) } }, {
    initialProps: { owner, activeSession },
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('集中核对后顺序复用单项Command，成功按原行修订消费且保留完整逐项结果', async () => {
  const posts: Array<{ key: string | null; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts.push({ key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) }); return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, secondRow] }); expect(mounted.result.current.draft.prepareBatch(entries)).toBe(true) })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts.map(post => post.body)).toEqual([
    { input: { encounterVersion: '1', requestId: 'request-1', materialId: 'material-1', catalogVersion: 1, quantity: 2, reason: '合成预留依据' } },
    { input: { encounterVersion: '1', requestId: 'request-1', materialId: 'material-2', catalogVersion: 1, quantity: 2, reason: '合成预留依据' } },
  ])
  expect(new Set(posts.map(post => post.key)).size).toBe(2)
  expect(mounted.result.current.draft.value.rows).toEqual([])
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['success', 'success'])
})

it('已核对未发出的行被编辑后不使用旧冻结输入，明确重新准备保留全部人工输入', async () => {
  const posts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts.push(init); return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, secondRow] }); mounted.result.current.draft.prepareBatch(entries) })
  const revised = { ...firstRow, revision: crypto.randomUUID(), note: '集中核对后新编辑' }
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [revised, secondRow] }) })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts).toEqual([])
  act(() => { expect(mounted.result.current.draft.discardReady()).toBe(true) })
  expect(mounted.result.current.draft.items).toEqual([])
  expect(mounted.result.current.draft.value.rows).toEqual([revised, secondRow])
})

it('第二项丢响应后停止，刷新只恢复该原key，余项由用户再次明确继续', async () => {
  const third = { ...secondRow, id: 'row-3', revision: crypto.randomUUID(), note: '第三种耗材依据' }
  const batch = [...entries, { rowId: third.id, rowRevision: third.revision, label: '第三种合成耗材', command: command('material-3') }]
  const posts: Array<{ key: string | null; materialId: string }> = [], receipts: Array<string | null> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const key = new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey'); receipts.push(key)
      return Response.json({ operationId: 'inpatient.drg.reservation.create', idempotencyKey: key, status: 'completed', response: output })
    }
    const body = JSON.parse(String(init?.body))
    posts.push({ key: new Headers(init?.headers).get('idempotency-key'), materialId: body.input.materialId })
    if (body.input.materialId === 'material-2') throw new TypeError('合成第二项已提交但响应丢失')
    return Response.json(output)
  }))
  const first = mount()
  act(() => { first.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, secondRow, third] }); first.result.current.draft.prepareBatch(batch) })
  const keys = first.result.current.draft.items.map(item => item.idempotencyKey)
  await act(async () => { await first.result.current.draft.start(() => true) })
  expect(posts.map(post => post.materialId)).toEqual(['material-1', 'material-2'])
  expect(first.result.current.draft.items.map(item => item.status)).toEqual(['success', 'unknown', 'ready'])
  expect(first.result.current.draft.value.rows).toEqual([secondRow, third])
  expect(first.result.current.draft.clear()).toBe(false)
  first.unmount()
  const restored = mount()
  await act(async () => { await restored.result.current.draft.resume(() => true) })
  expect(receipts).toEqual([keys[1]])
  expect(posts).toHaveLength(2)
  expect(restored.result.current.draft.items.map(item => item.status)).toEqual(['success', 'success', 'ready'])
  expect(restored.result.current.draft.value.rows).toEqual([third])
  await act(async () => { await restored.result.current.draft.start(() => true) })
  expect(posts).toEqual([{ key: keys[0], materialId: 'material-1' }, { key: keys[1], materialId: 'material-2' }, { key: keys[2], materialId: 'material-3' }])
  expect(restored.result.current.draft.value.rows).toEqual([])
})

it('确定拒绝保留原行并继续其他已核对项，迟到成功保留该行后来编辑', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    const body = JSON.parse(String(init?.body)); posts.push(body.input.materialId)
    if (body.input.materialId === 'material-1') return Response.json({ error: { code: 'CATALOG_CONFLICT', message: '合成第一项目录已变化' } }, { status: 409 })
    await held; return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, secondRow] }); mounted.result.current.draft.prepareBatch(entries) })
  let running: Promise<void> = Promise.resolve()
  await act(async () => { running = mounted.result.current.draft.start(() => true); await vi.waitFor(() => expect(posts).toEqual(['material-1', 'material-2'])) })
  const later = { ...secondRow, revision: crypto.randomUUID(), note: '原请求等待时后来新编辑' }
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, later] }) })
  await act(async () => { release(); await running })
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['failed', 'success'])
  expect(mounted.result.current.draft.items[0]?.error?.code).toBe('CATALOG_CONFLICT')
  expect(mounted.result.current.draft.value.rows).toEqual([firstRow, later])
  expect(mounted.result.current.write.pending).toBeNull()
})

it('超过20项或跨计划集中确认被阻止且输入不截断，退出登录清理隔离私稿', async () => {
  const mounted = mount(), many = Array.from({ length: 21 }, (_, index) => ({ ...firstRow, id: `row-${index}`, revision: crypto.randomUUID() }))
  act(() => { expect(mounted.result.current.draft.save({ commonReason: '共同依据', rows: many })).toBe(true) })
  act(() => { expect(mounted.result.current.draft.prepareBatch(many.map((row, index) => ({ rowId: row.id, rowRevision: row.revision, label: `合成项目${index}`, command: command(`material-${index}`) })))).toBe(false) })
  expect(mounted.result.current.draft.value.rows).toHaveLength(21)
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow] }); expect(mounted.result.current.draft.prepareBatch([{ ...entries[0]!, command: { ...command('material-1'), input: { ...command('material-1').input, requestId: 'other-request' } } }])).toBe(false) })
  const old = mounted.result.current.draft
  const another = { ...session, actor: { ...session.actor, locationId: 'other-location' } }
  mounted.rerender({ owner: reservationDraftScope({ session: another, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', action: 'create' }), activeSession: another })
  expect(mounted.result.current.draft.value.rows).toEqual([])
  act(() => { expect(old.save({ commonReason: '迟到旧账号写入', rows: [] })).toBe(false); expect(old.clear()).toBe(false) })
  mounted.rerender({ owner: scope, activeSession: session })
  expect(mounted.result.current.draft.value.rows).toEqual([firstRow])
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await act(async () => { await signOut() })
  expect(mounted.result.current.draft.value.rows).toEqual([])
})

it('私稿保存失败禁止发送；丢弃失败保留原输入及确认所需失败状态', async () => {
  const mounted = mount(), fetch = vi.fn(async () => Response.json(output))
  vi.stubGlobal('fetch', fetch)
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('合成空间不足') })
  act(() => { expect(mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow] })).toBe(false) })
  expect(mounted.result.current.draft.value.rows).toEqual([firstRow])
  expect(mounted.result.current.draft.failed).toBe(true)
  act(() => { expect(mounted.result.current.draft.prepareBatch([entries[0]!])).toBe(false) })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(fetch).not.toHaveBeenCalled()
  set.mockRestore()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow] }) })
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成丢弃失败') })
  act(() => { expect(mounted.result.current.draft.clear()).toBe(false) })
  expect(mounted.result.current.draft.failed).toBe(true)
  expect(mounted.result.current.draft.value.rows).toEqual([firstRow])
  remove.mockRestore()
})

it.each(['receipt-rejected', 'malformed-write', 'key-conflict'] as const)('非确定拒绝停在原尝试且不得继续或清空：%s', async kind => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) return Response.json({ error: { code: 'FORBIDDEN', message: '合成回执读取被拒绝' } }, { status: 403 })
    posts += 1
    if (kind === 'malformed-write') return new Response('<html>合成非可信响应</html>', { status: 409 })
    if (kind === 'key-conflict') return Response.json({ error: { code: 'IDEMPOTENCY_KEY_REUSED', message: '合成幂等冲突' } }, { status: 409 })
    throw new TypeError('合成响应丢失')
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, secondRow] }); mounted.result.current.draft.prepareBatch(entries) })
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  if (kind === 'receipt-rejected') await act(async () => { await mounted.result.current.draft.resume(() => true) })
  expect(posts).toBe(1)
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['unknown', 'ready'])
  expect(mounted.result.current.draft.value.rows).toEqual([firstRow, secondRow])
  expect(mounted.result.current.draft.clear()).toBe(false)
  expect(mounted.result.current.draft.discardReady()).toBe(false)
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts).toBe(1)
})

it('成功消费存储失败仍保留原意图，恢复原回执后暂停剩余项', async () => {
  let posts = 0, receiptReads = 0, rejectSettlement = false
  const originalSet = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (rejectSettlement && key.startsWith('clinmesh.reservation-batch:')) throw new Error('合成原行结算失败')
    originalSet.call(this, key, value)
  })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      receiptReads += 1
      return Response.json({ operationId: 'inpatient.drg.reservation.create', idempotencyKey: new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey'), status: 'completed', response: output })
    }
    posts += 1; rejectSettlement = true; return Response.json(output)
  }))
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '共同依据', rows: [firstRow, secondRow] }); mounted.result.current.draft.prepareBatch(entries) })
  const originalKey = mounted.result.current.draft.items[0]?.idempotencyKey
  await act(async () => { await mounted.result.current.draft.start(() => true) })
  expect(posts).toBe(1)
  expect(mounted.result.current.write.pending?.idempotencyKey).toBe(originalKey)
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['unknown', 'ready'])
  rejectSettlement = false
  await act(async () => { await mounted.result.current.draft.resume(() => true) })
  expect(posts).toBe(1)
  expect(receiptReads).toBe(1)
  expect(mounted.result.current.draft.items.map(item => item.status)).toEqual(['success', 'ready'])
  expect(mounted.result.current.draft.value.rows).toEqual([secondRow])
})

it('释放队列冻结原预留依据并按原单项合同提交，不把已变化的依据带入确认', async () => {
  const releaseScope = reservationDraftScope({ session, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', action: 'release' })
  const releaseSchema = z.object({ commonReason: z.string(), rows: z.array(z.object({ id: z.string(), revision: z.string(), selected: z.boolean(),
    reservation: z.object({ id: z.string(), admissionId: z.string(), requestId: z.string(), version: z.number() }).strict(), reason: z.string() }).strict()) }).strict()
  const row = { id: 'reservation-1', revision: crypto.randomUUID(), selected: true, reservation: { id: 'reservation-1', admissionId: 'admission-1', requestId: 'request-1', version: 4 }, reason: '合成核对余量释放' }
  const releaseCommand = { operation: 'inpatient.drg.reservation.release' as const, input: { admissionId: 'admission-1', encounterVersion: '1', reservationId: 'reservation-1', expectedReservationVersion: 4, reason: row.reason } }
  const posts: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts.push({ path, body: JSON.parse(String(init?.body)) }); return Response.json(output)
  }))
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  const mounted = renderHook(() => { const write = useInpatientWriteIntent(session, () => undefined); return useReservationBatchDraft({ session, scope: releaseScope, schema: releaseSchema, initial: { commonReason: '', rows: [] }, write }) }, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  act(() => { mounted.result.current.save({ commonReason: '', rows: [row] }) })
  act(() => { expect(mounted.result.current.prepareBatch([{ rowId: row.id, rowRevision: row.revision, label: '合成待释放预留', command: { ...releaseCommand, input: { ...releaseCommand.input, expectedReservationVersion: 3 } } }])).toBe(false) })
  act(() => { expect(mounted.result.current.prepareBatch([{ rowId: row.id, rowRevision: row.revision, label: '合成待释放预留', command: releaseCommand }])).toBe(true) })
  await act(async () => { await mounted.result.current.start(() => true) })
  expect(posts).toEqual([{ path: '/api/his/v1/inpatient/admissions/admission-1/drg/reservations/reservation-1/release', body: { input: { encounterVersion: '1', expectedReservationVersion: 4, reason: row.reason } } }])
  expect(mounted.result.current.value.rows).toEqual([])
})

it('会话已变化但调用方尚未换scope时不显示或改写原岗位输入', () => {
  const mounted = mount()
  act(() => { mounted.result.current.draft.save({ commonReason: '原岗位依据', rows: [firstRow] }) })
  const old = mounted.result.current.draft
  mounted.rerender({ owner: scope, activeSession: { ...session, actor: { ...session.actor, organizationId: 'other-organization' } } })
  expect(mounted.result.current.draft.value.rows).toEqual([])
  expect(mounted.result.current.draft.failed).toBe(true)
  act(() => { expect(old.clear()).toBe(false); expect(old.save({ commonReason: '迟到清空', rows: [] })).toBe(false) })
})

it('上层写入仍存活时卸载预留队列，迟到身份预检不发旧请求且输入可重挂载', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => { release = resolve })
  let reads = 0, posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') { reads += 1; await held; return Response.json(session) }
    posts += 1; return Response.json(output)
  }))
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const writer = renderHook(() => useInpatientWriteIntent(session, () => undefined), { wrapper })
  const open = () => renderHook(() => useReservationBatchDraft({ session, scope, schema, initial, write: writer.result.current }), { wrapper })
  const first = open()
  act(() => { first.result.current.save({ commonReason: '共同依据', rows: [firstRow] }); first.result.current.prepareBatch([entries[0]!]) })
  let running: Promise<void> = Promise.resolve()
  await act(async () => { running = first.result.current.start(() => true); await vi.waitFor(() => expect(reads).toBe(1)) })
  first.unmount()
  await act(async () => { release(); await running })
  expect(posts).toBe(0)
  expect(writer.result.current.pending).toBeNull()
  const restored = open()
  expect(restored.result.current.value.rows).toEqual([firstRow])
  expect(restored.result.current.items[0]?.status).toBe('unknown')
})

it.each(['ready', 'unknown'] as const)('持久%s项被改到其他住院、动作或计划后重新打开即阻断且保留输入', async status => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成没有回执' } }, { status: 404 })
    posts += 1; return Response.json(output)
  }))
  for (const changed of ['admission', 'action', 'request']) {
    sessionStorage.clear()
    const first = mount()
    act(() => { first.result.current.draft.save({ commonReason: '必须保留的原依据', rows: [firstRow, secondRow] }); first.result.current.draft.prepareBatch(entries) })
    first.unmount()
    const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.reservation-batch:'))!
    const record = JSON.parse(sessionStorage.getItem(key)!)
    record.items[0].status = status
    if (changed === 'admission') record.items[0].command.input.admissionId = 'other-admission'
    if (changed === 'request') record.items[0].command.input.requestId = 'other-request'
    if (changed === 'action') record.items[0].command = { operation: 'inpatient.drg.reservation.release', input: { admissionId: 'admission-1', encounterVersion: '1', reservationId: 'reservation-other', expectedReservationVersion: 1, reason: '被改为另一动作' } }
    const original = JSON.stringify(record)
    sessionStorage.setItem(key, original)
    const restored = mount()
    expect(restored.result.current.draft.failed).toBe(true)
    expect(restored.result.current.draft.blocked).toBe(true)
    expect(restored.result.current.draft.value).toEqual({ commonReason: '必须保留的原依据', rows: [firstRow, secondRow] })
    await act(async () => { await restored.result.current.draft.start(() => true); await restored.result.current.draft.resume(() => true) })
    act(() => { expect(restored.result.current.draft.save(restored.result.current.draft.value)).toBe(false) })
    expect(posts).toBe(0)
    expect(sessionStorage.getItem(key)).toBe(original)
    if (status === 'ready') {
      const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成清理失败') })
      act(() => { expect(restored.result.current.draft.clear()).toBe(false) })
      expect(restored.result.current.draft.value.rows).toEqual([firstRow, secondRow])
      expect(sessionStorage.getItem(key)).toBe(original)
      remove.mockRestore()
    } else expect(restored.result.current.draft.clear()).toBe(false)
    restored.unmount()
  }
})

it('原回执结算不能消费持久范围不符的项或丢弃其人工输入', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) return Response.json({ operationId: entries[0]!.command.operation,
      idempotencyKey: new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey'), status: 'completed', response: output })
    posts += 1; return Response.json(output)
  }))
  const first = mount()
  act(() => { first.result.current.draft.save({ commonReason: '原人工依据', rows: [firstRow] }); first.result.current.draft.prepareBatch([entries[0]!]) })
  first.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.reservation-batch:'))!
  const record = JSON.parse(sessionStorage.getItem(key)!)
  record.items[0].status = 'unknown'; record.items[0].command.input.requestId = 'other-request'
  const original = JSON.stringify(record); sessionStorage.setItem(key, original)
  const restored = mount()
  await act(async () => { await expect(restored.result.current.write.mutation.mutateAsync({ ...entries[0]!.command, idempotencyKey: record.items[0].idempotencyKey, recoverOriginal: true })).rejects.toMatchObject({ code: 'INPATIENT_INTENT_STORAGE_UNAVAILABLE' }) })
  expect(posts).toBe(0)
  expect(restored.result.current.write.pending?.command).toEqual(entries[0]!.command)
  expect(restored.result.current.draft.value.rows).toEqual([firstRow])
  expect(sessionStorage.getItem(key)).toBe(original)
})

it.each(['missing', 'reservation', 'request', 'admission', 'version'] as const)('释放原归属%s不完整或不匹配时安全阻断旧格式和篡改项', async changed => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { if (path === '/api/auth/context') return Response.json(session); posts += 1; return Response.json(output) }))
  const first = mountRelease()
  act(() => { first.result.current.draft.save({ commonReason: '原释放依据', rows: [releaseRow] }); expect(first.result.current.draft.prepareBatch([releaseEntry])).toBe(true) })
  first.unmount()
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.reservation-batch:'))!
  const record = JSON.parse(sessionStorage.getItem(key)!)
  record.items[0].status = 'unknown'
  if (changed === 'missing') delete record.items[0].releaseBinding
  if (changed === 'reservation') record.items[0].command.input.reservationId = 'other-reservation'
  if (changed === 'request') record.items[0].releaseBinding.requestId = 'other-request'
  if (changed === 'admission') record.items[0].releaseBinding.admissionId = 'other-admission'
  if (changed === 'version') record.items[0].command.input.expectedReservationVersion = 5
  const original = JSON.stringify(record); sessionStorage.setItem(key, original)
  const restored = mountRelease()
  expect(restored.result.current.draft.failed).toBe(true)
  expect(restored.result.current.draft.value.rows).toEqual([releaseRow])
  await act(async () => { await restored.result.current.draft.resume(() => true) })
  expect(posts).toBe(0)
  expect(sessionStorage.getItem(key)).toBe(original)
})

it('释放成功移出原行后仍能重开；未知恢复沿冻结归属并保留后来的人工编辑', async () => {
  let lose = false, posts = 0, receipts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) { receipts += 1; return Response.json({ operationId: releaseCommand.operation,
      idempotencyKey: new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey'), status: 'completed', response: output }) }
    posts += 1; if (lose) throw new TypeError('合成释放响应丢失'); return Response.json(output)
  }))
  const first = mountRelease()
  act(() => { first.result.current.draft.save({ commonReason: '', rows: [releaseRow] }); first.result.current.draft.prepareBatch([releaseEntry]) })
  await act(async () => { await first.result.current.draft.start(() => true) })
  first.unmount()
  const reopened = mountRelease()
  expect(reopened.result.current.draft.failed).toBe(false)
  expect(reopened.result.current.draft.value.rows).toEqual([])
  expect(reopened.result.current.draft.items[0]?.status).toBe('success')
  lose = true
  act(() => { reopened.result.current.draft.save({ commonReason: '', rows: [releaseRow] }); reopened.result.current.draft.prepareBatch([releaseEntry]) })
  await act(async () => { await reopened.result.current.draft.start(() => true) })
  const later = { ...releaseRow, revision: crypto.randomUUID(), reason: '后来重新核对的输入', reservation: { ...releaseRow.reservation, version: 5 } }
  act(() => { reopened.result.current.draft.save({ commonReason: '', rows: [later] }) })
  reopened.unmount()
  const restored = mountRelease()
  expect(restored.result.current.draft.failed).toBe(false)
  await act(async () => { await restored.result.current.draft.resume(() => true) })
  expect(posts).toBe(2)
  expect(receipts).toBe(1)
  expect(restored.result.current.draft.items[0]?.status).toBe('success')
  expect(restored.result.current.draft.value.rows).toEqual([later])
})

it.each(['response', 'receipt'] as const)('同住院其他手术坏稿不影响原释放的成功结算（%s）', async mode => {
  const other = mountRelease({ ...releaseScope, requestId: 'request-other' })
  act(() => { expect(other.result.current.draft.save({ commonReason: '另一台合成手术', rows: [] })).toBe(true) })
  other.unmount()
  const otherKey = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.reservation-batch:'))!
  sessionStorage.setItem(otherKey, '{broken')
  const posts: Array<string | null> = [], receiptKeys: Array<string | null> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const key = new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey')
      receiptKeys.push(key)
      return Response.json({ operationId: releaseCommand.operation, idempotencyKey: key, status: 'completed', response: output })
    }
    posts.push(new Headers(init?.headers).get('idempotency-key'))
    if (mode === 'receipt') throw new TypeError('合成释放响应丢失')
    return Response.json(output)
  }))
  const original = mountRelease()
  act(() => {
    expect(original.result.current.draft.save({ commonReason: '', rows: [releaseRow] })).toBe(true)
    expect(original.result.current.draft.prepareBatch([releaseEntry])).toBe(true)
  })
  await act(async () => { await original.result.current.draft.start(() => true) })
  if (mode === 'receipt') {
    expect(original.result.current.draft.items[0]?.status).toBe('unknown')
    original.unmount()
  }
  const settled = mode === 'receipt' ? mountRelease() : original
  if (mode === 'receipt') await act(async () => { await settled.result.current.draft.resume(() => true) })
  expect(settled.result.current.draft.items[0]?.status).toBe('success')
  expect(settled.result.current.draft.value.rows).toEqual([])
  expect(settled.result.current.write.pending).toBeNull()
  expect(posts).toHaveLength(1)
  expect(receiptKeys).toEqual(mode === 'receipt' ? posts : [])
  expect(sessionStorage.getItem(otherKey)).toBe('{broken')
})

it.each(['remove', 'access'] as const)('退出删除被拒时隐藏预留旧输入，存储恢复后先清理再允许保存（%s）', async failure => {
  const original = mount()
  act(() => { expect(original.result.current.draft.save({ commonReason: '退出前依据', rows: [firstRow] })).toBe(true) })
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
  act(() => { expect(restored.result.current.draft.save({ commonReason: '重新登录后依据', rows: [secondRow] })).toBe(true) })
  restored.unmount()
  expect(mount().result.current.draft.value.rows).toEqual([secondRow])
})
