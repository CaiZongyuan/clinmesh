// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebApp } from './web-app.tsx'

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

const administratorSession = {
  actor: {
    actorId: 'actor-administrator',
    epoch: 'epoch-1',
    locationId: 'location-administrator',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-administrator',
    practitionerRoleId: 'practitioner-role-administrator',
    roleCode: 'administrator',
    scenarioRunId: 'scenario-run-1',
    workspaceId: 'workspace-demo',
  },
  availableRoles: [{
    code: 'administrator',
    id: 'practitioner-role-administrator',
    locationId: 'location-administrator',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-administrator',
    practitionerName: '合成管理员',
  }, {
    code: 'cashier',
    id: 'practitioner-role-cashier',
    locationId: 'location-cashier',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-cashier',
    practitionerName: '合成收费员',
  }, {
    code: 'outpatient-doctor',
    id: 'practitioner-role-outpatient-doctor',
    locationId: 'location-outpatient-doctor',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-outpatient-doctor',
    practitionerName: '合成门诊医生',
  }, {
    code: 'pharmacist',
    id: 'practitioner-role-pharmacist',
    locationId: 'location-pharmacist',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-pharmacist',
    practitionerName: '合成药师',
  }, {
    code: 'registrar',
    id: 'practitioner-role-registrar',
    locationId: 'location-registrar',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-registrar',
    practitionerName: '合成挂号员',
  }, {
    code: 'triage-nurse',
    id: 'practitioner-role-triage-nurse',
    locationId: 'location-triage-nurse',
    organizationId: 'organization-clinmesh',
    practitionerId: 'practitioner-triage-nurse',
    practitionerName: '合成分诊护士',
  }],
  user: {
    email: 'admin@demo.clinmesh.local',
    id: 'user-administrator',
    name: '合成管理员',
  },
}

const administratorAsRegistrarSession = {
  ...administratorSession,
  actor: {
    ...administratorSession.actor,
    locationId: 'location-registrar',
    practitionerId: 'practitioner-registrar',
    practitionerRoleId: 'practitioner-role-registrar',
    roleCode: 'registrar',
  },
}

function createMediaQueryList(media: string): MediaQueryList {
  return {
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    matches: false,
    media,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }
}

