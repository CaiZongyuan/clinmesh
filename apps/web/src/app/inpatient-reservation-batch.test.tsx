// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionContext } from '@clinmesh/contracts/his'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { reservationDraftScope, useReservationBatchDraft } from './inpatient-reservation-batch.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

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
function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client)
  return renderHook(() => { const write = useInpatientWriteIntent(session, () => undefined); return { write, draft: useReservationBatchDraft({ session, scope, schema, initial, write }) } }, {
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
