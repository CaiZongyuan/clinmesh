// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { surgeryDraftScope, useSurgeryDraft } from './inpatient-surgery-draft.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '合成医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const schema = z.object({ note: z.string() }).strict()
const commandInput = { admissionId: 'admission-1', requestId: 'request-1', expectedRequestVersion: 1, note: '合成手术依据' }
const commands = [
  { operation: 'inpatient.surgery.execute' as const, input: { ...commandInput, procedureId: 'procedure-1', catalogVersion: 1, materials: [] } },
  { operation: 'inpatient.surgery.complete' as const, input: { ...commandInput, executionId: 'execution-1' } },
]
const response = { auditId: 'audit-1', requestId: 'receipt-1', effects: [], warnings: [], data: {
  admissionId: 'admission-1', encounterVersion: '2', virtualTime: '2026-11-03T09:00:00+08:00', requests: [], executions: [], inProgress: [],
} }
const corrupted = '{synthetic-corrupted'
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

async function loseSurgeryResponse(command: typeof commands[number]) {
  const posts: Array<{ key: string | null; body: unknown }> = []
  const receipt = vi.fn(() => Response.json({ operationId: command.operation, idempotencyKey: posts[0]?.key, status: 'completed', response }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/auth/context') return Response.json(session)
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      expect(new URL(path, 'http://synthetic.local').searchParams.get('idempotencyKey')).toBe(posts[0]?.key)
      return receipt()
    }
    posts.push({ key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) })
    throw new TypeError('合成手术成功但响应丢失')
  }))
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
  const scope = surgeryDraftScope({ session, patientId: 'patient-1', admissionId: 'admission-1', requestId: 'request-1',
    ...(command.operation === 'inpatient.surgery.complete' ? { action: 'complete', executionId: command.input.executionId } : { action: 'execute' }) })
  const first = renderHook(() => ({ draft: useSurgeryDraft({ scope, schema, initial: { note: '' } }), write: useInpatientWriteIntent(session, () => undefined) }), { wrapper })
  act(() => { first.result.current.draft.save({ note: command.input.note }); expect(first.result.current.draft.prepareSubmission(command)).toBe(true) })
  const key = Object.keys(sessionStorage).find(key => key.startsWith('clinmesh.surgery-draft:v1:'))!
  await act(async () => { await expect(first.result.current.write.mutation.mutateAsync(command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' }) })
  first.unmount()
  sessionStorage.setItem(key, corrupted)
  const onSuccess = vi.fn()
  function Recovery() {
    const write = useInpatientWriteIntent(session, onSuccess)
    return <><InpatientWriteRecovery write={write} locale="zh-CN" /><p role="status">{write.blocked ? '原手术待恢复' : '可以继续办理'}</p></>
  }
  const open = () => render(<Recovery />, { wrapper })
  return { posts, receipt, scope, key, onSuccess, open }
}

it.each(commands)('$operation 的坏原稿仅在成功回执与明确确认后丢弃，其他手术及患者私稿保留', async command => {
  const original = await loseSurgeryResponse(command)
  const otherSurgery = renderHook(() => useSurgeryDraft({ scope: { ...original.scope, requestId: 'other-request' }, schema, initial: { note: '' } }))
  act(() => { expect(otherSurgery.result.current.save({ note: '另一台手术私稿' })).toBe(true) })
  otherSurgery.unmount()
  const otherPatient = renderHook(() => useSurgeryDraft({ scope: { ...original.scope, patientId: 'other-patient', admissionId: 'other-admission', requestId: 'other-patient-request' }, schema, initial: { note: '' } }))
  act(() => { expect(otherPatient.result.current.save({ note: '另一位患者私稿' })).toBe(true) })
  otherPatient.unmount()
  const otherKeys = Object.keys(sessionStorage).filter(key => key.startsWith('clinmesh.surgery-draft:v1:') && key !== original.key)
  sessionStorage.setItem(otherKeys[0]!, '{synthetic-other-corrupted')
  const others = otherKeys.map(key => [key, sessionStorage.getItem(key)] as const)
  const user = userEvent.setup(); original.open()
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
  expect(sessionStorage.getItem(original.key)).toBe(corrupted)
  expect(original.onSuccess).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '保留原记录' }))
  expect(sessionStorage.getItem(original.key)).toBe(corrupted)
  await user.click(screen.getByRole('button', { name: '丢弃原不可读记录' }))
  await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('可以继续办理'))
  expect(original.onSuccess).toHaveBeenCalledWith(command, response)
  expect(sessionStorage.getItem(original.key)).toBeNull()
  for (const [key, value] of others) expect(sessionStorage.getItem(key)).toBe(value)
  expect(original.posts).toHaveLength(1)
  expect(original.receipt).toHaveBeenCalledTimes(2)
})

it.each(commands.flatMap(command => (['missing', 'failed', 'changed-admission'] as const).map(outcome => ({ command, outcome }))))('$command.operation 确认丢弃时原回执$outcome仍保留坏稿及原意图，不重发手术', async ({ command, outcome }) => {
  const original = await loseSurgeryResponse(command), user = userEvent.setup()
  original.open()
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
  original.receipt.mockImplementation(() => outcome === 'changed-admission'
    ? Response.json({ operationId: command.operation, idempotencyKey: original.posts[0]?.key, status: 'completed', response: {
      ...response, data: { ...response.data, admissionId: 'other-admission' },
    } })
    : Response.json({ error: { code: outcome === 'missing' ? 'COMMAND_RECEIPT_NOT_FOUND' : 'INTERNAL_ERROR', message: '合成原回执不可用' } }, { status: outcome === 'missing' ? 404 : 500 }))
  await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
  await screen.findByRole('button', { name: '恢复原住院操作' })
  expect(screen.getByRole('status').textContent).toBe('原手术待恢复')
  expect(sessionStorage.getItem(original.key)).toBe(corrupted)
  expect(original.onSuccess).not.toHaveBeenCalled()
  expect(original.posts).toHaveLength(1)
  expect(original.receipt).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: '丢弃原不可读记录' })).toBeNull()
})

it.each(commands)('$operation 确认丢弃期间读取原稿失败不被当作坏稿删除，恢复读取后仍按原回执处理', async command => {
  const original = await loseSurgeryResponse(command), user = userEvent.setup()
  original.open()
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
  const get = Storage.prototype.getItem
  const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (key === original.key) throw new DOMException('合成原稿读取被拒', 'SecurityError')
    return get.call(this, key)
  })
  await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
  await screen.findByRole('button', { name: '恢复原住院操作' })
  expect(screen.getByRole('status').textContent).toBe('原手术待恢复')
  expect(get.call(sessionStorage, original.key)).toBe(corrupted)
  expect(screen.queryByRole('button', { name: '丢弃原不可读记录' })).toBeNull()
  expect(original.onSuccess).not.toHaveBeenCalled()
  denied.mockRestore()
  await user.click(screen.getByRole('button', { name: '恢复原住院操作' }))
  await user.click(await screen.findByRole('button', { name: '丢弃原不可读记录' }))
  await user.click(screen.getByRole('button', { name: '确认丢弃并恢复' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('可以继续办理'))
  expect(sessionStorage.getItem(original.key)).toBeNull()
  expect(original.posts).toHaveLength(1)
  expect(original.receipt).toHaveBeenCalledTimes(4)
})
