import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.ts'
import { createRuntimeDependencies } from '../src/runtime.ts'

function captureStream() {
  let value = ''
  return {
    stream: { write: (chunk: string) => { value += chunk } },
    value: () => value,
  }
}

describe('CLI runtime credential resolution', () => {
  it.each([
    {
      code: 'agent_token_required',
      env: {
        CLINMESH_AGENT_TASK_ID: 'task-1',
        CLINMESH_SERVER_URL: 'http://127.0.0.1:51868',
      },
    },
    {
      code: 'agent_token_invalid',
      env: {
        CLINMESH_AGENT_TASK_ID: 'task-1',
        CLINMESH_SERVER_URL: 'http://127.0.0.1:51868',
        CLINMESH_TOKEN: 'cma_too_short',
      },
    },
  ])('returns structured authentication error $code before an Agent request', async ({
    code,
    env,
  }) => {
    const fetch = vi.fn()
    const dependencies = createRuntimeDependencies({ env, fetch })
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['patient', 'search', '--query', 'Synthetic Patient'],
      { stderr: stderr.stream, stdout: stdout.stream },
      dependencies,
    )

    expect(exitCode).toBe(3)
    expect(fetch).not.toHaveBeenCalled()
    expect(stdout.value()).toBe('')
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code,
        operationId: 'patient.search',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'authentication',
      },
      ok: false,
    })
  })

  it('returns a structured configuration error when Agent server URL is absent', async () => {
    const fetch = vi.fn()
    const dependencies = createRuntimeDependencies({
      env: {
        CLINMESH_AGENT_TASK_ID: 'task-1',
        CLINMESH_TOKEN: `cma_${'a'.repeat(40)}`,
      },
      fetch,
    })
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['context', 'show'],
      { stderr: stderr.stream, stdout: stdout.stream },
      dependencies,
    )

    expect(exitCode).toBe(3)
    expect(fetch).not.toHaveBeenCalled()
    expect(stdout.value()).toBe('')
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'server_url_required',
        operationId: 'agent.context.read',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'config',
      },
      ok: false,
    })
  })

  it('returns a structured configuration error when a human operation profile is absent', async () => {
    const fetch = vi.fn()
    const dependencies = createRuntimeDependencies({
      env: { CLINMESH_PROFILE: 'missing' },
      fetch,
      profiles: {
        load: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        save: vi.fn(),
      },
    })
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['patient', 'search', '--query', 'Synthetic Patient'],
      { stderr: stderr.stream, stdout: stdout.stream },
      dependencies,
    )

    expect(exitCode).toBe(3)
    expect(fetch).not.toHaveBeenCalled()
    expect(stdout.value()).toBe('')
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'profile_not_found',
        operationId: 'patient.search',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'config',
      },
      ok: false,
    })
  })

  it('classifies an expired Agent context token as authentication failure', async () => {
    const dependencies = createRuntimeDependencies({
      env: {
        CLINMESH_AGENT_TASK_ID: 'task-1',
        CLINMESH_SERVER_URL: 'http://127.0.0.1:51868',
        CLINMESH_TOKEN: `cma_${'a'.repeat(40)}`,
      },
      fetch: vi.fn().mockResolvedValue(Response.json({
        error: {
          code: 'AGENT_TOKEN_INVALID',
          message: 'The Agent Capability Grant is invalid',
        },
      }, { status: 401 })),
    })
    const stdout = captureStream()
    const stderr = captureStream()

    const exitCode = await runCli(
      ['context', 'show'],
      { stderr: stderr.stream, stdout: stdout.stream },
      dependencies,
    )

    expect(exitCode).toBe(3)
    expect(stdout.value()).toBe('')
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'AGENT_TOKEN_INVALID',
        operationId: 'agent.context.read',
        outcome: 'definitely_not_sent',
        retryable: false,
        type: 'authentication',
      },
      ok: false,
    })
  })

  it('fails closed in Agent context instead of reading a human profile', async () => {
    const profiles = {
      load: vi.fn().mockResolvedValue({
        cookie: 'better-auth.session_token=human',
        serverUrl: 'http://127.0.0.1:51868',
      }),
      remove: vi.fn(),
      save: vi.fn(),
    }
    const fetch = vi.fn()
    const dependencies = createRuntimeDependencies({
      env: {
        CLINMESH_AGENT_ID: 'agent-1',
        CLINMESH_AGENT_TASK_ID: 'task-1',
        CLINMESH_SERVER_URL: 'http://127.0.0.1:51868',
      },
      fetch,
      profiles,
    })

    await expect(dependencies.execute?.('reference.diagnoses.search', {
      page: 1,
      pageSize: 20,
      query: '糖尿病',
    })).rejects.toThrowError(
      'Agent execution context requires a task-scoped CLINMESH_TOKEN',
    )
    expect(profiles.load).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a malformed injected Agent token before issuing a request', async () => {
    const profiles = {
      load: vi.fn(),
      remove: vi.fn(),
      save: vi.fn(),
    }
    const fetch = vi.fn()
    const dependencies = createRuntimeDependencies({
      env: {
        CLINMESH_AGENT_TASK_ID: 'task-1',
        CLINMESH_SERVER_URL: 'http://127.0.0.1:51868',
        CLINMESH_TOKEN: 'cma_too_short',
      },
      fetch,
      profiles,
    })

    await expect(dependencies.execute?.('reference.diagnoses.search', {
      page: 1,
      pageSize: 20,
      query: '糖尿病',
    })).rejects.toThrowError(
      'Agent execution context requires a task-scoped CLINMESH_TOKEN',
    )
    expect(profiles.load).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
