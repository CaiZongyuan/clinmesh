// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { surgeryDraftScope, useSurgeryDraft } from './inpatient-surgery-draft.ts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { signOut } from './api-client.ts'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const schema = z.object({ note: z.string() }).strict()
const scope = surgeryDraftScope({ session, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', action: 'execute' })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('手术未提交输入在重挂载后恢复，并按完整岗位和患者隔离', () => {
  const first = renderHook(() => useSurgeryDraft({ scope, schema, initial: { note: '' } }))
  act(() => { expect(first.result.current.save({ note: '合成补录依据' })).toBe(true) })
  first.unmount()
  const restored = renderHook(() => useSurgeryDraft({ scope, schema, initial: { note: '' } }))
  expect(restored.result.current.value.note).toBe('合成补录依据')
  const other = surgeryDraftScope({ session: { ...session, actor: { ...session.actor, locationId: 'other-location' } }, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1', action: 'execute' })
  const isolated = renderHook(() => useSurgeryDraft({ scope: other, schema, initial: { note: '' } }))
  expect(isolated.result.current.value.note).toBe('')
  expect(restored.result.current.value.note).toBe('合成补录依据')
})

it('切换患者后旧私稿句柄不可写入、清空或准备原患者提交', () => {
  const nextScope = { ...scope, patientId: 'patient-2', admissionId: 'admission-2', requestId: 'request-2' }
  const draft = renderHook(({ owner }) => useSurgeryDraft({ scope: owner, schema, initial: { note: '' } }), { initialProps: { owner: scope } })
  act(() => { draft.result.current.save({ note: '第一位患者人工输入' }) })
  const old = draft.result.current
  draft.rerender({ owner: nextScope })
  act(() => { draft.result.current.save({ note: '第二位患者人工输入' }) })
  act(() => { expect(old.save({ note: '迟到输入' })).toBe(false); expect(old.clear()).toBe(false) })
  expect(draft.result.current.value.note).toBe('第二位患者人工输入')
  draft.rerender({ owner: scope })
  expect(draft.result.current.value.note).toBe('第一位患者人工输入')
})

it.each([false, true])('丢响应后恢复原手术回执，消费提交版本并保护后续编辑=%s', async editAfterSubmit => {
  const command = { operation: 'inpatient.surgery.execute' as const, input: { admissionId: 'admission-1', requestId: 'request-1', expectedRequestVersion: 1,
    note: '合成补录依据', procedureId: 'procedure-1', catalogVersion: 1, materials: [] } }
  const response = { auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [], data: {
    admissionId: 'admission-1', encounterVersion: '2', virtualTime: '2026-11-03T09:00:00+08:00', requests: [], executions: [], inProgress: [],
  } }
  const posts: Array<{ body: unknown; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const query = new URL(path, 'http://synthetic.local').searchParams
      expect(query.get('idempotencyKey')).toBe(posts[0]?.key)
      return Response.json({ operationId: command.operation, idempotencyKey: query.get('idempotencyKey'), status: 'completed', response })
    }
    posts.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') })
    throw new TypeError('合成已提交响应丢失')
  }))
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
  const open = () => renderHook(() => ({ draft: useSurgeryDraft({ scope, schema, initial: { note: '' } }), write: useInpatientWriteIntent(session, () => undefined) }), { wrapper })
  const first = open()
  act(() => { first.result.current.draft.save({ note: command.input.note }); expect(first.result.current.draft.prepareSubmission(command)).toBe(true) })
  await act(async () => { await expect(first.result.current.write.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  if (editAfterSubmit) act(() => { first.result.current.draft.save({ note: '后来人工编辑，不能被原回执删除' }) })
  first.unmount()
  const restored = open()
  await act(async () => { await restored.result.current.write.mutation.mutateAsync(undefined) })
  expect(posts).toHaveLength(1)
  expect(restored.result.current.write.pending).toBeNull()
  expect(restored.result.current.draft.value.note).toBe(editAfterSubmit ? '后来人工编辑，不能被原回执删除' : '')
})

it('保存失败保留本地输入并阻止准备新提交，退出登录清除所有手术私稿', async () => {
  const draft = renderHook(() => useSurgeryDraft({ scope, schema, initial: { note: '' } }))
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('合成存储空间不足') })
  act(() => { expect(draft.result.current.save({ note: '仍应看见的输入' })).toBe(false) })
  expect(draft.result.current.value.note).toBe('仍应看见的输入')
  expect(draft.result.current.failed).toBe(true)
  expect(draft.result.current.prepareSubmission({})).toBe(false)
  setItem.mockRestore()
  act(() => { draft.result.current.save({ note: '可持久输入' }) })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await act(async () => { await signOut() })
  draft.unmount()
  const nextLogin = renderHook(() => useSurgeryDraft({ scope, schema, initial: { note: '' } }))
  expect(nextLogin.result.current.value.note).toBe('')
})

