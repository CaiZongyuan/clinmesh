import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import { agentExecutionProofPayloadSchema, agentToolCatalog, isDoctorReadOperation } from '@clinmesh/contracts/agent'
import { z } from 'zod'
import { AgentExecutionProofIssuer, parseAgentExecutionProof, parseDoctorAgentTaskPermit } from './execution-proof.ts'

export const CLINMESH_AGENT_PROOF_PATH = '/clinmesh-agent-proof'
export const CLINMESH_AGENT_HANDOFF_PATH = '/clinmesh-agent-handoff'
export const CLINMESH_DOCTOR_TASK_PATH = '/clinmesh-doctor-task'
const MAX_PROOF_REQUEST_BYTES = 4096
const MAX_HANDOFF_REQUEST_BYTES = 16_384
const UNCONFIRMED_EXECUTION = 'CLINMESH_EXECUTION_UNCONFIRMED:'

const proofRequestSchema = z.object({
  contextId: z.string().min(1).max(128),
  pageRevision: z.string().min(1).max(1024),
  scopeKey: z.string().min(1).max(128),
  toolName: z.string().regex(/^clinmesh_[a-z0-9_]+$/).max(64),
  previousProof: z.string().min(32).max(8192).optional(),
}).strict()
const bindingSchema = proofRequestSchema.pick({ pageRevision: true, scopeKey: true }).strip()
const toolBindingSchema = z.object({
  properties: z.object({
    scopeKey: z.object({ const: z.string() }),
    pageRevision: z.object({ const: z.string() }),
  }),
})
const humanSourceSchema = z.object({ kind: z.literal('user'), rpcId: z.string().min(1).max(256) })
const questionReplySourceSchema = z.object({ kind: z.literal('user-question-reply'),
  callId: z.string().min(1).max(256), outcome: z.literal('answered') })
const consultationReturnSchema = bindingSchema.extend({ section: z.literal('consultation') }).strict()
const doctorReadNames = new Set(agentToolCatalog.filter(tool => isDoctorReadOperation(tool.operationId))
  .map(tool => tool.toolName))
const doctorToolNames = new Set(agentToolCatalog.filter(tool => tool.operationId.startsWith('outpatient.'))
  .map(tool => tool.toolName))
type ExecutionOrigin = NonNullable<z.infer<typeof agentExecutionProofPayloadSchema>['origin']>

const handoffTargetSchema = proofRequestSchema.pick({ pageRevision: true, scopeKey: true }).extend({
  toolNames: z.array(proofRequestSchema.shape.toolName).min(1).max(32)
    .refine(names => new Set(names).size === names.length, 'Tool names must be unique'),
}).strict()
const settleRequestSchema = z.object({
  proof: z.string().min(32).max(8192),
  phase: z.literal('settle'),
  target: handoffTargetSchema,
}).strict()
const handoffRequestSchema = z.discriminatedUnion('phase', [settleRequestSchema,
  settleRequestSchema.pick({ proof: true }).extend({ phase: z.literal('pause') }).strict()])

interface PendingCall {
  execution: ToolExecution
  disposeProof(): void
  bodyStarted: boolean
  bodyReceived: boolean
  deadline: number | undefined
  abort: AbortController
  proof?: string
  target?: z.infer<typeof handoffTargetSchema>
  origin?: ExecutionOrigin
}

