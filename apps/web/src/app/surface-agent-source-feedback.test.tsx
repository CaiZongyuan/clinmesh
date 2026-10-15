// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { Toaster } from '@clinmesh/ui/components/toast'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { AgentPageContextClaim } from '@clinmesh/contracts/agent'
import { AgentPageRegistryProvider, useRegisterAgentPage } from './agent-page-context.tsx'
import { useSurfaceAgentPublisher } from './surface-agent-publisher.ts'
import { WebPreferencesProvider } from './preferences-context.tsx'
import { WebRuntimeProvider, type WebRuntimeOptions } from './web-runtime.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { useMemo } from 'react'
import type { AgentPageRegistration } from './agent-page-context.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const failureMessage = '暂未确认本条补充已加入病历，请核对后重新补充。'
const doctor: SessionContext = { actor: { actorId: 'doctor', epoch: 'epoch', locationId: 'location', organizationId: 'hospital',
  practitionerId: 'practitioner', practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor', scenarioRunId: 'scenario', workspaceId: 'workspace' },
  availableRoles: [], user: { id: 'doctor-user', email: 'synthetic@example.test', name: '合成医生' } }
type InputCallbacks = Parameters<NonNullable<WebRuntimeOptions['surfaceDoctorInput']>>

function DoctorPage({ caseId }: { caseId: string }) {
  const page = useMemo<AgentPageRegistration>(() => ({ actions: { 'outpatient.case.read': {
    description: 'Read synthetic case', parameters: { type: 'object', properties: {} }, execute: async () => ({ caseId }),
  } }, claim: { version: 1, viewId: 'consultation', viewRevision: caseId,
    activeSection: 'record', selection: { id: caseId, kind: 'case', version: '1' }, ui: { status: 'ready' } },
    label: 'Synthetic doctor', readState: () => ({ caseId }) }), [caseId])
  useRegisterAgentPage(page)
  useSurfaceAgentPublisher({ activeSection: 'consultation', navigate: async () => {}, session: doctor })
  const query = useQuery({ queryKey: ['doctor-case', 'workspace', 'epoch', caseId], retry: false,
    queryFn: async () => { const response = await fetch('/case-state'); if (!response.ok) throw new Error('Query failed'); return response.json() } })
  return <span>{query.isError ? 'Case refresh failed' : 'Case ready'}</span>
}

async function fixture({ saveFails = false, refreshFails = false, locale = 'zh-CN' }: {
  saveFails?: boolean; refreshFails?: boolean; locale?: WorkspaceLocale
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let callbacks: InputCallbacks | undefined
  let registered = false
  let saved = false
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path.endsWith('/agent/v1/page-contexts')) {
      const { claim } = JSON.parse(String(init?.body)) as { claim: AgentPageContextClaim }
      return Response.json({ token: 'synthetic-context-token-at-least-32-characters', snapshot: {
        version: 1, id: `context-${claim.viewRevision}`, claim, actor: { actorId: 'doctor', practitionerRoleId: 'doctor-role', roleCode: 'outpatient-doctor' },
        workspace: { id: 'workspace', epoch: 'epoch', scenarioRunId: 'scenario' }, allowedOperationIds: ['ui.context.read', 'outpatient.case.read'],
        dshSessionId: 'doctor-session', scopeKey: `clinmesh:${claim.selection?.id}`, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
      } }, { status: 201 })
    }
    if (path.endsWith('/agent/v1/doctor-inputs')) {
      if (saveFails) throw new Error('synthetic-private-doctor-text-and-credential')
      saved = true
      return Response.json({ auditId: 'audit', requestId: 'request', effects: [], warnings: [], data: { caseId: 'case-1', sourceId: 'doctor-source' } })
    }
    if (path === '/case-state') return Response.json({}, { status: saved && refreshFails ? 503 : 200 })
    throw new Error(`Unexpected request: ${path}`)
  }))
  const tree = (caseId = 'case-1') => <QueryClientProvider client={queryClient}>
    <WebPreferencesProvider value={{ preferences: { locale, fontSize: 'standard', theme: 'system' }, setPreferences: () => {} }}>
      <WebRuntimeProvider value={{ mode: 'surface', appearanceRoot: { current: null }, surfaceAgentStatus: 'active', surfaceSessionId: 'doctor-session',
        surfaceDoctorInput: (...input) => { callbacks = input; return () => { callbacks = undefined } },
        surfaceAgent: { register: () => { registered = true; return () => { registered = false } } },
      }}><AgentPageRegistryProvider><Toaster><DoctorPage caseId={caseId} /></Toaster></AgentPageRegistryProvider></WebRuntimeProvider>
    </WebPreferencesProvider></QueryClientProvider>
  const rendered = render(tree())
  await waitFor(() => expect(registered).toBe(true))
  return { callbacks: () => callbacks!, rendered, tree, saved: () => saved }
}

it.each([['zh-CN', failureMessage], ['en-US', 'This supplement has not been confirmed in the record. Check the record before adding it again.']] as const)(
  'shows a generic %s warning when native source proof fails', async (locale, message) => {
  const f = await fixture({ locale })
  expect(f.callbacks()[2]).toBeTypeOf('function')
  await act(async () => f.callbacks()[2]!('doctor-session'))
  expect(await screen.findByText(message)).toBeTruthy()
})

it('reports a failed source save through the same generic feedback without exposing private errors', async () => {
  const f = await fixture({ saveFails: true })
  await act(async () => {
    try { await f.callbacks()[1]!({ content: '合成医生补充。', dshSessionId: 'doctor-session', rpcId: 'rpc', sourceProof: 'synthetic-source-proof-at-least-32-characters' }, new AbortController().signal) }
    catch { f.callbacks()[2]!('doctor-session') }
  })
  expect(await screen.findByText(failureMessage)).toBeTruthy()
  expect(screen.queryByText(/synthetic-private/)).toBeNull()
})

it('does not report a committed source as failed when its case refresh fails', async () => {
  const f = await fixture({ refreshFails: true })
  await act(async () => {
    try { await f.callbacks()[1]!({ content: '合成医生补充。', dshSessionId: 'doctor-session', rpcId: 'rpc', sourceProof: 'synthetic-source-proof-at-least-32-characters' }, new AbortController().signal) }
    catch { f.callbacks()[2]!('doctor-session') }
  })
  expect(f.saved()).toBe(true)
  expect(await screen.findByText('Case refresh failed')).toBeTruthy()
  expect(screen.queryByText(failureMessage)).toBeNull()
})

it('suppresses an old failure after changing cases or from another session', async () => {
  const f = await fixture()
  const oldFailure = f.callbacks()[2]!
  await act(async () => f.callbacks()[2]!('another-session'))
  expect(screen.queryByText(failureMessage)).toBeNull()
  f.rendered.rerender(f.tree('case-2'))
  await act(async () => oldFailure('doctor-session'))
  expect(screen.queryByText(failureMessage)).toBeNull()
})
