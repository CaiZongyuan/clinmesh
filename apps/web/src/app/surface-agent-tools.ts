import {
  agentPageBindingRevision,
  hasSameDoctorCase,
  parseAgentToolInput,
  usesDoctorReadBinding,
  type AgentPageContextBinding,
  type AgentReviewDecisionRequest,
  type AgentToolAuthorizationRequest,
  type AgentToolAuthorizationResponse,
  type AgentToolDefinition,
  agentDoctorQueryRequestSchema,
  type AgentToolResultRequest,
} from '@clinmesh/contracts/agent'
import { z } from 'zod'
import { doctorQueueSchema } from '@clinmesh/contracts/his'
import type { WebSurfaceAgentTool } from './web-runtime.tsx'
import { isAgentReviewTask, type AgentReviewTask } from './agent-review.tsx'
import { ApiClientError } from './api-client.ts'

const editingInstruction = '每次调用显式传入当前 schema 的 scopeKey、pageRevision const 值；const 不会自动填入，Context ID 由桥接管理。绑定变化时重新读取页面。填写草稿前用 clinmesh_read_current_context 读取当前授权页面及未保存内容，根据意图询问覆盖；这不是强制覆盖授权或并发修改保护。问诊超时先读病例状态，已有问题仅重试未完成的患者回复，不重复发送问题。正式医院动作仍须应用内人工审阅。'

export interface SurfaceAgentPageAction {
  description: string
  enabled?: boolean
  execute(input: unknown, signal: AbortSignal): unknown | Promise<unknown>
  parameters: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: readonly string[]
    additionalProperties?: boolean
  }
}

export interface AgentActionFeedback {
  id: string
  operationId: string
  input: unknown
  phase: 'executing' | 'completed' | 'awaiting-review' | 'submitting' | 'rejected' | 'failed' | 'unconfirmed'
  message?: string
}

export interface SurfaceAgentFrame {
  actions: Readonly<Record<string, SurfaceAgentPageAction>>
  binding: AgentPageContextBinding
  readState(): unknown
}

interface BuildSurfaceAgentToolsInput {
  queryDoctor?(request: z.infer<typeof agentDoctorQueryRequestSchema>, signal: AbortSignal): Promise<object>
  actions: Readonly<Record<string, SurfaceAgentPageAction>>
  authorize(request: AgentToolAuthorizationRequest, signal: AbortSignal): Promise<AgentToolAuthorizationResponse>
  binding: AgentPageContextBinding
  complete(request: AgentToolResultRequest, signal: AbortSignal): Promise<unknown>
  definitions: readonly AgentToolDefinition[]
  issueProof(input: {
    contextId: string
    pageRevision: string
    previousProof?: string
    scopeKey: string
    signal: AbortSignal
    toolName: string
  }): Promise<string>
  onExecutionSettled?(proof: string | undefined, signal: AbortSignal, unconfirmed?: boolean): void
  onExecutionStart?(): void
  onActionFeedback?(event: AgentActionFeedback): void
  readState(): unknown
  resolveBinding?(): AgentPageContextBinding | undefined
  resolveFrame?(): SurfaceAgentFrame | undefined
  review(request: AgentReviewDecisionRequest, signal: AbortSignal): Promise<unknown>
  strictDefinitions?: boolean
}

