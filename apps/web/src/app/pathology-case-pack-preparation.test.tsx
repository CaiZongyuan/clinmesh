// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PathologyCasePackPreparation } from './pathology-case-pack-preparation.tsx'

const session: SessionContext = { user: { id: 'synthetic-admin', email: 'admin@demo.clinmesh.local', name: '合成管理员' },
  actor: { actorId: 'synthetic-admin', epoch: 'epoch-1', practitionerRoleId: 'role-admin', roleCode: 'administrator',
    scenarioRunId: 'run-1', workspaceId: 'workspace-demo' }, availableRoles: [] }
const pending = { packageId: 'clinmesh-pathology-consultations-v1', packageVersion: '1', name: '结直肠与甲状腺既往切片会诊病例',
  nameEn: 'Prior colorectal and thyroid slide consultations', readyCount: 0, totalCount: 2,
  cases: ['结直肠息肉切除', '甲状腺手术'].map((name, index) => ({ draftId: `synthetic-${index}`, title: `既往${name}切片会诊`, titleEn: `Synthetic consultation ${index}`,
    recommendedEntry: 'outpatient', profileId: `profile-${index}`, sourceHash: 'a'.repeat(64), case: null })) }
const ready = { ...pending, readyCount: 2, cases: pending.cases.map((item, index) => ({ ...item, case: {
  activeBriefRevision: 1, caseId: `case-${index}`, caseType: 'new-problem', createdAt: '2026-11-23T00:00:00Z', profileId: item.profileId,
  profileRevision: 1, revision: 2, sourceHash: item.sourceHash, status: 'brief-ready', updatedAt: '2026-11-23T00:00:00Z', visibleHistoryCount: 1, workspaceId: 'workspace-demo',
} })) }
const response = { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: ready }
const base = '/api/sim/v1/admin/pathology-case-pack'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
function page(cache = client(), current = session) {
  return { cache, ...render(<QueryClientProvider client={cache}><PathologyCasePackPreparation locale="zh-CN" session={current} /></QueryClientProvider>) }
}

it('从管理员页面显示两例准备状态并准备病理病例，成功后刷新患者库', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url) === base) return Response.json(pending)
    if (String(url) === `${base}/prepare`) { posts++; expect(JSON.parse(String(init?.body))).toEqual({ input: { expectedEpoch: 'epoch-1' } }); return Response.json(response) }
    throw new Error(String(url))
  }))
  const { cache } = page()
  expect(await screen.findByText('既往结直肠息肉切除切片会诊')).toBeTruthy()
  expect(screen.getByText('既往甲状腺手术切片会诊')).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: '准备病理病例包（2 例）' }))
  expect(await screen.findByText('2/2 例已就绪')).toBeTruthy()
  expect(posts).toBe(1)
  cache.clear()
})

it('未知结果保留原键，面板重新挂载后先GET原回执恢复，不发送第二次准备', async () => {
  let key: string | null = null, posts = 0, lookups = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === base) return Response.json(pending)
    if (path === `${base}/prepare`) { posts++; key = new Headers(init?.headers).get('idempotency-key'); throw new TypeError('Response lost') }
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      lookups++; expect(new URL(path, 'http://synthetic.invalid').searchParams.get('idempotencyKey')).toBe(key)
      return Response.json({ status: 'completed', operationId: 'admin.authored-case-pack.prepare', idempotencyKey: key, response })
    }
    throw new Error(path)
  }))
  const first = page(), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '准备病理病例包（2 例）' }))
  expect(await screen.findByRole('button', { name: '恢复原病理病例准备' })).toBeTruthy()
  first.unmount()
  const next = page(first.cache)
  expect((screen.getByRole('button', { name: '准备病理病例包（2 例）' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '恢复原病理病例准备' }))
  expect(await screen.findByText('2/2 例已就绪')).toBeTruthy()
  expect([posts, lookups]).toEqual([1, 1])
  next.cache.clear()
})

it('原回执404时仅重发原包原body原键；异包回执无法解除待确认状态', async () => {
  const requests: Array<{ key: string | null; body: unknown }> = []
  let mode = 'wrong-pack'
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === base) return Response.json(pending)
    if (path === `${base}/prepare`) {
      requests.push({ key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) })
      if (requests.length === 1) throw new TypeError('Response lost')
      return Response.json(response)
    }
    if (path.startsWith('/api/his/v1/command-receipts?')) return mode === 'wrong-pack'
      ? Response.json({ status: 'completed', operationId: 'admin.authored-case-pack.prepare', idempotencyKey: requests[0]!.key,
        response: { ...response, data: { ...ready, packageId: 'other-case-pack' } } })
      : Response.json({ error: { code: 'COMMAND_RECEIPT_NOT_FOUND', message: 'No receipt' } }, { status: 404 })
    throw new Error(path)
  }))
  const { cache } = page(), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '准备病理病例包（2 例）' }))
  await user.click(await screen.findByRole('button', { name: '恢复原病理病例准备' }))
  expect(await screen.findByText('无法确认准备结果，请恢复原病理病例准备。')).toBeTruthy()
  expect(requests).toHaveLength(1)
  mode = 'missing'
  await user.click(screen.getByRole('button', { name: '恢复原病理病例准备' }))
  expect(await screen.findByText('2/2 例已就绪')).toBeTruthy()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  cache.clear()
})

it('切换数据世代不会读取上一世代的病例状态或待确认操作', async () => {
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url) === base) return Response.json(pending)
    if (String(url) === `${base}/prepare`) { posts++; throw new TypeError('Response lost') }
    throw new Error(String(url))
  }))
  const first = page(), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '准备病理病例包（2 例）' }))
  expect(await screen.findByRole('button', { name: '恢复原病理病例准备' })).toBeTruthy()
  first.unmount()
  const second = page(first.cache, { ...session, actor: { ...session.actor, epoch: 'epoch-2', scenarioRunId: 'run-2' } })
  await waitFor(() => expect((screen.getByRole('button', { name: '准备病理病例包（2 例）' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByRole('button', { name: '恢复原病理病例准备' })).toBeNull()
  expect(posts).toBe(1)
  second.cache.clear()
})
