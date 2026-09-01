import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliDependencies } from './cli.ts'
import {
  createHttpExecutor,
  HttpOperationError,
  parseHttpResponse,
  transportError,
} from './http-executor.ts'
import { createProfileStore, type ProfileStore } from './profile-store.ts'
import { agentCapabilityContextSchema } from '@clinmesh/contracts/agent'

interface RuntimeOptions {
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
  profiles?: ProfileStore
}

function configDirectory(env: Record<string, string | undefined>): string {
  if (env.CLINMESH_CONFIG_DIR !== undefined) return env.CLINMESH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME !== undefined) return join(env.XDG_CONFIG_HOME, 'clinmesh')
  if (env.APPDATA !== undefined) return join(env.APPDATA, 'ClinMesh')
  return join(homedir(), '.config', 'clinmesh')
}

function isAgentContext(env: Record<string, string | undefined>): boolean {
  return env.CLINMESH_AGENT_ID !== undefined
    || env.CLINMESH_AGENT_TASK_ID !== undefined
    || env.CLINMESH_TOKEN !== undefined
}

function runtimeError(
  operationId: string,
  code: string,
  type: 'authentication' | 'config',
  message: string,
): HttpOperationError {
  return new HttpOperationError(3, {
    code,
    message,
    operationId,
    outcome: 'definitely_not_sent',
    retryable: false,
    type,
  })
}

export function createRuntimeDependencies(options: RuntimeOptions = {}): CliDependencies {
  const env = options.env ?? process.env
  const fetch = options.fetch ?? globalThis.fetch
  const profiles = options.profiles ?? createProfileStore({ directory: configDirectory(env) })
  const agentContext = isAgentContext(env)

  const agentCredential = (operationId: string) => {
    const token = env.CLINMESH_TOKEN
    if (token === undefined) {
      throw runtimeError(
        operationId,
        'agent_token_required',
        'authentication',
        'Agent execution context requires a task-scoped CLINMESH_TOKEN',
      )
    }
    if (!/^cma_[a-f0-9]{40}$/.test(token)) {
      throw runtimeError(
        operationId,
        'agent_token_invalid',
        'authentication',
        'Agent execution context requires a task-scoped CLINMESH_TOKEN',
      )
    }
    const serverUrl = env.CLINMESH_SERVER_URL
    if (serverUrl === undefined) {
      throw runtimeError(
        operationId,
        'server_url_required',
        'config',
        'Agent execution context requires CLINMESH_SERVER_URL',
      )
    }
    try {
      const parsed = new URL(serverUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('unsupported protocol')
    } catch {
      throw runtimeError(
        operationId,
        'server_url_invalid',
        'config',
        'CLINMESH_SERVER_URL must be an HTTP or HTTPS URL',
      )
    }
    return { serverUrl, token }
  }

  return {
    authMode: agentContext ? 'agent' : 'human',
    fetch,
    profiles,
    async readContext() {
      if (!agentContext) {
        throw runtimeError(
          'agent.context.read',
          'agent_context_inactive',
          'config',
          'Agent context is not active',
        )
      }
      const { serverUrl, token } = agentCredential('agent.context.read')
      let response: Response
      try {
        response = await fetch(new URL('/api/agent/v1/context', serverUrl), {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
          method: 'GET',
        })
      } catch (cause) {
        throw transportError('agent.context.read', false, undefined, cause)
      }
      return parseHttpResponse(
        response,
        agentCapabilityContextSchema,
        'agent.context.read',
        false,
      )
    },
    async execute(operationId, input, execution) {
      if (agentContext) {
        const { serverUrl, token } = agentCredential(operationId)
        if (execution?.profile !== undefined) {
          throw runtimeError(
            operationId,
            'human_profile_forbidden',
            'authentication',
            'Agent execution context cannot use a human profile',
          )
        }
        return createHttpExecutor({
          baseUrl: serverUrl,
          credential: { kind: 'agent', token },
          fetch,
        })(operationId, input, execution)
      }

      const profileName = execution?.profile ?? env.CLINMESH_PROFILE ?? 'default'
      const profile = await profiles.load(profileName)
      if (profile === undefined) {
        throw runtimeError(
          operationId,
          'profile_not_found',
          'config',
          `Human profile not found: ${profileName}`,
        )
      }
      return createHttpExecutor({
        baseUrl: profile.serverUrl,
        credential: { cookie: profile.cookie, kind: 'human' },
        fetch,
      })(operationId, input, execution)
    },
  }
}
