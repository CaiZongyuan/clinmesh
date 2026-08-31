// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebApp, type WebRuntimeOptions } from './web-app.tsx'
import { agentToolsForContext } from '@clinmesh/contracts/agent'
import type { WebSurfaceAgentController, WebSurfaceAgentTool } from './web-runtime.tsx'

const registrarSession = {
  actor: {
    actorId: 'actor-registrar',
    epoch: 'epoch-1',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerRoleId: 'practitioner-role-registrar',
    roleCode: 'registrar',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'registrar',
    id: 'practitioner-role-registrar',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerName: '合成挂号员',
  }],
  user: {
    email: 'registrar@demo.clinmesh.local',
    id: 'user-registrar',
    name: '合成挂号员',
  },
}

const registrarAgentActor = {
  actorId: registrarSession.actor.actorId,
  practitionerRoleId: registrarSession.actor.practitionerRoleId,
  roleCode: registrarSession.actor.roleCode,
}

let testCallSequence = 0

function randomTestId(): string {
  testCallSequence += 1
  return `call-${String(testCallSequence)}`
}

function boundToolValue(tool: WebSurfaceAgentTool, key: 'contextId' | 'scopeKey'): string {
  const properties = tool.parameters.properties as Record<string, { enum?: unknown[] }> | undefined
  const value = properties?.[key]?.enum?.[0]
  if (typeof value !== 'string') throw new Error(`Tool ${tool.name} has no bound ${key}`)
  return value
}

function createMediaQueryList(media: string, matches = false): MediaQueryList {
  return {
    matches,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }
}

function installMatchMedia(prefersDark: boolean): { setPrefersDark: (matches: boolean) => void } {
  let darkMatches = prefersDark
  const darkListeners = new Set<EventListenerOrEventListenerObject>()

  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    if (query !== '(prefers-color-scheme: dark)') return createMediaQueryList(query)

    return {
      get matches() {
        return darkMatches
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => darkListeners.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => darkListeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } satisfies MediaQueryList
  }))

  return {
    setPrefersDark(matches) {
      darkMatches = matches
      const event = new Event('change')
      for (const listener of darkListeners) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    },
  }
}

async function renderWebApp(options: {
  history?: RouterHistory
  runtime?: WebRuntimeOptions
} = {}) {
  const rendered = render(<WebApp {...options} />)
  await screen.findByRole('heading', { level: 1 })
  return rendered
}