export function buildSurfaceAgentTools(
  input: BuildSurfaceAgentToolsInput,
): WebSurfaceAgentTool[] {
  const pageRevision = agentPageBindingRevision(input.binding.snapshot.claim)
  const currentBinding = (): AgentPageContextBinding => {
    const binding = input.resolveBinding === undefined ? input.binding : input.resolveBinding()
    if (binding === undefined || binding.snapshot.scopeKey !== input.binding.snapshot.scopeKey
      || agentPageBindingRevision(binding.snapshot.claim) !== pageRevision) {
      throw new TypeError('CLINMESH_BINDING_MISMATCH: 当前患者、岗位或页面版本已变化，尚未执行。请读取当前页面状态后决定是否继续。')
    }
    return binding
  }
  if (input.strictDefinitions === true) {
    const missing = input.definitions.filter(definition => (
      input.binding.snapshot.allowedOperationIds.includes(definition.operationId)
      && definition.operationId !== 'ui.context.read'
      && input.actions[definition.operationId] === undefined
    ))
    if (missing.length > 0) {
      throw new Error(`ClinMesh page is missing Agent actions: ${missing
        .map(definition => definition.operationId).join(', ')}`)
    }
  }
  return input.definitions.flatMap(definition => {
    if (!input.binding.snapshot.allowedOperationIds.includes(definition.operationId)) return []
    const action = definition.operationId === 'ui.context.read'
      ? contextReadAction(input, currentBinding)
      : input.actions[definition.operationId]
    if (action === undefined || action.enabled === false) return []
    const executionRead = usesDoctorReadBinding(input.binding.snapshot, definition.operationId)
    const readFrame = (): SurfaceAgentFrame => {
      const frame = input.resolveFrame === undefined
        ? { actions: input.actions, binding: currentBinding(), readState: input.readState }
        : input.resolveFrame()
      if (frame === undefined || !hasSameDoctorCase(input.binding.snapshot, frame.binding.snapshot)
        || !frame.binding.snapshot.allowedOperationIds.includes(definition.operationId)) {
        throw new TypeError('CLINMESH_TASK_CHANGED: 当前病例或权限已变化，已暂停原任务。')
      }
      return frame
    }
    return [{
      description: [action.description, executionRead
        ? '只提交业务参数，当前病例与授权由系统绑定。读取不切换医生页面；对象或权限变化时暂停原任务。'
        : editingInstruction].join(' '),
      name: definition.toolName,
      parameters: executionRead ? projectDshToolSchema({ ...action.parameters, additionalProperties: true }) : bindContextParameters(
        action.parameters,
        input.binding.snapshot.scopeKey,
        pageRevision,
      ),
      execute: async (raw, signal) => {
        input.onExecutionStart?.()
        const id = crypto.randomUUID()
        let executionProof: string | undefined
        let unconfirmed = false
        let feedback: ((phase: AgentActionFeedback['phase'], message?: string) => void) | undefined
        const onAbort = (): void => feedback?.('unconfirmed', '操作已中断，结果尚未确认；请读取当前状态。')
        try {
          const frame = executionRead ? readFrame() : undefined
          let binding = frame?.binding ?? currentBinding()
          const values = executionRead ? z.record(z.string(), z.unknown()).parse(raw) : requireBoundInput(
            raw,
            input.binding.snapshot.scopeKey,
            pageRevision,
          )
          const actionInput = z.json().parse(parseAgentToolInput(
            definition.operationId,
            Object.fromEntries(Object.entries(values).filter(([key]) => (
              key !== 'pageRevision' && key !== 'scopeKey'
            ))),
          ))
          executionProof = await input.issueProof({
            contextId: binding.snapshot.id,
            pageRevision: agentPageBindingRevision(binding.snapshot.claim),
            signal,
            scopeKey: binding.snapshot.scopeKey,
            toolName: definition.toolName,
          })
          const authorize = () => input.authorize({
            contextToken: binding.token,
            executionProof: executionProof!,
            input: actionInput,
            operationId: definition.operationId,
          }, signal)
          const authorization = await authorize().catch(async (error: unknown) => {
            if (error instanceof ApiClientError && [
              'AGENT_CONTEXT_EXPIRED', 'AGENT_CONTEXT_INVALID', 'AGENT_CONTEXT_STALE',
            ].includes(error.code)) {
              if (executionRead) {
                const current = readFrame().binding
                if (current.snapshot.id !== binding.snapshot.id) {
                  signal.throwIfAborted()
                  binding = current
                  executionProof = await input.issueProof({ contextId: current.snapshot.id,
                    pageRevision: agentPageBindingRevision(current.snapshot.claim), previousProof: executionProof!,
                    signal, scopeKey: current.snapshot.scopeKey, toolName: definition.toolName })
                  return authorize()
                }
                throw new Error('当前病例资料暂时无法读取，已暂停；请稍后再试。', { cause: error })
              }
              throw new Error(`${error.code}: ${error.message}。本次动作尚未执行。请等待 ClinMesh 页面更新工具定义，按当前工具 schema 的 const 传入 scopeKey、pageRevision，并读取当前页面状态后决定是否重试；若工具持续未更新，请重新打开 ClinMesh 工作台。`, { cause: error })
            }
            throw error
          })
          signal.throwIfAborted()
          if (!executionRead && definition.operationId !== 'ui.context.read' && !definition.operationId.endsWith('.read')) {
            feedback = (phase, message) => input.onActionFeedback?.({
              id, operationId: definition.operationId, input: actionInput, phase,
              ...(message === undefined ? {} : { message }),
            })
          }
          feedback?.('executing')
          signal.addEventListener('abort', onAbort, { once: true })
          let actionResolved = false
          try {
            const executionFrame = executionRead ? readFrame() : undefined
            if (!executionRead) currentBinding()
            const currentAction = executionFrame === undefined ? action : definition.operationId === 'ui.context.read'
              ? contextReadAction({ ...input, readState: executionFrame.readState }, () => executionFrame.binding)
              : executionFrame.actions[definition.operationId]
            if (currentAction === undefined || currentAction.enabled === false) {
              throw new TypeError('CLINMESH_TASK_CHANGED: 当前读取能力不可用，已暂停原任务。')
            }
            const queried = executionFrame !== undefined && input.queryDoctor !== undefined
              ? await input.queryDoctor({ contextToken: executionFrame.binding.token,
                  receiptToken: authorization.receiptToken, input: actionInput }, signal)
              : undefined
            if (executionRead) readFrame()
            const data = executionFrame !== undefined && input.queryDoctor !== undefined
              ? definition.operationId === 'ui.context.read'
                ? { snapshot: readFrame().binding.snapshot, pageState: readFrame().readState() }
                : definition.operationId === 'outpatient.case.read'
                  ? { ...queried, queue: z.object({ queue: doctorQueueSchema.nullable().optional() }).parse(readFrame().readState()).queue ?? null }
                : queried
              : await currentAction.execute(actionInput, signal)
            actionResolved = true
            if (executionRead) readFrame()
            if (isAgentReviewTask(data)) {
              if (definition.mode !== 'proposal' || authorization.proposalId === undefined) {
                throw new Error('ClinMesh review requires an authorized Agent proposal')
              }
              settleAgentReview(
                data,
                authorization.receiptToken,
                input.review,
                input.complete,
                feedback,
                definition.operationId,
              )
              feedback?.('awaiting-review')
              return JSON.stringify({
                data: {
                  proposalId: authorization.proposalId,
                  status: 'awaiting-human-review',
                },
                ok: true,
              })
            }
            const result = normalizeJsonValue(data)
            await input.complete({
              ok: true,
              receiptToken: authorization.receiptToken,
              result,
            }, signal)
            if (executionRead) readFrame()
            feedback?.(signal.aborted ? 'unconfirmed' : 'completed')
            return JSON.stringify({ data: result, ok: true })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'ClinMesh page action failed'
            const phase = signal.aborted || actionResolved ? 'unconfirmed' : errorFeedbackPhase(error)
            unconfirmed = phase === 'unconfirmed'
            feedback?.(phase, feedbackErrorMessage(phase, message))
            if (!actionResolved) {
              try {
                await input.complete({ error: message, ok: false, receiptToken: authorization.receiptToken }, signal)
              } catch (completionError) {
                // Preserve the pause marker when recording an uncertain result also fails.
                if (!unconfirmed) throw completionError
              }
            }
            throw new Error(unconfirmed ? `CLINMESH_EXECUTION_UNCONFIRMED: ${message}` : message)
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          // Defer handoff until the returned body can reach the native broker.
          if (input.onExecutionSettled !== undefined) {
            const settle = input.onExecutionSettled
            setTimeout(() => unconfirmed ? settle(executionProof, signal, true) : settle(executionProof, signal), 0)
          }
        }
      },
    }]
  })
}

function settleAgentReview(
  task: AgentReviewTask,
  receiptToken: string,
  review: BuildSurfaceAgentToolsInput['review'],
  complete: BuildSurfaceAgentToolsInput['complete'],
  feedback?: (phase: AgentActionFeedback['phase'], message?: string) => void,
  operationId?: string,
): void {
  const completionSignal = new AbortController().signal
  task.bindDecisionGate(async decision => {
    if (decision === 'approved') feedback?.('submitting')
    await review({ decision, receiptToken }, completionSignal)
  })
  void task.decision.then(
    async result => {
      await complete({
        ok: true,
        receiptToken,
        result: z.json().parse(result),
      }, completionSignal)
      if (!result.approved) feedback?.('rejected')
      else if (operationId === 'billing.payment.confirm.propose') {
        feedback?.(paymentFeedbackPhase(result.data))
      } else feedback?.('completed')
    },
    async error => {
      const phase = errorFeedbackPhase(error)
      feedback?.(phase, feedbackErrorMessage(phase, error instanceof Error ? error.message : '人工审阅未完成'))
      await complete({
        error: error instanceof Error ? error.message : 'ClinMesh Agent review was cancelled',
        ok: false,
        receiptToken,
      }, completionSignal)
    },
  ).catch(() => feedback?.('unconfirmed', '操作结果尚未确认，请读取当前状态。'))
}

function errorFeedbackPhase(error: unknown): 'failed' | 'unconfirmed' {
  if (error instanceof ApiClientError && (error.status === 0 || error.status >= 500
    || error.code === 'UNEXPECTED_RESPONSE')) return 'unconfirmed'
  return 'failed'
}

function feedbackErrorMessage(phase: AgentActionFeedback['phase'], message: string): string {
  return phase === 'unconfirmed' ? `${message}；结果尚未确认，请读取当前状态。` : message
}

function paymentFeedbackPhase(response: unknown): AgentActionFeedback['phase'] {
  const data = typeof response === 'object' && response !== null && 'data' in response ? response.data : undefined
  const outcome = typeof data === 'object' && data !== null && 'outcome' in data ? data.outcome : undefined
  if (outcome === 'success') return 'completed'
  if (outcome === 'declined') return 'failed'
  return 'unconfirmed'
}

function contextReadAction(input: BuildSurfaceAgentToolsInput, binding: () => AgentPageContextBinding): SurfaceAgentPageAction {
  return {
    description: 'Read the current authorized ClinMesh page context and visible UI state.',
    execute: () => ({
      pageState: input.readState(),
      snapshot: binding().snapshot,
    }),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }
}

function normalizeJsonValue(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('ClinMesh page action result must be JSON serializable')
  }
  return z.json().parse(JSON.parse(serialized))
}

