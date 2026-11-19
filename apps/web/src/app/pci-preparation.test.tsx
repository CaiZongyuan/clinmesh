// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { PciPreparation } from './pci-preparation.tsx'

const session: SessionContext = {
  user: { id: 'user-admin', email: 'admin@demo.clinmesh.local', name: '合成管理员' },
  actor: { actorId: 'actor-admin', epoch: 'epoch-1', locationId: 'admin-location', organizationId: 'hospital',
    practitionerId: 'admin', practitionerRoleId: 'role-admin', roleCode: 'administrator', scenarioRunId: 'run-1', workspaceId: 'workspace-demo' },
  availableRoles: [],
}
const source = {
  auditId: 'audit-source', requestId: 'request-source', effects: [], warnings: [], data: {
    profileId: 'profile-pci', sourceHash: 'a'.repeat(64), packageVersion: '2026-v1',
    case: { activeBriefRevision: 1, caseId: 'case-pci', caseType: 'new-problem', createdAt: '2026-10-27T00:00:00Z',
      profileId: 'profile-pci', profileRevision: 1, revision: 2, sourceHash: 'a'.repeat(64), status: 'brief-ready',
      updatedAt: '2026-10-27T00:00:00Z', visibleHistoryCount: 0, workspaceId: 'workspace-demo' },
  },
}
const authoredPackPending = {
  packageId: 'clinmesh-cardiorenal-authored-case-pack', packageVersion: '2026-11-19.r1',
  name: '心血管与慢病专病合成病例包', nameEn: 'Cardiorenal Specialist Synthetic Case Pack',
  readyCount: 0, totalCount: 1,
  cases: [{
    draftId: 'cardio-nstemi-chest-pain-v1', title: '病例① 高危非 ST 段抬高型心肌梗死',
    titleEn: 'Case 1: High-risk NSTEMI', recommendedEntry: 'outpatient',
    profileId: 'profile-nstemi', sourceHash: 'b'.repeat(64), case: null,
  }],
}
const authoredPackReady = {
  ...authoredPackPending, readyCount: 1,
  cases: [{
    ...authoredPackPending.cases[0]!,
    case: { ...source.data.case, caseId: 'case-nstemi', profileId: 'profile-nstemi', sourceHash: 'b'.repeat(64) },
  }],
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('prepares a fixed source from the page and recovers its lost receipt without another prepare request', async () => {
  let originalKey: string | null = null
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/his/v1/inpatient/pci-data') return Response.json({ error: { code: 'REFERENCE_RELEASE_NOT_FOUND', message: '资料未就绪' } }, { status: 409 })
    if (path === '/api/sim/v1/synthetic-cases/authored-pack') return Response.json(authoredPackPending)
    if (path === '/api/sim/v1/synthetic-cases/pci/prepare') {
      posts += 1
      originalKey = new Headers(init?.headers).get('idempotency-key')
      expect(JSON.parse(String(init?.body))).toEqual({ input: { expectedEpoch: 'epoch-1' } })
      throw new TypeError('Response lost')
    }
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const params = new URL(path, 'http://clinmesh.test').searchParams
      expect(params.get('idempotencyKey')).toBe(originalKey)
      expect(params.get('operationId')).toBe('admin.pci-case.prepare')
      return Response.json({ status: 'completed', operationId: 'admin.pci-case.prepare', idempotencyKey: originalKey, response: source })
    }
    throw new Error(path)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ready = vi.fn(async () => {})
  render(<QueryClientProvider client={client}><PciPreparation locale="zh-CN" session={session} onSourcePrepared={ready} /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '准备固定 PCI 病例' }))
  expect(await screen.findByRole('button', { name: '恢复原准备操作' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '恢复原准备操作' }))
  await waitFor(() => expect(ready).toHaveBeenCalledWith('profile-pci'))
  expect(posts).toBe(1)
  expect(await screen.findByText(/患者档案已就绪，可办理入院/)).toBeTruthy()
  client.clear()
})