describe('Web application shell', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.removeAttribute('style')
    document.documentElement.className = ''
    document.documentElement.lang = 'zh-CN'
    document.documentElement.removeAttribute('data-theme')
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => createMediaQueryList(query)))
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') return Response.json(registrarSession)
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/api/his/v1/registrations') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the active role workspace without a duplicate overview entry', async () => {
    await renderWebApp()

    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('navigation', { name: '岗位导航' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '工作台总览' })).toBeNull()
    expect(screen.queryByRole('link', { name: '门诊收费' })).toBeNull()
    expect(screen.getByRole('button', { name: '通知' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '用户菜单' })).toBeTruthy()
    expect(screen.queryByText('外观')).toBeNull()
    expect(screen.queryByRole('button', { name: 'English' })).toBeNull()
    expect(await screen.findByText('暂无挂号记录')).toBeTruthy()
    expect(screen.queryByText(/Agent|AI|助手/i)).toBeNull()
  })

  it('uses an isolated API prefix and memory history in a DSH Surface', async () => {
    window.history.replaceState(null, '', '/dsh-host')
    const history = createMemoryHistory({ initialEntries: ['/'] })
    const requestedPaths: string[] = []
    vi.mocked(fetch).mockImplementation(async input => {
      const path = new URL(String(input), 'http://localhost').pathname
      requestedPaths.push(path)
      if (path === '/clinmesh-api/auth/context') return Response.json(registrarSession)
      if (path === '/clinmesh-api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/clinmesh-api/his/v1/registrations') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    await renderWebApp({
      history,
      runtime: { apiBasePath: '/clinmesh-api', mode: 'surface' },
    })

    expect(history.location.pathname).toBe('/registration')
    expect(window.location.pathname).toBe('/dsh-host')
    expect(requestedPaths).toContain('/clinmesh-api/auth/context')
  })

  it('scopes Surface appearance and feedback portals to the application root', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'light',
    }))
    const history = createMemoryHistory({ initialEntries: ['/components'] })
    const user = userEvent.setup()

    await renderWebApp({ history, runtime: { mode: 'surface' } })
    const applicationRoot = document.querySelector<HTMLElement>('[data-clinmesh-app="web"]')
    const portalRoot = applicationRoot?.querySelector<HTMLElement>('[data-clinmesh-portal-root]')
    expect(applicationRoot?.lang).toBe('en-US')
    expect(document.documentElement.lang).toBe('zh-CN')

    await user.click(screen.getByRole('button', { name: 'Dark theme' }))
    expect(applicationRoot?.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Delete order' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm order deletion' })
    expect(portalRoot?.contains(dialog)).toBe(true)
  })

  it('lets a Surface Agent fill a draft but requires human review before creating a Patient', async () => {
    const history = createMemoryHistory({ initialEntries: ['/registration'] })
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    let patientCreated = false
    const toolResults: unknown[] = []
    const pageClaims: Array<{ draft?: { dirty: boolean }; ui: { status: string } }> = []
    let resolveRegistrationQueue: (response: Response) => void = () => undefined
    const registrationQueue = new Promise<Response>(resolve => {
      resolveRegistrationQueue = resolve
    })
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/clinmesh-api/auth/context') return Response.json(registrarSession)
      if (path === '/clinmesh-api/his/v1/catalogs/registration') {
        return Response.json({
          departments: [{ id: 'department-general', nameEn: 'General', nameZh: '全科', version: 1 }],
          locations: [{ id: 'location-clinic', nameEn: 'Clinic', nameZh: '门诊', version: 1 }],
          virtualDate: '2026-08-31',
          visitTypes: [{ id: 'visit-general', nameEn: 'General', nameZh: '普通门诊', priceFen: 2000, version: 1 }],
        })
      }
      if (path === '/clinmesh-api/his/v1/registrations') {
        return registrationQueue
      }
      if (path === '/clinmesh-api/agent/v1/page-contexts') {
        const request = JSON.parse(String(init?.body)) as {
          claim: {
            viewId: 'registration'
            viewRevision: string
            version: 1
            ui: { status: 'ready' | 'empty' | 'loading' | 'error' }
          }
          dshSessionId: string
        }
        const claim = request.claim
        pageClaims.push(claim)
        const issuedAt = new Date()
        return Response.json({
          snapshot: {
            version: 1,
            id: `context-${claim.viewRevision}`,
            claim,
            actor: registrarAgentActor,
            workspace: {
              id: registrarSession.actor.workspaceId,
              epoch: registrarSession.actor.epoch,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
            allowedOperationIds: agentToolsForContext('registrar', 'registration')
              .map(tool => tool.operationId),
            dshSessionId: request.dshSessionId,
            scopeKey: 'clinmesh:registrar:registration',
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
          },
          token: 'context-token-with-at-least-32-characters',
        }, { status: 201 })
      }
      if (path === '/clinmesh-agent-proof') {
        return Response.json({ data: { proof: 'proof-with-at-least-32-characters' } })
      }
      if (path === '/clinmesh-api/agent/v1/tool-calls') {
        const request = JSON.parse(String(init?.body)) as { operationId: string }
        return Response.json({
          callId: randomTestId(),
          context: {
            version: 1,
            id: 'context-authorized',
            claim: {
              version: 1,
              viewId: 'registration',
              viewRevision: 'authorized',
              ui: { status: 'ready' },
            },
            actor: registrarAgentActor,
            workspace: {
              id: registrarSession.actor.workspaceId,
              epoch: registrarSession.actor.epoch,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
            allowedOperationIds: [request.operationId],
            dshSessionId: 'dsh-session-1',
            scopeKey: 'clinmesh:registrar:registration',
            issuedAt: '2026-08-31T00:00:00.000Z',
            expiresAt: '2026-08-31T00:05:00.000Z',
          },
          dshSessionId: 'dsh-session-1',
          operationId: request.operationId,
          ...(request.operationId.endsWith('.propose') ? { proposalId: 'proposal-1' } : {}),
          receiptToken: 'receipt-token-with-at-least-32-characters',
          status: 'authorized',
        }, { status: 201 })
      }
      if (path === '/clinmesh-api/agent/v1/tool-calls/result') {
        toolResults.push(JSON.parse(String(init?.body)))
        return Response.json({ status: 'completed' })
      }
      if (path === '/clinmesh-api/agent/v1/tool-calls/review') {
        const request = JSON.parse(String(init?.body)) as { decision: 'approved' | 'rejected' }
        return Response.json({
          decidedAt: '2026-08-31T00:00:01.000Z',
          decision: request.decision,
          proposalId: 'proposal-1',
        })
      }
      if (path === '/clinmesh-api/his/v1/patients' && init?.method === 'POST') {
        patientCreated = true
        return Response.json({
          auditId: 'audit-1',
          data: {
            patient: {
              birthDate: '1990-01-01',
              gender: 'male',
              id: 'patient-agent-1',
              identifier: 'CM-AGENT-001',
              name: '合成患者甲',
              synthetic: true,
              versionId: '1',
            },
          },
          effects: [{ kind: 'created', reference: 'Patient/patient-agent-1', versionId: '1' }],
          requestId: 'request-1',
          warnings: [],
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    const runtimeFor = (surfaceAgentStatus: 'active' | 'connecting') => ({
      apiBasePath: '/clinmesh-api',
      mode: 'surface' as const,
      surfaceAgent,
      surfaceAgentStatus,
      surfaceSessionId: 'dsh-session-1',
    })
    const rendered = await renderWebApp({
      history,
      runtime: runtimeFor('active'),
    })
    await waitFor(() => expect(pageClaims.at(-1)?.ui.status).toBe('loading'))
    resolveRegistrationQueue(Response.json({ items: [], page: 1, pageSize: 20, total: 0 }))
    await waitFor(() => expect(registration?.tools.some(tool => (
      tool.name === 'clinmesh_fill_patient_draft'
    ))).toBe(true))
    await waitFor(() => expect(pageClaims.at(-1)?.ui.status).toBe('empty'))
    expect(registration?.tools.find(tool => tool.name === 'clinmesh_navigate')?.parameters)
      .toMatchObject({
        properties: {
          destination: {
            enum: ['registration', 'settingsGeneral', 'uiComponents'],
          },
        },
      })
    expect(registration?.tools.some(tool => tool.name === 'clinmesh_prepare_create_patient'))
      .toBe(false)
    let activeRegistration = registration!
    const stableScopeKey = activeRegistration.scopeKey
    const focus = activeRegistration.tools.find(tool => tool.name === 'clinmesh_focus_panel')!
    await act(async () => {
      await focus.execute({
        contextId: boundToolValue(focus, 'contextId'),
        scopeKey: activeRegistration.scopeKey,
      }, new AbortController().signal)
    })
    expect(document.activeElement).toBe(document.querySelector('[data-clinmesh-workspace-panel]'))
    const fill = activeRegistration.tools.find(tool => tool.name === 'clinmesh_fill_patient_draft')!
    await act(async () => {
      await fill.execute({
        contextId: boundToolValue(fill, 'contextId'),
        scopeKey: activeRegistration.scopeKey,
        birthDate: '1990-01-01',
        gender: 'male',
        identifier: 'CM-AGENT-001',
        name: '合成患者甲',
      }, new AbortController().signal)
    })
    await waitFor(() => expect(pageClaims.at(-1)?.draft?.dirty).toBe(true))
    await waitFor(() => expect(registration?.tools.some(
      tool => tool.name === 'clinmesh_prepare_create_patient',
    )).toBe(true))
    activeRegistration = registration!
    expect(activeRegistration.scopeKey).toBe(stableScopeKey)
    expect(activeRegistration.tools.some(tool => tool.name === 'clinmesh_prepare_create_patient'))
      .toBe(true)
    const prepare = activeRegistration.tools.find(tool => tool.name === 'clinmesh_prepare_create_patient')!
    let proposalResult = ''
    await act(async () => {
      proposalResult = await prepare.execute(
        {
          contextId: boundToolValue(prepare, 'contextId'),
          scopeKey: activeRegistration.scopeKey,
        },
        new AbortController().signal,
      )
    })

    expect(proposalResult).toContain('awaiting-human-review')
    expect(await screen.findByRole('alertdialog', { name: '创建患者' })).toBeTruthy()
    expect(patientCreated).toBe(false)

    rendered.rerender(<WebApp history={history} runtime={runtimeFor('connecting')} />)
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '创建患者' })).toBeNull())
    await waitFor(() => expect(toolResults.at(-1)).toMatchObject({ ok: false }))
    expect(patientCreated).toBe(false)

    rendered.rerender(<WebApp history={history} runtime={runtimeFor('active')} />)
    await act(async () => {
      proposalResult = await prepare.execute(
        {
          contextId: boundToolValue(prepare, 'contextId'),
          scopeKey: activeRegistration.scopeKey,
        },
        new AbortController().signal,
      )
    })
    expect(proposalResult).toContain('awaiting-human-review')
    expect(await screen.findByRole('alertdialog', { name: '创建患者' })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: '创建患者' }))
    await waitFor(() => expect(patientCreated).toBe(true))
    await waitFor(() => expect(toolResults.at(-1)).toMatchObject({
      ok: true,
      result: { approved: true },
    }))
  })

  it('renews the Agent Page Context without replacing the page Tool scope', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-31T00:00:00.000Z'), shouldAdvanceTime: true })
    const history = createMemoryHistory({ initialEntries: ['/settings'] })
    const registeredScopes: string[] = []
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    let contextRequests = 0
    const contextBindings: Array<{
      client: { id: string; revision: number }
      dshSessionId: string
      signalBound: boolean
    }> = []
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registeredScopes.push(value.scopeKey)
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/clinmesh-api/auth/context') return Response.json(registrarSession)
      if (path === '/clinmesh-api/agent/v1/page-contexts') {
        contextRequests += 1
        const request = JSON.parse(String(init?.body)) as {
          claim: Record<string, unknown>
          client: { id: string; revision: number }
          dshSessionId: string
        }
        contextBindings.push({
          client: request.client,
          dshSessionId: request.dshSessionId,
          signalBound: init?.signal instanceof AbortSignal,
        })
        const claim = request.claim
        const issuedAt = new Date()
        return Response.json({
          snapshot: {
            version: 1,
            id: `context-${String(contextRequests)}`,
            claim,
            actor: registrarAgentActor,
            workspace: {
              id: registrarSession.actor.workspaceId,
              epoch: registrarSession.actor.epoch,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
            allowedOperationIds: agentToolsForContext('registrar', 'settingsGeneral')
              .map(tool => tool.operationId),
            dshSessionId: request.dshSessionId,
            scopeKey: 'clinmesh:registrar:settings',
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
          },
          token: `context-token-${String(contextRequests).padEnd(32, 'x')}`,
        }, { status: 201 })
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    const runtimeFor = (surfaceAgentStatus: 'active' | 'connecting' | 'unavailable') => ({
      apiBasePath: '/clinmesh-api',
      mode: 'surface' as const,
      surfaceAgent,
      surfaceAgentStatus,
      surfaceSessionId: 'dsh-session-1',
    })
    const rendered = await renderWebApp({
      history,
      runtime: runtimeFor('unavailable'),
    })
    await waitFor(() => expect(registration?.scopeKey).toBe('clinmesh:registrar:settings'))
    expect(contextRequests).toBe(1)

    rendered.rerender(<WebApp history={history} runtime={runtimeFor('connecting')} />)
    await act(async () => Promise.resolve())
    rendered.rerender(<WebApp history={history} runtime={runtimeFor('active')} />)
    await act(async () => Promise.resolve())
    expect(contextRequests).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000)
    })

    await waitFor(() => expect(contextRequests).toBe(2))
    expect(registration?.scopeKey).toBe('clinmesh:registrar:settings')
    expect(contextRequests).toBe(2)
    expect(new Set(registeredScopes)).toEqual(new Set(['clinmesh:registrar:settings']))
    expect(contextBindings[0]?.client.id).toMatch(/^clinmesh-surface-/)
    expect(contextBindings[1]?.client.id).toBe(contextBindings[0]?.client.id)
    expect(contextBindings.map(binding => binding.client.revision)).toEqual([1, 2])
    expect(contextBindings.map(binding => binding.dshSessionId)).toEqual([
      'dsh-session-1',
      'dsh-session-1',
    ])
    expect(contextBindings.every(binding => binding.signalBound)).toBe(true)
  })

  it('replaces the Agent Page Context after an active Surface lease is lost', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-31T00:00:00.000Z'), shouldAdvanceTime: true })
    const history = createMemoryHistory({ initialEntries: ['/settings'] })
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    let contextRequests = 0
    const clientRevisions: number[] = []
    let resolveReplacement: (() => void) | undefined
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/clinmesh-api/auth/context') return Response.json(registrarSession)
      if (path === '/clinmesh-api/agent/v1/page-contexts') {
        contextRequests += 1
        const request = JSON.parse(String(init?.body)) as {
          claim: Record<string, unknown>
          client: { revision: number }
          dshSessionId: string
        }
        clientRevisions.push(request.client.revision)
        const response = Response.json({
          snapshot: {
            version: 1,
            id: `context-${String(contextRequests)}`,
            claim: request.claim,
            actor: registrarAgentActor,
            workspace: {
              id: registrarSession.actor.workspaceId,
              epoch: registrarSession.actor.epoch,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
            allowedOperationIds: agentToolsForContext('registrar', 'settingsGeneral')
              .map(tool => tool.operationId),
            dshSessionId: request.dshSessionId,
            scopeKey: 'clinmesh:registrar:settings',
            issuedAt: '2026-08-31T00:00:00.000Z',
            expiresAt: '2026-08-31T00:05:00.000Z',
          },
          token: `context-token-${String(contextRequests).padEnd(32, 'x')}`,
        }, { status: 201 })
        if (contextRequests === 1) return response
        return new Promise<Response>(resolve => {
          resolveReplacement = () => resolve(response)
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    const runtimeFor = (
      surfaceAgentStatus: 'active' | 'connecting' | 'contended' | 'unavailable',
    ) => ({
      apiBasePath: '/clinmesh-api',
      mode: 'surface' as const,
      surfaceAgent,
      surfaceAgentStatus,
      surfaceSessionId: 'dsh-session-1',
    })
    const rendered = await renderWebApp({
      history,
      runtime: runtimeFor('unavailable'),
    })
    await waitFor(() => expect(registration).toBeDefined())
    const initialContextId = boundToolValue(registration!.tools[0]!, 'contextId')

    rendered.rerender(<WebApp history={history} runtime={runtimeFor('connecting')} />)
    rendered.rerender(<WebApp history={history} runtime={runtimeFor('active')} />)
    await act(async () => Promise.resolve())
    expect(contextRequests).toBe(1)

    rendered.rerender(<WebApp history={history} runtime={runtimeFor('contended')} />)

    await waitFor(() => expect(contextRequests).toBe(2))
    await waitFor(() => expect(registration).toBeUndefined())
    await act(async () => resolveReplacement?.())
    await waitFor(() => expect(boundToolValue(registration!.tools[0]!, 'contextId'))
      .not.toBe(initialContextId))
    expect(clientRevisions).toEqual([1, 2])
  })

  it('removes Surface Agent tools when Page Context renewal cannot finish before expiry', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-31T00:00:00.000Z'), shouldAdvanceTime: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const history = createMemoryHistory({ initialEntries: ['/settings'] })
    let registration: Parameters<WebSurfaceAgentController['register']>[0] | undefined
    let contextRequests = 0
    const surfaceAgent: WebSurfaceAgentController = {
      register(value) {
        registration = value
        return () => {
          if (registration === value) registration = undefined
        }
      },
    }
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/clinmesh-api/auth/context') return Response.json(registrarSession)
      if (path === '/clinmesh-api/agent/v1/page-contexts') {
        contextRequests += 1
        if (contextRequests > 1) throw new Error('Page Context renewal unavailable')
        const request = JSON.parse(String(init?.body)) as {
          claim: Record<string, unknown>
          dshSessionId: string
        }
        const claim = request.claim
        return Response.json({
          snapshot: {
            version: 1,
            id: 'context-expiring',
            claim,
            actor: registrarAgentActor,
            workspace: {
              id: registrarSession.actor.workspaceId,
              epoch: registrarSession.actor.epoch,
              scenarioRunId: registrarSession.actor.scenarioRunId,
            },
            allowedOperationIds: agentToolsForContext('registrar', 'settingsGeneral')
              .map(tool => tool.operationId),
            dshSessionId: request.dshSessionId,
            scopeKey: 'clinmesh:registrar:settings',
            issuedAt: '2026-08-31T00:00:00.000Z',
            expiresAt: '2026-08-31T00:05:00.000Z',
          },
          token: 'context-token-with-at-least-32-characters',
        }, { status: 201 })
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    await renderWebApp({
      history,
      runtime: {
        apiBasePath: '/clinmesh-api',
        mode: 'surface',
        surfaceAgent,
        surfaceAgentStatus: 'active',
        surfaceSessionId: 'dsh-session-1',
      },
    })
    await waitFor(() => expect(registration?.scopeKey).toBe('clinmesh:registrar:settings'))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000)
    })

    await waitFor(() => expect(registration).toBeUndefined())
    expect(contextRequests).toBeGreaterThan(1)
  })

  it('opens the public component catalog without requesting application data', async () => {
    window.history.replaceState(null, '', '/components')

    await renderWebApp()

    expect(screen.getByRole('heading', { level: 1, name: '组件目录' })).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('localizes the public component catalog from the saved Web preference', async () => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      locale: 'en-US',
      theme: 'system',
    }))
    window.history.replaceState(null, '', '/components')

    await renderWebApp()

    expect(document.documentElement.lang).toBe('en-US')
    expect(screen.getByRole('heading', { level: 1, name: 'Component catalog' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Controls and forms' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dark theme' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: '组件目录' })).toBeNull()
  })

  it('shows every component group in one continuous column', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    for (const heading of [
      '控件与表单',
      '临床数据与状态',
      '弹层与反馈',
      '基础与导航',
      '会话组件',
    ]) expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: '组件分类' })).toBeNull()
  })

  it('exposes form, validation, loading, and submit states in the component catalog', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    expect(screen.getByRole('textbox', { name: '主诉' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '患者姓名' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('textbox', { name: '初步诊断' }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert', { name: '诊断不能为空' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '正在提交' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('region', { name: '固定提交区' })).toBeTruthy()
  })

  it('shows clinical tables, semantic states, loading, and long Chinese content', async () => {
    window.history.replaceState(null, '', '/components')
    await renderWebApp()

    expect(screen.getByRole('table', { name: '门诊检验结果' })).toBeTruthy()
    expect(screen.getByText('青霉素过敏')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByRole('status', { name: '正在加载病例' })).toBeTruthy()
    expect(screen.getByRole('alert', { name: '处方审查失败' })).toBeTruthy()
    expect(screen.getByText(/请复核同一患者在本次就诊中已开具的全部药品/)).toBeTruthy()
  })

  it('opens catalog feedback, restores dialog focus, and emits a toast', async () => {
    window.history.replaceState(null, '', '/components')
    const user = userEvent.setup()
    await renderWebApp()

    const deleteTrigger = screen.getByRole('button', { name: '删除医嘱' })
    await user.click(deleteTrigger)

    expect(await screen.findByRole('alertdialog', { name: '确认删除医嘱' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '取消删除' }))
    expect(document.activeElement).toBe(deleteTrigger)

    await user.click(screen.getByRole('button', { name: '发送成功反馈' }))
    expect(await screen.findByText('病历已保存')).toBeTruthy()
  })

  it('previews and persists light and dark component themes', async () => {
    window.history.replaceState(null, '', '/components')
    const user = userEvent.setup()
    await renderWebApp()

    const darkTheme = screen.getByRole('button', { name: '暗色主题' })
    await user.click(darkTheme)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(darkTheme.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'zh-CN',
      theme: 'dark',
    })

    await user.click(darkTheme)
    expect(darkTheme.getAttribute('aria-pressed')).toBe('true')
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(screen.getByRole('button', { name: '亮色主题' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('navigates between role workspaces without reloading the application shell', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('link', { name: '门诊挂号' }))

    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('heading', { name: '门诊挂号' })).toBeTruthy()
  })

  it('opens the UI component catalog from the developer settings navigation', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    expect(screen.queryByRole('link', { name: '设置' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))

    expect(window.location.pathname).toBe('/settings')
    expect(screen.getByRole('navigation', { name: '设置导航' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: '通用' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '语言' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'English' })).toBeTruthy()
    expect(screen.getByText('开发者')).toBeTruthy()

    await user.click(screen.getByRole('link', { name: 'UI 组件' }))

    expect(window.location.pathname).toBe('/settings/developer/components')
    expect(screen.getByRole('heading', { level: 1, name: 'UI 组件' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '控件与表单' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: '组件分类' })).toBeNull()
  })

  it('localizes the mobile navigation dialog', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => (
      createMediaQueryList(query, query === '(max-width: 767px)')
    )))
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '切换导航栏' }))

    expect(await screen.findByRole('dialog', { name: '岗位导航' })).toBeTruthy()
    expect(screen.getByText('显示移动端岗位导航。')).toBeTruthy()
  })

  it('switches the complete shell to English and restores that preference', async () => {
    const user = userEvent.setup()
    const rendered = await renderWebApp()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Settings navigation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'User menu' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'en-US',
      theme: 'system',
    })

    rendered.unmount()
    await renderWebApp()
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
  })

  it('follows the system theme and supports explicit light and dark modes', async () => {
    const media = installMatchMedia(true)
    const user = userEvent.setup()
    await renderWebApp()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    act(() => media.setPrefersDark(false))
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.click(screen.getByRole('button', { name: '暗色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    act(() => media.setPrefersDark(false))
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(screen.getByRole('button', { name: '亮色' }))
    expect(document.documentElement.dataset.theme).toBe('light')

    await user.click(screen.getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(JSON.parse(localStorage.getItem('clinmesh.preferences:v1') ?? '')).toEqual({
      locale: 'zh-CN',
      theme: 'system',
    })
  })

  it('redirects an unauthorized refreshed SPA path to the active role workspace', async () => {
    window.history.replaceState(null, '', '/pharmacy')

    await renderWebApp()

    expect(await screen.findByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByRole('link', { name: '门诊挂号' }).getAttribute('aria-current')).toBe('page')
  })

  it('opens the notification and user preference menus', async () => {
    const user = userEvent.setup()
    await renderWebApp()

    await user.click(screen.getByRole('button', { name: '通知' }))
    expect(await screen.findByText('当前无待处理通知')).toBeTruthy()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    expect(await screen.findByRole('menuitem', { name: '设置' })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: 'English' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: '暗色' })).toBeTruthy()
  })
})