export function installAgentProofBridge(ctx: Context, secret: string,
  options: { handoffTimeoutMs?: number } = {},
): void {
  const issuer = new AgentExecutionProofIssuer({ secret })
  const pending = new Map<string, PendingCall>()
  const queuedTasks = new Map<string, { task: Omit<ExecutionOrigin['task'], 'turn'>; caseSelected: boolean }>()
  const activeTasks = new Map<string, ExecutionOrigin['task']>()
  const unselectedTasks = new WeakSet<ExecutionOrigin['task']>()
  const questionCalls = new Map<string, ExecutionOrigin['task']>()
  const sidebandTasks = new Map<string, ExecutionOrigin['task']>()
  const callSources = new Map<string, { arguments: unknown; origin: ExecutionOrigin }>()
  const turnCalls = new Map<string, Set<string>>()
  const doctorTasks = new Map<string, { permit: ReturnType<typeof parseDoctorAgentTaskPermit>; timer: ReturnType<typeof setTimeout> }>()
  const usedDelegations = new Map<string, number>()
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
      if (!target.toolNames.includes(tool.name)) return false
      if (!binding.success && doctorReadNames.has(tool.name)) {
        const current = directoryBinding(ctx, call.execution.agent)
        return current?.scopeKey === target.scopeKey && current.pageRevision === target.pageRevision
      }
      return binding.success && binding.data.properties.scopeKey.const === target.scopeKey
        && binding.data.properties.pageRevision.const === target.pageRevision
    })
  }
  const finish = (execution: Pick<ToolExecution, 'agent' | 'callId'>): void => {
    const key = executionKey(execution)
    const call = pending.get(key)
    pending.delete(key)
    for (const sourceKey of callSources.keys()) {
      if (sourceKey.startsWith(`${key}\u0000`)) callSources.delete(sourceKey)
    }
    call?.disposeProof()
    notify()
  }
  const pause = (call: PendingCall): boolean => {
    const agent = call.execution.agent
    if (agent === undefined || !call.bodyStarted || call.abort.signal.aborted) return false
    const sessionId = String(agent.session.id)
    const task = activeTasks.get(sessionId)
    if (task !== call.origin?.task) return false
    activeTasks.delete(sessionId)
    if (task !== undefined) {
      for (const [key, source] of callSources) if (source.origin.task === task) callSources.delete(key)
      for (const map of [questionCalls, sidebandTasks]) {
        for (const [key, candidate] of map) if (candidate === task) map.delete(key)
      }
    }
    const reason = `${UNCONFIRMED_EXECUTION} 操作结果尚未确认，已暂停原任务；不能自动重放。`
    call.abort.abort(new Error(reason))
    agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    notify()
    return true
  }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const reply = questionReplySourceSchema.safeParse(message.source)
    if (reply.success) {
      const questionKey = `${agent.session.id}\u0000${reply.data.callId}`
      const task = questionCalls.get(questionKey)
      if (task !== undefined && task === activeTasks.get(String(agent.session.id))
        && sidebandTasks.size < 256 && ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')
          ?.questions.active.some(question => question.state === 'continued' && String(question.callId) === reply.data.callId)) {
        questionCalls.delete(questionKey)
        sidebandTasks.set(`${agent.session.id}\u0000${message.id}`, task)
      }
      return
    }
    const source = humanSourceSchema.safeParse(message.source)
    if (!source.success || agent.session.header.origin === 'subagent' || queuedTasks.size >= 256) return
    const taskKey = `${agent.session.id}\u0000${source.data.rpcId}`
    const registered = doctorTasks.get(taskKey)
    if (registered !== undefined) { clearTimeout(registered.timer); doctorTasks.delete(taskKey) }
    const content = message.content.length === 1 && message.content[0]?.type === 'text' ? message.content[0].text : undefined
    if (registered !== undefined && (Date.parse(registered.permit.expiresAt) <= Date.now()
      || content === undefined || createHash('sha256').update(content).digest('hex') !== registered.permit.inputHash)) return
    const binding = registered?.permit ?? directoryBinding(ctx, agent)
    if (binding === undefined) return
    queuedTasks.set(`${agent.session.id}\u0000${message.id}`, { task: {
      scopeKey: binding.scopeKey, pageRevision: binding.pageRevision,
      messageId: String(message.id), rpcId: source.data.rpcId, acceptedAt: new Date().toISOString(),
      ...(registered === undefined ? {} : { contextId: registered.permit.contextId, delegationId: registered.permit.taskId }),
    }, caseSelected: ctx.tools.get('clinmesh_select_doctor_section', agent) !== undefined })
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const key = `${agent.session.id}\u0000${message.id}`
    const sideband = sidebandTasks.get(key)
    sidebandTasks.delete(key)
    if (sideband !== undefined && sideband === activeTasks.get(String(agent.session.id)) && sideband.turn === turn) return
    const queued = queuedTasks.get(key)
    queuedTasks.delete(key)
    activeTasks.delete(String(agent.session.id))
    if (queued !== undefined) {
      const task = { ...queued.task, turn }
      activeTasks.set(String(agent.session.id), task)
      if (!queued.caseSelected) unselectedTasks.add(task)
    }
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    queuedTasks.delete(`${agent.session.id}\u0000${message.id}`)
    sidebandTasks.delete(`${agent.session.id}\u0000${message.id}`)
  })
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event.type === 'step/start') {
      if (!turnCalls.has(sessionId)) turnCalls.set(sessionId, new Set())
      return
    }
    if (event.type === 'turn/end') {
      activeTasks.delete(sessionId)
      turnCalls.delete(sessionId)
      for (const key of callSources.keys()) if (key.startsWith(`${sessionId}\u0000`)) callSources.delete(key)
      for (const map of [questionCalls, sidebandTasks]) {
        for (const key of map.keys()) if (key.startsWith(`${sessionId}\u0000`)) map.delete(key)
      }
      return
    }
    if (event.type !== 'tool/call') return
    const task = activeTasks.get(sessionId)
    const header = session.requestHeader()
    const original = header?.tools?.find(tool => tool.name === event.data.name)
    if (event.data.name === 'ask_user_question') {
      if (task !== undefined && task.turn === event.data.turn && original !== undefined && questionCalls.size < 256) {
        questionCalls.set(`${sessionId}\u0000${event.data.callId}`, task)
      }
      return
    }
    if (!event.data.name.startsWith('clinmesh_')) return
    const binding = bindingFromParameters(header?.tools?.find(tool => tool.name === 'clinmesh_select_doctor_section')?.parameters)
      ?? bindingFromParameters(header?.tools?.find(tool => tool.name === 'clinmesh_select_doctor_case')?.parameters)
    const seen = turnCalls.get(sessionId)
    if (seen === undefined || seen.has(String(event.data.callId)) || seen.size >= 256) return
    seen.add(String(event.data.callId))
    if (original === undefined || binding === undefined || task === undefined
      || task.turn !== event.data.turn || callSources.size >= 256) return
    let args: unknown
    try { args = event.data.arguments.trim() === '' ? {} : JSON.parse(event.data.arguments) } catch { return }
    callSources.set(`${sessionId}\u0000${event.data.callId}\u0000${event.data.name}`, {
      arguments: args, origin: { request: binding, task },
    })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const prefix = `${agent.session.id}\u0000`
    activeTasks.delete(String(agent.session.id))
    turnCalls.delete(String(agent.session.id))
    for (const key of queuedTasks.keys()) if (key.startsWith(prefix)) queuedTasks.delete(key)
    for (const key of callSources.keys()) if (key.startsWith(prefix)) callSources.delete(key)
    for (const map of [questionCalls, sidebandTasks]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key)
    }
    for (const [key, task] of doctorTasks) if (key.startsWith(prefix)) {
      clearTimeout(task.timer)
      doctorTasks.delete(key)
    }
    for (const [key, call] of pending) if (key.startsWith(prefix)) {
      call.abort.abort(new Error('CLINMESH_HANDOFF_CANCELLED'))
      finish(call.execution)
    }
  })

  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!execution.name.startsWith('clinmesh_')) return next()
    try {
      const dshSessionId = execution.agent?.session.id
      if (dshSessionId === undefined) {
        return {
          kind: 'deny',
          reason: 'CLINMESH_HOST_SESSION_REQUIRED: 当前调用未关联 DSH Agent 会话，尚未执行。请从打开 ClinMesh 工作台的 DSH 会话调用；参数补全无法修复会话关联。',
        }
      }
      const current = toolBindingSchema.safeParse(ctx.tools.get(execution.name, execution.agent)?.parameters)
      const executionRead = !current.success && doctorReadNames.has(execution.name)
      const sourceKey = `${executionKey(execution)}\u0000${execution.name}`
      const source = callSources.get(sourceKey)
      callSources.delete(sourceKey)
      const binding = executionRead ? directoryBinding(ctx, execution.agent) : bindingFromArguments(execution.arguments)
      if (binding === undefined || (!executionRead && (!current.success
        || current.data.properties.scopeKey.const !== binding.scopeKey
        || current.data.properties.pageRevision.const !== binding.pageRevision))) {
        return {
          kind: 'deny',
          reason: bindingMismatchReason(ctx, execution.agent),
        }
      }
      const originalDoctor = bindingFromParameters(execution.agent?.session.requestHeader?.()?.tools
        ?.find(tool => tool.name === 'clinmesh_select_doctor_section')?.parameters)
        ?? bindingFromParameters(execution.agent?.session.requestHeader?.()?.tools
          ?.find(tool => tool.name === 'clinmesh_select_doctor_case')?.parameters)
      const doctorCall = doctorToolNames.has(execution.name)
        || directoryBinding(ctx, execution.agent) !== undefined || originalDoctor !== undefined
      if ((doctorCall && source === undefined) || (source !== undefined
        && (source.origin.task !== activeTasks.get(String(dshSessionId))
          || JSON.stringify(source.arguments) !== JSON.stringify(execution.arguments)))
        || execution.signal?.aborted) {
        throw new Error('CLINMESH_CALL_SOURCE_REQUIRED: 无法核实原医生任务与原生调用，尚未执行。')
      }
      if (source !== undefined && unselectedTasks.has(source.origin.task)
        && ctx.tools.get('clinmesh_select_doctor_section', execution.agent) !== undefined) {
        throw new Error('CLINMESH_TASK_CHANGED: 原任务没有病例锚点，请由医生为已选择病例提交新任务。')
      }
      if (['clinmesh_ask_virtual_patient', 'clinmesh_retry_patient_reply'].includes(execution.name)
        && source?.origin.task.delegationId === undefined) {
        throw new Error('CLINMESH_DELEGATION_REQUIRED: 当前任务没有代问委托，请由医生在问诊区提交代问范围。')
      }
      if (source?.origin.task.delegationId !== undefined && !doctorReadNames.has(execution.name)
        && !['clinmesh_ask_virtual_patient', 'clinmesh_retry_patient_reply'].includes(execution.name)
        && !(execution.name === 'clinmesh_select_doctor_section'
          && consultationReturnSchema.safeParse(execution.arguments).success)) {
        throw new Error('CLINMESH_TASK_OPERATION_NOT_ALLOWED: 代问任务仅允许读取资料和向当前患者提问。')
      }
      const dispose = issuer.begin({
        callId: String(execution.callId),
        pageRevision: binding.pageRevision,
        dshSessionId: String(dshSessionId),
        scopeKey: binding.scopeKey,
        toolName: execution.name,
        ...(source === undefined ? {} : { origin: source.origin }),
      })
      pending.set(executionKey(execution), { execution, disposeProof: dispose, bodyStarted: false,
        bodyReceived: false, deadline: undefined, abort: new AbortController(),
        ...(source === undefined ? {} : { origin: source.origin }) })
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
    if (call !== undefined && result.isError && result.error.message.startsWith(UNCONFIRMED_EXECUTION)) {
      pause(call)
      return next()
    }
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

  ctx.on('tools/result', (execution, result) => {
    const call = pending.get(executionKey(execution))
    if (call !== undefined && result?.isError && result.error.message.startsWith(UNCONFIRMED_EXECUTION)) pause(call)
    finish(execution)
  })

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: CLINMESH_DOCTOR_TASK_PATH,
    handler: async (request, response) => {
      try {
        if (!isTrustedBrowserRequest(request)) { writeError(response, 403, 'REQUEST_NOT_TRUSTED', 'Doctor tasks require the DSH Web origin'); return }
        if (request.method !== 'POST') { response.setHeader('allow', 'POST'); writeError(response, 405, 'METHOD_NOT_ALLOWED', 'Doctor tasks require POST'); return }
        const body = z.object({ permit: z.string().min(32).max(8192) }).strict().parse(await readJson(request, 16_384))
        const permit = parseDoctorAgentTaskPermit(body.permit, { secret })
        for (const [id, expiresAt] of usedDelegations) if (expiresAt <= Date.now()) usedDelegations.delete(id)
        if (usedDelegations.has(permit.taskId) || doctorTasks.size >= 256 || usedDelegations.size >= 256) throw new Error('The doctor task is already registered or unavailable')
        const key = `${permit.dshSessionId}\u0000${permit.rpcId}`
        if (doctorTasks.has(key)) throw new Error('The doctor task request is already registered')
        usedDelegations.set(permit.taskId, Date.parse(permit.expiresAt))
        const timer = setTimeout(() => doctorTasks.delete(key), Math.max(0, Date.parse(permit.expiresAt) - Date.now()))
        doctorTasks.set(key, { permit, timer })
        writeJson(response, 200, { data: { registered: true } })
      } catch { writeError(response, 409, 'DOCTOR_TASK_INVALID', 'The doctor task cannot be registered') }
    },
  }), 'clinmesh-dsh-web: directly submitted doctor tasks')

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
          const input = proofRequestSchema.parse(await readJson(request, MAX_HANDOFF_REQUEST_BYTES))
          if (input.previousProof !== undefined) {
            const previous = parseAgentExecutionProof(input.previousProof, { secret })
            const call = pending.get(`${previous.dshSessionId}\u0000${previous.callId}`)
            const current = call === undefined ? undefined : directoryBinding(ctx, call.execution.agent)
            if (call === undefined || call.proof !== input.previousProof || call.bodyReceived
              || call.target !== undefined || call.origin?.task !== activeTasks.get(previous.dshSessionId)
              || call.execution.signal.aborted || call.abort.signal.aborted
              || !doctorReadNames.has(input.toolName) || current?.scopeKey !== input.scopeKey
              || current.pageRevision !== input.pageRevision) {
              throw new Error('No active doctor read permits recovery')
            }
          }
          const proof = issuer.issue(input)
          const payload = parseAgentExecutionProof(proof, { secret })
          const call = pending.get(`${payload.dshSessionId}\u0000${payload.callId}`)
          if (call === undefined || call.execution.signal.aborted || call.abort.signal.aborted) {
            throw new Error('No pending ClinMesh execution')
          }
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
        if (call === undefined || call.proof !== input.proof || !call.bodyStarted) {
          throw new Error('No unsettled ClinMesh Tool body matches the proof')
        }
        if (input.phase === 'pause') {
          if (!pause(call)) throw new Error('The original ClinMesh task is no longer active')
          writeJson(response, 200, { data: { paused: true } })
          return
        }
        if (call.target !== undefined) throw new Error('The ClinMesh Tool result was already settled')
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
    queuedTasks.clear()
    activeTasks.clear()
    questionCalls.clear()
    sidebandTasks.clear()
    callSources.clear()
    turnCalls.clear()
    for (const task of doctorTasks.values()) clearTimeout(task.timer)
    doctorTasks.clear()
    usedDelegations.clear()
  }, 'clinmesh-dsh-web: release Tool execution proofs')
}

function bindingFromParameters(parameters: unknown): ExecutionOrigin['request'] | undefined {
  const parsed = toolBindingSchema.safeParse(parameters)
  if (!parsed.success) return undefined
  const binding = bindingSchema.safeParse({ scopeKey: parsed.data.properties.scopeKey.const,
    pageRevision: parsed.data.properties.pageRevision.const })
  return binding.success ? binding.data : undefined
}

function directoryBinding(ctx: Context, agent: Agent | undefined): ExecutionOrigin['request'] | undefined {
  if (agent === undefined) return undefined
  return bindingFromParameters(ctx.tools.get('clinmesh_select_doctor_section', agent)?.parameters)
    ?? bindingFromParameters(ctx.tools.get('clinmesh_select_doctor_case', agent)?.parameters)
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
