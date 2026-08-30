import { describe, expect, it, vi } from 'vitest'
import { createRuntimeDependencies } from '../src/runtime.ts'

describe('CLI runtime credential resolution', () => {
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
