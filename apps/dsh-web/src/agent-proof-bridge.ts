import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { AgentExecutionProofIssuer } from './execution-proof.ts'

export const CLINMESH_AGENT_PROOF_PATH = '/clinmesh-agent-proof'
const MAX_PROOF_REQUEST_BYTES = 4096

const proofRequestSchema = z.object({
  contextId: z.string().min(1).max(128),
  scopeKey: z.string().min(1).max(128),
  toolName: z.string().regex(/^clinmesh_[a-z0-9_]+$/).max(64),
}).strict()
const bindingSchema = proofRequestSchema.pick({ contextId: true, scopeKey: true }).strip()

export function installAgentProofBridge(ctx: Context, secret: string): void {
  const issuer = new AgentExecutionProofIssuer({ secret })
  const pending = new Map<string, () => void>()
  const finish = (execution: Pick<ToolExecution, 'agent' | 'callId'>): void => {
    const key = executionKey(execution)
    const dispose = pending.get(key)
    pending.delete(key)
    dispose?.()
  }

  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!execution.name.startsWith('clinmesh_')) return next()
    try {
      const binding = bindingFromArguments(execution.arguments)
      const dshSessionId = execution.agent?.session.id
      if (dshSessionId === undefined) {
        return {
          kind: 'deny',
          reason: 'CLINMESH_HOST_SESSION_REQUIRED: 当前调用未关联 DSH Agent 会话，尚未执行。请从打开 ClinMesh 工作台的 DSH 会话调用；参数补全无法修复会话关联。',
        }
      }
      const dispose = issuer.begin({
        callId: String(execution.callId),
        contextId: binding.contextId,
        dshSessionId: String(dshSessionId),
        scopeKey: binding.scopeKey,
        toolName: execution.name,
      })
      pending.set(executionKey(execution), dispose)
      const decision = await next()
      if (decision.kind !== 'allow') finish(execution)
      return decision
    } catch (error) {
      finish(execution)
      return {
        kind: 'deny',
        reason: error instanceof Error ? error.message : 'ClinMesh Tool proof setup failed',
      }
    }
  })

  ctx.on('tools/result', execution => {
    finish(execution)
  })

  ctx.effect(
    () => ctx.webServer.register({
      handler: async (request, response) => {
        try {
          if (!isTrustedBrowserRequest(request)) {
            writeError(response, 403, 'REQUEST_NOT_TRUSTED', 'Proof requests require the DSH Web origin')
            return
          }
          if (request.method !== 'POST') {
            response.setHeader('allow', 'POST')
            writeError(response, 405, 'METHOD_NOT_ALLOWED', 'Proof requests require POST')
            return
          }
          const input = proofRequestSchema.parse(await readJson(request))
          const proof = issuer.issue(input)
          writeJson(response, 200, { data: { proof } })
        } catch (error) {
          writeError(
            response,
            error instanceof z.ZodError ? 400 : 409,
            error instanceof z.ZodError ? 'INVALID_INPUT' : 'PROOF_NOT_PENDING',
            error instanceof Error ? error.message : 'Proof request failed',
          )
        }
      },
      kind: 'exact',
      path: CLINMESH_AGENT_PROOF_PATH,
    }),
    'clinmesh-dsh-web: Tool execution proof route',
  )
  ctx.effect(() => () => {
    for (const dispose of pending.values()) dispose()
    pending.clear()
  }, 'clinmesh-dsh-web: release Tool execution proofs')
}

function bindingFromArguments(value: unknown): {
  contextId: string
  scopeKey: string
} {
  const result = bindingSchema.safeParse(value)
  if (result.success) return result.data
  const fields = [...new Set(result.error.issues.flatMap(issue => (
    issue.path.length === 0 ? ['contextId', 'scopeKey'] : [String(issue.path[0])]
  )))]
  throw new TypeError(`CLINMESH_BINDING_ARGUMENTS_INVALID: 调用 JSON 缺少或包含无效的绑定参数：${fields.join(', ')}。尚未执行。请把当前工具 schema 中的 contextId、scopeKey 的 const 值显式写入调用 JSON 后重试；const 不会自动填入。不要复用历史消息中的值；此错误不表示绑定已过期或被读取消耗。`)
}

function executionKey(execution: Pick<ToolExecution, 'agent' | 'callId'>): string {
  return `${String(execution.agent?.session.id ?? '')}\u0000${String(execution.callId)}`
}

function isTrustedBrowserRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress?.toLowerCase()
  const loopback = address === '::1'
    || address?.startsWith('127.') === true
    || address?.startsWith('::ffff:127.') === true
  if (!loopback || request.headers['sec-fetch-site'] === 'cross-site') return false
  const host = request.headers.host
  const origin = request.headers.origin
  if (typeof host !== 'string' || origin === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new TypeError('Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_PROOF_REQUEST_BYTES) throw new TypeError('Proof request is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-length', Buffer.byteLength(body))
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(body)
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(response, status, { error: { code, message } })
}
