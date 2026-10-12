// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPageContextBinding, AgentPageContextClaim } from '@clinmesh/contracts/agent'
import type { SessionContext } from '@clinmesh/contracts/his'
import { AgentPageRegistryProvider, useRegisterAgentPage, type AgentPageRegistration } from './agent-page-context.tsx'
import { useSurfaceAgentPublisher } from './surface-agent-publisher.ts'
import { WebRuntimeProvider, type WebSurfaceAgentController, type WebSurfaceAgentTool } from './web-runtime.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const session: SessionContext = {
  actor: { actorId: 'registrar', epoch: 'epoch-1', locationId: 'location', organizationId: 'organization',
    practitionerId: 'practitioner', practitionerRoleId: 'registrar-role', roleCode: 'registrar',
    scenarioRunId: 'scenario', workspaceId: 'workspace' },
  availableRoles: [], user: { id: 'user', email: 'synthetic@example.test', name: '合成挂号员' },
}

const navigate = async () => undefined
function PublishedPage({ page }: { page: AgentPageRegistration }) {
  useRegisterAgentPage(page)
  useSurfaceAgentPublisher({ activeSection: 'registration', navigate, session })
  return null
}

async function fixture(initialPatient?: string, holdHandoff = false) {
  let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
  const released: Array<Parameters<WebSurfaceAgentController['register']>[0]> = []
  const surfaceAgent: WebSurfaceAgentController = { register(value) {
    registration = value
    return () => { released.push(value); if (registration === value) registration = undefined }
  } }
  const oldAction = vi.fn(async () => ({ matches: 1 }))
  const newAction = vi.fn(async () => ({ matches: 2 }))
  const pageFor = (revision: string, execute: typeof oldAction, patient?: string): AgentPageRegistration => ({
    actions: { 'registration.patient.search': {
      description: 'Search synthetic patients', parameters: { type: 'object',
        properties: { query: { type: 'string' } }, required: ['query'] }, execute,
    } },
    claim: { version: 1, viewId: 'registration', viewRevision: revision, ui: { status: 'ready' },
      ...(patient === undefined ? {} : { selection: { id: patient, kind: 'patient', version: '1' } }),
    },
    label: 'Synthetic registration', readState: () => ({ revision }),
  })
  let latest: AgentPageContextBinding | undefined
  let replacementRequested = false
  let releaseReplacement: () => void = () => undefined
  const replacement = new Promise<void>(resolve => { releaseReplacement = resolve })
  const proofRequests: unknown[] = []
  const handoffRequests: unknown[] = []
  const handoffSignals: AbortSignal[] = []
  let releaseHandoff: () => void = () => undefined
  const handoff = new Promise<void>(resolve => { releaseHandoff = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path.endsWith('/agent/v1/page-contexts')) {
      const { claim } = JSON.parse(String(init?.body)) as { claim: AgentPageContextClaim }
      if (claim.viewRevision === 'page-2') { replacementRequested = true; await replacement }
      const now = Date.now()
      latest = { token: 'synthetic-context-token-at-least-32-characters', snapshot: {
        version: 1, id: `context-${claim.viewRevision}`, claim,
        actor: { actorId: session.actor.actorId, practitionerRoleId: 'registrar-role',
          roleCode: 'registrar' },
        workspace: { id: session.actor.workspaceId, epoch: session.actor.epoch, scenarioRunId: 'scenario' },
        allowedOperationIds: ['ui.context.read', 'registration.patient.search'], dshSessionId: 'synthetic-session',
        scopeKey: `clinmesh:${claim.selection?.id ?? 'registrar'}`, issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
      } }
      return Response.json(latest, { status: 201 })
    }
    if (path === '/clinmesh-agent-proof') {
      proofRequests.push(JSON.parse(String(init?.body)))
      return Response.json({ data: { proof: `synthetic-proof-${proofRequests.length}-at-least-32-characters` } })
    }
    if (path === '/clinmesh-agent-handoff') {
      const request = JSON.parse(String(init?.body))
      handoffRequests.push(request)
      if (request.phase === 'pause') return Response.json({ data: { paused: true } })
      const signal = init!.signal!
      handoffSignals.push(signal)
      if (holdHandoff) await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        void handoff.then(() => { signal.removeEventListener('abort', abort); resolve() })
      })
      return Response.json({ data: { permitted: true } })
    }
    if (path.endsWith('/agent/v1/tool-calls')) return Response.json({
      callId: 'call', context: latest!.snapshot, dshSessionId: 'synthetic-session',
      operationId: JSON.parse(String(init?.body)).operationId, receiptToken: 'synthetic-receipt-at-least-32-characters', status: 'authorized',
    }, { status: 201 })
    if (path.endsWith('/agent/v1/tool-calls/result')) return Response.json({ status: 'completed' })
    throw new Error(`Unexpected request: ${path}`)
  }))
  const tree = (page: AgentPageRegistration) => <WebRuntimeProvider value={{ mode: 'surface',
    appearanceRoot: { current: null }, surfaceAgent, surfaceAgentStatus: 'active', surfaceSessionId: 'synthetic-session',
  }}><AgentPageRegistryProvider><PublishedPage page={page} /></AgentPageRegistryProvider></WebRuntimeProvider>
  const rendered = render(tree(pageFor('page-1', oldAction, initialPatient)))
  const findSearch = (): WebSurfaceAgentTool | undefined => registration?.tools.find(tool => tool.name === 'clinmesh_search_patients')
  await waitFor(() => expect(findSearch()).toBeDefined())
  return { rendered, tree, pageFor, findSearch, oldAction, newAction, proofRequests, released, handoffRequests, handoffSignals, releaseHandoff,
    current: () => registration, requested: () => replacementRequested, release: releaseReplacement }
}