function bindContextParameters(
  parameters: SurfaceAgentPageAction['parameters'],
  scopeKey: string,
  pageRevision: string,
): Record<string, unknown> {
  return projectDshToolSchema({
    type: 'object',
    properties: {
      scopeKey: { type: 'string', const: scopeKey, description: '必填：当前页面作用域的 const 值。' },
      pageRevision: { type: 'string', const: pageRevision, description: '必填：当前页面语义版本的 const 值，与 scopeKey 配对。' },
      ...parameters.properties,
    },
    required: ['scopeKey', 'pageRevision', ...(parameters.required ?? [])],
    additionalProperties: false,
  })
}

function projectDshToolSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClinMesh Tool schemas must contain object nodes')
  }
  const schema = value as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const annotation of ['description', 'title', 'default', 'examples'] as const) {
    if (schema[annotation] !== undefined) projected[annotation] = schema[annotation]
  }
  if (schema.type !== undefined) projected.type = schema.type
  if (Array.isArray(schema.oneOf)) {
    projected.oneOf = schema.oneOf.map(projectDshToolSchema)
  }
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    projected.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [key, projectDshToolSchema(child)]),
    )
  }
  if (Array.isArray(schema.required)) projected.required = schema.required
  if (typeof schema.additionalProperties === 'boolean') {
    projected.additionalProperties = schema.additionalProperties
  }
  if (schema.items !== undefined) projected.items = projectDshToolSchema(schema.items)
  if (Array.isArray(schema.enum)) projected.enum = schema.enum
  if (schema.const !== undefined) projected.const = schema.const
  return projected
}

function requireBoundInput(
  value: unknown,
  scopeKey: string,
  pageRevision: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClinMesh Tool input must be an object')
  }
  const input = value as Record<string, unknown>
  const invalidFields = ['scopeKey', 'pageRevision'].filter(key => (
    typeof input[key] !== 'string' || input[key].length === 0
  ))
  if (invalidFields.length > 0) {
    throw new TypeError(`CLINMESH_BINDING_ARGUMENTS_INVALID: 调用 JSON 缺少或包含无效的绑定参数：${invalidFields.join(', ')}。尚未执行。请显式传入当前工具 schema 的 const 值；const 不会自动填入。`)
  }
  if (input.pageRevision !== pageRevision || input.scopeKey !== scopeKey) {
    throw new TypeError('CLINMESH_BINDING_MISMATCH: 当前患者、岗位或页面版本已变化，尚未执行。请使用当前工具 schema 的 const 值并重新读取页面状态后决定是否继续。')
  }
  return input
}
