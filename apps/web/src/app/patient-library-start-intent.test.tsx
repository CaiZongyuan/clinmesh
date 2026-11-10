// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { usePatientLibraryVisitState } from './patient-library-visit-state.ts'
import { useInpatientReviewQueue } from './inpatient-review-queue.ts'

const session: SessionContext = { user: { id: 'synthetic-admin', name: '合成管理员', email: 'synthetic@example.test' }, availableRoles: [],
  actor: { actorId: 'synthetic-admin', epoch: 'synthetic-epoch', workspaceId: 'synthetic-workspace', scenarioRunId: 'synthetic-run', roleCode: 'administrator', practitionerRoleId: 'synthetic-role' } }
const command = { operation: 'registration.synthetic-case.start' as const,
  input: { caseId: 'case-a', activeBriefRevision: 2, expectedCaseRevision: 3,
    departmentId: 'synthetic-department', locationId: 'synthetic-location', visitDate: '2026-11-10', visitTypeId: 'synthetic-visit' },
  continuation: { current: { profileId: 'profile-a', caseId: 'case-a', name: '合成当前甲' },
    next: { profileId: 'profile-b', caseId: 'case-b', name: '合成下一乙', profileRevision: 1, caseRevision: 3, activeBriefRevision: 2 },
    page: 2, search: '合成', hasMore: true, queueReady: true } }
const response = { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: {
  syntheticCaseId: 'case-a', patientId: 'synthetic-patient', encounterId: 'synthetic-encounter', outpatientCaseId: 'synthetic-outpatient',
  queueTaskId: 'synthetic-queue', registrationId: 'synthetic-registration', status: 'awaiting-triage' } }
const clients: QueryClient[] = []
function createHook() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return renderHook(() => ({ write: useInpatientWriteIntent(session, () => undefined), visit: usePatientLibraryVisitState(session, command.continuation.current) }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(['operation', 'key', 'case'] as const)('门诊原回执的%s不匹配时保留恢复入口，不宣布原患者成功或重发', async mismatch => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'https://synthetic.example.test').searchParams
      return Response.json({ operationId: mismatch === 'operation' ? 'registration.synthetic-case.start-inpatient' : command.operation,
        idempotencyKey: mismatch === 'key' ? crypto.randomUUID() : query.get('idempotencyKey'), status: 'completed',
        response: mismatch === 'case' ? { ...response, data: { ...response.data, syntheticCaseId: 'case-other' } } : response })
    }
    posts += 1
    throw new TypeError('synthetic committed response loss')
  }))
  const original = createHook()
  await act(async () => { await expect(original.result.current.write.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  original.unmount()
  const restored = createHook()
  await act(async () => { await expect(restored.result.current.write.mutation.mutateAsync(undefined)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' }) })
  expect(restored.result.current.write.pending?.command).toEqual(command)
  expect(restored.result.current.visit.state.completion).toBeNull()
  expect(posts).toBe(1)
})

it.each([false, true])('门诊原页面卸载后迟到成功仍持久完成原队列，完成存储不可用=%s时只按回执补完成', async unavailable => {
  let finish: () => void = () => undefined
  const gate = new Promise<void>(resolve => { finish = resolve })
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) return Response.json({ operationId: command.operation,
      idempotencyKey: new URL(path, 'https://synthetic.example.test').searchParams.get('idempotencyKey'), status: 'completed', response })
    posts += 1
    await gate
    return Response.json(response)
  }))
  const original = createHook()
  let attempt: Promise<unknown> = Promise.resolve()
  await act(async () => { attempt = original.result.current.write.mutation.mutateAsync(command).catch(error => error) })
  await waitFor(() => expect(posts).toBe(1))
  original.unmount()
  const nativeSet = Storage.prototype.setItem
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (unavailable && key.startsWith('clinmesh.patient-library-visit:')) throw new Error('synthetic unavailable')
    nativeSet.call(this, key, value)
  })
  let outcome: unknown
  await act(async () => { finish(); outcome = await attempt })
  const restored = createHook()
  if (unavailable) {
    expect(outcome).toMatchObject({ code: 'INPATIENT_INTENT_STORAGE_UNAVAILABLE' })
    expect(restored.result.current.write.pending?.command).toEqual(command)
    expect(restored.result.current.visit.state.completion).toBeNull()
    set.mockRestore()
    await act(async () => { await restored.result.current.write.mutation.mutateAsync(undefined) })
  }
  expect(restored.result.current.write.pending).toBeNull()
  expect(restored.result.current.visit.state.completion).toEqual({ continuation: command.continuation, result: response.data })
  expect(posts).toBe(1)
})

it('等待原回执404期间服务端Actor变化时不重发原门诊开始', async () => {
  let currentSession = session, receipts = 0, posts = 0
  let finish: () => void = () => undefined
  const gate = new Promise<void>(resolve => { finish = resolve })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(currentSession)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      receipts += 1; await gate
      return Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: '合成原回执不存在' } }, { status: 404 })
    }
    posts += 1
    throw new TypeError('synthetic response loss')
  }))
  const hook = createHook()
  await act(async () => { await expect(hook.result.current.write.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  let recovery: Promise<unknown> = Promise.resolve()
  await act(async () => { recovery = hook.result.current.write.mutation.mutateAsync(undefined).catch(error => error) })
  await waitFor(() => expect(receipts).toBe(1))
  currentSession = { ...session, actor: { ...session.actor, practitionerRoleId: 'synthetic-other-role' } }
  let outcome: unknown
  await act(async () => { finish(); outcome = await recovery })
  expect(outcome).toMatchObject({ code: 'INPATIENT_INTENT_CONTEXT_CHANGED' })
  expect(hook.result.current.write.pending?.command).toEqual(command)
  expect(posts).toBe(1)
})

it('医保原回执完成在页面卸载后仍持久原具名队列，恢复时不再发核定', async () => {
  const review = { operation: 'inpatient.drg.payer.review' as const, input: { admissionId: 'synthetic-admission', encounterVersion: '3', expectedFingerprint: 'a'.repeat(64), reason: '合成核定说明' } }
  const context = { filter: 'pending', page: 2, queue: ['synthetic-admission', 'synthetic-next'],
    target: { id: 'synthetic-next', patientId: 'synthetic-next-patient', patientName: '合成医保下一份', versionId: '2' } }
  const queue = renderHook(() => useInpatientReviewQueue(session, review.input.admissionId))
  act(() => expect(queue.result.current.prepare(review, context)).toBe(true))
  queue.unmount()
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) return Response.json({ operationId: review.operation,
      idempotencyKey: new URL(path, 'https://synthetic.example.test').searchParams.get('idempotencyKey'), status: 'completed',
      response: { ...response, data: { admissionId: 'synthetic-admission', reviews: [] } } })
    posts += 1
    throw new TypeError('synthetic committed response loss')
  }))
  const original = createHook()
  await act(async () => { await expect(original.result.current.write.mutation.mutateAsync(review)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  original.unmount()
  const restored = createHook()
  await act(async () => { await restored.result.current.write.mutation.mutateAsync(undefined) })
  const restoredQueue = renderHook(() => useInpatientReviewQueue(session, review.input.admissionId))
  expect(restoredQueue.result.current.snapshots).toEqual([expect.objectContaining({ ...context, operation: review.operation, complete: true })])
  expect(restored.result.current.write.pending).toBeNull()
  expect(posts).toBe(1)
})
