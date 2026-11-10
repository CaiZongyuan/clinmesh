// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearInpatientReviewDrafts, completeInpatientReviewDraft, useInpatientReviewDraft } from './inpatient-review-draft.ts'

const session: SessionContext = { actor: { actorId: 'coder', workspaceId: 'workspace', epoch: 'epoch', scenarioRunId: 'run', practitionerRoleId: 'role', roleCode: 'medical-records' }, user: { id: 'account', name: '合成病案员', email: 'coder@demo.clinmesh.local' }, availableRoles: [] }
const command = { operation: 'inpatient.record.review', input: { admissionId: 'admission', reason: '原稿', outcome: 'approved' } }
const binding = { accountId: session.user.id, actor: session.actor }
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('关闭重开恢复患者原稿，已卸载成功仍消费原提交稿', () => {
  const first = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  act(() => first.result.current.setReason('原稿'))
  act(() => expect(first.result.current.prepare(command)).toBe(true))
  first.unmount()
  completeInpatientReviewDraft(command, binding)
  const reopened = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  expect(reopened.result.current.reason).toBe('')
})
it('迟到成功保留后续编辑，且不跨患者或完整身份清稿', () => {
  const first = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  act(() => first.result.current.setReason('原稿'))
  act(() => first.result.current.prepare(command))
  act(() => first.result.current.setReason('迟到编辑'))
  const other = renderHook(() => useInpatientReviewDraft({ ...session, actor: { ...session.actor, actorId: 'other' } }, 'patient', 'admission', 'record'))
  act(() => other.result.current.setReason('另一身份'))
  act(() => completeInpatientReviewDraft(command, binding))
  expect(first.result.current.reason).toBe('迟到编辑')
  expect(other.result.current.reason).toBe('另一身份')
})
it('退出清私稿，prepare失败或未发送也不会残留说明', () => {
  const sent = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  const unsent = renderHook(() => useInpatientReviewDraft(session, 'patient-2', 'admission-2', 'record'))
  act(() => sent.result.current.setReason('原稿'))
  act(() => sent.result.current.prepare(command))
  act(() => unsent.result.current.setReason('未发'))
  act(() => clearInpatientReviewDrafts())
  expect(sent.result.current.reason).toBe('')
  expect(unsent.result.current.reason).toBe('')
})
it('持久化失败阻发送并允许保留编辑后重试', () => {
  const view = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('synthetic unavailable') })
  act(() => view.result.current.setReason('未落盘'))
  expect(view.result.current.error).toBe(true)
  act(() => expect(view.result.current.prepare(command)).toBe(false))
  write.mockRestore()
  act(() => view.result.current.retry())
  expect(view.result.current.error).toBe(false)
  expect(view.result.current.reason).toBe('未落盘')
})

it('其他患者或账号损坏的私稿不阻原成功回执完成', () => {
  const view = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  act(() => view.result.current.setReason('原稿'))
  act(() => view.result.current.prepare(command))
  const other = renderHook(() => useInpatientReviewDraft(session, 'other-patient', 'other-admission', 'record'))
  act(() => other.result.current.setReason('另一患者'))
  const otherKey = Object.keys(sessionStorage).find(key => decodeURIComponent(key).includes('other-admission'))!
  sessionStorage.setItem(otherKey, '{broken')
  sessionStorage.setItem('clinmesh.inpatient-review-draft:v1:unrelated-account', '{broken')
  act(() => expect(() => completeInpatientReviewDraft(command, binding)).not.toThrow())
  expect(view.result.current.reason).toBe('')
  expect(sessionStorage.getItem(otherKey)).toBe('{broken')
})

it('退出清理受限后隐藏旧稿，存储恢复时先补清再允许新编辑', () => {
  const first = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  act(() => first.result.current.setReason('退出前私稿'))
  first.unmount()
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('synthetic unavailable') })
  expect(() => clearInpatientReviewDrafts()).toThrow()
  const restricted = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  expect(restricted.result.current.reason).toBe('')
  expect(restricted.result.current.error).toBe(true)
  restricted.unmount(); remove.mockRestore()
  const recovered = renderHook(() => useInpatientReviewDraft(session, 'patient', 'admission', 'record'))
  expect(recovered.result.current.reason).toBe('')
  expect(recovered.result.current.error).toBe(false)
  act(() => recovered.result.current.setReason('退出后的新稿'))
  expect(recovered.result.current.reason).toBe('退出后的新稿')
})
