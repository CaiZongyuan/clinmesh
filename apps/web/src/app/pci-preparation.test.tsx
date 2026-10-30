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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('prepares a fixed source from the page and recovers its lost receipt without another prepare request', async () => {
  let originalKey: string | null = null
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/auth/context') return Response.json(session)
    if (path === '/api/his/v1/inpatient/pci-data') return Response.json({ error: { code: 'REFERENCE_RELEASE_NOT_FOUND', message: '资料未就绪' } }, { status: 409 })
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
