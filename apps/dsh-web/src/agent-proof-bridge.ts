import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { AgentExecutionProofIssuer, parseAgentExecutionProof } from './execution-proof.ts'

export const CLINMESH_AGENT_PROOF_PATH = '/clinmesh-agent-proof'
export const CLINMESH_AGENT_HANDOFF_PATH = '/clinmesh-agent-handoff'
const MAX_PROOF_REQUEST_BYTES = 4096
const MAX_HANDOFF_REQUEST_BYTES = 16_384

const proofRequestSchema = z.object({
  contextId: z.string().min(1).max(128),
  pageRevision: z.string().min(1).max(1024),
  scopeKey: z.string().min(1).max(128),
  toolName: z.string().regex(/^clinmesh_[a-z0-9_]+$/).max(64),
}).strict()
const bindingSchema = proofRequestSchema.pick({ pageRevision: true, scopeKey: true }).strip()
const toolBindingSchema = z.object({
  properties: z.object({
    scopeKey: z.object({ const: z.string() }),
    pageRevision: z.object({ const: z.string() }),
  }),
})

const handoffTargetSchema = proofRequestSchema.pick({ pageRevision: true, scopeKey: true }).extend({
  toolNames: z.array(proofRequestSchema.shape.toolName).min(1).max(32)
    .refine(names => new Set(names).size === names.length, 'Tool names must be unique'),
}).strict()
const handoffRequestSchema = z.object({
  proof: z.string().min(32).max(4096),
  phase: z.literal('settle'),
  target: handoffTargetSchema,
}).strict()

interface PendingCall {
  execution: ToolExecution
  disposeProof(): void
  bodyStarted: boolean
  bodyReceived: boolean
  deadline: number | undefined
  abort: AbortController
  proof?: string
  target?: z.infer<typeof handoffTargetSchema>
}

export function installAgentProofBridge(ctx: Context, secret: string,
  options: { handoffTimeoutMs?: number } = {},
): void {
  const issuer = new AgentExecutionProofIssuer({ secret })
  const pending = new Map<string, PendingCall>()
  const changed = new Set<() => void>()
  const lifetime = new AbortController()
  const timeoutMs = options.handoffTimeoutMs ?? 30_000
  const notify = (): void => { for (const listener of changed) listener() }
  const wait = (call: PendingCall, ready: () => boolean, signal = call.execution.signal): Promise<void> => {
    const combined = AbortSignal.any([signal, lifetime.signal, call.execution.signal, call.abort.signal])
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        changed.delete(check)
        combined.removeEventListener('abort', onAbort)
      }
      const fail = (error: unknown): void => { cleanup(); reject(error) }
      const onAbort = (): void => fail(combined.reason)
      const check = (): void => {
        if (combined.aborted) { onAbort(); return }
        try {
          if (ready()) { cleanup(); resolve(); return }
        } catch (error) { fail(error); return }
        if (timer === undefined) timer = setTimeout(() => fail(new Error('CLINMESH_HANDOFF_TIMEOUT')),
          Math.max(0, (call.deadline ?? Date.now() + timeoutMs) - Date.now()))
      }
      changed.add(check)
      combined.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }
  const directoryMatches = (call: PendingCall): boolean => {
    if (call.target === undefined) return false
    const target = call.target
    const tools = ctx.tools.schemas(call.execution.agent).filter(tool => tool.name.startsWith('clinmesh_'))
    if (tools.length !== target.toolNames.length) return false
    return tools.every(tool => {
      const binding = toolBindingSchema.safeParse(tool.parameters)
      return target.toolNames.includes(tool.name) && binding.success
        && binding.data.properties.scopeKey.const === target.scopeKey
        && binding.data.properties.pageRevision.const === target.pageRevision
    })
  }
  const finish = (execution: Pick<ToolExecution, 'agent' | 'callId'>): void => {
    const key = executionKey(execution)
    const call = pending.get(key)
    pending.delete(key)
    call?.disposeProof()
    notify()
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
      const current = toolBindingSchema.safeParse(ctx.tools.get(execution.name, execution.agent)?.parameters)
      if (!current.success || current.data.properties.scopeKey.const !== binding.scopeKey
        || current.data.properties.pageRevision.const !== binding.pageRevision) {
        return {
          kind: 'deny',
          reason: bindingMismatchReason(ctx, execution.agent),
        }
      }
      const dispose = issuer.begin({
        callId: String(execution.callId),
        pageRevision: binding.pageRevision,
        dshSessionId: String(dshSessionId),
        scopeKey: binding.scopeKey,
        toolName: execution.name,
      })
      pending.set(executionKey(execution), { execution, disposeProof: dispose, bodyStarted: false,
        bodyReceived: false, deadline: undefined, abort: new AbortController() })
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

  ctx.on('tools/execute', async (execution, next) => {
    const call = pending.get(executionKey(execution))
    if (call === undefined) return next()
    call.bodyStarted = true
    notify()
    try { return await next() } finally {
      call.bodyReceived = true
      call.deadline = Date.now() + timeoutMs
      notify()
    }
  })

  ctx.on('tools/post-execute', async (execution, result, next) => {
    const call = pending.get(executionKey(execution))
    if (call?.proof === undefined) return next()
    try {
      await wait(call, () => directoryMatches(call))
      return next()
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'CLINMESH_HANDOFF_CANCELLED'
      execution.agent?.cancel({ kind: 'hook', reason }, { keepInbox: true })
      return { kind: 'block', feedback: [...result.content, { type: 'text',
        text: `${reason}: 工具目录同步未完成，已停止本轮后续调用。${result.isError ? '上述错误结果保留；业务是否发生须依据原结果和当前状态核对。' : '上述工具返回结果保留；同步失败不会撤销已完成的动作。'}不能自动重放业务动作。`,
      }] }
    }
  })
  ctx.on('tools/change', notify)

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
          const payload = parseAgentExecutionProof(proof, { secret })
          const call = pending.get(`${payload.dshSessionId}\u0000${payload.callId}`)
          if (call === undefined) throw new Error('No pending ClinMesh execution')
          call.proof = proof
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: CLINMESH_AGENT_HANDOFF_PATH,
    handler: async (request, response) => {
      const closed = new AbortController()
      let activeCall: PendingCall | undefined
      const onClose = (): void => {
        if (response.writableEnded) return
        const error = new Error('CLINMESH_HANDOFF_CANCELLED')
        closed.abort(error)
        activeCall?.abort.abort(error)
      }
      response.once('close', onClose)
      try {
        if (!isTrustedBrowserRequest(request)) {
          writeError(response, 403, 'REQUEST_NOT_TRUSTED', 'Handoff requests require the DSH Web origin'); return
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          writeError(response, 405, 'METHOD_NOT_ALLOWED', 'Handoff requests require POST'); return
        }
        const input = handoffRequestSchema.parse(await readJson(request, MAX_HANDOFF_REQUEST_BYTES))
        const payload = parseAgentExecutionProof(input.proof, { secret })
        const call = pending.get(`${payload.dshSessionId}\u0000${payload.callId}`)
        if (call === undefined || call.proof !== input.proof || !call.bodyStarted || call.target !== undefined) {
          throw new Error('No unsettled ClinMesh Tool body matches the proof')
        }
        activeCall = call
        call.target = input.target
        notify()
        await wait(call, () => [...pending.values()].every(candidate => (
          candidate.execution.agent?.session.id !== call.execution.agent?.session.id
          || !candidate.bodyStarted || candidate.bodyReceived
        )), closed.signal)
        writeJson(response, 200, { data: { permitted: true } })
      } catch (error) {
        if (closed.signal.aborted) activeCall?.abort.abort(closed.signal.reason)
        if (response.destroyed) return
        writeError(response, error instanceof RangeError ? 413 : error instanceof z.ZodError ? 400 : 409,
          error instanceof RangeError ? 'REQUEST_TOO_LARGE' : error instanceof z.ZodError ? 'INVALID_INPUT' : 'HANDOFF_NOT_READY',
          error instanceof Error ? error.message : 'Handoff failed')
      } finally { response.off('close', onClose) }
    },
  }), 'clinmesh-dsh-web: Tool result handoff route')
  ctx.effect(() => () => {
    lifetime.abort(new Error('CLINMESH_HANDOFF_UNLOADED'))
    for (const call of pending.values()) call.disposeProof()
    pending.clear()
  }, 'clinmesh-dsh-web: release Tool execution proofs')
}

