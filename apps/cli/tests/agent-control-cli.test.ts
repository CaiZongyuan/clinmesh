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

describe('clinmesh Agent control commands', () => {
  it.each([
    { expectedType: 'authentication', status: 401 },
    { expectedType: 'authorization', status: 403 },
  ])('classifies a human control HTTP $status response as $expectedType', async ({
    expectedType,
    status,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-control-error-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const fetch = vi.fn().mockResolvedValue(Response.json({
        error: {
          code: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ROLE_NOT_ALLOWED',
          message: status === 401
            ? 'A valid session is required'
            : 'An administrator role is required',
        },
      }, { status }))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli(
        ['agent', 'client', 'list', '--profile', 'admin'],
        { stderr: stderr.stream, stdout: stdout.stream },
        { fetch, profiles },
      )

      expect(exitCode).toBe(3)
      expect(stdout.value()).toBe('')
      expect(JSON.parse(stderr.value())).toMatchObject({
        error: {
          code: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ROLE_NOT_ALLOWED',
          outcome: 'definitely_not_sent',
          retryable: false,
          type: expectedType,
        },
        ok: false,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('reports a lost Grant creation response as ambiguous with one-time token recovery guidance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-grant-loss-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const fetch = vi.fn().mockRejectedValue(new TypeError('response lost'))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'agent', 'grant', 'create',
        '--profile', 'admin',
        '--agent-client-id', '11111111-1111-4111-8111-111111111111',
        '--practitioner-role-id', 'practitioner-role-outpatient-doctor',
        '--operation', 'patient.search',
        '--ttl-seconds', '3600',
        '--idempotency-key', 'agent-grant-response-lost-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(7)
      expect(fetch).toHaveBeenCalledOnce()
      expect(stdout.value()).toBe('')
      expect(JSON.parse(stderr.value())).toMatchObject({
        error: {
          code: 'ambiguous_outcome',
          idempotencyKey: 'agent-grant-response-lost-1',
          message: expect.stringMatching(/inspect.*revoke.*new Grant/i),
          operationId: 'agent.grant.create',
          outcome: 'ambiguous',
          retryable: false,
        },
        ok: false,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('lists and views Agent Clients and Capability Grants through a human administrator profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-inspect-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const client = {
        actorId: 'agent-actor-1',
        agentClientId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-08-31T00:00:00.000Z',
        name: 'Synthetic whole-HIS agent',
        status: 'active',
      }
      const grant = {
        agentClientId: client.agentClientId,
        createdAt: '2026-08-31T00:00:00.000Z',
        expiresAt: '2026-08-31T01:00:00.000Z',
        grantId: '22222222-2222-4222-8222-222222222222',
        operationIds: ['reference.diagnoses.search'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        revokedAt: null,
        status: 'active',
      }
      const cases = [
        {
          argv: ['agent', 'client', 'list', '--profile', 'admin'],
          path: '/api/agent/v1/clients',
          response: { items: [client] },
        },
        {
          argv: [
            'agent', 'client', 'get', '--profile', 'admin',
            '--agent-client-id', client.agentClientId,
          ],
          path: `/api/agent/v1/clients/${client.agentClientId}`,
          response: client,
        },
        {
          argv: ['agent', 'grant', 'list', '--profile', 'admin'],
          path: '/api/agent/v1/grants',
          response: { items: [grant] },
        },
        {
          argv: [
            'agent', 'grant', 'get', '--profile', 'admin',
            '--grant-id', grant.grantId,
          ],
          path: `/api/agent/v1/grants/${grant.grantId}`,
          response: grant,
        },
      ] as const

      for (const testCase of cases) {
        const fetch = vi.fn().mockResolvedValue(Response.json(testCase.response))
        const stdout = captureStream()
        const stderr = captureStream()
        const exitCode = await runCli(
          testCase.argv,
          { stderr: stderr.stream, stdout: stdout.stream },
          { fetch, profiles },
        )

        expect(exitCode).toBe(0)
        expect(stderr.value()).toBe('')
        expect(fetch).toHaveBeenCalledWith(
          new URL(`http://127.0.0.1:51868${testCase.path}`),
          {
            headers: {
              accept: 'application/json',
              cookie: 'better-auth.session_token=administrator',
            },
            method: 'GET',
          },
        )
        expect(JSON.parse(stdout.value())).toMatchObject({ data: testCase.response, ok: true })
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('disables an Agent Client without accepting Agent credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-disable-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const response = {
        actorId: 'agent-actor-1',
        agentClientId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-08-31T00:00:00.000Z',
        name: 'Synthetic whole-HIS agent',
        status: 'disabled',
      }
      const fetch = vi.fn().mockResolvedValue(Response.json(response))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'agent', 'client', 'disable',
        '--profile', 'admin',
        '--agent-client-id', response.agentClientId,
        '--idempotency-key', 'agent-client-disable-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL(`http://127.0.0.1:51868/api/agent/v1/clients/${response.agentClientId}/actions/disable`),
        expect.objectContaining({ body: '{}', method: 'POST' }),
      )
      expect(JSON.parse(stdout.value())).toMatchObject({ data: response, ok: true })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('creates an Agent Client through a human administrator profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-control-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const response = {
        actorId: 'agent-actor-1',
        agentClientId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-08-31T00:00:00.000Z',
        name: 'Synthetic whole-HIS agent',
        status: 'active',
      }
      const fetch = vi.fn().mockResolvedValue(Response.json(response))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'agent', 'client', 'create',
        '--profile', 'admin',
        '--name', 'Synthetic whole-HIS agent',
        '--idempotency-key', 'agent-client-create-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:51868/api/agent/v1/clients'),
        {
          body: JSON.stringify({ name: 'Synthetic whole-HIS agent' }),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            cookie: 'better-auth.session_token=administrator',
            'idempotency-key': 'agent-client-create-1',
            origin: 'http://127.0.0.1:51868',
          },
          method: 'POST',
        },
      )
      expect(JSON.parse(stdout.value())).toMatchObject({ data: response, ok: true })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('mints one role-bound Agent Capability Grant with an explicit operation allowlist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-grant-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const response = {
        agentClientId: '11111111-1111-4111-8111-111111111111',
        expiresAt: '2026-08-31T01:00:00.000Z',
        grantId: '22222222-2222-4222-8222-222222222222',
        operationIds: ['command.receipt.get', 'encounter.diagnosis.draft.set'],
        practitionerRoleId: 'practitioner-role-outpatient-doctor',
        token: `cma_${'a'.repeat(40)}`,
      }
      const fetch = vi.fn().mockResolvedValue(Response.json(response))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'agent', 'grant', 'create',
        '--profile', 'admin',
        '--agent-client-id', response.agentClientId,
        '--practitioner-role-id', response.practitionerRoleId,
        '--operation', 'encounter.diagnosis.draft.set',
        '--ttl-seconds', '3600',
        '--idempotency-key', 'agent-grant-create-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:51868/api/agent/v1/grants'),
        expect.objectContaining({
          body: JSON.stringify({
            agentClientId: response.agentClientId,
            operationIds: ['encounter.diagnosis.draft.set'],
            practitionerRoleId: response.practitionerRoleId,
            ttlSeconds: 3600,
          }),
          method: 'POST',
        }),
      )
      expect(JSON.parse(stdout.value())).toMatchObject({ data: response, ok: true })
      await expect(profiles.load('admin')).resolves.toEqual({
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('revokes a Grant by ID without requiring the raw token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-agent-revoke-'))
    try {
      const profiles = createProfileStore({ directory })
      await profiles.save('admin', {
        cookie: 'better-auth.session_token=administrator',
        serverUrl: 'http://127.0.0.1:51868',
      })
      const grantId = '22222222-2222-4222-8222-222222222222'
      const response = {
        grantId,
        revokedAt: '2026-08-31T00:30:00.000Z',
        status: 'revoked',
      }
      const fetch = vi.fn().mockResolvedValue(Response.json(response))
      const stdout = captureStream()
      const stderr = captureStream()

      const exitCode = await runCli([
        'agent', 'grant', 'revoke',
        '--profile', 'admin',
        '--grant-id', grantId,
        '--idempotency-key', 'agent-grant-revoke-1',
      ], { stderr: stderr.stream, stdout: stdout.stream }, { fetch, profiles })

      expect(exitCode).toBe(0)
      expect(stderr.value()).toBe('')
      expect(fetch).toHaveBeenCalledWith(
        new URL(`http://127.0.0.1:51868/api/agent/v1/grants/${grantId}/actions/revoke`),
        expect.objectContaining({ body: '{}', method: 'POST' }),
      )
      expect(JSON.parse(stdout.value())).toMatchObject({ data: response, ok: true })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
