// @vitest-environment jsdom
import type { SessionContext } from '@clinmesh/contracts/his'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPageRegistryProvider } from '../agent-page-context.tsx'
import { AgentReviewProvider } from '../agent-review.tsx'
import { DoctorWorkspace } from './doctor-case-controller.tsx'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

it('StrictMode 重放后导航可用，切换病例库保留滑块，切换身份与卸载清理宿主', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/his/v1/catalogs/clinical') return Response.json({ diagnoses: [], laboratory: [], medications: [], prescriptionConclusionSupported: true })
    if (url.pathname === '/api/his/v1/doctor/queue' || url.pathname === '/api/his/v1/doctor/completed-cases') return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
    throw new Error(`Unexpected navigation request: ${url.pathname}`)
  }))
  const session: SessionContext = {
    actor: { actorId: 'doctor', epoch: 'epoch', locationId: 'clinic', organizationId: 'hospital', practitionerId: 'doctor',
      practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor', scenarioRunId: 'run', workspaceId: 'workspace' },
    availableRoles: [], user: { email: 'doctor@example.test', id: 'doctor', name: '合成医生' },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const workspace = (session: SessionContext) => <StrictMode><QueryClientProvider client={client}><AgentPageRegistryProvider><AgentReviewProvider>
    <DoctorWorkspace locale="zh-CN" session={session} />
  </AgentReviewProvider></AgentPageRegistryProvider></QueryClientProvider></StrictMode>
  const { unmount, rerender } = render(workspace(session))
  const list = screen.getByRole('tablist', { name: '门诊诊疗' })
  const host = list.parentElement!
  const indicator = list.querySelector('[data-slot="tabs-indicator"]')
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '完诊' }))
  expect(screen.getByRole('tablist', { name: '门诊诊疗' })).toBe(list)
  expect(list.querySelector('[data-slot="tabs-indicator"]')).toBe(indicator)
  await user.click(screen.getByRole('tab', { name: '待诊' }))
  expect(screen.getByRole('tablist', { name: '门诊诊疗' })).toBe(list)
  rerender(workspace({ ...session, actor: { ...session.actor, epoch: 'next-epoch' } }))
  const nextList = screen.getByRole('tablist', { name: '门诊诊疗' })
  const nextHost = nextList.parentElement!
  expect(nextList).not.toBe(list)
  expect(list.isConnected).toBe(false)
  expect(host.isConnected).toBe(false)
  unmount()
  expect(nextList.isConnected).toBe(false)
  expect(nextHost.isConnected).toBe(false)
})
