// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearPatientLibraryVisitDrafts, completePatientLibraryVisit, PatientLibraryDraftUnreadable, patientLibraryOwner,
  patientLibraryVisitStorage, usePatientLibraryVisitState } from './patient-library-visit-state.ts'

const session: SessionContext = { user: { id: 'synthetic-admin', name: '合成管理员', email: 'synthetic@example.test' }, availableRoles: [],
  actor: { actorId: 'synthetic-admin', epoch: 'synthetic-epoch', workspaceId: 'synthetic-workspace', scenarioRunId: 'synthetic-run', roleCode: 'administrator', practitionerRoleId: 'synthetic-role' } }
const current = { profileId: 'profile-a', caseId: 'case-a', name: '合成当前甲' }
const originalDraft = { departmentId: 'synthetic-department', locationId: 'synthetic-location', visitTypeId: 'synthetic-visit' }
const command = { operation: 'registration.synthetic-case.start' as const,
  input: { ...originalDraft, caseId: current.caseId, activeBriefRevision: 2, expectedCaseRevision: 3, visitDate: '2026-11-10' },
  continuation: { current, next: null, page: 1, search: '', hasMore: false, queueReady: true } }
const response = { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: {
  syntheticCaseId: current.caseId, patientId: 'synthetic-patient', encounterId: 'synthetic-encounter', outpatientCaseId: 'synthetic-outpatient',
  queueTaskId: 'synthetic-queue', registrationId: 'synthetic-registration', status: 'awaiting-triage' } }
const mount = () => renderHook(() => usePatientLibraryVisitState(session, current))
const owner = patientLibraryOwner(session)
beforeEach(() => sessionStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearPatientLibraryVisitDrafts() })

it('读取失败时编辑不会覆盖原私稿，重试只重读并恢复原选择', () => {
  const original = mount()
  act(() => original.result.current.saveDraft(originalDraft))
  const key = original.result.current.storage.key
  const raw = sessionStorage.getItem(key)
  expect(raw).not.toBeNull()
  original.unmount()
  const read = Storage.prototype.getItem
  const fault = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
    if (name === key) throw new Error('合成读取故障')
    return read.call(this, name)
  })
  const unavailable = mount()
  act(() => unavailable.result.current.saveDraft({ ...originalDraft, departmentId: 'synthetic-other' }))
  expect(read.call(sessionStorage, key)).toBe(raw)
  expect(unavailable.result.current.state.failure).toBe('read')
  act(() => unavailable.result.current.retry())
  expect(read.call(sessionStorage, key)).toBe(raw)
  fault.mockRestore()
  act(() => unavailable.result.current.retry())
  expect(unavailable.result.current.state).toMatchObject({ failure: null, draft: originalDraft })
  expect(sessionStorage.getItem(key)).toBe(raw)
})

it('保存失败保留本次选择，重试保存后仍能从原范围读回', () => {
  const hook = mount()
  const key = hook.result.current.storage.key
  const write = Storage.prototype.setItem
  const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name === key) throw new Error('合成保存故障')
    write.call(this, name, value)
  })
  act(() => hook.result.current.saveDraft(originalDraft))
  expect(hook.result.current.state).toMatchObject({ failure: 'save', draft: originalDraft })
  expect(sessionStorage.getItem(key)).toBeNull()
  fault.mockRestore()
  act(() => hook.result.current.retry())
  expect(hook.result.current.storage.load()).toMatchObject({ failure: null, draft: originalDraft })
})

it('成功原结果遇到坏稿保留原文，经授权仅替换仍不可读的原范围记录', () => {
  const storage = patientLibraryVisitStorage(owner, current)
  const other = patientLibraryVisitStorage(owner, { profileId: 'profile-b', caseId: 'case-b' })
  other.save(originalDraft, null)
  const otherRaw = sessionStorage.getItem(other.key)
  sessionStorage.setItem(storage.key, '{损坏的原稿')
  expect(() => completePatientLibraryVisit(command, response, owner)).toThrow(PatientLibraryDraftUnreadable)
  expect(sessionStorage.getItem(storage.key)).toBe('{损坏的原稿')
  completePatientLibraryVisit(command, response, owner, true)
  expect(storage.load()).toMatchObject({ failure: null, completion: { result: response.data } })
  expect(sessionStorage.getItem(other.key)).toBe(otherRaw)
  storage.save(originalDraft, null)
  completePatientLibraryVisit(command, response, owner, true)
  expect(storage.load()).toMatchObject({ failure: null, draft: originalDraft, completion: { result: response.data } })
})

it('明确丢弃前重读，已恢复的有效稿保留，仍不可读的草稿才清除', () => {
  const storage = patientLibraryVisitStorage(owner, current)
  sessionStorage.setItem(storage.key, '{损坏的草稿')
  const hook = mount()
  expect(hook.result.current.state.failure).toBe('read')
  act(() => hook.result.current.discardUnread())
  expect(sessionStorage.getItem(storage.key)).toBeNull()
  hook.unmount()
  sessionStorage.setItem(storage.key, '{待恢复草稿')
  const restored = mount()
  expect(restored.result.current.state.failure).toBe('read')
  restored.unmount()
  const read = Storage.prototype.getItem
  storage.save(originalDraft, null)
  const fault = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
    if (name === storage.key) throw new Error('合成读取故障')
    return read.call(this, name)
  })
  const unavailable = mount()
  fault.mockRestore()
  act(() => unavailable.result.current.discardUnread())
  expect(unavailable.result.current.state).toMatchObject({ failure: null, draft: originalDraft })
})
