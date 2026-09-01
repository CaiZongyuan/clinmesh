import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.ts'
import { createProfileStore } from '../src/profile-store.ts'

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

describe('clinmesh auth', () => {
  it('classifies a rejected Better Auth login as authentication failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-auth-rejected-'))
    try {
      const profiles = createProfileStore({ directory })
      const fetch = vi.fn().mockResolvedValue(Response.json({
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'Invalid email or password',
      }, { status: 401 }))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'auth', 'login',
        '--profile', 'doctor',
        '--server-url', 'http://127.0.0.1:51868',
        '--email', 'doctor@demo.clinmesh.local',
        '--password-stdin',
      ], { stderr: stderr.stream, stdout: stdout.stream }, {
        fetch,
        profiles,
        readStdin: async () => 'wrong-password\n',
      })

      expect(exitCode).toBe(3)
      expect(stdout.value()).toBe('')
      expect(JSON.parse(stderr.value())).toMatchObject({
        error: {
          outcome: 'definitely_not_sent',
          retryable: false,
          type: 'authentication',
        },
        ok: false,
      })
      await expect(profiles.load('doctor')).resolves.toBeUndefined()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('logs a human profile in with a stdin password without echoing credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-auth-'))
    try {
      const profiles = createProfileStore({ directory })
      const fetch = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ user: { id: 'user-doctor' } }),
        {
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'better-auth.session_token=synthetic; Path=/; HttpOnly',
          },
          status: 200,
        },
      ))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'auth', 'login',
        '--profile', 'doctor',
        '--server-url', 'http://127.0.0.1:51868',
        '--email', 'doctor@demo.clinmesh.local',
        '--password-stdin',
      ], { stderr: stderr.stream, stdout: stdout.stream }, {
        fetch,
        profiles,
        readStdin: async () => 'synthetic-password\n',
      })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:51868/api/auth/sign-in/email'),
        {
          body: JSON.stringify({
            email: 'doctor@demo.clinmesh.local',
            password: 'synthetic-password',
          }),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            origin: 'http://127.0.0.1:51868',
          },
          method: 'POST',
        },
      )
      await expect(profiles.load('doctor')).resolves.toEqual({
        cookie: 'better-auth.session_token=synthetic',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const output = stdout.value()
      expect(output).not.toContain('synthetic-password')
      expect(output).not.toContain('session_token')
      expect(JSON.parse(output)).toMatchObject({
        data: {
          authMode: 'human',
          profile: 'doctor',
          serverUrl: 'http://127.0.0.1:51868',
        },
        ok: true,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('reads and validates the trusted session context without exposing the cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-context-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('doctor', {
        cookie: 'better-auth.session_token=synthetic',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const context = {
        actor: {
          actorId: 'actor-doctor',
          epoch: 'epoch-1',
          locationId: 'location-doctor',
          organizationId: 'organization-clinmesh',
          practitionerId: 'practitioner-doctor',
          practitionerRoleId: 'practitioner-role-outpatient-doctor',
          roleCode: 'outpatient-doctor',
          scenarioRunId: 'scenario-run-1',
          workspaceId: 'workspace-demo',
        },
        availableRoles: [{
          code: 'outpatient-doctor',
          id: 'practitioner-role-outpatient-doctor',
          locationId: 'location-doctor',
          organizationId: 'organization-clinmesh',
          practitionerId: 'practitioner-doctor',
          practitionerName: '合成门诊医生',
        }],
        user: {
          email: 'doctor@demo.clinmesh.local',
          id: 'user-doctor',
          name: '合成门诊医生',
        },
      }
      const fetch = vi.fn().mockResolvedValue(Response.json(context))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'context', 'show', '--profile', 'doctor',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:51868/api/auth/context'),
        {
          headers: {
            accept: 'application/json',
            cookie: 'better-auth.session_token=synthetic',
          },
          method: 'GET',
        },
      )
      const output = stdout.value()
      expect(output).not.toContain('session_token')
      expect(JSON.parse(output)).toMatchObject({ data: context, ok: true })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('switches the acting Practitioner Role through the human session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-role-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const context = {
        actor: {
          actorId: 'actor-administrator',
          epoch: 'epoch-1',
          locationId: 'location-doctor',
          organizationId: 'organization-clinmesh',
          practitionerId: 'practitioner-doctor',
          practitionerRoleId: 'practitioner-role-outpatient-doctor',
          roleCode: 'outpatient-doctor',
          scenarioRunId: 'scenario-run-1',
          workspaceId: 'workspace-demo',
        },
        availableRoles: [{
          code: 'outpatient-doctor',
          id: 'practitioner-role-outpatient-doctor',
          locationId: 'location-doctor',
          organizationId: 'organization-clinmesh',
          practitionerId: 'practitioner-doctor',
          practitionerName: '合成门诊医生',
        }],
        user: {
          email: 'admin@demo.clinmesh.local',
          id: 'user-admin',
          name: '合成管理员',
        },
      }
      const fetch = vi.fn().mockResolvedValue(Response.json(context))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'auth', 'role', 'use',
        '--profile', 'admin',
        '--practitioner-role-id', 'practitioner-role-outpatient-doctor',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:51868/api/auth/role'),
        expect.objectContaining({
          body: JSON.stringify({ practitionerRoleId: 'practitioner-role-outpatient-doctor' }),
          method: 'POST',
        }),
      )
      expect(JSON.parse(stdout.value())).toMatchObject({ data: context, ok: true })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('signs out on the Server before deleting the human profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-logout-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('doctor', {
        cookie: 'better-auth.session_token=doctor',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const fetch = vi.fn().mockResolvedValue(Response.json({}))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'auth', 'logout', '--profile', 'doctor',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:51868/api/auth/sign-out'),
        expect.objectContaining({ body: '{}', method: 'POST' }),
      )
      await expect(profiles.load('doctor')).resolves.toBeUndefined()
      expect(JSON.parse(stdout.value())).toMatchObject({
        data: { profile: 'doctor', status: 'signed-out' },
        ok: true,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('shows an injected Agent context without reading a human profile', async () => {
    const profiles = {
      load: vi.fn(),
      remove: vi.fn(),
      save: vi.fn(),
    }
    const context = {
      actor: {
        actorId: 'agent-actor-1',
        epoch: 'epoch-1',
        locationId: 'location-doctor',
        organizationId: 'organization-clinmesh',
        practitionerId: 'practitioner-doctor',
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        roleCode: 'outpatient-doctor',
        scenarioRunId: 'scenario-run-1',
        workspaceId: 'workspace-demo',
      },
      agent: {
        agentClientId: '11111111-1111-4111-8111-111111111111',
        name: 'Synthetic whole-HIS agent',
      },
      grant: {
        expiresAt: '2026-08-31T01:00:00.000Z',
        grantId: '22222222-2222-4222-8222-222222222222',
        operationIds: ['doctor.queue.list'],
        policyVersion: 1,
      },
    }
    const stdout = captureStream()
    const stderr = captureStream()
    const readContext = vi.fn().mockResolvedValue(context)

    const exitCode = await runCli(
      ['context', 'show'],
      { stderr: stderr.stream, stdout: stdout.stream },
      { authMode: 'agent', profiles, readContext },
    )

    expect(exitCode).toBe(0)
    expect(stderr.value()).toBe('')
    expect(readContext).toHaveBeenCalledOnce()
    expect(profiles.load).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.value())).toMatchObject({ data: context, ok: true })
  })
})
