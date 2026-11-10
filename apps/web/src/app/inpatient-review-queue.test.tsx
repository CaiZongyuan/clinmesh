// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInpatientReviewQueue } from './inpatient-review-queue.ts'
import { completeInpatientReviewDraft } from './inpatient-review-draft.ts'

const session: SessionContext = { actor: { actorId: 'coder', workspaceId: 'workspace', epoch: 'epoch', scenarioRunId: 'run', practitionerRoleId: 'role', roleCode: 'medical-records' }, user: { id: 'account', name: '合成病案员', email: 'coder@demo.clinmesh.local' }, availableRoles: [] }
const command = { operation: 'inpatient.record.review' as const, input: { admissionId: 'source', expectedRevision: 1, expectedSourcesHash: 'a'.repeat(64), outcome: 'approved' } }
const context = { filter: 'open', page: 2, queue: ['source', 'target'], target: { id: 'target', patientId: 'patient', patientName: '合成下一份', versionId: '1' } }
const binding = { accountId: session.user.id, actor: session.actor }
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('刷新后原回执完成持久队列，恢复原姓名、筛选、页码与动作', () => {
  const original = renderHook(() => useInpatientReviewQueue(session, 'source'))
  act(() => expect(original.result.current.prepare(command, context)).toBe(true))
  original.unmount()
  // writer 的普通响应与 receipt 路径共用这个持久完成 owner。
  completeInpatientReviewDraft(command, binding)
  const restored = renderHook(() => useInpatientReviewQueue(session, 'source'))
  expect(restored.result.current.snapshots).toEqual([expect.objectContaining({ ...context, complete: true, operation: command.operation })])
  const another = renderHook(() => useInpatientReviewQueue({ ...session, actor: { ...session.actor, actorId: 'other' } }, 'source'))
  expect(another.result.current.snapshots).toEqual([])
})
it('新修订重试覆盖原snapshot，旧回执不得完成新动作', () => {
  const view = renderHook(() => useInpatientReviewQueue(session, 'source'))
  act(() => view.result.current.prepare(command, context))
  const revised = { ...command, input: { ...command.input, expectedRevision: 2 } }
  act(() => view.result.current.prepare(revised, context))
  act(() => completeInpatientReviewDraft(command, binding))
  expect(view.result.current.snapshots[0]?.complete).toBe(false)
  act(() => completeInpatientReviewDraft(revised, binding))
  expect(view.result.current.snapshots[0]?.complete).toBe(true)
})
it('快照存储失败阻提交，成功重试后才形成可恢复原队列', () => {
  const view = renderHook(() => useInpatientReviewQueue(session, 'source'))
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic unavailable') })
  act(() => expect(view.result.current.prepare(command, context)).toBe(false))
  expect(view.result.current.error).toBe(true)
  write.mockRestore()
  act(() => view.result.current.retry())
  act(() => expect(view.result.current.prepare(command, context)).toBe(true))
  expect(view.result.current.snapshots[0]?.complete).toBe(false)
})