function bindingMismatchReason(ctx: Context, agent: ToolExecution['agent']): string {
  const reason = 'CLINMESH_BINDING_MISMATCH: 当前患者、岗位、栏目或页面版本已变化，原调用尚未执行。'
  const read = agent === undefined ? undefined : toolBindingSchema.safeParse(
    ctx.tools.get('clinmesh_read_current_context', agent)?.parameters,
  )
  const binding = read?.success === true ? bindingSchema.safeParse({
    scopeKey: read.data.properties.scopeKey.const,
    pageRevision: read.data.properties.pageRevision.const,
  }) : undefined
  if (binding?.success !== true) {
    return `${reason}当前 Agent 尚无可用的只读工具目录；等待系统重新发布后再读取，不能据此判断患者状态。`
  }
  return `${reason}先调用以下当前只读工具，核对实际岗位、患者与状态是否符合本轮目标，再决定是否写入；不能从本次拒绝推断患者是否已切换：\n${JSON.stringify({
    toolName: 'clinmesh_read_current_context', arguments: binding.data,
  })}`
}

function bindingFromArguments(value: unknown): {
  pageRevision: string
  scopeKey: string
} {
  const result = bindingSchema.safeParse(value)
  if (result.success) return result.data
  const fields = [...new Set(result.error.issues.flatMap(issue => (
    issue.path.length === 0 ? ['scopeKey', 'pageRevision'] : [String(issue.path[0])]
  )))]
  throw new TypeError(`CLINMESH_BINDING_ARGUMENTS_INVALID: 调用 JSON 缺少或包含无效的绑定参数：${fields.join(', ')}。尚未执行。请显式传入当前工具 schema 中的 scopeKey、pageRevision const 值；const 不会自动填入。Context ID 由执行桥接管理。`)
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

async function readJson(request: IncomingMessage, maxBytes = MAX_PROOF_REQUEST_BYTES): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new TypeError('Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new RangeError('The bridge request is too large')
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
