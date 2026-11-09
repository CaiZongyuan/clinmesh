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