it('returns the Tool body before handing off the final signed page and awaits Host permission to publish', async () => {
  const f = await fixture('patient-1', true)
  const previous = f.findSearch()!
  const originalRegistration = f.current()!
  f.oldAction.mockImplementation(async () => {
    f.rendered.rerender(f.tree(f.pageFor('page-2', f.newAction, 'patient-2')))
    return { matches: 1 }
  })
  const result = await previous.execute({ query: '合成', scopeKey: 'clinmesh:patient-1', pageRevision: '["page-1",null]' }, new AbortController().signal)
  expect(result).toContain('"matches":1')
  expect(f.handoffRequests).toEqual([])
  expect(f.released).not.toContain(originalRegistration)
  await waitFor(() => expect(f.requested()).toBe(true))
  await act(async () => f.release())
  await waitFor(() => expect(f.handoffRequests).toHaveLength(1))
  expect(f.handoffRequests[0]).toMatchObject({
    phase: 'settle',
    target: { scopeKey: 'clinmesh:patient-2', pageRevision: '["page-2",null]', toolNames: ['clinmesh_read_current_context', 'clinmesh_search_patients'] },
  })
  expect(f.released).not.toContain(originalRegistration)
  await act(async () => f.releaseHandoff())
  await waitFor(() => expect(f.findSearch()?.parameters).toHaveProperty('properties.scopeKey.const', 'clinmesh:patient-2'))
})

it('requests a pause immediately after an uncertain body without waiting for a replacement frame', async () => {
  const f = await fixture('patient-1', true)
  // A successful body followed by a lost completion response is also uncertain.
  f.oldAction.mockImplementation(async () => ({ matches: 1 }))
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).endsWith('/agent/v1/tool-calls/result')) throw new Error('Completion lost')
    return originalFetch(url, init)
  }))
  const tool = f.findSearch()!
  await expect(tool.execute({ query: '合成', scopeKey: 'clinmesh:patient-1', pageRevision: '["page-1",null]' }, new AbortController().signal))
    .rejects.toThrow('CLINMESH_EXECUTION_UNCONFIRMED:')
  await waitFor(() => expect(f.handoffRequests).toEqual([{
    phase: 'pause', proof: 'synthetic-proof-1-at-least-32-characters',
  }]))
})

it('hands parallel read and write bodies to one final page without releasing either transport early', async () => {
  const f = await fixture('patient-1', true)
  const original = f.current()!
  let finishAction: () => void = () => undefined
  f.oldAction.mockImplementation(() => new Promise(resolve => { finishAction = () => resolve({ matches: 1 }) }))
  const args = { scopeKey: 'clinmesh:patient-1', pageRevision: '["page-1",null]' }
  const writing = f.findSearch()!.execute({ ...args, query: '合成' }, new AbortController().signal)
  await waitFor(() => expect(f.oldAction).toHaveBeenCalledOnce())
  const reading = original.tools.find(tool => tool.name === 'clinmesh_read_current_context')!
  await expect(reading.execute(args, new AbortController().signal)).resolves.toContain('"pageState"')
  f.rendered.rerender(f.tree(f.pageFor('page-2', f.newAction, 'patient-2')))
  await waitFor(() => expect(f.requested()).toBe(true))
  expect(f.handoffRequests).toEqual([])
  await act(async () => { f.release(); finishAction() })
  await expect(writing).resolves.toContain('"matches":1')
  await waitFor(() => expect(f.handoffRequests).toHaveLength(2))
  const requests = f.handoffRequests as Array<{ proof: string; target: unknown }>
  expect(new Set(requests.map(request => request.proof)).size).toBe(2)
  expect(requests[0]!.target).toEqual(requests[1]!.target)
  expect(requests[0]!.target).toMatchObject({ scopeKey: 'clinmesh:patient-2', pageRevision: '["page-2",null]' })
  expect(f.released).not.toContain(original)
  await act(async () => f.releaseHandoff())
  await waitFor(() => expect(f.findSearch()?.parameters).toHaveProperty('properties.scopeKey.const', 'clinmesh:patient-2'))
})

