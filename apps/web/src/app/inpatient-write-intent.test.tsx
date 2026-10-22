// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const session: SessionContext = { actor: { actorId: 'actor-registrar', epoch: 'epoch-1', workspaceId: 'workspace-demo',
  scenarioRunId: 'scenario-run-1', roleCode: 'registrar', practitionerRoleId: 'practitioner-role-registrar',
  practitionerId: 'practitioner-registrar', organizationId: 'organization-clinmesh', locationId: 'location-registrar' },
  user: { id: 'synthetic-user', name: '合成挂号员', email: 'registrar@demo.clinmesh.local' }, availableRoles: [] }
const command = { operation: 'inpatient.admission.register' as const, input: { expectedEpoch: 'epoch-1', patientId: 'synthetic-patient', patientVersion: '1',
  admissionRoute: 'direct' as const, wardId: 'ward-general', depositFen: 100000 } }
const response = { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: { admission: {
  id: 'synthetic-admission', patientId: 'synthetic-patient', patientName: '合成患者', inpatientNumber: 'ZY-SYNTHETIC', admissionRoute: 'direct',
  wardId: 'ward-general', organizationId: 'organization-inpatient-medicine', status: 'registered', financialStatus: 'open', recordStatus: 'open',
  registeredAt: '2026-08-24T09:00:00+08:00', depositFen: 100000, chargesFen: 0, versionId: '1',
} } }
const createHook = () => renderHook(() => useInpatientWriteIntent(session, () => undefined), {
  wrapper: ({ children }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>,
})
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('缺少回执时只用原输入和原key重发，未确认期间拒绝新输入', async () => {
  const posts: Array<{ key: string | undefined; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'synthetic missing' } }, { status: 404 })
    posts.push({ key: new Headers(init.headers).get('idempotency-key') ?? undefined, body: JSON.parse(String(init.body)) })
    if (posts.length === 1) throw new TypeError('synthetic network loss')
    return Response.json(response)
  }))
  const { result } = createHook()
  await act(async () => { await expect(result.current.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  expect(result.current.pending?.command).toEqual(command)
  await act(async () => { await expect(result.current.mutation.mutateAsync({ ...command, input: { ...command.input, depositFen: 1 } })).rejects.toMatchObject({ code: 'INPATIENT_INTENT_PENDING' }) })
  await act(async () => { await result.current.mutation.mutateAsync(undefined) })
  expect(posts).toHaveLength(2)
  expect(posts[1]).toEqual(posts[0])
  expect(result.current.pending).toBeNull()
  expect(sessionStorage.length).toBe(0)
})

it('恢复先核对真实Session，旧Epoch输入保持原值且不能发送到新Epoch', async () => {
  let currentSession = session
  const writes = vi.fn(async () => { throw new TypeError('synthetic response loss') })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/context' ? Response.json(currentSession) : writes()))
  const { result } = createHook()
  await act(async () => { await expect(result.current.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  const saved = sessionStorage.getItem(sessionStorage.key(0)!)
  currentSession = { ...session, actor: { ...session.actor, epoch: 'epoch-2', scenarioRunId: 'scenario-run-2' } }
  await act(async () => { await expect(result.current.mutation.mutateAsync(undefined)).rejects.toMatchObject({ code: 'INPATIENT_INTENT_CONTEXT_CHANGED' }) })
  expect(writes).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(saved)
  expect(result.current.pending?.command).toEqual(command)
})

it('严格拒绝持久数据的额外字段和伪造绑定，存储不可写时不发业务请求', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    throw new TypeError('synthetic response loss')
  })
  vi.stubGlobal('fetch', fetch)
  const initial = createHook()
  await act(async () => { await expect(initial.result.current.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  initial.unmount()
  const key = sessionStorage.key(0)!
  const saved = JSON.parse(sessionStorage.getItem(key)!)
  for (const invalid of [{ ...saved, token: 'synthetic-forbidden' }, { ...saved, binding: { ...saved.binding, accountId: 'another-user' } }]) {
    sessionStorage.setItem(key, JSON.stringify(invalid))
    fetch.mockClear()
    const hook = createHook()
    await act(async () => { await expect(hook.result.current.mutation.mutateAsync(undefined)).rejects.toMatchObject({ code: 'INPATIENT_INTENT_STORAGE_UNAVAILABLE' }) })
    expect(fetch).not.toHaveBeenCalled()
    hook.unmount()
  }
  sessionStorage.clear()
  const hook = createHook()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic quota') })
  fetch.mockClear()
  await act(async () => { await expect(hook.result.current.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'INPATIENT_INTENT_STORAGE_UNAVAILABLE' }) })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth/context')
})

it('不可信的4xx响应仍为结果未知，保留原意图并阻止新意图', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts += 1
    return new Response('synthetic proxy page', { status: 400, headers: { 'content-type': 'text/html' } })
  }))
  const { result } = createHook()
  await act(async () => { await expect(result.current.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE', status: 400 }) })
  expect(result.current.pending?.command).toEqual(command)
  expect(sessionStorage.length).toBe(1)
  await act(async () => { await expect(result.current.mutation.mutateAsync({ ...command, input: { ...command.input, depositFen: 1 } })).rejects.toMatchObject({ code: 'INPATIENT_INTENT_PENDING' }) })
  expect(posts).toBe(1)
})

it('同岗位的两个挂载同时提交时只有一个完整意图能发出业务写入', async () => {
  const releases: Array<() => void> = []
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') {
      await new Promise<void>(resolve => { releases.push(resolve) })
      return Response.json(session)
    }
    posts += 1
    throw new TypeError('synthetic response loss')
  }))
  const first = createHook()
  const second = createHook()
  await act(async () => {
    const a = first.result.current.mutation.mutateAsync(command).catch(error => error)
    const b = second.result.current.mutation.mutateAsync(command).catch(error => error)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    for (const release of releases) release()
    const errors = await Promise.all([a, b])
    expect(errors.map(error => error.code).sort()).toEqual(['INPATIENT_INTENT_PENDING', 'NETWORK_ERROR'])
  })
  expect(posts).toBe(1)
  expect(first.result.current.pending?.idempotencyKey).toBe(second.result.current.pending?.idempotencyKey)
})

it('首个挂载写入成功后，同scope后来挂载同步清除pending并解锁', async () => {
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts += 1
    await held
    return Response.json(response)
  }))
  const first = createHook()
  let submitting: Promise<unknown> | undefined
  await act(async () => {
    submitting = first.result.current.mutation.mutateAsync(command)
    await vi.waitFor(() => expect(posts).toBe(1))
  })
  const second = createHook()
  expect(second.result.current.blocked).toBe(true)
  await act(async () => { finish(); await submitting })
  expect(first.result.current.pending).toBeNull()
  expect(second.result.current.pending).toBeNull()
  expect(second.result.current.blocked).toBe(false)
})

it('病例切换卸载原挂载后，旧请求成功仍能解锁接收原意图的新挂载', async () => {
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    posts += 1
    await held
    return Response.json(response)
  }))
  const previous = createHook()
  let submitting: Promise<unknown> | undefined
  await act(async () => {
    submitting = previous.result.current.mutation.mutateAsync(command)
    await vi.waitFor(() => expect(posts).toBe(1))
  })
  previous.unmount()
  const current = createHook()
  expect(current.result.current.pending?.command).toEqual(command)
  await act(async () => { finish(); await submitting })
  expect(current.result.current.pending).toBeNull()
  expect(current.result.current.blocked).toBe(false)
})