describe('trusted Web session workflow', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => createMediaQueryList(query)))
    vi.stubGlobal('scrollTo', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('authenticates before exposing only the granted role workspace', async () => {
    let authenticated = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') {
        return authenticated
          ? Response.json(registrarSession)
          : Response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in required' } }, { status: 401 })
      }
      if (path === '/api/auth/sign-in/email') {
        authenticated = true
        return Response.json({ user: registrarSession.user })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '登录 ClinMesh' })).toBeTruthy()
    await user.type(screen.getByLabelText('账户邮箱'), 'registrar@demo.clinmesh.local')
    await user.type(screen.getByLabelText('账户密码'), 'test-only-password')
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByRole('heading', { name: '工作台总览' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '分诊护理' })).toBeNull()
    expect(screen.queryByText(/Agent|AI|助手/i)).toBeNull()
  })

  it('switches to a granted Practitioner Role and clears the previous role workspace', async () => {
    let session = administratorSession
    let scenarioRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') return Response.json(session)
      if (path === '/api/auth/role') {
        const request = JSON.parse(String(init?.body)) as { practitionerRoleId: string }
        session = request.practitionerRoleId === 'practitioner-role-registrar'
          ? administratorAsRegistrarSession
          : administratorSession
        return Response.json(session)
      }
      if (path === '/api/sim/v1/scenario-runs/current') {
        scenarioRequests += 1
        return Response.json({
          epoch: 'epoch-1',
          initialStateHash: 'a'.repeat(64),
          kind: 'candidate',
          scenarioId: 'candidate-fever-outpatient-v1',
          scenarioRunId: 'scenario-run-1',
          status: 'active',
          virtualTime: '2026-08-24T08:00:00.000Z',
          workspaceId: 'workspace-demo',
        })
      }
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/api/his/v1/registrations') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '工作台总览' })).toBeTruthy()
    expect(screen.getByText('管理员 · 合成管理员')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    for (const label of [
      '管理员 · 合成管理员',
      '收费员 · 合成收费员',
      '门诊医生 · 合成门诊医生',
      '药师 · 合成药师',
      '挂号员 · 合成挂号员',
      '分诊护士 · 合成分诊护士',
    ]) {
      expect(await screen.findByRole('menuitemradio', { name: label })).toBeTruthy()
    }
    await user.click(await screen.findByRole('menuitemradio', { name: '挂号员 · 合成挂号员' }))

    expect(await screen.findByRole('heading', { name: '门诊挂号' })).toBeTruthy()
    expect(window.location.pathname).toBe('/registration')
    expect(screen.getByText('挂号员 · 合成挂号员')).toBeTruthy()
    expect(screen.getByRole('link', { name: '门诊挂号' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '门诊收费' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '管理员 · 合成管理员' }))

    expect(await screen.findByRole('heading', { name: '工作台总览' })).toBeTruthy()
    expect(window.location.pathname).toBe('/')
    expect(scenarioRequests).toBe(2)
  })

  it('shows a permission state when a stale role grant is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') return Response.json(administratorSession)
      if (path === '/api/auth/role') {
        return Response.json({
          error: {
            code: 'ROLE_NOT_ALLOWED',
            message: 'The selected Practitioner Role is no longer available',
          },
        }, { status: 403 })
      }
      if (path === '/api/sim/v1/scenario-runs/current') {
        return Response.json({
          epoch: 'epoch-1',
          initialStateHash: 'a'.repeat(64),
          kind: 'candidate',
          scenarioId: 'candidate-fever-outpatient-v1',
          scenarioRunId: 'scenario-run-1',
          status: 'active',
          virtualTime: '2026-08-24T08:00:00.000Z',
          workspaceId: 'workspace-demo',
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '工作台总览' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '挂号员 · 合成挂号员' }))

    expect(await screen.findByText('当前岗位无权执行此操作')).toBeTruthy()
    expect(screen.getByText('请切换到有权限的岗位后重试。')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '工作台总览' })).toBeTruthy()
  })

  it('signs out and removes the authenticated role workspace', async () => {
    let authenticated = true
    let contextRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') {
        contextRequests += 1
        return authenticated
          ? Response.json(registrarSession)
          : Response.json({ error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in required' } }, { status: 401 })
      }
      if (path === '/api/auth/sign-out') {
        authenticated = false
        return Response.json({ success: true })
      }
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/api/his/v1/registrations') {
        return Response.json({ items: [], page: 1, pageSize: 20, total: 0 })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByRole('heading', { name: '工作台总览' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    expect(await screen.findByRole('heading', { name: '登录 ClinMesh' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: '门诊挂号' })).toBeNull()
    expect(contextRequests).toBe(2)
  })

  it('does not reuse role data after one account signs out and another signs in', async () => {
    const secondSession = {
      ...registrarSession,
      actor: {
        ...registrarSession.actor,
        actorId: 'actor-registrar-second',
        practitionerId: 'practitioner-registrar-second',
      },
      user: {
        email: 'registrar.second@demo.clinmesh.local',
        id: 'user-registrar-second',
        name: '合成挂号员乙',
      },
    }
    let account: 'first' | 'second' | undefined = 'first'
    const queueAccounts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/auth/context') {
        if (account === undefined) {
          return Response.json({
            error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in required' },
          }, { status: 401 })
        }
        return Response.json(account === 'first' ? registrarSession : secondSession)
      }
      if (path === '/api/auth/sign-out') {
        account = undefined
        return Response.json({ success: true })
      }
      if (path === '/api/auth/sign-in/email') {
        const body = JSON.parse(String(init?.body)) as { email: string }
        expect(body.email).toBe(secondSession.user.email)
        account = 'second'
        return Response.json({ user: secondSession.user })
      }
      if (path === '/api/his/v1/catalogs/registration') {
        return Response.json({ departments: [], virtualDate: '2026-08-24', visitTypes: [] })
      }
      if (path === '/api/his/v1/registrations') {
        if (account === undefined) {
          return Response.json({
            error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in required' },
          }, { status: 401 })
        }
        queueAccounts.push(account)
        const sequence = account === 'first' ? 'A' : 'B'
        return Response.json({
          items: [{
            arrivedAt: '2026-08-24T09:00:00+08:00',
            caseId: `case-${sequence}`,
            encounterId: `encounter-${sequence}`,
            encounterVersion: '1',
            patient: {
              id: `patient-${sequence}`,
              identifier: `CM-SYN-${sequence}`,
              name: `合成患者${sequence}`,
              synthetic: true,
              versionId: '1',
            },
            registrationId: `registration-${sequence}`,
            registrationNumber: `CM-OP-${sequence}`,
            registrationStatus: 'registered',
            status: 'awaiting-triage',
            taskId: `task-${sequence}`,
            taskVersion: '1',
          }],
          page: 1,
          pageSize: 20,
          total: 1,
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    const user = userEvent.setup()
    render(<WebApp />)

    expect(await screen.findByText('CM-OP-A')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '用户菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    await user.type(await screen.findByLabelText('账户邮箱'), secondSession.user.email)
    await user.type(screen.getByLabelText('账户密码'), 'test-only-password')
    await user.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('CM-OP-B')).toBeTruthy()
    expect(screen.queryByText('CM-OP-A')).toBeNull()
    expect(queueAccounts).toEqual(['first', 'second'])
  })
})