it('非法未提交输入保留在本地并阻断提交，修正后可以重新保存', () => {
  const draft = renderHook(() => useSurgeryDraft({ scope, schema: z.object({ note: z.string().max(5) }).strict(), initial: { note: '' } }))
  act(() => { expect(draft.result.current.save({ note: '超过字段限制的人工输入' })).toBe(false) })
  expect(draft.result.current.value.note).toBe('超过字段限制的人工输入')
  expect(draft.result.current.failed).toBe(true)
  act(() => { expect(draft.result.current.save({ note: '已修正' })).toBe(true) })
  expect(draft.result.current.failed).toBe(false)
})

it('明确清空后使用最新临床初值，不被首次挂载的监听闭包覆盖', () => {
  const mounted = renderHook(({ initial }) => useSurgeryDraft({ scope, schema, initial }), { initialProps: { initial: { note: '首次临床初值' } } })
  act(() => { mounted.result.current.save({ note: '人工草稿' }) })
  mounted.rerender({ initial: { note: '最新临床初值' } })
  expect(mounted.result.current.value.note).toBe('人工草稿')
  act(() => { expect(mounted.result.current.clear()).toBe(true) })
  expect(mounted.result.current.value.note).toBe('最新临床初值')
})

it('服务端已成功但消费私稿失败时保留原意图，恢复只查原回执且忽略无关损坏key', async () => {
  const command = { operation: 'inpatient.surgery.execute' as const, input: { admissionId: 'admission-1', requestId: 'request-1', expectedRequestVersion: 1,
    note: '合成整台补录', procedureId: 'procedure-1', catalogVersion: 1, materials: [] } }
  const response = { auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [], data: {
    admissionId: 'admission-1', encounterVersion: '2', virtualTime: '2026-11-03T09:00:00+08:00', requests: [], executions: [], inProgress: [],
  } }
  let posts = 0, receiptReads = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      receiptReads += 1
      return Response.json({ operationId: command.operation, idempotencyKey: new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey'), status: 'completed', response })
    }
    posts += 1; return Response.json(response)
  }))
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const mounted = renderHook(() => ({ draft: useSurgeryDraft({ scope, schema, initial: { note: '' } }), write: useInpatientWriteIntent(session, () => undefined) }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  act(() => { mounted.result.current.draft.save({ note: command.input.note }); mounted.result.current.draft.prepareSubmission(command) })
  sessionStorage.setItem('clinmesh.surgery-draft:v1:%broken', 'unrelated invalid key')
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成私稿清理失败') })
  await act(async () => { await expect(mounted.result.current.write.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'INPATIENT_INTENT_STORAGE_UNAVAILABLE' }) })
  expect(mounted.result.current.write.pending?.command).toEqual(command)
  expect(mounted.result.current.draft.value.note).toBe(command.input.note)
  remove.mockRestore()
  await act(async () => { await mounted.result.current.write.mutation.mutateAsync(undefined) })
  expect(posts).toBe(1)
  expect(receiptReads).toBe(1)
  expect(mounted.result.current.write.pending).toBeNull()
  expect(mounted.result.current.draft.value.note).toBe('')
})

it.each(['remove', 'access'] as const)('退出删除被拒时隐藏手术旧输入，存储恢复后先清理再允许保存（%s）', async failure => {
  const open = () => renderHook(() => useSurgeryDraft({ scope, schema, initial: { note: '' } }))
  const original = open()
  act(() => { expect(original.result.current.save({ note: '退出前的合成人工输入' })).toBe(true) })
  original.unmount()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  const denied = failure === 'remove'
    ? vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('合成删除被拒') })
    : vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('合成存储访问被拒') })
  await expect(signOut()).resolves.toBeUndefined()
  const blocked = open()
  expect(blocked.result.current.value.note).toBe('')
  expect(blocked.result.current.failed).toBe(true)
  blocked.unmount(); denied.mockRestore()
  const restored = open()
  expect(restored.result.current.value.note).toBe('')
  expect(restored.result.current.failed).toBe(false)
  act(() => { expect(restored.result.current.save({ note: '重新登录后的新输入' })).toBe(true) })
  restored.unmount()
  expect(open().result.current.value.note).toBe('重新登录后的新输入')
})