it('displays authored case pack readiness with dynamic count and prepares the specialist pack', async () => {
  let preparedPosts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/his/v1/inpatient/pci-data') return Response.json({ error: { code: 'REFERENCE_RELEASE_NOT_FOUND', message: '资料未就绪' } }, { status: 409 })
    if (path === '/api/sim/v1/synthetic-cases/authored-pack') return Response.json(authoredPackPending)
    if (path === '/api/sim/v1/synthetic-cases/authored-pack/prepare') {
      preparedPosts += 1
      expect(new Headers(init?.headers).get('idempotency-key')).toBeTruthy()
      expect(JSON.parse(String(init?.body))).toEqual({ input: { expectedEpoch: 'epoch-1' } })
      return Response.json({ auditId: 'audit-pack', requestId: 'req-pack', effects: [], warnings: [], data: authoredPackReady })
    }
    throw new Error(path)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><PciPreparation locale="zh-CN" session={session} onSourcePrepared={async () => {}} /></QueryClientProvider>)
  expect(await screen.findByText(/心血管与慢病专病合成病例包：0\/1 已就绪/)).toBeTruthy()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '准备专病病例包（1 例）' }))
  expect(await screen.findByText(/心血管与慢病专病合成病例包：1\/1 已就绪/)).toBeTruthy()
  expect(preparedPosts).toBe(1)
  client.clear()
})

it('shows an error alert when authored case pack summary fails to load', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const path = String(url)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/his/v1/inpatient/pci-data') return Response.json({ error: { code: 'REFERENCE_RELEASE_NOT_FOUND', message: '资料未就绪' } }, { status: 409 })
    if (path === '/api/sim/v1/synthetic-cases/authored-pack') return Response.json({ error: { code: 'AUTHORED_PACK_UNAVAILABLE', message: '病例包状态读取失败' } }, { status: 500 })
    throw new Error(path)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><PciPreparation locale="zh-CN" session={session} onSourcePrepared={async () => {}} /></QueryClientProvider>)
  expect(await screen.findByText('专病病例包未就绪')).toBeTruthy()
  expect(screen.getByRole('button', { name: '准备专病病例包（5 例）' })).toBeTruthy()
  client.clear()
})

it('recovers a lost authored case pack prepare receipt without sending another prepare request', async () => {
  let originalKey: string | null = null
  let posts = 0
  const packReceipt = { auditId: 'audit-pack', requestId: 'req-pack', effects: [], warnings: [], data: authoredPackReady }
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/his/v1/inpatient/pci-data') return Response.json({ error: { code: 'REFERENCE_RELEASE_NOT_FOUND', message: '资料未就绪' } }, { status: 409 })
    if (path === '/api/sim/v1/synthetic-cases/authored-pack') return Response.json(authoredPackPending)
    if (path === '/api/sim/v1/synthetic-cases/authored-pack/prepare') {
      posts += 1
      originalKey = new Headers(init?.headers).get('idempotency-key')
      expect(JSON.parse(String(init?.body))).toEqual({ input: { expectedEpoch: 'epoch-1' } })
      throw new TypeError('Response lost')
    }
    if (path.startsWith('/api/his/v1/command-receipts?')) {
      const params = new URL(path, 'http://clinmesh.test').searchParams
      expect(params.get('idempotencyKey')).toBe(originalKey)
      expect(params.get('operationId')).toBe('admin.authored-case-pack.prepare')
      return Response.json({ status: 'completed', operationId: 'admin.authored-case-pack.prepare', idempotencyKey: originalKey, response: packReceipt })
    }
    throw new Error(path)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><PciPreparation locale="zh-CN" session={session} onSourcePrepared={async () => {}} /></QueryClientProvider>)
  expect(await screen.findByText(/心血管与慢病专病合成病例包：0\/1 已就绪/)).toBeTruthy()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '准备专病病例包（1 例）' }))
  expect(await screen.findByRole('button', { name: '恢复原准备操作' })).toBeTruthy()
  expect((screen.getByRole('button', { name: '准备 PCI 目录' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '准备固定 PCI 病例' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '准备专病病例包（1 例）' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '恢复原准备操作' }))
  expect(await screen.findByText(/心血管与慢病专病合成病例包：1\/1 已就绪/)).toBeTruthy()
  expect(posts).toBe(1)
  client.clear()
})