it('acknowledges a read with the existing complete catalog without replacing its lease', async () => {
  const f = await fixture()
  const original = f.current()!
  const read = original.tools.find(tool => tool.name === 'clinmesh_read_current_context')!
  await read.execute({ scopeKey: 'clinmesh:registrar', pageRevision: '["page-1",null]' }, new AbortController().signal)
  await waitFor(() => expect(f.handoffRequests).toHaveLength(1))
  expect(f.handoffRequests[0]).toMatchObject({ target: {
    scopeKey: 'clinmesh:registrar', pageRevision: '["page-1",null]',
    toolNames: ['clinmesh_read_current_context', 'clinmesh_search_patients'],
  } })
  expect(f.released).not.toContain(original)
})

it.each(['cancel', 'unload', 'timeout'])('cleans a %s handoff without replaying its returned business action', async reason => {
  if (reason === 'timeout') vi.useFakeTimers({ shouldAdvanceTime: true })
  const f = await fixture(undefined, true)
  const controller = new AbortController()
  const result = await f.findSearch()!.execute({ query: '合成', scopeKey: 'clinmesh:registrar', pageRevision: '["page-1",null]' }, controller.signal)
  expect(result).toContain('"matches":1')
  await waitFor(() => expect(f.handoffRequests).toHaveLength(1))
  if (reason === 'cancel') controller.abort()
  else if (reason === 'unload') f.rendered.unmount()
  else await act(async () => vi.advanceTimersByTimeAsync(30_001))
  await waitFor(() => expect(f.handoffSignals[0]!.aborted).toBe(true))
  expect(f.oldAction).toHaveBeenCalledOnce()
  expect(f.proofRequests).toHaveLength(1)
  expect(f.handoffRequests).toHaveLength(1)
})

it('rejects an old page call while its replacement Context is still being issued', async () => {
  const f = await fixture()
  const previous = f.findSearch()!
  const args = { query: '合成', scopeKey: 'clinmesh:registrar', pageRevision: '["page-1",null]' }
  f.rendered.rerender(f.tree(f.pageFor('page-2', f.newAction)))
  await waitFor(() => expect(f.requested()).toBe(true))
  try {
    await expect(previous.execute(args, new AbortController().signal)).rejects.toThrow('CLINMESH_BINDING_MISMATCH')
    expect(f.oldAction).not.toHaveBeenCalled()
    expect(f.newAction).not.toHaveBeenCalled()
    expect(f.proofRequests).toEqual([])
  } finally { f.release() }
  await waitFor(() => expect(f.findSearch()?.parameters).toHaveProperty('properties.pageRevision.const', '["page-2",null]'))
  await expect(f.findSearch()!.execute({ ...args, pageRevision: '["page-2",null]' }, new AbortController().signal))
    .resolves.toContain('"matches":2')
  expect(f.newAction).toHaveBeenCalledOnce()
})

it('retains an already authorized call until its result settles when page scope changes', async () => {
  const f = await fixture('patient-1')
  let finishAction: () => void = () => undefined
  const pending = new Promise<{ matches: number }>(resolve => { finishAction = () => resolve({ matches: 1 }) })
  f.oldAction.mockImplementation(() => pending)
  const previous = f.findSearch()!
  const originalRegistration = f.current()!
  const args = { query: '合成', scopeKey: 'clinmesh:patient-1', pageRevision: '["page-1",null]' }
  const running = Promise.resolve(previous.execute(args, new AbortController().signal))
  await waitFor(() => expect(f.oldAction).toHaveBeenCalledOnce())
  f.rendered.rerender(f.tree(f.pageFor('page-2', f.newAction, 'patient-2')))
  await waitFor(() => expect(f.requested()).toBe(true))
  try {
    expect(f.released).not.toContain(originalRegistration)
    await expect(previous.execute(args, new AbortController().signal)).rejects.toThrow('CLINMESH_BINDING_MISMATCH')
    expect(f.proofRequests).toHaveLength(1)
    expect(f.newAction).not.toHaveBeenCalled()
  } finally { finishAction(); f.release() }
  await expect(running).resolves.toContain('"matches":1')
  await waitFor(() => expect(f.findSearch()?.parameters).toHaveProperty('properties.scopeKey.const', 'clinmesh:patient-2'))
})
